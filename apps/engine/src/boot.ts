import { appSettings, type ControlDb, modeChanges } from '@scb/shared';
import { eq } from 'drizzle-orm';

/**
 * The engine always comes up in PAPER, whatever the last session left behind.
 * LIVE can only be re-entered through the dashboard confirmation flow (PLAN §7.1, §9).
 * kill_switch is deliberately left untouched: a restart must not silently clear a halt.
 */
export const bootToPaper = (db: ControlDb, now = new Date()) =>
  db.transaction((tx) => {
    const get = (key: 'active_mode' | 'kill_switch') =>
      tx.select().from(appSettings).where(eq(appSettings.key, key)).get()?.value;
    const previous = get('active_mode') ?? null;

    for (const key of ['requested_mode', 'active_mode'] as const) {
      tx.insert(appSettings)
        .values({ key, value: 'PAPER', updatedAt: now, updatedBy: 'engine_boot' })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: { value: 'PAPER', updatedAt: now, updatedBy: 'engine_boot' },
        })
        .run();
    }
    if (previous !== 'PAPER') {
      tx.insert(modeChanges)
        .values({
          at: now,
          fromMode: previous,
          toMode: 'PAPER',
          requestedBy: 'engine_boot',
          accepted: true,
          reason: 'engine always starts in PAPER',
        })
        .run();
    }
    return { previous, killSwitch: get('kill_switch') === 'on' };
  });

/** M3: read on every entry (the dashboard toggles it live). Unreadable => on: fail closed. */
export const readKillSwitch = (db: ControlDb) => {
  try {
    return (
      db.select().from(appSettings).where(eq(appSettings.key, 'kill_switch')).get()?.value === 'on'
    );
  } catch {
    return true;
  }
};
