// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { useSessionStore } from './session';

afterEach(() => { useSessionStore.getState().clear(); sessionStorage.clear(); });
it('keeps signing in memory but never persists an in-flight request', () => {
  useSessionStore.getState().set({ status: 'signing' });
  expect(useSessionStore.getState().status).toBe('signing');
  expect(JSON.parse(sessionStorage.getItem('gc.session')!).state.status).toBe('anonymous');
});
it('restores legacy signing snapshots as anonymous, without disabling store actions', async () => {
  sessionStorage.setItem('gc.session', JSON.stringify({ state: { status: 'signing' }, version: 0 }));
  await useSessionStore.persist.rehydrate();
  expect(useSessionStore.getState().status).toBe('anonymous');
  useSessionStore.getState().set({ status: 'signing' });
  expect(useSessionStore.getState().status).toBe('signing');
});
it('preserves a completed session and clears its credentials on sign-out', async () => {
  const session = { status: 'authenticated' as const, address: 'wallet-test', wallet: { address: 'wallet-test', handle: 'test' }, csrf: 'test-only-token' };
  useSessionStore.getState().set(session);
  expect(JSON.parse(sessionStorage.getItem('gc.session')!).state).toEqual(session);
  await useSessionStore.persist.rehydrate();
  expect(useSessionStore.getState()).toMatchObject(session);
  useSessionStore.getState().clear();
  expect(JSON.parse(sessionStorage.getItem('gc.session')!).state).toEqual({ status: 'anonymous' });
});
