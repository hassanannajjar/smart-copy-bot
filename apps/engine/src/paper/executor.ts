// Paper executor + PositionManager (PLAN §5). PAPER only: nothing here signs or sends anything,
// and the Jupiter client cannot even request a transaction (no taker).
// Entries and polls run on one serial chain: Jupiter is a single rate bucket and createHttp's
// throttle is not concurrency-safe. Every fill and its guard-state update is one transaction.
import {
  type Config,
  decisions,
  eventsLog,
  fills,
  type HeliusFeeRpc,
  type JupiterApi,
  type JupPrices,
  positions,
  rcReportSchema,
  signals,
  type TradingDb,
  tokenSnapshots,
  WSOL_MINT,
} from '@scb/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import {
  type ExitReason,
  evaluate,
  type GuardState,
  initialGuard,
  pnl,
  sellAmount,
  stopPrice,
  type Trigger,
} from './guard.js';

const LAMPORTS_PER_SOL = 1e9;
const MICRO_LAMPORTS_PER_SOL = 1e15;

export interface PaperDeps {
  db: TradingDb;
  config: Config;
  jupiter: JupiterApi;
  fees: HeliusFeeRpc;
  /** Read live (the dashboard toggles it). Must return true when it can't tell: fail closed. */
  killSwitch: () => boolean;
  log: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

type Position = typeof positions.$inferSelect;
type Fill = Omit<typeof fills.$inferInsert, 'positionId'>;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const startPaper = (d: PaperDeps) => {
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const { paper, executor } = d.config;
  let chain: Promise<unknown> = Promise.resolve();
  let stopped = false;
  let tickQueued = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const eventRow = (message: string, data: Record<string, unknown>, level = 'info') => ({
    at: new Date(now()),
    level,
    stage: 'paper',
    message,
    dataJson: JSON.stringify(data),
  });
  const event = (message: string, data: Record<string, unknown>, level = 'info') =>
    d.db
      .insert(eventsLog)
      .values(eventRow(message, data, level))
      .run();

  const enqueue = (label: string, fn: () => Promise<unknown>, data: Record<string, unknown>) => {
    chain = chain
      .then(() => (stopped ? undefined : fn()))
      .catch((e) => {
        // A provider or DB error never opens a position; an open one is retried next tick.
        d.log.error({ ...data, err: errMsg(e) }, `paper ${label} failed`);
        try {
          event(`${label}_failed`, { ...data, err: errMsg(e) }, 'error');
        } catch {} // the chain must survive a broken DB write
      });
    return chain;
  };

  const killed = () => {
    try {
      return d.killSwitch();
    } catch {
      return true;
    }
  };

  /** Network fee in SOL: base + Helius priority estimate x CU; static fallback on any error. */
  const networkFeeSol = async (ammKeys: string[], log: Logger) => {
    let priority = paper.priority_fee_sol;
    let source = 'static';
    try {
      const microLamportsPerCu = await d.fees.priorityFeeEstimate(
        ammKeys,
        executor.priority_fee_level,
      );
      priority = (microLamportsPerCu * executor.compute_units) / MICRO_LAMPORTS_PER_SOL;
      source = 'helius';
    } catch (e) {
      log.warn({ err: errMsg(e) }, 'priority fee estimate failed, using paper.priority_fee_sol');
    }
    return { sol: paper.base_fee_sol + priority, prioritySol: priority, source };
  };

  const decimalsFor = (signalId: number): number | null => {
    const snap = d.db
      .select({ raw: tokenSnapshots.rawJson })
      .from(tokenSnapshots)
      .where(eq(tokenSnapshots.signalId, signalId))
      .orderBy(desc(tokenSnapshots.id))
      .get();
    try {
      const rc = rcReportSchema.safeParse(JSON.parse(snap?.raw ?? 'null')?.providers?.rugcheck);
      return rc.success ? rc.data.token.decimals : null;
    } catch {
      return null;
    }
  };

  // ---- entry ----
  const enter = async (signalId: number) => {
    const log = d.log.child({ signal_id: signalId });
    const sig = d.db.select().from(signals).where(eq(signals.id, signalId)).get();
    const mint = sig?.mint;
    const skip = (reason: string, extra: Record<string, unknown> = {}) => {
      event('skipped', { signal_id: signalId, mint, reason, ...extra });
      log.info({ reason, mint, ...extra }, 'paper: entry skipped');
    };
    if (!sig) return skip('signal_not_found');
    const dec = d.db.select().from(decisions).where(eq(decisions.signalId, signalId)).get();
    if (dec?.verdict !== 'PASSED') return skip('not_passed');
    if (killed()) return skip('kill_switch');
    const isOpen = () =>
      d.db
        .select({ id: positions.id })
        .from(positions)
        .where(and(eq(positions.mint, sig.mint), eq(positions.status, 'open')))
        .get();
    if (isOpen()) return skip('position_open');
    const last = d.db
      .select({ entryAt: positions.entryAt })
      .from(positions)
      .where(eq(positions.mint, sig.mint))
      .orderBy(desc(positions.entryAt))
      .get();
    const cooldownMs = d.config.prefilters.mint_cooldown_h * 3_600_000;
    if (last && now() - last.entryAt.getTime() < cooldownMs)
      return skip('mint_cooldown', { last_entry_at: last.entryAt.getTime() });
    // Same "when the wallet traded" as the rules stage: block_time when known.
    const detectedAt = Math.min(sig.blockTime?.getTime() ?? Infinity, sig.detectedAt.getTime());
    if (now() - detectedAt > executor.max_entry_delay_s * 1000)
      return skip('stale', { age_ms: now() - detectedAt });
    const decimals = decimalsFor(signalId);
    if (decimals === null) return skip('data_unavailable', { missing: 'decimals' });
    const ref = d.db
      .select({ price: tokenSnapshots.priceUsd })
      .from(tokenSnapshots)
      .where(eq(tokenSnapshots.signalId, signalId))
      .orderBy(desc(tokenSnapshots.id))
      .get()?.price;

    // We are never faster than detection + our latency, and never earlier than now.
    const wait = detectedAt + paper.simulated_latency_ms - now();
    if (wait > 0) await sleep(wait);

    const prices = await d.jupiter.prices([sig.mint, WSOL_MINT]);
    const solUsd = prices[WSOL_MINT]?.usdPrice;
    if (!solUsd) return skip('data_unavailable', { missing: 'sol_price' });
    const lamports = BigInt(Math.floor((paper.position_size_usd / solUsd) * LAMPORTS_PER_SOL));
    const q = await d.jupiter.quote(WSOL_MINT, sig.mint, lamports);
    if (!q) return skip('no_route');
    const fee = await networkFeeSol(q.ammKeys, log);
    if (killed()) return skip('kill_switch'); // it may have been engaged during the waits

    const at = now();
    const spentUsd = (Number(q.inAmount) / LAMPORTS_PER_SOL) * solUsd;
    const qty = Number(q.outAmount) / 10 ** decimals;
    const price = spentUsd / qty;
    const platformUsd = (spentUsd * q.feeBps) / 10_000;
    const refPrice = ref ?? prices[sig.mint]?.usdPrice ?? price;
    const guard = initialGuard(
      d.config,
      at,
      decimals,
      q.outAmount,
      prices[sig.mint]?.liquidity ?? null,
    );
    guard.platform_fee_usd = platformUsd;
    guard.slippage_usd = qty * (price - refPrice);
    const feeUsd = fee.sol * solUsd + platformUsd;
    const data = {
      signal_id: signalId,
      mint: sig.mint,
      size_usd: spentUsd,
      qty,
      price,
      ref_price: refPrice,
      fee_usd: feeUsd,
      priority_fee_sol: fee.prioritySol,
      priority_fee_source: fee.source,
      fee_bps: q.feeBps,
      price_impact_pct: q.priceImpactPct,
      router: q.router,
      latency_ms: at - detectedAt,
    };
    try {
      const id = d.db.transaction((tx) => {
        const row = tx
          .insert(positions)
          .values({
            signalId,
            mode: 'paper',
            mint: sig.mint,
            sizeUsd: spentUsd,
            entryPrice: price,
            entryAt: new Date(at),
            stopPrice: stopPrice(guard, price),
            tpPlanJson: JSON.stringify(guard),
            status: 'open',
          })
          .returning({ id: positions.id })
          .get();
        tx.insert(fills)
          .values({
            positionId: row.id,
            side: 'buy',
            qty,
            price,
            feeUsd,
            txSig: null,
            simulated: true,
            at: new Date(at),
          })
          .run();
        tx.insert(eventsLog)
          .values(eventRow('opened', { position_id: row.id, ...data }))
          .run();
        return row.id;
      });
      log.info({ position_id: id, ...data }, 'paper: position opened');
    } catch (e) {
      // The one-open-per-mint index lost a race to another signal for this mint.
      if (isOpen()) return skip('position_open');
      throw e;
    }
  };

  // ---- position manager ----
  const fillAndMaybeClose = (
    pos: Position,
    g: GuardState,
    fill: Fill,
    reason: ExitReason | 'no_route',
    extra: Record<string, unknown>,
  ) =>
    d.db.transaction((tx) => {
      tx.insert(fills)
        .values({ ...fill, positionId: pos.id })
        .run();
      const closing = BigInt(g.remaining_raw) === 0n;
      const set: Partial<typeof positions.$inferInsert> = { tpPlanJson: JSON.stringify(g) };
      let breakdown: ReturnType<typeof pnl> | undefined;
      if (closing) {
        const all = tx.select().from(fills).where(eq(fills.positionId, pos.id)).all();
        const sells = all.filter((f) => f.side === 'sell');
        const proceedsUsd = sells.reduce((s, f) => s + f.qty * f.price, 0);
        const soldQty = sells.reduce((s, f) => s + f.qty, 0);
        breakdown = pnl({
          sizeUsd: pos.sizeUsd,
          proceedsUsd,
          feesUsd: all.reduce((s, f) => s + f.feeUsd, 0),
          platformFeeUsd: g.platform_fee_usd,
          slippageUsd: g.slippage_usd,
        });
        Object.assign(set, {
          status: 'closed',
          exitPrice: soldQty > 0 ? proceedsUsd / soldQty : 0,
          exitAt: fill.at,
          exitReason: reason,
          ...breakdown,
        });
      }
      tx.update(positions).set(set).where(eq(positions.id, pos.id)).run();
      const data = {
        position_id: pos.id,
        signal_id: pos.signalId,
        mint: pos.mint,
        reason,
        qty: fill.qty,
        price: fill.price,
        fee_usd: fill.feeUsd,
        ...extra,
      };
      tx.insert(eventsLog).values(eventRow('exit', data)).run();
      if (breakdown)
        tx.insert(eventsLog)
          .values(eventRow('closed', { ...data, ...breakdown }))
          .run();
      return breakdown;
    });

  const manage = async (pos: Position, prices: JupPrices, solUsd: number) => {
    const log = d.log.child({ signal_id: pos.signalId, position_id: pos.id });
    const g: GuardState = JSON.parse(pos.tpPlanJson);
    const remaining = BigInt(g.remaining_raw);
    const toQty = (raw: bigint) => Number(raw) / 10 ** g.decimals;
    const p = prices[pos.mint];
    let mark = p?.usdPrice ?? null;
    let noRoute = false;
    if (!p) {
      // Price V3 omits mints it deems unreliable: mark at an executable quote for our size instead.
      const q = await d.jupiter.quote(pos.mint, WSOL_MINT, remaining).catch((e) => {
        log.warn({ err: errMsg(e) }, 'paper: fallback mark quote failed');
        return undefined;
      });
      if (q) mark = ((Number(q.outAmount) / LAMPORTS_PER_SOL) * solUsd) / toQty(remaining);
      noRoute = q === null;
    }
    const ev = evaluate(g, pos.entryPrice, mark, p?.liquidity ?? null, now());
    const { next } = ev;
    // No price and no route: treat as a rug; the exit path books it at zero after N such polls.
    const trigger: Trigger | null = ev.trigger ?? (noRoute ? { reason: 'rug' } : null);
    const save = (s: GuardState) =>
      d.db
        .update(positions)
        .set({ tpPlanJson: JSON.stringify(s) })
        .where(eq(positions.id, pos.id))
        .run();
    if (!trigger) {
      if (JSON.stringify(next) !== pos.tpPlanJson) save(next);
      return;
    }
    await exit(pos, next, trigger, mark, solUsd, log, save);
  };

  const exit = async (
    pos: Position,
    g: GuardState,
    t: Trigger,
    mark: number | null,
    solUsd: number,
    log: Logger,
    save: (s: GuardState) => unknown,
  ) => {
    save(g); // keep this poll's peak/liquidity even if the quote below fails
    const toQty = (raw: bigint) => Number(raw) / 10 ** g.decimals;
    const raw = sellAmount(g, t);
    await sleep(paper.simulated_latency_ms);
    // The fill is a fresh quote for our size now, never the trigger or stop price: gaps are real.
    const q = await d.jupiter.quote(pos.mint, WSOL_MINT, raw);
    const at = new Date(now());
    if (!q) {
      const polls = g.no_route_polls + 1;
      if (polls < executor.no_route_max_polls) {
        save({ ...g, no_route_polls: polls });
        log.warn({ reason: t.reason, polls }, 'paper: no route for exit, retrying next poll');
        return;
      }
      // Nobody will buy it: book the rest at zero.
      const rest = BigInt(g.remaining_raw);
      const qty = toQty(rest);
      const done: GuardState = {
        ...g,
        no_route_polls: polls,
        remaining_raw: '0',
        slippage_usd: g.slippage_usd + qty * (mark ?? 0),
      };
      const b = fillAndMaybeClose(
        pos,
        done,
        { side: 'sell', qty, price: 0, feeUsd: 0, txSig: null, simulated: true, at },
        'no_route',
        { trigger: t.reason, mark },
      );
      log.warn({ ...b, trigger: t.reason }, 'paper: closed at zero, no route');
      return;
    }
    const fee = await networkFeeSol(q.ammKeys, log);
    const qty = toQty(raw);
    const proceedsUsd = (Number(q.outAmount) / LAMPORTS_PER_SOL) * solUsd;
    const price = proceedsUsd / qty;
    const platformUsd = (proceedsUsd * q.feeBps) / 10_000;
    const tp = g.take_profit.map((l, i) => (i === t.tp ? { ...l, done: true } : l));
    const next: GuardState = {
      ...g,
      take_profit: tp,
      remaining_raw: (BigInt(g.remaining_raw) - raw).toString(),
      // The trailing stop starts from the mark that completed the ladder.
      peak_price: t.tp !== undefined && tp.every((l) => l.done) ? mark : g.peak_price,
      no_route_polls: 0,
      platform_fee_usd: g.platform_fee_usd + platformUsd,
      slippage_usd: g.slippage_usd + qty * ((mark ?? price) - price),
    };
    const b = fillAndMaybeClose(
      pos,
      next,
      {
        side: 'sell',
        qty,
        price,
        feeUsd: fee.sol * solUsd + platformUsd,
        txSig: null,
        simulated: true,
        at,
      },
      t.reason,
      {
        trigger_mark: mark,
        priority_fee_source: fee.source,
        fee_bps: q.feeBps,
        price_impact_pct: q.priceImpactPct,
        partial: next.remaining_raw !== '0',
      },
    );
    log.info(
      { reason: t.reason, qty, price, mark, ...b },
      b ? 'paper: closed' : 'paper: partial exit',
    );
  };

  const tick = async () => {
    const open = d.db
      .select()
      .from(positions)
      .where(and(eq(positions.status, 'open'), eq(positions.mode, 'paper')))
      .all();
    if (!open.length) return;
    const mints = [...new Set(open.map((p) => p.mint))];
    const prices: JupPrices = {};
    try {
      // One Price V3 call per batch; any failed batch skips the tick (no exit on missing data).
      for (let i = 0; i < mints.length; i += executor.price_batch_size)
        Object.assign(
          prices,
          await d.jupiter.prices([...mints.slice(i, i + executor.price_batch_size), WSOL_MINT]),
        );
    } catch (e) {
      // Logged, not evented: an outage would otherwise write a row every poll.
      d.log.warn({ err: errMsg(e) }, 'paper: price poll failed, skipping tick');
      return;
    }
    const solUsd = prices[WSOL_MINT]?.usdPrice;
    if (!solUsd) {
      d.log.warn('paper: no SOL price, skipping tick');
      return;
    }
    for (const pos of open) {
      if (stopped) return;
      try {
        await manage(pos, prices, solUsd);
      } catch (e) {
        d.log.error(
          { signal_id: pos.signalId, position_id: pos.id, err: errMsg(e) },
          'paper: manage failed',
        );
        event(
          'manage_failed',
          { signal_id: pos.signalId, position_id: pos.id, err: errMsg(e) },
          'error',
        );
      }
    }
  };

  const queueTick = () => {
    if (tickQueued) return chain; // a slow tick (rate limits) swallows the next one
    tickQueued = true;
    return enqueue('tick', () => tick().finally(() => (tickQueued = false)), {});
  };

  return {
    /** Called by the rules stage for every PASSED decision. */
    submit: (signalId: number) => enqueue('entry', () => enter(signalId), { signal_id: signalId }),
    tick: queueTick,
    /** Open positions live in the DB, so boot just starts polling them again. */
    start: () => {
      const open = d.db
        .select({ id: positions.id })
        .from(positions)
        .where(and(eq(positions.status, 'open'), eq(positions.mode, 'paper')))
        .all();
      event('resumed', { open_positions: open.length });
      d.log.info({ open_positions: open.length }, 'paper: managing open positions');
      timer = setInterval(queueTick, paper.poll_interval_s * 1000);
      return open.length;
    },
    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
    },
    idle: async () => {
      for (let c = chain; ; c = chain) {
        await c;
        if (c === chain) return;
      }
    },
  };
};
