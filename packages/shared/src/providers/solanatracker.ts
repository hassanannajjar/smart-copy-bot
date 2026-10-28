// Solana Tracker Data API (PnL V2). Verified against the official docs: docs/providers/solanatracker.md
import { z } from 'zod';
import { createHttp, type HttpOptions } from './http.js';

const num = z.number().nullish();
const str = z.string().nullish();

// Only the fields we read; unknown fields are stripped. Most are nullish because the
// documented examples omit them on some rows.
export const stIdentitySchema = z.object({
  name: str,
  type: str,
  tags: z.array(z.string()).nullish(),
  exchange: z.object({ name: str }).nullish(),
  pool: z.object({ poolAddress: str }).nullish(),
  bot: z.object({ name: str }).nullish(),
  hacker: z.object({ label: str }).nullish(),
  spamDusting: z.object({ label: str }).nullish(),
});

const pagination = z.object({ hasMore: z.boolean(), nextCursor: str });

export const stLeaderboardSchema = z.object({
  traders: z.array(
    z.object({
      wallet: z.string(),
      period: z
        .object({
          realized: num,
          tradingDays: num,
          days: z.object({ winRate: num }).nullish(),
        })
        .nullish(),
      counts: z.object({ trades: num }).nullish(),
      winRate: num,
      identity: stIdentitySchema.nullish(),
    }),
  ),
  pagination,
});

export const stPositionsSchema = z.object({
  positions: z.array(z.object({ token: z.string(), pnl: z.object({ realized: num }) })),
  pagination,
});

export type StIdentity = z.infer<typeof stIdentitySchema>;
export type StLeaderboard = z.infer<typeof stLeaderboardSchema>;
export type StPositions = z.infer<typeof stPositionsSchema>;

export interface StTopTradersQuery {
  days: 1 | 7 | 30 | 90;
  minTrades: number;
  minDays: number;
  maxSingleTokenPct: number;
  excludeArbitrage: boolean;
  pnlMode: 'strict' | 'adjusted' | 'raw';
  limit: number;
  cursor?: string;
}

export type StPeriod = '1d' | '7d' | '14d' | '30d' | '90d' | 'all';

export interface SolanaTrackerApi {
  topTraders(q: StTopTradersQuery): Promise<StLeaderboard>;
  /** Profitable positions sorted by realized PnL desc, first page only (see pagination.hasMore). */
  profitablePositions(wallet: string, period: StPeriod): Promise<StPositions>;
}

export const SOLANATRACKER_BASE_URL = 'https://data.solanatracker.io';

type ClientOptions = Omit<HttpOptions, 'provider' | 'baseUrl' | 'headers'> & { apiKey: string };

export const createSolanaTrackerApi = ({ apiKey, ...o }: ClientOptions): SolanaTrackerApi => {
  const http = createHttp({
    ...o,
    provider: 'solanatracker',
    baseUrl: SOLANATRACKER_BASE_URL,
    headers: { 'x-api-key': apiKey },
  });
  return {
    topTraders: async (q) =>
      stLeaderboardSchema.parse(
        await http({
          name: 'leaderboard-top',
          method: 'GET',
          path: '/v2/pnl/leaderboard/top',
          query: { sort: 'realized', direction: 'desc', ...q },
        }),
      ),
    profitablePositions: async (wallet, period) =>
      stPositionsSchema.parse(
        await http({
          name: 'positions',
          method: 'GET',
          path: `/v2/pnl/wallets/${encodeURIComponent(wallet)}/positions`,
          query: { filter: 'profitable', sort: 'realized', direction: 'desc', period, limit: 200 },
        }),
      ),
  };
};
