// Minimal JSON-over-HTTP client shared by every provider.
// Auth lives only in headers; errors and logs carry provider/status/method/path, never headers,
// so an API key can't leak through a log line or a thrown message.

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
    readonly status: number | 'network',
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

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const createHttp = (o: HttpOptions) => {
  const doFetch = o.fetch ?? fetch;
  const sleep = o.sleep ?? realSleep;
  let nextSlot = 0; // ponytail: per-client interval throttle, swap for bottleneck if calls go concurrent

  return async (req: RequestSpec): Promise<unknown> => {
    const query = req.query ?? {};
    const url = new URL(req.path, o.baseUrl);
    for (const [k, v] of Object.entries(query))
      if (v !== undefined) url.searchParams.set(k, String(v));

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
      const backoff = Math.min(30_000, 500 * 2 ** attempt) * (0.5 + Math.random());
      await sleep(retryAfterMs ?? backoff);
    }
  };
};
