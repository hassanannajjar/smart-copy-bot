import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eventsLog, loadConfig, migrateAll, openTradingDb, signals } from '@scb/shared';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startScout } from '../src/scout/scout.js';
import { fakeHeliusRpc, fakeHeliusStream, heliusTx } from './fakes.js';

const cfg = loadConfig(new URL('../../../config/rules.yaml', import.meta.url).pathname).scout;
const buy = heliusTx('tx-jupiter-buy');
const pumpBuy = heliusTx('tx-pumpfun-buy');
const transfer = heliusTx('tx-sol-transfer');
const A = buy.wallet;
const B = transfer.wallet;
const sigOf = (t: typeof buy) => t.tx.transaction.signatures[0] as string;

const setup = (txs = [buy, pumpBuy, transfer], sigs = {}, onSignal?: (id: number) => void) => {
  const dir = mkdtempSync(join(tmpdir(), 'scb-scout-'));
  migrateAll(dir);
  const db = openTradingDb(join(dir, 'paper.db'));
  const lines: string[] = [];
  const log = pino({ level: 'debug' }, { write: (l: string) => lines.push(l) });
  const s = fakeHeliusStream();
  const { rpc, calls } = fakeHeliusRpc(txs, sigs);
  const scout = startScout({
    stream: s.stream,
    rpc,
    db,
    wallets: [A, B],
    cfg,
    ignoredMints: [],
    log,
    rawDir: join(dir, 'raw'),
    sleep: async () => {},
    onSignal,
  });
  const raw = () =>
    readdirSync(join(dir, 'raw')).flatMap((f) =>
      readFileSync(join(dir, 'raw', f), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    );
  const events = () => db.select().from(eventsLog).all();
  return { db, lines, s, calls, scout, raw, events };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('scout', () => {
  it('turns a notification into a signal with detect_latency_ms, raw line and signal_id log', async () => {
    const t = setup();
    const receivedAt = (buy.tx.blockTime as number) * 1000 + 2345;
    t.s.logs({ wallet: A, signature: sigOf(buy), receivedAt });
    await t.scout.idle();

    const rows = t.db.select().from(signals).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      wallet: A,
      side: 'buy',
      mint: 'FZAEGkZxMpZN8v2XMZGyoAJH89r3aHJRAikwZXcWZz9R',
      txSig: sigOf(buy),
      detectLatencyMs: 2345,
    });
    expect(rows[0]?.detectedAt.getTime()).toBe(receivedAt);
    expect(t.raw()).toEqual([
      expect.objectContaining({ wallet: A, signature: sigOf(buy), detectedAt: receivedAt }),
    ]);
    expect(t.raw()[0].tx.transaction.signatures[0]).toBe(sigOf(buy));
    const signalLine = t.lines.map((l) => JSON.parse(l)).find((l) => l.msg === 'signal');
    expect(signalLine).toMatchObject({ signal_id: rows[0]?.id, tx_sig: sigOf(buy), wallet: A });
    t.scout.stop();
    expect(t.s.stopped).toBe(true);
  });

  it('hands every newly stored signal id to onSignal (the rules stage)', async () => {
    const ids: number[] = [];
    const t = setup(undefined, {}, (id) => ids.push(id));
    t.s.logs({ wallet: A, signature: sigOf(buy) });
    t.s.logs({ wallet: A, signature: sigOf(buy) }); // duplicate: not handed over again
    t.s.logs({ wallet: B, signature: sigOf(transfer) }); // skipped tx: no signal
    await t.scout.idle();
    expect(ids).toEqual(
      t.db
        .select()
        .from(signals)
        .all()
        .map((r) => r.id),
    );
    expect(ids).toHaveLength(1);
    t.scout.stop();
  });

  it('ignores a duplicate tx_sig without refetching, and skips failed txs without fetching', async () => {
    const t = setup();
    t.s.logs({ wallet: A, signature: sigOf(buy) });
    t.s.logs({ wallet: A, signature: sigOf(buy) });
    t.s.logs({ wallet: A, signature: 'failedSig', err: { InstructionError: [0, 'x'] } });
    await t.scout.idle();
    expect(t.db.select().from(signals).all()).toHaveLength(1);
    expect(t.calls.getTransaction).toEqual([sigOf(buy)]);
  });

  it('a tx that never becomes available is recorded raw-only after retries, no signal', async () => {
    const t = setup();
    t.s.logs({ wallet: A, signature: 'missingSig' });
    await t.scout.idle();
    expect(t.calls.getTransaction).toHaveLength(cfg.tx_fetch_retries + 1);
    expect(t.db.select().from(signals).all()).toHaveLength(0);
    expect(t.raw()).toEqual([expect.objectContaining({ signature: 'missingSig', tx: null })]);
  });

  it('a non-swap tx is recorded raw but makes no signal', async () => {
    const t = setup();
    t.s.logs({ wallet: B, signature: sigOf(transfer) });
    await t.scout.idle();
    expect(t.db.select().from(signals).all()).toHaveLength(0);
    expect(t.raw()).toHaveLength(1);
  });

  it('boot backfill starts from each wallet’s latest stored signal; none stored => no backfill', async () => {
    const t = setup(undefined, {
      [A]: [{ signature: sigOf(pumpBuy), slot: 1, err: null, blockTime: pumpBuy.tx.blockTime }],
    });
    t.db
      .insert(signals)
      .values({ wallet: A, mint: 'm', side: 'buy', txSig: 'storedSig', detectedAt: new Date(0) })
      .run();
    t.s.status({ event: 'subscriptions_acked', count: 2, failed: 0 });
    await t.scout.idle();
    expect(t.calls.signatures).toEqual([
      { wallet: A, until: 'storedSig', limit: cfg.backfill_limit },
    ]);
    const txSigs = t.db
      .select()
      .from(signals)
      .all()
      .map((r) => r.txSig);
    expect(txSigs).toContain(sigOf(pumpBuy));
    expect(t.events().find((e) => e.message === 'backfill_done')?.dataJson).toBe(
      JSON.stringify({ wallets: 1, txs: 1 }),
    );
  });

  it('reconnect backfill starts from the last signature seen on the stream', async () => {
    const t = setup();
    t.s.status({ event: 'subscriptions_acked', count: 2, failed: 0 }); // boot: nothing stored
    t.s.logs({ wallet: B, signature: sigOf(transfer) });
    await t.scout.idle();
    expect(t.calls.signatures).toEqual([]);

    t.s.status({ event: 'subscriptions_acked', count: 2, failed: 0 }); // after a reconnect
    await t.scout.idle();
    expect(t.calls.signatures).toEqual([
      { wallet: B, until: sigOf(transfer), limit: cfg.backfill_limit },
    ]);
  });

  it('writes heartbeat and status rows to events_log, without URLs or keys', async () => {
    vi.useFakeTimers();
    const t = setup();
    vi.advanceTimersByTime(cfg.heartbeat_interval_ms * 2);
    t.s.status({ event: 'connected' });
    t.s.status({ event: 'subscriptions_acked', count: 2, failed: 0 });
    t.s.status({ event: 'ws_closed', code: 1006 });
    t.s.status({ event: 'reconnecting', attempt: 1, delayMs: 1234 });
    await t.scout.idle();
    t.scout.stop();

    const ev = t.events();
    expect(ev.every((e) => e.stage === 'scout')).toBe(true);
    expect(ev.filter((e) => e.message === 'heartbeat')).toHaveLength(3); // boot + 2 intervals
    expect(ev.filter((e) => e.message !== 'heartbeat').map((e) => [e.message, e.dataJson])).toEqual(
      [
        ['connected', null],
        ['subscriptions_acked', '{"count":2}'],
        ['ws_closed', '{"code":1006}'],
        ['reconnecting', '{"attempt":1,"delay_ms":1234}'],
        ['backfill_done', '{"wallets":0,"txs":0}'],
      ],
    );
    expect(JSON.stringify(ev)).not.toMatch(/wss?:\/\/|api-key/);
  });
});
