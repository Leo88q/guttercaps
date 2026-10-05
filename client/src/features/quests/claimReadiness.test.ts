import { describe, expect, it } from 'vitest';
import { isClaimReady } from './claimReadiness';

describe('isClaimReady', () => {
  const now = Date.parse('2026-10-04T16:00:00.000Z');

  it('does not treat a pending, unpublished root with a null claimableAt as ready', () => {
    expect(isClaimReady({ claimed: false, published: false, claimableAt: null }, now)).toBe(false);
  });

  it('requires a valid claimableAt even if the API says the root is published', () => {
    expect(isClaimReady({ claimed: false, published: true, claimableAt: null }, now)).toBe(false);
    expect(isClaimReady({ claimed: false, published: true, claimableAt: 'not-a-date' }, now)).toBe(false);
  });

  it('waits for the on-chain root timelock to elapse', () => {
    expect(isClaimReady({ claimed: false, published: true, claimableAt: '2026-10-04T16:00:01.000Z' }, now)).toBe(false);
  });

  it('allows an unclaimed, published leaf after its timelock', () => {
    expect(isClaimReady({ claimed: false, published: true, claimableAt: '2026-10-04T15:59:59.000Z' }, now)).toBe(true);
  });

  it('never offers an already claimed leaf again', () => {
    expect(isClaimReady({ claimed: true, published: true, claimableAt: '2026-10-04T15:59:59.000Z' }, now)).toBe(false);
  });
});
