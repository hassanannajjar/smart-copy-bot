import Database from 'better-sqlite3';

// The dashboard's only writer, and it writes control.db only.
// Engine mode is PAPER|LIVE. DEMO is a dashboard data view (cookie) and is never written here.
export type EngineMode = 'PAPER' | 'LIVE';
export type ModeState = { requested: EngineMode; active: EngineMode; killSwitch: boolean };
export type ModeChange = {
  id: number;
  at: number;
  from_mode: string | null;
  to_mode: string;
  requested_by: string;
  accepted: number;
  reason: string | null;
};

const BY = 'dashboard';

const open = (path: string, readonly = false) => {
  const db = new Database(path, { fileMustExist: true, readonly });
  db.pragma('busy_timeout = 5000'); // the engine writes control.db too
  return db;
};

const use = <T>(path: string, fn: (db: Database.Database) => T, readonly = false): T => {
  const db = open(path, readonly);
  try {
    return fn(db);
  } finally {
    db.close();
  }
};

const get = (db: Database.Database, key: string) =>
  (
    db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
  )?.value;

// Fail closed: anything other than an exact 'LIVE' reads as PAPER (the engine's boot default).
const asMode = (v: string | undefined): EngineMode => (v === 'LIVE' ? 'LIVE' : 'PAPER');

export const readModeState = (path: string): ModeState =>
  use(
    path,
    (db) => ({
      requested: asMode(get(db, 'requested_mode')),
      active: asMode(get(db, 'active_mode')),
      killSwitch: get(db, 'kill_switch') === 'on',
    }),
    true,
  );

const set = (db: Database.Database, key: string, value: string, now: number) =>
  db
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
    )
    .run(key, value, now, BY);

const log = (
  db: Database.Database,
  now: number,
  from: string | null,
  to: string,
  accepted: boolean,
  reason: string | null,
) =>
  db
    .prepare(
      `INSERT INTO mode_changes (at, from_mode, to_mode, requested_by, accepted, reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(now, from, to, BY, accepted ? 1 : 0, reason);

const toPaper = (db: Database.Database, now: number, reason: string) => {
  const from = get(db, 'active_mode') ?? null;
  set(db, 'requested_mode', 'PAPER', now);
  set(db, 'active_mode', 'PAPER', now);
  log(db, now, from, 'PAPER', true, reason);
};

/** PAPER is the safe direction, so the dashboard accepts it directly (until M7 moves acceptance to the engine). */
export const requestPaper = (path: string, now = Date.now()) =>
  use(path, (db) => db.transaction(() => toPaper(db, now, 'requested from dashboard')).immediate());

// ponytail: hard-closed until M7 adds an engine status channel (isLiveArmed + wallet + balance).
export const liveGate = () => ({
  open: false as const,
  reason:
    'LIVE disabled: engine has not reported LIVE_ENABLED + LIVE_CONFIRM and a configured wallet (M7).',
});

/** Records the attempt and rejects it. Never touches app_settings. */
export const requestLive = (path: string, now = Date.now()) =>
  use(path, (db) => {
    log(db, now, get(db, 'active_mode') ?? null, 'LIVE', false, liveGate().reason);
  });

export const setKillSwitch = (path: string, on: boolean, now = Date.now()) =>
  use(path, (db) =>
    db
      .transaction(() => {
        // Engaging twice (double-click, two tabs) must not log twice.
        if (on && get(db, 'kill_switch') === 'on') return;
        set(db, 'kill_switch', on ? 'on' : 'off', now);
        if (on) toPaper(db, now, 'kill switch engaged');
        else {
          const mode = get(db, 'active_mode') ?? 'PAPER';
          log(db, now, mode, mode, true, 'kill switch released');
        }
      })
      .immediate(),
  );

export const modeHistory = (path: string, limit = 50) =>
  use(
    path,
    (db) =>
      db.prepare('SELECT * FROM mode_changes ORDER BY id DESC LIMIT ?').all(limit) as ModeChange[],
    true,
  );
