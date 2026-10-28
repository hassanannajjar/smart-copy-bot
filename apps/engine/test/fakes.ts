// Fake provider APIs that serve the recorded/doc-derived fixtures. No network.
import { readFileSync } from 'node:fs';
import {
  type BirdeyeApi,
  beGainersSchema,
  beIdentitiesSchema,
  type SolanaTrackerApi,
  stLeaderboardSchema,
  stPositionsSchema,
} from '@scb/shared';

const fixture = (path: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../packages/shared/test/fixtures/${path}.json`, import.meta.url),
      'utf8',
    ),
  ).response;

export const fakeSolanaTracker = (): SolanaTrackerApi => ({
  topTraders: async () => stLeaderboardSchema.parse(fixture('solanatracker/leaderboard-top')),
  profitablePositions: async () => stPositionsSchema.parse(fixture('solanatracker/positions')),
});

export const fakeBirdeye = (): BirdeyeApi => ({
  gainers: async () => beGainersSchema.parse(fixture('birdeye/gainers-losers')),
  identities: async () => beIdentitiesSchema.parse(fixture('birdeye/identity-multiple')),
});
