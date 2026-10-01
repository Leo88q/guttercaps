// @vitest-environment happy-dom
// Render the actual list dialog and intercept only the send boundary. No signature or RPC.
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Keypair, type TransactionInstruction } from '@solana/web3.js';
import { LOCALES, setLocale, t } from '@/shared/i18n';
import { fmtAmount, fmtCg, fmtDecimal } from '@/shared/lib/format';
import { useUiStore } from '@/app/store/ui';
import { Toasts } from '@/shared/ui/primitives';

const mocks = vi.hoisted(() => ({ wallet: undefined as unknown, cfg: undefined as unknown, send: vi.fn(), resolve: vi.fn(), invalidate: vi.fn() }));
vi.mock('@/api/hooks', () => ({ useFloor: () => ({ data: { skrUsd: 0.1, solUsd: 100 } }) }));
vi.mock('@/api/client', () => ({ isMock: () => false }));
vi.mock('@/chain/hooks', () => ({ useGameConfig: () => ({ data: mocks.cfg }), useWalletLike: () => mocks.wallet }));
vi.mock('@solana/wallet-adapter-react', () => ({ useConnection: () => ({ connection: {} }) }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: mocks.invalidate }) }));
// the resolver is the on-chain + DAS boundary; here it is replaced by a fixed leaf
vi.mock('@/chain/flows/compressedChip', () => ({ resolveCompressedChip: mocks.resolve }));
vi.mock('@/chain/tx', () => ({ sendTx: mocks.send }));
import { ListModal } from './ListModal';

const pk = () => Keypair.generate().publicKey;
const seller = pk(), asset = pk(), claim = pk(), merkleTree = pk();
afterEach(async () => { cleanup(); vi.clearAllMocks(); useUiStore.setState({ toasts: [] }); await act(() => setLocale('en')); });

for (const locale of LOCALES) it(`${locale}: SOL listing labels, proceeds and receipt survive a language switch`, async () => {
  await act(() => setLocale(locale));
  mocks.wallet = { publicKey: seller };
  mocks.cfg = { cgMint: pk(), marketFeeBps: 750 };
  mocks.resolve.mockResolvedValue({ asset, claim, chip: pk(), merkleTree, treeConfig: pk(), coreCollection: pk(), collectionIdx: 3, delegate: pk(), proof: { proof: [] }, leaf: {} });
  mocks.send.mockResolvedValue({ signature: 'test-only' });
  const onClose = vi.fn();
  render(<><ListModal chip={{ asset: asset.toBase58(), collection: 3, rarity: 0 }} onClose={onClose} /><Toasts /></>);
  expect((screen.getByRole('textbox', { name: t('market.price', { currency: 'SOL' }) }) as HTMLInputElement).placeholder).toBe(fmtDecimal(0.25));

  // SEC-B28: the currency picker is gone, not hidden. A USDC/SKR button would build a transaction
  // the program refuses at list time, so its absence is the fix.
  expect(screen.queryByRole('button', { name: 'USDC' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'SKR' })).toBeNull();
  expect(screen.getByRole('dialog').textContent).toContain(t('market.solOnly'));

  // 0.012345678 SOL — the input is in whole SOL with 9 decimals, not the 6 the Core-NFT path used
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '0,012345678' } });
  const amount = 12345678n, net = amount - amount * 750n / 10000n - amount * 250n / 10000n;
  expect(screen.getByRole('dialog').textContent).toContain(t('market.price', { currency: 'SOL' }));
  expect(screen.getByRole('dialog').textContent).toContain(fmtAmount(net, 'SOL'));
  expect(screen.getByRole('dialog').textContent).not.toContain(fmtAmount(net, 'CG'));
  fireEvent.click(screen.getByRole('button', { name: t('market.list') }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());

  const ixs = mocks.send.mock.calls[0][2] as TransactionInstruction[];
  // one instruction: the V2 list has no ATA leg to prepare, unlike the Core-NFT path
  expect(ixs).toHaveLength(1);
  expect(ixs[0].data.readBigUInt64LE(8)).toBe(amount);
  expect(ixs[0].data[16]).toBe(0); // wire currency tag 0 = SOL
  // the leaf is resolved through chain + DAS before the instruction is built, never from the API row
  expect(mocks.resolve).toHaveBeenCalledOnce();
  expect(mocks.resolve.mock.calls[0][2].equals(asset)).toBe(true);

  const body = () => `${fmtAmount(amount, 'SOL')} · ${t('market.feeBurned', { amount: fmtCg(500000n) })}`;
  expect(screen.getByText(body(), { normalizer: v => v })).toBeTruthy();
  await act(() => setLocale(locale === 'en' ? 'ru' : 'en'));
  expect(screen.getByText(body(), { normalizer: v => v })).toBeTruthy();
  expect(mocks.send).toHaveBeenCalledOnce();
  expect(ixs[0].data.readBigUInt64LE(8)).toBe(amount);
});

it('a resolver failure is reported, and no instruction is sent', async () => {
  mocks.wallet = { publicKey: seller };
  mocks.cfg = { cgMint: pk(), marketFeeBps: 750 };
  mocks.resolve.mockRejectedValue(new Error('this chip is listed'));
  mocks.send.mockResolvedValue({ signature: 'x' });
  render(<><ListModal chip={{ asset: asset.toBase58(), collection: 3, rarity: 0 }} onClose={vi.fn()} /><Toasts /></>);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '1.5' } });
  fireEvent.click(screen.getByRole('button', { name: t('market.list') }));
  await waitFor(() => expect(useUiStore.getState().toasts.length).toBeGreaterThan(0));
  expect(mocks.send).not.toHaveBeenCalled();
});
