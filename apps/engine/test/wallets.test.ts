import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateAll, openTradingDb, wallets } from '@scb/shared';
import { describe, expect, it } from 'vitest';
import { isSolanaAddress, loadWallets, parseWallets, syncWallets } from '../src/scout/wallets.js';

const A = 'GwSwopjoSe1nTyBBADzkNKxaCuvJtHTEdWgq4MCfpESh';
const B = 'HvvEk6DkVfri3xGqvh4KK3eVqtGT6RRvdWaaKBA5j1gV';
const csv = (...rows: string[]) => ['address,label,source', ...rows].join('\n');

describe('wallets.csv', () => {
  it('loads the real list and keeps the source column', () => {
    const rows = loadWallets(new URL('../../../data/wallets.csv', import.meta.url).pathname);
    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect(rows.find((r) => r.address === A)?.source).toBe('discover-2026-10-29b');
  });

  it('validates base58 addresses that decode to 32 bytes', () => {
    expect(isSolanaAddress(A)).toBe(true);
    expect(isSolanaAddress('11111111111111111111111111111111')).toBe(true); // system program
    expect(isSolanaAddress(`${A.slice(0, -1)}0`)).toBe(false); // '0' isn't base58
    expect(isSolanaAddress(A.slice(0, 33))).toBe(false); // too short to be 32 bytes
  });

  it.each([
    ['a bad header', 'wallet,label\nx', /line 1: header/],
    ['a bad address', csv(`${A},a,s`, 'notAnAddress,b,s'), /line 3: invalid Solana address/],
    ['a duplicate', csv(`${A},a,s`, `${A},b,s`), /line 3: duplicate address/],
    ['a wrong column count', csv(`${A},a`), /line 2: expected 3 columns/],
    ['no rows', csv(), /no wallets/],
  ])('fails closed on %s', (_, text, err) => {
    expect(() => parseWallets(text)).toThrow(err);
  });

  it('sync upserts listed wallets and deactivates removed ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scb-wallets-'));
    migrateAll(dir);
    const db = openTradingDb(join(dir, 'paper.db'));
    syncWallets(db, parseWallets(csv(`${A},a,verified`, `${B},b,unverified`)));
    syncWallets(db, parseWallets(csv(`${A},a2,verified`)));
    const rows = db.select().from(wallets).all();
    expect(rows.map((r) => [r.address, r.label, r.source, r.active])).toEqual([
      [A, 'a2', 'verified', true],
      [B, 'b', 'unverified', false],
    ]);
  });
});
