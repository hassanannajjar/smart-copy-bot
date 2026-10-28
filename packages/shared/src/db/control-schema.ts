// Control schema: lives only in control.db, the single source of truth for mode state.
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const appSettings = sqliteTable('app_settings', {
  key: text('key', { enum: ['requested_mode', 'active_mode', 'kill_switch'] }).primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  updatedBy: text('updated_by').notNull(),
});

export const modeChanges = sqliteTable('mode_changes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  at: integer('at', { mode: 'timestamp_ms' }).notNull(),
  fromMode: text('from_mode'),
  toMode: text('to_mode').notNull(),
  requestedBy: text('requested_by').notNull(),
  accepted: integer('accepted', { mode: 'boolean' }).notNull(),
  reason: text('reason'),
});
