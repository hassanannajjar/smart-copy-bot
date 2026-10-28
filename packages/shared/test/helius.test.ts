import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHeliusRpc,
  createHeliusStream,
  type SocketLike,
  type StreamStatus,
  SYSTEM_PROGRAM_ID,
} from '../src/providers/helius.js';
import { backoffMs } from '../src/providers/http.js';

const KEY = 'helius_SECRET_key_123';
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/helius/${name}.json`, import.meta.url), 'utf8'));
const W1 = 'GwSwopjoSe1nTyBBADzkNKxaCuvJtHTEdWgq4MCfpESh';
const W2 = 'HvvEk6DkVfri3xGqvh4KK3eVqtGT6RRvdWaaKBA5j1gV';

class FakeSocket extends EventEmitter {
  sent: { id: number; method: string; params: unknown[] }[] = [];
  pings = 0;
  constructor(readonly url: string) {
    super();
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  ping() {
    this.pings++;
  }
  terminate() {
    this.emit('close', 1006);
  }
  close() {
    this.emit('close', 1000);
  }
  /** Server acks every logsSubscribe with subscription id 100 + request id. */
  ackAll() {
    for (const s of this.sent) this.message({ jsonrpc: '2.0', id: s.id, result: 100 + s.id });
  }
  message(m: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(m)));
  }
}

const setup = () => {
  vi.useFakeTimers();
  const sockets: FakeSocket[] = [];
  const statuses: StreamStatus[] = [];
  const logs: unknown[] = [];
  const stream = createHeliusStream({
    apiKey: KEY,
    commitment: 'confirmed',
    pingIntervalMs: 30_000,
    reconnectBaseMs: 1000,
    reconnectMaxMs: 30_000,
    random: () => 0.5, // jitter factor 1.0
    connect: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      queueMicrotask(() => s.emit('open'));
      return s as unknown as SocketLike;
    },
  });
  stream.start([W1, W2], { logs: (e) => logs.push(e), status: (s) => statuses.push(s) });
  const last = () => sockets.at(-1) as FakeSocket;
  return { stream, sockets, statuses, logs, last };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('backoffMs', () => {
  it('doubles, caps and jitters x0.5..x1.5', () => {
    expect([0, 1, 2, 10].map((a) => backoffMs(a, 1000, 30_000, () => 0.5))).toEqual([
      1000, 2000, 4000, 30_000,
    ]);
    expect(backoffMs(0, 1000, 30_000, () => 0)).toBe(500);
    expect(backoffMs(0, 1000, 30_000, () => 0.999)).toBeCloseTo(1499, 0);
  });
});

describe('Helius stream', () => {
  it('subscribes once per wallet and routes notifications to the right wallet', async () => {
    const t = setup();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.last().url).toBe(`wss://mainnet.helius-rpc.com/?api-key=${KEY}`);
    expect(t.last().sent).toEqual([
      {
        jsonrpc: '2.0',
        id: 0,
        method: 'logsSubscribe',
        params: [{ mentions: [W1] }, { commitment: 'confirmed' }],
      },
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'logsSubscribe',
        params: [{ mentions: [W2] }, { commitment: 'confirmed' }],
      },
    ]);
    t.last().ackAll();
    expect(t.statuses).toContainEqual({ event: 'subscriptions_acked', count: 2, failed: 0 });

    const n = fixture('logs-notification').response;
    t.last().message({ ...n, params: { ...n.params, subscription: 101 } });
    expect(t.logs).toEqual([
      expect.objectContaining({
        wallet: W2,
        signature: n.params.result.value.signature,
        err: null,
        slot: n.params.result.context.slot,
      }),
    ]);
  });

  it('reconnects with growing, capped backoff, resubscribes, and resets after a good connection', async () => {
    const t = setup();
    await vi.advanceTimersByTimeAsync(0);
    const delays = () => t.statuses.flatMap((s) => (s.event === 'reconnecting' ? [s.delayMs] : []));

    for (let i = 0; i < 7; i++) {
      t.last().emit('close', 1006);
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(delays()).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
    expect(t.sockets).toHaveLength(8);
    expect(t.last().sent.map((s) => s.params[0])).toEqual([{ mentions: [W1] }, { mentions: [W2] }]);

    t.last().ackAll(); // fully subscribed => attempt counter resets
    t.last().emit('close', 1006);
    expect(delays().at(-1)).toBe(1000);
  });

  it('a missed pong terminates the socket and reconnects', async () => {
    const t = setup();
    await vi.advanceTimersByTimeAsync(0);
    const first = t.last();
    await vi.advanceTimersByTimeAsync(30_000); // ping #1
    expect(first.pings).toBe(1);
    first.emit('pong');
    await vi.advanceTimersByTimeAsync(30_000); // pong arrived: ping #2
    expect(first.pings).toBe(2);
    await vi.advanceTimersByTimeAsync(30_000); // no pong => terminate
    expect(t.statuses).toContainEqual({ event: 'ws_closed', code: 1006 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.sockets).toHaveLength(2);
  });

  it('redacts the key from socket errors; stop() does not reconnect', async () => {
    const t = setup();
    await vi.advanceTimersByTimeAsync(0);
    t.last().emit('error', new Error(`401 at wss://mainnet.helius-rpc.com/?api-key=${KEY}`));
    expect(JSON.stringify(t.statuses)).not.toContain(KEY);
    t.stream.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.sockets).toHaveLength(1);
    expect(t.statuses.some((s) => s.event === 'reconnecting')).toBe(false);
  });

  it('reports a rejected subscription and still settles', async () => {
    const t = setup();
    await vi.advanceTimersByTimeAsync(0);
    t.last().message({ jsonrpc: '2.0', id: 0, result: 100 });
    t.last().message({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32602, message: 'Invalid mentions' },
    });
    expect(t.statuses).toContainEqual({ event: 'subscribe_failed', wallet: W2, code: -32602 });
    expect(t.statuses).toContainEqual({ event: 'subscriptions_acked', count: 1, failed: 1 });
  });
});

const rpcClient = (fetch: typeof globalThis.fetch) =>
  createHeliusRpc({
    apiKey: KEY,
    commitment: 'confirmed',
    timeoutMs: 1000,
    retries: 2,
    minIntervalMs: 0,
    fetch,
    sleep: async () => {},
  });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('Helius RPC', () => {
  it('getTransaction: sends the documented params, parses the recorded tx, keeps the raw result', async () => {
    const f = fixture('tx-jupiter-buy');
    const fetch = vi.fn(async (_u: URL | RequestInfo, _i?: RequestInit) => json(f.response));
    const res = await rpcClient(fetch).getTransaction(f.request.body.signature);
    expect(res.tx?.transaction.signatures[0]).toBe(f.request.body.signature);
    expect(res.raw).toEqual(f.response.result);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe(`https://mainnet.helius-rpc.com/?api-key=${KEY}`);
    expect(JSON.parse(String(init?.body)).params[1]).toEqual({
      encoding: 'jsonParsed',
      maxSupportedTransactionVersion: 1,
      commitment: 'confirmed',
    });
  });

  it('getTransaction: null result means not available yet', async () => {
    const res = await rpcClient(async () =>
      json({ jsonrpc: '2.0', id: 1, result: null }),
    ).getTransaction('s');
    expect(res).toEqual({ tx: null, raw: null });
  });

  it('getAccountInfo: zero-length data slice, returns owner, null when missing', async () => {
    const wallet = fixture('account-wallet');
    const fetch = vi.fn(async (_u: URL | RequestInfo, _i?: RequestInit) => json(wallet.response));
    const acct = await rpcClient(fetch).getAccountInfo(wallet.request.body.address);
    expect(acct).toEqual({ owner: SYSTEM_PROGRAM_ID, executable: false });
    const [, init] = fetch.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      method: 'getAccountInfo',
      params: [
        wallet.request.body.address,
        { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'confirmed' },
      ],
    });
    const token = await rpcClient(async () =>
      json(fixture('account-token').response),
    ).getAccountInfo('x');
    expect(token?.owner).toBe('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const missing = await rpcClient(async () =>
      json(fixture('account-missing').response),
    ).getAccountInfo('x');
    expect(missing).toBeNull();
  });

  it('retries JSON-RPC -32005 (rate limited), fails other RPC errors with no key in the message', async () => {
    const limited = {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32005, message: 'Too many requests' },
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(limited))
      .mockResolvedValueOnce(json(fixture('signatures').response));
    const sigs = await rpcClient(fetch).signatures(W1, { limit: 6 });
    expect(sigs).toHaveLength(6);
    expect(fetch).toHaveBeenCalledTimes(2);

    const bad = async () => json({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'x' } });
    const err = await rpcClient(bad)
      .signatures(W1, { limit: 1 })
      .catch((e) => e);
    expect(err.message).toBe('helius -32602 POST getSignaturesForAddress');
    expect(`${err.message} ${err.stack}`).not.toContain(KEY);
  });
});
