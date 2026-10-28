// GeckoTerminal public API (keyless, ~10 calls/min). Used only for R5's 45-minute price change,
// which DexScreener doesn't expose. Verified: docs/providers/geckoterminal.md
import { z } from 'zod';
import { createHttp, type HttpOptions, ProviderError } from './http.js';

// [timestamp_s, open, high, low, close, volume], newest first.
const candle = z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]);
export const gtOhlcvSchema = z.object({
  data: z.object({ attributes: z.object({ ohlcv_list: z.array(candle) }) }),
});

export type Candle = z.infer<typeof candle>;

export interface GeckoTerminalApi {
  /** 1-minute USD candles for a pool, including empty minutes, newest first. */
  minuteCandles(pool: string, limit: number): Promise<{ candles: Candle[]; raw: unknown }>;
}

export const GECKOTERMINAL_BASE_URL = 'https://api.geckoterminal.com';

type ClientOptions = Omit<HttpOptions, 'provider' | 'baseUrl' | 'headers'>;

export const createGeckoTerminalApi = (o: ClientOptions): GeckoTerminalApi => {
  const http = createHttp({
    ...o,
    provider: 'geckoterminal',
    baseUrl: GECKOTERMINAL_BASE_URL,
    headers: {},
  });
  return {
    minuteCandles: async (pool, limit) => {
      const path = `/api/v2/networks/solana/pools/${encodeURIComponent(pool)}/ohlcv/minute`;
      const raw = await http({
        name: `ohlcv-${pool.slice(0, 8)}`,
        method: 'GET',
        path,
        query: { aggregate: 1, limit, currency: 'usd', include_empty_intervals: true },
      });
      const p = gtOhlcvSchema.safeParse(raw);
      if (!p.success) throw new ProviderError('geckoterminal', 'schema', 'GET', '/ohlcv/minute');
      return { candles: p.data.data.attributes.ohlcv_list, raw };
    },
  };
};
