'use client';

import { useTransition } from 'react';
import { killSwitch, requestEngineMode } from '../app/actions';
import type { ModeState } from '../lib/control';
import { nextKillSwitch } from '../lib/kill';

type Props = { engine: ModeState; gate: { open: boolean; reason: string } };

/** Lives in the sticky engine strip: kill switch (one click to engage) and the engine-mode request. */
export function EngineControls({ engine, gate }: Props) {
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<void>) => start(() => fn());
  return (
    <div className="controls">
      {engine.active === 'LIVE' ? (
        <button
          type="button"
          className="btn"
          disabled={pending}
          onClick={() => run(() => requestEngineMode('PAPER'))}
        >
          Switch to PAPER
        </button>
      ) : (
        // ponytail: no type-LIVE confirm dialog yet; the gate is hard-closed until M7, which adds it.
        <details className="gate">
          <summary>
            <button type="button" className="btn" disabled>
              Request LIVE
            </button>
            <span className="why">locked — why?</span>
          </summary>
          <p>{gate.reason}</p>
        </details>
      )}
      <button
        type="button"
        className={engine.killSwitch ? 'kill engaged' : 'kill'}
        disabled={pending && engine.killSwitch}
        onClick={() => {
          const next = nextKillSwitch(engine.killSwitch, confirm);
          if (next !== null) run(() => killSwitch(next));
        }}
      >
        {engine.killSwitch ? 'Release kill switch' : 'KILL SWITCH'}
      </button>
    </div>
  );
}
