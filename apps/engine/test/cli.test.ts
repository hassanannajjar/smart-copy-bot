import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NO_KEY_MESSAGE, run } from '../src/discover/cli.js';
import { fakeBirdeye, fakeSolanaTracker } from './fakes.js';

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};

describe('wallets:discover cli', () => {
  it('without keys: exits 1 with one clear line and no stack trace', async () => {
    const c = capture();
    expect(await run([], { HELIUS_API_KEY: 'x' }, c.io)).toBe(1);
    expect(c.err).toEqual([NO_KEY_MESSAGE]);
    expect(c.out).toEqual([]);
  });

  it('writes only wallets.candidates.csv and prints the verified/unverified counts', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'scb-cli-'));
    const c = capture();
    const code = await run(
      [],
      { BIRDEYE_API_KEY: 'k', SOLANATRACKER_API_KEY: 'k', DATA_DIR: dataDir },
      c.io,
      () => ({ st: fakeSolanaTracker(), be: fakeBirdeye() }),
    );
    expect(code).toBe(0);
    expect(existsSync(join(dataDir, 'wallets.csv'))).toBe(false);
    const csv = readFileSync(join(dataDir, 'wallets.candidates.csv'), 'utf8');
    expect(csv.split('\n')[0]).toContain('pnl_per_trade');
    const report = c.out.join('\n');
    expect(report).toMatch(/VERIFIED: 0 {3}UNVERIFIED: 1/);
    expect(report).toContain('1JKP3jcMcBzpp5SUSj9DFMFZGiJiXLyuRyGYcf6E97z');
  });

  it('exits 1 with provider errors (no stack) when every provider fails', async () => {
    const c = capture();
    const fail = (m: string) => async () => Promise.reject(new Error(m));
    const code = await run([], { BIRDEYE_API_KEY: 'k' }, c.io, () => ({
      be: { gainers: fail('birdeye 401 GET /trader/gainers-losers'), identities: fail('x') },
    }));
    expect(code).toBe(1);
    expect(c.err.join('\n')).toContain(
      'All providers failed: birdeye 401 GET /trader/gainers-losers',
    );
    expect(c.err.join('\n')).not.toMatch(/\n\s+at /);
  });
});
