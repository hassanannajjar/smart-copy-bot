import { type HeliusSignature, heliusTxSchema, loadConfig } from '@scb/shared';
import { describe, expect, it } from 'vitest';
import { activityDrop, checkActivity, discover } from '../src/discover/discover.js';
import { type Candidate, isStarter } from '../src/discover/rank.js';
import { fakeHeliusRpc, fakeSolanaTracker, heliusTx, WSOL } from './fakes.js';

const config = loadConfig('config/rules.yaml');
const cfg = config.discovery;
const h = { quoteMint: WSOL, ignoredMints: config.prefilters.ignored_mints };
const HOUR = 3_600_000;

const failed = heliusTx('tx-failed');
const jupBuy = heliusTx('tx-jupiter-buy');
const pumpSell = heliusTx('tx-pumpamm-sell');
const pumpBuy = heliusTx('tx-pumpfun-buy');
const wsolQuoted = heliusTx('tx-wsol-quoted');
const usdcXstock = heliusTx('tx-usdc-xstock');

const sigOf = (t: ReturnType<typeof heliusTx>): HeliusSignature => ({
  signature: t.tx.transaction.signatures[0] as string,
  slot: t.tx.slot,
  err: t.tx.meta.err ?? null,
  blockTime: t.tx.blockTime,
});
const timeOf = (t: ReturnType<typeof heliusTx>) => (t.tx.blockTime as number) * 1000;

describe('checkActivity (recorded mainnet txs)', () => {
  it('SOL-quoted trader: counts swaps, skips failed txs, newest swap time', async () => {
    const wallet = jupBuy.wallet;
    const { rpc, calls } = fakeHeliusRpc([failed, jupBuy, pumpSell, pumpBuy], {
      [wallet]: [jupBuy, pumpSell, failed, pumpBuy].map(sigOf),
    });
    const a = await checkActivity(rpc, wallet, cfg.activity, h, timeOf(jupBuy) + HOUR);
    expect(a).toEqual({
      lastSwapAt: timeOf(jupBuy),
      solQuotedSwaps: 3,
      nonSolQuoteSwaps: 0,
      solQuotePct: 100,
    });
    expect(calls.getTransaction).not.toContain(sigOf(failed).signature);
    expect(calls.signatures).toEqual([{ wallet, limit: cfg.activity.signatures_limit }]);
  });

  it('stable-quoted swaps count against the SOL share', async () => {
    const wallet = wsolQuoted.wallet;
    const { rpc } = fakeHeliusRpc([wsolQuoted, usdcXstock], {
      [wallet]: [wsolQuoted, usdcXstock].map(sigOf),
    });
    const a = await checkActivity(rpc, wallet, cfg.activity, h, timeOf(wsolQuoted));
    expect(a).toMatchObject({ solQuotedSwaps: 1, nonSolQuoteSwaps: 1, solQuotePct: 50 });
  });

  it('fetches at most tx_sample transactions', async () => {
    const wallet = jupBuy.wallet;
    const { rpc, calls } = fakeHeliusRpc([jupBuy, pumpSell, pumpBuy], {
      [wallet]: [jupBuy, pumpSell, pumpBuy].map(sigOf),
    });
    await checkActivity(rpc, wallet, { ...cfg.activity, tx_sample: 2 }, h, timeOf(jupBuy));
    expect(calls.getTransaction).toHaveLength(2);
  });

  it('newest signature older than the window: no getTransaction credits, inactive', async () => {
    const wallet = jupBuy.wallet;
    const { rpc, calls } = fakeHeliusRpc([jupBuy], { [wallet]: [sigOf(jupBuy)] });
    const now = timeOf(jupBuy) + (cfg.activity.max_inactive_h + 1) * HOUR;
    const a = await checkActivity(rpc, wallet, cfg.activity, h, now);
    expect(calls.getTransaction).toEqual([]);
    expect(activityDrop(a, cfg.activity, now)).toBe('inactive');
  });
});

describe('activityDrop', () => {
  const now = 1_800_000_000_000;
  const a = { lastSwapAt: now - HOUR, solQuotedSwaps: 3, nonSolQuoteSwaps: 1, solQuotePct: 75 };
  it('keeps a recent SOL-quoted trader', () => {
    expect(activityDrop(a, cfg.activity, now)).toBeNull();
  });
  it('no swap seen, or the last swap too old => inactive', () => {
    expect(activityDrop({ ...a, lastSwapAt: null, solQuotePct: null }, cfg.activity, now)).toBe(
      'inactive',
    );
    const old = now - (cfg.activity.max_inactive_h + 1) * HOUR;
    expect(activityDrop({ ...a, lastSwapAt: old }, cfg.activity, now)).toBe('inactive');
  });
  it('mostly stable-quoted => not_memecoin_trader', () => {
    expect(activityDrop({ ...a, solQuotePct: 40 }, cfg.activity, now)).toBe('not_memecoin_trader');
  });
});

describe('isStarter', () => {
  const s = cfg.starter;
  const c: Candidate = {
    address: jupBuy.wallet,
    label: '',
    sources: ['solanatracker'],
    windows: [7, 30, 90],
    realizedPnl: 1000,
    winRate: 50,
    trades: 100,
    tradesPerDay: 5,
    avgTradeUsd: 200,
    topTokenPct: 20,
    topTokenPartial: false,
    medianHoldS: 600,
    verified: true,
    identityChecked: true,
    lastSwapAt: 1,
    solQuotePct: 90,
    starter: false,
  };
  it('passes a checked, active, mid-size SOL trader; unknown win rate / top token allowed', () => {
    expect(isStarter(c, s)).toBe(true);
    expect(isStarter({ ...c, winRate: null, topTokenPct: null }, s)).toBe(true);
  });
  it.each<[string, Partial<Candidate>]>([
    ['identity unchecked', { identityChecked: false }],
    ['activity unchecked', { lastSwapAt: null, solQuotePct: null }],
    ['low SOL share', { solQuotePct: s.min_sol_quote_pct - 1 }],
    ['trade rate unknown', { tradesPerDay: null }],
    ['too many trades/day', { tradesPerDay: s.max_trades_per_day + 1 }],
    ['trade size unknown', { avgTradeUsd: null }],
    ['whale', { avgTradeUsd: s.max_avg_trade_usd + 1 }],
    ['win rate too low', { winRate: s.min_win_rate_pct - 1 }],
    ['win rate too high', { winRate: s.max_win_rate_pct + 1 }],
    ['one-token wallet', { topTokenPct: s.max_top_token_pct + 1 }],
  ])('fails when %s', (_, over) => {
    expect(isStarter({ ...c, ...over }, s)).toBe(false);
  });
});

describe('discover with the Helius activity check', () => {
  it('drops silent wallets as inactive, keeps an active one, counts Helius calls', async () => {
    const leaderboard = await fakeSolanaTracker().topTraders({} as never);
    const target = leaderboard.traders.map((t) => t.wallet)[0] as string;
    // The recorded buy, rewritten so it belongs to a leaderboard wallet.
    const raw = JSON.parse(JSON.stringify(jupBuy.raw).replaceAll(jupBuy.wallet, target));
    const tx = heliusTxSchema.parse(raw);
    const { rpc } = fakeHeliusRpc([{ tx, raw, wallet: target }], {
      [target]: [{ ...sigOf(jupBuy), err: null }],
    });
    const now = timeOf(jupBuy) + HOUR;
    const loose = { ...cfg, max_trades_per_day: 1e9, min_win_rate_pct: 0, min_median_hold_s: 0 };
    const r = await discover({ st: fakeSolanaTracker(), helius: { rpc, ...h } }, loose, now);

    const checked = r.candidates.filter((c) => c.lastSwapAt !== null);
    expect(checked.map((c) => [c.address, c.solQuotePct])).toEqual([[target, 100]]);
    expect(r.dropped.inactive ?? 0).toBeGreaterThan(0);
    expect(r.heliusCalls).toBe((r.dropped.inactive ?? 0) + checked.length + 1);
    for (const c of r.candidates)
      expect(c.starter).toBe(c.lastSwapAt !== null && isStarter(c, cfg.starter));
  });
});
