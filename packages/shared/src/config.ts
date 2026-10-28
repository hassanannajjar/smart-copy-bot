import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

// Every threshold is required and unknown keys are rejected: a typo or a missing
// value must stop the engine, never fall back to a silent default (fail closed).
const num = z.number().finite();
const pct = num.min(0).max(100);
const positive = num.positive();
const obj = z.strictObject;

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
});

export type Config = z.infer<typeof configSchema>;

export const parseConfig = (raw: unknown): Config => configSchema.parse(raw);

export const loadConfig = (path: string): Config => parseConfig(parse(readFileSync(path, 'utf8')));
