// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api } from './client';
import * as hooks from './hooks';
import { useSessionStore } from '@/app/store/session';
import { LOCALES, setLocale } from '@/shared/i18n';

afterEach(async () => { cleanup(); vi.restoreAllMocks(); useSessionStore.getState().clear(); await setLocale('en'); });
for (const locale of LOCALES) it(`${locale}: all session-gated queries react to login and logout without an incidental rerender`, async () => {
  await setLocale(locale);
  useSessionStore.getState().clear();
  const get = vi.spyOn(api, 'get').mockResolvedValue({});
  const post = vi.spyOn(api, 'post').mockResolvedValue({});
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const { result, unmount } = renderHook(() => [
    hooks.useQuote(1, 2, 'SKR'), hooks.useHandleCheck('rail_queen'), hooks.useMyServices(), hooks.usePass(),
    hooks.useOffers('made'), hooks.useFusionSuggest(), hooks.useArenaMe(), hooks.useStakingMe(),
    hooks.useQuests(), hooks.useHuman(), hooks.useClaims(), hooks.useStreak(), hooks.useReferrals(),
    hooks.useAdminParams(), hooks.useAdminKpi(), hooks.useAdminFraud(), hooks.useAdminAudit(),
  ], { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider> });
  expect(get).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
  await act(() => useSessionStore.getState().set({ status: 'signing' }));
  expect(get).not.toHaveBeenCalled();
  await act(() => useSessionStore.getState().set({ status: 'authenticated' }));
  await waitFor(() => expect(result.current.every(query => query.isSuccess)).toBe(true));
  expect(get).toHaveBeenCalledTimes(16); expect(post).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith('/packs/quote', { sku: 1, qty: 2, currency: 'SKR' });
  await act(() => useSessionStore.getState().clear());
  get.mockClear(); post.mockClear();
  await act(() => qc.invalidateQueries());
  expect(get).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
  expect(qc.getQueryCache().getAll().every(query => !query.isActive())).toBe(true);
  unmount(); qc.clear();
});

it('disabled flags and invalid handles remain gated, including when flags change after login', async () => {
  useSessionStore.getState().clear();
  const get = vi.spyOn(api, 'get').mockResolvedValue({});
  const post = vi.spyOn(api, 'post').mockResolvedValue({});
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = renderHook(({ enabled, handle }) => [
    hooks.useQuote(0, 1, 'CG', enabled), hooks.useHandleCheck(handle),
    hooks.useAdminParams(enabled), hooks.useAdminKpi(enabled), hooks.useAdminFraud(enabled), hooks.useAdminAudit(enabled),
  ], { initialProps: { enabled: false, handle: 'a' }, wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider> });
  await act(() => useSessionStore.getState().set({ status: 'authenticated' }));
  expect(get).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
  view.rerender({ enabled: true, handle: 'valid_name' });
  await waitFor(() => expect(view.result.current.every(q => q.isSuccess)).toBe(true));
  expect(get).toHaveBeenCalledTimes(5); expect(post).toHaveBeenCalledTimes(1);
  view.rerender({ enabled: false, handle: 'a' });
  get.mockClear(); post.mockClear();
  await act(() => qc.invalidateQueries());
  expect(get).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
  view.unmount(); qc.clear();
});
