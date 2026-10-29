import {
  type HeliusSignature,
  heliusTxSchema,
  loadConfig,
  ProviderError,
  SYSTEM_PROGRAM_ID,
} from '@scb/shared';
import { describe, expect, it } from 'vitest';
import { activityDrop, checkActivity, discover } from '../src/discover/discover.js';
import { type Candidate, isStarter, median } from '../src/discover/rank.js';
import { parseSwap } from '../src/scout/parse.js';
import {
  beGainers,
  fakeBirdeye,
  fakeHeliusRpc,
  fakeSolanaTracker,
  heliusTx,
  WSOL,
} from './fakes.js';

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
    const swaps = [jupBuy, pumpSell, pumpBuy].flatMap((t) => {
      const p = parseSwap(t.tx, wallet, WSOL, h.ignoredMints);
      return 'skip' in p ? [] : [p];
    });
    expect(swaps).toHaveLength(3);
    expect(a).toEqual({
      lastSwapAt: timeOf(jupBuy),
      solQuotedSwaps: 3,
      nonSolQuoteSwaps: 0,
      solQuotePct: 100,
      medianSwapSol: median(swaps.map((s) => s.amountSol)),
      distinctMintRatio: new Set(swaps.map((s) => s.mint)).size / 3,
    });
    expect(a.medianSwapSol).toBeGreaterThan(0);
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
  const a = {
    lastSwapAt: now - HOUR,
    solQuotedSwaps: 3,
    nonSolQuoteSwaps: 1,
    solQuotePct: 75,
    medianSwapSol: 1,
    distinctMintRatio: 1,
  };
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
  it('median SOL swap below min_median_swap_sol => dust_trader', () => {
    const m = cfg.activity.min_median_swap_sol;
    expect(activityDrop({ ...a, medianSwapSol: m / 2 }, cfg.activity, now)).toBe('dust_trader');
    expect(activityDrop({ ...a, medianSwapSol: m }, cfg.activity, now)).toBeNull();
  });
  it('few distinct mints per swap => single_token_scalper', () => {
    const r = cfg.activity.min_distinct_mint_ratio;
    expect(activityDrop({ ...a, distinctMintRatio: r - 0.01 }, cfg.activity, now)).toBe(
      'single_token_scalper',
    );
    expect(activityDrop({ ...a, distinctMintRatio: r }, cfg.activity, now)).toBeNull();
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

describe('on-chain identity substitute', () => {
  it('System Program-owned => identity_source onchain; other owners dropped; missing stays unchecked', async () => {
    const st = fakeSolanaTracker();
    const stWallets = new Set((await st.topTraders({} as never)).traders.map((t) => t.wallet));
    const beOnly = [
      ...new Set(
        beGainers()
          .data.items.map((i) => i.address)
          .filter((a) => !stWallets.has(a)),
      ),
    ];
    const [wallet, token, missing] = beOnly as [string, string, string];
    const { rpc, calls } = fakeHeliusRpc(
      [],
      {},
      {
        [wallet]: { owner: SYSTEM_PROGRAM_ID, executable: false },
        [token]: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', executable: false },
      },
    );
    const be = {
      ...fakeBirdeye(),
      identities: async () => Promise.reject(new ProviderError('birdeye', 401, 'POST', '/x')),
    };
    const loose = {
      ...cfg,
      max_trades_per_day: 1e9,
      min_win_rate_pct: 0,
      max_avg_trade_usd: 1e12,
      min_median_hold_s: 0,
      enrich_top_n: 1e6,
    };
    const r = await discover({ st, be, helius: { rpc, ...h } }, loose);

    const byAddress = new Map(r.candidates.map((c) => [c.address, c]));
    expect(calls.accounts).toEqual(expect.arrayContaining([wallet, token, missing]));
    expect(calls.accounts.some((a) => stWallets.has(a))).toBe(false); // provider-checked: no call
    expect(r.dropped.not_system_owned).toBe(1);
    expect(byAddress.has(token)).toBe(false);
    // The fake has no signatures, so the on-chain wallet is enriched and then dropped as inactive;
    // the missing account is never identity-checked and stays in the list.
    expect(byAddress.has(wallet)).toBe(false);
    expect(byAddress.get(missing)).toMatchObject({ identityChecked: false, identitySource: null });
    expect(r.dropped.inactive ?? 0).toBeGreaterThan(0);
  });
});
