import { type Config, loadConfig } from '@scb/shared';
import { describe, expect, it } from 'vitest';
import {
  buildSnapshot,
  type Fetched,
  launchBundle,
  priceChange,
  top10Pct,
} from '../src/rules/enrich.js';
import { evaluate, outsideAgeWindow, prefilter, RULES, type Snapshot } from '../src/rules/rules.js';
import { MINTS, recorded, WSOL } from './fakes.js';

const config = loadConfig(new URL('../../../config/rules.yaml', import.meta.url).pathname);
const rules = config.rules;

/** A snapshot built from the recorded responses, optionally with providers dropped or edited. */
const snap = (mint: string, edit: (f: Fetched) => void = () => {}, cfg: Config = config) => {
  const r = recorded(mint);
  const f: Fetched = {
    pairs: r.pairs,
    report: structuredClone(r.report),
    candles: r.candles,
    launch: r.launch,
    errors: {},
  };
  edit(f);
  return buildSnapshot(mint, f, r.takenAt, cfg);
};
const run = (id: keyof typeof RULES, s: Snapshot, c = rules) => RULES[id](s, c);
const pass = snap(MINTS.migrated);

describe('R1 liquidity', () => {
  it('passes on the deepest DexScreener pool', () => {
    expect(pass.liquiditySource).toBe('dexscreener');
    expect(run('R1', pass)).toMatchObject({ passed: true, reason: null });
  });
  it('fails a thin pool', () => {
    expect(run('R1', snap(MINTS.insiders))).toMatchObject({
      passed: false,
      reason: 'low_liquidity',
    });
  });
  it('values a pump.fun curve from RugCheck when DexScreener has no liquidity', () => {
    const s = snap(MINTS.curve);
    expect(s.liquiditySource).toBe('rugcheck');
    expect(run('R1', s)).toMatchObject({ passed: false, reason: 'low_liquidity' });
  });
  it('missing data: no DexScreener and no RugCheck market => data_unavailable', () => {
    const s = snap(MINTS.migrated, (f) => {
      f.pairs = undefined;
    });
    expect(run('R1', s)).toMatchObject({ passed: false, value: null, reason: 'data_unavailable' });
  });
});

describe('R2 top-10 holders', () => {
  it('excludes pool vaults (known AMM accounts) and passes', () => {
    const r = recorded(MINTS.migrated).report;
    const naive = (r.topHolders ?? []).slice(0, 10).reduce((s, h) => s + h.pct, 0);
    expect(pass.top10Pct).toBeLessThan(naive); // the 4.5% PumpSwap vault is dropped
    expect(run('R2', pass)).toMatchObject({ passed: true });
  });
  it('fails above the threshold', () => {
    expect(run('R2', pass, { ...rules, R2_max_top10_pct: 1 })).toMatchObject({
      passed: false,
      reason: 'top10_concentrated',
    });
  });
  it('keeps lockers unless their type is configured as excluded', () => {
    const r = recorded(MINTS.insiders).report; // two LOCKER holders in its top 5
    const cfg = { ...config.enricher, R2_exclude_known_types: ['AMM', 'LOCKER'] };
    expect(top10Pct(r, cfg)).toBeLessThan(top10Pct(r, config.enricher) ?? 0);
  });
  it('missing data: no RugCheck report => data_unavailable', () => {
    const s = snap(MINTS.migrated, (f) => {
      f.report = undefined;
    });
    expect(run('R2', s)).toMatchObject({ passed: false, reason: 'data_unavailable' });
  });
});

describe('R3 dev holding', () => {
  it('passes a creator holding 0.06%', () => {
    const s = snap(MINTS.insiders);
    expect(s.devPct).toBeCloseTo(0.06, 2);
    expect(run('R3', s)).toMatchObject({ passed: true });
  });
  it('fails when the creator holds more than the threshold', () => {
    const s = snap(MINTS.migrated, (f) => {
      if (f.report) f.report.creatorBalance = f.report.token.supply * 0.1;
    });
    expect(run('R3', s)).toMatchObject({
      passed: false,
      value: '10',
      reason: 'dev_holds_too_much',
    });
  });
  it('missing data: unknown creator => data_unavailable', () => {
    const s = snap(MINTS.migrated, (f) => {
      if (f.report) f.report.creator = null;
    });
    expect(run('R3', s)).toMatchObject({ passed: false, reason: 'data_unavailable' });
  });
});

describe('R4 bundled launch (v1 heuristic)', () => {
  it('passes and exposes its sub-scores in value', () => {
    const r = run('R4', pass);
    expect(r.passed).toBe(true);
    expect(JSON.parse(r.value ?? '{}')).toMatchObject({
      insiderNetworkPct: 0,
      truncated: false,
      txs: recorded(MINTS.migrated).launch.txs.length,
    });
  });
  it('fails a launch with a heavy first-slot / same-slot cluster', () => {
    const s = snap(MINTS.curve);
    expect(s.bundle?.slotClusterPct).toBeGreaterThan(rules.R4_max_bundled_pct);
    expect(run('R4', s)).toMatchObject({ passed: false, reason: 'bundled_launch' });
  });
  it('uses the RugCheck insider network when it is larger than the slot cluster', () => {
    const s = snap(MINTS.insiders);
    expect(s.bundledPct).toBe(s.bundle?.insiderNetworkPct);
    expect(run('R4', s, { ...rules, R4_max_bundled_pct: 5 })).toMatchObject({
      passed: false,
      reason: 'bundled_launch',
    });
  });
  it('a truncated window can fail but never pass (data_unavailable)', () => {
    const s = snap(MINTS.busy);
    expect(s.bundle?.truncated).toBe(true);
    expect(run('R4', s)).toMatchObject({ passed: false, reason: 'data_unavailable' });
    expect(run('R4', s, { ...rules, R4_max_bundled_pct: 1 })).toMatchObject({
      reason: 'bundled_launch',
    });
  });
  it('missing data: no Helius launch window => data_unavailable', () => {
    const s = snap(MINTS.migrated, (f) => {
      f.launch = undefined;
    });
    expect(run('R4', s)).toMatchObject({ passed: false, value: null, reason: 'data_unavailable' });
  });
  it('launchBundle: a huge min-buyers leaves only the first slot', () => {
    const r = recorded(MINTS.curve);
    const supply = r.report.token.supply / 10 ** r.report.token.decimals;
    const b = launchBundle(r.launch.txs, MINTS.curve, supply, 10_000, WSOL, []);
    expect(b.slotClusterPct).toBe(b.launchSlotPct);
    expect(b.clusterSlots).toBe(1);
    expect(b.windowBuyPct).toBeGreaterThan(b.slotClusterPct);
    expect(launchBundle([], MINTS.curve, supply, 3, WSOL, [])).toMatchObject({ txs: 0, buyers: 0 });
  });
});

describe('R5 overextension (45 min)', () => {
  it('passes a flat chart', () => {
    expect(run('R5', snap(MINTS.busy))).toMatchObject({ passed: true });
  });
  it('fails a pump above the threshold', () => {
    const s = snap(MINTS.migrated);
    expect(s.priceChange45m).toBeGreaterThan(rules.R5_max_price_change_45m_pct);
    expect(run('R5', s)).toMatchObject({ passed: false, reason: 'overextended' });
  });
  it('missing data: no candles => data_unavailable', () => {
    const s = snap(MINTS.migrated, (f) => {
      f.candles = [];
    });
    expect(run('R5', s)).toMatchObject({ passed: false, reason: 'data_unavailable' });
  });
  it('a pool younger than the window measures from its first candle and flags it', () => {
    const t = 1_800_000_000;
    const c = (ts: number, o: number, cl: number) => [ts, o, o, cl, cl, 1] as const;
    const young = [c(t - 600, 1, 1.5), c(t - 60, 1.5, 3)].map((x) => [...x]) as never;
    expect(priceChange(young, t * 1000, 45)).toEqual({ pct: 200, partial: true });
    const old = [c(t - 3000, 2, 2), c(t - 2600, 2, 2.2), c(t - 60, 2.2, 3)].map((x) => [
      ...x,
    ]) as never;
    expect(priceChange(old, t * 1000, 45)).toEqual({ pct: 50, partial: false });
  });
});

describe('R6 contract safety', () => {
  it('passes revoked authorities with LP 100% locked', () => {
    expect(run('R6', pass)).toMatchObject({ passed: true });
  });
  it('passes the LP leg when the venue has no LP token (pump.fun curve)', () => {
    const s = snap(MINTS.curve);
    expect(s.lpApplicable).toBe(false);
    expect(run('R6', s)).toMatchObject({ passed: true });
  });
  it('fails a live mint or freeze authority, or unlocked LP', () => {
    const s = snap(MINTS.migrated, (f) => {
      if (f.report) f.report.token.freezeAuthority = 'Frz1111111111111111111111111111111111111111';
    });
    expect(run('R6', s)).toMatchObject({ passed: false, reason: 'freeze_authority' });
    expect(run('R6', { ...pass, mintAuthorityRevoked: false, lpLockedPct: 10 })).toMatchObject({
      reason: 'mint_authority,lp_unlocked',
    });
  });
  it('missing data: no RugCheck market for the pair => data_unavailable', () => {
    const s = snap(MINTS.migrated, (f) => {
      if (f.report) f.report.markets = [];
    });
    expect(run('R6', s)).toMatchObject({ passed: false, reason: 'data_unavailable' });
  });
});

describe('evaluate', () => {
  it('runs every rule in config order; killed_by is the first failure', () => {
    const ev = evaluate(snap(MINTS.curve), rules, 60, recorded(MINTS.curve).takenAt);
    expect(ev.results.map((r) => r.ruleId)).toEqual(rules.order);
    expect(ev).toMatchObject({ verdict: 'KILLED', killedBy: 'R1', failed: ['R1', 'R4'] });
  });
  it('respects a custom order', () => {
    const order = ['R4', 'R1', 'R2', 'R3', 'R5', 'R6'] as Config['rules']['order'];
    const ev = evaluate(snap(MINTS.curve), { ...rules, order }, 60, recorded(MINTS.curve).takenAt);
    expect(ev.killedBy).toBe('R4');
  });
  it('a deferred rule is stored as not_evaluated and is not a kill', () => {
    const big = { ...rules, R5_max_price_change_45m_pct: 0 }; // R5 would fail if it ran
    const ev = evaluate(pass, big, 60, pass.takenAt, ['R5']);
    expect(ev.results.find((r) => r.ruleId === 'R5')).toMatchObject({
      passed: false,
      value: null,
      reason: 'not_evaluated',
    });
    expect(ev).toMatchObject({ verdict: 'PASSED', killedBy: null, failed: [] });
    const killed = evaluate(snap(MINTS.curve), rules, 60, pass.takenAt, ['R5']);
    expect(killed).toMatchObject({ killedBy: 'R1', failed: ['R1', 'R4'] });
  });
  it('R4 default needs 5 buyers per slot; fewer counts less as bundled', () => {
    expect(config.enricher.R4_slot_cluster_min_buyers).toBe(5);
    const at = (n: number) =>
      snap(MINTS.migrated, () => {}, {
        ...config,
        enricher: { ...config.enricher, R4_slot_cluster_min_buyers: n },
      }).bundle?.slotClusterPct ?? 0;
    expect(at(5)).toBeLessThanOrEqual(at(3));
  });
  it('PASSES when all six pass', () => {
    const ev = evaluate(pass, { ...rules, R5_max_price_change_45m_pct: 1000 }, 60, pass.takenAt);
    expect(ev).toMatchObject({ verdict: 'PASSED', killedBy: null, failed: [] });
  });
  it('first failure lacking data => killed_by data_unavailable', () => {
    const s = snap(MINTS.migrated, (f) => {
      f.report = undefined;
    });
    expect(evaluate(s, rules, 60, s.takenAt)).toMatchObject({
      verdict: 'KILLED',
      killedBy: 'data_unavailable',
    });
  });
  it('a stale snapshot is KILLED data_unavailable with a DATA row, rules still stored', () => {
    const big = { ...rules, R5_max_price_change_45m_pct: 1000 };
    const ev = evaluate(pass, big, 60, pass.takenAt - 61_000);
    expect(ev.results[0]).toMatchObject({ ruleId: 'DATA', passed: false, reason: 'stale' });
    expect(ev.results).toHaveLength(7);
    expect(ev).toMatchObject({ verdict: 'KILLED', killedBy: 'data_unavailable', failed: ['DATA'] });
  });
});

describe('pre-filters', () => {
  const p = config.prefilters;
  const buy = { side: 'buy' as const, mint: MINTS.migrated, amountSol: 1 };
  it('skips sells, ignored mints and dust; keeps a real buy', () => {
    expect(prefilter({ ...buy, side: 'sell' }, p)).toBe('sell');
    expect(prefilter({ ...buy, mint: WSOL }, p)).toBe('ignored_mint');
    expect(prefilter({ ...buy, amountSol: p.min_buy_sol / 2 }, p)).toBe('below_min_buy');
    expect(prefilter({ ...buy, amountSol: null }, p)).toBe('below_min_buy');
    expect(prefilter(buy, p)).toBeNull();
  });
  it('token age window', () => {
    const h = 3_600_000;
    expect(outsideAgeWindow(0, (p.token_age_max_h + 1) * h, p)).toBe(true);
    expect(outsideAgeWindow(0, h, p)).toBe(false);
    expect(outsideAgeWindow(null, h, p)).toBe(false); // unknown age: R4 fails closed instead
  });
});
