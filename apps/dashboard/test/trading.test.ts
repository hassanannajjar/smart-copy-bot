import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateAll } from '@scb/shared';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { localDayStart } from '../lib/format.ts';
import {
  liveStats,
  parseGuard,
  readEngineHealth,
  readHeartbeat,
  readView,
} from '../lib/trading.ts';

// "Today" and daily buckets are the server's local day; pin it so the test is machine-independent.
process.env.TZ = 'Asia/Qatar';

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'scb-dash-'));
  migrateAll(dir);
  return join(dir, 'paper.db');
};

const exec = (path: string, sql: string) => {
  const db = new Database(path);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
};

const DAY = 86_400_000;

// 4 signals: 1 skipped, 1 killed (R1), 2 passed (one vetoed by the analyst, one copied and closed).
const sample = (path: string) =>
  exec(
    path,
    `INSERT INTO wallets (address, added_at, active) VALUES ('w1', 1, 1), ('w2', 1, 0);
     INSERT INTO signals (id, wallet, mint, side, tx_sig, detected_at) VALUES
       (1, 'w1', 'm1', 'buy', 't1', 10), (2, 'w1', 'm2', 'buy', 't2', 20),
       (3, 'w1', 'm3', 'buy', 't3', 30), (4, 'w1', 'm4', 'buy', 't4', 40);
     INSERT INTO decisions (signal_id, verdict, killed_by, decided_at) VALUES
       (1, 'SKIPPED', NULL, 11), (2, 'KILLED', 'R1', 21), (3, 'PASSED', NULL, 31), (4, 'PASSED', NULL, 41);
     INSERT INTO analyst_reviews (signal_id, provider, model, verdict, used_for_decision)
       VALUES (3, 'p', 'm', 'veto', 1);
     INSERT INTO rule_results (signal_id, rule_id, passed) VALUES
       (4, 'R1', 1), (4, 'R2', 1), (4, 'R3', 1), (4, 'R4', 1), (4, 'R5', 1), (4, 'R6', 1);
     INSERT INTO positions (signal_id, mode, mint, size_usd, entry_price, entry_at, stop_price,
       tp_plan_json, status, exit_at, net_pnl_usd)
       VALUES (4, 'PAPER', 'm4', 100, 1, 42, 0.8, '[]', 'closed', ${DAY + 5}, 25);
     INSERT INTO events_log (at, level, stage, message) VALUES (99, 'info', 'scout', 'hi');`,
  );

describe('trading', () => {
  it('computes the panels from a hand-built dataset', () => {
    const path = fresh();
    sample(path);
    const view = readView(path, 'PAPER');
    if (view.state !== 'ok') throw new Error(view.state);
    const { overview, funnel, killReasons, copyLog, heartbeat } = view.data;
    expect(overview).toEqual({
      wallets: 1,
      signals: 4,
      killed: 1,
      passed: 2,
      copied: 1,
      closed: 1,
      netPnlUsd: 25,
      winRate: 1,
      returnMultiple: 1.25,
    });
    expect(funnel.map((f) => f.count)).toEqual([4, 3, 2, 1, 1]);
    expect(killReasons).toEqual([{ reason: 'R1', count: 1 }]);
    expect(copyLog).toEqual([
      expect.objectContaining({ mint: 'm4', wallet: 'w1', rules_passed: 6, rules_total: 6 }),
    ]);
    expect(heartbeat).toEqual({ lastEventAt: 99, lastSignalAt: 40 });
  });

  it('shows the per-mode empty state on an empty DB', () => {
    expect(readView(fresh(), 'PAPER')).toMatchObject({
      state: 'empty',
      message: expect.stringMatching(/No paper data yet/),
    });
  });

  it('reports a missing DB file instead of creating it', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'scb-dash-')), 'paper.db');
    expect(readView(path, 'PAPER')).toMatchObject({ state: 'missing' });
  });

  it('readHeartbeat reports the last event and signal, and null for a missing DB', () => {
    const path = fresh();
    sample(path);
    expect(readHeartbeat(path)).toEqual({ lastEventAt: 99, lastSignalAt: 40 });
    expect(readHeartbeat(join(tmpdir(), 'nope.db'))).toBeNull();
  });

  it('liveStats counts only today and caps the loss remaining at the limit', () => {
    const path = fresh();
    sample(path);
    expect(liveStats(path, 50, DAY + 1000)).toEqual({ todayPnlUsd: 25, lossRemainingUsd: 50 });
    expect(liveStats(path, 50, 2 * DAY + 1000)).toEqual({ todayPnlUsd: 0, lossRemainingUsd: 50 });
    exec(
      path,
      `INSERT INTO positions (signal_id, mode, mint, size_usd, entry_price, entry_at, stop_price,
         tp_plan_json, status, exit_at, net_pnl_usd)
         VALUES (4, 'PAPER', 'm5', 100, 1, 42, 0.8, '[]', 'closed', ${DAY + 6}, -40);`,
    );
    expect(liveStats(path, 50, DAY + 1000)).toEqual({ todayPnlUsd: -15, lossRemainingUsd: 35 });
    expect(liveStats(join(tmpdir(), 'nope.db'), 50)).toEqual({
      todayPnlUsd: 0,
      lossRemainingUsd: 50,
    });
  });

  it('liveStats uses the local day (UTC+3), not the UTC day', () => {
    const path = fresh();
    const exit = Date.UTC(2026, 9, 29, 1); // 01:00 UTC = 04:00 local, 29 Oct
    exec(
      path,
      `INSERT INTO signals (id, wallet, mint, side, tx_sig, detected_at) VALUES (1, 'w', 'm', 'buy', 't', 1);
       INSERT INTO positions (signal_id, mode, mint, size_usd, entry_price, entry_at, stop_price,
         tp_plan_json, status, exit_at, net_pnl_usd)
         VALUES (1, 'paper', 'm', 100, 1, 1, 0.8, '{}', 'closed', ${exit}, 25);`,
    );
    expect(localDayStart(exit)).toBe(Date.UTC(2026, 9, 28, 21));
    // 22:00 UTC on 29 Oct is already 30 Oct locally: no longer "today" (a UTC day would say 25).
    expect(liveStats(path, 50, Date.UTC(2026, 9, 29, 22)).todayPnlUsd).toBe(0);
    expect(liveStats(path, 50, Date.UTC(2026, 9, 29, 20)).todayPnlUsd).toBe(25);
  });

  it('reads open positions with their guard levels, and flags a broken guard', () => {
    const path = fresh();
    sample(path);
    const guard = {
      take_profit: [
        { at_multiple: 2, sell_pct: 50, done: true },
        { at_multiple: 4, sell_pct: 50, done: false },
      ],
      trailing_stop_pct: 25,
      time_stop_at: 5000,
      initial_raw: '1000',
      remaining_raw: '500',
      peak_price: null,
      extra_field: 1,
    };
    exec(
      path,
      `INSERT INTO wallets (address, label, added_at, active) VALUES ('w3', 'alpha', 1, 1);
       INSERT INTO signals (id, wallet, mint, side, tx_sig, detected_at) VALUES
         (5, 'w3', 'm5', 'buy', 't5', 50), (6, 'w1', 'm6', 'buy', 't6', 60);
       INSERT INTO positions (signal_id, mode, mint, size_usd, entry_price, entry_at, stop_price,
         tp_plan_json, status) VALUES
         (5, 'paper', 'm5', 50, 0.5, 51, 0.35, '${JSON.stringify(guard)}', 'open'),
         (6, 'paper', 'm6', 50, 1, 61, 0.7, 'not json', 'open');`,
    );
    const view = readView(path, 'PAPER', 1000);
    if (view.state !== 'ok') throw new Error(view.state);
    const [broken, ok] = view.data.open;
    expect(broken).toMatchObject({ mint: 'm6', guard: null });
    expect(ok).toMatchObject({ mint: 'm5', wallet: 'w3', label: 'alpha', stop_price: 0.35 });
    expect(ok?.guard).toEqual({
      nextTp: { price: 2, sellPct: 50 },
      ladderDone: false,
      trailPct: 25,
      trailAt: null,
      timeStopAt: 5000,
      remaining: 0.5,
      mark: null,
      markAt: null,
    });
  });

  it('parseGuard: done ladder arms the trailing stop; wrong shape is null', () => {
    const g = {
      take_profit: [{ at_multiple: 2, sell_pct: 50, done: true }],
      trailing_stop_pct: 25,
      time_stop_at: 1,
      initial_raw: '0',
      remaining_raw: '0',
      peak_price: 4,
      last_mark: 3.5,
      last_mark_at: 9,
    };
    expect(parseGuard(JSON.stringify(g), 1)).toMatchObject({
      nextTp: null,
      ladderDone: true,
      trailAt: 3,
      remaining: null,
      mark: 3.5,
      markAt: 9,
    });
    expect(parseGuard('[]', 1)).toBeNull();
    expect(parseGuard(JSON.stringify({ ...g, time_stop_at: 'soon' }), 1)).toBeNull();
  });

  it('builds the equity curve and zero-filled local daily buckets', () => {
    const path = fresh();
    sample(path); // +25 at DAY+5
    exec(
      path,
      `INSERT INTO positions (signal_id, mode, mint, size_usd, entry_price, entry_at, stop_price,
         tp_plan_json, status, exit_at, net_pnl_usd) VALUES
         (4, 'paper', 'm7', 100, 1, 42, 0.8, '{}', 'closed', ${DAY + 7_200_000}, -10),
         (4, 'paper', 'm8', 100, 1, 42, 0.8, '{}', 'closed', ${3 * DAY}, 4);`,
    );
    const view = readView(path, 'PAPER', 3 * DAY + 1000);
    if (view.state !== 'ok') throw new Error(view.state);
    expect(view.data.equity.map((p) => p.cum)).toEqual([25, 15, 19]);
    const { daily } = view.data;
    expect(daily).toHaveLength(30);
    expect(daily.at(-1)).toEqual({ day: '1970-01-04', pnl: 4 });
    expect(daily.at(-3)).toEqual({ day: '1970-01-02', pnl: 15 });
    expect(daily.at(-2)?.pnl).toBe(0);
  });

  it('activity skips heartbeats; recent signals join decision and wallet label', () => {
    const path = fresh();
    sample(path);
    exec(
      path,
      `INSERT INTO events_log (at, level, stage, message) VALUES (100, 'info', 'scout', 'heartbeat');
       UPDATE wallets SET label = 'w-one' WHERE address = 'w1';
       UPDATE decisions SET confluence = 2 WHERE signal_id = 2;`,
    );
    const view = readView(path, 'PAPER');
    if (view.state !== 'ok') throw new Error(view.state);
    expect(view.data.activity.map((e) => e.message)).toEqual(['hi']);
    expect(view.data.signals[0]).toMatchObject({ id: 4, verdict: 'PASSED', label: 'w-one' });
    expect(view.data.signals.find((s) => s.id === 2)).toMatchObject({
      verdict: 'KILLED',
      killed_by: 'R1',
      confluence: 2,
    });
  });

  it('engine health counts only today and reads the last heartbeat and subscription', () => {
    const path = fresh();
    const now = 10 * DAY;
    const today = localDayStart(now);
    exec(
      path,
      `INSERT INTO wallets (address, added_at, active) VALUES ('a', 1, 1), ('b', 1, 1);
       INSERT INTO events_log (at, level, stage, message, data_json) VALUES
         (${today - 1}, 'warn', 'scout', 'liveness_timeout', '{}'),
         (${today + 1}, 'warn', 'scout', 'liveness_timeout', '{}'),
         (${today + 2}, 'error', 'paper', 'open_failed', '{}'),
         (${today + 3}, 'info', 'scout', 'subscriptions_acked', '{"count":1}'),
         (${now - 60_000}, 'info', 'scout', 'heartbeat', '{"last_notification_age_s":5}');`,
    );
    expect(readEngineHealth(path, now)).toEqual({
      heartbeatAt: now - 60_000,
      notificationAgeS: 65,
      livenessToday: 1,
      problemsToday: [
        { level: 'error', message: 'open_failed', count: 1 },
        { level: 'warn', message: 'liveness_timeout', count: 1 },
      ],
      subscribed: 1,
      activeWallets: 2,
    });
    expect(readEngineHealth(join(tmpdir(), 'nope.db'))).toBeNull();
  });
});
