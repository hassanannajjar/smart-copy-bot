import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

// Every threshold is required and unknown keys are rejected: a typo or a missing
// value must stop the engine, never fall back to a silent default (fail closed).
const num = z.number().finite();
const pct = num.min(0).max(100);
const positive = num.positive();
const obj = z.strictObject;
const providerLimits = {
  min_interval_ms: num.int().min(0),
  timeout_ms: num.int().positive(),
  retries: num.int().min(0).max(10),
};

export const configSchema = obj({
  data: obj({ max_snapshot_age_s: positive }),
  prefilters: obj({
    ignore_sells: z.boolean(),
    ignored_mints: z.array(z.string().min(32).max(44)),
    token_age_min_h: num.min(0),
    token_age_max_h: positive,
    min_buy_sol: positive,
    mint_cooldown_h: num.min(0),
  }),
  rules: obj({
    order: z
      .array(z.enum(['R1', 'R2', 'R3', 'R4', 'R5', 'R6']))
      .length(6)
      .refine((ids) => new Set(ids).size === 6, 'order must list each of R1..R6 once'),
    R1_min_liquidity_usd: positive,
    R2_max_top10_pct: pct,
    R3_max_dev_pct: pct,
    R4_max_bundled_pct: pct,
    R4_window_s: positive,
    R5_max_price_change_45m_pct: num,
    R6_require_mint_revoked: z.literal(true),
    R6_require_freeze_revoked: z.literal(true),
    R6_min_lp_locked_pct: pct,
  }),
  paper: obj({
    position_size_usd: positive,
    simulated_latency_ms: num.int().min(0),
    base_fee_sol: num.min(0),
    priority_fee_sol: num.min(0),
    poll_interval_s: positive,
    rug_liquidity_drop_pct: pct,
  }),
  guard: obj({
    stop_loss_pct: num.max(0),
    take_profit: z.array(obj({ at_multiple: num.gt(1), sell_pct: pct })).min(1),
    trailing_stop_pct: pct,
    time_stop_h: positive,
  }),
  analyst: obj({ enabled: z.boolean(), shadow: z.boolean(), timeout_ms: positive }),
  live: obj({
    max_position_usd: positive,
    max_open_positions: num.int().positive(),
    max_trades_per_hour: num.int().positive(),
    daily_loss_limit_usd: positive,
    max_wallet_balance_sol: positive,
    slippage_cap_bps: num.int().positive(),
    priority_fee_cap_sol: positive,
  }),
  discovery: obj({
    // Windows both providers support (Birdeye calls 7d "1W").
    windows_days: z.array(z.union([z.literal(7), z.literal(30), z.literal(90)])).min(1),
    min_trades: num.int().min(0),
    // Active trading days per window (Solana Tracker minDays); 10 of 7 days would match nobody.
    min_days: obj({ '7': num.int().min(0).max(7), '30': num.int().min(0), '90': num.int().min(0) }),
    max_single_token_pct: pct,
    exclude_arbitrage: z.boolean(),
    pnl_mode: z.enum(['strict', 'adjusted', 'raw']),
    page_limit: num.int().min(1).max(100),
    max_pages: obj({ solanatracker: num.int().min(1), birdeye: num.int().min(1) }), // per window
    enrich_top_n: num.int().min(0),
    enrich_period: z.enum(['1d', '7d', '14d', '30d', '90d', 'all']),
    max_trades_per_day: positive,
    min_win_rate_pct: pct,
    suspicious_win_rate_pct: pct,
    suspicious_win_rate_min_trades: num.int().min(0),
    max_avg_trade_usd: positive,
    min_median_hold_s: num.min(0),
    drop_identity_labels: z.array(z.string().min(1)),
    report_top: num.int().positive(),
    // Helius activity check on enriched candidates.
    activity: obj({
      signatures_limit: num.int().min(1).max(1000),
      tx_sample: num.int().min(1),
      max_inactive_h: positive,
      min_sol_quote_pct: pct,
    }),
    // The `starter` CSV column. Unknown win rate / top-token share pass; unknown activity fails.
    starter: obj({
      min_sol_quote_pct: pct,
      max_trades_per_day: positive,
      max_avg_trade_usd: positive,
      min_win_rate_pct: pct,
      max_win_rate_pct: pct,
      max_top_token_pct: pct,
      max_wallets: num.int().positive(),
    }),
    solanatracker: obj(providerLimits),
    birdeye: obj(providerLimits),
    helius: obj(providerLimits),
  }),
  scout: obj({
    commitment: z.enum(['confirmed', 'finalized']), // getTransaction rejects 'processed'
    quote_mint: z.string().min(32).max(44),
    ping_interval_ms: num.int().positive(),
    heartbeat_interval_ms: num.int().positive(),
    reconnect_base_ms: num.int().positive(),
    reconnect_max_ms: num.int().positive(),
    tx_fetch_retries: num.int().min(0).max(20),
    tx_fetch_delay_ms: num.int().min(0),
    backfill_limit: num.int().min(1).max(1000),
    rpc: obj(providerLimits),
  }),
});

export type Config = z.infer<typeof configSchema>;

export const parseConfig = (raw: unknown): Config => configSchema.parse(raw);

export const loadConfig = (path: string): Config => parseConfig(parse(readFileSync(path, 'utf8')));
