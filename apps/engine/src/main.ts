import { existsSync } from 'node:fs';
import {
  controlDbPath,
  isLiveArmed,
  loadConfig,
  modeDbPath,
  openControlDb,
  openTradingDb,
  parseEnv,
} from '@scb/shared';
import pino from 'pino';
import { bootToPaper } from './boot.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const env = parseEnv();
const log = pino({ level: env.LOG_LEVEL });

// Invalid config throws here and the process exits non-zero: fail closed.
loadConfig(env.RULES_PATH);

const control = openControlDb(controlDbPath(env.DATA_DIR));
const { previous, killSwitch } = bootToPaper(control);
if (killSwitch) log.warn('kill_switch is ON: no positions will be opened until it is cleared');

const paperPath = modeDbPath(env.DATA_DIR, 'PAPER');
openTradingDb(paperPath).$client.close();
control.$client.close();

// Never log env values: API keys live there.
log.info(
  { mode: 'PAPER', previousMode: previous, db: paperPath, liveArmed: isLiveArmed(env), killSwitch },
  'engine booted (M0: no pipeline yet)',
);
