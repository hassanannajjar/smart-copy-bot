import type { Config } from '@scb/shared';

const money = (n: number) => (n >= 1000 ? `$${+(n / 1000).toFixed(1)}k` : `$${n}`);

/**
 * killed_by / skip / exit codes → plain words, using the *current* rules.yaml thresholds.
 * Unknown codes, or no readable config, fall back to the raw code (never a guess).
 */
export const reasonLabel = (code: string | null, c: Config | null): string => {
  if (!code) return '—';
  const r = c?.rules;
  const p = c?.prefilters;
  const labels: Record<string, string | undefined> = {
    R1: r && `Liquidity < ${money(r.R1_min_liquidity_usd)}`,
    R2: r && `Top-10 holders > ${r.R2_max_top10_pct}%`,
    R3: r && `Dev holds > ${r.R3_max_dev_pct}%`,
    R4: r && `Bundled launch > ${r.R4_max_bundled_pct}%`,
    R5: r && `Up > ${r.R5_max_price_change_45m_pct}% in ${c?.enricher.R5_window_min}m`,
    R6: r && `Mint/freeze not revoked or LP < ${r.R6_min_lp_locked_pct}% locked`,
    data_unavailable: 'Missing or stale data (fail-closed)',
    // pre-filter skips
    sell: 'Sell (ignored)',
    ignored_mint: 'Ignored mint (SOL/stable)',
    below_min_buy: p && `Buy < ${p.min_buy_sol} SOL`,
    token_age: p && `Token age outside ${p.token_age_min_h}–${p.token_age_max_h}h`,
    repeat_buy: p && `Repeat buy within ${p.repeat_buy_cooldown_h}h`,
    // paper entry skips
    kill_switch: 'Kill switch on',
    position_open: 'Already holding this mint',
    mint_cooldown: p && `Mint cooldown (${p.mint_cooldown_h}h)`,
    stale: c ? `Signal older than ${c.executor.max_entry_delay_s}s` : undefined,
    not_passed: 'Did not pass rules',
    signal_not_found: 'Signal not found',
    // exits
    no_route: 'No Jupiter route',
    rug: 'Rug (liquidity pulled)',
    stop_loss: 'Stop loss',
    time_stop: 'Time stop',
    take_profit: 'Take profit',
    trailing_stop: 'Trailing stop',
  };
  return labels[code] ?? code;
};
