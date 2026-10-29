import { loadConfig } from '@scb/shared';
import { describe, expect, it } from 'vitest';
import { evaluate, initialGuard, pnl, sellAmount, stopPrice } from '../src/paper/guard.js';

const base = loadConfig(new URL('../../../config/rules.yaml', import.meta.url).pathname);
const H = 3_600_000;
const E = 1; // entry price
// rules.yaml: stop -30%, TP 50% at 2x, trailing 25%, time stop 24h, rug drop 50%.
const g0 = () => initialGuard(base, 0, 6, 1_000_000n, 10_000);

describe('guard', () => {
  it('is set from rules.yaml before entry', () => {
    const g = g0();
    expect(g).toMatchObject({
      stop_loss_pct: -30,
      take_profit: [{ at_multiple: 2, sell_pct: 50, done: false }],
      trailing_stop_pct: 25,
      time_stop_at: 24 * H,
      rug_liquidity_drop_pct: 50,
      remaining_raw: '1000000',
      last_liquidity_usd: 10_000,
    });
    expect(stopPrice(g, E)).toBeCloseTo(0.7);
  });

  it('holds while nothing triggers', () => {
    expect(evaluate(g0(), E, 1.2, 9_000, H).trigger).toBeNull();
    expect(evaluate(g0(), E, null, null, H).trigger).toBeNull(); // no data: no exit, no guess
  });

  it('stop_loss at or below entry -30%', () => {
    expect(evaluate(g0(), E, 0.71, 10_000, H).trigger).toBeNull();
    expect(evaluate(g0(), E, 0.7, 10_000, H).trigger).toEqual({ reason: 'stop_loss' });
    expect(evaluate(g0(), E, 0.2, 10_000, H).trigger?.reason).toBe('stop_loss'); // gap
  });

  it('time_stop after time_stop_h, even without a price', () => {
    expect(evaluate(g0(), E, null, null, 24 * H).trigger).toEqual({ reason: 'time_stop' });
    expect(evaluate(g0(), E, 1.1, 10_000, 24 * H - 1).trigger).toBeNull();
  });

  it('rug when liquidity drops more than rug_liquidity_drop_pct between polls, before anything else', () => {
    expect(evaluate(g0(), E, 0.5, 5_001, H).trigger?.reason).toBe('stop_loss');
    expect(evaluate(g0(), E, 0.5, 4_999, 24 * H).trigger).toEqual({ reason: 'rug' });
    // The baseline follows each poll, so a slow bleed is not a rug...
    const { next } = evaluate(g0(), E, 1, 6_000, H);
    expect(next.last_liquidity_usd).toBe(6_000);
    expect(evaluate(next, E, 1, 3_500, H).trigger).toBeNull();
    // ...and a poll without liquidity keeps the old baseline.
    expect(evaluate(next, E, 1, null, H).next.last_liquidity_usd).toBe(6_000);
  });

  it('take_profit sells sell_pct of the initial size at at_multiple', () => {
    const r = evaluate(g0(), E, 2, 10_000, H);
    expect(r.trigger).toEqual({ reason: 'take_profit', tp: 0 });
    expect(sellAmount(g0(), { reason: 'take_profit', tp: 0 })).toBe(500_000n);
    expect(sellAmount(g0(), { reason: 'stop_loss' })).toBe(1_000_000n);
  });

  it('trailing_stop only after the ladder, from the peak since', () => {
    const ladderDone = { ...g0(), take_profit: [{ at_multiple: 2, sell_pct: 50, done: true }] };
    // Before the ladder is done there is no trailing stop, only the hard stop.
    expect(evaluate({ ...g0(), peak_price: 1.9 }, E, 1.2, 10_000, H).trigger).toBeNull();
    let g = { ...ladderDone, remaining_raw: '500000', peak_price: 2 };
    g = evaluate(g, E, 3, 10_000, H).next; // new high
    expect(g.peak_price).toBe(3);
    expect(evaluate(g, E, 2.3, 10_000, H).trigger).toBeNull(); // 3 * 0.75 = 2.25
    expect(evaluate(g, E, 2.25, 10_000, H).trigger).toEqual({ reason: 'trailing_stop' });
    expect(sellAmount(g, { reason: 'trailing_stop' })).toBe(500_000n);
  });

  it('a ladder adding up to 100% sells the remainder (no dust left open)', () => {
    const c = {
      ...base,
      guard: {
        ...base.guard,
        take_profit: [
          { at_multiple: 2, sell_pct: 33.33 },
          { at_multiple: 3, sell_pct: 66.67 },
        ],
      },
    };
    const g = initialGuard(c, 0, 6, 1_000_001n, null);
    expect(sellAmount(g, { reason: 'take_profit', tp: 0 })).toBe(333_300n);
    const after = {
      ...g,
      remaining_raw: '666701',
      take_profit: g.take_profit.map((l, i) => ({ ...l, done: i === 0 })),
    };
    expect(sellAmount(after, { reason: 'take_profit', tp: 1 })).toBe(666_701n);
  });

  it('pnl: gross adds back platform fees, net subtracts all fees', () => {
    const b = pnl({
      sizeUsd: 50,
      proceedsUsd: 60,
      feesUsd: 0.5,
      platformFeeUsd: 0.1,
      slippageUsd: 1,
    });
    expect(b.grossPnlUsd).toBeCloseTo(10.1);
    expect(b.netPnlUsd).toBeCloseTo(9.6);
    expect(b.netPnlPct).toBeCloseTo(19.2);
    expect(b.slippageBps).toBeCloseTo(200);
  });
});
