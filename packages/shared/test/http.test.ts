import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createHttp, ProviderError } from '../src/providers/http.js';

const KEY = 'sk_test_SECRET_123';
const json = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

const client = (fetch: typeof globalThis.fetch, extra = {}) =>
  createHttp({
    provider: 'p',
    baseUrl: 'https://api.example.test',
    headers: { 'x-api-key': KEY },
    timeoutMs: 1000,
    retries: 2,
    minIntervalMs: 0,
    fetch,
    sleep: async () => {},
    ...extra,
  });

describe('createHttp', () => {
  it('sends the auth header and query, records the response', async () => {
    const fetch = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) =>
      json(200, { ok: 1 }),
    );
    const record = vi.fn();
    const res = await client(fetch, { record })({
      name: 'thing',
      method: 'GET',
      path: '/v1/thing',
      query: { a: 1, skip: undefined },
    });
    expect(res).toEqual({ ok: 1 });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://api.example.test/v1/thing?a=1');
    expect(new Headers(init?.headers).get('x-api-key')).toBe(KEY);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'thing', response: { ok: 1 } }),
    );
    expect(JSON.stringify(record.mock.calls)).not.toContain(KEY);
  });

  it('retries a 429 (logging it) and then succeeds', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(429, {}, { 'retry-after': '1' }))
      .mockResolvedValueOnce(json(200, { ok: 2 }));
    const onRateLimited = vi.fn();
    const sleep = vi.fn(async () => {});
    const res = await client(fetch, { onRateLimited, sleep })({
      name: 'x',
      method: 'GET',
      path: '/x',
    });
    expect(res).toEqual({ ok: 2 });
    expect(onRateLimited).toHaveBeenCalledWith({ provider: 'p', path: '/x', attempt: 0 });
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it('gives up after the retry budget with an error that never contains the key', async () => {
    const fetch = vi.fn(async () => json(503));
    const err = await client(fetch)({ name: 'x', method: 'GET', path: '/x' }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toBe('p 503 GET /x');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(`${err.message} ${err.stack}`).not.toContain(KEY);
  });

  it('does not retry a 401 and hides network error details', async () => {
    const unauthorized = vi.fn(async () => json(401));
    await expect(client(unauthorized)({ name: 'x', method: 'GET', path: '/x' })).rejects.toThrow(
      'p 401 GET /x',
    );
    expect(unauthorized).toHaveBeenCalledTimes(1);

    const down = vi.fn(async () => {
      throw new Error(`connect failed with key ${KEY}`);
    });
    const err = await client(down)({ name: 'x', method: 'GET', path: '/x' }).catch((e) => e);
    expect(err.message).toBe('p network GET /x');
  });

  it('a response that does not match the schema fails with one short line', async () => {
    const fetch = vi.fn(async () => json(200, { error: 'Wallet not indexed' }));
    const err = await client(fetch)(
      { name: 'x', method: 'GET', path: '/v2/pnl/wallets/W/positions' },
      z.object({ positions: z.array(z.unknown()) }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toBe('p schema GET /v2/pnl/wallets/W/positions');
    expect(err.message).not.toContain('\n');
  });
});
