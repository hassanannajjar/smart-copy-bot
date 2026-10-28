import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadConfig, parseConfig } from '../src/config.js';

const PATH = new URL('../../../config/rules.yaml', import.meta.url).pathname;
const raw = () => parse(readFileSync(PATH, 'utf8'));

describe('rules.yaml', () => {
  it('parses with the PLAN defaults', () => {
    const c = loadConfig(PATH);
    expect(c.rules.R1_min_liquidity_usd).toBe(30000);
    expect(c.rules.order).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6']);
    expect(c.paper.priority_fee_sol).toBe(0.001);
    expect(c.guard.stop_loss_pct).toBe(-30);
  });

  it('rejects a missing threshold (no silent defaults)', () => {
    const c = raw();
    delete c.rules.R3_max_dev_pct;
    expect(() => parseConfig(c)).toThrow();
  });

  it('rejects unknown keys (typos fail closed)', () => {
    const c = raw();
    c.rules.R1_min_liquidty_usd = 1;
    expect(() => parseConfig(c)).toThrow();
  });

  it('rejects a rule order with duplicates', () => {
    const c = raw();
    c.rules.order = ['R1', 'R1', 'R2', 'R3', 'R4', 'R5'];
    expect(() => parseConfig(c)).toThrow();
  });
});
