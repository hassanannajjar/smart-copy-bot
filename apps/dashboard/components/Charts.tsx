import { clock, signedUsd } from '../lib/format';
import type { DailyPnl, EquityPoint } from '../lib/trading';

const W = 600;
const H = 150;
const PAD = { l: 8, r: 64, t: 10, b: 18 };

/** Cumulative net PnL as a step line from 0, server-rendered SVG. */
export function EquityCurve({ points }: { points: EquityPoint[] }) {
  if (!points.length) return <p className="empty">No closed positions yet.</p>;
  const t0 = points[0]?.t ?? 0;
  const t1 = points.at(-1)?.t ?? t0;
  const vals = points.map((p) => p.cum);
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals);
  const x = (t: number) => PAD.l + (t1 === t0 ? 0.5 : (t - t0) / (t1 - t0)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (hi === lo ? 0.5 : (hi - v) / (hi - lo)) * (H - PAD.t - PAD.b);
  const d = `M${x(t0)},${y(0)}${points.map((p) => `H${x(p.t)}V${y(p.cum)}`).join('')}`;
  const last = vals.at(-1) ?? 0;
  const tone = last >= 0 ? 'pos' : 'neg';
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Cumulative net PnL">
      <line className="zero" x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} />
      <path className={`line ${tone}`} d={d} />
      <text className="axis" x={W - PAD.r + 6} y={y(hi) + 4}>
        {signedUsd(hi)}
      </text>
      {lo < 0 && (
        <text className="axis" x={W - PAD.r + 6} y={y(lo)}>
          {signedUsd(lo)}
        </text>
      )}
      <text className={`axis strong ${tone}`} x={W - PAD.r + 6} y={y(last) + 4}>
        {signedUsd(last)}
      </text>
      <text className="axis" x={PAD.l} y={H - 4}>
        {clock(t0)}
      </text>
      <text className="axis" x={W - PAD.r} y={H - 4} textAnchor="end">
        {clock(t1)}
      </text>
    </svg>
  );
}

/** Net PnL per local day; zero-filled so the bars line up with dates. */
export function DailyBars({ days }: { days: DailyPnl[] }) {
  const h = 90;
  const max = Math.max(0.01, ...days.map((d) => Math.abs(d.pnl)));
  const bw = (W - PAD.l - PAD.r) / Math.max(1, days.length);
  const mid = h / 2;
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${h + 16}`} role="img" aria-label="Daily net PnL">
      <line className="zero" x1={PAD.l} x2={W - PAD.r} y1={mid} y2={mid} />
      {days.map((d, i) => {
        const bh = (Math.abs(d.pnl) / max) * (mid - 4);
        return (
          <rect
            key={d.day}
            className={d.pnl >= 0 ? 'bar pos' : 'bar neg'}
            x={PAD.l + i * bw + 1}
            width={Math.max(1, bw - 2)}
            y={d.pnl >= 0 ? mid - bh : mid}
            height={Math.max(d.pnl === 0 ? 0 : 1, bh)}
          >
            <title>{`${d.day}: ${signedUsd(d.pnl)}`}</title>
          </rect>
        );
      })}
      <text className="axis" x={W - PAD.r + 6} y={mid - (mid - 4) + 8}>
        {signedUsd(max)}
      </text>
      <text className="axis" x={PAD.l} y={h + 12}>
        {days[0]?.day}
      </text>
      <text className="axis" x={W - PAD.r} y={h + 12} textAnchor="end">
        {days.at(-1)?.day}
      </text>
    </svg>
  );
}
