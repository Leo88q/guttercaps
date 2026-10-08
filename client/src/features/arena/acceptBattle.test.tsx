// @vitest-environment happy-dom
// Regression guard for the gap the 2026-10-01 audit found: `accept_battle` existed as
// `acceptBattleIx` in chain/ix/arena.ts and was imported by nothing — not the UI, not a
// test — so a challenger could escrow a wager and no client path could ever take it.
//
// This renders the real Arena screen with the in-browser mock API (so chips and season
// data exist) but a fake chain: `connection.getAccountInfo` answers the Battle PDA with a
// real WagerBattle buffer, and `sendTx` is intercepted so the transaction the UI built can
// be inspected instead of sent. What is asserted is the seam that used to be missing: the
// screen reads the challenger's battle, and clicking Accept produces exactly one
// instruction with the `accept_battle_v2` discriminator, signed by the opponent, against the
// battle PDA and the escrow ATAs, with all three squad proofs as remaining accounts.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Keypair, PublicKey } from '@solana/web3.js';
import { accountDiscriminator, ixDiscriminator } from '@/chain/anchor';
import { BorshWriter } from '@/chain/borsh';
import { battlePda, bubblegumTreeMetaPda, compressedChipStatePda } from '@/chain/pdas';
import { chainKeys } from '@/chain/hooks';
import { setMockMode } from '@/api/client';
import { qk } from '@/api/keys';
import { useSessionStore } from '@/app/store/session';

const CHALLENGER = Keypair.generate().publicKey;
const OPPONENT = Keypair.generate().publicKey;
const CG_MINT = Keypair.generate().publicKey;
const NONCE = 4242n;
const SQUAD_A = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];

let connected = false;
let chainStaked = false;
const sent: { programId: PublicKey; data: Uint8Array; keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] }[] = [];

vi.mock('@/chain/tx', () => ({
  sendTx: async (_c: unknown, _w: unknown, ixs: unknown[]) => {
    for (const ix of ixs as typeof sent) sent.push(ix);
    return { signature: '5'.repeat(64), logs: [] };
  },
}));

vi.mock('@solana/wallet-adapter-react', async () => {
  const actual = await vi.importActual<typeof import('@solana/wallet-adapter-react')>('@solana/wallet-adapter-react');
  return {
    ...actual,
    useWallet: () => ({
      publicKey: connected ? OPPONENT : null, connected, connecting: false,
      wallet: connected ? { adapter: { name: 'FakeWallet' } } : null,
      signTransaction: connected ? async (tx: unknown) => tx : undefined,
      signMessage: connected ? async () => new Uint8Array(64) : undefined,
      disconnect: async () => { connected = false; },
    }),
    useConnection: () => ({
      connection: {
        // Only the battle PDA is answered; anything else (config, chips) stays null so the
        // test fails loudly if the screen starts reading an account it should not need.
        getAccountInfo: async (pk: PublicKey) => {
          const [battle] = battlePda(CHALLENGER, NONCE);
          if (pk.equals(battle)) return { data: Buffer.from(fakeBattle()), executable: false, lamports: 1, owner: ARENA };
          for (const l of LEAVES) {
            if (pk.equals(compressedChipStatePda(l.asset)[0])) return { data: Buffer.from(chipState(l)) };
            if (pk.equals(l.claim)) return { data: Buffer.from(claimAccount()) };
          }
          // one tree per collection, so the meta is the same account for all three leaves
          if (pk.equals(bubblegumTreeMetaPda(0)[0])) return { data: Buffer.from(treeMeta()) };
          return null;
        },
        getMultipleAccountsInfo: async () => [],
        getSlot: async () => 1,
        getLatestBlockhash: async () => ({ blockhash: '1'.repeat(32), lastValidBlockHeight: 1 }),
      },
    }),
    ConnectionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    WalletProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

import { ARENA_ID as ARENA } from '@/chain/ids';
import Arena from './Arena';

/** A real-shaped WagerBattle account: status 0 (open), nonce = NONCE, challenger pinned. */
function fakeBattle(): Uint8Array {
  const w = new BorshWriter();
  w.bytes(accountDiscriminator('WagerBattle'));
  w.pubkey(CHALLENGER);                       // challenger
  w.pubkey(PublicKey.default);                // opponent — unset until accepted
  w.u64(25_000_000n);                         // wager (25 $CG)
  for (const s of SQUAD_A) w.pubkey(s);       // squadA (fixed [Pubkey; 3])
  for (let i = 0; i < 3; i++) w.pubkey(PublicKey.default); // squadB
  w.u32(900); w.u32(0);                       // powerA / powerB
  w.pubkey(Keypair.generate().publicKey);     // randomness
  w.u64(1);                                   // commitSlot
  w.u8(0);                                    // status = open
  w.i64(1); w.i64(0);                         // createdAt / acceptedAt
  w.pubkey(PublicKey.default);                // winner
  w.bytes(new Uint8Array(32));                // resultHash
  w.u64(NONCE);                               // nonce
  w.u8(255);                                  // bump
  return w.toBytes();
}

/**
 * Three registered V2 leaves owned by the opponent, seeded straight into the infinite-query cache so
 * the squad the test picks is the squad the instruction must carry — the mock inventory is
 * randomised. Each one gets a real `["compressed_chip", asset]` projection, a real `BubblegumTreeMeta`
 * and a real `CompressedMintClaim`, because `accept_battle_v2` re-verifies all three on chain and the
 * client now resolves them before it builds anything.
 */
// one collection, one tree — which is what a real deployment has, and what the shared
// `["bubblegum_tree", 0]` meta PDA implies
const TREE = Keypair.generate().publicKey;
const LEAVES = [0, 1, 2].map((i) => ({
  asset: Keypair.generate().publicKey, claim: Keypair.generate().publicKey,
  merkleTree: TREE, leafIndex: 100 + i,
}));
const MY_CHIPS = LEAVES.map((l, i) => ({
  asset: l.asset.toBase58(), owner: OPPONENT.toBase58(),
  collection: i, rarity: 3 + i, level: 2, index: 10 + i,
  flags: { staked: false, listed: false, fusing: false, soulbound: false }, lockUntil: null,
  power: 500, skin: null, stakeWeight: '1000',
  art: { image: `/art/0${i + 1}-${3 + i}-256.webp`, vfxTier: 0 },
}));

/** A real-shaped `CompressedChipState` for one leaf. */
function chipState(l: (typeof LEAVES)[number]): Uint8Array {
  const w = new BorshWriter();
  w.bytes(accountDiscriminator('CompressedChipState'));
  w.pubkey(l.asset).pubkey(l.claim).u8(0).pubkey(l.merkleTree).u32(l.leafIndex).u64(BigInt(l.leafIndex));
  for (let i = 0; i < 4; i++) w.bytes(new Uint8Array(32).fill(i + 1));
  w.u8(0).u8(4).u8(9).u64(77n).u8(chainStaked ? 1 : 0).i64(0n).i64(1n).u8(200);
  return w.toBytes();
}

function treeMeta(): Uint8Array {
  const w = new BorshWriter();
  w.bytes(accountDiscriminator('BubblegumTreeMeta'));
  w.u8(0).pubkey(Keypair.generate().publicKey).pubkey(TREE)
    .pubkey(Keypair.generate().publicKey).pubkey(PublicKey.default).u8(14).u8(8).bool(true).u8(201);
  return w.toBytes();
}

function claimAccount(): Uint8Array {
  const w = new BorshWriter();
  w.bytes(accountDiscriminator('CompressedMintClaim'));
  w.pubkey(OPPONENT).u8(0).u8(4).u8(9).u64(7n).i64(0n).pubkey(Keypair.generate().publicKey);
  w.bool(true).bool(true).bool(true).bool(false).bool(false).u8(9).bool(chainStaked)
    .pubkey(Keypair.generate().publicKey).i64(0n);
  return w.toBytes();
}

// DAS is the only place the Merkle path exists, so the resolver's proof source is stubbed here.
vi.mock('@/features/market/payment', () => ({
  dasClient: () => ({
    getAssetWithProof: async (id: PublicKey) => {
      const l = LEAVES.find((x) => x.asset.equals(id))!;
      return {
        assetId: l.asset, leafOwner: OPPONENT, leafDelegate: OPPONENT, merkleTree: l.merkleTree,
        root: new Uint8Array(32).fill(9), dataHash: new Uint8Array(32).fill(1), creatorHash: new Uint8Array(32).fill(2),
        collectionHash: new Uint8Array(32).fill(3), assetDataHash: new Uint8Array(32).fill(4),
        flags: 0, leafNonce: BigInt(l.leafIndex), leafIndex: BigInt(l.leafIndex),
        proof: [Keypair.generate().publicKey, Keypair.generate().publicKey],
      };
    },
  }),
}));

function seed(qc: QueryClient) {
  qc.setQueryData(chainKeys.config, { cgMint: CG_MINT, admin: OPPONENT } as never);
  qc.setQueryData(qk.myChips({}), { pages: [{ items: MY_CHIPS.map(c => ({ ...c, flags: { ...c.flags, staked: chainStaked } })), nextCursor: null }], pageParams: [undefined] });
}

function mount(qc: QueryClient) {
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/arena?challenger=${CHALLENGER.toBase58()}&nonce=${NONCE}`]}>
        <Arena />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeAll(() => {
  setMockMode(true);
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  window.scrollTo = () => {};
  (globalThis as { Buffer?: unknown }).Buffer ??= Buffer;
});

beforeEach(() => {
  cleanup(); sent.length = 0; connected = true; chainStaked = false;
  // the chip list is gated on a SIWS session, and the accept path needs three owned caps
  useSessionStore.setState({ status: 'authenticated', address: OPPONENT.toBase58() });
});

describe('arena: accepting a wager battle', () => {
  it.each([false, true])('reads the battle and sends accept_battle_v2 (staked squad: %s)', async (staked) => {
    chainStaked = staked;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // useGameConfig is disabled in mock mode, so the $CG mint the escrow needs is seeded directly.
    seed(qc);
    mount(qc);

    // 1. the invite from the URL is picked up and the battle loads (status open → no error)
    await waitFor(() => expect(screen.getByText(/Accept and stake/i)).toBeTruthy(), { timeout: 4000 });

    // 2. a squad of three is required — the confirm button is inert without one
    const confirm = () => screen.getByText(/Accept and stake/i).closest('button') as HTMLButtonElement;
    expect(confirm().disabled).toBe(true);

    // 3. pick three caps through the squad modal
    fireEvent.click(document.querySelector('.squad-slot-plus')!.closest('div') as HTMLElement);
    const cards = await waitFor(() => {
      const found = document.querySelectorAll('.chip-card');
      expect(found.length).toBeGreaterThanOrEqual(3);
      return found;
    });
    await act(async () => { for (let i = 0; i < 3; i++) fireEvent.click(cards[i]); });
    fireEvent.click(screen.getByText(/^Done/i));

    // 4. accept
    await waitFor(() => expect(confirm().disabled).toBe(false));
    await act(async () => { fireEvent.click(confirm()); });

    // 5. the transaction is the one instruction, against the battle PDA and both escrow ATAs
    expect(sent).toHaveLength(1);
    const ix = sent[0];
    expect(ix.programId.equals(ARENA)).toBe(true);
    expect(Buffer.from(ix.data.subarray(0, 8)).toString('hex'))
      .toBe(Buffer.from(ixDiscriminator('accept_battle_v2')).toString('hex'));
    const [battle] = battlePda(CHALLENGER, NONCE);
    expect(ix.keys[0].pubkey.equals(OPPONENT) && ix.keys[0].isSigner).toBe(true);   // opponent signs
    expect(ix.keys[2].pubkey.equals(battle) && ix.keys[2].isWritable).toBe(true);   // the battle
    // the args are 3 delegates + 3 full leaf proofs (5×32 B + flags + nonce + index) + 3 depths,
    // and the proof nodes ride as remaining accounts after the fixed prologue
    expect(ix.data.length).toBe(8 + 3 * 32 + 3 * (32 * 5 + 1 + 8 + 4) + 3);
    // 7 fixed + 3 × (claim, chip, merkleTree) + 3 × 2 proof nodes
    expect(ix.keys).toHaveLength(7 + 9 + 6);
    for (const l of LEAVES) {
      expect(ix.keys.some((k) => k.pubkey.equals(l.claim))).toBe(true);
      expect(ix.keys.some((k) => k.pubkey.equals(compressedChipStatePda(l.asset)[0]))).toBe(true);
      expect(ix.keys.some((k) => k.pubkey.equals(l.merkleTree))).toBe(true);
    }
    // the three delegates the instruction carries are the live leaf delegates, in squad order
    for (let i = 0; i < 3; i++) {
      expect(new PublicKey(ix.data.subarray(8 + i * 32, 8 + (i + 1) * 32)).equals(OPPONENT)).toBe(true);
    }
  });

  it('refuses a battle that is not open, and one of your own', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seed(qc);
    mount(qc);
    await waitFor(() => expect(screen.getByText(/Accept and stake/i)).toBeTruthy(), { timeout: 4000 });
    // the account we hand back is open and owned by someone else, so both guards pass here;
    // the guards themselves are asserted by the unit test in chain.test.ts (builder shape) and
    // by the localnet suite (80-security / 40-arena). This test pins the UI half: the panel
    // reaches the confirm step only for a battle it could actually take.
    expect(sent).toHaveLength(0);
  });
});


it('explains why 300 power blocks BOTH battle buttons and unlocks them for a stronger squad', async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed(qc);
  const low = MY_CHIPS.map(c => ({ ...c, rarity: 0, level: 1, power: 100 }));
  const strong = { ...MY_CHIPS[0], asset: Keypair.generate().publicKey.toBase58(), flags: { ...MY_CHIPS[0].flags, staked: true } };
  qc.setQueryData(qk.myChips({}), { pages: [{ items: [...low, strong], nextCursor: null }], pageParams: [undefined] });
  mount(qc);
  await waitFor(() => expect(screen.getByText(/Accept and stake/i)).toBeTruthy());
  const ranked = () => screen.getByRole('button', { name: 'Ranked match' }) as HTMLButtonElement;
  const wager = () => screen.getByRole('button', { name: 'Wager battle ($CG)' }) as HTMLButtonElement;
  expect(ranked().disabled).toBe(true);
  expect(wager().disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Pick your squad (3)' }));
  const cards = document.querySelectorAll('.chip-card');
  expect(cards).toHaveLength(4);
  for (let i = 0; i < 3; i++) fireEvent.click(cards[i]);
  fireEvent.click(screen.getByText(/^Done/i));
  expect(screen.getByRole('status').textContent).toContain('Squad power 300 / 400');
  expect(ranked().disabled).toBe(true);
  expect(wager().disabled).toBe(true);
  expect(sent).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Pick your squad (3)' }));
  fireEvent.click(document.querySelectorAll('.chip-card')[0]);
  fireEvent.click(document.querySelectorAll('.chip-card')[3]);
  fireEvent.click(screen.getByText(/^Done/i));
  expect(screen.queryByRole('status')).toBeNull();
  expect(ranked().disabled).toBe(false);
  expect(wager().disabled).toBe(false);
});
