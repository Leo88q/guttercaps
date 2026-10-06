import { afterEach, expect, it, vi } from 'vitest';
import { clearWait, getWait, resetWaitForTest, setWait, subscribeWait, TX_PHASES } from './waitStatus';

afterEach(() => resetWaitForTest());

it('starts empty, reports the current phase and keeps the phase start time on re-set', () => {
  expect(getWait()).toBeNull();
  setWait('prepare');
  const first = getWait()!;
  expect(first.phase).toBe('prepare');
  expect(first.at).toBeGreaterThan(0);
  setWait('prepare');
  expect(getWait()!.at).toBe(first.at); // same phase — timer keeps running
  setWait('wallet');
  expect(getWait()!.phase).toBe('wallet');
  expect(getWait()!.at).toBeGreaterThanOrEqual(first.at);
});

it('carries the signature across later phases once the wallet has signed', () => {
  setWait('wallet');
  expect(getWait()!.signature).toBeUndefined();
  setWait('send', 'sig123');
  expect(getWait()!.signature).toBe('sig123');
  setWait('confirm');
  expect(getWait()!.signature).toBe('sig123'); // not wiped by the phase change
});

it('clearing is phase-guarded so tx and wallet owners never erase each other', () => {
  setWait('connect');
  clearWait(...TX_PHASES);
  expect(getWait()!.phase).toBe('connect'); // tx-side clear must not touch the bridge
  clearWait('connect');
  expect(getWait()).toBeNull();

  setWait('confirm', 'sig');
  clearWait('signin');
  expect(getWait()!.phase).toBe('confirm');
  clearWait(...TX_PHASES);
  expect(getWait()).toBeNull();
});

it('notifies subscribers on every change and lets them unsubscribe', () => {
  const fn = vi.fn();
  const off = subscribeWait(fn);
  setWait('wallet');
  clearWait(...TX_PHASES);
  expect(fn).toHaveBeenCalledTimes(2);
  off();
  setWait('prepare');
  expect(fn).toHaveBeenCalledTimes(2);
});
