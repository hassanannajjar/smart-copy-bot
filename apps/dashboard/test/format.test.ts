import { describe, expect, it } from 'vitest';
import { dur, signedPct, signedUsd, stale, usd } from '../lib/format';

describe('usd', () => {
  it('puts the minus sign before the dollar sign', () => {
    expect(usd(-17.956)).toBe('-$17.96');
    expect(usd(17.956)).toBe('$17.96');
    expect(usd(0)).toBe('$0.00');
    expect(usd(-0.004)).toBe('$0.00');
  });

  it('signs PnL, without a sign on zero', () => {
    expect(signedUsd(1.2)).toBe('+$1.20');
    expect(signedUsd(-1.2)).toBe('-$1.20');
    expect(signedUsd(0.001)).toBe('$0.00');
    expect(signedPct(12.34)).toBe('+12.3%');
    expect(signedPct(null)).toBe('—');
  });
});

describe('dur', () => {
  it('scales units', () => {
    expect(dur(45)).toBe('45s');
    expect(dur(720)).toBe('12m');
    expect(dur(3 * 3600 + 300)).toBe('3h 05m');
    expect(dur(2 * 86_400 + 4 * 3600)).toBe('2d 4h');
    expect(dur(-5)).toBe('0s');
  });
});

describe('stale', () => {
  it('fails closed on unknown age or limit', () => {
    expect(stale(1000, 2000)).toBe(false);
    expect(stale(3000, 2000)).toBe(true);
    expect(stale(null, 2000)).toBe(true);
    expect(stale(1000, null)).toBe(true);
  });
});
