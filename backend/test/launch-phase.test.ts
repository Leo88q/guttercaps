import { describe, expect, it } from 'vitest';
import { parseLaunchPhase } from '../src/config.ts';

describe('launch phase flag (MINIMAL-LAUNCH-CHECKLIST 0.1)', () => {
  it('defaults to full and accepts g', () => {
    expect(parseLaunchPhase(undefined)).toBe('full');
    expect(parseLaunchPhase('')).toBe('full');
    expect(parseLaunchPhase('full')).toBe('full');
    expect(parseLaunchPhase('g')).toBe('g');
    // 'v' is a real phase (docs/PHASEV-ACTIVATION.md switches the backend with
    // LAUNCH_PHASE=v): the parser once rejected it while the 'v' branches in
    // config/crank sat unreachable — activation would crash the boot.
    expect(parseLaunchPhase('v')).toBe('v');
  });
  it('garbage is a hard error, never a silent fallback', () => {
    expect(() => parseLaunchPhase('G')).toThrow(/LAUNCH_PHASE/);
    expect(() => parseLaunchPhase('phase-g')).toThrow(/LAUNCH_PHASE/);
    expect(() => parseLaunchPhase('1')).toThrow(/LAUNCH_PHASE/);
  });
});
