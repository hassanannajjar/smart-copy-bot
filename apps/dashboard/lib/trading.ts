import { existsSync } from 'node:fs';
import type { Mode } from '@scb/shared';
import Database from 'better-sqlite3';
import { z } from 'zod';
import type { EventRow } from './events';
import { dayKey, localDayStart } from './format';

export type Overview = {
  wallets: number;
  signals: number;
  killed: number;
  passed: number;
  copied: number;
  closed: number;
  netPnlUsd: number;
  winRate: number | null;
  returnMultiple: number | null;
};
export type FunnelStep = { stage: string; count: number };
export type KillReason = { reason: string; count: number };
export type CopyRow = {
  id: number;
  mint: string;
  wallet: string | null;
  label: string | null;
  status: string;
  size_usd: number;
  entry_price: number;
  entry_at: number;
  exit_price: number | null;
  exit_reason: string | null;
  net_pnl_usd: number | null;
  net_pnl_pct: number | null;
  rules_passed: number;
  rules_total: number;
};
export type Heartbeat = { lastEventAt: number | null; lastSignalAt: number | null };

/** What the dashboard shows from positions.tp_plan_json (the engine's GuardState). */
export type GuardView = {
  nextTp: { price: number; sellPct: number } | null;
  ladderDone: boolean;
  trailPct: number;
  trailAt: number | null; // trailing stop level once the ladder is done
  timeStopAt: number;
  remaining: number | null; // fraction of the bag still held
  mark: number | null; // not persisted by the engine yet (last_mark)
  markAt: number | null;
};
export type OpenPosition = {
  id: number;
  mint: string;
  wallet: string | null;
  label: string | null;
  size_usd: number;
  entry_price: number;
  entry_at: number;
  stop_price: number;
  guard: GuardView | null; // null = tp_plan_json unreadable
};
export type EquityPoint = { t: number; cum: number };
export type DailyPnl = { day: string; pnl: number };
export type Health = {
  heartbeatAt: number | null;
  notificationAgeS: number | null; // now, = age at the heartbeat + time since it
  livenessToday: number;
  problemsToday: { level: string; message: string; count: number }[];
  subscribed: number | null;
  activeWallets: number;
};
export type SignalRow = {
  id: number;
  detected_at: number;
  wallet: string;
  label: string | null;
  mint: string;
  side: string;
  amount_sol: number | null;
  tx_sig: string;
  verdict: string | null;
  killed_by: string | null;
  confluence: number | null;
};
export type TradingData = {
  overview: Overview;
  funnel: FunnelStep[];
  killReasons: KillReason[];
  copyLog: CopyRow[];
  heartbeat: Heartbeat;
  open: OpenPosition[];
  equity: EquityPoint[];
  daily: DailyPnl[];
  activity: EventRow[];
  health: Health;
  signals: SignalRow[];
};
export type ViewResult =
  | { state: 'missing'; message: string }
  | { state: 'empty'; message: string; heartbeat: Heartbeat; health: Health }
  | { state: 'ok'; data: TradingData };

export const solscan = {
  token: (mint: string) => `https://solscan.io/token/${encodeURIComponent(mint)}`,
  account: (address: string) => `https://solscan.io/account/${encodeURIComponent(address)}`,
  tx: (sig: string) => `https://solscan.io/tx/${encodeURIComponent(sig)}`,
};

const EMPTY: Record<Mode, string> = {
  DEMO: 'No demo data yet — run pnpm db:seed:demo',
  PAPER: 'No paper data yet — engine writes paper.db',
  LIVE: 'No live data — live trading arrives in M7',
};

export const DAILY_DAYS = 30;

// Read-only: the dashboard can never corrupt trading data.
const openRead = (path: string) => {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  return db;
};

const one = <T>(db: Database.Database, sql: string, ...args: unknown[]) =>
  db.prepare(sql).get(...args) as T;
const all = <T>(db: Database.Database, sql: string, ...args: unknown[]) =>
  db.prepare(sql).all(...args) as T[];

// Only the GuardState fields the dashboard reads; unknown fields are ignored.
const guardSchema = z.object({
  take_profit: z.array(
    z.object({ at_multiple: z.number(), sell_pct: z.number(), done: z.boolean() }),
  ),
  trailing_stop_pct: z.number(),
  time_stop_at: z.number(),
  initial_raw: z.string(),
  remaining_raw: z.string(),
  peak_price: z.number().nullable(),
  last_mark: z.number().nullish(),
  last_mark_at: z.number().nullish(),
});

export const parseGuard = (json: string, entryPrice: number): GuardView | null => {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const r = guardSchema.safeParse(raw);
  if (!r.success) return null;
  const g = r.data;
  const next = g.take_profit.find((l) => !l.done);
  let remaining: number | null = null;
  try {
    const init = BigInt(g.initial_raw);
    if (init > 0n) remaining = Number((BigInt(g.remaining_raw) * 10_000n) / init) / 10_000;
  } catch {
    // non-integer raw amounts: leave remaining unknown
  }
  return {
    nextTp: next ? { price: entryPrice * next.at_multiple, sellPct: next.sell_pct } : null,
    ladderDone: !next,
    trailPct: g.trailing_stop_pct,
    trailAt: g.peak_price === null ? null : g.peak_price * (1 - g.trailing_stop_pct / 100),
    timeStopAt: g.time_stop_at,
    remaining,
    mark: g.last_mark ?? null,
    markAt: g.last_mark_at ?? null,
  };
};

const readHealth = (db: Database.Database, now: number): Health => {
  const today = localDayStart(now);
  const hb = one<{ at: number; data_json: string | null } | undefined>(
    db,
    `SELECT at, data_json FROM events_log WHERE stage = 'scout' AND message = 'heartbeat'
     ORDER BY id DESC LIMIT 1`,
  );
  const field = (json: string | null | undefined, k: string) => {
    try {
      const v = JSON.parse(json ?? '{}')[k];
      return typeof v === 'number' ? v : null;
    } catch {
      return null;
    }
  };
  const ageAtBeat = field(hb?.data_json, 'last_notification_age_s');
  const acked = one<{ data_json: string | null } | undefined>(
    db,
    `SELECT data_json FROM events_log WHERE stage = 'scout' AND message = 'subscriptions_acked'
     ORDER BY id DESC LIMIT 1`,
  );
  return {
    heartbeatAt: hb?.at ?? null,
    notificationAgeS:
      hb && ageAtBeat !== null ? ageAtBeat + Math.max(0, (now - hb.at) / 1000) : null,
    // ponytail: full scan of today's events_log rows; add an events_log(at) index if it gets slow
    livenessToday: one<{ n: number }>(
      db,
      "SELECT count(*) AS n FROM events_log WHERE message = 'liveness_timeout' AND at >= ?",
      today,
    ).n,
    problemsToday: all(
      db,
      `SELECT level, message, count(*) AS count FROM events_log
       WHERE level IN ('warn', 'error') AND at >= ? GROUP BY 1, 2 ORDER BY 3 DESC, 1, 2`,
      today,
    ),
    subscribed: field(acked?.data_json, 'count'),
    activeWallets: one<{ n: number }>(db, 'SELECT count(*) AS n FROM wallets WHERE active = 1').n,
  };
};

export const readTrading = (db: Database.Database, now = Date.now()): TradingData => {
  const n = (sql: string) => one<{ n: number }>(db, sql).n;
  const pnl = one<{ closed: number; wins: number; size: number; net: number }>(
    db,
    `SELECT count(*) AS closed, coalesce(sum(net_pnl_usd > 0), 0) AS wins,
            coalesce(sum(size_usd), 0) AS size, coalesce(sum(net_pnl_usd), 0) AS net
     FROM positions WHERE status = 'closed'`,
  );
  const signals = n('SELECT count(*) AS n FROM signals');
  const passed = n("SELECT count(*) AS n FROM decisions WHERE verdict = 'PASSED'");
  const copied = n('SELECT count(*) AS n FROM positions');
  const overview: Overview = {
    wallets: n('SELECT count(*) AS n FROM wallets WHERE active = 1'),
    signals,
    killed: n("SELECT count(*) AS n FROM decisions WHERE verdict = 'KILLED'"),
    passed,
    copied,
    closed: pnl.closed,
    netPnlUsd: pnl.net,
    winRate: pnl.closed ? pnl.wins / pnl.closed : null,
    returnMultiple: pnl.size ? (pnl.size + pnl.net) / pnl.size : null,
  };
  const vetoed = n(
    `SELECT count(DISTINCT a.signal_id) AS n FROM analyst_reviews a
     JOIN decisions d ON d.signal_id = a.signal_id
     WHERE d.verdict = 'PASSED' AND a.used_for_decision = 1 AND a.verdict = 'veto'`,
  );
  const funnel: FunnelStep[] = [
    { stage: 'Scout', count: signals },
    { stage: 'Filter', count: n("SELECT count(*) AS n FROM decisions WHERE verdict != 'SKIPPED'") },
    { stage: 'Analyst', count: passed },
    { stage: 'Guard', count: passed - vetoed },
    { stage: 'Copied', count: copied },
  ];
  const killReasons = all<KillReason>(
    db,
    `SELECT coalesce(killed_by, 'unknown') AS reason, count(*) AS count FROM decisions
     WHERE verdict = 'KILLED' GROUP BY 1 ORDER BY 2 DESC, 1`,
  );
  const copyLog = all<CopyRow>(
    db,
    `SELECT p.id, p.mint, s.wallet, w.label, p.status, p.size_usd, p.entry_price, p.entry_at,
            p.exit_price, p.exit_reason, p.net_pnl_usd, p.net_pnl_pct,
            (SELECT count(*) FROM rule_results r WHERE r.signal_id = p.signal_id AND r.passed = 1)
              AS rules_passed,
            (SELECT count(*) FROM rule_results r WHERE r.signal_id = p.signal_id) AS rules_total
     FROM positions p LEFT JOIN signals s ON s.id = p.signal_id
     LEFT JOIN wallets w ON w.address = s.wallet
     ORDER BY p.entry_at DESC LIMIT 100`,
  );
  const open = all<Omit<OpenPosition, 'guard'> & { tp_plan_json: string }>(
    db,
    `SELECT p.id, p.mint, s.wallet, w.label, p.size_usd, p.entry_price, p.entry_at, p.stop_price,
            p.tp_plan_json
     FROM positions p LEFT JOIN signals s ON s.id = p.signal_id
     LEFT JOIN wallets w ON w.address = s.wallet
     WHERE p.status = 'open' ORDER BY p.entry_at DESC`,
  ).map(({ tp_plan_json, ...p }) => ({ ...p, guard: parseGuard(tp_plan_json, p.entry_price) }));

  const closed = all<{ t: number; pnl: number }>(
    db,
    `SELECT exit_at AS t, coalesce(net_pnl_usd, 0) AS pnl FROM positions
     WHERE status = 'closed' AND exit_at IS NOT NULL ORDER BY exit_at, id`,
  );
  const equity: EquityPoint[] = [];
  const byDay = new Map<string, number>();
  for (const c of closed) {
    equity.push({ t: c.t, cum: (equity.at(-1)?.cum ?? 0) + c.pnl });
    byDay.set(dayKey(c.t), (byDay.get(dayKey(c.t)) ?? 0) + c.pnl);
  }
  const daily = Array.from({ length: DAILY_DAYS }, (_, i) => {
    const day = dayKey(localDayStart(now, DAILY_DAYS - 1 - i));
    return { day, pnl: byDay.get(day) ?? 0 };
  });

  const activity = all<EventRow>(
    db,
    "SELECT * FROM events_log WHERE message != 'heartbeat' ORDER BY id DESC LIMIT 50",
  );
  const recent = all<SignalRow>(
    db,
    `SELECT s.id, s.detected_at, s.wallet, w.label, s.mint, s.side, s.amount_sol, s.tx_sig,
            d.verdict, d.killed_by, d.confluence
     FROM signals s LEFT JOIN decisions d ON d.signal_id = s.id
     LEFT JOIN wallets w ON w.address = s.wallet
     ORDER BY s.detected_at DESC, s.id DESC LIMIT 50`,
  );
  return {
    overview,
    funnel,
    killReasons,
    copyLog,
    heartbeat: heartbeat(db),
    open,
    equity,
    daily,
    activity,
    health: readHealth(db, now),
    signals: recent,
  };
};

const heartbeat = (db: Database.Database): Heartbeat => ({
  lastEventAt: one<{ t: number | null }>(db, 'SELECT max(at) AS t FROM events_log').t,
  lastSignalAt: one<{ t: number | null }>(db, 'SELECT max(detected_at) AS t FROM signals').t,
});

export const readView = (path: string, mode: Mode, now = Date.now()): ViewResult => {
  if (!existsSync(path)) {
    return { state: 'missing', message: `${path} not found — run pnpm db:migrate` };
  }
  const db = openRead(path);
  try {
    const data = readTrading(db, now);
    if (!data.overview.signals && !data.overview.copied) {
      return {
        state: 'empty',
        message: EMPTY[mode],
        heartbeat: data.heartbeat,
        health: data.health,
      };
    }
    return { state: 'ok', data };
  } finally {
    db.close();
  }
};

/** LIVE banner numbers: today's (local day) net PnL and how much of the daily loss limit is left. */
export const liveStats = (path: string, dailyLossLimitUsd: number, now = Date.now()) => {
  let todayPnlUsd = 0;
  if (existsSync(path)) {
    const db = openRead(path);
    try {
      todayPnlUsd = one<{ v: number }>(
        db,
        `SELECT coalesce(sum(net_pnl_usd), 0) AS v FROM positions
         WHERE status = 'closed' AND exit_at >= ?`,
        localDayStart(now),
      ).v;
    } finally {
      db.close();
    }
  }
  return { todayPnlUsd, lossRemainingUsd: dailyLossLimitUsd + Math.min(0, todayPnlUsd) };
};

/** Engine heartbeat from the active mode's DB; null when that DB doesn't exist yet. */
export const readHeartbeat = (path: string): Heartbeat | null => {
  if (!existsSync(path)) return null;
  const db = openRead(path);
  try {
    return heartbeat(db);
  } finally {
    db.close();
  }
};

/** Scout health from the active mode's DB, for the engine strip; null when that DB doesn't exist yet. */
export const readEngineHealth = (path: string, now = Date.now()): Health | null => {
  if (!existsSync(path)) return null;
  const db = openRead(path);
  try {
    return readHealth(db, now);
  } finally {
    db.close();
  }
};
