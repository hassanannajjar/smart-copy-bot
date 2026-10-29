import { join } from 'node:path';
import { loadConfig } from '@scb/shared';
import { describe, expect, it } from 'vitest';
import { reasonLabel } from '../lib/labels.ts';

const cfg = loadConfig(join(import.meta.dirname, '../../../config/rules.yaml'));

describe('reasonLabel', () => {
  it('words every rule with its current threshold', () => {
    const r = cfg.rules;
    expect(reasonLabel('R1', cfg)).toBe(
      `Liquidity < $${+(r.R1_min_liquidity_usd / 1000).toFixed(1)}k`,
    );
    expect(reasonLabel('R2', cfg)).toBe(`Top-10 holders > ${r.R2_max_top10_pct}%`);
    expect(reasonLabel('R3', cfg)).toBe(`Dev holds > ${r.R3_max_dev_pct}%`);
    expect(reasonLabel('R4', cfg)).toBe(`Bundled launch > ${r.R4_max_bundled_pct}%`);
    expect(reasonLabel('R5', cfg)).toMatch(/^Up > \d+% in \d+m$/);
    expect(reasonLabel('R6', cfg)).toMatch(/LP < \d+% locked/);
    expect(reasonLabel('data_unavailable', cfg)).toMatch(/fail-closed/);
  });

  it('words skip and exit codes', () => {
    expect(reasonLabel('below_min_buy', cfg)).toBe(`Buy < ${cfg.prefilters.min_buy_sol} SOL`);
    expect(reasonLabel('repeat_buy', cfg)).toMatch(/^Repeat buy within \d+h$/);
    expect(reasonLabel('token_age', cfg)).toMatch(/^Token age outside/);
    expect(reasonLabel('trailing_stop', cfg)).toBe('Trailing stop');
  });

  it('falls back to the raw code: unknown code, or no readable rules.yaml', () => {
    expect(reasonLabel('R9', cfg)).toBe('R9');
    expect(reasonLabel('R1', null)).toBe('R1');
    expect(reasonLabel('data_unavailable', null)).toMatch(/fail-closed/);
    expect(reasonLabel(null, cfg)).toBe('—');
  });
});
