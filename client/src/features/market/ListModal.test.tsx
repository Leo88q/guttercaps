// @vitest-environment happy-dom
// Render the actual list dialog and intercept only the send boundary. No signature or RPC.
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Keypair, type TransactionInstruction } from '@solana/web3.js';
import { LOCALES, setLocale, t } from '@/shared/i18n';
import { fmtAmount, fmtCg, fmtDecimal } from '@/shared/lib/format';
import { useUiStore } from '@/app/store/ui';
import { Toasts } from '@/shared/ui/primitives';

const mocks = vi.hoisted(() => ({ wallet: undefined as unknown, cfg: undefined as unknown, send: vi.fn(), cores: vi.fn(), invalidate: vi.fn() }));
vi.mock('@/api/hooks', () => ({ useFloor: () => ({ data: { skrUsd: 0.1, solUsd: 100 } }) }));
vi.mock('@/api/client', () => ({ isMock: () => false }));
vi.mock('@/chain/hooks', () => ({ useGameConfig: () => ({ data: mocks.cfg }), useWalletLike: () => mocks.wallet }));
vi.mock('@solana/wallet-adapter-react', () => ({ useConnection: () => ({ connection: {} }) }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: mocks.invalidate }) }));
vi.mock('@/chain/flows/packFlow', () => ({ fetchCoreCollections: mocks.cores }));
vi.mock('@/chain/tx', () => ({ sendTx: mocks.send }));
import { ListModal } from './ListModal';

const pk = () => Keypair.generate().publicKey;
const seller = pk(), asset = pk(), cgMint = pk(), skrMint = pk(), usdcMint = pk(), coreCollection = pk();
afterEach(async () => { cleanup(); vi.clearAllMocks(); useUiStore.setState({ toasts: [] }); await act(() => setLocale('en')); });

for (const locale of LOCALES) it(`${locale}: SKR listing labels, proceeds and receipt match wire code 2 after language switching`, async () => {
  await act(() => setLocale(locale));
  mocks.wallet = { publicKey: seller };
  mocks.cfg = { cgMint, skrMint, usdcMint, collectionsCreated: 8, marketFeeBps: 750 };
  mocks.cores.mockResolvedValue(new Map([[0, coreCollection]]));
  mocks.send.mockResolvedValue({ signature: 'test-only' });
  const onClose = vi.fn();
  render(<><ListModal chip={{ asset: asset.toBase58(), collection: 0, rarity: 0 }} onClose={onClose} /><Toasts /></>);
  expect((screen.getByRole('textbox', { name: t('market.price', { currency: 'SOL' }) }) as HTMLInputElement).placeholder).toBe(fmtDecimal(0.25));
  fireEvent.click(screen.getByRole('button', { name: 'USDC' }));
  expect((screen.getByRole('textbox', { name: t('market.price', { currency: 'USDC' }) }) as HTMLInputElement).placeholder).toBe(fmtDecimal(12));
  fireEvent.click(screen.getByRole('button', { name: 'SKR' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '12,345678' } });
  const amount = 12345678n, net = amount - amount * 750n / 10000n - amount * 250n / 10000n;
  expect(screen.getByRole('dialog').textContent).toContain(t('market.price', { currency: 'SKR' }));
  expect(screen.getByRole('dialog').textContent).toContain(fmtAmount(net, 'SKR'));
  expect(screen.getByRole('dialog').textContent).not.toContain(fmtAmount(net, 'CG'));
  fireEvent.click(screen.getByRole('button', { name: t('market.list') }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  const ixs = mocks.send.mock.calls[0][2] as TransactionInstruction[];
  expect(ixs).toHaveLength(2);
  expect(ixs[1].data.readBigUInt64LE(8)).toBe(amount);
  expect(ixs[1].data[16]).toBe(2);
  // The listing fee is still burned in CG; it must not be relabelled SKR with the sale price.
  expect(ixs[1].keys[8].pubkey.equals(cgMint)).toBe(true);
  const body = () => `${fmtAmount(amount, 'SKR')} · ${t('market.feeBurned', { amount: fmtCg(500000n) })}`;
  expect(screen.getByText(body(), { normalizer: v => v })).toBeTruthy();
  await act(() => setLocale(locale === 'en' ? 'ru' : 'en'));
  expect(screen.getByText(body(), { normalizer: v => v })).toBeTruthy();
  expect(mocks.send).toHaveBeenCalledOnce();
  expect(ixs[1].data.readBigUInt64LE(8)).toBe(amount);
});
