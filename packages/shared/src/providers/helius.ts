// Helius: standard Solana JSON-RPC + WebSocket logsSubscribe (free plan). Verified against the
// official docs and a real recording: docs/providers/helius.md
// The key must go in the URL (Helius auth). It is never logged: errors carry the RPC method only,
// and WebSocket error text is redacted before it leaves this module.
import WebSocket from 'ws';
import { z } from 'zod';
import { backoffMs, createHttp, type HttpOptions, ProviderError } from './http.js';

export const HELIUS_RPC_URL = 'https://mainnet.helius-rpc.com/';
export const HELIUS_WS_URL = 'wss://mainnet.helius-rpc.com/';

const tokenBalance = z.object({
  accountIndex: z.number(),
  mint: z.string(),
  owner: z.string().nullish(),
  uiTokenAmount: z.object({ amount: z.string(), decimals: z.number() }),
});

// Only the fields the scout reads; the full raw result is kept separately for data/raw/.
export const heliusTxSchema = z.object({
  slot: z.number(),
  blockTime: z.number().nullish(),
  meta: z.object({
    err: z.unknown(),
    fee: z.number(),
    preBalances: z.array(z.number()),
    postBalances: z.array(z.number()),
    preTokenBalances: z.array(tokenBalance).nullish(),
    postTokenBalances: z.array(tokenBalance).nullish(),
  }),
  transaction: z.object({
    signatures: z.array(z.string()).min(1),
    message: z.object({
      // jsonParsed: static + lookup-table keys, aligned with pre/postBalances. [0] is the fee payer.
      accountKeys: z.array(z.object({ pubkey: z.string(), signer: z.boolean() })),
    }),
  }),
});

export const heliusSignaturesSchema = z.array(
  z.object({
    signature: z.string(),
    slot: z.number(),
    err: z.unknown(),
    blockTime: z.number().nullish(),
  }),
);

export const heliusLogsNotificationSchema = z.object({
  method: z.literal('logsNotification'),
  params: z.object({
    subscription: z.number(),
    result: z.object({
      context: z.object({ slot: z.number() }),
      value: z.object({
        signature: z.string(),
        err: z.unknown(),
        logs: z.array(z.string()).nullish(),
      }),
    }),
  }),
});

/** JSON-RPC envelope as recorded in fixtures: `{ jsonrpc, id, result }`. */
export const rpcResultSchema = <T extends z.ZodType>(result: T) => z.object({ result });

export type HeliusTx = z.infer<typeof heliusTxSchema>;
export type HeliusSignature = z.infer<typeof heliusSignaturesSchema>[number];

export interface HeliusRpc {
  /** `tx` is null when the node doesn't have it yet; `raw` is the untouched result for replay. */
  getTransaction(signature: string): Promise<{ tx: HeliusTx | null; raw: unknown }>;
  /** Newest first, stopping before `until`. */
  signatures(wallet: string, o: { until?: string; limit: number }): Promise<HeliusSignature[]>;
}

const rpcEnvelope = z.object({
  result: z.unknown().optional(), // absent on error responses
  error: z.object({ code: z.number() }).nullish(),
});

const RPC_RATE_LIMITED = -32005; // JSON-RPC "Too many requests" (Helius rate-limit docs)

type RpcOptions = Omit<HttpOptions, 'provider' | 'baseUrl' | 'headers' | 'authQuery' | 'record'> & {
  apiKey: string;
  commitment: 'confirmed' | 'finalized';
};

export const createHeliusRpc = ({ apiKey, commitment, ...o }: RpcOptions): HeliusRpc => {
  const http = createHttp({
    ...o,
    provider: 'helius',
    baseUrl: HELIUS_RPC_URL,
    headers: {},
    authQuery: { 'api-key': apiKey },
  });
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const call = async (method: string, params: unknown[]): Promise<unknown> => {
    for (let attempt = 0; ; attempt++) {
      const body = { jsonrpc: '2.0', id: 1, method, params };
      const res = await http({ name: method, method: 'POST', path: '/', body }, rpcEnvelope);
      if (!res.error) return res.result;
      if (res.error.code !== RPC_RATE_LIMITED || attempt >= o.retries) {
        throw new ProviderError('helius', res.error.code, 'POST', method);
      }
      o.onRateLimited?.({ provider: 'helius', path: method, attempt });
      await sleep(backoffMs(attempt, 1000, 30_000));
    }
  };

  const parse = <T>(schema: z.ZodType<T>, value: unknown, method: string) => {
    const p = schema.safeParse(value);
    if (!p.success) throw new ProviderError('helius', 'schema', 'POST', method);
    return p.data;
  };

  return {
    getTransaction: async (signature) => {
      // Version 1 per Helius docs: covers legacy, v0 and v1; a lower value fails on newer txs.
      const raw = await call('getTransaction', [
        signature,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment },
      ]);
      return { tx: raw === null ? null : parse(heliusTxSchema, raw, 'getTransaction'), raw };
    },
    signatures: async (wallet, { until, limit }) =>
      parse(
        heliusSignaturesSchema,
        await call('getSignaturesForAddress', [wallet, { until, limit, commitment }]),
        'getSignaturesForAddress',
      ),
  };
};

export interface LogsEvent {
  wallet: string;
  signature: string;
  err: unknown;
  slot: number;
  receivedAt: number;
  raw: unknown;
}

export type StreamStatus =
  | { event: 'connected' }
  | { event: 'subscriptions_acked'; count: number; failed: number }
  | { event: 'subscribe_failed'; wallet: string; code: number | null }
  | { event: 'ws_closed'; code: number }
  | { event: 'reconnecting'; attempt: number; delayMs: number }
  | { event: 'ws_error'; message: string };

export interface HeliusStream {
  start(wallets: string[], on: { logs(e: LogsEvent): void; status(s: StreamStatus): void }): void;
  stop(): void;
}

/** The subset of a `ws` WebSocket we use, so tests can pass a fake. */
export interface SocketLike {
  on(event: 'open' | 'pong', cb: () => void): unknown;
  on(event: 'message', cb: (data: unknown) => void): unknown;
  on(event: 'close', cb: (code: number) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  send(data: string): void;
  ping(): void;
  terminate(): void;
  close(): void;
}

export interface StreamOptions {
  apiKey: string;
  commitment: 'confirmed' | 'finalized';
  pingIntervalMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  connect?: (url: string) => SocketLike;
  random?: () => number;
}

export const createHeliusStream = (o: StreamOptions): HeliusStream => {
  const connect = o.connect ?? ((url: string) => new WebSocket(url) as SocketLike);
  const redact = (s: string) => s.replaceAll(o.apiKey, '***');
  let stopped = false;
  let socket: SocketLike | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;

  return {
    start(wallets, on) {
      const open = () => {
        const ws = connect(`${HELIUS_WS_URL}?api-key=${encodeURIComponent(o.apiKey)}`);
        socket = ws;
        const walletBySub = new Map<number, string>();
        let alive = true;
        let acked = 0;
        let failed = 0;
        const settle = () => {
          if (acked + failed < wallets.length) return;
          attempt = 0; // a fully subscribed connection resets the backoff
          on.status({ event: 'subscriptions_acked', count: acked, failed });
        };

        ws.on('open', () => {
          on.status({ event: 'connected' });
          // logsSubscribe `mentions` takes exactly one pubkey, so one subscription per wallet.
          wallets.forEach((w, id) => {
            const params = [{ mentions: [w] }, { commitment: o.commitment }];
            ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'logsSubscribe', params }));
          });
          // Helius drops idle sockets after 10 min; a missed pong by the next tick means dead.
          pingTimer = setInterval(() => {
            if (!alive) return ws.terminate();
            alive = false;
            ws.ping();
          }, o.pingIntervalMs);
        });
        ws.on('pong', () => {
          alive = true;
        });
        ws.on('message', (data) => {
          alive = true;
          let msg: { id?: unknown; result?: unknown; error?: { code?: number } };
          try {
            msg = JSON.parse(String(data));
          } catch {
            return;
          }
          const wallet = typeof msg.id === 'number' ? wallets[msg.id] : undefined;
          if (wallet) {
            if (typeof msg.result === 'number') {
              walletBySub.set(msg.result, wallet);
              acked++;
            } else {
              failed++;
              on.status({ event: 'subscribe_failed', wallet, code: msg.error?.code ?? null });
            }
            return settle();
          }
          const n = heliusLogsNotificationSchema.safeParse(msg);
          const subWallet = n.success ? walletBySub.get(n.data.params.subscription) : undefined;
          if (!n.success || !subWallet) return;
          const { context, value } = n.data.params.result;
          on.logs({
            wallet: subWallet,
            signature: value.signature,
            err: value.err ?? null,
            slot: context.slot,
            receivedAt: Date.now(),
            raw: msg,
          });
        });
        ws.on('error', (err) => on.status({ event: 'ws_error', message: redact(err.message) }));
        ws.on('close', (code) => {
          clearInterval(pingTimer);
          on.status({ event: 'ws_closed', code });
          if (stopped) return;
          const delayMs = Math.round(
            backoffMs(attempt, o.reconnectBaseMs, o.reconnectMaxMs, o.random),
          );
          attempt++;
          on.status({ event: 'reconnecting', attempt, delayMs });
          retryTimer = setTimeout(open, delayMs);
        });
      };
      open();
    },
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      clearInterval(pingTimer);
      socket?.close();
    },
  };
};
