import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderError } from '@scb/shared';
import { describe, expect, it } from 'vitest';
import { NO_KEY_MESSAGE, run } from '../src/discover/cli.js';
import { CSV_COLUMNS } from '../src/discover/rank.js';
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

  it('writes only wallets.candidates.csv and prints counts, human-likeness and the identity note', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'scb-cli-'));
    const c = capture();
    const be = {
      ...fakeBirdeye(),
      identities: async () =>
        Promise.reject(new ProviderError('birdeye', 401, 'POST', '/identity/v1/multiple')),
    };
    const code = await run(
      [],
      { BIRDEYE_API_KEY: 'k', SOLANATRACKER_API_KEY: 'k', DATA_DIR: dataDir },
      c.io,
      () => ({ st: fakeSolanaTracker(), be }),
    );
    expect(code).toBe(0);
    expect(existsSync(join(dataDir, 'wallets.csv'))).toBe(false);
    const csv = readFileSync(join(dataDir, 'wallets.candidates.csv'), 'utf8');
    expect(csv.split('\n')[0]).toBe(CSV_COLUMNS.join(','));
    const report = c.out.join('\n');
    expect(report).toMatch(/VERIFIED: \d+ {3}UNVERIFIED: \d+/);
    expect(report).toMatch(
      /human-likeness: median trades\/day [\d.-]+, median win% \S+, median pnl\/trade \$\S+, median avg trade \$\S+, median hold \S+s \(n=\d+ enriched\)/,
    );
    expect(report.match(/note: Birdeye identity unavailable on this plan \(401\)/g)).toHaveLength(
      1,
    );
    expect(c.err.filter((l) => l.includes('identity'))).toEqual([]);
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
