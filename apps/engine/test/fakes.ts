// Fake provider APIs that serve the committed fixtures (recorded or doc-derived). No network.
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

export const stLeaderboard = () =>
  stLeaderboardSchema.parse(fixture('solanatracker/leaderboard-top'));
export const stPositions = () => stPositionsSchema.parse(fixture('solanatracker/positions'));
export const beGainers = () => beGainersSchema.parse(fixture('birdeye/gainers-losers'));

export const fakeSolanaTracker = (): SolanaTrackerApi => ({
  topTraders: async () => stLeaderboard(),
  profitablePositions: async () => stPositions(),
});

export const fakeBirdeye = (): BirdeyeApi => ({
  gainers: async () => beGainers(),
  identities: async () => beIdentitiesSchema.parse(fixture('birdeye/identity-multiple')),
});
