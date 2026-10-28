import { existsSync } from 'node:fs';
import type { Mode } from '@scb/shared';
import Database from 'better-sqlite3';

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
export type TradingData = {
  overview: Overview;
  funnel: FunnelStep[];
  killReasons: KillReason[];
  copyLog: CopyRow[];
  heartbeat: Heartbeat;
};
export type ViewResult =
  | { state: 'missing'; message: string }
  | { state: 'empty'; message: string; heartbeat: Heartbeat }
  | { state: 'ok'; data: TradingData };

export const solscan = {
  token: (mint: string) => `https://solscan.io/token/${mint}`,
  account: (address: string) => `https://solscan.io/account/${address}`,
};

const EMPTY: Record<Mode, string> = {
  DEMO: 'No demo data yet — run pnpm db:seed:demo',
  PAPER: 'No paper data yet — engine writes paper.db',
  LIVE: 'No live data — live trading arrives in M7',
};

// Read-only: the dashboard can never corrupt trading data.
const openRead = (path: string) => {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  return db;
};

const one = <T>(db: Database.Database, sql: string, ...args: unknown[]) =>
  db.prepare(sql).get(...args) as T;

export const readTrading = (db: Database.Database): TradingData => {
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
  const killReasons = db
    .prepare(
      `SELECT coalesce(killed_by, 'unknown') AS reason, count(*) AS count FROM decisions
       WHERE verdict = 'KILLED' GROUP BY 1 ORDER BY 2 DESC, 1`,
    )
    .all() as KillReason[];
  const copyLog = db
    .prepare(
      `SELECT p.id, p.mint, s.wallet, p.status, p.size_usd, p.entry_price, p.entry_at, p.exit_price,
              p.exit_reason, p.net_pnl_usd, p.net_pnl_pct,
              (SELECT count(*) FROM rule_results r WHERE r.signal_id = p.signal_id AND r.passed = 1)
                AS rules_passed,
              (SELECT count(*) FROM rule_results r WHERE r.signal_id = p.signal_id) AS rules_total
       FROM positions p LEFT JOIN signals s ON s.id = p.signal_id
       ORDER BY p.entry_at DESC LIMIT 100`,
    )
    .all() as CopyRow[];
  return { overview, funnel, killReasons, copyLog, heartbeat: heartbeat(db) };
};

const heartbeat = (db: Database.Database): Heartbeat => ({
  lastEventAt: one<{ t: number | null }>(db, 'SELECT max(at) AS t FROM events_log').t,
  lastSignalAt: one<{ t: number | null }>(db, 'SELECT max(detected_at) AS t FROM signals').t,
});

export const readView = (path: string, mode: Mode): ViewResult => {
  if (!existsSync(path)) {
    return { state: 'missing', message: `${path} not found — run pnpm db:migrate` };
  }
  const db = openRead(path);
  try {
    const data = readTrading(db);
    if (!data.overview.signals && !data.overview.copied) {
      return { state: 'empty', message: EMPTY[mode], heartbeat: data.heartbeat };
    }
    return { state: 'ok', data };
  } finally {
    db.close();
  }
};

/** LIVE banner numbers: today's (UTC) net PnL and how much of the daily loss limit is left. */
export const liveStats = (path: string, dailyLossLimitUsd: number, now = Date.now()) => {
  const dayStart = now - (now % 86_400_000);
  let todayPnlUsd = 0;
  if (existsSync(path)) {
    const db = openRead(path);
    try {
      todayPnlUsd = one<{ v: number }>(
        db,
        `SELECT coalesce(sum(net_pnl_usd), 0) AS v FROM positions
         WHERE status = 'closed' AND exit_at >= ?`,
        dayStart,
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
