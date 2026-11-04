// T-L-S (SEC-G01 / SEC-G02) — `tick_day` around a scheduled genesis (docs/06 §3.5 "Стейкинг").
//
// The shared environment (helpers/env.ts) initialises the emission singleton with `genesis_ts = now − 10`,
// so a *future* genesis — the `GENESIS_TS` launch-scheduling path of scripts/setup.ts — needs its own
// chain: this spec boots a private LiteSVM with just the staking program and a fresh $CG mint.
//
// Before the fix `((now - genesis_ts) / DAY) as u32` wrapped the negative pre-genesis day count to
// 4 294 967 295, the first (permissionless) tick stored it as `day_index`, and no later tick could ever
// satisfy `today > day_index` again — emission dead until a program upgrade (SEC-G01). The day-0
// exception is additionally pinned to the live pools so it cannot be replayed (SEC-G02).
import { beforeAll, describe, expect, it } from 'vitest';
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { MINT_SIZE, TOKEN_PROGRAM_ID, createInitializeMint2Instruction } from '@solana/spl-token';
import { ixData, rw, signer } from '@/chain/anchor';
import { decodeEmissionState, decodePool } from '@/chain/accounts';
import { STAKING_ID } from '@/chain/ids';
import { chipPoolPda, emissionPda, tokenPoolPda } from '@/chain/pdas';
import { LiteSvmChain } from './helpers/chain';
import { binariesPresent, forgeProgramData, initEmissionIx, programBinaries } from './helpers/env';
import { Err, expectFail } from './helpers/expect';

const bins = binariesPresent();
// LiteSVM only: the RPC back-end cannot boot a second chain and its emission singleton is already live
const suite = describe.skipIf(!bins.ok || !!process.env.LOCALNET_RPC);
const DAY = 86_400n;

const tickDayIx = (cranker: PublicKey) =>
  new TransactionInstruction({ programId: STAKING_ID, keys: [signer(cranker, false), rw(emissionPda()[0]), rw(tokenPoolPda()[0]), rw(chipPoolPda()[0])], data: Buffer.from(ixData('tick_day')) });

suite('T-L-S emission genesis (SEC-G01 / SEC-G02)', () => {
  let chain: LiteSvmChain;
  let admin: Keypair;
  let genesis: bigint;
  const emission = async () => decodeEmissionState((await chain.getAccount(emissionPda()[0]))!.data);
  const pool = async (k: 'token' | 'chip') => decodePool((await chain.getAccount((k === 'token' ? tokenPoolPda : chipPoolPda)()[0]))!.data);
  const tick = (who: Keypair) => chain.send([tickDayIx(who.publicKey)], { signers: [who], label: 'tick_day' });

  beforeAll(async () => {
    chain = await LiteSvmChain.create(programBinaries().filter((p) => p.id.equals(STAKING_ID)));
    admin = chain.admin;
    // Находка 13: `init_emission` принимает только upgrade authority — у LiteSVM нет ProgramData,
    // поэтому подкладываем заголовок с admin в роли authority (как делают suite 82 и helpers/env.ts).
    await forgeProgramData(chain, STAKING_ID, admin.publicKey);
    const mint = Keypair.generate();
    await chain.send([
      SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: mint.publicKey, lamports: Number(await chain.rentExempt(MINT_SIZE)), space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
      createInitializeMint2Instruction(mint.publicKey, 6, admin.publicKey, null),
    ], { signers: [admin, mint], label: 'create $CG mint' });
    genesis = (await chain.now()) + 3n * DAY; // launch scheduled three days out
    await chain.send([initEmissionIx({ admin: admin.publicKey, cgMint: mint.publicKey, genesisTs: genesis })], { signers: [admin], label: 'init_emission (future genesis)' });
  });

  it('G01 tick_day before genesis → BeforeGenesis (anyone may crank; nothing is recorded)', async () => {
    const e0 = await emission();
    expect(e0.genesisTs).toBe(genesis);
    expect(e0.dayIndex).toBe(0);
    const stranger = Keypair.generate();
    await chain.airdrop(stranger.publicKey, 1_000_000_000n);
    await expectFail(tick(stranger), Err.staking('BeforeGenesis'), 'stranger, 3 days early');
    await chain.warpSeconds(3n * DAY - 30n);
    await expectFail(tick(admin), Err.staking('BeforeGenesis'), 'admin, 30 s early');
    const e1 = await emission();
    expect(e1.dayIndex).toBe(0);
    expect(e1.sliceBudget.every((b) => b === 0n)).toBe(true);
    expect((await pool('chip')).budgetPerSec).toBe(0n);
  });

  it('G01/G02 first tick at genesis opens day 0 exactly once; the calendar keeps counting from genesis afterwards', async () => {
    await chain.warpSeconds(60n); // now = genesis + 30 s
    await tick(admin);
    const e1 = await emission();
    expect(e1.dayIndex).toBe(0);
    const cp = await pool('chip'); const tp = await pool('token');
    expect(cp.budgetPerSec).toBeGreaterThan(0n);
    expect(tp.budgetRemaining).toBeGreaterThan(0n);
    // SEC-G02: the day-0 exception is spent — a replay is refused even though nothing has been minted yet
    await expectFail(tick(admin), Err.staking('DayAlreadyClosed'), 'replay of day 0');
    expect((await pool('chip')).budgetRemaining).toBe(cp.budgetRemaining);
    // the pre-genesis attempts left no trace: day 1 arrives one DAY after genesis, not after the first tick
    await chain.warpSeconds(DAY - 60n); // now = genesis + DAY − 30 s
    await expectFail(tick(admin), Err.staking('DayAlreadyClosed'), 'still day 0');
    await chain.warpSeconds(60n); // now = genesis + DAY + 30 s
    await tick(admin);
    expect((await emission()).dayIndex).toBe(1);
    await expectFail(tick(admin), Err.staking('DayAlreadyClosed'), 'second tick of day 1');
  });
});
