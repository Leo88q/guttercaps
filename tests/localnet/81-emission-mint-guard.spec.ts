// T-L-SEC-F1 — `init_emission` binds the $CG mint forever; it must be the mint docs/02 promises.
//
// docs/02-economy.md: hard cap 1 B $CG, freeze authority none. Before SEC-F1 the instruction only
// checked `decimals == 6`, so a mint that still carried a freeze authority (its holder can freeze
// every player's and every pool's $CG account) or one pre-minted beyond the non-play allocation
// (supply + 550 M play emission > hard cap) was accepted. The shared environment's emission
// singleton is already live, so — like 51-emission-genesis — this spec boots a private LiteSVM
// with just the staking program.
//
// Also covers checklist A6 (re-initialisation) and the "front-run the deploy" angle: nobody but the
// current mint authority can bind a given mint, because `init_emission` moves the mint authority
// to the emission PDA in the same transaction.
import { beforeAll, describe, expect, it } from 'vitest';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { MINT_SIZE, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createInitializeMint2Instruction, createMintToInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { decodeEmissionState } from '@/chain/accounts';
import { STAKING_ID } from '@/chain/ids';
import { emissionPda } from '@/chain/pdas';
import { LiteSvmChain } from './helpers/chain';
import { binariesPresent, forgeProgramData, initEmissionIx, programBinaries } from './helpers/env';
import { Err, expectAnyFail, expectFail } from './helpers/expect';

const bins = binariesPresent();
const suite = describe.skipIf(!bins.ok || !!process.env.LOCALNET_RPC);
const MICRO = 1_000_000n;
const HARD_CAP = 1_000_000_000n * MICRO;
const NON_PLAY = HARD_CAP - (HARD_CAP / 100n) * 55n; // 450 M $CG — everything else only comes from tick_day

suite('T-L-SEC-F1 init_emission $CG mint guard', () => {
  let chain: LiteSvmChain;
  let admin: Keypair;

  async function mint(o: { authority: Keypair; freeze?: PublicKey; supply?: bigint }): Promise<PublicKey> {
    const m = Keypair.generate();
    const ixs = [
      SystemProgram.createAccount({ fromPubkey: o.authority.publicKey, newAccountPubkey: m.publicKey, lamports: Number(await chain.rentExempt(MINT_SIZE)), space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
      createInitializeMint2Instruction(m.publicKey, 6, o.authority.publicKey, o.freeze ?? null),
    ];
    if (o.supply) {
      const stash = getAssociatedTokenAddressSync(m.publicKey, o.authority.publicKey);
      ixs.push(
        createAssociatedTokenAccountIdempotentInstruction(o.authority.publicKey, stash, o.authority.publicKey, m.publicKey),
        createMintToInstruction(m.publicKey, stash, o.authority.publicKey, o.supply),
      );
    }
    await chain.send(ixs, { signers: [o.authority, m], label: 'create test mint' });
    return m.publicKey;
  }
  const init = (who: Keypair, cgMint: PublicKey) => chain.send([initEmissionIx({ admin: who.publicKey, cgMint, genesisTs: 0n })], { signers: [who], label: 'init_emission' });

  beforeAll(async () => {
    chain = await LiteSvmChain.create(programBinaries().filter((p) => p.id.equals(STAKING_ID)));
    admin = chain.admin;
    // Находка 13: `init_emission` пускает только upgrade authority программы. LiteSVM не создаёт
    // ProgramData, поэтому подкладываем заголовок с admin в роли authority (см. suite 82).
    await forgeProgramData(chain, STAKING_ID, admin.publicKey);
  });

  it('F1a a mint that still has a freeze authority → BadMint (nothing is created)', async () => {
    const m = await mint({ authority: admin, freeze: admin.publicKey });
    await expectFail(init(admin, m), Err.staking('BadMint'), 'freeze authority set');
    expect(await chain.getAccount(emissionPda()[0])).toBeNull();
  });

  it('F1b a mint pre-minted beyond the 450 M non-play allocation → BadMint (supply + play emission would exceed the 1 B cap)', async () => {
    const m = await mint({ authority: admin, supply: NON_PLAY + 1n });
    await expectFail(init(admin, m), Err.staking('BadMint'), '450 M + 1 micro');
    expect(await chain.getAccount(emissionPda()[0])).toBeNull();
  });

  it('F1c a stranger cannot bind a mint (front-running init_emission is refused at the upgrade-authority gate, находка 13)', async () => {
    const m = await mint({ authority: admin });
    const stranger = Keypair.generate();
    await chain.airdrop(stranger.publicKey, 2_000_000_000n);
    // До находки 13 отказ приходил из SPL Token (set_authority чужого mint), теперь — раньше, из
    // самого `init_emission`: чужой подписант не является upgrade authority программы.
    await expectFail(init(stranger, m), Err.staking('NotUpgradeAuthority'), 'stranger is not the upgrade authority');
    expect(await chain.getAccount(emissionPda()[0])).toBeNull();
    // Легальная инициализация тем же mint проверяется в F1d: singleton общий на весь suite, и
    // «доказать, что admin может» здесь значило бы занять `emission` до F1d.
  });

  it('F1d exactly the non-play allocation is accepted; the mint authority moves to the emission PDA; a second init_emission fails (A6)', async () => {
    const m = await mint({ authority: admin, supply: NON_PLAY });
    await init(admin, m);
    const e = decodeEmissionState((await chain.getAccount(emissionPda()[0]))!.data);
    expect(e.cgMint.equals(m)).toBe(true);
    expect(e.admin.equals(admin.publicKey)).toBe(true);
    // SPL Mint layout: COption<Pubkey> mint_authority at 0..36 → tag 1 + emission PDA
    const raw = (await chain.getAccount(m))!.data;
    expect(raw[0]).toBe(1);
    expect(new PublicKey(raw.subarray(4, 36)).equals(emissionPda()[0])).toBe(true);

    const other = await mint({ authority: admin });
    await expectAnyFail(init(admin, other), 're-init with another mint');
    expect(decodeEmissionState((await chain.getAccount(emissionPda()[0]))!.data).cgMint.equals(m)).toBe(true);
  });
});
