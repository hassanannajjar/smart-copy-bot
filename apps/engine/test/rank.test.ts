import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@scb/shared';
import { describe, expect, it } from 'vitest';
import {
  type Candidate,
  compareCandidates,
  csvCell,
  filterRows,
  mergeRows,
  toCsv,
  topTokenShare,
  type WindowRow,
  writeCandidates,
} from '../src/discover/rank.js';

const cfg = loadConfig('config/rules.yaml').discovery;
const A = (n: number) => `${'A'.repeat(43)}${'BCDEFGHJKL'[n]}`; // valid base58, 44 chars

const row = (over: Partial<WindowRow>): WindowRow => ({
  address: A(0),
  source: 'solanatracker',
  windowDays: 30,
  realizedPnl: 1000,
  winRate: 60,
  trades: 100,
  label: null,
  labels: [],
  ...over,
});

const cand = (over: Partial<Candidate>): Candidate => ({
  address: A(0),
  label: '',
  sources: ['solanatracker'],
  windows: [30],
  realizedPnl: 1000,
  winRate: 50,
  trades: 100,
  topTokenPct: null,
  topTokenPartial: false,
  verified: true,
  ...over,
});

describe('filterRows', () => {
  it('drops each bad row with its reason', () => {
    const { kept, dropped } = filterRows(
      [
        row({ address: A(1), labels: ['arbitrage'] }),
        row({ address: A(2), labels: ['exchange'], source: 'birdeye' }),
        row({ address: A(3), trades: 30 * cfg.max_trades_per_day + 1 }),
        row({ address: A(4), realizedPnl: -5 }),
        row({ address: A(5), realizedPnl: null }),
        row({ address: 'not-an-address' }),
        row({ address: A(6) }),
      ],
      cfg,
    );
    expect(kept.map((r) => r.address)).toEqual([A(6)]);
    expect(dropped).toEqual({
      identity_arbitrage: 1,
      identity_exchange: 1,
      bot_trade_rate: 1,
      unprofitable: 2,
      invalid_address: 1,
    });
  });

  it('a flag from one provider drops the other provider rows for that address', () => {
    const { kept, dropped } = filterRows(
      [row({ source: 'birdeye', labels: ['program'] }), row({ windowDays: 90 })],
      cfg,
    );
    expect(kept).toEqual([]);
    expect(dropped).toEqual({ identity_program: 2 });
  });
});

describe('mergeRows', () => {
  it('merges windows and sources; metrics from the longest window, ST preferred', () => {
    const [c] = mergeRows([
      row({ windowDays: 30, realizedPnl: 100, winRate: 70 }),
      row({ windowDays: 90, source: 'birdeye', realizedPnl: 900, winRate: null, trades: 400 }),
      row({ windowDays: 90, realizedPnl: 500, winRate: 55, trades: 300, label: 'whale' }),
    ]);
    expect(c).toMatchObject({
      sources: ['birdeye', 'solanatracker'],
      windows: [30, 90],
      realizedPnl: 500,
      winRate: 55,
      trades: 300,
      label: 'whale',
      verified: false,
    });
  });
});

describe('compareCandidates', () => {
  it('orders tiers, then win rate (missing last), then realized PnL', () => {
    const list = [
      cand({
        address: 'unverified-best',
        verified: false,
        windows: [30, 90],
        winRate: 99,
        realizedPnl: 1e9,
      }),
      cand({ address: 'one-window', winRate: 90 }),
      cand({ address: 'both-windows-low-wr', windows: [30, 90], winRate: 40 }),
      cand({ address: 'both-windows-no-wr', windows: [30, 90], winRate: null, realizedPnl: 1e8 }),
      cand({ address: 'both-windows-high-wr', windows: [30, 90], winRate: 80 }),
      cand({
        address: 'both-sources',
        windows: [30, 90],
        sources: ['birdeye', 'solanatracker'],
        winRate: 10,
      }),
      cand({
        address: 'both-windows-high-wr-richer',
        windows: [30, 90],
        winRate: 80,
        realizedPnl: 5000,
      }),
    ];
    expect(list.sort(compareCandidates(2)).map((c) => c.address)).toEqual([
      'both-sources',
      'both-windows-high-wr-richer',
      'both-windows-high-wr',
      'both-windows-low-wr',
      'both-windows-no-wr',
      'one-window',
      'unverified-best',
    ]);
  });
});

describe('topTokenShare', () => {
  it('is the largest win over total wins, ignoring losses and nulls', () => {
    expect(topTokenShare([300, 100, -500, null, 100])).toBe(60);
    expect(topTokenShare([-1, null])).toBeNull();
    expect(topTokenShare([])).toBeNull();
  });
});

describe('csv', () => {
  it('quotes and neutralizes formulas', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-5')).toBe("'-5");
  });

  it('writes the agreed columns, with pnl_per_trade and blanks for unknowns', () => {
    const csv = toCsv([
      cand({
        label: 'x',
        windows: [30, 90],
        realizedPnl: 1000,
        trades: 50,
        topTokenPct: 12.345,
        topTokenPartial: true,
      }),
      cand({ address: A(1), sources: ['birdeye'], winRate: null, trades: null, verified: false }),
    ]);
    const [header, first, second] = csv.trim().split('\n');
    expect(header).toBe(
      'address,label,source,window,realized_pnl,win_rate,trades,pnl_per_trade,top_token_pct,top_token_partial,verified',
    );
    expect(first).toBe(`${A(0)},x,solanatracker,30d+90d,1000.00,50.00,50,20.00,12.35,true,true`);
    expect(second).toBe(`${A(1)},,birdeye,30d,1000.00,,,,,false,false`);
  });

  it('refuses to write anything but wallets.candidates.csv', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scb-csv-'));
    expect(() => writeCandidates(join(dir, 'wallets.csv'), 'x')).toThrow(/refusing/);
    expect(() => writeCandidates(join(dir, 'wallets.candidates.csv'), 'x')).not.toThrow();
  });
});
