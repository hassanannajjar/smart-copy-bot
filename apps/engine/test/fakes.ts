// Fake provider APIs that serve the committed fixtures (recorded or doc-derived). No network.
import { readFileSync } from 'node:fs';
import {
  type BirdeyeApi,
  beGainersSchema,
  beIdentitiesSchema,
  type HeliusRpc,
  type HeliusSignature,
  type HeliusStream,
  heliusTxSchema,
  type LogsEvent,
  type SolanaTrackerApi,
  type StreamStatus,
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

export const WSOL = 'So11111111111111111111111111111111111111112';

const heliusFixture = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../packages/shared/test/fixtures/helius/${name}.json`, import.meta.url),
      'utf8',
    ),
  );

/** A recorded getTransaction fixture: parsed tx, the tracked wallet it was recorded for, raw result. */
export const heliusTx = (name: string) => {
  const f = heliusFixture(name);
  const raw = f.response.result;
  return { tx: heliusTxSchema.parse(raw), wallet: f.wallet as string, raw };
};

/** RPC serving fixtures by signature; unknown signatures return null (not yet available). */
export const fakeHeliusRpc = (
  txs: ReturnType<typeof heliusTx>[],
  signatures: Record<string, HeliusSignature[]> = {},
) => {
  const bySig = new Map(txs.map((t) => [t.tx.transaction.signatures[0], t]));
  const calls = { getTransaction: [] as string[], signatures: [] as unknown[] };
  const rpc: HeliusRpc = {
    getTransaction: async (sig) => {
      calls.getTransaction.push(sig);
      const t = bySig.get(sig);
      return t ? { tx: t.tx, raw: t.raw } : { tx: null, raw: null };
    },
    signatures: async (wallet, o) => {
      calls.signatures.push({ wallet, ...o });
      return signatures[wallet] ?? [];
    },
  };
  return { rpc, calls };
};

/** A stream the test drives by hand. */
export const fakeHeliusStream = () => {
  let handlers: Parameters<HeliusStream['start']>[1] | undefined;
  const s = {
    started: [] as string[],
    stopped: false,
    stream: {
      start: (wallets, on) => {
        s.started = wallets;
        handlers = on;
      },
      stop: () => {
        s.stopped = true;
      },
    } satisfies HeliusStream,
    logs: (e: Partial<LogsEvent> & { wallet: string; signature: string }) =>
      handlers?.logs({ err: null, slot: 1, receivedAt: Date.now(), raw: {}, ...e }),
    status: (st: StreamStatus) => handlers?.status(st),
  };
  return s;
};
