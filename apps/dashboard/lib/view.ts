import { MODES, type Mode } from '@scb/shared';
import { cookies } from 'next/headers';
import { type ModeState, readModeState } from './control';
import { paths } from './paths';

export const VIEW_COOKIE = 'scb_view';

/** The data view is a cookie only; it never touches control.db. Anything unknown reads as PAPER. */
export const getView = async (): Promise<Mode> => {
  const v = (await cookies()).get(VIEW_COOKIE)?.value;
  return MODES.includes(v as Mode) ? (v as Mode) : 'PAPER';
};

/** Engine state from control.db; a missing/unreadable DB reads as PAPER with the error shown. */
export const engineState = (): { state: ModeState; error: string | null } => {
  try {
    return { state: readModeState(paths.control), error: null };
  } catch (e) {
    return {
      state: { requested: 'PAPER', active: 'PAPER', killSwitch: false },
      error: `control.db unreadable (${(e as Error).message}) — run pnpm db:migrate`,
    };
  }
};
