import { describe, expect, it, vi } from 'vitest';
import { nextKillSwitch } from '../lib/kill';

describe('nextKillSwitch', () => {
  it('engages in one click without asking', () => {
    const confirm = vi.fn(() => false);
    expect(nextKillSwitch(false, confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('releases only after confirmation', () => {
    expect(nextKillSwitch(true, () => true)).toBe(false);
  });

  it('does nothing when the release is cancelled', () => {
    const confirm = vi.fn(() => false);
    expect(nextKillSwitch(true, confirm)).toBeNull();
    expect(confirm).toHaveBeenCalledOnce();
  });
});
