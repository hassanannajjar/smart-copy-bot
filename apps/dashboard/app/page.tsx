import { Card } from '../components/Card';
import {
  Activity,
  CopyLog,
  EngineHealth,
  Equity,
  Funnel,
  Kills,
  Kpis,
  OpenPositions,
  Signals,
} from '../components/Panels';
import { paths } from '../lib/paths';
import { readRules } from '../lib/rules';
import { readView } from '../lib/trading';
import { getView } from '../lib/view';

export default async function Overview() {
  const view = await getView();
  const now = Date.now();
  const r = readView(paths.view(view), view, now);
  const rules = readRules();
  if (r.state === 'missing') {
    return (
      <Card title="Overview" view={view}>
        <p className="empty">{r.message}</p>
      </Card>
    );
  }
  if (r.state === 'empty') {
    return (
      <div className="grid">
        <div className="col">
          <Card title="Overview" view={view} order={1}>
            <p className="empty">{r.message}</p>
          </Card>
        </div>
        <div className="col">
          <EngineHealth view={view} h={r.health} rules={rules} now={now} />
        </div>
      </div>
    );
  }
  const d = r.data;
  return (
    <>
      <Kpis view={view} o={d.overview} open={d.open.length} />
      <div className="grid">
        <div className="col">
          <OpenPositions view={view} rows={d.open} now={now} />
          <Equity view={view} points={d.equity} days={d.daily} />
          <Signals view={view} rows={d.signals} rules={rules} />
          <CopyLog view={view} rows={d.copyLog} rules={rules} />
        </div>
        <div className="col rail">
          <EngineHealth view={view} h={d.health} rules={rules} now={now} />
          <Funnel view={view} steps={d.funnel} />
          <Kills view={view} rows={d.killReasons} rules={rules} />
          <Activity view={view} rows={d.activity} rules={rules} />
        </div>
      </div>
    </>
  );
}
