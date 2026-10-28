import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as control from './control-schema.js';
import * as trading from './schema.js';

const openSqlite = (path: string) => {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const client = new Database(path);
  client.pragma('journal_mode = WAL');
  client.pragma('foreign_keys = ON');
  return client;
};

export const openTradingDb = (path: string) =>
  drizzle({ client: openSqlite(path), schema: trading });
export const openControlDb = (path: string) =>
  drizzle({ client: openSqlite(path), schema: control });

export type TradingDb = ReturnType<typeof openTradingDb>;
export type ControlDb = ReturnType<typeof openControlDb>;
