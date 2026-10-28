import { Card } from '../components/Card';
import { usd } from '../lib/format';
import { paths } from '../lib/paths';
import { readView, solscan } from '../lib/trading';
import { getView } from '../lib/view';

const pct = (n: number | null) => (n === null ? '—' : `${(n * 100).toFixed(1)}%`);
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;

const Bars = ({ rows }: { rows: { label: string; count: number }[] }) => {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <ul className="bars">
      {rows.map((r) => (
        <li key={r.label}>
          <span>{r.label}</span>
          <span className="bar" style={{ width: `${(r.count / max) * 100}%` }} />
          <b>{r.count}</b>
        </li>
      ))}
    </ul>
  );
};

export default async function Overview() {
  const view = await getView();
  const r = readView(paths.view(view), view);
  if (r.state !== 'ok') {
    return (
      <Card title="Overview" view={view}>
        <p className="empty">{r.message}</p>
      </Card>
    );
  }
  const { overview: o, funnel, killReasons, copyLog } = r.data;
  const stats: [string, string | number][] = [
    ['Wallets', o.wallets],
    ['Signals', o.signals],
    ['Killed', o.killed],
    ['Passed', o.passed],
    ['Copied', o.copied],
    ['Closed', o.closed],
    ['Net PnL', usd(o.netPnlUsd)],
    ['Win rate', pct(o.winRate)],
    ['Return', o.returnMultiple === null ? '—' : `${o.returnMultiple.toFixed(2)}x`],
  ];
  return (
    <>
      <Card title="Overview" view={view}>
        <dl className="stats">
          {stats.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <Card title="Funnel" view={view}>
        <Bars rows={funnel.map((f) => ({ label: f.stage, count: f.count }))} />
      </Card>
      <Card title="Kill reasons" view={view}>
        <Bars rows={killReasons.map((k) => ({ label: k.reason, count: k.count }))} />
      </Card>
      <Card title="Copy log" view={view}>
        <table>
          <thead>
            <tr>
              <th>Entry</th>
              <th>Token</th>
              <th>Wallet</th>
              <th>Rules</th>
              <th>Size</th>
              <th>Status</th>
              <th>Exit</th>
              <th>PnL</th>
            </tr>
          </thead>
          <tbody>
            {copyLog.map((c) => (
              <tr key={c.id}>
                <td>{new Date(c.entry_at).toISOString().slice(0, 16).replace('T', ' ')}</td>
                <td>
                  <a href={solscan.token(c.mint)} target="_blank" rel="noreferrer">
                    {short(c.mint)}
                  </a>
                </td>
                <td>
                  {c.wallet ? (
                    <a href={solscan.account(c.wallet)} target="_blank" rel="noreferrer">
                      {short(c.wallet)}
                    </a>
                  ) : (
                    '—'
                  )}
                </td>
                <td>
                  {c.rules_passed}/{c.rules_total}
                </td>
                <td>{usd(c.size_usd)}</td>
                <td>{c.status}</td>
                <td>{c.exit_reason ?? '—'}</td>
                <td className={(c.net_pnl_usd ?? 0) < 0 ? 'neg' : 'pos'}>
                  {c.net_pnl_usd === null
                    ? '—'
                    : `${usd(c.net_pnl_usd)} (${c.net_pnl_pct?.toFixed(1)}%)`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="Wallet leaderboard" view={view}>
        <p className="empty">Arrives after M5.</p>
      </Card>
    </>
  );
}
