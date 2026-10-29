// `pnpm wallets:discover [--record]`: writes data/wallets.candidates.csv and prints a ranked report.
// Never writes data/wallets.csv. Never prints API keys or stack traces.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type BirdeyeApi,
  type Config,
  createBirdeyeApi,
  createHeliusRpc,
  createSolanaTrackerApi,
  type Env,
  loadConfig,
  parseEnv,
  type RecordedCall,
  type SolanaTrackerApi,
} from '@scb/shared';
import { type DiscoveryResult, discover, type HeliusCheck } from './discover.js';
import {
  CANDIDATES_FILE,
  type Candidate,
  type DiscoveryConfig,
  median,
  pnlPerTrade,
  toCsv,
  writeCandidates,
} from './rank.js';

export const NO_KEY_MESSAGE =
  'No provider key set. Add SOLANATRACKER_API_KEY (leaderboard + top-token check) and/or BIRDEYE_API_KEY to .env, then re-run.';

export const FIXTURES_DIR = 'packages/shared/test/fixtures';

interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

/** --record: keep the first raw response per provider + fixture name, in the fixture envelope. */
export const fixtureRecorder = (
  provider: string,
  dir = FIXTURES_DIR,
  by = 'pnpm wallets:discover --record',
) => {
  const seen = new Set<string>();
  return (call: RecordedCall) => {
    if (seen.has(call.name)) return;
    seen.add(call.name);
    mkdirSync(join(dir, provider), { recursive: true });
    const envelope = {
      _provenance: `recorded ${new Date().toISOString()} by ${by}`,
      request: call.request,
      response: call.response,
    };
    writeFileSync(
      join(dir, provider, `${call.name}.json`),
      `${JSON.stringify(envelope, null, 2)}\n`,
    );
  };
};

export const buildApis = (env: Env, config: Config, io: Io, record: boolean) => {
  const cfg = config.discovery;
  const onRateLimited = (i: { provider: string; path: string; attempt: number }) =>
    io.err(`warn: ${i.provider} 429 on ${i.path} (attempt ${i.attempt + 1}), backing off`);
  const st: SolanaTrackerApi | undefined = env.SOLANATRACKER_API_KEY
    ? createSolanaTrackerApi({
        apiKey: env.SOLANATRACKER_API_KEY,
        ...limits(cfg.solanatracker),
        onRateLimited,
        record: record ? fixtureRecorder('solanatracker') : undefined,
      })
    : undefined;
  const be: BirdeyeApi | undefined = env.BIRDEYE_API_KEY
    ? createBirdeyeApi({
        apiKey: env.BIRDEYE_API_KEY,
        ...limits(cfg.birdeye),
        onRateLimited,
        record: record ? fixtureRecorder('birdeye') : undefined,
      })
    : undefined;
  const helius: HeliusCheck | undefined = env.HELIUS_API_KEY
    ? {
        rpc: createHeliusRpc({
          apiKey: env.HELIUS_API_KEY,
          commitment: config.scout.commitment,
          ...limits(cfg.helius),
          onRateLimited,
        }),
        quoteMint: config.scout.quote_mint,
        ignoredMints: config.prefilters.ignored_mints,
      }
    : undefined;
  return { st, be, helius };
};

const limits = (l: DiscoveryConfig['solanatracker']) => ({
  minIntervalMs: l.min_interval_ms,
  timeoutMs: l.timeout_ms,
  retries: l.retries,
});

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const money = (v: number | null) => (v === null ? '-' : Math.round(v).toLocaleString('en-US'));
const pct = (v: number | null) => (v === null ? '-' : `${v.toFixed(1)}%`);

const reportRow = (c: Candidate, rank: number, now: number) =>
  [
    String(rank).padStart(3),
    c.address.padEnd(44),
    short(c.label || '-', 14).padEnd(14),
    c.windows
      .map((w) => `${w}d`)
      .join('+')
      .padEnd(7),
    c.sources
      .map((s) => (s === 'solanatracker' ? 'ST' : 'BE'))
      .join('+')
      .padEnd(5),
    money(c.realizedPnl).padStart(12),
    pct(c.winRate).padStart(6),
    String(c.trades ?? '-').padStart(6),
    money(pnlPerTrade(c)).padStart(9),
    num1(c.tradesPerDay).padStart(6),
    money(c.avgTradeUsd).padStart(7),
    (c.medianHoldS === null ? '-' : String(Math.round(c.medianHoldS))).padStart(6),
    `${pct(c.topTokenPct)}${c.topTokenPartial ? '~' : ''}`.padStart(7),
    (c.verified ? 'yes' : 'no').padEnd(3),
    (c.identitySource === 'onchain' ? 'onc' : c.identityChecked ? 'yes' : 'no').padEnd(3),
    (c.lastSwapAt === null ? '-' : `${num1((now - c.lastSwapAt) / 3_600_000)}h`).padStart(7),
    pct(c.solQuotePct).padStart(6),
    (c.medianSwapSol === null ? '-' : c.medianSwapSol.toFixed(2)).padStart(7),
    (c.distinctMintRatio === null ? '-' : c.distinctMintRatio.toFixed(2)).padStart(6),
    c.starter ? 'yes' : 'no',
  ].join('  ');

const num1 = (v: number | null) => (v === null ? '-' : v.toFixed(1));

/** Medians over the final list: a quick read on whether it looks like humans or bots. */
export const humanLikeness = (cs: Candidate[]) => {
  const holds = cs.map((c) => c.medianHoldS);
  return [
    `median trades/day ${num1(median(cs.map((c) => c.tradesPerDay)))}`,
    `median win% ${pct(median(cs.map((c) => c.winRate)))}`,
    `median pnl/trade $${money(median(cs.map(pnlPerTrade)))}`,
    `median avg trade $${money(median(cs.map((c) => c.avgTradeUsd)))}`,
    `median hold ${num1(median(holds))}s (n=${holds.filter((h) => h !== null).length} enriched)`,
  ].join(', ');
};

export const formatReport = (
  r: DiscoveryResult,
  cfg: DiscoveryConfig,
  outPath: string,
  now = Date.now(),
) => {
  const verified = r.candidates.filter((c) => c.verified).length;
  const bothWindows = r.candidates.filter(
    (c) => c.windows.length >= cfg.windows_days.length,
  ).length;
  const header = [
    '  #',
    'address'.padEnd(44),
    'label'.padEnd(14),
    'window'.padEnd(7),
    'src'.padEnd(5),
    'realized_usd'.padStart(12),
    'win%'.padStart(6),
    'trades'.padStart(6),
    'pnl/trade'.padStart(9),
    'tr/day'.padStart(6),
    'avg_tr$'.padStart(7),
    'hold_s'.padStart(6),
    'top_tok'.padStart(7),
    'ver',
    'id ',
    'swap_ago'.padStart(7),
    'sol_q%'.padStart(6),
    'med_sol'.padStart(7),
    'mint_r'.padStart(6),
    'starter',
  ].join('  ');
  const dropped = Object.entries(r.dropped)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  return [
    `Top ${Math.min(cfg.report_top, r.candidates.length)} of ${r.candidates.length} candidates`,
    header,
    ...r.candidates.slice(0, cfg.report_top).map((c, i) => reportRow(c, i + 1, now)),
    '',
    `providers: ${r.providers.map((p) => `${p.source}=${p.status}${p.status === 'ok' ? ` (${p.rows} rows)` : ''}${p.error ? ` [${p.error}]` : ''}`).join(', ')}`,
    `fetched rows: ${r.fetched}; dropped: ${dropped || 'none'}`,
    `candidates: ${r.candidates.length}; profitable in all windows: ${bothWindows}`,
    `VERIFIED: ${verified}   UNVERIFIED: ${r.candidates.length - verified} (no top-token check; ranked below verified)`,
    `human-likeness: ${humanLikeness(r.candidates)}`,
    `STARTER: ${r.candidates.filter((c) => c.starter).length} (identity on-chain: ${r.candidates.filter((c) => c.identitySource === 'onchain').length}; activity-checked: ${r.candidates.filter((c) => c.lastSwapAt !== null).length}; Helius calls = credits: ${r.heliusCalls})`,
    ...r.notes.map((n) => `note: ${n}`),
    'Scopes: realized/win%/tr/day = leaderboard window; win% = token win rate; top_tok + hold_s = all-time profitable positions, first page ("~" = partial); swap_ago + sol_q% + med_sol (median SOL swap) + mint_r (distinct mints / swaps) = Helius sample of recent txs.',
    `Wrote ${outPath}. Review by hand; copy chosen rows into data/wallets.csv yourself.`,
  ].join('\n');
};

export const run = async (
  argv: string[],
  source: Record<string, string | undefined>,
  io: Io,
  makeApis: typeof buildApis = buildApis,
): Promise<number> => {
  try {
    const env = parseEnv(source);
    if (!env.SOLANATRACKER_API_KEY && !env.BIRDEYE_API_KEY) {
      io.err(NO_KEY_MESSAGE);
      return 1;
    }
    const config = loadConfig(env.RULES_PATH);
    const cfg = config.discovery;
    const apis = makeApis(env, config, io, argv.includes('--record'));
    if (!apis.st)
      io.err(
        'note: SOLANATRACKER_API_KEY not set; skipping Solana Tracker (no top-token check, all rows unverified)',
      );
    if (!apis.be) io.err('note: BIRDEYE_API_KEY not set; skipping Birdeye');
    if (!apis.helius) io.err('note: HELIUS_API_KEY not set; no activity check, so no starter rows');

    const result = await discover(apis, cfg);
    for (const w of result.warnings) io.err(`warn: ${w}`);
    if (result.providers.every((p) => p.status !== 'ok')) {
      const errors = result.providers.filter((p) => p.status === 'failed').map((p) => p.error);
      io.err(`All providers failed: ${errors.join('; ')}`);
      return 1;
    }
    const outPath = join(env.DATA_DIR, CANDIDATES_FILE);
    mkdirSync(env.DATA_DIR, { recursive: true });
    writeCandidates(outPath, toCsv(result.candidates));
    io.out(formatReport(result, cfg, outPath));
    return 0;
  } catch (e) {
    // One line, no stack: messages here never contain keys (see providers/http.ts).
    io.err(`wallets:discover failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (existsSync('.env')) process.loadEnvFile('.env');
  process.exitCode = await run(process.argv.slice(2), process.env, {
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  });
}
