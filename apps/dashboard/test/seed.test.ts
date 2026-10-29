import { copyFileSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateAll } from '@scb/shared';
import { describe, expect, it } from 'vitest';
import { readView } from '../lib/trading.ts';
import { demoTarget, seedDemo } from '../scripts/seed-demo.ts';

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'scb-seed-'));
  migrateAll(dir);
  return dir;
};

describe('seed-demo guard', () => {
  it('accepts data/demo.db', () => {
    const dir = fresh();
    expect(demoTarget(dir)).toMatch(/demo\.db$/);
  });

  it.each(['paper.db', 'live.db', 'control.db'])('refuses %s', (name) => {
    const dir = fresh();
    expect(() => demoTarget(dir, join(dir, name))).toThrow(/refusing/);
  });

  it('refuses a look-alike path', () => {
    const dir = fresh();
    copyFileSync(join(dir, 'paper.db'), join(dir, 'demo.db.bak'));
    expect(() => demoTarget(dir, join(dir, 'demo.db.bak'))).toThrow(/refusing/);
  });

  it('refuses a demo.db symlinked to paper.db', () => {
    const dir = fresh();
    rmSync(join(dir, 'demo.db'));
    symlinkSync(join(dir, 'paper.db'), join(dir, 'demo.db'));
    expect(() => demoTarget(dir)).toThrow(/refusing/);
  });

  it('refuses a missing demo.db', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scb-seed-'));
    expect(() => demoTarget(dir)).toThrow(/db:migrate/);
  });
});

describe('seedDemo', () => {
  it('fills every panel and is deterministic', () => {
    const dir = fresh();
    const path = demoTarget(dir);
    seedDemo(path, 1_700_000_000_000);
    const a = readView(path, 'DEMO', 1_700_000_000_000);
    if (a.state !== 'ok') throw new Error(a.state);
    const { overview, killReasons, copyLog } = a.data;
    expect(overview.signals).toBe(300);
    expect(overview.killed).toBeGreaterThan(150);
    expect(overview.copied).toBeGreaterThan(10);
    expect(killReasons[0]?.reason).toBe('R1');
    expect(copyLog.some((r) => r.status === 'open')).toBe(true);
    seedDemo(path, 1_700_000_000_000);
    expect(readView(path, 'DEMO', 1_700_000_000_000)).toEqual(a);
    expect(readView(join(dir, 'paper.db'), 'PAPER').state).toBe('empty');
  });
});
