import type { Mode } from '@scb/shared';
import type { ModeState } from '../lib/control';
import { ago, dur, stale, usd } from '../lib/format';
import type { Health, Heartbeat } from '../lib/trading';
import { EngineControls } from './EngineControls';

const VIEW_TEXT: Record<Mode, string> = {
  DEMO: 'DEMO data — not real',
  PAPER: 'PAPER data — simulated money',
  LIVE: 'LIVE data — real funds',
};

export type Limits = { heartbeatMs: number; livenessS: number } | null;

type Props = {
  engine: ModeState;
  error: string | null;
  heartbeat: Heartbeat | null;
  health: Health | null;
  limits: Limits;
  live: { todayPnlUsd: number; lossRemainingUsd: number } | null;
  view: Mode;
  gate: { open: boolean; reason: string };
};

/** The engine strip and data-view strip: always shown and sticky, whatever view is selected. */
export function ModeBanner({ engine, error, heartbeat, health, limits, live, view, gate }: Props) {
  const isLive = engine.active === 'LIVE';
  const now = Date.now();
  const hbAt = health?.heartbeatAt ?? null;
  const hbStale = stale(hbAt === null ? null : now - hbAt, limits && 2 * limits.heartbeatMs);
  const ws = health?.notificationAgeS ?? null;
  const wsStale = stale(ws === null ? null : ws * 1000, limits && limits.livenessS * 1000);
  return (
    <div className="sticky">
      <div className={isLive ? 'strip live' : 'strip'} role="status">
        <b className="engine">{isLive ? 'LIVE — REAL FUNDS' : 'ENGINE PAPER'}</b>
        <span className={hbStale ? 'metric bad' : 'metric ok'}>
          <i className="dot" aria-hidden /> heartbeat {ago(hbAt, now)}
        </span>
        <span className={wsStale ? 'metric bad' : 'metric'}>
          ws msg {ws === null ? '—' : `${dur(ws)} ago`}
        </span>
        <span className="metric dim">last signal {ago(heartbeat?.lastSignalAt ?? null, now)}</span>
        {isLive && (
          <>
            {/* ponytail: wallet address and balance arrive with the M7 engine status channel */}
            <span className="metric">wallet: not reported (M7)</span>
            {live && <span className="metric">today {usd(live.todayPnlUsd)}</span>}
            {live && <span className="metric">loss limit left {usd(live.lossRemainingUsd)}</span>}
          </>
        )}
        <EngineControls engine={engine} gate={gate} />
      </div>
      {engine.killSwitch && (
        <div className="notice">KILL SWITCH ON — no new positions open until it is released</div>
      )}
      {error && <div className="notice">{error}</div>}
      <div className={`viewstrip view-${view}`}>
        Viewing: <b>{VIEW_TEXT[view]}</b>
        {view !== engine.active && <span> · engine is running {engine.active}</span>}
      </div>
    </div>
  );
}
