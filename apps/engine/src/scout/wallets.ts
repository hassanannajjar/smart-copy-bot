// data/wallets.csv (address,label,source): validated on load, synced into the trading DB's
// `wallets` table. Any bad row stops the engine (fail closed). Reloaded on every restart.
import { readFileSync } from 'node:fs';
import { type TradingDb, wallets } from '@scb/shared';
import { notInArray } from 'drizzle-orm';

export interface WalletRow {
  address: string;
  label: string;
  source: string;
}

const HEADER = 'address,label,source';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** A Solana address is base58 that decodes to exactly 32 bytes. */
export const isSolanaAddress = (s: string) => {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  const leadingZeros = s.length - s.replace(/^1+/, '').length;
  const bytes = n === 0n ? 0 : Math.ceil(n.toString(16).length / 2);
  return leadingZeros + bytes === 32;
};

export const parseWallets = (csv: string): WalletRow[] => {
  const lines = csv.split(/\r?\n/);
  if (lines[0]?.trim() !== HEADER)
    throw new Error(`wallets.csv line 1: header must be "${HEADER}"`);
  const seen = new Set<string>();
  const rows: WalletRow[] = [];
  lines.slice(1).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const at = `wallets.csv line ${i + 2}`;
    const cells = line.split(',').map((c) => c.trim());
    const [address = '', label = '', source = ''] = cells;
    if (cells.length !== 3) throw new Error(`${at}: expected 3 columns, got ${cells.length}`);
    if (!isSolanaAddress(address)) throw new Error(`${at}: invalid Solana address "${address}"`);
    if (seen.has(address)) throw new Error(`${at}: duplicate address ${address}`);
    seen.add(address);
    rows.push({ address, label, source });
  });
  if (rows.length === 0) throw new Error('wallets.csv: no wallets');
  return rows;
};

export const loadWallets = (path: string) => parseWallets(readFileSync(path, 'utf8'));

/** Upsert the CSV into `wallets` (active) and deactivate addresses no longer listed. */
export const syncWallets = (db: TradingDb, rows: WalletRow[], now = new Date()) =>
  db.transaction((tx) => {
    for (const r of rows) {
      tx.insert(wallets)
        .values({ ...r, addedAt: now, active: true })
        .onConflictDoUpdate({
          target: wallets.address,
          set: { label: r.label, source: r.source, active: true },
        })
        .run();
    }
    const addresses = rows.map((r) => r.address);
    tx.update(wallets).set({ active: false }).where(notInArray(wallets.address, addresses)).run();
  });
