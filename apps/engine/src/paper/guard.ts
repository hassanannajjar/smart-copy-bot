// Guard (PLAN §5): set from rules.yaml before entry, persisted in positions.tp_plan_json so a
// restart resumes exactly where it stopped. Pure functions only; the executor does the I/O.
import type { Config } from '@scb/shared';

export type ExitReason = 'rug' | 'stop_loss' | 'time_stop' | 'take_profit' | 'trailing_stop';

export interface GuardState {
  stop_loss_pct: number;
  take_profit: { at_multiple: number; sell_pct: number; done: boolean }[];
  trailing_stop_pct: number;
  time_stop_at: number; // ms
  rug_liquidity_drop_pct: number;
  decimals: number;
  initial_raw: string; // token base units bought (bigint as string)
  remaining_raw: string;
  peak_price: number | null; // trailing high, set once the TP ladder is done
  last_liquidity_usd: number | null; // previous poll, for the rug check
  no_route_polls: number;
  platform_fee_usd: number; // part of fees_usd already inside the quoted amounts
  slippage_usd: number; // signed cost vs the reference price, summed over fills
}

export const initialGuard = (
  c: Config,
  entryAt: number,
  decimals: number,
  boughtRaw: bigint,
  liquidityUsd: number | null,
): GuardState => ({
  stop_loss_pct: c.guard.stop_loss_pct,
  take_profit: c.guard.take_profit.map((t) => ({ ...t, done: false })),
  trailing_stop_pct: c.guard.trailing_stop_pct,
  time_stop_at: entryAt + c.guard.time_stop_h * 3_600_000,
  rug_liquidity_drop_pct: c.paper.rug_liquidity_drop_pct,
  decimals,
  initial_raw: boughtRaw.toString(),
  remaining_raw: boughtRaw.toString(),
  peak_price: null,
  last_liquidity_usd: liquidityUsd,
  no_route_polls: 0,
  platform_fee_usd: 0,
  slippage_usd: 0,
});

export const stopPrice = (g: Pick<GuardState, 'stop_loss_pct'>, entryPrice: number) =>
  entryPrice * (1 + g.stop_loss_pct / 100);

export interface Trigger {
  reason: ExitReason;
  /** Index into take_profit for a partial TP; undefined = sell everything left. */
  tp?: number;
}

/**
 * One poll. `mark` is USD per whole token (null = no price this poll), `liquidityUsd` likewise.
 * Priority: rug > stop_loss > time_stop > take_profit > trailing_stop. Returns the guard state
 * with this poll's observations (liquidity baseline, trailing peak) folded in.
 */
export const evaluate = (
  g: GuardState,
  entryPrice: number,
  mark: number | null,
  liquidityUsd: number | null,
  now: number,
): { trigger: Trigger | null; next: GuardState } => {
  const ladderDone = g.take_profit.every((t) => t.done);
  const next: GuardState = {
    ...g,
    last_liquidity_usd: liquidityUsd ?? g.last_liquidity_usd,
    peak_price: ladderDone && mark !== null ? Math.max(g.peak_price ?? mark, mark) : g.peak_price,
  };
  const hit = (reason: ExitReason, tp?: number) => ({ trigger: { reason, tp }, next });

  if (
    liquidityUsd !== null &&
    g.last_liquidity_usd !== null &&
    liquidityUsd < g.last_liquidity_usd * (1 - g.rug_liquidity_drop_pct / 100)
  )
    return hit('rug');
  if (mark !== null && mark <= stopPrice(g, entryPrice)) return hit('stop_loss');
  if (now >= g.time_stop_at) return hit('time_stop');
  if (mark === null) return { trigger: null, next };
  const tp = g.take_profit.findIndex((t) => !t.done && mark >= entryPrice * t.at_multiple);
  if (tp >= 0) return hit('take_profit', tp);
  if (
    ladderDone &&
    next.peak_price !== null &&
    mark <= next.peak_price * (1 - g.trailing_stop_pct / 100)
  )
    return hit('trailing_stop');
  return { trigger: null, next };
};

/** Raw amount to sell for a trigger: a TP level sells sell_pct of the initial size. */
export const sellAmount = (g: GuardState, t: Trigger): bigint => {
  const remaining = BigInt(g.remaining_raw);
  if (t.tp === undefined) return remaining;
  const level = g.take_profit[t.tp];
  if (!level) return remaining;
  const soldPct = g.take_profit.filter((l) => l.done).reduce((s, l) => s + l.sell_pct, 0);
  // The ladder adds up to 100%: sell what's left rather than strand rounding dust.
  if (soldPct + level.sell_pct >= 100) return remaining;
  const want = (BigInt(g.initial_raw) * BigInt(Math.round(level.sell_pct * 100))) / 10_000n;
  // biome-ignore lint/complexity/useMathMinMax: bigint, Math.min doesn't take it
  return want < remaining ? want : remaining;
};

/** PLAN §5 PnL breakdown for a closed position. Proceeds and size are net of platform fees. */
export const pnl = (o: {
  sizeUsd: number;
  proceedsUsd: number;
  feesUsd: number; // network + platform
  platformFeeUsd: number;
  slippageUsd: number;
}) => {
  const gross = o.proceedsUsd - o.sizeUsd + o.platformFeeUsd;
  const net = gross - o.feesUsd;
  return {
    grossPnlUsd: gross,
    feesUsd: o.feesUsd,
    slippageBps: (o.slippageUsd / o.sizeUsd) * 10_000,
    netPnlUsd: net,
    netPnlPct: (net / o.sizeUsd) * 100,
  };
};
