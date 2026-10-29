import { dur, signedPct, signedUsd, usd } from './format';

export type EventRow = {
  id: number;
  at: number;
  level: string;
  stage: string;
  message: string;
  data_json: string | null;
};
export type Tone = 'info' | 'pos' | 'neg' | 'muted' | 'warn' | 'error';
export type Described = { tone: Tone; text: string; mint: string | null };

const parse = (json: string | null): Record<string, unknown> => {
  try {
    const v = JSON.parse(json ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
};
const num = (v: unknown) => (typeof v === 'number' ? v : null);
const str = (v: unknown) => (typeof v === 'string' ? v : null);

/**
 * One events_log row → a human line. Error text from the engine (`err`) is never shown: it can
 * carry provider URLs; the engine logs have it.
 */
export const describeEvent = (e: EventRow, label: (code: string | null) => string): Described => {
  const d = parse(e.data_json);
  const mint = str(d.mint);
  const base: Tone = e.level === 'error' ? 'error' : e.level === 'warn' ? 'warn' : 'info';
  const out = (text: string, tone: Tone = base): Described => ({ tone, text, mint });
  const key = `${e.stage}:${e.message}`;
  switch (key) {
    case 'rules:KILLED':
      return out(`Killed — ${label(str(d.killed_by))}`, 'neg');
    case 'rules:SKIPPED':
      return out(`Skipped — ${label(str(d.killed_by))}`, 'muted');
    case 'rules:PASSED':
      return out('Passed all rules', 'pos');
    case 'paper:opened':
      return out(`Opened ${usd(num(d.size_usd) ?? 0)}`);
    case 'paper:exit':
      return out(`Sold — ${label(str(d.reason))}`);
    case 'paper:closed': {
      const net = num(d.netPnlUsd);
      return out(
        `Closed — ${label(str(d.reason))} ${net === null ? '' : `${signedUsd(net)} (${signedPct(num(d.netPnlPct))})`}`.trim(),
        net === null ? base : net >= 0 ? 'pos' : 'neg',
      );
    }
    case 'paper:skipped':
      return out(`Not copied — ${label(str(d.reason))}`, 'muted');
    case 'paper:resumed':
      return out(`Paper executor resumed — ${num(d.open_positions) ?? 0} open`);
    case 'scout:connected':
      return out('WebSocket connected');
    case 'scout:subscriptions_acked':
      return out(`Subscribed to ${num(d.count) ?? '?'} wallets`);
    case 'scout:backfill_done':
      return out(`Backfill done — ${num(d.wallets) ?? '?'} wallets, ${num(d.txs) ?? '?'} txs`);
    case 'scout:ws_closed':
      return out(`WebSocket closed (code ${num(d.code) ?? '?'})`);
    case 'scout:reconnecting':
      return out(
        `Reconnecting — attempt ${num(d.attempt) ?? '?'}, in ${dur((num(d.delay_ms) ?? 0) / 1000)}`,
      );
    case 'scout:liveness_timeout':
      return out(`No notifications for ${dur((num(d.silent_ms) ?? 0) / 1000)} — reconnecting`);
  }
  if (e.message.endsWith('_failed')) {
    return out(`${e.message.replace(/_failed$/, '').replace(/_/g, ' ')} failed — see engine logs`);
  }
  return out(e.message);
};
