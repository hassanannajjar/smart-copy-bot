import { join } from 'node:path';

export const MODES = ['DEMO', 'PAPER', 'LIVE'] as const;
export type Mode = (typeof MODES)[number];

/** Trading data for each mode lives in its own file so fake/simulated PnL never mixes with real. */
export const modeDbPath = (dataDir: string, mode: Mode) =>
  join(dataDir, `${mode.toLowerCase()}.db`);

/** Single source of truth for requested/active mode, kill switch and the mode audit log. */
export const controlDbPath = (dataDir: string) => join(dataDir, 'control.db');
