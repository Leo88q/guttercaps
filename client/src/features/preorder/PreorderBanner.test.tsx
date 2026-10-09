// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setLocale, t } from '@/shared/i18n';
import { PreorderBanner } from './PreorderBanner';

const mocks = vi.hoisted(() => ({ campaign: undefined as unknown }));
vi.mock('@/api/hooks', () => ({
  usePreorderCampaign: () => ({ data: mocks.campaign, isLoading: false }),
}));

function mount(variant: 'home' | 'shop' = 'home') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <PreorderBanner testId="preorder-banner" variant={variant} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(async () => {
  cleanup();
  mocks.campaign = undefined;
  await act(() => setLocale('en'));
});

it('keeps the pre-sale entry visible when the campaign is closed or missing', () => {
  mocks.campaign = { active: false, remaining: 363, total: 500 };
  mount();
  const banner = screen.getByTestId('preorder-banner');
  expect(banner.getAttribute('href')).toBe('/preorder');
  expect(banner.textContent).toContain(t('preorder.title'));
  expect(banner.textContent).toContain(t('preorder.ended'));
  cleanup();

  mocks.campaign = undefined;
  mount();
  expect(screen.getByTestId('preorder-banner').getAttribute('href')).toBe('/preorder');
  expect(screen.getByTestId('preorder-banner').textContent).toContain(t('preorder.title'));
});

it('shop variant only uses the live CTA copy while the drop is actually on sale', () => {
  mocks.campaign = { active: true, remaining: 10, total: 500 };
  mount('shop');
  expect(screen.getByTestId('preorder-banner').textContent).toContain(t('preorder.shopBanner'));
  expect(screen.getByTestId('preorder-banner').textContent).toContain(t('preorder.shopCta'));
  cleanup();

  mocks.campaign = { active: false, remaining: 10, total: 500 };
  mount('shop');
  expect(screen.getByTestId('preorder-banner').textContent).not.toContain(t('preorder.shopBanner'));
  expect(screen.getByTestId('preorder-banner').textContent).toContain(t('preorder.ended'));
});
