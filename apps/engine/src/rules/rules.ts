// The 6 hard rules (PLAN §4) and the pre-filters. Pure functions: (snapshot, config) -> result.
// Missing input => passed=false with reason data_unavailable (fail closed).
import type { Config } from '@scb/shared';

export type RuleId = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6';
export type RulesConfig = Config['rules'];

export const DATA_UNAVAILABLE = 'data_unavailable';
/** A deferred rule that wasn't run because another rule already killed the signal. Not a kill. */
export const NOT_EVALUATED = 'not_evaluated';

/** Launch-window sub-scores for R4 (docs/notes/2026-10-29-m2-overnight.md, "R4"). */
export interface BundleScores {
  insiderNetworkPct: number; // RugCheck transfer-linked clusters, % of supply still held
  launchSlotPct: number; // bought in the first slot of the window
  slotClusterPct: number; // bought in the first slot + slots with >= N distinct buyers
  windowBuyPct: number; // everything bought in the window, for tuning only
  buyers: number;
  clusterSlots: number;
  txs: number;
  truncated: boolean; // more txs in the window than R4_max_pages fetched: pcts are lower bounds
}

/** One row of token_snapshots plus the derived fields the rules need (kept in raw_json). */
export interface Snapshot {
  takenAt: number; // ms
  priceUsd: number | null;
  liquidityUsd: number | null;
  liquiditySource: 'dexscreener' | 'rugcheck' | null;
  fdvUsd: number | null;
  pairAddress: string | null;
  pairCreatedAt: number | null; // ms, earliest pool of the mint
  priceChange5m: number | null;
  priceChange45m: number | null;
  priceChangePartial: boolean; // pool younger than the window: change since its first candle
  top10Pct: number | null;
  devPct: number | null;
  bundledPct: number | null; // max(insiderNetworkPct, slotClusterPct)
  bundle: BundleScores | null;
  mintAuthorityRevoked: boolean | null;
  freezeAuthorityRevoked: boolean | null;
  lpApplicable: boolean | null; // false = the venue has no LP token (pump.fun curve, DLMM…)
  lpLockedPct: number | null;
  errors: Record<string, string>; // provider -> one-line error (no secrets, see http.ts)
}

export interface RuleResult {
  ruleId: RuleId | 'DATA';
  passed: boolean;
  value: string | null;
  threshold: string;
  reason: string | null;
}

const fmt = (v: number) => String(Math.round(v * 100) / 100);

const check = (
  ruleId: RuleId,
  value: number | null,
  ok: (v: number) => boolean,
  threshold: string,
  failReason: string,
): RuleResult =>
  value === null
    ? { ruleId, passed: false, value: null, threshold, reason: DATA_UNAVAILABLE }
    : ok(value)
      ? { ruleId, passed: true, value: fmt(value), threshold, reason: null }
      : { ruleId, passed: false, value: fmt(value), threshold, reason: failReason };

export const RULES: Record<RuleId, (s: Snapshot, c: RulesConfig) => RuleResult> = {
  R1: (s, c) =>
    check(
      'R1',
      s.liquidityUsd,
      (v) => v >= c.R1_min_liquidity_usd,
      `>=${c.R1_min_liquidity_usd}`,
      'low_liquidity',
    ),
  R2: (s, c) =>
    check(
      'R2',
      s.top10Pct,
      (v) => v <= c.R2_max_top10_pct,
      `<=${c.R2_max_top10_pct}`,
      'top10_concentrated',
    ),
  R3: (s, c) =>
    check(
      'R3',
      s.devPct,
      (v) => v <= c.R3_max_dev_pct,
      `<=${c.R3_max_dev_pct}`,
      'dev_holds_too_much',
    ),
  R4: (s, c) => {
    const threshold = `<=${c.R4_max_bundled_pct}`;
    const b = s.bundle;
    if (s.bundledPct === null || !b)
      return { ruleId: 'R4', passed: false, value: null, threshold, reason: DATA_UNAVAILABLE };
    // Sub-scores go in value so replay can tune the heuristic (PLAN §4).
    const value = JSON.stringify({ bundled_pct: Number(fmt(s.bundledPct)), ...b });
    if (s.bundledPct > c.R4_max_bundled_pct)
      return { ruleId: 'R4', passed: false, value, threshold, reason: 'bundled_launch' };
    // A truncated window is a lower bound: it can prove a fail, never a pass.
    if (b.truncated)
      return { ruleId: 'R4', passed: false, value, threshold, reason: DATA_UNAVAILABLE };
    return { ruleId: 'R4', passed: true, value, threshold, reason: null };
  },
  R5: (s, c) =>
    check(
      'R5',
      s.priceChange45m,
      (v) => v <= c.R5_max_price_change_45m_pct,
      `<=${c.R5_max_price_change_45m_pct}`,
      'overextended',
    ),
  R6: (s, c) => {
    const threshold = `mint_revoked && freeze_revoked && lp_locked>=${c.R6_min_lp_locked_pct} (if LP token)`;
    const {
      mintAuthorityRevoked: mint,
      freezeAuthorityRevoked: freeze,
      lpApplicable,
      lpLockedPct,
    } = s;
    const value = JSON.stringify({
      mint_revoked: mint,
      freeze_revoked: freeze,
      lp_applicable: lpApplicable,
      lp_locked_pct: lpLockedPct,
    });
    const fails: string[] = [];
    if (mint === false) fails.push('mint_authority');
    if (freeze === false) fails.push('freeze_authority');
    if (lpApplicable && lpLockedPct !== null && lpLockedPct < c.R6_min_lp_locked_pct)
      fails.push('lp_unlocked');
    if (fails.length)
      return { ruleId: 'R6', passed: false, value, threshold, reason: fails.join(',') };
    const missing =
      mint === null ||
      freeze === null ||
      lpApplicable === null ||
      (lpApplicable && lpLockedPct === null);
    if (missing) return { ruleId: 'R6', passed: false, value, threshold, reason: DATA_UNAVAILABLE };
    return { ruleId: 'R6', passed: true, value, threshold, reason: null };
  },
};

export interface Evaluation {
  results: RuleResult[]; // the DATA row (if stale) first, then every rule in config order
  verdict: 'PASSED' | 'KILLED';
  killedBy: string | null; // first failing rule, or data_unavailable when that rule lacked data
  failed: string[];
}

/**
 * Every rule runs and is stored; a snapshot older than max_snapshot_age_s kills on its own.
 * `deferred` rules are stored as not_evaluated (passed=false) and never count as failures:
 * the stage runs them in a second pass only if everything else passed.
 */
export const evaluate = (
  s: Snapshot,
  rules: RulesConfig,
  maxSnapshotAgeS: number,
  detectedAt: number,
  deferred: readonly RuleId[] = [],
): Evaluation => {
  const results = rules.order.map(
    (id): RuleResult =>
      deferred.includes(id)
        ? { ruleId: id, passed: false, value: null, threshold: '', reason: NOT_EVALUATED }
        : RULES[id](s, rules),
  );
  const ageS = (s.takenAt - detectedAt) / 1000;
  const stale = ageS > maxSnapshotAgeS;
  if (stale)
    results.unshift({
      ruleId: 'DATA',
      passed: false,
      value: fmt(ageS),
      threshold: `snapshot_age_s<=${maxSnapshotAgeS}`,
      reason: 'stale',
    });
  const failed = results.filter((r) => !r.passed && r.reason !== NOT_EVALUATED);
  const first = failed[0];
  const killedBy = !first
    ? null
    : stale || first.reason === DATA_UNAVAILABLE
      ? DATA_UNAVAILABLE
      : first.ruleId;
  return {
    results,
    verdict: first ? 'KILLED' : 'PASSED',
    killedBy,
    failed: failed.map((r) => r.ruleId),
  };
};

export type SkipReason = 'sell' | 'ignored_mint' | 'below_min_buy' | 'token_age' | 'repeat_buy';

/** Cheap pre-filters that need no provider call. Token age runs after DexScreener. */
export const prefilter = (
  sig: { side: 'buy' | 'sell'; mint: string; amountSol: number | null },
  p: Config['prefilters'],
): SkipReason | null => {
  if (p.ignore_sells && sig.side === 'sell') return 'sell';
  if (p.ignored_mints.includes(sig.mint)) return 'ignored_mint';
  // A buy with no SOL amount can't be sized: treat as dust rather than guess.
  if ((sig.amountSol ?? 0) < p.min_buy_sol) return 'below_min_buy';
  return null;
};

export const outsideAgeWindow = (
  pairCreatedAt: number | null,
  detectedAt: number,
  p: Config['prefilters'],
) => {
  if (pairCreatedAt === null) return false; // unknown age is left to R4 (needs it) => data_unavailable
  const ageH = (detectedAt - pairCreatedAt) / 3_600_000;
  return ageH < p.token_age_min_h || ageH > p.token_age_max_h;
};
