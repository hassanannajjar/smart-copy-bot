import { describe, expect, it } from 'vitest';
import { usd } from '../lib/format';

describe('usd', () => {
  it('puts the minus sign before the dollar sign', () => {
    expect(usd(-17.956)).toBe('-$17.96');
    expect(usd(17.956)).toBe('$17.96');
    expect(usd(0)).toBe('$0.00');
    expect(usd(-0.004)).toBe('$0.00');
  });
});
