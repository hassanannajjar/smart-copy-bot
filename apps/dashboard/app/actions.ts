'use server';

import { MODES } from '@scb/shared';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { requestLive, requestPaper, setKillSwitch } from '../lib/control';
import { paths } from '../lib/paths';
import { THEME_COOKIE, VIEW_COOKIE } from '../lib/view';

const done = () => revalidatePath('/', 'layout');
const cookie = { path: '/', sameSite: 'strict', httpOnly: true } as const;

/** Switches the data view (cookie only). */
export async function setView(view: string) {
  const v = z.enum(MODES).parse(view);
  (await cookies()).set(VIEW_COOKIE, v, cookie);
  done();
}

/** Switches the display theme (cookie only). */
export async function setTheme(theme: string) {
  (await cookies()).set(THEME_COOKIE, z.enum(['dark', 'light']).parse(theme), cookie);
  done();
}

/** Asks for an engine mode. PAPER is accepted; LIVE is logged and rejected until M7. */
export async function requestEngineMode(to: string) {
  const mode = z.enum(['PAPER', 'LIVE']).parse(to);
  if (mode === 'PAPER') requestPaper(paths.control);
  else requestLive(paths.control);
  done();
}

export async function killSwitch(on: boolean) {
  setKillSwitch(paths.control, z.boolean().parse(on));
  done();
}
