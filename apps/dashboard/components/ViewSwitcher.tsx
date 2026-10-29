'use client';

import type { Mode } from '@scb/shared';
import { useTransition } from 'react';
import { setTheme, setView } from '../app/actions';

// Local copy: a runtime import of @scb/shared would bundle better-sqlite3 into the browser.
const VIEWS: readonly Mode[] = ['DEMO', 'PAPER', 'LIVE'];

export function ViewSwitcher({ view, theme }: { view: Mode; theme: 'dark' | 'light' }) {
  const [pending, start] = useTransition();
  return (
    <div className="viewswitch">
      <fieldset className="seg" aria-label="Data view">
        <legend>Data</legend>
        {VIEWS.map((m) => (
          <button
            key={m}
            type="button"
            className={m === view ? `on v-${m}` : ''}
            aria-pressed={m === view}
            disabled={pending || m === view}
            onClick={() => start(() => setView(m))}
          >
            {m}
          </button>
        ))}
      </fieldset>
      <button
        type="button"
        className="btn ghost"
        disabled={pending}
        onClick={() => start(() => setTheme(theme === 'dark' ? 'light' : 'dark'))}
      >
        {theme === 'dark' ? 'Light theme' : 'Dark theme'}
      </button>
    </div>
  );
}
