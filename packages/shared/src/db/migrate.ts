import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { parseEnv } from '../env.js';
import { controlDbPath, MODES, modeDbPath } from '../mode.js';
import { openControlDb, openTradingDb } from './open.js';

const folder = (name: string) => fileURLToPath(new URL(`../../drizzle/${name}`, import.meta.url));

/** Creates/upgrades control.db plus demo/paper/live.db. Idempotent; never drops data. */
export const migrateAll = (dataDir: string) => {
  const paths = [controlDbPath(dataDir)];
  const control = openControlDb(paths[0] as string);
  migrate(control, { migrationsFolder: folder('control') });
  control.$client.close();

  for (const mode of MODES) {
    const path = modeDbPath(dataDir, mode);
    const db = openTradingDb(path);
    migrate(db, { migrationsFolder: folder('trading') });
    db.$client.close();
    paths.push(path);
  }
  return paths;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (existsSync('.env')) process.loadEnvFile('.env');
  for (const path of migrateAll(parseEnv().DATA_DIR)) console.log(`migrated ${path}`);
}
