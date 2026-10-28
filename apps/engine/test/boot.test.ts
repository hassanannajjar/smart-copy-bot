import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appSettings, migrateAll, modeChanges, openControlDb } from '@scb/shared';
import { describe, expect, it } from 'vitest';
import { bootToPaper } from '../src/boot.js';

const freshControl = () => {
  const dir = mkdtempSync(join(tmpdir(), 'scb-boot-'));
  migrateAll(dir);
  return openControlDb(join(dir, 'control.db'));
};

const settings = (db: ReturnType<typeof openControlDb>) =>
  Object.fromEntries(
    db
      .select()
      .from(appSettings)
      .all()
      .map((r) => [r.key, r.value]),
  );

describe('bootToPaper', () => {
  it('comes up in PAPER from LIVE and keeps kill_switch on', () => {
    const db = freshControl();
    const at = new Date(0);
    db.insert(appSettings)
      .values([
        { key: 'active_mode', value: 'LIVE', updatedAt: at, updatedBy: 'test' },
        { key: 'requested_mode', value: 'LIVE', updatedAt: at, updatedBy: 'test' },
        { key: 'kill_switch', value: 'on', updatedAt: at, updatedBy: 'test' },
      ])
      .run();

    expect(bootToPaper(db)).toEqual({ previous: 'LIVE', killSwitch: true });
    expect(settings(db)).toEqual({
      active_mode: 'PAPER',
      requested_mode: 'PAPER',
      kill_switch: 'on',
    });
    const audit = db.select().from(modeChanges).all();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ fromMode: 'LIVE', toMode: 'PAPER', accepted: true });
  });

  it('initialises an empty control.db and does not re-audit PAPER -> PAPER', () => {
    const db = freshControl();
    expect(bootToPaper(db)).toEqual({ previous: null, killSwitch: false });
    bootToPaper(db);
    expect(settings(db)).toMatchObject({ active_mode: 'PAPER', requested_mode: 'PAPER' });
    expect(db.select().from(modeChanges).all()).toHaveLength(1);
  });
});
