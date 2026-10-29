import type { Config, Mode } from '@scb/shared';
import { describeEvent, type EventRow } from '../lib/events';
import {
  ago,
  clock,
  dur,
  pct,
  price,
  short,
  signedPct,
  signedUsd,
  stale,
  tzLabel,
  usd,
} from '../lib/format';
import { reasonLabel } from '../lib/labels';
import {
  type CopyRow,
  type DailyPnl,
  type EquityPoint,
  type FunnelStep,
  type Health,
  type KillReason,
  type OpenPosition,
  type Overview,
  type SignalRow,
  solscan,
} from '../lib/trading';
import { Card } from './Card';
import { DailyBars, EquityCurve } from './Charts';

type P = { view: Mode };
const tone = (n: number | null) => (n === null ? '' : n > 0 ? 'pos' : n < 0 ? 'neg' : '');

const Sol = ({ kind, id, text }: { kind: keyof typeof solscan; id: string; text?: string }) => (
  <a href={solscan[kind](id)} target="_blank" rel="noreferrer" title={id}>
    {text ?? short(id)}
  </a>
);

const Wallet = ({ address, label }: { address: string | null; label: string | null }) =>
  address ? (
    <>
      {label && <span className="label">{label}</span>} <Sol kind="account" id={address} />
    </>
  ) : (
    '—'
  );

export function Kpis({ view, o, open }: P & { o: Overview; open: number }) {
  const stats: [string, string | number, string?][] = [
    ['Net PnL', signedUsd(o.netPnlUsd), tone(o.netPnlUsd)],
    ['Win rate', pct(o.winRate)],
    ['Return', o.returnMultiple === null ? '—' : `${o.returnMultiple.toFixed(2)}×`],
    ['Open', open],
    ['Closed', o.closed],
    ['Signals', o.signals],
    ['Passed', o.passed],
    ['Killed', o.killed],
    ['Wallets', o.wallets],
  ];
  return (
    <section className={`kpis v-${view}`} aria-label={`Key numbers, ${view} data`}>
      {stats.map(([k, v, t]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd className={t}>{v}</dd>
        </div>
      ))}
      <span className={`tag tag-${view}`}>{view}</span>
    </section>
  );
}

export function OpenPositions({ view, rows, now }: P & { rows: OpenPosition[]; now: number }) {
  return (
    <Card title="Open positions" view={view} aside={rows.length || undefined} order={1}>
      {!rows.length ? (
        <p className="empty">No open positions. New ones appear here when a signal passes.</p>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Token</th>
                <th>Wallet</th>
                <th className="n">Size</th>
                <th className="n">Entry</th>
                <th className="n">Mark</th>
                <th className="n">uPnL</th>
                <th className="n">Stop</th>
                <th className="n">Next TP</th>
                <th>Trailing</th>
                <th className="n">Time stop</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const g = p.guard;
                const move = g?.mark == null ? null : g.mark / p.entry_price - 1;
                const upnl = move === null ? null : (g?.remaining ?? 1) * p.size_usd * move;
                return (
                  <tr key={p.id}>
                    <td>
                      <Sol kind="token" id={p.mint} />
                    </td>
                    <td>
                      <Wallet address={p.wallet} label={p.label} />
                    </td>
                    <td className="n">
                      {usd(p.size_usd)}
                      {g?.remaining != null && g.remaining < 1 && (
                        <small> · {pct(g.remaining, 0)} left</small>
                      )}
                    </td>
                    <td className="n">{price(p.entry_price)}</td>
                    {!g ? (
                      <td colSpan={6} className="error-text">
                        guard state unreadable — check the engine
                      </td>
                    ) : (
                      <>
                        <td className="n">{price(g.mark)}</td>
                        <td className={`n ${tone(upnl)}`}>
                          {upnl === null || move === null
                            ? '—'
                            : `${signedUsd(upnl)} ${signedPct(move * 100)}`}
                        </td>
                        <td className="n neg">{price(p.stop_price)}</td>
                        <td className="n pos">
                          {g.nextTp ? (
                            <>
                              {price(g.nextTp.price)} <small>sell {g.nextTp.sellPct}%</small>
                            </>
                          ) : (
                            'ladder done'
                          )}
                        </td>
                        <td>
                          {g.trailAt === null
                            ? `${g.trailPct}% after TP ladder`
                            : `armed @ ${price(g.trailAt)}`}
                        </td>
                        <td className="n">
                          {g.timeStopAt > now ? `${dur((g.timeStopAt - now) / 1000)} left` : 'due'}
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.some((p) => p.guard && p.guard.mark === null) && (
            <p className="foot">Mark and uPnL: the engine doesn't persist marks yet.</p>
          )}
        </div>
      )}
    </Card>
  );
}

export function Equity({ view, points, days }: P & { points: EquityPoint[]; days: DailyPnl[] }) {
  return (
    <Card
      title="Equity"
      view={view}
      aside={`closed positions · local time (${tzLabel()})`}
      order={3}
    >
      <h3>Cumulative net PnL</h3>
      <EquityCurve points={points} />
      <h3>Daily net PnL, last {days.length} days</h3>
      <DailyBars days={days} />
    </Card>
  );
}

const VERDICT: Record<string, string> = { PASSED: 'pos', KILLED: 'neg', SKIPPED: 'muted' };

export function Signals({ view, rows, rules }: P & { rows: SignalRow[]; rules: Config | null }) {
  return (
    <Card title="Recent signals" view={view} aside={`latest ${rows.length}`} order={4}>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Wallet</th>
              <th>Token</th>
              <th>Side</th>
              <th className="n">SOL</th>
              <th>Verdict</th>
              <th>Reason</th>
              <th
                className="n"
                title="Distinct tracked wallets that bought this mint in the window"
              >
                Conf.
              </th>
              <th>Tx</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td className="n">{clock(s.detected_at, true)}</td>
                <td>
                  <Wallet address={s.wallet} label={s.label} />
                </td>
                <td>
                  <Sol kind="token" id={s.mint} />
                </td>
                <td className={s.side === 'buy' ? 'pos' : 'neg'}>{s.side}</td>
                <td className="n">{s.amount_sol?.toFixed(3) ?? '—'}</td>
                <td>
                  <span className={`pill ${VERDICT[s.verdict ?? ''] ?? ''}`}>
                    {s.verdict ?? 'pending'}
                  </span>
                </td>
                <td title={s.killed_by ?? undefined}>
                  {s.verdict === 'PASSED' ? '' : reasonLabel(s.killed_by, rules)}
                </td>
                <td className="n">{s.confluence ?? '—'}</td>
                <td>
                  <Sol kind="tx" id={s.tx_sig} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="foot">Reasons use the current rules.yaml thresholds.</p>
    </Card>
  );
}

export function Funnel({ view, steps }: P & { steps: FunnelStep[] }) {
  const max = Math.max(1, ...steps.map((s) => s.count));
  return (
    <Card title="Funnel" view={view} order={5}>
      <ol className="funnel">
        {steps.map((s, i) => {
          const prev = steps[i - 1]?.count;
          return (
            <li key={s.stage}>
              <span>{s.stage}</span>
              <span className="track">
                <span className="fill" style={{ width: `${(s.count / max) * 100}%` }} />
              </span>
              <b>{s.count}</b>
              <small>{prev === undefined ? '' : prev ? `${pct(s.count / prev, 0)}` : '—'}</small>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

export function Kills({ view, rows, rules }: P & { rows: KillReason[]; rules: Config | null }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  const total = rows.reduce((a, r) => a + r.count, 0);
  return (
    <Card title="Kill reasons" view={view} aside={total || undefined} order={6}>
      {!rows.length ? (
        <p className="empty">No kills yet.</p>
      ) : (
        <ul className="kills">
          {rows.map((r) => (
            <li key={r.reason} title={r.reason}>
              <span>
                <code>{r.reason}</code> {reasonLabel(r.reason, rules)}
              </span>
              <span className="track">
                <span className="fill neg" style={{ width: `${(r.count / max) * 100}%` }} />
              </span>
              <b>{r.count}</b>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function Activity({ view, rows, rules }: P & { rows: EventRow[]; rules: Config | null }) {
  const label = (c: string | null) => reasonLabel(c, rules);
  return (
    <Card title="Activity" view={view} aside="heartbeats hidden" order={7}>
      {!rows.length ? (
        <p className="empty">No events yet.</p>
      ) : (
        <ol className="feed">
          {rows.map((e) => {
            const d = describeEvent(e, label);
            return (
              <li key={e.id} className={`t-${d.tone}`}>
                <time className="n">{clock(e.at, true).slice(6)}</time>
                <span className={`stage s-${e.stage}`}>{e.stage}</span>
                <span className="text">
                  {d.text}
                  {d.mint && (
                    <>
                      {' '}
                      <Sol kind="token" id={d.mint} />
                    </>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

export function EngineHealth({
  view,
  h,
  rules,
  now,
}: P & { h: Health; rules: Config | null; now: number }) {
  const hbStale = stale(
    h.heartbeatAt === null ? null : now - h.heartbeatAt,
    rules && 2 * rules.scout.heartbeat_interval_ms,
  );
  const wsStale = stale(
    h.notificationAgeS === null ? null : h.notificationAgeS * 1000,
    rules && rules.scout.liveness_timeout_s * 1000,
  );
  const problems = h.problemsToday.reduce((a, p) => a + p.count, 0);
  const rows: [string, string, boolean][] = [
    ['Heartbeat', ago(h.heartbeatAt, now), hbStale],
    [
      'Last ws notification',
      h.notificationAgeS === null ? '—' : `${dur(h.notificationAgeS)} ago`,
      wsStale,
    ],
    ['Liveness timeouts today', String(h.livenessToday), h.livenessToday > 0],
    ['Warnings/errors today', String(problems), h.problemsToday.some((p) => p.level === 'error')],
    ['Provider 429s', 'engine logs only', false],
    [
      'Wallets subscribed',
      `${h.subscribed ?? '—'} / ${h.activeWallets} active`,
      h.subscribed === null || h.subscribed < h.activeWallets,
    ],
  ];
  return (
    <Card title="Engine health" view={view} aside={`today = local day (${tzLabel()})`} order={2}>
      <dl className="health">
        {rows.map(([k, v, bad]) => (
          <div key={k} className={bad ? 'bad' : undefined}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {h.problemsToday.length > 0 && (
        <ul className="problems">
          {h.problemsToday.map((p) => (
            <li key={`${p.level}:${p.message}`} className={`t-${p.level}`}>
              <code>{p.message}</code> × {p.count}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function CopyLog({ view, rows, rules }: P & { rows: CopyRow[]; rules: Config | null }) {
  return (
    <Card title="Copy log" view={view} aside={`latest ${rows.length}`} order={8}>
      {!rows.length ? (
        <p className="empty">No positions yet.</p>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Entry</th>
                <th>Token</th>
                <th>Wallet</th>
                <th className="n">Rules</th>
                <th className="n">Size</th>
                <th>Status</th>
                <th>Exit</th>
                <th className="n">Net PnL</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td className="n">{clock(c.entry_at)}</td>
                  <td>
                    <Sol kind="token" id={c.mint} />
                  </td>
                  <td>
                    <Wallet address={c.wallet} label={c.label} />
                  </td>
                  <td className="n">
                    {c.rules_passed}/{c.rules_total}
                  </td>
                  <td className="n">{usd(c.size_usd)}</td>
                  <td>{c.status}</td>
                  <td>{c.exit_reason ? reasonLabel(c.exit_reason, rules) : '—'}</td>
                  <td className={`n ${tone(c.net_pnl_usd)}`}>
                    {c.net_pnl_usd === null
                      ? '—'
                      : `${signedUsd(c.net_pnl_usd)} ${signedPct(c.net_pnl_pct)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
