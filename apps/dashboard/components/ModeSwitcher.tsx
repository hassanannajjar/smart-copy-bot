'use client';

import type { Mode } from '@scb/shared';
import { useTransition } from 'react';
import { killSwitch, requestEngineMode, setView } from '../app/actions';
import type { ModeState } from '../lib/control';
import { nextKillSwitch } from '../lib/kill';

// Local copy: a runtime import of @scb/shared would bundle better-sqlite3 into the browser.
const VIEWS: readonly Mode[] = ['DEMO', 'PAPER', 'LIVE'];

type Props = { view: Mode; engine: ModeState; gate: { open: boolean; reason: string } };

export function ModeSwitcher({ view, engine, gate }: Props) {
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<void>) => start(() => fn());
  return (
    <div className="switcher">
      <span>
        View:{' '}
        {VIEWS.map((m) => (
          <button
            key={m}
            type="button"
            className={m === view ? 'on' : ''}
            disabled={pending || m === view}
            onClick={() => run(() => setView(m))}
          >
            {m}
          </button>
        ))}
      </span>
      <span>
        Engine: <b>{engine.active}</b>{' '}
        {engine.active === 'LIVE' && (
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => requestEngineMode('PAPER'))}
          >
            Switch to PAPER
          </button>
        )}
        {engine.active !== 'LIVE' && (
          // ponytail: no type-LIVE confirm dialog yet; the gate is hard-closed until M7, which adds it.
          <span title={gate.reason}>
            <button type="button" disabled>
              Request LIVE
            </button>{' '}
            <small className="reason">{gate.reason}</small>
          </span>
        )}
      </span>
      <button
        type="button"
        className={engine.killSwitch ? 'kill on' : 'kill'}
        disabled={pending && engine.killSwitch}
        onClick={() => {
          const next = nextKillSwitch(engine.killSwitch, confirm);
          if (next !== null) run(() => killSwitch(next));
        }}
      >
        {engine.killSwitch ? 'Release kill switch' : 'Kill switch'}
      </button>
    </div>
  );
}
