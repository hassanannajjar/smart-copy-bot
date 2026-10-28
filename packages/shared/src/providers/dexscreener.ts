// DexScreener public API (keyless). Verified against the official OpenAPI spec and a real
// recording: docs/providers/dexscreener.md
import { z } from 'zod';
import { createHttp, type HttpOptions, ProviderError } from './http.js';

const n = z.number().nullish();

// Only the fields the enricher reads; the untouched response goes to token_snapshots.raw_json.
export const dsPairSchema = z.object({
  chainId: z.string(),
  dexId: z.string(),
  pairAddress: z.string(),
  labels: z.array(z.string()).nullish(),
  baseToken: z.object({ address: z.string(), symbol: z.string().nullish() }),
  quoteToken: z.object({ address: z.string().nullish(), symbol: z.string().nullish() }),
  priceUsd: z.string().nullish(),
  priceChange: z.record(z.string(), z.number()).nullish(), // keys seen: m5, h1, h6, h24 (no 45m)
  liquidity: z.object({ usd: n }).nullish(), // absent on pump.fun bonding-curve pairs
  fdv: n,
  pairCreatedAt: n, // ms
});
export const dsTokenPairsSchema = z.array(dsPairSchema);

export type DsPair = z.infer<typeof dsPairSchema>;

export interface DexScreenerApi {
  /** Every pool of a token on Solana (`/token-pairs/v1/solana/{mint}`). */
  tokenPairs(mint: string): Promise<{ pairs: DsPair[]; raw: unknown }>;
}

export const DEXSCREENER_BASE_URL = 'https://api.dexscreener.com';

type ClientOptions = Omit<HttpOptions, 'provider' | 'baseUrl' | 'headers'>;

export const createDexScreenerApi = (o: ClientOptions): DexScreenerApi => {
  const http = createHttp({
    ...o,
    provider: 'dexscreener',
    baseUrl: DEXSCREENER_BASE_URL,
    headers: {},
  });
  return {
    tokenPairs: async (mint) => {
      const path = `/token-pairs/v1/solana/${encodeURIComponent(mint)}`;
      const raw = await http({ name: `token-pairs-${mint.slice(0, 8)}`, method: 'GET', path });
      const p = dsTokenPairsSchema.safeParse(raw);
      if (!p.success) throw new ProviderError('dexscreener', 'schema', 'GET', '/token-pairs/v1');
      return { pairs: p.data, raw };
    },
  };
};
