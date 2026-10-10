// @vitest-environment happy-dom
// The pre-sale screen (docs/preorder-beta.md) drives real money, so the test renders the actual
// component and intercepts only the API boundary: campaign state, the reservation call, the
// payment confirmation and the guest redirect are the contract this file pins.
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setLocale, t } from '@/shared/i18n';
import { fmtSol } from '@/shared/lib/format';
import { useUiStore } from '@/app/store/ui';

const mocks = vi.hoisted(() => ({
  connected: false,
  campaign: undefined as unknown,
  items: [] as unknown[],
  post: vi.fn(),
}));
vi.mock('@/api/hooks', () => ({
  usePreorderCampaign: () => ({ data: mocks.campaign, isLoading: false }),
  useMyPreorders: () => ({ data: { items: mocks.items }, isLoading: false }),
  usePreorderRegistry: () => ({ data: { campaign: mocks.campaign, rows: [] }, isLoading: false }),
}));
vi.mock('@/api/client', () => ({ api: { post: mocks.post }, isMock: () => true }));
vi.mock('@solana/wallet-adapter-react', () => ({ useWallet: () => ({ connected: mocks.connected, publicKey: null }) }));
import Preorder from './Preorder';

const LocationProbe = () => {
  const loc = useLocation();
  return <div data-testid="probe">{loc.pathname + loc.search}</div>;
};

const campaign = (over: Record<string, unknown> = {}) => ({
  active: true, sku: 3, priceLamports: '300000000', treasury: 'TreasuryVaULT11111111111111111111111111111',
  total: 500, remaining: 480, sold: 20, intentTtlS: 259200, ...over,
});
const intent = { refId: 7, wallet: 'W', sku: 3, qty: 3, offer: 'pack', lamports: '900000000', treasury: campaign().treasury, memo: 'GC-PRE|7', expiresAt: 9999999999 };

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/preorder']}>
        <Routes>
          <Route path="/preorder" element={<Preorder />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
afterEach(async () => {
  cleanup(); vi.clearAllMocks(); mocks.connected = false; mocks.campaign = undefined; mocks.items = [];
  useUiStore.setState({ toasts: [] }); await act(() => setLocale('en'));
});

it('a switched-off or exhausted campaign shows its end state and never offers a reservation', () => {
  mocks.campaign = campaign({ active: false });
  mount();
  expect(document.body.textContent).toContain(t('preorder.ended'));
  expect(screen.queryByTestId('preorder-reserve')).toBeNull();
  expect(screen.getByTestId('preorder-campaign')).toBeTruthy();
  expect(screen.getByTestId('preorder-how').textContent).toContain(t('preorder.how'));
  expect(screen.getByTestId('preorder-mine').textContent).toContain(t('preorder.empty'));
  cleanup();

  mocks.campaign = campaign({ remaining: 0, sold: 500 });
  mount();
  expect(document.body.textContent).toContain(t('preorder.soldOut'));
  expect(screen.queryByTestId('preorder-reserve')).toBeNull();
});

it('guests are sent to the connect flow with a return path, and qty pills cap at the remaining supply', async () => {
  mocks.campaign = campaign({ remaining: 2 }); // caps the pills below the wallet limit
  mount();
  const pills = screen.getByTestId('preorder-reserve').querySelectorAll('.tabs > *');
  expect(pills.length).toBe(2);

  fireEvent.click(screen.getByRole('button', { name: t('preorder.reserve') }));
  await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('/?connect=1&next=/preorder'));
  expect(mocks.post).not.toHaveBeenCalled();
});

it('reserve → pay → confirm: the exact payment data is shown and the confirmation posts the signature once', async () => {
  mocks.connected = true;
  mocks.campaign = campaign();
  mocks.post.mockResolvedValueOnce(intent).mockResolvedValueOnce({ ...intent, status: 'paid' });
  mount();

  // choose qty 3 — the quoted total is price × qty, not a copy-pasted constant
  fireEvent.click(screen.getByText('3'));
  expect(screen.getByTestId('preorder-reserve').textContent).toContain(fmtSol('900000000'));
  fireEvent.click(screen.getByRole('button', { name: t('preorder.reserve') }));
  await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/preorder/intent', { offer: 'pack', qty: 3 }));

  const pay = await screen.findByTestId('preorder-pay');
  expect(pay.textContent).toContain('GC-PRE|7');
  expect(pay.textContent).toContain(intent.treasury);
  expect(pay.textContent).toContain(fmtSol(intent.lamports));

  const sig = '5'.repeat(64);
  const confirmBtn = screen.getByRole('button', { name: t('preorder.confirm') }) as HTMLButtonElement;
  expect(confirmBtn.disabled).toBe(true); // empty signature
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'short' } });
  expect(confirmBtn.disabled).toBe(true); // < 32 chars is not a signature
  fireEvent.change(screen.getByRole('textbox'), { target: { value: sig } });
  fireEvent.click(confirmBtn);
  await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/preorder/confirm', { refId: 7, signature: sig }));

  // paid clears the pay card and raises the money toast; the payment cannot be re-submitted
  await waitFor(() => expect(screen.queryByTestId('preorder-pay')).toBeNull());
  const toasts = useUiStore.getState().toasts;
  expect(toasts).toHaveLength(1);
  expect(toasts[0].kind).toBe('money');
  expect(toasts[0].title).toEqual({ key: 'preorder.confirmed' });
});

it('the reservation list renders statuses from i18n and flags delivered drops', () => {
  mocks.campaign = campaign({ active: false });
  mocks.items = [
    { ref_id: 2, wallet: 'W', sku: 3, qty: 1, lamports: '999000000', status: 'paid' },
    { ref_id: 1, wallet: 'W', sku: 3, qty: 2, lamports: '1998000000', status: 'granted' },
  ];
  mount();
  const mine = screen.getByTestId('preorder-mine');
  expect(mine.textContent).toContain('#2');
  expect(mine.textContent).toContain(t('preorder.statusPaid'));
  expect(mine.textContent).toContain(t('preorder.statusGranted'));
  expect(mine.textContent).toContain(t('preorder.grantedNote'));
});

it('the founders chest posts offer=chest and never shares the pack qty stepper', async () => {
  mocks.connected = true;
  mocks.campaign = campaign({
    offers: [
      { id: 'pack', packs: 1, priceLamports: '300000000', total: 500, remaining: 480, sold: 20, maxPerWallet: 5, maxQty: 5 },
      { id: 'chest', packs: 4, priceLamports: '999000000', total: 125, remaining: 125, sold: 0, maxPerWallet: 1, maxQty: 1 },
    ],
  });
  mocks.post.mockResolvedValueOnce({ ...intent, offer: 'chest', qty: 4, lamports: '999000000' });
  mount();
  fireEvent.click(screen.getByRole('button', { name: t('preorder.reserveChest') }));
  await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/preorder/intent', { offer: 'chest', qty: 1 }));
});
