import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSolanaTrackerApi, loadConfig, ProviderError } from '@scb/shared';
import { describe, expect, it } from 'vitest';
import { fixtureRecorder } from '../src/discover/cli.js';
import { discover } from '../src/discover/discover.js';
import { compareCandidates } from '../src/discover/rank.js';
import { fakeBirdeye, fakeSolanaTracker } from './fakes.js';

const cfg = loadConfig('config/rules.yaml').discovery;

const ROW_REASONS =
  /^(invalid_address|identity_.+|unprofitable|bot_trade_rate|implausible_win_rate|low_win_rate|whale_trade_size)$/;
const WALLET_REASONS = /^(one_token_profit|short_hold)$/;

// Invariants that must hold for ANY fixture (doc-derived or recorded).
describe('discover on the committed fixtures, default config', async () => {
  const r = await discover({ st: fakeSolanaTracker(), be: fakeBirdeye() }, cfg);

  it('both providers ran', () => {
    expect(r.providers.map((p) => [p.source, p.status])).toEqual([
      ['solanatracker', 'ok'],
      ['birdeye', 'ok'],
    ]);
  });

  it('every final candidate passes every human-likeness filter', () => {
    for (const c of r.candidates) {
      if (c.tradesPerDay !== null)
        expect(c.tradesPerDay).toBeLessThanOrEqual(cfg.max_trades_per_day);
      if (c.winRate !== null && c.trades !== null && c.trades >= cfg.suspicious_win_rate_min_trades)
        expect(c.winRate).toBeLessThan(cfg.suspicious_win_rate_pct);
      if (c.winRate !== null) expect(c.winRate).toBeGreaterThanOrEqual(cfg.min_win_rate_pct);
      if (c.avgTradeUsd !== null) expect(c.avgTradeUsd).toBeLessThanOrEqual(cfg.max_avg_trade_usd);
      if (c.medianHoldS !== null)
        expect(c.medianHoldS).toBeGreaterThanOrEqual(cfg.min_median_hold_s);
      if (c.topTokenPct !== null)
        expect(c.topTokenPct).toBeLessThanOrEqual(cfg.max_single_token_pct);
      expect(c.realizedPnl).toBeGreaterThan(0);
    }
  });

  it('drop counts only use known reasons and add up', () => {
    const rowDrops = Object.entries(r.dropped).filter(([k]) => ROW_REASONS.test(k));
    const walletDrops = Object.entries(r.dropped).filter(([k]) => WALLET_REASONS.test(k));
    expect(rowDrops.length + walletDrops.length).toBe(Object.keys(r.dropped).length);
    const droppedRows = rowDrops.reduce((s, [, v]) => s + v, 0);
    expect(droppedRows).toBeLessThanOrEqual(r.fetched);
  });

  it('is sorted by the ranking tiers', () => {
    const cmp = compareCandidates(cfg.windows_days.length);
    for (let i = 1; i < r.candidates.length; i++) {
      expect(cmp(r.candidates[i - 1] as never, r.candidates[i] as never)).toBeLessThanOrEqual(0);
    }
  });
});

describe('failure handling', () => {
  const loose = {
    ...cfg,
    max_trades_per_day: 1e9,
    min_win_rate_pct: 0,
    max_avg_trade_usd: 1e12,
    suspicious_win_rate_pct: 100,
    suspicious_win_rate_min_trades: 1e9,
  };

  it('keeps rows unverified when enrichment fails, and keeps one provider when the other fails', async () => {
    const st = {
      ...fakeSolanaTracker(),
      profitablePositions: async () => Promise.reject(new Error('solanatracker 500 GET /x')),
    };
    const be = {
      ...fakeBirdeye(),
      gainers: async () => Promise.reject(new Error('birdeye 401 GET /trader/gainers-losers')),
    };
    const r = await discover({ st, be }, loose);
    expect(r.providers.find((p) => p.source === 'birdeye')).toMatchObject({ status: 'failed' });
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates.every((c) => !c.verified)).toBe(true);
    expect(r.warnings.some((w) => w.includes('left unverified'))).toBe(true);
  });

  it('identity 401: one note, Birdeye-only rows unchecked and ranked below checked rows', async () => {
    const be = {
      ...fakeBirdeye(),
      identities: async () =>
        Promise.reject(new ProviderError('birdeye', 401, 'POST', '/identity/v1/multiple')),
    };
    const r = await discover({ st: fakeSolanaTracker(), be }, loose);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatch(
      /^Birdeye identity unavailable on this plan \(401\); \d+ rows identity_checked=false$/,
    );
    expect(r.warnings.filter((w) => w.includes('identity'))).toEqual([]);
    for (const c of r.candidates)
      expect(c.identityChecked).toBe(c.sources.includes('solanatracker'));
    const firstUnchecked = r.candidates.findIndex((c) => !c.identityChecked);
    if (firstUnchecked >= 0)
      expect(r.candidates.slice(firstUnchecked).every((c) => !c.identityChecked)).toBe(true);
  });

  it('identity non-auth error: a single warning instead of a note', async () => {
    const be = {
      ...fakeBirdeye(),
      identities: async () =>
        Promise.reject(new ProviderError('birdeye', 500, 'POST', '/identity/v1/multiple')),
    };
    const r = await discover({ be }, loose);
    expect(r.notes).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/identity lookup failed \(birdeye 500 POST/);
  });
});

describe('--record', () => {
  it('saves the first raw response per endpoint in the fixture envelope', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scb-rec-'));
    const body = JSON.parse(
      readFileSync('packages/shared/test/fixtures/solanatracker/leaderboard-top.json', 'utf8'),
    ).response;
    const st = createSolanaTrackerApi({
      apiKey: 'sk_SECRET',
      timeoutMs: 1000,
      retries: 0,
      minIntervalMs: 0,
      fetch: async () => new Response(JSON.stringify(body)),
      record: fixtureRecorder('solanatracker', dir),
    });
    const q = {
      days: 30,
      minTrades: 50,
      minDays: 10,
      maxSingleTokenPct: 30,
      excludeArbitrage: true,
      pnlMode: 'strict',
      limit: 100,
    } as const;
    await st.topTraders(q);
    await st.topTraders({ ...q, days: 90 });
    const saved = readFileSync(join(dir, 'solanatracker', 'leaderboard-top.json'), 'utf8');
    const f = JSON.parse(saved);
    expect(f._provenance).toMatch(/^recorded /);
    expect(f.request).toMatchObject({
      method: 'GET',
      path: '/v2/pnl/leaderboard/top',
      query: { days: 30 },
    });
    expect(f.response).toEqual(body);
    expect(saved).not.toContain('sk_SECRET');
  });
});
