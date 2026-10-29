// Fake provider APIs that serve the committed fixtures (recorded or doc-derived). No network.
import { readFileSync } from 'node:fs';
import {
  type BirdeyeApi,
  beGainersSchema,
  beIdentitiesSchema,
  dsTokenPairsSchema,
  gtOhlcvSchema,
  type HeliusAccount,
  type HeliusFeeRpc,
  type HeliusRpc,
  type HeliusSignature,
  type HeliusStream,
  heliusTxPageSchema,
  heliusTxSchema,
  type JupiterApi,
  type JupPrices,
  jupPriceSchema,
  type LogsEvent,
  rcReportSchema,
  type SolanaTrackerApi,
  type StreamStatus,
  stLeaderboardSchema,
  stPositionsSchema,
} from '@scb/shared';
import type { Providers } from '../src/rules/enrich.js';

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
  accounts: Record<string, HeliusAccount | null> = {},
) => {
  const bySig = new Map(txs.map((t) => [t.tx.transaction.signatures[0], t]));
  const calls = {
    getTransaction: [] as string[],
    signatures: [] as unknown[],
    accounts: [] as string[],
  };
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
    getAccountInfo: async (address) => {
      calls.accounts.push(address);
      return accounts[address] ?? null;
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

/** Mints recorded with `pnpm rules:record` (fixtures in dexscreener/rugcheck/geckoterminal/helius). */
export const MINTS = {
  migrated: 'dyw5fDNv91eknniMG4tGCU1ZrzjuxbpsLiEzih6pump', // pump.fun -> PumpSwap, R5 fails
  curve: '58gj8ENdAg6pvEuaro6GrgZtRv4tpnsPJJcYMzCpjWmX', // still on the pump.fun curve, no LP token
  insiders: 'Bo9fcNZQ8J8BQP69Rbqt6sPpfwqtqh2KMy48ZBWdyvVb', // Raydium CPMM, 82-wallet insider network
  busy: 'EqRZn9nH4UPb36AVLuigzRfufa1z8b744vWpt5tjpump', // > R4_max_pages txs in its launch window
} as const;

/** The provider responses recorded for a mint, parsed, plus a takenAt matching the recording. */
export const recorded = (mint: string) => {
  const m = mint.slice(0, 8);
  const pairs = dsTokenPairsSchema.parse(fixture(`dexscreener/token-pairs-${m}`));
  const report = rcReportSchema.parse(fixture(`rugcheck/report-${m}`));
  const top = [...pairs].sort((a, b) => (b.liquidity?.usd ?? -1) - (a.liquidity?.usd ?? -1))[0];
  const candles = gtOhlcvSchema.parse(
    fixture(`geckoterminal/ohlcv-${top?.pairAddress.slice(0, 8)}`),
  ).data.attributes.ohlcv_list;
  const launchFile = heliusFixture(`launch-${m}`);
  const launch = {
    txs: heliusTxPageSchema.parse(launchFile.response.result).data,
    truncated: launchFile.truncated as boolean,
  };
  const takenAt = Math.max(...candles.map((c) => c[0])) * 1000 + 30_000;
  return { pairs, report, candles, launch, takenAt, raw: fixture(`dexscreener/token-pairs-${m}`) };
};

/** Providers serving the recorded fixtures; `fail` makes a provider throw like a 5xx would. */
export const fakeProviders = (fail: string[] = []) => {
  const calls: string[] = [];
  const guard = (name: string) => {
    calls.push(name);
    if (fail.includes(name)) throw new Error(`${name} 503 GET /x`);
  };
  const byPool = (pool: string) =>
    Object.values(MINTS)
      .map(recorded)
      .find((r) => r.pairs.some((p) => p.pairAddress === pool));
  const providers: Providers = {
    dexscreener: {
      tokenPairs: async (mint) => {
        guard('dexscreener');
        const r = recorded(mint);
        return { pairs: r.pairs, raw: r.raw };
      },
    },
    rugcheck: {
      report: async (mint) => {
        guard('rugcheck');
        return { report: recorded(mint).report, raw: rugcheckRaw(mint) };
      },
    },
    geckoterminal: {
      minuteCandles: async (pool) => {
        guard('geckoterminal');
        return { candles: byPool(pool)?.candles ?? [], raw: {} };
      },
    },
    helius: {
      transactionsForAddress: async (mint) => {
        guard('helius');
        return recorded(mint).launch;
      },
    },
  };
  return { providers, calls };
};

/** The rugcheck report raw JSON for a mint, as the rules stage stores it in token_snapshots. */
export const rugcheckRaw = (mint: string) => fixture(`rugcheck/report-${mint.slice(0, 8)}`);

/**
 * A Jupiter market the test moves by hand. Starts at the recorded Price V3 values; quotes fill at
 * mid minus `impactBps` (both sides), net of feeBps like the real /order. 6-decimals mints only.
 */
export const fakeJupiter = () => {
  const price = jupPriceSchema.parse(fixture('jupiter/price-58gj8ENd'));
  const m = {
    solUsd: price[WSOL]?.usdPrice ?? 100,
    mid: new Map<string, number>(),
    liq: new Map<string, number>(),
    impactBps: 200,
    feeBps: 10,
    omit: new Set<string>(), // absent from Price V3
    noRoute: new Set<string>(),
    failPrices: false,
    failQuotes: false,
    quotes: [] as { in: string; out: string; amount: bigint; at: number }[],
    priceCalls: [] as string[][],
    now: () => 0,
  };
  const take = (usd: number) => usd * (1 - m.impactBps / 10_000) * (1 - m.feeBps / 10_000);
  const jupiter: JupiterApi = {
    prices: async (ids) => {
      m.priceCalls.push(ids);
      if (m.failPrices) throw new Error('jupiter 503 GET /price/v3');
      const out: JupPrices = {};
      for (const id of ids) {
        if (id === WSOL) out[id] = { usdPrice: m.solUsd, liquidity: 9e8, decimals: 9 };
        else if (m.mid.has(id) && !m.omit.has(id))
          out[id] = { usdPrice: m.mid.get(id) ?? 0, liquidity: m.liq.get(id) ?? null, decimals: 6 };
      }
      return out;
    },
    quote: async (inputMint, outputMint, amount) => {
      m.quotes.push({ in: inputMint, out: outputMint, amount, at: m.now() });
      if (m.failQuotes) throw new Error('jupiter 503 GET /swap/v2/order');
      const mint = inputMint === WSOL ? outputMint : inputMint;
      const mid = m.mid.get(mint);
      if (m.noRoute.has(mint) || !mid) return null;
      const outAmount =
        inputMint === WSOL
          ? BigInt(Math.floor((take((Number(amount) / 1e9) * m.solUsd) / mid) * 1e6))
          : BigInt(Math.floor((take((Number(amount) / 1e6) * mid) / m.solUsd) * 1e9));
      return {
        inAmount: amount,
        outAmount,
        feeBps: m.feeBps,
        priceImpactPct: -m.impactBps / 100,
        router: 'metis',
        ammKeys: ['9DnxRbvLBb6n4bZEgZJLZC5br2ZasvCkHknU4rqpk4oH'],
      };
    },
  };
  return { jupiter, m };
};

/** Helius priority fees: a fixed micro-lamports/CU, or throws when `fail` is set. */
export const fakeFees = (microLamportsPerCu = 120_000) => {
  const f = { fail: false, calls: 0 };
  const fees: HeliusFeeRpc = {
    priorityFeeEstimate: async () => {
      f.calls++;
      if (f.fail) throw new Error('helius 503 POST getPriorityFeeEstimate');
      return microLamportsPerCu;
    },
  };
  return { fees, f };
};
