// One test per human-likeness filter, each driven by a real row picked from the recorded
// fixtures. If a re-recorded fixture has no qualifying row, the test says so explicitly.
import { loadConfig } from '@scb/shared';
import { describe, expect, it } from 'vitest';
import { beRow, discover, stRow, stWinRate } from '../src/discover/discover.js';
import { filterRows, median, type WindowRow } from '../src/discover/rank.js';
import { beGainers, fakeSolanaTracker, stLeaderboard, stPositions } from './fakes.js';

const cfg = loadConfig('config/rules.yaml').discovery;
const WINDOW = 30;

// Every filter off except the one under test.
const off = {
  ...cfg,
  max_trades_per_day: Number.MAX_VALUE,
  min_win_rate_pct: 0,
  suspicious_win_rate_pct: 100,
  suspicious_win_rate_min_trades: Number.MAX_SAFE_INTEGER,
  max_avg_trade_usd: Number.MAX_VALUE,
  min_median_hold_s: 0,
  max_single_token_pct: 100,
};

const st = stLeaderboard().traders.map((t) => stRow(t, WINDOW));
const be = beGainers().data.items.map((i) => beRow(i, WINDOW));
const clean = (r: WindowRow) =>
  (r.realizedPnl ?? 0) > 0 && !r.labels.some((l) => cfg.drop_identity_labels.includes(l));

const pick = (rows: WindowRow[], what: string, pred: (r: WindowRow) => boolean) => {
  const r = rows.find((x) => clean(x) && pred(x));
  if (!r) throw new Error(`recorded fixture has no ${what} row; re-record or adjust this test`);
  return r;
};

const reasons = (row: WindowRow, c = cfg) => filterRows([row], c).dropped;

describe('win rate source', () => {
  it('uses the token win rate, not the profitable-days rate', () => {
    const raw = stLeaderboard().traders.find(
      (t) =>
        t.winRate != null && t.period?.days?.winRate != null && t.winRate !== t.period.days.winRate,
    );
    if (!raw) throw new Error('recorded fixture has no row where the two win rates differ');
    expect(stRow(raw, WINDOW).winRate).toBe(raw.winRate);
  });
});

describe('winRate 0 with positive realized PnL', () => {
  it('is treated as unknown (null), not as a 0% win rate', () => {
    const raw = stLeaderboard().traders.find((t) => (t.period?.realized ?? 0) > 0);
    if (!raw) throw new Error('recorded fixture has no profitable row');
    expect(stWinRate({ ...raw, winRate: 0 })).toBeNull();
    expect(stWinRate({ ...raw, winRate: 0, period: { ...raw.period, realized: -1 } })).toBe(0);
    expect(stWinRate(raw)).toBe(raw.winRate ?? null);
  });
});

describe('low_win_rate', () => {
  it('drops a recorded row below min_win_rate_pct, keeps it at the threshold, ignores missing', () => {
    const r = st
      .filter((x) => clean(x) && x.winRate !== null)
      .sort((a, b) => (a.winRate as number) - (b.winRate as number))[0];
    if (!r) throw new Error('recorded fixture has no row with a win rate');
    const at = (min: number) => reasons(r, { ...off, min_win_rate_pct: min });
    expect(at((r.winRate as number) + 1)).toEqual({ low_win_rate: 1 });
    expect(at(r.winRate as number)).toEqual({});
    expect(reasons({ ...r, winRate: null }, { ...off, min_win_rate_pct: 100 })).toEqual({});
  });
});

describe('bot_trade_rate', () => {
  it('drops a recorded row above max_trades_per_day, keeps one below', () => {
    const limit = cfg.max_trades_per_day * WINDOW;
    const bot = pick(st, 'high trade-rate', (r) => (r.trades ?? 0) > limit);
    const human = pick(st, 'low trade-rate', (r) => (r.trades ?? Infinity) <= limit);
    expect(reasons(bot, { ...off, max_trades_per_day: cfg.max_trades_per_day })).toEqual({
      bot_trade_rate: 1,
    });
    expect(reasons(human, { ...off, max_trades_per_day: cfg.max_trades_per_day })).toEqual({});
  });
});

describe('implausible_win_rate', () => {
  const only = {
    ...off,
    suspicious_win_rate_pct: cfg.suspicious_win_rate_pct,
    suspicious_win_rate_min_trades: cfg.suspicious_win_rate_min_trades,
  };
  it('drops a recorded row with win rate >= X and trades >= Y', () => {
    const r = pick(
      st,
      'high win-rate, many trades',
      (x) =>
        (x.winRate ?? 0) >= cfg.suspicious_win_rate_pct &&
        (x.trades ?? 0) >= cfg.suspicious_win_rate_min_trades,
    );
    expect(reasons(r, only)).toEqual({ implausible_win_rate: 1 });
  });
  it('keeps a recorded row with a lower win rate, and Birdeye rows (no win rate)', () => {
    const r = pick(st, 'lower win-rate', (x) => (x.winRate ?? 100) < cfg.suspicious_win_rate_pct);
    expect(reasons(r, only)).toEqual({});
    expect(
      reasons(
        pick(be, 'any Birdeye', () => true),
        only,
      ),
    ).toEqual({});
  });
});

describe('whale_trade_size', () => {
  const only = { ...off, max_avg_trade_usd: cfg.max_avg_trade_usd };
  it('drops recorded Solana Tracker and Birdeye rows above max_avg_trade_usd', () => {
    const big = (x: WindowRow) => (x.avgTradeUsd ?? 0) > cfg.max_avg_trade_usd;
    expect(reasons(pick(st, 'ST whale', big), only)).toEqual({ whale_trade_size: 1 });
    expect(reasons(pick(be, 'Birdeye whale', big), only)).toEqual({ whale_trade_size: 1 });
  });
  it('keeps small traders and rows with no size data', () => {
    const small = pick(
      be,
      'small trader',
      (x) => (x.avgTradeUsd ?? Infinity) <= cfg.max_avg_trade_usd,
    );
    expect(reasons(small, only)).toEqual({});
    expect(reasons({ ...small, avgTradeUsd: null }, only)).toEqual({});
  });
});

describe('short_hold', () => {
  const realMedian = median(stPositions().positions.map((p) => p.timing?.holdTimeSecs)) as number;
  const enrichOne = { ...off, enrich_top_n: 1, max_pages: 1, windows_days: [30] as 30[] };

  it('the recorded positions expose holdTimeSecs', () => {
    expect(realMedian).toBeTypeOf('number');
  });

  it('drops an enriched wallet whose median hold is below the threshold', async () => {
    const r = await discover(
      { st: fakeSolanaTracker() },
      { ...enrichOne, min_median_hold_s: realMedian + 1 },
    );
    expect(r.dropped.short_hold).toBe(1);
    expect(r.candidates.some((c) => c.verified)).toBe(false);
  });

  it('keeps it (and records the median) when the hold is long enough', async () => {
    const r = await discover(
      { st: fakeSolanaTracker() },
      { ...enrichOne, min_median_hold_s: realMedian - 1 },
    );
    expect(r.dropped.short_hold).toBeUndefined();
    const enriched = r.candidates.filter((c) => c.medianHoldS !== null);
    expect(enriched).toHaveLength(1);
    expect(enriched[0]?.medianHoldS).toBe(realMedian);
  });
});
