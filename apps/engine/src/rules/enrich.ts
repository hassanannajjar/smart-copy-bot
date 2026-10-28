// Enricher: provider responses -> Snapshot. Fetching is separate from the pure builders, so the
// rules can be re-run offline on recorded responses (fixtures today, replay in M5).
import {
  type Candle,
  type Config,
  createDexScreenerApi,
  createGeckoTerminalApi,
  createHeliusRpc,
  createRugCheckApi,
  type DexScreenerApi,
  type DsPair,
  type GeckoTerminalApi,
  type HeliusHistoryRpc,
  type HeliusTx,
  type RcReport,
  type RecordedCall,
  type RugCheckApi,
} from '@scb/shared';
import { parseSwap } from '../scout/parse.js';
import type { BundleScores, Snapshot } from './rules.js';

export type EnricherConfig = Config['enricher'];

const SYSTEM_PROGRAM = '11111111111111111111111111111111'; // RugCheck's "no LP mint" marker
const TOP_N = 10; // R2 is defined as the top-10 holders

const round = (v: number) => Math.round(v * 1e4) / 1e4;

/** The mint's Solana pools as base token; the deepest one is the pair we'd trade through. */
export const pickPairs = (pairs: DsPair[], mint: string) => {
  const own = pairs.filter((p) => p.chainId === 'solana' && p.baseToken.address === mint);
  const top = [...own].sort((a, b) => (b.liquidity?.usd ?? -1) - (a.liquidity?.usd ?? -1))[0];
  const created = own.map((p) => p.pairCreatedAt).filter((t): t is number => t != null);
  return { top, pairCreatedAt: created.length ? Math.min(...created) : null };
};

/**
 * R4 launch-window part (v1 heuristic). Each tx's fee payer is the buyer; a buy is the scout's
 * own swap parse (token up, SOL down). Bundled = bought in the window's first slot, plus slots
 * where >= minBuyers distinct wallets bought. Limits: no funder/fresh-wallet check here (that
 * part comes from RugCheck insider networks), relayed buys with a third-party fee payer are
 * missed, and txs that don't reference the mint account are invisible to the query.
 */
export const launchBundle = (
  txs: HeliusTx[],
  mint: string,
  supplyUi: number,
  minBuyers: number,
  quoteMint: string,
  ignoredMints: readonly string[],
): Omit<BundleScores, 'insiderNetworkPct' | 'truncated'> => {
  const slots = new Map<number, { buyers: Set<string>; amount: number }>();
  const buyers = new Set<string>();
  let firstSlot = Number.POSITIVE_INFINITY;
  for (const tx of txs) {
    firstSlot = Math.min(firstSlot, tx.slot);
    const payer = tx.transaction.message.accountKeys[0]?.pubkey;
    if (!payer) continue;
    const p = parseSwap(tx, payer, quoteMint, ignoredMints);
    if (!('side' in p) || p.side !== 'buy' || p.mint !== mint) continue;
    const s = slots.get(tx.slot) ?? { buyers: new Set<string>(), amount: 0 };
    s.buyers.add(payer);
    s.amount += p.amountToken;
    slots.set(tx.slot, s);
    buyers.add(payer);
  }
  const pct = (amount: number) => (supplyUi > 0 ? round((amount / supplyUi) * 100) : 0);
  let cluster = 0;
  let clusterSlots = 0;
  let all = 0;
  for (const [slot, s] of slots) {
    all += s.amount;
    if (slot === firstSlot || s.buyers.size >= minBuyers) {
      cluster += s.amount;
      clusterSlots++;
    }
  }
  return {
    launchSlotPct: pct(slots.get(firstSlot)?.amount ?? 0),
    slotClusterPct: pct(cluster),
    windowBuyPct: pct(all),
    buyers: buyers.size,
    clusterSlots,
    txs: txs.length,
  };
};

/** R2: top-10 % after dropping pool vaults (known AMM accounts) and burn owners. */
export const top10Pct = (r: RcReport, cfg: EnricherConfig) => {
  if (!r.topHolders) return null;
  const known = r.knownAccounts ?? {};
  const isType = (a?: string | null) =>
    a != null && cfg.R2_exclude_known_types.includes(known[a]?.type ?? '');
  const vaults = new Set((r.markets ?? []).flatMap((m) => [m.liquidityA, m.liquidityB]));
  const kept = r.topHolders.filter(
    (h) =>
      !isType(h.owner) &&
      !isType(h.address) &&
      !vaults.has(h.address) &&
      !cfg.R2_exclude_owners.includes(h.owner ?? ''),
  );
  return round(kept.slice(0, TOP_N).reduce((sum, h) => sum + h.pct, 0));
};

/** R5: % change from the open of the candle covering takenAt - window to the latest close. */
export const priceChange = (candles: Candle[], takenAtMs: number, windowMin: number) => {
  const asc = [...candles].sort((a, b) => a[0] - b[0]);
  const last = asc.at(-1);
  if (!last) return { pct: null, partial: false };
  const t0 = takenAtMs / 1000 - windowMin * 60;
  const covering = asc.filter((c) => c[0] <= t0).at(-1);
  const ref = covering ?? asc[0];
  if (!ref || ref[1] <= 0) return { pct: null, partial: false };
  return { pct: round((last[4] / ref[1] - 1) * 100), partial: !covering };
};

export interface Fetched {
  pairs?: DsPair[];
  report?: RcReport;
  candles?: Candle[];
  launch?: { txs: HeliusTx[]; truncated: boolean };
  errors: Record<string, string>;
}

/** Pure: everything a snapshot holds is derived here from the provider responses. */
export const buildSnapshot = (
  mint: string,
  f: Fetched,
  takenAt: number,
  config: Config,
): Snapshot => {
  const cfg = config.enricher;
  const { top, pairCreatedAt } = pickPairs(f.pairs ?? [], mint);
  const r = f.report;
  const market = top && r?.markets?.find((m) => m.pubkey === top.pairAddress);

  let liquidityUsd = top?.liquidity?.usd ?? null;
  let liquiditySource: Snapshot['liquiditySource'] = liquidityUsd === null ? null : 'dexscreener';
  // pump.fun bonding curves have no DexScreener liquidity; RugCheck values the curve's reserves.
  if (
    liquidityUsd === null &&
    market?.lp &&
    (market.lp.baseUSD != null || market.lp.quoteUSD != null)
  ) {
    liquidityUsd = round((market.lp.baseUSD ?? 0) + (market.lp.quoteUSD ?? 0));
    liquiditySource = 'rugcheck';
  }

  const supply = r ? r.token.supply / 10 ** r.token.decimals : 0;
  const devPct =
    r?.creator && r.creatorBalance != null && r.token.supply > 0
      ? round((r.creatorBalance / r.token.supply) * 100)
      : null;

  const lpApplicable = market ? Boolean(market.mintLP && market.mintLP !== SYSTEM_PROGRAM) : null;
  const lpLockedPct = lpApplicable ? (market?.lp?.lpLockedPct ?? null) : null;

  let bundle: BundleScores | null = null;
  if (r && f.launch && r.token.supply > 0) {
    const held = (r.insiderNetworks ?? []).reduce(
      (sum, n) => sum + (n.currentHolding ?? n.tokenAmount ?? 0),
      0,
    );
    bundle = {
      insiderNetworkPct: round((held / r.token.supply) * 100),
      ...launchBundle(
        f.launch.txs,
        mint,
        supply,
        cfg.R4_slot_cluster_min_buyers,
        config.scout.quote_mint,
        config.prefilters.ignored_mints,
      ),
      truncated: f.launch.truncated,
    };
  }

  const r5 = f.candles ? priceChange(f.candles, takenAt, cfg.R5_window_min) : null;
  const price = top?.priceUsd == null ? null : Number(top.priceUsd);

  return {
    takenAt,
    priceUsd: price !== null && Number.isFinite(price) ? price : null,
    liquidityUsd,
    liquiditySource,
    fdvUsd: top?.fdv ?? null,
    pairAddress: top?.pairAddress ?? null,
    pairCreatedAt,
    priceChange5m: top?.priceChange?.m5 ?? null,
    priceChange45m: r5?.pct ?? null,
    priceChangePartial: r5?.partial ?? false,
    top10Pct: r ? top10Pct(r, cfg) : null,
    devPct,
    bundledPct: bundle ? Math.max(bundle.insiderNetworkPct, bundle.slotClusterPct) : null,
    bundle,
    mintAuthorityRevoked: r ? r.token.mintAuthority === null : null,
    freezeAuthorityRevoked: r ? r.token.freezeAuthority === null : null,
    lpApplicable,
    lpLockedPct,
    errors: f.errors,
  };
};

export interface Providers {
  dexscreener: DexScreenerApi;
  rugcheck: RugCheckApi;
  geckoterminal: GeckoTerminalApi;
  helius: HeliusHistoryRpc;
}

type Limits = Config['enricher']['dexscreener'];
const limits = (l: Limits) => ({
  minIntervalMs: l.min_interval_ms,
  timeoutMs: l.timeout_ms,
  retries: l.retries,
});

export const createProviders = (
  config: Config,
  heliusApiKey: string,
  onRateLimited: (i: { provider: string; path: string; attempt: number }) => void,
  record?: (provider: string) => (call: RecordedCall) => void,
): Providers => {
  const cfg = config.enricher;
  return {
    dexscreener: createDexScreenerApi({
      ...limits(cfg.dexscreener),
      onRateLimited,
      record: record?.('dexscreener'),
    }),
    rugcheck: createRugCheckApi({
      ...limits(cfg.rugcheck),
      onRateLimited,
      record: record?.('rugcheck'),
    }),
    geckoterminal: createGeckoTerminalApi({
      ...limits(cfg.geckoterminal),
      onRateLimited,
      record: record?.('geckoterminal'),
    }),
    // Its own client and throttle, separate from the scout's: launch-window scans never delay it.
    helius: createHeliusRpc({
      apiKey: heliusApiKey,
      commitment: config.scout.commitment,
      ...limits(cfg.helius),
      onRateLimited,
    }),
  };
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * DexScreener first (pair + age); then RugCheck, GeckoTerminal and Helius in parallel, each on
 * its own throttle. A failed provider leaves its fields empty, so the rules fail closed.
 * `raw` keeps the untouched responses for token_snapshots.raw_json (not the Helius txs: MBs).
 */
export const fetchForMint = async (
  mint: string,
  p: Providers,
  config: Config,
  afterPairs: (pairCreatedAt: number | null) => boolean = () => true,
) => {
  const cfg = config.enricher;
  const f: Fetched = { errors: {} };
  const raw: Record<string, unknown> = {};
  try {
    const ds = await p.dexscreener.tokenPairs(mint);
    f.pairs = ds.pairs;
    raw.dexscreener = ds.raw;
  } catch (e) {
    f.errors.dexscreener = errText(e);
  }
  const { top, pairCreatedAt } = pickPairs(f.pairs ?? [], mint);
  if (!top) f.errors.dexscreener ??= 'no solana pair for mint';
  // No pair: nothing to trade through, so don't spend the slower providers' budget.
  if (!top || !afterPairs(pairCreatedAt)) return { f, raw };

  const safe = async <T>(name: string, fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (e) {
      f.errors[name] = errText(e);
      return undefined;
    }
  };
  const [rc, gt, launch] = await Promise.all([
    safe('rugcheck', () => p.rugcheck.report(mint)),
    safe('geckoterminal', () =>
      p.geckoterminal.minuteCandles(top.pairAddress, cfg.R5_window_min + 2),
    ),
    pairCreatedAt === null
      ? undefined
      : safe('helius', () =>
          p.helius.transactionsForAddress(mint, {
            fromS: Math.floor(pairCreatedAt / 1000),
            toS: Math.floor(pairCreatedAt / 1000) + config.rules.R4_window_s,
            maxPages: cfg.R4_max_pages,
          }),
        ),
  ]);
  f.report = rc?.report;
  f.candles = gt?.candles;
  f.launch = launch;
  if (rc) raw.rugcheck = rc.raw;
  if (gt) raw.geckoterminal = gt.raw;
  return { f, raw };
};
