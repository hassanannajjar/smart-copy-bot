import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { controlDbPath, type Mode, modeDbPath, parseEnv } from '@scb/shared';

// Next runs with cwd=apps/dashboard, but DATA_DIR/RULES_PATH are relative to the repo root.
const findRoot = (dir: string): string => {
  if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
  const up = dirname(dir);
  if (up === dir) throw new Error('repo root (pnpm-workspace.yaml) not found');
  return findRoot(up);
};

const root = findRoot(process.cwd());
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));
const env = parseEnv();
const dataDir = resolve(root, env.DATA_DIR);

export const paths = {
  control: controlDbPath(dataDir),
  view: (mode: Mode) => modeDbPath(dataDir, mode),
  rules: resolve(root, env.RULES_PATH),
};
