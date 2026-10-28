import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateAll } from '@scb/shared';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { liveStats, readHeartbeat, readView } from '../lib/trading.ts';

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
});
