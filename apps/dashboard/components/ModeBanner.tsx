import type { Mode } from '@scb/shared';
import { killSwitch } from '../app/actions';
import type { ModeState } from '../lib/control';
import { usd } from '../lib/format';
import type { Heartbeat } from '../lib/trading';

const ago = (t: number | null) => (t ? `${Math.round((Date.now() - t) / 1000)}s ago` : 'never');

const VIEW_TEXT: Record<Mode, string> = {
  DEMO: 'DEMO data — not real',
  PAPER: 'PAPER data — simulated money',
  LIVE: 'LIVE data — real funds',
};

type Props = {
  engine: ModeState;
  error: string | null;
  heartbeat: Heartbeat | null;
  live: { todayPnlUsd: number; lossRemainingUsd: number } | null;
  view: Mode;
};

/** The engine-mode banner is always shown, whatever data view is selected. */
export function ModeBanner({ engine, error, heartbeat, live, view }: Props) {
  const isLive = engine.active === 'LIVE';
  return (
    <>
      <div className={isLive ? 'banner live' : 'banner paper'}>
        {isLive ? (
          <>
            <b>LIVE — REAL FUNDS</b>
            {/* ponytail: wallet address and balance arrive with the M7 engine status channel */}
            <span>Wallet: not reported (M7)</span>
            <span>Balance: —</span>
            {live && <span>Today: {usd(live.todayPnlUsd)}</span>}
            {live && <span>Loss limit left: {usd(live.lossRemainingUsd)}</span>}
            <form action={killSwitch.bind(null, true)}>
              <button type="submit" className="kill">
                STOP
              </button>
            </form>
          </>
        ) : (
          <b>PAPER TRADING — real market data, simulated money</b>
        )}
        <span>
          Heartbeat: {ago(heartbeat?.lastEventAt ?? null)} · Last signal:{' '}
          {ago(heartbeat?.lastSignalAt ?? null)}
        </span>
        {engine.killSwitch && <b className="notice">KILL SWITCH ON — no new positions</b>}
        {error && <b className="notice">{error}</b>}
      </div>
      <div className={`viewstrip view-${view}`}>Viewing: {VIEW_TEXT[view]}</div>
    </>
  );
}
