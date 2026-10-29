// Jupiter Swap V2 `/order` (quote only: no `taker`, so no transaction is ever built) and Price V3.
// Verified against the official docs and a real keyless recording: docs/providers/jupiter.md
// There is deliberately no `taker` parameter here: this client cannot produce a signable swap.
import { z } from 'zod';
import { createHttp, type HttpOptions, ProviderError } from './http.js';

export const JUPITER_BASE_URL = 'https://api.jup.ag';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const PRICE_V3_MAX_IDS = 50;

// Only the fields the executor reads. Amounts are raw (base units) as strings.
export const jupOrderSchema = z.object({
  inAmount: z.string().nullish(),
  outAmount: z.string().nullish(),
  feeBps: z.number().nullish(),
  priceImpact: z.number().nullish(), // percentage points
  router: z.string().nullish(),
  routePlan: z.array(z.object({ swapInfo: z.object({ ammKey: z.string() }) })).nullish(),
  errorCode: z.number().nullish(),
  error: z.string().nullish(),
});

export const jupPriceSchema = z.record(
  z.string(),
  z.object({ usdPrice: z.number(), liquidity: z.number().nullish(), decimals: z.number() }),
);

export interface JupQuote {
  inAmount: bigint;
  outAmount: bigint;
  feeBps: number;
  priceImpactPct: number | null;
  router: string | null;
  ammKeys: string[];
}

export type JupPrices = z.infer<typeof jupPriceSchema>;

export interface JupiterApi {
  /** ExactIn quote; null = no route (400, an error field, or a missing/zero outAmount). */
  quote(inputMint: string, outputMint: string, amount: bigint): Promise<JupQuote | null>;
  /** Up to PRICE_V3_MAX_IDS mints. Mints Jupiter deems unreliable are simply absent. */
  prices(mints: string[]): Promise<JupPrices>;
}

type ClientOptions = Omit<HttpOptions, 'provider' | 'baseUrl' | 'headers'> & { apiKey?: string };

export const createJupiterApi = ({ apiKey, ...o }: ClientOptions): JupiterApi => {
  // One client = one throttle: quotes and prices share Jupiter's per-org rate bucket.
  const http = createHttp({
    ...o,
    provider: 'jupiter',
    baseUrl: JUPITER_BASE_URL,
    headers: apiKey ? { 'x-api-key': apiKey } : {},
  });
  return {
    quote: async (inputMint, outputMint, amount) => {
      let res: z.infer<typeof jupOrderSchema>;
      try {
        res = await http(
          {
            name: `order-${outputMint === WSOL_MINT ? 'sell' : 'buy'}-${(outputMint === WSOL_MINT ? inputMint : outputMint).slice(0, 8)}`,
            method: 'GET',
            path: '/swap/v2/order',
            query: { inputMint, outputMint, amount: amount.toString() },
          },
          jupOrderSchema,
        );
      } catch (e) {
        if (e instanceof ProviderError && e.status === 400) return null;
        throw e;
      }
      const out = res.outAmount && /^\d+$/.test(res.outAmount) ? BigInt(res.outAmount) : 0n;
      if (res.error || res.errorCode || out === 0n) return null;
      return {
        inAmount: res.inAmount && /^\d+$/.test(res.inAmount) ? BigInt(res.inAmount) : amount,
        outAmount: out,
        feeBps: res.feeBps ?? 0,
        priceImpactPct: res.priceImpact ?? null,
        router: res.router ?? null,
        ammKeys: (res.routePlan ?? []).map((r) => r.swapInfo.ammKey),
      };
    },
    prices: async (mints) => {
      if (mints.length > PRICE_V3_MAX_IDS)
        throw new Error(`price/v3 takes <= ${PRICE_V3_MAX_IDS} ids`);
      return http(
        { name: 'price', method: 'GET', path: '/price/v3', query: { ids: mints.join(',') } },
        jupPriceSchema,
      );
    },
  };
};
