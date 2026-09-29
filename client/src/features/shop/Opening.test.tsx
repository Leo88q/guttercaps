// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { LOCALES, setLocale, t } from '@/shared/i18n';
import { useTxStore } from '@/app/store/txs';
import { CHIP_CORE_ID } from '@/chain/ids';

const mock = vi.hoisted(() => ({ wallet: undefined as unknown, pending: undefined as unknown, resume: vi.fn() }));
vi.mock('@solana/wallet-adapter-react', () => ({ useWallet: () => ({ publicKey: mock.wallet }) }));
vi.mock('@/chain/hooks', () => ({ usePendingPack: () => ({ data: mock.pending }) }));
vi.mock('./usePackFlow', () => ({ usePackFlow: () => ({ state: null, resume: mock.resume }) }));
vi.mock('@/api/client', () => ({ isMock: () => true }));
import Opening from './Opening';

function mount() {
  mock.wallet = PublicKey.default;
  return render(<MemoryRouter initialEntries={['/shop/opening/123']}><Routes><Route path="/shop/opening/:nonce" element={<Opening />} /></Routes></MemoryRouter>);
}
afterEach(async () => { cleanup(); mock.pending = undefined; useTxStore.setState({ packs: {} }); await act(() => setLocale('en')); });

it('the actual restored opening page passes persisted program diagnostics to the stepper in all languages', async () => {
  useTxStore.getState().upsertPack({ id: `pack:${PublicKey.default}:123`, wallet: PublicKey.default.toBase58(), nonce: '123', sku: 1, qty: 1, currency: 0, phase: 'error', openSignatures: [], opened: [], createdAt: 1, updatedAt: 1, error: 'original failure', errorDiagnostic: { message: 'original failure', logs: [`Program ${CHIP_CORE_ID} failed: custom program error: 6006`] } });
  const saved = JSON.stringify(useTxStore.getState().packs);
  mount();
  for (const locale of LOCALES) {
    await act(() => setLocale(locale));
    expect(document.body.textContent).toContain(t('failures.chip_core_DailyCapReached'));
    expect(document.body.textContent).toContain('6006 · DailyCapReached');
    expect(JSON.stringify(useTxStore.getState().packs)).toBe(saved);
  }
  expect(mock.resume).not.toHaveBeenCalled();
});

it('the untracked on-chain purchase notice follows language changes without pretending to resume it', async () => {
  mock.pending = { sku: 1, qty: 1 }; // retained query data, no locally tracked purchase
  mount();
  for (const locale of LOCALES) {
    await act(() => setLocale(locale));
    expect(document.body.textContent).toContain(t('screens.reconnectPackBuyer'));
    expect(screen.getByRole('link', { name: t('ui.backShop') }).getAttribute('href')).toBe('/shop');
  }
  expect(mock.resume).not.toHaveBeenCalled();
});
