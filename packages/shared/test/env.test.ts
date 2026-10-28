import { describe, expect, it } from 'vitest';
import { isLiveArmed, LIVE_CONFIRM_PHRASE, parseEnv } from '../src/env.js';
import { controlDbPath, MODES, modeDbPath } from '../src/mode.js';

describe('env', () => {
  it('defaults to not armed and treats empty keys as absent', () => {
    const env = parseEnv({ HELIUS_API_KEY: '' });
    expect(isLiveArmed(env)).toBe(false);
    expect(env.HELIUS_API_KEY).toBeUndefined();
  });

  it('arms live only on the exact flag pair', () => {
    const armed = (LIVE_ENABLED: string, LIVE_CONFIRM: string) =>
      isLiveArmed(parseEnv({ LIVE_ENABLED, LIVE_CONFIRM }));
    expect(armed('true', LIVE_CONFIRM_PHRASE)).toBe(true);
    expect(armed('true', '')).toBe(false);
    expect(armed('1', LIVE_CONFIRM_PHRASE)).toBe(false);
    expect(armed('TRUE', LIVE_CONFIRM_PHRASE)).toBe(false);
    expect(armed('true', 'i_understand_the_risk')).toBe(false);
    expect(armed('true', `${LIVE_CONFIRM_PHRASE} `)).toBe(false);
    expect(armed('false', LIVE_CONFIRM_PHRASE)).toBe(false);
  });
});

describe('db paths', () => {
  it('gives every mode and control its own file', () => {
    const paths = [controlDbPath('d'), ...MODES.map((m) => modeDbPath('d', m))];
    expect(new Set(paths).size).toBe(4);
    expect(paths).toEqual(['d/control.db', 'd/demo.db', 'd/paper.db', 'd/live.db']);
  });
});
