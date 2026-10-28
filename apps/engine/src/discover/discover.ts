// Wallet discovery: provider leaderboards -> filtered, merged, enriched, ranked candidates.
// One provider failing never discards the other's results.
import {
  BIRDEYE_IDENTITY_BATCH,
  type BirdeyeApi,
  type SolanaTrackerApi,
  type StIdentity,
} from '@scb/shared';
import {
  type Candidate,
  compareCandidates,
  type DiscoveryConfig,
  type DropCounts,
  filterRows,
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
  fetched: number;
  dropped: DropCounts;
  providers: ProviderRun[];
  warnings: string[];
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

const fetchSolanaTracker = async (st: SolanaTrackerApi, cfg: DiscoveryConfig) => {
  const rows: WindowRow[] = [];
  for (const days of cfg.windows_days) {
    let cursor: string | undefined;
    for (let page = 0; page < cfg.max_pages; page++) {
      const res = await st.topTraders({
        days,
        minTrades: cfg.min_trades,
        minDays: cfg.min_days,
        maxSingleTokenPct: cfg.max_single_token_pct,
        excludeArbitrage: cfg.exclude_arbitrage,
        pnlMode: cfg.pnl_mode,
        limit: cfg.page_limit,
        cursor,
      });
      for (const t of res.traders) {
        rows.push({
          address: t.wallet,
          source: 'solanatracker',
          windowDays: days,
          realizedPnl: t.period?.realized ?? null,
          winRate: t.period?.days?.winRate ?? t.winRate ?? null,
          trades: t.counts?.trades ?? null,
          label: t.identity?.name ?? null,
          labels: stLabels(t.identity),
        });
      }
      if (!res.pagination.hasMore || !res.pagination.nextCursor) break;
      cursor = res.pagination.nextCursor;
    }
  }
  return rows;
};

const fetchBirdeye = async (be: BirdeyeApi, cfg: DiscoveryConfig) => {
  const rows: WindowRow[] = [];
  for (const days of cfg.windows_days) {
    for (let page = 0; page < cfg.max_pages; page++) {
      const res = await be.gainers({
        type: `${days}d`,
        min_trade: cfg.min_trades,
        offset: page * cfg.page_limit,
        limit: cfg.page_limit,
      });
      for (const i of res.data.items) {
        rows.push({
          address: i.address,
          source: 'birdeye',
          windowDays: days,
          realizedPnl: i.realized_pnl ?? null,
          winRate: null, // not provided by Birdeye
          trades: i.trade_count ?? null,
          label: null,
          labels: [],
        });
      }
      if (res.data.items.length < cfg.page_limit) break;
    }
  }
  return rows;
};

/** Adds Birdeye identity (type, label) to every row of each known address. */
const applyBirdeyeIdentity = async (be: BirdeyeApi, rows: WindowRow[]) => {
  const addresses = [...new Set(rows.map((r) => r.address))];
  for (let i = 0; i < addresses.length; i += BIRDEYE_IDENTITY_BATCH) {
    const { data } = await be.identities(addresses.slice(i, i + BIRDEYE_IDENTITY_BATCH));
    for (const r of rows) {
      const id = data[r.address];
      if (!id) continue;
      r.labels = [...r.labels, ...lower([id.type])];
      r.label ??= id.label ?? null;
    }
  }
};

export const discover = async (
  apis: { st?: SolanaTrackerApi; be?: BirdeyeApi },
  cfg: DiscoveryConfig,
): Promise<DiscoveryResult> => {
  const warnings: string[] = [];
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

  if (be && rows.length) {
    try {
      await applyBirdeyeIdentity(be, rows);
    } catch (e) {
      warnings.push(
        `birdeye identity lookup failed (${errorText(e)}); exchange/program check incomplete`,
      );
    }
  }

  const { kept, dropped } = filterRows(rows, cfg);
  const compare = compareCandidates(cfg.windows_days.length);
  const merged = mergeRows(kept).sort(compare);

  // Enrich the top N Solana Tracker-backed candidates with a top-token share.
  // Anything not enriched stays unverified (kept, ranked below verified): this is a review list.
  const candidates: Candidate[] = [];
  let enriched = 0;
  for (const c of merged) {
    if (st && enriched < cfg.enrich_top_n && c.sources.includes('solanatracker')) {
      enriched++;
      try {
        const res = await st.profitablePositions(c.address, cfg.enrich_period);
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
    }
    candidates.push(c);
  }

  return {
    candidates: candidates.sort(compare),
    fetched: rows.length,
    dropped,
    providers,
    warnings,
  };
};
