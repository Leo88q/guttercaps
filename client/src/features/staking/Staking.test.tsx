// @vitest-environment happy-dom
// The Core-NFT chip-staking paths the UI used to call (`stake_chip`, `unstake_chip`, `claim_chip`)
// need a Core asset and its ChipState, and neither can exist on a live config — `open_pack` is
// fail-closed. `stake_compressed_chip_v2` / `unstake_compressed_chip` operate on the registered
// Bubblegum V2 leaf instead.
//
// This renders the real Staking screen with a fake chain: `connection.getAccountInfo` answers the
// `["compressed_chip", asset]`, `BubblegumTreeMeta` and `CompressedMintClaim` accounts with real
// buffers, DAS answers with a real-shaped proof, and `sendTx` is intercepted so the transaction the
// UI built is inspected instead of sent. What is asserted is the seam that used to be missing: the
// screen resolves a leaf and produces one instruction with the `stake_compressed_chip_v2` /
// `unstake_compressed_chip` discriminator, carrying the proof as remaining accounts.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Keypair, PublicKey } from '@solana/web3.js';
import { accountDiscriminator, ixDiscriminator } from '@/chain/anchor';
import { BorshWriter } from '@/chain/borsh';
import { bubblegumTreeMetaPda, compressedChipStatePda, compressedChipStakePda } from '@/chain/pdas';
import { deriveBubblegumLeafAssetId } from '@/chain/bubblegum';
import { chainKeys } from '@/chain/hooks';
import { ata, emissionPda } from '@/chain/pdas';
import { ASSOCIATED_TOKEN_PROGRAM_ID } from '@/chain/ids';

const OWNER = Keypair.generate().publicKey;
const CG_MINT = Keypair.generate().publicKey;
const MERKLE_TREE = Keypair.generate().publicKey;
const CORE_COLLECTION = Keypair.generate().publicKey;
const TREE_CONFIG = Keypair.generate().publicKey;
const CLAIM = Keypair.generate().publicKey;
const ASSET = deriveBubblegumLeafAssetId(MERKLE_TREE, 11);

const sent: { programId: PublicKey; data: Uint8Array; keys: { pubkey: PublicKey }[] }[] = [];
let dasCalls = 0;

vi.mock('@/chain/tx', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/chain/tx')>(),
  sendTx: async (_c: unknown, _w: unknown, ixs: unknown[]) => {
    for (const ix of ixs as typeof sent) sent.push(ix);
    return { signature: '5'.repeat(64), logs: [] };
  },
}));

// The DAS boundary: the only place the Merkle path exists. Counted so a test can prove the unstake
// path does NOT pay for a proof it never reads.
vi.mock('@/features/market/payment', () => ({
  dasClient: () => ({
    getAssetWithProof: async () => {
      dasCalls += 1;
      return {
        assetId: ASSET, leafOwner: OWNER, leafDelegate: OWNER, merkleTree: MERKLE_TREE,
        root: new Uint8Array(32).fill(9), dataHash: new Uint8Array(32).fill(1), creatorHash: new Uint8Array(32).fill(2),
        collectionHash: new Uint8Array(32).fill(3), assetDataHash: new Uint8Array(32).fill(4),
        flags: 0, leafNonce: 11n, leafIndex: 11n, proof: [Keypair.generate().publicKey, Keypair.generate().publicKey],
      };
    },
  }),
}));

vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => ({ publicKey: OWNER, connected: true, signTransaction: async (tx: unknown) => tx }),
  useConnection: () => ({
    connection: {
      // Only the leaf identity / claim / stake accounts are answered; anything else stays null so the test
      // fails loudly if the screen starts reading an account it should not need.
      getAccountInfo: async (pk: PublicKey) => {
        if (pk.equals(compressedChipStatePda(ASSET)[0])) return { data: Buffer.from(chipState(CHIP.staked ? 1 : 0)) };
        if (pk.equals(bubblegumTreeMetaPda(3)[0])) return { data: Buffer.from(treeMeta()) };
        if (pk.equals(CLAIM)) return { data: Buffer.from(claimAccount(CHIP.staked)) };
        if (pk.equals(compressedChipStakePda(CLAIM)[0]) && CHIP.staked) {
          const w = new BorshWriter();
          w.bytes(accountDiscriminator('CompressedChipStake'));
          w.pubkey(OWNER).pubkey(CLAIM).u128(1000n).u128(0n).i64(1n).u8(200);
          return { data: Buffer.from(w.toBytes()) };
        }
        return null;
      },
      getMultipleAccountsInfo: async () => [],
      getSlot: async () => 1,
      getLatestBlockhash: async () => ({ blockhash: '1'.repeat(32), lastValidBlockHeight: 1 }),
    },
  }),
  ConnectionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  WalletProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import Staking from './Staking';
import { ChipDrawer } from '@/features/collection/ChipDrawer';

/** A real-shaped `CompressedChipState`. `stakedFlag` flips the bit the program sets on a stake. */
function chipState(stakedFlag: number): Uint8Array {
  const w = new BorshWriter();
  w.bytes(accountDiscriminator('CompressedChipState'));
  w.pubkey(ASSET).pubkey(CLAIM).u8(3).pubkey(MERKLE_TREE).u32(11).u64(11n);
  for (let i = 0; i < 4; i++) w.bytes(new Uint8Array(32).fill(i + 1));
  w.u8(0).u8(4).u8(9).u64(77n).u8(stakedFlag).i64(0n).i64(1n).u8(200);
  return w.toBytes();
}

function treeMeta(): Uint8Array {
  const w = new BorshWriter();
  w.bytes(accountDiscriminator('BubblegumTreeMeta'));
  w.u8(3).pubkey(CORE_COLLECTION).pubkey(MERKLE_TREE).pubkey(TREE_CONFIG)
    .pubkey(PublicKey.default).u8(14).u8(8).bool(true).u8(201);
  return w.toBytes();
}

/** A real-shaped `CompressedMintClaim` — the receipt `stake_compressed_chip_v2` gates on. */
function claimAccount(staked: boolean): Uint8Array {
  const w = new BorshWriter();
  w.bytes(accountDiscriminator('CompressedMintClaim'));
  w.pubkey(OWNER).u8(3).u8(4).u8(9).u64(7n).i64(0n).pubkey(Keypair.generate().publicKey);
  w.bool(true).bool(true).bool(true).bool(false).bool(false).u8(9).bool(staked)
    .pubkey(Keypair.generate().publicKey).i64(0n);
  return w.toBytes();
}

/** The chip the API serves. Note there is no `claim` field: the read model does not carry it. */
const chip = (staked: boolean) => ({
  asset: ASSET.toBase58(), owner: OWNER.toBase58(), collection: 3, rarity: 4, level: 2, index: 11,
  flags: { staked, listed: false, fusing: false, soulbound: false }, lockUntil: null,
  power: 500, skin: null, stakeWeight: '1000',
  art: { image: '/art/04-4-256.webp', vfxTier: 0 },
});

function seed(qc: QueryClient, staked: boolean) {
  CHIP.staked = staked;
  // `useGameConfig` is live here, so the $CG mint the unstake needs is seeded as the chain config
  qc.setQueryData(chainKeys.config, { cgMint: CG_MINT, admin: OWNER } as never);
}

function mount(qc: QueryClient) {
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Staking />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// The page's own `run()` helper short-circuits on mock mode, so the API boundary is stubbed to
// "live" and every read the page performs is served from the seeded query cache instead.
const CHIP = { staked: false };
vi.mock('@/api/client', () => ({ isMock: () => false, setMockMode: () => {}, request: async () => ({}) }));
vi.mock('@/api/hooks', () => ({
  useStakingOverview: () => ({ data: { emission: {}, tokenPool: {}, chipPool: {} }, isLoading: false }),
  useStakingMe: () => ({ data: { chipStakes: [], tokenStakes: [], setBonus: { onChainSets: 0 } } }),
  useMyChips: () => ({ data: { pages: [{ items: [CHIP.staked ? chip(true) : chip(false)], nextCursor: null }] } }),
}));

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  window.scrollTo = () => {};
  (globalThis as { Buffer?: unknown }).Buffer ??= Buffer;
});

beforeEach(() => {
  cleanup(); sent.length = 0; dasCalls = 0;
  CHIP.staked = false;
});

describe('V2 chip staking', () => {
  it('staking a cap signs `stake_compressed_chip_v2` with the DAS proof as remaining accounts', async () => {
    const qc = new QueryClient();
    seed(qc, false);
    mount(qc);
    // open the picker and take the only cap it offers
    fireEvent.click(await screen.findByRole('button', { name: '+ Stake a cap' }));
    // the only cap the picker offers; the rarity label comes from the economy table, so the card
    // itself is the stable selector
    fireEvent.click(document.querySelector('.chip-card') as HTMLElement);
    await waitFor(() => expect(sent).toHaveLength(1));

    // exactly one instruction: the V2 stake has no ATA leg, unlike the Core-NFT path
    expect(sent).toHaveLength(1);
    const ix = sent[0];
    expect(ix.data.subarray(0, 8)).toEqual(Buffer.from(ixDiscriminator('stake_compressed_chip_v2')));
    // the leaf delegate and the four hashes + root are serialized into the args
    expect(ix.data.length).toBeGreaterThan(8 + 32 * 6);
    // the proof nodes ride as remaining accounts, so the instruction is not longer for them
    expect(ix.keys.length).toBeGreaterThanOrEqual(12);
    expect(dasCalls).toBe(1);
  });

  it('unstaking signs `unstake_compressed_chip` and pays for no proof it never reads', async () => {
    const qc = new QueryClient();
    seed(qc, true);
    mount(qc);
    const unstake = await screen.findByRole('button', { name: /Unstake/ });
    fireEvent.click(unstake);
    await waitFor(() => expect(sent).toHaveLength(2));

    // the ATA is prepared idempotently, then the unstake; nothing else
    expect(sent).toHaveLength(2);
    expect(sent[1].data.subarray(0, 8)).toEqual(Buffer.from(ixDiscriminator('unstake_compressed_chip')));
    // the unstake handler reads no proof, so the resolver must not fetch one
    expect(dasCalls).toBe(0);
    // the reward is minted by the unstake itself, so there is no separate claim button to click
    expect(screen.queryByRole('button', { name: /Claim/ })).toBeNull();
  });

  it('a cap the resolver refuses is reported, and nothing is signed', async () => {
    const qc = new QueryClient();
    seed(qc, false);
    // the claim names a different wallet, which `stake_compressed_chip_v2` refuses on chain
    vi.spyOn(PublicKey.prototype, 'equals').mockReturnValue(false);
    mount(qc);
    fireEvent.click(await screen.findByRole('button', { name: '+ Stake a cap' }));
    fireEvent.click(document.querySelector('.chip-card') as HTMLElement);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(sent).toHaveLength(0);
    vi.restoreAllMocks();
  });
});


it('the collection drawer also unstakes a genuinely staked cap without DAS', async () => {
  const qc = new QueryClient();
  seed(qc, true);
  const onClose = vi.fn();
  render(<QueryClientProvider client={qc}><MemoryRouter>
    <ChipDrawer chip={chip(true)} onClose={onClose} />
  </MemoryRouter></QueryClientProvider>);
  fireEvent.click(screen.getByRole('button', { name: /Unstake/ }));
  await waitFor(() => expect(sent).toHaveLength(2));
  expect(sent[1].data.subarray(0, 8)).toEqual(Buffer.from(ixDiscriminator('unstake_compressed_chip')));
  expect(dasCalls).toBe(0);
  expect(onClose).toHaveBeenCalledOnce();
});

it('the first 30-day CG stake creates the shared vault before depositing, in one wallet transaction', async () => {
  const qc = new QueryClient();
  seed(qc, false);
  mount(qc);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '1000' } });
  fireEvent.click(await screen.findByRole('button', { name: /^Stake 30/ }));
  await waitFor(() => expect(sent).toHaveLength(3));
  expect(sent[0].programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
  expect(sent[1].programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
  expect(sent[1].keys[1].pubkey.equals(ata(CG_MINT, emissionPda()[0]))).toBe(true);
  expect(sent[1].keys[2].pubkey.equals(emissionPda()[0])).toBe(true);
  expect([...sent[1].data]).toEqual([1]); // CreateIdempotent, never a transfer to an arbitrary account
  expect(sent[2].data.subarray(0, 8)).toEqual(Buffer.from(ixDiscriminator('stake_cg')));
  expect(sent[2].data[8]).toBe(1); // 30 days; the fix must not change the chosen tier
  expect(sent[2].keys[6].pubkey.equals(sent[1].keys[1].pubkey)).toBe(true);
});
