import { describe, it, expect } from 'vitest';
import { utcDay, featuredDistrict, drainStorageKey } from './drainDay';

describe('drain day', () => {
  it('utcDay matches unix-seconds / 86400', () => {
    expect(utcDay(0)).toBe(0);
    expect(utcDay(86_400_000)).toBe(1);
    expect(utcDay(1_760_140_800_000)).toBe(Math.floor(1_760_140_800_000 / 86_400_000));
  });
  it('featured district is in 0..7 and stable for a UTC day', () => {
    const d = featuredDistrict(20_000);
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThan(8);
    expect(featuredDistrict(20_000)).toBe(d);
    expect(featuredDistrict(20_001)).not.toBe(d);
  });
  it('storage key is per wallet and day', () => {
    expect(drainStorageKey('W', 3)).toBe('gc.drain:W:3');
    expect(drainStorageKey('W', 4)).not.toBe(drainStorageKey('W', 3));
  });
});
