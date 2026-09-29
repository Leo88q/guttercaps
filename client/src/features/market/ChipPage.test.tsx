// @vitest-environment happy-dom
// Exercise the real page handlers, instruction builders and decimal parser.
// The send boundary is intercepted: no wallet signing or RPC calls occur.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Keypair, type TransactionInstruction } from '@solana/web3.js';
import { LOCALES, setLocale, t } from '@/shared/i18n';
import { fmtAmount } from '@/shared/lib/format';
import { ata } from '@/chain/pdas';

const mocks = vi.hoisted(() => ({
  detail: undefined as unknown,
  wallet: undefined as unknown,
  cfg: undefined as unknown,
  send: vi.fn(), cores: vi.fn(), invalidate: vi.fn(),
}));
vi.mock('@/api/hooks', () => ({ useChipDetail: () => ({ data: mocks.detail, isLoading: false }) }));
vi.mock('@/api/client', () => ({ isMock: () => false }));
vi.mock('@/chain/hooks', () => ({ useGameConfig: () => ({ data: mocks.cfg }), useWalletLike: () => mocks.wallet }));
vi.mock('@solana/wallet-adapter-react', () => ({ useWallet: () => mocks.wallet, useConnection: () => ({ connection: {} }) }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: mocks.invalidate }) }));
vi.mock('@/chain/flows/packFlow', () => ({ fetchCoreCollections: mocks.cores }));
vi.mock('@/chain/tx', () => ({ sendTx: mocks.send }));
// Listing modal is not part of the buy/reprice regression.
vi.mock('./ListModal', () => ({ ListModal: () => null }));
import ChipPage from './ChipPage';

const key = () => Keypair.generate().publicKey;
const buyer = key(), seller = key(), asset = key(), skrMint = key(), usdcMint = key(), treasury = key(), buybackWallet = key(), coreCollection = key();
function mount(own: boolean) {
  mocks.wallet = { publicKey: own ? seller : buyer, signTransaction: vi.fn() };
  mocks.cfg = { skrMint, usdcMint, treasury, buybackWallet, collectionsCreated: 8, marketFeeBps: 750 };
  mocks.detail = { asset: asset.toBase58(), owner: seller.toBase58(), collection: 0, rarity: 2, level: 1, power: 210, stakeWeight: 5,
    flags: {}, listing: { seller: seller.toBase58(), currency: 'SKR', price: '12345678', priceUsd: 0.2 } };
  mocks.send.mockResolvedValue({ signature: 'test-signature' });
  mocks.cores.mockResolvedValue(new Map([[0, coreCollection]]));
  return render(<MemoryRouter initialEntries={[`/market/${asset.toBase58()}`]}><Routes><Route path="/market/:asset" element={<ChipPage />} /></Routes></MemoryRouter>);
}
afterEach(async () => { cleanup(); vi.clearAllMocks(); await setLocale('en'); });

describe('SKR page actions remain correct after localization', () => {
  for (const locale of LOCALES) {
    it(`${locale}: purchase pins SKR price/code and prepares SKR recipients`, async () => {
      await setLocale(locale);
      mount(false);
      fireEvent.click(screen.getByRole('button', { name: t('ui.buyFor', { amount: fmtAmount(12_345_678n, 'SKR') }) }));
      await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
      const ixs = mocks.send.mock.calls[0][2] as TransactionInstruction[];
      expect(ixs).toHaveLength(4);
      expect(ixs[3].data.readBigUInt64LE(8)).toBe(12_345_678n);
      expect(ixs[3].data[16]).toBe(2);
      expect(ixs[3].keys[11].pubkey.equals(ata(skrMint, buyer))).toBe(true);
      expect(ixs[0].keys[1].pubkey.equals(ata(skrMint, seller))).toBe(true);
    });
    it(`${locale}: repricing 12,345678 SKR signs 12345678 micro-SKR and shows SKR proceeds`, async () => {
      await setLocale(locale);
      mount(true);
      fireEvent.click(screen.getByRole('button', { name: t('ui.changePrice') }));
      const dialog = screen.getByRole('dialog');
      fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '12,345678' } });
      // 7.5% protocol + 2.5% royalty, each integer-rounded as on chain.
      const amount = 12_345_678n;
      const net = amount - amount * 750n / 10_000n - amount * 250n / 10_000n;
      expect(dialog.textContent).toContain(fmtAmount(net, 'SKR'));
      expect(dialog.textContent).not.toMatch(/SOL|USDC/);
      fireEvent.click(within(dialog).getByRole('button', { name: t('ui.update') }));
      await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
      const ixs = mocks.send.mock.calls[0][2] as TransactionInstruction[];
      expect(ixs).toHaveLength(1);
      expect(ixs[0].data.readBigUInt64LE(8)).toBe(12_345_678n);
    });
  }
});
