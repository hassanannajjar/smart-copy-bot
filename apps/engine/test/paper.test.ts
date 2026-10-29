import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Config,
  decisions,
  eventsLog,
  fills,
  loadConfig,
  migrateAll,
  openTradingDb,
  positions,
  signals,
  type TradingDb,
  tokenSnapshots,
} from '@scb/shared';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { startPaper } from '../src/paper/executor.js';
import type { GuardState } from '../src/paper/guard.js';
import { startRules } from '../src/rules/stage.js';
import {
  fakeFees,
  fakeJupiter,
  fakeProviders,
  MINTS,
  recorded,
  rugcheckRaw,
  WSOL,
} from './fakes.js';

const base = loadConfig(new URL('../../../config/rules.yaml', import.meta.url).pathname);
const H = 3_600_000;
const MINT = MINTS.curve;
const MID = 1e-5;

const setup = (o: { config?: Config; db?: TradingDb; t0?: number } = {}) => {
  const config = o.config ?? base;
  let db = o.db;
  if (!db) {
    const dir = mkdtempSync(join(tmpdir(), 'scb-paper-'));
    migrateAll(dir);
    db = openTradingDb(join(dir, 'paper.db'));
  }
  const c = { t: o.t0 ?? 1_800_000_000_000 };
  const now = () => c.t;
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    c.t += ms;
  };
  const { jupiter, m } = fakeJupiter();
  m.now = now;
  m.mid.set(MINT, MID);
  m.liq.set(MINT, 20_000);
  const { fees, f } = fakeFees();
  const ks = { on: false, throws: false };
  const lines: string[] = [];
  const log = pino({ level: 'debug' }, { write: (l: string) => lines.push(l) });
  const killSwitch = () => {
    if (ks.throws) throw new Error('SQLITE_BUSY');
    return ks.on;
  };
  const paper = startPaper({ db, config, jupiter, fees, killSwitch, log, now, sleep });
  const tdb = db;
  let n = 0;
  const passed = (p: { mint?: string; ageMs?: number; rugcheck?: boolean } = {}) => {
    const mint = p.mint ?? MINT;
    const at = new Date(c.t - (p.ageMs ?? 500));
    const id = tdb
      .insert(signals)
      .values({
        wallet: 'W1',
        mint,
        side: 'buy',
        amountSol: 1,
        txSig: `s${n++}-${c.t}`,
        detectedAt: at,
        blockTime: at,
      })
      .returning({ id: signals.id })
      .get().id;
    tdb
      .insert(tokenSnapshots)
      .values({
        signalId: id,
        mint,
        takenAt: new Date(c.t),
        priceUsd: m.mid.get(mint) ?? null,
        rawJson: JSON.stringify({
          providers: p.rugcheck === false ? {} : { rugcheck: rugcheckRaw(MINT) },
        }),
      })
      .run();
    tdb
      .insert(decisions)
      .values({ signalId: id, verdict: 'PASSED', decidedAt: new Date(c.t) })
      .run();
    return id;
  };
  const enter = async (id: number) => {
    paper.submit(id);
    await paper.idle();
  };
  const tick = async () => {
    paper.tick();
    await paper.idle();
  };
  const pos = () => tdb.select().from(positions).all();
  const fillsOf = (id: number) => tdb.select().from(fills).where(eq(fills.positionId, id)).all();
  const events = () =>
    tdb
      .select()
      .from(eventsLog)
      .where(eq(eventsLog.stage, 'paper'))
      .all()
      .map((e) => ({ message: e.message, ...JSON.parse(e.dataJson ?? '{}') }));
  const guard = (id: number): GuardState =>
    JSON.parse(tdb.select().from(positions).where(eq(positions.id, id)).get()?.tpPlanJson ?? '{}');
  return {
    db: tdb,
    c,
    m,
    f,
    ks,
    paper,
    passed,
    enter,
    tick,
    pos,
    fillsOf,
    events,
    guard,
    sleeps,
    lines,
  };
};

const opened = async (t: ReturnType<typeof setup>, mint = MINT) => {
  await t.enter(t.passed({ mint }));
  const p = t.pos().find((x) => x.mint === mint && x.status === 'open');
  if (!p) throw new Error('no position');
  return p;
};

describe('paper executor: entry', () => {
  it('fills at a fresh Jupiter quote for our size after the latency, with Helius fees', async () => {
    const t = setup();
    const id = t.passed({ ageMs: 500 }); // detected 500ms ago; latency is 1500ms
    const detectedAt = t.c.t - 500;
    await t.enter(id);
    const [p] = t.pos();
    const sol = t.m.solUsd;
    // Never earlier than detection + simulated latency.
    expect(t.sleeps[0]).toBe(1000);
    expect(t.m.quotes[0]).toMatchObject({ in: WSOL, out: MINT, at: detectedAt + 1500 });
    expect(Number(t.m.quotes[0]?.amount)).toBeCloseTo((50 / sol) * 1e9, -1);
    expect(p).toMatchObject({ mode: 'paper', mint: MINT, status: 'open', signalId: id });
    expect(p?.sizeUsd).toBeCloseTo(50, 4);
    // Our fill is worse than the mid: impact + platform fee (not the wallet's price).
    expect(p?.entryPrice).toBeGreaterThan(MID * 1.02);
    expect(p?.stopPrice).toBeCloseTo((p?.entryPrice ?? 0) * 0.7);
    const [buy] = t.fillsOf(p?.id ?? 0);
    expect(buy).toMatchObject({ side: 'buy', simulated: true, txSig: null });
    // base 0.000005 + 120k micro-lamports/CU x 300k CU = 0.000036 SOL; platform 10 bps of $50.
    expect(buy?.feeUsd).toBeCloseTo((0.000005 + 0.000036) * sol + 0.05, 6);
    expect(t.f.calls).toBe(1);
    const ev = t.events().find((e) => e.message === 'opened');
    expect(ev).toMatchObject({ signal_id: id, priority_fee_source: 'helius', fee_bps: 10 });
    expect(ev?.latency_ms).toBe(1500);
    expect(t.guard(p?.id ?? 0).slippage_usd).toBeGreaterThan(0);
    // signal_id on every pipeline log line
    expect(t.lines.map((l) => JSON.parse(l)).every((l) => l.signal_id === id)).toBe(true);
  });

  it('falls back to the static priority fee when Helius fails', async () => {
    const t = setup();
    t.f.fail = true;
    const p = await opened(t);
    expect(t.fillsOf(p.id)[0]?.feeUsd).toBeCloseTo((0.000005 + 0.001) * t.m.solUsd + 0.05, 6);
    expect(t.events().find((e) => e.message === 'opened')?.priority_fee_source).toBe('static');
  });

  it('kill switch blocks new positions (and fails closed when unreadable)', async () => {
    const t = setup();
    t.ks.on = true;
    await t.enter(t.passed());
    t.ks.on = false;
    t.ks.throws = true;
    await t.enter(t.passed());
    expect(t.pos()).toHaveLength(0);
    expect(t.events().map((e) => e.reason)).toEqual(['kill_switch', 'kill_switch']);
    expect(t.m.quotes).toHaveLength(0);
  });

  it('one open position per mint, then mint_cooldown_h after the last entry', async () => {
    const t = setup();
    const p = await opened(t);
    await t.enter(t.passed());
    expect(t.events().at(-1)).toMatchObject({ message: 'skipped', reason: 'position_open' });
    t.m.mid.set(MINT, MID * 0.5);
    await t.tick(); // stop_loss closes it
    expect(t.pos()[0]?.status).toBe('closed');
    await t.enter(t.passed());
    expect(t.events().at(-1)).toMatchObject({ reason: 'mint_cooldown' });
    t.c.t = p.entryAt.getTime() + 6 * H + 1;
    t.m.mid.set(MINT, MID);
    await t.enter(t.passed());
    expect(t.pos().filter((x) => x.status === 'open')).toHaveLength(1);
  });

  it('skips stale signals and missing data; errors never open a position', async () => {
    const t = setup();
    await t.enter(t.passed({ ageMs: 61_000 }));
    await t.enter(t.passed({ rugcheck: false }));
    t.m.noRoute.add(MINT);
    await t.enter(t.passed());
    t.m.noRoute.clear();
    t.m.failQuotes = true;
    await t.enter(t.passed());
    t.m.failQuotes = false;
    t.m.failPrices = true;
    await t.enter(t.passed());
    expect(t.pos()).toHaveLength(0);
    expect(t.db.select().from(fills).all()).toHaveLength(0);
    expect(t.events().map((e) => e.reason ?? e.message)).toEqual([
      'stale',
      'data_unavailable',
      'no_route',
      'entry_failed',
      'entry_failed',
    ]);
  });
});

describe('paper position manager: exits', () => {
  it('stop_loss exits at a fresh quote for our size, below the stop on a gap, with full PnL', async () => {
    const t = setup();
    const p = await opened(t);
    t.m.mid.set(MINT, MID * 0.4); // gaps straight through -30%
    t.m.quotes.length = 0;
    const before = t.c.t;
    await t.tick();
    const closed = t.pos()[0];
    expect(closed).toMatchObject({ status: 'closed', exitReason: 'stop_loss' });
    // Quoted after the latency, for exactly what we hold, and filled well below the stop price.
    expect(t.m.quotes[0]).toMatchObject({ in: MINT, out: WSOL, at: before + 1500 });
    expect(t.m.quotes[0]?.amount).toBe(BigInt(t.guard(p.id).initial_raw));
    expect(closed?.exitPrice).toBeLessThan(p.stopPrice * 0.6);
    const fs = t.fillsOf(p.id);
    expect(fs.map((f) => f.side)).toEqual(['buy', 'sell']);
    const fees = fs.reduce((s, f) => s + f.feeUsd, 0);
    const proceeds = (fs[1]?.qty ?? 0) * (fs[1]?.price ?? 0);
    expect(closed?.feesUsd).toBeCloseTo(fees);
    expect(closed?.netPnlUsd).toBeCloseTo((closed?.grossPnlUsd ?? 0) - fees);
    expect(closed?.netPnlUsd).toBeCloseTo(
      proceeds - p.sizeUsd - (fees - t.guard(p.id).platform_fee_usd),
    );
    expect(closed?.netPnlPct).toBeCloseTo(((closed?.netPnlUsd ?? 0) / p.sizeUsd) * 100);
    expect(closed?.netPnlPct).toBeLessThan(-60);
    expect(closed?.slippageBps).toBeGreaterThan(0);
    expect(t.guard(p.id).remaining_raw).toBe('0');
    expect(t.events().filter((e) => e.message === 'closed')).toHaveLength(1);
  });

  it('take_profit sells half at 2x, then the trailing stop closes the rest', async () => {
    const t = setup();
    const p = await opened(t);
    const entry = p.entryPrice;
    t.m.mid.set(MINT, entry * 2.1);
    await t.tick();
    expect(t.pos()[0]?.status).toBe('open');
    const g = t.guard(p.id);
    expect(g.take_profit[0]?.done).toBe(true);
    expect(BigInt(g.remaining_raw)).toBe(BigInt(g.initial_raw) - BigInt(g.initial_raw) / 2n);
    expect(g.peak_price).toBeCloseTo(entry * 2.1);
    t.m.mid.set(MINT, entry * 3);
    await t.tick();
    expect(t.guard(p.id).peak_price).toBeCloseTo(entry * 3);
    t.m.mid.set(MINT, entry * 2.3); // 3x * 0.75 = 2.25x: still above
    await t.tick();
    expect(t.pos()[0]?.status).toBe('open');
    t.m.mid.set(MINT, entry * 2.2);
    await t.tick();
    const closed = t.pos()[0];
    expect(closed).toMatchObject({ status: 'closed', exitReason: 'trailing_stop' });
    expect(t.fillsOf(p.id).map((f) => f.side)).toEqual(['buy', 'sell', 'sell']);
    expect(closed?.netPnlUsd).toBeGreaterThan(40);
    expect(
      t
        .events()
        .filter((e) => e.message === 'exit')
        .map((e) => [e.reason, e.partial]),
    ).toEqual([
      ['take_profit', true],
      ['trailing_stop', false],
    ]);
  });

  it('time_stop closes after time_stop_h', async () => {
    const t = setup();
    await opened(t);
    t.c.t += 24 * H;
    await t.tick();
    expect(t.pos()[0]).toMatchObject({ status: 'closed', exitReason: 'time_stop' });
  });

  it('rug: liquidity drop between polls exits at the quoted price', async () => {
    const t = setup();
    await opened(t);
    t.m.liq.set(MINT, 9_000); // 20k -> 9k = -55%
    t.m.mid.set(MINT, MID * 0.05);
    await t.tick();
    const closed = t.pos()[0];
    expect(closed).toMatchObject({ status: 'closed', exitReason: 'rug' });
    expect(closed?.netPnlPct).toBeLessThan(-90);
  });

  it('no route: retried, then booked at zero after no_route_max_polls', async () => {
    const t = setup();
    const p = await opened(t);
    t.m.omit.add(MINT); // gone from Price V3...
    t.m.noRoute.add(MINT); // ...and unsellable
    await t.tick();
    await t.tick();
    expect(t.pos()[0]?.status).toBe('open');
    expect(t.guard(p.id).no_route_polls).toBe(2);
    await t.tick();
    const closed = t.pos()[0];
    expect(closed).toMatchObject({ status: 'closed', exitReason: 'no_route', exitPrice: 0 });
    expect(closed?.netPnlPct).toBeLessThan(-100); // -100% plus the entry fees
  });

  it('marks from a sell quote when Price V3 omits the mint', async () => {
    const t = setup();
    await opened(t);
    t.m.omit.add(MINT);
    await t.tick();
    expect(t.pos()[0]?.status).toBe('open'); // quote mark ~ entry: hold
    t.m.mid.set(MINT, MID * 0.5);
    await t.tick();
    expect(t.pos()[0]).toMatchObject({ status: 'closed', exitReason: 'stop_loss' });
  });

  it('no exit on missing data; a failed exit quote is retried next poll', async () => {
    const t = setup();
    await opened(t);
    t.m.mid.set(MINT, MID * 0.5);
    t.m.failPrices = true;
    await t.tick();
    expect(t.pos()[0]?.status).toBe('open');
    t.m.failPrices = false;
    t.m.failQuotes = true;
    await t.tick();
    expect(t.pos()[0]?.status).toBe('open');
    t.m.failQuotes = false;
    await t.tick();
    expect(t.pos()[0]).toMatchObject({ status: 'closed', exitReason: 'stop_loss' });
  });

  it('kill switch on: open positions keep being managed', async () => {
    const t = setup();
    await opened(t);
    t.ks.on = true;
    t.m.mid.set(MINT, MID * 0.5);
    await t.tick();
    expect(t.pos()[0]).toMatchObject({ status: 'closed', exitReason: 'stop_loss' });
  });

  it('batches Price V3 calls (wSOL in each) and resumes open positions after a restart', async () => {
    const config = { ...base, executor: { ...base.executor, price_batch_size: 2 } };
    const t = setup({ config });
    for (const mint of [MINTS.curve, MINTS.migrated, MINTS.insiders]) {
      t.m.mid.set(mint, MID);
      await opened(t, mint);
    }
    t.m.priceCalls.length = 0;
    await t.tick();
    expect(t.m.priceCalls.map((c) => c.length)).toEqual([3, 2]);
    expect(t.m.priceCalls.every((c) => c.at(-1) === WSOL)).toBe(true);

    // "Restart": a fresh executor on the same DB picks the open positions up.
    t.paper.stop();
    const r = setup({ config, db: t.db, t0: t.c.t + H });
    for (const mint of [MINTS.curve, MINTS.migrated, MINTS.insiders]) r.m.mid.set(mint, MID);
    expect(r.paper.start()).toBe(3);
    expect(r.events().at(-1)).toMatchObject({ message: 'resumed', open_positions: 3 });
    r.m.mid.set(MINTS.migrated, MID * 0.5);
    await r.tick();
    r.paper.stop();
    const byMint = Object.fromEntries(r.pos().map((p) => [p.mint, p.status]));
    expect(byMint).toEqual({
      [MINTS.curve]: 'open',
      [MINTS.migrated]: 'closed',
      [MINTS.insiders]: 'open',
    });
  });
});

describe('PAPER only (pre-M7)', () => {
  it('no source file imports a signer or can send a transaction', () => {
    const roots = [
      '../../engine/src',
      '../../dashboard/app',
      '../../dashboard/lib',
      '../../../packages/shared/src',
    ];
    const banned =
      /@solana\/web3\.js|@solana\/kit|Keypair|secretKey|signTransaction|sendTransaction|sendRawTransaction|\/execute\b|taker[:=]/;
    let files = 0;
    for (const r of roots) {
      const dir = new URL(`${r}/`, import.meta.url);
      for (const f of readdirSync(dir, { recursive: true }) as string[]) {
        if (!/\.(ts|tsx)$/.test(f)) continue;
        files++;
        expect(readFileSync(new URL(f, dir), 'utf8'), f).not.toMatch(banned);
      }
    }
    expect(files).toBeGreaterThan(20);
  });
});

describe('pipeline', () => {
  it('signal -> rules PASSED -> paper position -> stop_loss exit, all in the DB', async () => {
    const T = recorded(MINTS.migrated).takenAt;
    const t = setup({ t0: T });
    t.m.mid.set(MINTS.migrated, MID);
    t.m.liq.set(MINTS.migrated, 20_000);
    const loose = { ...base, rules: { ...base.rules, R5_max_price_change_45m_pct: 1000 } };
    const rules = startRules({
      db: t.db,
      config: loose,
      providers: fakeProviders().providers,
      log: pino({ level: 'silent' }),
      now: () => t.c.t,
      onPassed: (id) => t.paper.submit(id),
    });
    const id = t.db
      .insert(signals)
      .values({
        wallet: 'W1',
        mint: MINTS.migrated,
        side: 'buy',
        amountSol: 1,
        txSig: 'pipe1',
        detectedAt: new Date(T - 2000),
      })
      .returning({ id: signals.id })
      .get().id;
    rules.submit(id);
    await rules.idle();
    await t.paper.idle();
    expect(t.db.select().from(decisions).where(eq(decisions.signalId, id)).get()?.verdict).toBe(
      'PASSED',
    );
    const [p] = t.pos();
    expect(p).toMatchObject({ signalId: id, mint: MINTS.migrated, status: 'open' });

    t.m.mid.set(MINTS.migrated, MID * 0.6);
    await t.tick();
    expect(t.pos()[0]).toMatchObject({ status: 'closed', exitReason: 'stop_loss' });
    expect(t.pos()[0]?.netPnlUsd).toBeLessThan(0);
    expect(t.events().map((e) => e.message)).toEqual(['opened', 'exit', 'closed']);
    expect(t.events().every((e) => e.signal_id === id)).toBe(true);
  });
});
