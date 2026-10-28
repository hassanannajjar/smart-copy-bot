import { loadConfig } from '@scb/shared';
import { describe, expect, it } from 'vitest';
import { parseSwap } from '../src/scout/parse.js';
import { heliusTx, WSOL } from './fakes.js';

const IGNORED = loadConfig(new URL('../../../config/rules.yaml', import.meta.url).pathname)
  .prefilters.ignored_mints;

const parse = (name: string, ignored: readonly string[] = IGNORED) => {
  const { tx, wallet } = heliusTx(name);
  return parseSwap(tx, wallet, WSOL, ignored);
};

describe('parseSwap (recorded mainnet txs)', () => {
  it('Jupiter-routed buy: SOL out (fee excluded), one token in', () => {
    expect(parse('tx-jupiter-buy')).toEqual({
      side: 'buy',
      mint: 'FZAEGkZxMpZN8v2XMZGyoAJH89r3aHJRAikwZXcWZz9R',
      amountSol: 2.50148844,
      amountToken: 11235226.111992,
    });
  });

  it('pump.fun bonding-curve buy (via Jupiter)', () => {
    expect(parse('tx-pumpfun-buy')).toEqual({
      side: 'buy',
      mint: 'KMCHuK6W4F3M669wGyj2VFnjGErJrddqxakEWozw89z',
      amountSol: 0.75,
      amountToken: 4365239.037925,
    });
  });

  it('pump AMM sell: token out, SOL in', () => {
    expect(parse('tx-pumpamm-sell')).toEqual({
      side: 'sell',
      mint: 'KMCHuK6W4F3M669wGyj2VFnjGErJrddqxakEWozw89z',
      amountSol: 1.188949856,
      amountToken: 26416989.037141,
    });
  });

  it('counts a wSOL token leg as SOL (stables are filtered later by prefilters)', () => {
    expect(parse('tx-wsol-quoted')).toMatchObject({
      side: 'buy',
      mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      amountSol: 0.222595545,
    });
  });

  it.each([
    ['tx-failed', 'failed_tx'],
    ['tx-sol-transfer', 'no_token_change'],
    ['tx-dust-airdrop', 'no_sol_leg'],
    ['tx-usdc-xstock', 'non_sol_quote'], // USDC -> xStock + a receipt token: stable-quoted
  ])('%s -> skip %s', (name, reason) => {
    expect(parse(name)).toEqual({ skip: reason });
  });

  it('several non-stable mints moving is multi_token', () => {
    // Same tx with no stables configured: USDC is then just another mint.
    expect(parse('tx-usdc-xstock', [])).toEqual({ skip: 'multi_token' });
  });

  it('a wallet the tx does not involve parses to no_token_change, never a signal', () => {
    const { tx } = heliusTx('tx-jupiter-buy');
    expect(parseSwap(tx, '11111111111111111111111111111111', WSOL, IGNORED)).toEqual({
      skip: 'no_token_change',
    });
  });
});
