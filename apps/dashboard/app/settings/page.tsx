import { loadConfig } from '@scb/shared';
import { Card } from '../../components/Card';
import { paths } from '../../lib/paths';
import { getView } from '../../lib/view';

/** rules.yaml, read-only. Edit the file; the engine refuses to start on an invalid one. */
export default async function Settings() {
  const view = await getView();
  let body: string;
  let ok = true;
  try {
    body = JSON.stringify(loadConfig(paths.rules), null, 2);
  } catch (e) {
    ok = false;
    body = (e as Error).message;
  }
  return (
    <Card title="Rules (config/rules.yaml, read-only)" view={view}>
      {!ok && <p className="neg">rules.yaml is invalid — the engine will not start:</p>}
      <pre>{body}</pre>
    </Card>
  );
}
