import { Card } from '../../components/Card';
import { type ModeChange, modeHistory } from '../../lib/control';
import { clock } from '../../lib/format';
import { paths } from '../../lib/paths';
import { getView } from '../../lib/view';

export default async function History() {
  const view = await getView();
  let rows: ModeChange[] = [];
  let error: string | null = null;
  try {
    rows = modeHistory(paths.control);
  } catch (e) {
    error = (e as Error).message;
  }
  return (
    <Card title="Engine mode history (control.db)" view={view}>
      {error && <p className="empty">{error}</p>}
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>At</th>
              <th>From</th>
              <th>To</th>
              <th>By</th>
              <th>Accepted</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="n">{clock(r.at, true)}</td>
                <td>{r.from_mode ?? '—'}</td>
                <td>{r.to_mode}</td>
                <td>{r.requested_by}</td>
                <td>{r.accepted ? 'yes' : 'no'}</td>
                <td>{r.reason ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
