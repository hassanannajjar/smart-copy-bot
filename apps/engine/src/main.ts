import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  controlDbPath,
  createHeliusRpc,
  createHeliusStream,
  isLiveArmed,
  loadConfig,
  modeDbPath,
  openControlDb,
  openTradingDb,
  parseEnv,
} from '@scb/shared';
import pino from 'pino';
import { bootToPaper } from './boot.js';
import { fixtureRecorder } from './discover/cli.js';
import { createProviders } from './rules/enrich.js';
import { startRules } from './rules/stage.js';
import { startScout } from './scout/scout.js';
import { loadWallets, syncWallets } from './scout/wallets.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const env = parseEnv();
// Never log env values: API keys live there. The redact paths are a second line of defence.
const log = pino({ level: env.LOG_LEVEL, redact: ['apiKey', '*.apiKey', 'url', '*.url'] });

if (!env.HELIUS_API_KEY) {
  console.error('HELIUS_API_KEY is not set. Add it to .env, then re-run.');
  process.exit(1);
}
const apiKey = env.HELIUS_API_KEY;

// Invalid config or wallets.csv throws here and the process exits non-zero: fail closed.
const config = loadConfig(env.RULES_PATH);
const cfg = config.scout;
const walletRows = loadWallets(join(env.DATA_DIR, 'wallets.csv'));

const control = openControlDb(controlDbPath(env.DATA_DIR));
const { previous, killSwitch } = bootToPaper(control);
control.$client.close();
// The scout keeps recording with the kill switch on; it only blocks opening positions (M3+).
if (killSwitch) log.warn('kill_switch is ON: no positions will be opened until it is cleared');

// The engine always writes PAPER data to paper.db. DEMO is dashboard-only; LIVE is M7.
const paperPath = modeDbPath(env.DATA_DIR, 'PAPER');
const db = openTradingDb(paperPath);
syncWallets(db, walletRows);

const record = process.argv.includes('--record')
  ? fixtureRecorder('helius', undefined, 'pnpm start --record')
  : undefined;
const onRateLimited = (i: { provider: string; path: string; attempt: number }) =>
  log.warn(i, 'provider 429, backing off');

// Rules stage (M2): every new signal, plus any left undecided by an earlier run.
const rules = startRules({
  db,
  config,
  providers: createProviders(config, apiKey, onRateLimited),
  log: log.child({ stage: 'rules' }),
});
rules.submitPending();

const scout = startScout({
  stream: createHeliusStream({
    apiKey,
    commitment: cfg.commitment,
    pingIntervalMs: cfg.ping_interval_ms,
    livenessTimeoutMs: cfg.liveness_timeout_s * 1000,
    reconnectBaseMs: cfg.reconnect_base_ms,
    reconnectMaxMs: cfg.reconnect_max_ms,
  }),
  rpc: createHeliusRpc({
    apiKey,
    commitment: cfg.commitment,
    minIntervalMs: cfg.rpc.min_interval_ms,
    timeoutMs: cfg.rpc.timeout_ms,
    retries: cfg.rpc.retries,
    onRateLimited,
  }),
  db,
  wallets: walletRows.map((w) => w.address),
  cfg,
  ignoredMints: config.prefilters.ignored_mints,
  log: log.child({ stage: 'scout' }),
  rawDir: join(env.DATA_DIR, 'raw'),
  record,
  onSignal: (id) => rules.submit(id),
});

log.info(
  {
    mode: 'PAPER',
    previousMode: previous,
    db: paperPath,
    wallets: walletRows.length,
    liveArmed: isLiveArmed(env),
    killSwitch,
    record: Boolean(record),
  },
  'engine booted, scout and rules started',
);

const shutdown = async () => {
  scout.stop();
  await scout.idle();
  rules.stop(); // queued signals stay undecided and are picked up on the next boot
  await rules.idle();
  db.$client.close();
  log.info('engine stopped');
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
