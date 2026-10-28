// Trading schema: identical in demo.db, paper.db and live.db.
// Types kept Postgres-portable (ints for ms timestamps/bools, text for json/enums).
import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const ts = (name: string) => integer(name, { mode: 'timestamp_ms' });
const bool = (name: string) => integer(name, { mode: 'boolean' });
const id = () => integer('id').primaryKey({ autoIncrement: true });

export const wallets = sqliteTable('wallets', {
  address: text('address').primaryKey(),
  label: text('label'),
  source: text('source'),
  addedAt: ts('added_at').notNull(),
  active: bool('active').notNull().default(true),
  score: real('score'),
  notes: text('notes'),
});

export const signals = sqliteTable(
  'signals',
  {
    id: id(),
    wallet: text('wallet').notNull(),
    mint: text('mint').notNull(),
    side: text('side', { enum: ['buy', 'sell'] }).notNull(),
    amountSol: real('amount_sol'),
    amountToken: real('amount_token'),
    txSig: text('tx_sig').notNull().unique(),
    blockTime: ts('block_time'),
    detectedAt: ts('detected_at').notNull(),
    detectLatencyMs: integer('detect_latency_ms'),
  },
  (t) => [index('signals_mint_idx').on(t.mint), index('signals_wallet_idx').on(t.wallet)],
);

export const tokenSnapshots = sqliteTable('token_snapshots', {
  id: id(),
  signalId: integer('signal_id')
    .notNull()
    .references(() => signals.id),
  mint: text('mint').notNull(),
  takenAt: ts('taken_at').notNull(),
  priceUsd: real('price_usd'),
  liquidityUsd: real('liquidity_usd'),
  fdvUsd: real('fdv_usd'),
  pairAddress: text('pair_address'),
  pairCreatedAt: ts('pair_created_at'),
  priceChange5m: real('price_change_5m'),
  priceChange45m: real('price_change_45m'),
  top10Pct: real('top10_pct'),
  devPct: real('dev_pct'),
  bundledPct: real('bundled_pct'),
  mintAuthorityRevoked: bool('mint_authority_revoked'),
  freezeAuthorityRevoked: bool('freeze_authority_revoked'),
  lpLockedPct: real('lp_locked_pct'),
  rawJson: text('raw_json'),
});

export const ruleResults = sqliteTable(
  'rule_results',
  {
    id: id(),
    signalId: integer('signal_id')
      .notNull()
      .references(() => signals.id),
    ruleId: text('rule_id').notNull(),
    passed: bool('passed').notNull(),
    value: text('value'),
    threshold: text('threshold'),
    reason: text('reason'),
  },
  (t) => [index('rule_results_signal_idx').on(t.signalId)],
);

export const decisions = sqliteTable('decisions', {
  signalId: integer('signal_id')
    .primaryKey()
    .references(() => signals.id),
  verdict: text('verdict', { enum: ['PASSED', 'KILLED', 'SKIPPED'] }).notNull(),
  killedBy: text('killed_by'),
  allFailedJson: text('all_failed_json'),
  decidedAt: ts('decided_at').notNull(),
});

export const analystReviews = sqliteTable('analyst_reviews', {
  id: id(),
  signalId: integer('signal_id')
    .notNull()
    .references(() => signals.id),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  verdict: text('verdict'),
  confidence: real('confidence'),
  rationale: text('rationale'),
  latencyMs: integer('latency_ms'),
  costUsd: real('cost_usd'),
  usedForDecision: bool('used_for_decision').notNull().default(false),
});

export const positions = sqliteTable(
  'positions',
  {
    id: id(),
    signalId: integer('signal_id')
      .notNull()
      .references(() => signals.id),
    mode: text('mode', { enum: ['paper', 'live'] }).notNull(),
    mint: text('mint').notNull(),
    sizeUsd: real('size_usd').notNull(),
    entryPrice: real('entry_price').notNull(),
    entryAt: ts('entry_at').notNull(),
    stopPrice: real('stop_price').notNull(),
    tpPlanJson: text('tp_plan_json').notNull(),
    status: text('status', { enum: ['open', 'closed'] }).notNull(),
    exitPrice: real('exit_price'),
    exitAt: ts('exit_at'),
    exitReason: text('exit_reason'),
    grossPnlUsd: real('gross_pnl_usd'),
    feesUsd: real('fees_usd'),
    slippageBps: real('slippage_bps'),
    netPnlUsd: real('net_pnl_usd'),
    netPnlPct: real('net_pnl_pct'),
  },
  // One open position per mint, enforced by the DB rather than app code.
  (t) => [uniqueIndex('positions_one_open_per_mint').on(t.mint).where(sql`status = 'open'`)],
);

export const fills = sqliteTable('fills', {
  id: id(),
  positionId: integer('position_id')
    .notNull()
    .references(() => positions.id),
  side: text('side', { enum: ['buy', 'sell'] }).notNull(),
  qty: real('qty').notNull(),
  price: real('price').notNull(),
  feeUsd: real('fee_usd').notNull(),
  txSig: text('tx_sig'),
  simulated: bool('simulated').notNull(),
  at: ts('at').notNull(),
});

export const eventsLog = sqliteTable('events_log', {
  id: id(),
  at: ts('at').notNull(),
  level: text('level').notNull(),
  stage: text('stage').notNull(),
  message: text('message').notNull(),
  dataJson: text('data_json'),
});
