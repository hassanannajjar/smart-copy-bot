import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSolanaTrackerApi, loadConfig } from '@scb/shared';
import { describe, expect, it } from 'vitest';
import { fixtureRecorder } from '../src/discover/cli.js';
import { discover } from '../src/discover/discover.js';
import { fakeBirdeye, fakeSolanaTracker } from './fakes.js';

const cfg = loadConfig('config/rules.yaml').discovery;

// The doc examples are huge accounts (~1000+ trades/day), so the default bot filter drops all
// Solana Tracker rows; Birdeye keeps its one profitable row, which stays unverified.
describe('discover (doc-derived fixtures)', () => {
  it('runs end to end with default config', async () => {
    const r = await discover({ st: fakeSolanaTracker(), be: fakeBirdeye() }, cfg);
    expect(r.providers.map((p) => [p.source, p.status])).toEqual([
      ['solanatracker', 'ok'],
      ['birdeye', 'ok'],
    ]);
    expect(r.dropped.bot_trade_rate).toBeGreaterThan(0);
    expect(r.dropped.unprofitable).toBeGreaterThan(0);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({
      address: '1JKP3jcMcBzpp5SUSj9DFMFZGiJiXLyuRyGYcf6E97z',
      sources: ['birdeye'],
      windows: [30, 90],
      verified: false,
      topTokenPct: null,
    });
  });

  it('enriches ST rows and drops one-token wallets (fixture top token = 63.6%)', async () => {
    const loose = { ...cfg, max_trades_per_day: 1e9 };
    const r = await discover({ st: fakeSolanaTracker() }, loose);
    expect(r.dropped.one_token_profit).toBe(2);
    expect(r.candidates).toEqual([]);

    const r2 = await discover({ st: fakeSolanaTracker() }, { ...loose, max_single_token_pct: 70 });
    expect(r2.candidates).toHaveLength(2);
    expect(r2.candidates.every((c) => c.verified && c.topTokenPartial)).toBe(true);
    expect(r2.candidates[0]?.topTokenPct).toBeCloseTo((88872.66 / (88872.66 + 50791.19)) * 100, 1);
    // ranked by win rate within the same tier
    expect(r2.candidates.map((c) => c.winRate)).toEqual(
      [...r2.candidates.map((c) => c.winRate)].sort((a, b) => (b ?? 0) - (a ?? 0)),
    );
  });

  it('keeps rows unverified when enrichment fails, and keeps one provider when the other fails', async () => {
    const st = {
      ...fakeSolanaTracker(),
      profitablePositions: async () => Promise.reject(new Error('solanatracker 500 GET /x')),
    };
    const be = {
      ...fakeBirdeye(),
      gainers: async () => Promise.reject(new Error('birdeye 401 GET /trader/gainers-losers')),
    };
    const r = await discover({ st, be }, { ...cfg, max_trades_per_day: 1e9 });
    expect(r.providers.find((p) => p.source === 'birdeye')).toMatchObject({
      status: 'failed',
      error: 'birdeye 401 GET /trader/gainers-losers',
    });
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates.every((c) => !c.verified)).toBe(true);
    expect(r.warnings.some((w) => w.includes('left unverified'))).toBe(true);
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
