import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decisions,
  eventsLog,
  loadConfig,
  migrateAll,
  openTradingDb,
  ruleResults,
  signals,
  tokenSnapshots,
} from '@scb/shared';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { startRules } from '../src/rules/stage.js';
import { fakeProviders, MINTS, recorded, WSOL } from './fakes.js';

const base = loadConfig(new URL('../../../config/rules.yaml', import.meta.url).pathname);
const T = recorded(MINTS.migrated).takenAt; // "now" = when the fixtures were recorded

const setup = (fail: string[] = [], config = base) => {
  const dir = mkdtempSync(join(tmpdir(), 'scb-rules-'));
  migrateAll(dir);
  const db = openTradingDb(join(dir, 'paper.db'));
  const lines: string[] = [];
  const log = pino({ level: 'debug' }, { write: (l: string) => lines.push(l) });
  const { providers, calls } = fakeProviders(fail);
  const rules = startRules({ db, config, providers, log, now: () => T });
  let n = 0;
  const signal = (o: Partial<typeof signals.$inferInsert> = {}) =>
    db
      .insert(signals)
      .values({
        wallet: 'W1',
        mint: MINTS.migrated,
        side: 'buy',
        amountSol: 1,
        txSig: `sig${n++}`,
        detectedAt: new Date(T - 2000),
        ...o,
      })
      .returning({ id: signals.id })
      .get().id;
  const decision = (id: number) =>
    db.select().from(decisions).where(eq(decisions.signalId, id)).get();
  const results = (id: number) =>
    db.select().from(ruleResults).where(eq(ruleResults.signalId, id)).all();
  const snapshot = (id: number) =>
    db.select().from(tokenSnapshots).where(eq(tokenSnapshots.signalId, id)).get();
  return { db, rules, signal, decision, results, snapshot, calls, lines };
};

describe('rules stage', () => {
  it('boot: decides every pending signal; snapshot, 6 rule_results, decision, events_log', async () => {
    const t = setup();
    const killed = t.signal(); // R5 fails on the migrated fixture
    const curve = t.signal({ mint: MINTS.curve });
    const sell = t.signal({ side: 'sell' });
    const sol = t.signal({ mint: WSOL });
    const dust = t.signal({ amountSol: 0.01 });
    expect(t.rules.submitPending()).toBe(5);
    await t.rules.idle();

    expect(t.decision(killed)).toMatchObject({ verdict: 'KILLED', killedBy: 'R5' });
    expect(JSON.parse(t.decision(killed)?.allFailedJson ?? '[]')).toEqual(['R5']);
    expect(t.results(killed).map((r) => r.ruleId)).toEqual(base.rules.order);
    const snap = t.snapshot(killed);
    expect(snap).toMatchObject({ mint: MINTS.migrated, mintAuthorityRevoked: true });
    expect(snap?.priceChange45m).toBeGreaterThan(80);
    expect(JSON.parse(snap?.rawJson ?? '{}').providers.dexscreener).toBeDefined();

    expect(t.decision(curve)).toMatchObject({ verdict: 'KILLED', killedBy: 'R1' });
    // R5 is deferred: killed by R1/R4 first, so GeckoTerminal is never called for it.
    expect(t.results(curve).find((r) => r.ruleId === 'R5')).toMatchObject({
      passed: false,
      value: null,
      reason: 'not_evaluated',
    });
    expect(JSON.parse(t.decision(curve)?.allFailedJson ?? '[]')).toEqual(['R1', 'R4']);
    expect(t.calls.filter((c) => c === 'geckoterminal')).toHaveLength(1); // only `killed`
    expect(t.decision(sell)).toMatchObject({ verdict: 'SKIPPED', killedBy: 'sell' });
    expect(t.decision(sol)).toMatchObject({ verdict: 'SKIPPED', killedBy: 'ignored_mint' });
    expect(t.decision(dust)).toMatchObject({ verdict: 'SKIPPED', killedBy: 'below_min_buy' });
    expect(t.results(sell)).toHaveLength(0);
    expect(t.snapshot(sell)).toBeUndefined();

    const events = t.db.select().from(eventsLog).where(eq(eventsLog.stage, 'rules')).all();
    expect(events).toHaveLength(5);
    // signal_id on every pipeline log line
    const logged = t.lines.map((l) => JSON.parse(l)).filter((l) => l.msg === 'decision');
    expect(logged.map((l) => l.signal_id).sort()).toEqual([killed, curve, sell, sol, dust].sort());
  });

  it('PASSES a signal that clears all six rules, and never decides twice', async () => {
    const loose = { ...base, rules: { ...base.rules, R5_max_price_change_45m_pct: 1000 } };
    const t = setup([], loose);
    const id = t.signal();
    t.rules.submit(id);
    t.rules.submit(id); // queued twice: decided once
    await t.rules.idle();
    t.rules.submit(id); // already decided
    await t.rules.idle();
    expect(t.decision(id)).toMatchObject({
      verdict: 'PASSED',
      killedBy: null,
      allFailedJson: null,
    });
    expect(t.results(id)).toHaveLength(6);
    expect(t.results(id).every((r) => r.passed)).toBe(true);
    expect(t.calls.filter((c) => c === 'dexscreener')).toHaveLength(1);
    expect(t.calls.filter((c) => c === 'geckoterminal')).toHaveLength(1);
  });

  it('a provider error => KILLED data_unavailable, never PASSED', async () => {
    const loose = { ...base, rules: { ...base.rules, R5_max_price_change_45m_pct: 1000 } };
    const t = setup(['rugcheck'], loose);
    const id = t.signal();
    t.rules.submit(id);
    await t.rules.idle();
    expect(t.decision(id)).toMatchObject({ verdict: 'KILLED', killedBy: 'data_unavailable' });
    const byRule = Object.fromEntries(t.results(id).map((r) => [r.ruleId, r]));
    expect(byRule.R1?.passed).toBe(true);
    for (const r of ['R2', 'R3', 'R4', 'R6'])
      expect(byRule[r]).toMatchObject({ passed: false, reason: 'data_unavailable' });
    expect(JSON.parse(t.snapshot(id)?.rawJson ?? '{}').derived.errors.rugcheck).toMatch(/503/);
    expect(byRule.R5).toMatchObject({ reason: 'not_evaluated' });
    expect(t.calls).not.toContain('geckoterminal');
  });

  it('GeckoTerminal down on a signal that passed R1-R4/R6 => KILLED data_unavailable (R5)', async () => {
    const t = setup(['geckoterminal']);
    const id = t.signal();
    t.rules.submit(id);
    await t.rules.idle();
    expect(t.decision(id)).toMatchObject({ verdict: 'KILLED', killedBy: 'data_unavailable' });
    expect(t.results(id).find((r) => r.ruleId === 'R5')).toMatchObject({
      reason: 'data_unavailable',
    });
  });

  it('DexScreener down: no other provider is called, signal KILLED data_unavailable', async () => {
    const t = setup(['dexscreener']);
    const id = t.signal();
    t.rules.submit(id);
    await t.rules.idle();
    expect(t.decision(id)).toMatchObject({ verdict: 'KILLED', killedBy: 'data_unavailable' });
    expect(t.calls).toEqual(['dexscreener']);
  });

  it('an old signal (boot backlog) is KILLED stale without spending provider calls', async () => {
    const t = setup();
    const id = t.signal({ detectedAt: new Date(T - 3_600_000) });
    t.rules.submitPending();
    await t.rules.idle();
    expect(t.decision(id)).toMatchObject({ verdict: 'KILLED', killedBy: 'data_unavailable' });
    expect(t.results(id)[0]).toMatchObject({ ruleId: 'DATA', reason: 'stale' });
    expect(t.results(id)).toHaveLength(7);
    expect(t.calls).toEqual([]);
  });

  it('a backfilled signal (fresh detected_at, old block_time) is stale too', async () => {
    const t = setup();
    const id = t.signal({ blockTime: new Date(T - 3_600_000) });
    t.rules.submit(id);
    await t.rules.idle();
    expect(t.decision(id)).toMatchObject({ verdict: 'KILLED', killedBy: 'data_unavailable' });
    expect(t.calls).toEqual([]);
  });

  it('token outside the age window => SKIPPED token_age, with its snapshot', async () => {
    const young = { ...base, prefilters: { ...base.prefilters, token_age_max_h: 1 } };
    const t = setup([], young);
    const id = t.signal();
    t.rules.submit(id);
    await t.rules.idle();
    expect(t.decision(id)).toMatchObject({ verdict: 'SKIPPED', killedBy: 'token_age' });
    expect(t.snapshot(id)?.pairAddress).toBeTruthy();
    expect(t.calls).toEqual(['dexscreener']);
  });

  it('a DB error leaves the signal undecided and the queue keeps going', async () => {
    const t = setup();
    const a = t.signal();
    const b = t.signal({ side: 'sell' });
    t.rules.submit(a);
    t.db.$client.exec('DROP TABLE token_snapshots'); // the first write now throws
    t.rules.submit(b);
    await t.rules.idle();
    expect(t.decision(a)).toBeUndefined();
    expect(t.decision(b)).toMatchObject({ verdict: 'SKIPPED' });
  });

  it('stop(): queued signals are left for the next boot', async () => {
    const t = setup();
    const id = t.signal();
    t.rules.stop();
    t.rules.submit(id);
    await t.rules.idle();
    expect(t.decision(id)).toBeUndefined();
  });
});
