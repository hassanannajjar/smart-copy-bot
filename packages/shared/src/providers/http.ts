// Minimal JSON-over-HTTP client shared by every provider.
// Auth lives in headers (or authQuery for query-param providers); errors and logs carry
// provider/status/method/path only, so an API key can't leak through a log line or a thrown message.
import type { z } from 'zod';

export type Query = Record<string, string | number | boolean | undefined>;

export interface RecordedCall {
  name: string;
  request: { method: string; path: string; query: Query; body?: unknown };
  response: unknown;
}

export interface HttpOptions {
  provider: string;
  baseUrl: string;
  headers: Record<string, string>;
  /** For providers that auth by query param (Helius). Sent on the URL; never recorded or thrown. */
  authQuery?: Record<string, string>;
  timeoutMs: number;
  retries: number;
  minIntervalMs: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onRateLimited?: (info: { provider: string; path: string; attempt: number }) => void;
  record?: (call: RecordedCall) => void;
}

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number | 'network' | 'schema', // schema = response shape didn't match
    readonly method: string,
    readonly path: string,
  ) {
    super(`${provider} ${status} ${method} ${path}`);
    this.name = 'ProviderError';
  }
}

export interface RequestSpec {
  name: string; // fixture name used by --record
  method: 'GET' | 'POST';
  path: string;
  query?: Query;
  body?: unknown;
}

/** Exponential backoff with jitter (x0.5..x1.5), capped. Shared by HTTP retries and WS reconnects. */
export const backoffMs = (attempt: number, baseMs: number, capMs: number, random = Math.random) =>
  Math.min(capMs, baseMs * 2 ** attempt) * (0.5 + random());

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const createHttp = (o: HttpOptions) => {
  const doFetch = o.fetch ?? fetch;
  const sleep = o.sleep ?? realSleep;
  let nextSlot = 0; // ponytail: per-client interval throttle, swap for bottleneck if calls go concurrent

  /** With a schema, a shape mismatch throws a one-line ProviderError (status 'schema'). */
  async function request(req: RequestSpec): Promise<unknown>;
  async function request<T>(req: RequestSpec, schema: z.ZodType<T>): Promise<T>;
  async function request(req: RequestSpec, schema?: z.ZodType) {
    const json = await send(req);
    if (!schema) return json;
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new ProviderError(o.provider, 'schema', req.method, req.path);
    return parsed.data;
  }

  const send = async (req: RequestSpec): Promise<unknown> => {
    const query = req.query ?? {};
    const url = new URL(req.path, o.baseUrl);
    for (const [k, v] of Object.entries(query))
      if (v !== undefined) url.searchParams.set(k, String(v));
    for (const [k, v] of Object.entries(o.authQuery ?? {})) url.searchParams.set(k, v);

    for (let attempt = 0; ; attempt++) {
      const wait = nextSlot - Date.now();
      if (wait > 0) await sleep(wait);
      nextSlot = Date.now() + o.minIntervalMs;

      let status: number | 'network';
      let retryAfterMs: number | undefined;
      try {
        const res = await doFetch(url, {
          method: req.method,
          headers: {
            accept: 'application/json',
            ...(req.body === undefined ? {} : { 'content-type': 'application/json' }),
            ...o.headers,
          },
          body: req.body === undefined ? undefined : JSON.stringify(req.body),
          signal: AbortSignal.timeout(o.timeoutMs),
        });
        if (res.ok) {
          const json: unknown = await res.json();
          o.record?.({
            name: req.name,
            request: { method: req.method, path: req.path, query, body: req.body },
            response: json,
          });
          return json;
        }
        status = res.status;
        const ra = Number(res.headers.get('retry-after'));
        if (ra > 0) retryAfterMs = ra * 1000;
      } catch {
        status = 'network'; // timeout or connection error; the cause may echo the URL, so drop it
      }

      if (status === 429) o.onRateLimited?.({ provider: o.provider, path: req.path, attempt });
      const retryable = status === 'network' || status === 429 || status >= 500;
      if (!retryable || attempt >= o.retries) {
        throw new ProviderError(o.provider, status, req.method, req.path);
      }
      const backoff = backoffMs(attempt, 500, 30_000);
      // Never retry faster than the provider throttle allows.
      await sleep(Math.max(retryAfterMs ?? backoff, o.minIntervalMs));
    }
  };

  return request;
};
