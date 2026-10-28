// Rules stage: signal -> pre-filters -> enrich -> 6 rules -> token_snapshots, rule_results,
// decisions, events_log (stage=rules). One signal at a time; every write for a signal is one
// transaction, and decisions.signal_id is the PK, so a signal is decided exactly once.
import {
  type Config,
  decisions,
  eventsLog,
  ruleResults,
  signals,
  type TradingDb,
  tokenSnapshots,
} from '@scb/shared';
import { asc, eq, isNull } from 'drizzle-orm';
import type { Logger } from 'pino';
import {
  buildSnapshot,
  type Fetched,
  fetchCandles,
  fetchForMint,
  type Providers,
} from './enrich.js';
import {
  type Evaluation,
  evaluate,
  outsideAgeWindow,
  prefilter,
  type SkipReason,
  type Snapshot,
} from './rules.js';

export interface RulesDeps {
  db: TradingDb;
  config: Config;
  providers: Providers;
  log: Logger;
  now?: () => number;
}

type Signal = typeof signals.$inferSelect;

export const startRules = (d: RulesDeps) => {
  const now = d.now ?? Date.now;
  const queued = new Set<number>();
  let stopped = false;
  let chain: Promise<unknown> = Promise.resolve();

  const event = (message: string, data: Record<string, unknown>, level = 'info') =>
    d.db
      .insert(eventsLog)
      .values({
        at: new Date(now()),
        level,
        stage: 'rules',
        message,
        dataJson: JSON.stringify(data),
      })
      .run();

  const write = (
    sig: Signal,
    snap: { s: Snapshot; raw: Record<string, unknown> } | null,
    outcome: { verdict: 'SKIPPED'; skip: SkipReason } | Evaluation,
  ) => {
    const verdict = outcome.verdict;
    // SKIPPED rows carry the pre-filter reason in killed_by; dashboard kill charts read KILLED only.
    const killedBy = 'skip' in outcome ? outcome.skip : outcome.killedBy;
    const failed = 'skip' in outcome ? null : outcome.failed;
    d.db.transaction((tx) => {
      if (snap) {
        const { s, raw } = snap;
        tx.insert(tokenSnapshots)
          .values({
            signalId: sig.id,
            mint: sig.mint,
            takenAt: new Date(s.takenAt),
            priceUsd: s.priceUsd,
            liquidityUsd: s.liquidityUsd,
            fdvUsd: s.fdvUsd,
            pairAddress: s.pairAddress,
            pairCreatedAt: s.pairCreatedAt === null ? null : new Date(s.pairCreatedAt),
            priceChange5m: s.priceChange5m,
            priceChange45m: s.priceChange45m,
            top10Pct: s.top10Pct,
            devPct: s.devPct,
            bundledPct: s.bundledPct,
            mintAuthorityRevoked: s.mintAuthorityRevoked,
            freezeAuthorityRevoked: s.freezeAuthorityRevoked,
            lpLockedPct: s.lpLockedPct,
            rawJson: JSON.stringify({ derived: s, providers: raw }),
          })
          .run();
      }
      if (!('skip' in outcome))
        for (const r of outcome.results)
          tx.insert(ruleResults)
            .values({ signalId: sig.id, ...r })
            .run();
      tx.insert(decisions)
        .values({
          signalId: sig.id,
          verdict,
          killedBy,
          allFailedJson: failed?.length ? JSON.stringify(failed) : null,
          decidedAt: new Date(now()),
        })
        .onConflictDoNothing({ target: decisions.signalId })
        .run();
      tx.insert(eventsLog)
        .values({
          at: new Date(now()),
          level: 'info',
          stage: 'rules',
          message: verdict,
          dataJson: JSON.stringify({
            signal_id: sig.id,
            mint: sig.mint,
            killed_by: killedBy,
            failed,
          }),
        })
        .run();
    });
  };

  const decide = async (id: number) => {
    const log = d.log.child({ signal_id: id });
    const sig = d.db.select().from(signals).where(eq(signals.id, id)).get();
    if (!sig) return log.warn('signal not found');
    if (d.db.select().from(decisions).where(eq(decisions.signalId, id)).get())
      return log.debug('already decided');

    const skip = prefilter(sig, d.config.prefilters);
    if (skip) {
      write(sig, null, { verdict: 'SKIPPED', skip });
      return log.info({ verdict: 'SKIPPED', reason: skip }, 'decision');
    }

    // The moment the wallet traded. Backfilled signals get detected_at = fetch time, so block_time
    // (when known) is what keeps an hours-old buy from looking fresh.
    const detectedAt = Math.min(sig.blockTime?.getTime() ?? Infinity, sig.detectedAt.getTime());
    const maxAgeMs = d.config.data.max_snapshot_age_s * 1000;
    // Already too old to be fresh (boot backlog, backfill): don't spend provider budget on it.
    const tooOld = now() - detectedAt > maxAgeMs;
    let fetched: { f: Fetched; raw: Record<string, unknown> } = { f: { errors: {} }, raw: {} };
    let ageSkip = false;
    if (!tooOld) {
      fetched = await fetchForMint(sig.mint, d.providers, d.config, (pairCreatedAt) => {
        ageSkip = outsideAgeWindow(pairCreatedAt, detectedAt, d.config.prefilters);
        return !ageSkip;
      });
    }
    let s = buildSnapshot(sig.mint, fetched.f, now(), d.config);

    if (ageSkip) {
      write(sig, { s, raw: fetched.raw }, { verdict: 'SKIPPED', skip: 'token_age' });
      return log.info({ verdict: 'SKIPPED', reason: 'token_age' }, 'decision');
    }
    const maxAgeS = d.config.data.max_snapshot_age_s;
    // R5 needs GeckoTerminal, the tightest rate limit: only spend it when R5 decides the verdict.
    let ev = evaluate(s, d.config.rules, maxAgeS, detectedAt, ['R5']);
    if (ev.verdict === 'PASSED') {
      await fetchCandles(sig.mint, fetched, d.providers, d.config);
      s = buildSnapshot(sig.mint, fetched.f, now(), d.config);
      ev = evaluate(s, d.config.rules, maxAgeS, detectedAt);
    }
    if (Object.keys(s.errors).length) log.warn({ errors: s.errors }, 'provider data missing');
    write(sig, { s, raw: fetched.raw }, ev);
    log.info(
      { verdict: ev.verdict, killed_by: ev.killedBy, failed: ev.failed, mint: sig.mint },
      'decision',
    );
  };

  const submit = (id: number) => {
    if (queued.has(id)) return chain;
    queued.add(id);
    chain = chain
      .then(() => (stopped ? undefined : decide(id)))
      .catch((e) => {
        // A DB or code error leaves the signal undecided; the next boot retries it. Never a PASS.
        d.log.error(
          { signal_id: id, err: e instanceof Error ? e.message : String(e) },
          'rules failed',
        );
        try {
          event('rules_failed', { signal_id: id }, 'error');
        } catch {} // the chain must survive a broken DB write
      })
      .finally(() => queued.delete(id));
    return chain;
  };

  return {
    submit,
    /** Boot: every signal with no decision yet, oldest first. */
    submitPending: () => {
      const rows = d.db
        .select({ id: signals.id })
        .from(signals)
        .leftJoin(decisions, eq(decisions.signalId, signals.id))
        .where(isNull(decisions.signalId))
        .orderBy(asc(signals.id))
        .all();
      for (const r of rows) submit(r.id);
      d.log.info({ pending: rows.length }, 'rules: pending signals queued');
      return rows.length;
    },
    stop: () => {
      stopped = true;
    },
    idle: async () => {
      for (let c = chain; ; c = chain) {
        await c;
        if (c === chain) return;
      }
    },
  };
};
