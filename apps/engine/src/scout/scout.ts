// Scout: tracked wallets' transactions -> signals (paper.db), raw events -> data/raw/*.jsonl,
// heartbeat + connection status -> events_log (stage=scout).
// Never reads kill_switch: a halt blocks opening positions later, not data collection.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Config,
  eventsLog,
  type HeliusRpc,
  type HeliusStream,
  type HeliusTx,
  type RecordedCall,
  type StreamStatus,
  signals,
  type TradingDb,
} from '@scb/shared';
import { desc, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { parseSwap } from './parse.js';

export interface ScoutDeps {
  stream: HeliusStream;
  rpc: HeliusRpc;
  db: TradingDb;
  wallets: string[];
  cfg: Config['scout'];
  ignoredMints: readonly string[]; // prefilters.ignored_mints
  log: Logger;
  rawDir: string;
  record?: (call: RecordedCall) => void;
  /** Called with the id of every newly stored signal (the rules stage queues it). */
  onSignal?: (signalId: number) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const startScout = (d: ScoutDeps) => {
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? realSleep;
  const lastSig = new Map<string, string>(); // wallet -> newest signature seen, for reconnect backfill
  let booted = false;
  let reconnects = 0;
  let lastNotificationAt: number | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  mkdirSync(d.rawDir, { recursive: true });

  // ponytail: one tx at a time; a few hundred a day. Parallelise if the queue ever lags.
  const enqueue = (fn: () => Promise<unknown>) => {
    chain = chain.then(fn).catch((e) => d.log.error({ err: errText(e) }, 'scout task failed'));
    return chain;
  };

  const event = (message: string, data?: Record<string, unknown>, level = 'info') =>
    d.db
      .insert(eventsLog)
      .values({
        at: new Date(now()),
        level,
        stage: 'scout',
        message,
        dataJson: data ? JSON.stringify(data) : null,
      })
      .run();

  const writeRaw = (line: Record<string, unknown>) =>
    appendFileSync(
      join(d.rawDir, `scout-${new Date(now()).toISOString().slice(0, 10)}.jsonl`),
      `${JSON.stringify(line)}\n`,
    );

  const stored = (sig: string) =>
    d.db.select({ id: signals.id }).from(signals).where(eq(signals.txSig, sig)).get();

  const fetchTx = async (sig: string, log: Logger) => {
    for (let attempt = 0; attempt <= d.cfg.tx_fetch_retries; attempt++) {
      if (attempt > 0) await sleep(d.cfg.tx_fetch_delay_ms);
      try {
        const res = await d.rpc.getTransaction(sig);
        if (res.tx) return res as { tx: HeliusTx; raw: unknown };
      } catch (e) {
        log.warn({ err: errText(e), attempt }, 'getTransaction failed');
      }
    }
    return null;
  };

  const handle = async (
    wallet: string,
    sig: string,
    err: unknown,
    detectedAt: number,
    notification: unknown,
  ) => {
    const log = d.log.child({ wallet, tx_sig: sig });
    if (err != null) return log.debug({ reason: 'failed_tx' }, 'skip');
    if (stored(sig)) return log.debug('already stored');

    const fetched = await fetchTx(sig, log);
    writeRaw({ detectedAt, wallet, signature: sig, notification, tx: fetched?.raw ?? null });
    if (!fetched) return log.warn('tx unavailable after retries; raw only, no signal');

    const parsed = parseSwap(fetched.tx, wallet, d.cfg.quote_mint, d.ignoredMints);
    d.record?.({
      name: `tx-${'skip' in parsed ? `skip-${parsed.skip}` : parsed.side}`,
      request: { method: 'POST', path: 'getTransaction', query: {}, body: { signature: sig } },
      response: { jsonrpc: '2.0', id: 1, result: fetched.raw },
    });
    if ('skip' in parsed) return log.info({ reason: parsed.skip }, 'skip');

    const blockTimeMs = fetched.tx.blockTime == null ? null : fetched.tx.blockTime * 1000;
    const row = d.db
      .insert(signals)
      .values({
        wallet,
        mint: parsed.mint,
        side: parsed.side,
        amountSol: parsed.amountSol,
        amountToken: parsed.amountToken,
        txSig: sig,
        blockTime: blockTimeMs === null ? null : new Date(blockTimeMs),
        detectedAt: new Date(detectedAt),
        // blockTime has 1 s resolution, so this is accurate to about ±1 s.
        detectLatencyMs: blockTimeMs === null ? null : detectedAt - blockTimeMs,
      })
      .onConflictDoNothing({ target: signals.txSig })
      .returning({ id: signals.id })
      .get();
    // ponytail: tx_sig is UNIQUE (PLAN §3), so a tx mentioning two tracked wallets keeps the first.
    if (!row) return log.info('duplicate_tx_other_wallet');
    log.child({ signal_id: row.id }).info(
      {
        side: parsed.side,
        mint: parsed.mint,
        amount_sol: parsed.amountSol,
        detect_latency_ms: blockTimeMs === null ? null : detectedAt - blockTimeMs,
      },
      'signal',
    );
    d.onSignal?.(row.id);
  };

  const latestStored = (wallet: string) =>
    d.db
      .select({ txSig: signals.txSig })
      .from(signals)
      .where(eq(signals.wallet, wallet))
      .orderBy(desc(signals.blockTime), desc(signals.id))
      .limit(1)
      .get()?.txSig;

  /** Boot: since each wallet's latest stored signal. Reconnect: since the last sig seen. */
  const backfill = async (reconnect: boolean) => {
    let txs = 0;
    let walletsDone = 0;
    for (const wallet of d.wallets) {
      const until = reconnect
        ? (lastSig.get(wallet) ?? latestStored(wallet))
        : latestStored(wallet);
      if (!until) continue;
      try {
        const sigs = await d.rpc.signatures(wallet, { until, limit: d.cfg.backfill_limit });
        if (sigs[0]) lastSig.set(wallet, sigs[0].signature);
        for (const s of [...sigs].reverse()) {
          txs++;
          await handle(wallet, s.signature, s.err ?? null, now(), null);
        }
        walletsDone++;
      } catch (e) {
        d.log.warn({ wallet, err: errText(e) }, 'backfill failed');
      }
    }
    d.log.info({ wallets: walletsDone, txs, reconnect }, 'backfill done');
    event('backfill_done', { wallets: walletsDone, txs });
  };

  const onStatus = (s: StreamStatus) => {
    switch (s.event) {
      case 'connected':
        d.log.info('ws connected');
        return event('connected');
      case 'subscriptions_acked': {
        d.log.info({ count: s.count, failed: s.failed }, 'subscriptions acked');
        event('subscriptions_acked', { count: s.count });
        const reconnect = booted;
        booted = true;
        return enqueue(() => backfill(reconnect));
      }
      case 'subscribe_failed':
        return d.log.warn({ wallet: s.wallet, code: s.code }, 'subscribe failed');
      case 'ws_closed':
        d.log.warn({ code: s.code }, 'ws closed');
        return event('ws_closed', { code: s.code }, 'warn');
      case 'reconnecting':
        reconnects++;
        if (reconnects % 10 === 0) d.log.warn({ reconnects }, 'reconnecting often; check credits');
        d.log.info({ attempt: s.attempt, reconnect_in_ms: s.delayMs }, 'reconnecting');
        return event('reconnecting', { attempt: s.attempt, delay_ms: s.delayMs });
      case 'liveness_timeout':
        d.log.warn({ silent_s: Math.round(s.silentMs / 1000) }, 'ws silent too long; reconnecting');
        return event('liveness_timeout', { silent_ms: s.silentMs }, 'warn');
      case 'ws_error':
        return d.log.warn({ err: s.message }, 'ws error'); // already redacted by the stream
    }
  };

  let recordedNotification = false;
  d.stream.start(d.wallets, {
    logs: (e) => {
      lastNotificationAt = now();
      lastSig.set(e.wallet, e.signature);
      if (d.record && !recordedNotification) {
        recordedNotification = true;
        d.record({
          name: 'logs-notification',
          request: { method: 'WS', path: 'logsSubscribe', query: {} },
          response: e.raw,
        });
      }
      enqueue(() => handle(e.wallet, e.signature, e.err, e.receivedAt, e.raw));
    },
    status: onStatus,
  });

  // The heartbeat is a local timer: last_notification_age_s is what shows the ws is delivering.
  const beat = () =>
    event('heartbeat', {
      last_notification_age_s:
        lastNotificationAt === null ? null : Math.round((now() - lastNotificationAt) / 1000),
    });
  beat();
  const heartbeat = setInterval(beat, d.cfg.heartbeat_interval_ms);

  return {
    stop: () => {
      clearInterval(heartbeat);
      d.stream.stop();
    },
    /** Resolves when every queued notification/backfill has been handled (tests, shutdown). */
    idle: async () => {
      for (let c = chain; ; c = chain) {
        await c;
        if (c === chain) return;
      }
    },
  };
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
