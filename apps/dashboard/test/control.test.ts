import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateAll } from '@scb/shared';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  modeHistory,
  readModeState,
  requestLive,
  requestPaper,
  setKillSwitch,
} from '../lib/control.ts';

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'scb-dash-'));
  migrateAll(dir);
  return join(dir, 'control.db');
};

const raw = (path: string, sql: string, ...args: unknown[]) => {
  const db = new Database(path);
  try {
    const stmt = db.prepare(sql);
    if (!stmt.reader) {
      stmt.run(...args);
      return [];
    }
    return stmt.all(...args) as Record<string, unknown>[];
  } finally {
    db.close();
  }
};

const setting = (path: string, key: string) =>
  raw(path, 'SELECT value FROM app_settings WHERE key = ?', key)[0]?.value;

describe('control', () => {
  it('reads missing settings as PAPER with the kill switch off', () => {
    expect(readModeState(fresh())).toEqual({
      requested: 'PAPER',
      active: 'PAPER',
      killSwitch: false,
    });
  });

  it('reads anything other than an exact LIVE as PAPER', () => {
    const path = fresh();
    raw(path, "INSERT INTO app_settings VALUES ('active_mode', 'live', 1, 'x')");
    expect(readModeState(path).active).toBe('PAPER');
  });

  it('accepts PAPER and logs it', () => {
    const path = fresh();
    raw(path, "INSERT INTO app_settings VALUES ('active_mode', 'LIVE', 1, 'engine')");
    requestPaper(path, 42);
    expect(readModeState(path)).toMatchObject({ requested: 'PAPER', active: 'PAPER' });
    expect(modeHistory(path)).toEqual([
      expect.objectContaining({
        at: 42,
        from_mode: 'LIVE',
        to_mode: 'PAPER',
        requested_by: 'dashboard',
        accepted: 1,
      }),
    ]);
  });

  it('rejects LIVE with a reason and never touches app_settings', () => {
    const path = fresh();
    requestLive(path, 7);
    expect(raw(path, 'SELECT * FROM app_settings')).toEqual([]);
    expect(readModeState(path).active).toBe('PAPER');
    const [row] = modeHistory(path);
    expect(row).toMatchObject({ to_mode: 'LIVE', accepted: 0 });
    expect(row?.reason).toMatch(/LIVE disabled/);
  });

  it('kill switch on forces PAPER and logs; off logs and keeps the mode', () => {
    const path = fresh();
    raw(path, "INSERT INTO app_settings VALUES ('active_mode', 'LIVE', 1, 'engine')");
    setKillSwitch(path, true, 1);
    expect(readModeState(path)).toEqual({ requested: 'PAPER', active: 'PAPER', killSwitch: true });
    setKillSwitch(path, false, 2);
    expect(readModeState(path).killSwitch).toBe(false);
    expect(modeHistory(path).map((r) => r.reason)).toEqual([
      'kill switch released',
      'kill switch engaged',
    ]);
  });

  it('engaging an engaged kill switch does nothing and logs nothing', () => {
    const path = fresh();
    setKillSwitch(path, true, 1);
    setKillSwitch(path, true, 2);
    expect(readModeState(path).killSwitch).toBe(true);
    expect(modeHistory(path).map((r) => [r.at, r.reason])).toEqual([[1, 'kill switch engaged']]);
  });

  it('never writes DEMO to control.db', () => {
    const path = fresh();
    requestPaper(path);
    requestLive(path);
    setKillSwitch(path, true);
    setKillSwitch(path, false);
    expect(setting(path, 'active_mode')).toBe('PAPER');
    expect(raw(path, "SELECT * FROM app_settings WHERE value = 'DEMO'")).toEqual([]);
    expect(raw(path, "SELECT * FROM mode_changes WHERE to_mode = 'DEMO'")).toEqual([]);
  });

  it('fails on a missing control.db instead of creating one', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'scb-dash-')), 'control.db');
    expect(() => requestPaper(path)).toThrow();
    expect(() => readModeState(path)).toThrow();
  });
});
