import { describe, expect, it } from 'vitest';
import { describeEvent, type EventRow } from '../lib/events.ts';

const row = (stage: string, message: string, data: unknown = {}, level = 'info'): EventRow => ({
  id: 1,
  at: 0,
  level,
  stage,
  message,
  data_json: JSON.stringify(data),
});
const label = (c: string | null) => `<${c}>`;

describe('describeEvent', () => {
  it('rules verdicts', () => {
    expect(describeEvent(row('rules', 'KILLED', { mint: 'm', killed_by: 'R1' }), label)).toEqual({
      tone: 'neg',
      text: 'Killed — <R1>',
      mint: 'm',
    });
    expect(describeEvent(row('rules', 'SKIPPED', { killed_by: 'sell' }), label).tone).toBe('muted');
  });

  it('paper close carries signed PnL and its tone', () => {
    const d = describeEvent(
      row('paper', 'closed', { reason: 'take_profit', netPnlUsd: 25, netPnlPct: 50 }),
      label,
    );
    expect(d).toMatchObject({ tone: 'pos', text: 'Closed — <take_profit> +$25.00 (+50.0%)' });
    const loss = describeEvent(
      row('paper', 'closed', { reason: 'stop_loss', netPnlUsd: -5, netPnlPct: -10 }),
      label,
    );
    expect(loss.tone).toBe('neg');
  });

  it('scout connection events', () => {
    expect(describeEvent(row('scout', 'ws_closed', { code: 1006 }, 'warn'), label)).toMatchObject({
      tone: 'warn',
      text: 'WebSocket closed (code 1006)',
    });
    expect(
      describeEvent(row('scout', 'liveness_timeout', { silent_ms: 181_000 }, 'warn'), label).text,
    ).toBe('No notifications for 3m — reconnecting');
    expect(describeEvent(row('scout', 'subscriptions_acked', { count: 16 }), label).text).toBe(
      'Subscribed to 16 wallets',
    );
  });

  it('never shows engine error text, and survives bad JSON / unknown messages', () => {
    const d = describeEvent(
      row('paper', 'open_failed', { err: 'https://x?api-key=SECRET' }, 'error'),
      label,
    );
    expect(d.text).toBe('open failed — see engine logs');
    expect(d.text).not.toContain('SECRET');
    expect(d.tone).toBe('error');
    expect(describeEvent({ ...row('x', 'something'), data_json: '{bad' }, label)).toEqual({
      tone: 'info',
      text: 'something',
      mint: null,
    });
  });
});
