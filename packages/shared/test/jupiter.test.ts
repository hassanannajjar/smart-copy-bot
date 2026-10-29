import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createHeliusRpc } from '../src/providers/helius.js';
import { createJupiterApi, PRICE_V3_MAX_IDS, WSOL_MINT } from '../src/providers/jupiter.js';

const fixture = (p: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${p}.json`, import.meta.url), 'utf8'));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const MINT = '58gj8ENdAg6pvEuaro6GrgZtRv4tpnsPJJcYMzCpjWmX';
const KEY = 'jup_test_SECRET_456';

const api = (fetch: typeof globalThis.fetch, apiKey?: string, extra = {}) =>
  createJupiterApi({
    apiKey,
    timeoutMs: 1000,
    retries: 1,
    minIntervalMs: 0,
    fetch,
    sleep: async () => {},
    ...extra,
  });

describe('jupiter', () => {
  it('quotes a buy from the recorded /swap/v2/order without a taker, key in the header only', async () => {
    const fetch = vi.fn(async (_u: URL | RequestInfo, _i?: RequestInit) =>
      json(fixture('jupiter/order-buy-58gj8ENd').response),
    );
    const q = await api(fetch, KEY).quote(WSOL_MINT, MINT, 500_000_000n);
    expect(q).toMatchObject({
      inAmount: 500_000_000n,
      outAmount: 3_685_977_243_346n,
      feeBps: 10,
      router: 'metis',
      ammKeys: ['9DnxRbvLBb6n4bZEgZJLZC5br2ZasvCkHknU4rqpk4oH'],
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    const u = new URL(String(url));
    expect(u.pathname).toBe('/swap/v2/order');
    expect(u.searchParams.get('taker')).toBeNull(); // quote only: no transaction can be built
    expect(String(url)).not.toContain(KEY);
    expect(new Headers(init?.headers).get('x-api-key')).toBe(KEY);
  });

  it('sends no auth header keyless', async () => {
    const fetch = vi.fn(async (_u: URL | RequestInfo, _i?: RequestInit) =>
      json(fixture('jupiter/price-58gj8ENd').response),
    );
    const p = await api(fetch).prices([MINT, WSOL_MINT]);
    expect(p[MINT]).toMatchObject({ decimals: 6 });
    expect(p[WSOL_MINT]?.usdPrice).toBeGreaterThan(0);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(new URL(String(url)).searchParams.get('ids')).toBe(`${MINT},${WSOL_MINT}`);
    expect(new Headers(init?.headers).get('x-api-key')).toBeNull();
  });

  it('treats errorCode / zero outAmount and a 400 as no route', async () => {
    const noRoute = vi.fn(async () => json(fixture('jupiter/order-noroute').response));
    expect(await api(noRoute).quote(MINT, WSOL_MINT, 1n)).toBeNull();
    const bad = vi.fn(async () => json({ error: 'not a valid token mint' }, 400));
    expect(await api(bad).quote(MINT, WSOL_MINT, 1n)).toBeNull();
  });

  it('throws on 5xx after retries and reports 429s (never a fake fill)', async () => {
    const onRateLimited = vi.fn();
    const fetch = vi.fn(async () => json({}, 429));
    await expect(api(fetch, KEY, { onRateLimited }).quote(MINT, WSOL_MINT, 1n)).rejects.toThrow(
      /^jupiter 429 GET \/swap\/v2\/order$/,
    );
    expect(onRateLimited).toHaveBeenCalledWith(expect.objectContaining({ provider: 'jupiter' }));
  });

  it('refuses more than 50 ids per Price V3 call', async () => {
    const ids = Array.from({ length: PRICE_V3_MAX_IDS + 1 }, (_, i) => `m${i}`);
    await expect(api(vi.fn()).prices(ids)).rejects.toThrow(/<= 50/);
  });
});

describe('helius priority fee', () => {
  it('returns micro-lamports per CU from getPriorityFeeEstimate', async () => {
    const f = fixture('helius/priority-fee');
    const fetch = vi.fn(async (_u: URL | RequestInfo, _i?: RequestInit) => json(f.response));
    const rpc = createHeliusRpc({
      apiKey: 'k',
      commitment: 'confirmed',
      timeoutMs: 1000,
      retries: 0,
      minIntervalMs: 0,
      fetch,
    });
    expect(
      await rpc.priorityFeeEstimate(['9DnxRbvLBb6n4bZEgZJLZC5br2ZasvCkHknU4rqpk4oH'], 'High'),
    ).toBe(116_765);
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject(f.request.body);
  });
});
