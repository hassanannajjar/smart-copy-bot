// Birdeye Data API. Verified against the official docs: docs/providers/birdeye.md
// Note: no Birdeye wallet leaderboard supports a wallet_tags/smart_trader filter (checked 2026-10-28).
import { z } from 'zod';
import { createHttp, type HttpOptions } from './http.js';

export const beGainersSchema = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(
      z.object({
        address: z.string(),
        realized_pnl: z.number().nullish(),
        trade_count: z.number().nullish(),
        volume: z.number().nullish(), // USD, buys + sells
      }),
    ),
  }),
});

export const beIdentitiesSchema = z.object({
  success: z.literal(true),
  // Map keyed by address; addresses with no known identity are omitted.
  data: z.record(
    z.string(),
    z.object({
      type: z.string().nullish(),
      label: z.string().nullish(),
      tags: z.array(z.string()).nullish(),
    }),
  ),
});

export type BeGainers = z.infer<typeof beGainersSchema>;
export type BeIdentities = z.infer<typeof beIdentitiesSchema>;

export interface BeGainersQuery {
  type: '1W' | '30d' | '90d';
  min_trade: number;
  offset: number;
  limit: number;
}

export interface BirdeyeApi {
  /** Trader gainers ranked by realized PnL over the window. */
  gainers(q: BeGainersQuery): Promise<BeGainers>;
  /** Identity for up to 100 addresses per call. */
  identities(addresses: string[]): Promise<BeIdentities>;
}

export const BIRDEYE_BASE_URL = 'https://public-api.birdeye.so';
export const BIRDEYE_IDENTITY_BATCH = 100;

type ClientOptions = Omit<HttpOptions, 'provider' | 'baseUrl' | 'headers'> & { apiKey: string };

export const createBirdeyeApi = ({ apiKey, ...o }: ClientOptions): BirdeyeApi => {
  const http = createHttp({
    ...o,
    provider: 'birdeye',
    baseUrl: BIRDEYE_BASE_URL,
    headers: { 'X-API-KEY': apiKey, 'x-chain': 'solana' },
  });
  return {
    gainers: async (q) =>
      http(
        {
          name: 'gainers-losers',
          method: 'GET',
          path: '/trader/gainers-losers',
          query: { sort_by: 'realized_pnl', ...q },
        },
        beGainersSchema,
      ),
    identities: async (addresses) => {
      if (addresses.length > BIRDEYE_IDENTITY_BATCH) {
        throw new Error(`birdeye identities: max ${BIRDEYE_IDENTITY_BATCH} addresses per call`);
      }
      return http(
        {
          name: 'identity-multiple',
          method: 'POST',
          path: '/identity/v1/multiple',
          body: { addresses },
        },
        beIdentitiesSchema,
      );
    },
  };
};
