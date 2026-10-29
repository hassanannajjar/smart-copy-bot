// Fills data/demo.db with deterministic fake data. Refuses any other file.
// Run: pnpm db:seed:demo (after pnpm db:migrate).
import { existsSync, realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { controlDbPath, modeDbPath, parseEnv } from '@scb/shared';
import Database from 'better-sqlite3';

const real = (p: string) => (existsSync(p) ? realpathSync(p) : resolve(p));

/** Returns the demo.db path, or throws if it is missing or resolves to any other DB (symlinks included). */
export const demoTarget = (dataDir: string, target = modeDbPath(dataDir, 'DEMO')) => {
  if (!existsSync(target)) throw new Error(`${target} not found — run pnpm db:migrate first`);
  const t = realpathSync(target);
  const others = [
    controlDbPath(dataDir),
    modeDbPath(dataDir, 'PAPER'),
    modeDbPath(dataDir, 'LIVE'),
  ].map(real);
  if (basename(t) !== 'demo.db' || others.includes(t)) {
    throw new Error(`refusing to seed ${target}: not the demo DB`);
  }
  return t;
};

// mulberry32: tiny seeded PRNG so the demo data is the same on every run.
const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (bytes: number[]) => {
  let n = bytes.reduce((a, b) => a * 256n + BigInt(b), 0n);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  return s;
};

const RULES = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'] as const;
// Kill-reason weights: liquidity most common, then LP/authorities, then pump.
const KILL_WEIGHTS: [string, number][] = [
  ['R1', 30],
  ['R6', 20],
  ['R5', 15],
  ['R2', 12],
  ['R4', 8],
  ['R3', 5],
  ['data_unavailable', 10],
];

// Child tables first so deletes never trip a foreign key.
const TABLES = [
  'fills',
  'positions',
  'analyst_reviews',
  'rule_results',
  'decisions',
  'token_snapshots',
  'signals',
  'wallets',
  'events_log',
];

// The engine's GuardState shape (apps/engine/src/paper/guard.ts), with the rules.yaml defaults.
// last_mark is not written by the engine yet; DEMO sets it so the mark/uPnL columns can be seen.
const guardJson = (
  entryAt: number,
  price: number,
  open: boolean,
  ladderDone: boolean,
  now: number,
) =>
  JSON.stringify({
    stop_loss_pct: -30,
    take_profit: [{ at_multiple: 2, sell_pct: 50, done: ladderDone || !open }],
    trailing_stop_pct: 25,
    time_stop_at: entryAt + 24 * 3_600_000,
    rug_liquidity_drop_pct: 50,
    decimals: 6,
    initial_raw: '1000000000',
    remaining_raw: !open ? '0' : ladderDone ? '500000000' : '1000000000',
    peak_price: ladderDone ? price * 2.4 : null,
    last_liquidity_usd: null,
    no_route_polls: 0,
    platform_fee_usd: 0,
    slippage_usd: 0,
    ...(open && { last_mark: price * (ladderDone ? 2.2 : 0.88), last_mark_at: now }),
  });

export const seedDemo = (path: string, now = Date.now()) => {
  const rnd = prng(42);
  const bytes = (n: number) => Array.from({ length: n }, () => Math.floor(rnd() * 256));
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)] as T;
  const weighted = () => {
    let r = rnd() * KILL_WEIGHTS.reduce((a, [, w]) => a + w, 0);
    for (const [k, w] of KILL_WEIGHTS) {
      r -= w;
      if (r < 0) return k;
    }
    return 'R1';
  };

  const db = new Database(path, { fileMustExist: true });
  try {
    db.transaction(() => {
      for (const t of TABLES) db.prepare(`DELETE FROM ${t}`).run();
      // Reset AUTOINCREMENT counters so a re-seed yields the same ids.
      const hasSeq = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").get();
      if (hasSeq) {
        db.prepare(
          `DELETE FROM sqlite_sequence WHERE name IN (${TABLES.map(() => '?').join(',')})`,
        ).run(...TABLES);
      }
      const wallets = Array.from({ length: 15 }, () => b58(bytes(32)));
      const insWallet = db.prepare(
        'INSERT INTO wallets (address, label, source, added_at, active, score) VALUES (?, ?, ?, ?, 1, ?)',
      );
      wallets.forEach((w, i) => {
        insWallet.run(w, `demo-${i + 1}`, 'demo', now - 30 * 86_400_000, Math.round(rnd() * 100));
      });

      const insSignal = db.prepare(
        `INSERT INTO signals (wallet, mint, side, amount_sol, amount_token, tx_sig, block_time,
           detected_at, detect_latency_ms) VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?)`,
      );
      const insSnap = db.prepare(
        `INSERT INTO token_snapshots (signal_id, mint, taken_at, price_usd, liquidity_usd, fdv_usd,
           price_change_45m, top10_pct, dev_pct, bundled_pct, mint_authority_revoked,
           freeze_authority_revoked, lp_locked_pct) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insRule = db.prepare(
        'INSERT INTO rule_results (signal_id, rule_id, passed, value, threshold, reason) VALUES (?, ?, ?, ?, ?, ?)',
      );
      const insDecision = db.prepare(
        'INSERT INTO decisions (signal_id, verdict, killed_by, all_failed_json, decided_at) VALUES (?, ?, ?, ?, ?)',
      );
      const insPos = db.prepare(
        `INSERT INTO positions (signal_id, mode, mint, size_usd, entry_price, entry_at, stop_price,
           tp_plan_json, status, exit_price, exit_at, exit_reason, gross_pnl_usd, fees_usd,
           slippage_bps, net_pnl_usd, net_pnl_pct)
         VALUES (?, 'DEMO', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insFill = db.prepare(
        'INSERT INTO fills (position_id, side, qty, price, fee_usd, tx_sig, simulated, at) VALUES (?, ?, ?, ?, ?, NULL, 1, ?)',
      );
      const insEvent = db.prepare(
        'INSERT INTO events_log (at, level, stage, message, data_json) VALUES (?, ?, ?, ?, ?)',
      );

      let passedCount = 0;
      for (let i = 0; i < 300; i++) {
        const at = now - Math.floor(rnd() * 7 * 86_400_000);
        const mint = b58(bytes(32));
        const sid = Number(
          insSignal.run(
            pick(wallets),
            mint,
            +(rnd() * 5).toFixed(3),
            Math.floor(rnd() * 1e7),
            b58(bytes(64)),
            Math.floor(at / 1000) - 2,
            at,
            300 + Math.floor(rnd() * 2500),
          ).lastInsertRowid,
        );
        const r = rnd();
        if (r < 0.15) {
          insDecision.run(sid, 'SKIPPED', null, null, at + 50);
          continue;
        }
        const price = rnd() * 0.01;
        insSnap.run(
          sid,
          mint,
          at + 100,
          price,
          5e3 + rnd() * 2e5,
          1e5 + rnd() * 5e6,
          rnd() * 150 - 20,
          15 + rnd() * 50,
          rnd() * 15,
          rnd() * 30,
          rnd() > 0.2 ? 1 : 0,
          rnd() > 0.2 ? 1 : 0,
          50 + rnd() * 50,
        );
        const killedBy = r < 0.9 ? weighted() : null;
        for (const rule of RULES) {
          const failed = killedBy === rule || (killedBy === 'data_unavailable' && rule === 'R1');
          insRule.run(
            sid,
            rule,
            failed ? 0 : 1,
            null,
            null,
            failed
              ? killedBy === 'data_unavailable'
                ? 'data_unavailable'
                : `${rule} failed`
              : null,
          );
        }
        insDecision.run(
          sid,
          killedBy ? 'KILLED' : 'PASSED',
          killedBy,
          killedBy ? JSON.stringify([killedBy]) : null,
          at + 400,
        );
        if (killedBy) continue;

        // Every 7th pass is vetoed by the analyst; the rest are copied.
        passedCount++;
        const vetoed = passedCount % 7 === 0;
        db.prepare(
          `INSERT INTO analyst_reviews (signal_id, provider, model, verdict, confidence, rationale,
             latency_ms, cost_usd, used_for_decision) VALUES (?, 'demo', 'demo-model', ?, ?, ?, ?, ?, 1)`,
        ).run(
          sid,
          vetoed ? 'veto' : 'ok',
          rnd(),
          vetoed ? 'dev wallet cluster' : 'no red flags',
          800 + Math.floor(rnd() * 2000),
          0.002,
        );
        if (vetoed) continue;

        const size = 50;
        // Two open positions: a fresh one, and one past its TP ladder with the trailing stop armed.
        const open = passedCount === 1 || passedCount === 3;
        const entryAt = open ? now - passedCount * 3_600_000 : at + 2000;
        // Mostly small losers, a few runners, one rug.
        const outcome =
          passedCount === 2 ? -0.95 : rnd() < 0.2 ? 1 + rnd() * 3 : -0.1 - rnd() * 0.25;
        const exit = price * (1 + outcome);
        const fees = 0.6;
        const gross = size * outcome;
        const pid = Number(
          insPos.run(
            sid,
            mint,
            size,
            price,
            entryAt,
            price * 0.7,
            guardJson(entryAt, price, open, passedCount === 3, now),
            open ? 'open' : 'closed',
            open ? null : exit,
            open ? null : at + 3_600_000,
            open ? null : outcome <= -0.9 ? 'rug' : outcome > 0 ? 'take_profit' : 'stop_loss',
            open ? null : gross,
            open ? null : fees,
            80,
            open ? null : gross - fees,
            open ? null : ((gross - fees) / size) * 100,
          ).lastInsertRowid,
        );
        insFill.run(pid, 'buy', size / price, price, fees / 2, entryAt);
        if (!open) insFill.run(pid, 'sell', size / price, exit, fees / 2, at + 3_600_000);
      }

      // Realistic event shapes (same stage/message/data as the engine writes), newest last.
      const EVENTS: [string, string, string, () => Record<string, unknown>][] = [
        ['info', 'rules', 'KILLED', () => ({ mint: b58(bytes(32)), killed_by: weighted() })],
        ['info', 'rules', 'SKIPPED', () => ({ mint: b58(bytes(32)), killed_by: 'repeat_buy' })],
        ['info', 'paper', 'skipped', () => ({ mint: b58(bytes(32)), reason: 'position_open' })],
        ['warn', 'scout', 'ws_closed', () => ({ code: 1006 })],
        ['info', 'scout', 'reconnecting', () => ({ attempt: 1, delay_ms: 1000 })],
        ['warn', 'scout', 'liveness_timeout', () => ({ silent_ms: 181_000 })],
      ];
      for (let i = 0; i < 50; i++) {
        const [level, stage, message, data] = pick(EVENTS);
        const at = now - 3_600_000 + i * 60_000;
        insEvent.run(at, level, stage, message, JSON.stringify(data()));
      }
      insEvent.run(
        now - 30_000,
        'info',
        'scout',
        'subscriptions_acked',
        JSON.stringify({ count: 15 }),
      );
      insEvent.run(
        now,
        'info',
        'scout',
        'heartbeat',
        JSON.stringify({ last_notification_age_s: 4 }),
      );
    })();
  } finally {
    db.close();
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    if (existsSync('.env')) process.loadEnvFile('.env');
    const target = demoTarget(resolve(parseEnv().DATA_DIR));
    seedDemo(target);
    console.log(`seeded ${target}`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
