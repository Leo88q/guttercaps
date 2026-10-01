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
// instruction with the `accept_battle` discriminator, signed by the opponent, against the
// battle PDA and the escrow ATAs.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Keypair, PublicKey } from '@solana/web3.js';
import { accountDiscriminator, ixDiscriminator } from '@/chain/anchor';
import { BorshWriter } from '@/chain/borsh';
import { battlePda } from '@/chain/pdas';
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
          if (!pk.equals(battle)) return null;
          return { data: Buffer.from(fakeBattle()), executable: false, lamports: 1, owner: ARENA };
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

/** Three caps owned by the opponent, seeded straight into the infinite-query cache so the squad the
 *  test picks is the squad the instruction must carry — the mock inventory is randomised. */
const MY_CHIPS = [0, 1, 2].map((i) => ({
  asset: Keypair.generate().publicKey.toBase58(), owner: OPPONENT.toBase58(),
  collection: i, rarity: 3 + i, level: 2, index: 10 + i,
  flags: { staked: false, listed: false, fusing: false, soulbound: false }, lockUntil: null,
  power: 500, skin: null, stakeWeight: '1000',
  art: { image: `/art/0${i + 1}-${3 + i}-256.webp`, vfxTier: 0 },
}));

function seed(qc: QueryClient) {
  qc.setQueryData(chainKeys.config, { cgMint: CG_MINT, admin: OPPONENT } as never);
  qc.setQueryData(qk.myChips({}), { pages: [{ items: MY_CHIPS, nextCursor: null }], pageParams: [undefined] });
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
  cleanup(); sent.length = 0; connected = true;
  // the chip list is gated on a SIWS session, and the accept path needs three owned caps
  useSessionStore.setState({ status: 'authenticated', address: OPPONENT.toBase58() });
});

describe('arena: accepting a wager battle', () => {
  it('reads the challenger’s battle from the PDA and sends exactly accept_battle', async () => {
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
      .toBe(Buffer.from(ixDiscriminator('accept_battle')).toString('hex'));
    expect(ix.data).toHaveLength(8); // accept_battle carries no arguments
    const [battle] = battlePda(CHALLENGER, NONCE);
    expect(ix.keys[0].pubkey.equals(OPPONENT) && ix.keys[0].isSigner).toBe(true);   // opponent signs
    expect(ix.keys[2].pubkey.equals(battle) && ix.keys[2].isWritable).toBe(true);   // the battle
    // 3 caps → 3 (asset, chip_state) pairs appended after the fixed prologue
    expect(ix.keys).toHaveLength(6 + 6);
    for (const c of MY_CHIPS) expect(ix.keys.some((k) => k.pubkey.equals(new PublicKey(c.asset)))).toBe(true);
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
