import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrateAll } from '../src/db/migrate.js';

const TRADING = [
  'analyst_reviews',
  'decisions',
  'events_log',
  'fills',
  'positions',
  'rule_results',
  'signals',
  'token_snapshots',
  'wallets',
];

const tables = (path: string) => {
  const db = new Database(path);
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name",
    )
    .all() as { name: string }[];
  db.close();
  return rows.map((r) => r.name);
};

describe('migrateAll', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scb-'));
  migrateAll(dir);
  migrateAll(dir); // idempotent

  it('puts only control tables in control.db', () => {
    expect(tables(join(dir, 'control.db'))).toEqual(['app_settings', 'mode_changes']);
  });

  it.each(['demo', 'paper', 'live'])('puts only trading tables in %s.db', (mode) => {
    expect(tables(join(dir, `${mode}.db`))).toEqual(TRADING);
  });

  it('enforces unique tx_sig and one open position per mint', () => {
    const db = new Database(join(dir, 'paper.db'));
    const sig = db.prepare(
      "INSERT INTO signals (wallet, mint, side, tx_sig, detected_at) VALUES ('w', 'M', 'buy', ?, 0)",
    );
    sig.run('a');
    sig.run('b');
    expect(() => sig.run('a')).toThrow(/UNIQUE/);

    const open = db.prepare(
      "INSERT INTO positions (signal_id, mode, mint, size_usd, entry_price, entry_at, stop_price, tp_plan_json, status) VALUES (?, 'paper', 'M', 50, 1, 0, 0.7, '[]', ?)",
    );
    open.run(1, 'open');
    expect(() => open.run(2, 'open')).toThrow(/UNIQUE/);
    db.prepare("UPDATE positions SET status = 'closed'").run();
    expect(() => open.run(2, 'open')).not.toThrow();
    db.close();
  });
});
