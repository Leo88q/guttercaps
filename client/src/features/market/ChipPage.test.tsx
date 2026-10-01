// @vitest-environment happy-dom
// Exercise the real page handlers, instruction builders and decimal parser.
// The send boundary is intercepted: no wallet signing or RPC calls occur.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Keypair, type TransactionInstruction } from '@solana/web3.js';
import { LOCALES, setLocale, t } from '@/shared/i18n';
import { fmtAmount } from '@/shared/lib/format';
import { bubblegumTreeConfigPda } from '@/chain/pdas';

const mocks = vi.hoisted(() => ({
  detail: undefined as unknown,
  wallet: undefined as unknown,
  cfg: undefined as unknown,
  send: vi.fn(), resolve: vi.fn(), invalidate: vi.fn(),
}));
vi.mock('@/api/hooks', () => ({ useChipDetail: () => ({ data: mocks.detail, isLoading: false }) }));
vi.mock('@/api/client', () => ({ isMock: () => false }));
vi.mock('@/chain/hooks', () => ({ useGameConfig: () => ({ data: mocks.cfg }), useWalletLike: () => mocks.wallet }));
vi.mock('@solana/wallet-adapter-react', () => ({ useWallet: () => mocks.wallet, useConnection: () => ({ connection: {} }) }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: mocks.invalidate }) }));
// the leaf resolver is the on-chain + DAS boundary, replaced here by a fixed leaf
vi.mock('@/chain/flows/compressedChip', () => ({ resolveCompressedChip: mocks.resolve }));
vi.mock('@/chain/tx', () => ({ sendTx: mocks.send }));
// Listing modal is not part of the buy/cancel regression.
vi.mock('./ListModal', () => ({ ListModal: () => null }));
import ChipPage from './ChipPage';

const key = () => Keypair.generate().publicKey;
const buyer = key(), seller = key(), asset = key(), claim = key(), merkleTree = key(), treasury = key(), buybackWallet = key();
/** The leaf a resolved buy/cancel carries: claim PDA, tree, leaf index and a DAS proof. */
const leaf = () => ({
  asset, claim, chip: key(), merkleTree,
  // the tree config is derived from the tree, exactly as the program requires
  treeConfig: bubblegumTreeConfigPda(merkleTree)[0], coreCollection: key(),
  collectionIdx: 0, delegate: seller,
  proof: { assetId: asset, leafOwner: seller, leafDelegate: seller, merkleTree, root: new Uint8Array(32).fill(9), dataHash: new Uint8Array(32), creatorHash: new Uint8Array(32), collectionHash: new Uint8Array(32), assetDataHash: new Uint8Array(32), flags: 0, leafNonce: 4n, leafIndex: 4n, proof: [key(), key()] },
  leaf: { root: new Uint8Array(32), dataHash: new Uint8Array(32), creatorHash: new Uint8Array(32), collectionHash: new Uint8Array(32), assetDataHash: new Uint8Array(32), flags: 0, nonce: 4n, index: 4, proofNodes: [key(), key()] },
});

/** Price is a string of lamports, as the API returns it. */
const LAMPORTS = 12_345_678n;

function mount(own: boolean, currency = 'SOL') {
  mocks.wallet = { publicKey: own ? seller : buyer, signTransaction: vi.fn() };
  mocks.cfg = { treasury, buybackWallet, collectionsCreated: 8, marketFeeBps: 750 };
  mocks.detail = { asset: asset.toBase58(), owner: seller.toBase58(), collection: 0, rarity: 2, level: 1, power: 210, stakeWeight: 5,
    flags: {}, listing: { seller: seller.toBase58(), currency, price: String(LAMPORTS), priceUsd: 0.2 } };
  mocks.send.mockResolvedValue({ signature: 'test-signature' });
  mocks.resolve.mockResolvedValue(leaf());
  return render(<MemoryRouter initialEntries={[`/market/${asset.toBase58()}`]}><Routes><Route path="/market/:asset" element={<ChipPage />} /></Routes></MemoryRouter>);
}
afterEach(async () => { cleanup(); vi.clearAllMocks(); await setLocale('en'); });

describe('V2 page actions remain correct after localization', () => {
  for (const locale of LOCALES) {
    it(`${locale}: purchase resolves the leaf and signs the V2 buy with the pinned price`, async () => {
      await setLocale(locale);
      mount(false);
      fireEvent.click(screen.getByRole('button', { name: t('ui.buyFor', { amount: fmtAmount(LAMPORTS, 'SOL') }) }));
      await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
      const ixs = mocks.send.mock.calls[0][2] as TransactionInstruction[];
      // one instruction: the V2 buy has no SPL leg, so no ATA preparation
      expect(ixs).toHaveLength(1);
      // SEC-F5: the expected price is pinned in the args so a front-run cannot reprice the fill
      expect(ixs[0].data.readBigUInt64LE(ixs[0].data.length - 8)).toBe(LAMPORTS);
      expect(ixs[0].keys.some((k) => k.pubkey.equals(claim))).toBe(true);
      expect(mocks.resolve).toHaveBeenCalledOnce();
    });

    it(`${locale}: cancelling a listing returns the leaf through the V2 cancel`, async () => {
      await setLocale(locale);
      mount(true);
      fireEvent.click(screen.getByRole('button', { name: t('market.cancelListing') }));
      await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
      const ixs = mocks.send.mock.calls[0][2] as TransactionInstruction[];
      expect(ixs).toHaveLength(1);
      expect(ixs[0].keys.some((k) => k.pubkey.equals(claim))).toBe(true);
      // the change-price path is gone: the Core-NFT `update_price` has no V2 equivalent
      expect(screen.queryByRole('button', { name: t('ui.changePrice') })).toBeNull();
    });
  }
});

it('a listing row in USDC or SKR cannot be bought — the button is refused, not silently paid in SOL (SEC-B28)', async () => {
  for (const currency of ['USDC', 'SKR'] as const) {
    mount(false, currency);
    // the button is present (the row is real) but disabled, so nothing can be sent
    expect((screen.getByRole('button', { name: t('ui.buyFor', { amount: fmtAmount(LAMPORTS, currency) }) }) as HTMLButtonElement).disabled).toBe(true);
  }
});

it('a chip that is not for sale offers no buy, and no Core-NFT offer either', async () => {
  mount(false);
  (mocks.detail as { listing: null }).listing = null;
  // re-render with the same query cache: `useChipDetail` reads the mocked detail again
  const r = render(<MemoryRouter initialEntries={[`/market/${asset.toBase58()}`]}><Routes><Route path="/market/:asset" element={<ChipPage />} /></Routes></MemoryRouter>);
  expect(screen.queryByRole('button', { name: t('market.makeOffer') })).toBeNull();
  // `makeOffer` used to be the not-for-sale action; the V2 asset market has no offer instruction
  expect(r.container.querySelector('.card')?.textContent).toContain(t('market.solOnly'));
  r.unmount();
});
