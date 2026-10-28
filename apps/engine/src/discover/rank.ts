// Pure filter / merge / rank / CSV logic for wallet discovery. No I/O except writeCandidates.
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Config } from '@scb/shared';

export type DiscoveryConfig = Config['discovery'];
export type Source = 'solanatracker' | 'birdeye';

/** One leaderboard row from one provider for one window, normalized. */
export interface WindowRow {
  address: string;
  source: Source;
  windowDays: number;
  realizedPnl: number | null;
  winRate: number | null; // percent, 0..100
  trades: number | null;
  avgTradeUsd: number | null;
  label: string | null;
  labels: string[]; // identity type/tags, lowercased
}

export interface Candidate {
  address: string;
  label: string;
  sources: Source[];
  windows: number[];
  realizedPnl: number;
  winRate: number | null;
  trades: number | null;
  tradesPerDay: number | null;
  avgTradeUsd: number | null;
  topTokenPct: number | null;
  topTokenPartial: boolean;
  medianHoldS: number | null;
  verified: boolean;
  identityChecked: boolean;
  lastSwapAt: number | null; // ms; set only by the Helius activity check
  solQuotePct: number | null;
  starter: boolean;
}

export type DropCounts = Record<string, number>;

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const unique = <T>(xs: T[]) => [...new Set(xs)];

/**
 * Returns rows worth keeping and per-reason drop counts (counted per row).
 * An identity flag on any row drops every row of that address: if one provider says
 * "exchange", the other provider's clean-looking row for the same wallet goes too.
 */
export const filterRows = (rows: WindowRow[], cfg: DiscoveryConfig) => {
  const flaggedBy = new Map<string, string>();
  for (const r of rows) {
    const label = r.labels.find((l) => cfg.drop_identity_labels.includes(l));
    if (label && !flaggedBy.has(r.address)) flaggedBy.set(r.address, label);
  }
  const reasonFor = (r: WindowRow) => {
    if (!BASE58_ADDRESS.test(r.address)) return 'invalid_address';
    const flag = flaggedBy.get(r.address);
    if (flag) return `identity_${flag}`;
    if (r.realizedPnl === null || r.realizedPnl <= 0) return 'unprofitable';
    // Arbitrage/MEV bots trade far more often than any human copy target.
    if (r.trades !== null && r.trades / r.windowDays > cfg.max_trades_per_day)
      return 'bot_trade_rate';
    // 90%+ token win rate over hundreds of trades: bots, or wallets that never sell losers.
    if (
      r.winRate !== null &&
      r.trades !== null &&
      r.winRate >= cfg.suspicious_win_rate_pct &&
      r.trades >= cfg.suspicious_win_rate_min_trades
    )
      return 'implausible_win_rate';
    if (r.winRate !== null && r.winRate < cfg.min_win_rate_pct) return 'low_win_rate';
    // Whales move the price themselves; their entries are not reproducible at ~$50.
    if (r.avgTradeUsd !== null && r.avgTradeUsd > cfg.max_avg_trade_usd) return 'whale_trade_size';
    return null;
  };

  const kept: WindowRow[] = [];
  const dropped: DropCounts = {};
  for (const r of rows) {
    const reason = reasonFor(r);
    if (reason) dropped[reason] = (dropped[reason] ?? 0) + 1;
    else kept.push(r);
  }
  return { kept, dropped };
};

/** Metrics come from the longest window; at equal windows Solana Tracker wins (it has win rate). */
const preferred = (a: WindowRow, b: WindowRow) =>
  b.windowDays - a.windowDays || (a.source === 'solanatracker' ? -1 : 1);

/** `identityChecked`: addresses whose identity some provider actually checked. */
export const mergeRows = (rows: WindowRow[], identityChecked: Set<string>): Candidate[] => {
  const byAddress = Map.groupBy(rows, (r) => r.address);
  return [...byAddress.entries()].map(([address, group]) => {
    const best = [...group].sort(preferred)[0] as WindowRow;
    return {
      address,
      label: group.find((r) => r.label)?.label ?? '',
      sources: unique(group.map((r) => r.source)).sort(),
      windows: unique(group.map((r) => r.windowDays)).sort((a, b) => a - b),
      realizedPnl: best.realizedPnl ?? 0,
      winRate: best.winRate ?? group.find((r) => r.winRate !== null)?.winRate ?? null,
      trades: best.trades,
      tradesPerDay: best.trades === null ? null : best.trades / best.windowDays,
      avgTradeUsd:
        best.avgTradeUsd ?? group.find((r) => r.avgTradeUsd !== null)?.avgTradeUsd ?? null,
      topTokenPct: null,
      topTokenPartial: false,
      medianHoldS: null,
      verified: false,
      identityChecked: identityChecked.has(address),
      lastSwapAt: null,
      solQuotePct: null,
      starter: false,
    };
  });
};

/**
 * Tiers first (verified, identity checked, profitable in every window, both sources), then
 * consistency: win rate desc (missing last), then realized PnL desc. At ~$50 copy size,
 * consistency matters more than absolute PnL, which mostly reflects the wallet's size.
 */
export const compareCandidates =
  (windowCount: number) =>
  (a: Candidate, b: Candidate): number => {
    const tier = (c: Candidate) => [
      c.verified ? 1 : 0,
      c.identityChecked ? 1 : 0,
      c.windows.length >= windowCount ? 1 : 0,
      c.sources.length > 1 ? 1 : 0,
      c.winRate === null ? 0 : 1,
    ];
    const ta = tier(a);
    const tb = tier(b);
    for (let i = 0; i < ta.length; i++) {
      const d = (tb[i] as number) - (ta[i] as number);
      if (d) return d;
    }
    return (b.winRate ?? 0) - (a.winRate ?? 0) || b.realizedPnl - a.realizedPnl;
  };

/**
 * Starter-list criteria. Identity, activity, trade rate and trade size must be known;
 * win rate and top-token share pass when unknown.
 */
export const isStarter = (c: Candidate, s: DiscoveryConfig['starter']) =>
  c.identityChecked &&
  c.lastSwapAt !== null &&
  c.solQuotePct !== null &&
  c.solQuotePct >= s.min_sol_quote_pct &&
  c.tradesPerDay !== null &&
  c.tradesPerDay <= s.max_trades_per_day &&
  c.avgTradeUsd !== null &&
  c.avgTradeUsd <= s.max_avg_trade_usd &&
  (c.winRate === null || (c.winRate >= s.min_win_rate_pct && c.winRate <= s.max_win_rate_pct)) &&
  (c.topTokenPct === null || c.topTokenPct <= s.max_top_token_pct);

/** Largest profitable token's share of total profitable realized PnL, or null if unknowable. */
export const topTokenShare = (realized: (number | null | undefined)[]) => {
  const wins = realized.filter((v): v is number => typeof v === 'number' && v > 0);
  const total = wins.reduce((s, v) => s + v, 0);
  return total > 0 ? (Math.max(...wins) / total) * 100 : null;
};

export const median = (xs: (number | null | undefined)[]) => {
  const s = xs.filter((x): x is number => typeof x === 'number').sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};

export const pnlPerTrade = (c: Candidate) => (c.trades ? c.realizedPnl / c.trades : null);

export const CSV_COLUMNS = [
  'address',
  'label',
  'source',
  'window',
  'realized_pnl',
  'win_rate',
  'trades',
  'pnl_per_trade',
  'top_token_pct',
  'top_token_partial',
  'verified',
  'trades_per_day',
  'avg_trade_usd',
  'median_hold_s',
  'identity_checked',
  'last_swap_at',
  'sol_quote_pct',
  'starter',
] as const;

const fixed = (v: number | null) => (v === null ? '' : v.toFixed(2));

/** Quotes when needed and neutralizes spreadsheet formulas (labels come from providers). */
export const csvCell = (raw: string) => {
  const v = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
};

export const toCsv = (candidates: Candidate[]) =>
  [
    CSV_COLUMNS.join(','),
    ...candidates.map((c) =>
      [
        c.address,
        c.label,
        c.sources.join('+'),
        c.windows.map((w) => `${w}d`).join('+'),
        fixed(c.realizedPnl),
        fixed(c.winRate),
        c.trades === null ? '' : String(c.trades),
        fixed(pnlPerTrade(c)),
        fixed(c.topTokenPct),
        String(c.topTokenPartial),
        String(c.verified),
        fixed(c.tradesPerDay),
        fixed(c.avgTradeUsd),
        c.medianHoldS === null ? '' : String(Math.round(c.medianHoldS)),
        String(c.identityChecked),
        c.lastSwapAt === null ? '' : new Date(c.lastSwapAt).toISOString(),
        fixed(c.solQuotePct),
        String(c.starter),
      ]
        .map(csvCell)
        .join(','),
    ),
    '',
  ].join('\n');

export const CANDIDATES_FILE = 'wallets.candidates.csv';

/** The only file discovery may write. data/wallets.csv is curated by hand and never touched. */
export const writeCandidates = (path: string, csv: string) => {
  if (basename(path) !== CANDIDATES_FILE) {
    throw new Error(`refusing to write ${path}: discovery only writes ${CANDIDATES_FILE}`);
  }
  writeFileSync(path, csv);
};
