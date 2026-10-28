// RugCheck public API (keyless for the token report). Verified against the official Swagger spec
// and real recordings: docs/providers/rugcheck.md
import { z } from 'zod';
import { createHttp, type HttpOptions, ProviderError } from './http.js';

// Only the fields the enricher reads. Amounts are raw (base units); divide by 10^decimals.
export const rcReportSchema = z.object({
  mint: z.string(),
  creator: z.string().nullish(),
  creatorBalance: z.number().nullish(), // raw units, creator wallet only
  token: z.object({
    supply: z.number(),
    decimals: z.number(),
    mintAuthority: z.string().nullable(),
    freezeAuthority: z.string().nullable(),
  }),
  topHolders: z
    .array(
      z.object({
        address: z.string(), // token account
        owner: z.string().nullish(),
        pct: z.number(), // % of supply
        insider: z.boolean().nullish(),
      }),
    )
    .nullish(),
  markets: z
    .array(
      z.object({
        pubkey: z.string(), // pool address (= DexScreener pairAddress)
        marketType: z.string(),
        mintLP: z.string().nullish(), // the system program id means "no LP token"
        liquidityA: z.string().nullish(), // pool vaults
        liquidityB: z.string().nullish(),
        lp: z
          .object({
            lpLockedPct: z.number().nullish(),
            baseUSD: z.number().nullish(),
            quoteUSD: z.number().nullish(),
          })
          .nullish(),
      }),
    )
    .nullish(),
  knownAccounts: z
    .record(z.string(), z.object({ name: z.string().nullish(), type: z.string().nullish() }))
    .nullish(),
  graphInsidersDetected: z.number().nullish(),
  // Wallet clusters linked by transfers/funding; currentHolding is raw units still held.
  insiderNetworks: z
    .array(
      z.object({
        id: z.string(),
        size: z.number(),
        type: z.string().nullish(),
        tokenAmount: z.number().nullish(),
        currentHolding: z.number().nullish(),
      }),
    )
    .nullish(),
  totalHolders: z.number().nullish(),
  rugged: z.boolean().nullish(),
});

export type RcReport = z.infer<typeof rcReportSchema>;

export interface RugCheckApi {
  /** Full token report (`GET /v1/tokens/{mint}/report`). May be a cached report. */
  report(mint: string): Promise<{ report: RcReport; raw: unknown }>;
}

export const RUGCHECK_BASE_URL = 'https://api.rugcheck.xyz';

type ClientOptions = Omit<HttpOptions, 'provider' | 'baseUrl' | 'headers'>;

export const createRugCheckApi = (o: ClientOptions): RugCheckApi => {
  const http = createHttp({ ...o, provider: 'rugcheck', baseUrl: RUGCHECK_BASE_URL, headers: {} });
  return {
    report: async (mint) => {
      const path = `/v1/tokens/${encodeURIComponent(mint)}/report`;
      const raw = await http({ name: `report-${mint.slice(0, 8)}`, method: 'GET', path });
      const p = rcReportSchema.safeParse(raw);
      if (!p.success) throw new ProviderError('rugcheck', 'schema', 'GET', '/v1/tokens/report');
      return { report: p.data, raw };
    },
  };
};
