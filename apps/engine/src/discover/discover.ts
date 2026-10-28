// Wallet discovery: provider leaderboards -> filtered, merged, enriched, ranked candidates.
// One provider failing never discards the other's results.
import {
  type BeGainers,
  BIRDEYE_IDENTITY_BATCH,
  type BirdeyeApi,
  type HeliusRpc,
  ProviderError,
  type SolanaTrackerApi,
  type StIdentity,
  type StLeaderboard,
} from '@scb/shared';
import { parseSwap } from '../scout/parse.js';
import {
  type Candidate,
  compareCandidates,
  type DiscoveryConfig,
  type DropCounts,
  filterRows,
  isStarter,
  median,
  mergeRows,
  type Source,
  topTokenShare,
  type WindowRow,
} from './rank.js';

export interface ProviderRun {
  source: Source;
  status: 'ok' | 'failed' | 'skipped';
  rows: number;
  error?: string;
}

export interface DiscoveryResult {
  candidates: Candidate[];
  heliusCalls: number;
  fetched: number;
  dropped: DropCounts;
  providers: ProviderRun[];
  warnings: string[];
  notes: string[];
}

const lower = (xs: (string | null | undefined)[]) =>
  xs.filter((x): x is string => !!x).map((x) => x.toLowerCase());

/** Identity type + tags, plus synthetic labels for populated entity fields. */
export const stLabels = (id: StIdentity | null | undefined) =>
  id
    ? lower([
        id.type,
        ...(id.tags ?? []),
        id.exchange?.name ? 'exchange' : null,
        id.pool?.poolAddress ? 'pool' : null,
        id.bot?.name ? 'bot' : null,
        id.hacker?.label ? 'hacker' : null,
        id.spamDusting?.label ? 'spam' : null,
      ])
    : [];

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const perTrade = (usd: number | null | undefined, trades: number | null | undefined) =>
  typeof usd === 'number' && trades ? usd / trades : null;

type StTrader = StLeaderboard['traders'][number];
type BeItem = BeGainers['data']['items'][number];

/**
 * Solana Tracker reports winRate 0 for wallets with positive realized PnL when strict mode
 * leaves no closed tokens to count. That 0 means "unknown", not "never wins".
 */
export const stWinRate = (t: StTrader) =>
  t.winRate === 0 && (t.period?.realized ?? 0) > 0 ? null : (t.winRate ?? null);

/** Normalizes one Solana Tracker leaderboard row (exported for fixture-driven tests). */
export const stRow = (t: StTrader, days: number): WindowRow => ({
  address: t.wallet,
  source: 'solanatracker',
  windowDays: days,
  realizedPnl: t.period?.realized ?? null,
  // Token win rate (profitable/closed tokens). period.days.winRate is the share of
  // profitable *days*, a different and much rosier number.
  winRate: stWinRate(t),
  trades: t.counts?.trades ?? null,
  avgTradeUsd: t.averages?.buy ?? perTrade(t.period?.volume, t.counts?.trades),
  label: t.identity?.name ?? null,
  labels: stLabels(t.identity),
});

/** Normalizes one Birdeye gainers row (exported for fixture-driven tests). */
export const beRow = (i: BeItem, days: number): WindowRow => ({
  address: i.address,
  source: 'birdeye',
  windowDays: days,
  realizedPnl: i.realized_pnl ?? null,
  winRate: null, // not provided by Birdeye
  trades: i.trade_count ?? null,
  avgTradeUsd: perTrade(i.volume, i.trade_count),
  label: null,
  labels: [],
});

const fetchSolanaTracker = async (st: SolanaTrackerApi, cfg: DiscoveryConfig) => {
  const rows: WindowRow[] = [];
  for (const days of cfg.windows_days) {
    let cursor: string | undefined;
    for (let page = 0; page < cfg.max_pages.solanatracker; page++) {
      const res = await st.topTraders({
        days,
        minTrades: cfg.min_trades,
        minDays: cfg.min_days[`${days}`],
        maxSingleTokenPct: cfg.max_single_token_pct,
        excludeArbitrage: cfg.exclude_arbitrage,
        pnlMode: cfg.pnl_mode,
        limit: cfg.page_limit,
        cursor,
      });
      for (const t of res.traders) rows.push(stRow(t, days));
      if (!res.pagination.hasMore || !res.pagination.nextCursor) break;
      cursor = res.pagination.nextCursor;
    }
  }
  return rows;
};

const fetchBirdeye = async (be: BirdeyeApi, cfg: DiscoveryConfig) => {
  const rows: WindowRow[] = [];
  for (const days of cfg.windows_days) {
    for (let page = 0; page < cfg.max_pages.birdeye; page++) {
      const res = await be.gainers({
        type: days === 7 ? '1W' : `${days}d`,
        min_trade: cfg.min_trades,
        offset: page * cfg.page_limit,
        limit: cfg.page_limit,
      });
      for (const i of res.data.items) rows.push(beRow(i, days));
      if (res.data.items.length < cfg.page_limit) break;
    }
  }
  return rows;
};

/**
 * Adds Birdeye identity (type, label) to rows and records which addresses were checked.
 * Throws on the first failure; addresses checked before it stay in `checked`.
 */
const applyBirdeyeIdentity = async (be: BirdeyeApi, rows: WindowRow[], checked: Set<string>) => {
  const addresses = [...new Set(rows.map((r) => r.address))];
  for (let i = 0; i < addresses.length; i += BIRDEYE_IDENTITY_BATCH) {
    const batch = addresses.slice(i, i + BIRDEYE_IDENTITY_BATCH);
    const { data } = await be.identities(batch);
    for (const a of batch) checked.add(a);
    for (const r of rows) {
      const id = data[r.address];
      if (!id) continue;
      r.labels = [...r.labels, ...lower([id.type])];
      r.label ??= id.label ?? null;
    }
  }
};

/** Helius RPC plus what parseSwap needs (scout.quote_mint, prefilters.ignored_mints). */
export interface HeliusCheck {
  rpc: HeliusRpc;
  quoteMint: string;
  ignoredMints: readonly string[];
}

export interface Activity {
  lastSwapAt: number | null; // ms
  solQuotedSwaps: number;
  nonSolQuoteSwaps: number;
  solQuotePct: number | null;
}

/**
 * Newest signatures -> getTransaction on the newest non-failed ones -> the scout's parseSwap.
 * Stable-quoted and token-to-token swaps count as non-SOL-quoted; transfers and airdrops aren't swaps.
 */
export const checkActivity = async (
  rpc: HeliusRpc,
  wallet: string,
  a: DiscoveryConfig['activity'],
  h: Omit<HeliusCheck, 'rpc'>,
  now = Date.now(),
): Promise<Activity> => {
  const sigs = await rpc.signatures(wallet, { limit: a.signatures_limit });
  let sol = 0;
  let nonSol = 0;
  let last: number | null = null;
  const newest = sigs[0]?.blockTime;
  // Nothing at all inside the window means no swap either: skip the getTransaction credits.
  const stale = newest != null && newest * 1000 < now - a.max_inactive_h * 3_600_000;
  if (!stale) {
    for (const s of sigs.filter((s) => s.err == null).slice(0, a.tx_sample)) {
      const { tx } = await rpc.getTransaction(s.signature);
      if (!tx) continue;
      const p = parseSwap(tx, wallet, h.quoteMint, h.ignoredMints);
      if (!('skip' in p)) sol++;
      else if (p.skip === 'non_sol_quote' || p.skip === 'multi_token') nonSol++;
      else continue;
      const t = tx.blockTime ?? s.blockTime;
      if (t != null) last = Math.max(last ?? 0, t * 1000);
    }
  }
  const swaps = sol + nonSol;
  return {
    lastSwapAt: last,
    solQuotedSwaps: sol,
    nonSolQuoteSwaps: nonSol,
    solQuotePct: swaps ? (sol / swaps) * 100 : null,
  };
};

/** Drop reason for a checked wallet, or null to keep it. No swap seen counts as inactive. */
export const activityDrop = (a: Activity, cfg: DiscoveryConfig['activity'], now: number) => {
  if (a.lastSwapAt === null || now - a.lastSwapAt > cfg.max_inactive_h * 3_600_000)
    return 'inactive';
  if (a.solQuotePct === null || a.solQuotePct < cfg.min_sol_quote_pct) return 'not_memecoin_trader';
  return null;
};

export const discover = async (
  apis: { st?: SolanaTrackerApi; be?: BirdeyeApi; helius?: HeliusCheck },
  cfg: DiscoveryConfig,
  now = Date.now(),
): Promise<DiscoveryResult> => {
  // Every Helius RPC call costs 1 credit (getSignaturesForAddress, getTransaction).
  let heliusCalls = 0;
  const { helius } = apis;
  const rpc: HeliusRpc | undefined = helius && {
    getTransaction: (sig) => {
      heliusCalls++;
      return helius.rpc.getTransaction(sig);
    },
    signatures: (wallet, o) => {
      heliusCalls++;
      return helius.rpc.signatures(wallet, o);
    },
  };
  const warnings: string[] = [];
  const notes: string[] = [];
  const providers: ProviderRun[] = [];
  const rows: WindowRow[] = [];

  const run = async (source: Source, fetchRows: (() => Promise<WindowRow[]>) | null) => {
    if (!fetchRows) return providers.push({ source, status: 'skipped', rows: 0 });
    try {
      const got = await fetchRows();
      rows.push(...got);
      providers.push({ source, status: 'ok', rows: got.length });
    } catch (e) {
      providers.push({ source, status: 'failed', rows: 0, error: errorText(e) });
    }
  };
  const { st, be } = apis;
  await run('solanatracker', st ? () => fetchSolanaTracker(st, cfg) : null);
  await run('birdeye', be ? () => fetchBirdeye(be, cfg) : null);

  // Solana Tracker leaderboard rows carry identity (exchange/pool/bot/tags), so they count as checked.
  const identityChecked = new Set(
    rows.filter((r) => r.source === 'solanatracker').map((r) => r.address),
  );
  let identityProblem: { error: unknown } | null = null;
  if (be && rows.length) {
    try {
      await applyBirdeyeIdentity(be, rows, identityChecked);
    } catch (e) {
      identityProblem = { error: e };
    }
  }

  const { kept, dropped } = filterRows(rows, cfg);
  const compare = compareCandidates(cfg.windows_days.length);
  const merged = mergeRows(kept, identityChecked).sort(compare);

  if (identityProblem) {
    const e = identityProblem.error;
    const unchecked = merged.filter((c) => !c.identityChecked).length;
    if (e instanceof ProviderError && (e.status === 401 || e.status === 403)) {
      notes.push(
        `Birdeye identity unavailable on this plan (${e.status}); ${unchecked} rows identity_checked=false`,
      );
    } else {
      warnings.push(
        `birdeye identity lookup failed (${errorText(e)}); ${unchecked} rows identity_checked=false`,
      );
    }
  }

  // Enrich the top N identity-checked candidates (the only ones that can be starters): top-token
  // share and hold time from Solana Tracker positions, then the Helius activity check.
  // Anything not enriched stays unverified (kept, ranked below verified): this is a review list.
  const candidates: Candidate[] = [];
  let enriched = 0;
  for (const c of merged) {
    if (st && enriched < cfg.enrich_top_n && c.identityChecked) {
      enriched++;
      try {
        const res = await st.profitablePositions(c.address, cfg.enrich_period);
        const hold = median(res.positions.map((p) => p.timing?.holdTimeSecs));
        // Sub-2-minute median holds are sniping/flipping we cannot follow with copy latency.
        if (hold !== null && hold < cfg.min_median_hold_s) {
          dropped.short_hold = (dropped.short_hold ?? 0) + 1;
          continue;
        }
        c.medianHoldS = hold;
        const pct = topTokenShare(res.positions.map((p) => p.pnl.realized));
        if (pct !== null) {
          if (pct > cfg.max_single_token_pct) {
            dropped.one_token_profit = (dropped.one_token_profit ?? 0) + 1;
            continue;
          }
          c.topTokenPct = pct;
          c.topTokenPartial = res.pagination.hasMore;
          c.verified = true;
        }
      } catch (e) {
        warnings.push(`top-token check failed for ${c.address} (${errorText(e)}); left unverified`);
      }
      if (rpc && helius) {
        try {
          const a = await checkActivity(rpc, c.address, cfg.activity, helius, now);
          const reason = activityDrop(a, cfg.activity, now);
          if (reason) {
            dropped[reason] = (dropped[reason] ?? 0) + 1;
            continue;
          }
          c.lastSwapAt = a.lastSwapAt;
          c.solQuotePct = a.solQuotePct;
        } catch (e) {
          warnings.push(`activity check failed for ${c.address} (${errorText(e)}); left unchecked`);
        }
      }
    }
    candidates.push(c);
  }

  candidates.sort(compare);
  let starters = 0;
  for (const c of candidates) {
    if (starters < cfg.starter.max_wallets && isStarter(c, cfg.starter)) {
      c.starter = true;
      starters++;
    }
  }

  return {
    candidates,
    heliusCalls,
    fetched: rows.length,
    dropped,
    providers,
    warnings,
    notes,
  };
};
