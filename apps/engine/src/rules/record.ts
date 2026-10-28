// `pnpm rules:record <mint...>`: fetch every M2 provider for each mint, write the responses as
// fixtures (packages/shared/test/fixtures/<provider>/), and print the rule results. Standalone:
// never starts the engine, never opens a DB, never touches data/.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type HeliusTx, loadConfig, parseEnv } from '@scb/shared';
import { FIXTURES_DIR, fixtureRecorder } from '../discover/cli.js';
import { buildSnapshot, createProviders, fetchCandles, fetchForMint } from './enrich.js';
import { evaluate } from './rules.js';

const BY = 'pnpm rules:record';
const mints = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (mints.length === 0) {
  console.error('usage: pnpm rules:record <mint> [mint...]');
  process.exit(1);
}
if (existsSync('.env')) process.loadEnvFile('.env');
const env = parseEnv();
if (!env.HELIUS_API_KEY) {
  console.error('HELIUS_API_KEY is not set (needed for the R4 launch window). Add it to .env.');
  process.exit(1);
}
const config = loadConfig(env.RULES_PATH);
const recorders = new Map<string, ReturnType<typeof fixtureRecorder>>();
const providers = createProviders(
  config,
  env.HELIUS_API_KEY,
  (i) =>
    console.error(`warn: ${i.provider} 429 on ${i.path} (attempt ${i.attempt + 1}), backing off`),
  (provider) => {
    const r = recorders.get(provider) ?? fixtureRecorder(provider, FIXTURES_DIR, BY);
    recorders.set(provider, r);
    return r;
  },
);

// The Helius client keeps the API key in the URL, so its calls aren't recorded by createHttp.
// The launch window is written here, reduced to what launchBundle reads: the fee payer's
// account key, SOL balances and token balances (full txs are ~16 KB each, ~5 KB schema-stripped).
const feePayerView = (tx: HeliusTx): HeliusTx => {
  const payer = tx.transaction.message.accountKeys[0];
  const own = (b: HeliusTx['meta']['preTokenBalances']) =>
    (b ?? []).filter((x) => x.owner === payer?.pubkey);
  return {
    ...tx,
    meta: {
      ...tx.meta,
      preBalances: tx.meta.preBalances.slice(0, 1),
      postBalances: tx.meta.postBalances.slice(0, 1),
      preTokenBalances: own(tx.meta.preTokenBalances),
      postTokenBalances: own(tx.meta.postTokenBalances),
    },
    transaction: { ...tx.transaction, message: { accountKeys: payer ? [payer] : [] } },
  };
};
const helius = providers.helius;
providers.helius = {
  ...helius,
  transactionsForAddress: async (address, o) => {
    const res = await helius.transactionsForAddress(address, o);
    const dir = join(FIXTURES_DIR, 'helius');
    mkdirSync(dir, { recursive: true });
    const fixture = {
      _provenance: `recorded ${new Date().toISOString()} by ${BY} (reduced to the fee payer's balances)`,
      request: {
        method: 'POST',
        path: 'getTransactionsForAddress',
        query: {},
        body: { address, ...o },
      },
      response: {
        jsonrpc: '2.0',
        id: 1,
        result: { data: res.txs.map(feePayerView), paginationToken: null },
      },
      truncated: res.truncated,
    };
    writeFileSync(join(dir, `launch-${address.slice(0, 8)}.json`), `${JSON.stringify(fixture)}\n`);
    return res;
  },
};

for (const mint of mints) {
  // Always fetch R5's candles here (the engine defers them) so every fixture gets recorded.
  const fetched = await fetchForMint(mint, providers, config);
  await fetchCandles(mint, fetched, providers, config);
  const { f } = fetched;
  const takenAt = Date.now();
  const s = buildSnapshot(mint, f, takenAt, config);
  const ev = evaluate(s, config.rules, config.data.max_snapshot_age_s, takenAt);
  console.log(`\n${mint}: ${ev.verdict}${ev.killedBy ? ` (${ev.killedBy})` : ''}`);
  if (Object.keys(s.errors).length) console.log('  errors:', JSON.stringify(s.errors));
  for (const r of ev.results)
    console.log(
      `  ${r.ruleId} ${r.passed ? 'pass' : 'FAIL'} value=${r.value} ${r.threshold} ${r.reason ?? ''}`,
    );
}
