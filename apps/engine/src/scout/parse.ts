// Venue-agnostic swap parser: diff the wallet's own SOL and token balances. Jupiter routes,
// pump.fun curves, pump AMM, Raydium… all look the same from the wallet's balance sheet.
import type { HeliusTx } from '@scb/shared';

export type SkipReason =
  | 'failed_tx'
  | 'no_token_change'
  | 'multi_token'
  | 'non_sol_quote'
  | 'no_sol_leg';

export type ParsedSwap =
  | { side: 'buy' | 'sell'; mint: string; amountSol: number; amountToken: number }
  | { skip: SkipReason };

/**
 * SOL leg = wallet lamports delta (+ network fee if it paid it) + its wSOL token delta.
 * amountSol includes ATA rent (~0.002 SOL) on a first buy; noise against min_buy_sol.
 * Only SOL-quoted swaps become signals (v1); a token change without a SOL leg is no_sol_leg.
 */
export const parseSwap = (
  tx: HeliusTx,
  wallet: string,
  quoteMint: string,
  ignoredMints: readonly string[], // prefilters.ignored_mints: SOL / stables / majors
): ParsedSwap => {
  const { meta } = tx;
  if (meta.err != null) return { skip: 'failed_tx' };

  const i = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey === wallet);
  let lamports = i < 0 ? 0 : (meta.postBalances[i] ?? 0) - (meta.preBalances[i] ?? 0);
  if (i === 0) lamports += meta.fee; // account 0 is the fee payer; the fee isn't the trade

  const deltas = new Map<string, { raw: bigint; decimals: number }>();
  const add = (balances: HeliusTx['meta']['preTokenBalances'], sign: bigint) => {
    for (const b of balances ?? []) {
      if (b.owner !== wallet) continue;
      const d = deltas.get(b.mint) ?? { raw: 0n, decimals: b.uiTokenAmount.decimals };
      d.raw += sign * BigInt(b.uiTokenAmount.amount);
      deltas.set(b.mint, d);
    }
  };
  add(meta.preTokenBalances, -1n);
  add(meta.postTokenBalances, 1n);

  const wsol = deltas.get(quoteMint);
  deltas.delete(quoteMint);
  const sol = lamports / 1e9 + (wsol ? Number(wsol.raw) / 10 ** wsol.decimals : 0);

  const changed = [...deltas].filter(([, d]) => d.raw !== 0n);
  const [only, ...rest] = changed;
  if (!only) return { skip: 'no_token_change' };
  if (rest.length > 0) {
    // Several mints moved and one is a stable (USDC/USDT…): a stable-quoted swap, not SOL-quoted.
    const stableLeg = changed.some(([m]) => ignoredMints.includes(m));
    return { skip: stableLeg ? 'non_sol_quote' : 'multi_token' };
  }

  const [mint, d] = only;
  const amountToken = Math.abs(Number(d.raw) / 10 ** d.decimals);
  if (d.raw > 0n && sol < 0) return { side: 'buy', mint, amountSol: -sol, amountToken };
  if (d.raw < 0n && sol > 0) return { side: 'sell', mint, amountSol: sol, amountToken };
  return { skip: 'no_sol_leg' };
};
