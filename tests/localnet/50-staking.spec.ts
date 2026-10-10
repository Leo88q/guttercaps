// T-L-S — staking / emission / Merkle roots / SKR prize pool (docs/06 §3.5 "Стейкинг").
import { beforeAll, describe, expect, it } from 'vitest';
import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction } from '@solana/spl-token';
import { ixData, ro, rw, signer } from '@/chain/anchor';
import { BorshWriter } from '@/chain/borsh';
import {
  decodeCompressedChipStake, decodeCompressedMintClaim, decodeEmissionState, decodePlayerItems, decodePool, decodeRewardRoot, decodeSetBonus, decodeSkrPool, decodeTokenStake,
} from '@/chain/accounts';
import { CHIP_CORE_ID, STAKING_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@/chain/ids';
import { MarketCurrency, listCompressedIx } from '@/chain/ix/market';
import { claimChipRootIx, claimItemRootIx, claimRootIx, claimSkrRootIx, fundSkrIx, fundSliceIx, stakeCgIx, stakeCompressedChipIx, unstakeCgIx, unstakeCompressedChipIx } from '@/chain/ix/staking';
import { closeRandomnessIx, initRandomnessIx, rngAccounts } from '@/chain/ix/rng';
import { buildRewardTree } from '@/chain/merkle';
import { RNG_KIND, ata, chipPoolPda, compressedChipStakePda, compressedMintClaimPda, claimReceiptPda, configPda, emissionPda, pendingPackPda, playerItemsPda, rewardRootPda, rewarderPda, seasonPoolAuthPda, setBonusPda, skrPoolPda, tokenPoolPda, tokenStakePda } from '@/chain/pdas';
import { EMISSION_SPLIT, QUEST_CHIP_TEMPLATES, RARITY_PROFILES, STARTER_SOULBOUND_DAYS } from '@guttercaps/economy';
import { QUEST_ORACLE, SB_ORACLE, SB_QUEUE, SEASON_ORACLE, SET_ORACLE, TREASURY, binariesPresent, getEnv, mintCg, tokenBalance, type Env } from './helpers/env';
import { Err, expectAnyFail, expectFail, lamportsClose } from './helpers/expect';
import { buyPack, cancelStale, loadPending, mintCompressedChips, revealAndOpenCompressedAll, valueOf, Currency, SKU } from './helpers/flows';
import { randomnessAccount } from './helpers/sbmock';

const bins = binariesPresent();
const suite = describe.skipIf(!bins.ok && !process.env.LOCALNET_RPC);
const CG = 1_000_000n;
const DAY = 86_400n;
const ACC = 1_000_000_000_000n;
/**
 * Byte offset of `minted` inside `CompressedMintClaim`, discriminator included. Field order is the
 * decoder's (`@/chain/accounts`) and the struct's (`programs/chip_core/src/state.rs`): disc ‖ buyer ‖
 * collection_idx ‖ rarity ‖ level ‖ game_index ‖ expires_at ‖ settlement ‖ index_reserved ‖ **minted**
 * ‖ registered ‖ consumed ‖ listed ‖ bump ‖ staked ‖ origin ‖ lock_until. `helpers/v2leaf.ts` pins the
 * same region from the writing side, where the claimant's `listed` byte is `8+32+1+1+1+8+8+32+1+1+1+1`.
 */
const CLAIM_MINTED_OFFSET = 8 + 32 + 1 + 1 + 1 + 8 + 8 + 32 + 1;

// ---- admin / oracle builders (no client counterparts: backend-only paths; account order = programs/staking) ----
const emissionAdmin = (name: string, admin: PublicKey, args: Uint8Array) =>
  new TransactionInstruction({ programId: STAKING_ID, keys: [signer(admin, false), rw(emissionPda()[0])], data: Buffer.from(ixData(name, args)) });
const tickDayIx = (cranker: PublicKey) =>
  new TransactionInstruction({ programId: STAKING_ID, keys: [signer(cranker, false), rw(emissionPda()[0]), rw(tokenPoolPda()[0]), rw(chipPoolPda()[0])], data: Buffer.from(ixData('tick_day')) });
const reportBurnIx = (reporter: PublicKey, amount: bigint) =>
  new TransactionInstruction({ programId: STAKING_ID, keys: [signer(reporter, false), rw(emissionPda()[0])], data: Buffer.from(ixData('report_burn', new BorshWriter().u64(amount).toBytes())) });
/** set_oracles(OraclePatch { quest?, season?, set?, burn? }) — SEC-M1 added `burn_oracle` as the 4th Option */
const setOraclesIx = (admin: PublicKey, p: { quest?: PublicKey; season?: PublicKey; set?: PublicKey; burn?: PublicKey }) => {
  const w = new BorshWriter();
  for (const k of [p.quest, p.season, p.set, p.burn]) w.option(k, (v) => w.pubkey(v));
  return emissionAdmin('set_oracles', admin, w.toBytes());
};
const publishRootIx = (oracle: PublicKey, kind: number, epoch: number, root: Uint8Array, budget: bigint) =>
  new TransactionInstruction({ programId: STAKING_ID, keys: [signer(oracle), rw(emissionPda()[0]), rw(rewardRootPda(kind, epoch)[0]), ro(SYSTEM_PROGRAM_ID)], data: Buffer.from(ixData('publish_root', new BorshWriter().u8(kind).u32(epoch).bytes(root).u64(budget).toBytes())) });
const revokeRootIx = (admin: PublicKey, kind: number, epoch: number) =>
  new TransactionInstruction({ programId: STAKING_ID, keys: [signer(admin, false), rw(emissionPda()[0]), rw(rewardRootPda(kind, epoch)[0])], data: Buffer.from(ixData('revoke_root')) });
const syncSetBonusIx = (oracle: PublicKey, payer: PublicKey, owner: PublicKey, sets: number) =>
  new TransactionInstruction({ programId: STAKING_ID, keys: [signer(oracle, false), signer(payer), ro(emissionPda()[0]), ro(owner), rw(setBonusPda(owner)[0]), ro(SYSTEM_PROGRAM_ID)], data: Buffer.from(ixData('sync_set_bonus', new BorshWriter().u8(sets).toBytes())) });
const publishSkrRootIx = (oracle: PublicKey, kind: number, epoch: number, root: Uint8Array, budget: bigint) =>
  new TransactionInstruction({ programId: STAKING_ID, keys: [signer(oracle), ro(emissionPda()[0]), rw(skrPoolPda()[0]), rw(rewardRootPda(kind, epoch)[0]), ro(SYSTEM_PROGRAM_ID)], data: Buffer.from(ixData('publish_skr_root', new BorshWriter().u8(kind).u32(epoch).bytes(root).u64(budget).toBytes())) });
const revokeSkrRootIx = (admin: PublicKey, kind: number, epoch: number) =>
  new TransactionInstruction({ programId: STAKING_ID, keys: [signer(admin, false), ro(emissionPda()[0]), rw(skrPoolPda()[0]), rw(rewardRootPda(kind, epoch)[0])], data: Buffer.from(ixData('revoke_skr_root')) });
const withdrawSkrIx = (admin: PublicKey, skrMint: PublicKey, to: PublicKey, amount: bigint) =>
  new TransactionInstruction({ programId: STAKING_ID, keys: [signer(admin, false), ro(emissionPda()[0]), rw(skrPoolPda()[0]), rw(ata(skrMint, skrPoolPda()[0])), rw(to), ro(TOKEN_PROGRAM_ID)], data: Buffer.from(ixData('withdraw_skr', new BorshWriter().u64(amount).toBytes())) });
const syncSkrPoolIx = (skrMint: PublicKey) =>
  new TransactionInstruction({ programId: STAKING_ID, keys: [rw(skrPoolPda()[0]), ro(ata(skrMint, skrPoolPda()[0]))], data: Buffer.from(ixData('sync_skr_pool')) });
const publishItemRootIx = (oracle: PublicKey, kind: number, epoch: number, root: Uint8Array, budget: bigint) =>
  new TransactionInstruction({ programId: STAKING_ID, keys: [signer(oracle), ro(emissionPda()[0]), rw(rewardRootPda(kind, epoch)[0]), ro(SYSTEM_PROGRAM_ID)], data: Buffer.from(ixData('publish_item_root', new BorshWriter().u8(kind).u32(epoch).bytes(root).u64(budget).toBytes())) });
const revokeItemRootIx = (admin: PublicKey, kind: number, epoch: number) =>
  new TransactionInstruction({ programId: STAKING_ID, keys: [signer(admin, false), ro(emissionPda()[0]), rw(rewardRootPda(kind, epoch)[0])], data: Buffer.from(ixData('revoke_item_root')) });
const publishChipRootIx = (oracle: PublicKey, kind: number, epoch: number, root: Uint8Array, budget: bigint) =>
  new TransactionInstruction({ programId: STAKING_ID, keys: [signer(oracle), ro(emissionPda()[0]), rw(rewardRootPda(kind, epoch)[0]), ro(SYSTEM_PROGRAM_ID)], data: Buffer.from(ixData('publish_chip_root', new BorshWriter().u8(kind).u32(epoch).bytes(root).u64(budget).toBytes())) });
const revokeChipRootIx = (admin: PublicKey, kind: number, epoch: number) =>
  new TransactionInstruction({ programId: STAKING_ID, keys: [signer(admin, false), ro(emissionPda()[0]), rw(rewardRootPda(kind, epoch)[0])], data: Buffer.from(ixData('revoke_chip_root')) });
const setSkrPoolIx = (admin: PublicKey, maxRootBudget: bigint | null, paused: boolean | null) => {
  const w = new BorshWriter(); w.option(maxRootBudget, (v) => w.u64(v)); w.option(paused, (v) => w.bool(v));
  return new TransactionInstruction({ programId: STAKING_ID, keys: [signer(admin, false), ro(emissionPda()[0]), rw(skrPoolPda()[0])], data: Buffer.from(ixData('set_skr_pool', w.toBytes())) });
};

/** claim_item_root with an arbitrary kind — claimItemRootIx guards the kind client-side (correctly), but the
 *  "wrong root currency" negative has to reach the chain to prove the on-chain check fires (S23). */
const claimItemRootRawIx = (wallet: PublicKey, kind: number, epoch: number, amount: bigint, proof: Uint8Array[]) => {
  const [root] = rewardRootPda(kind, epoch);
  const w = new BorshWriter().u64(amount);
  w.vec(proof, (p) => w.bytes(p));
  return new TransactionInstruction({
    programId: STAKING_ID,
    keys: [
      signer(wallet), ro(emissionPda()[0]), rw(root), rw(claimReceiptPda(root, wallet)[0]),
      ro(rewarderPda()[0]), ro(configPda()[0]), rw(playerItemsPda(wallet)[0]), ro(CHIP_CORE_ID), ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('claim_item_root', w.toBytes())),
  });
};

let epochCounter = 100;
const nextEpoch = () => ++epochCounter;

suite('T-L-S staking', () => {
  let env: Env;
  let staker: Keypair;
  const emission = async () => decodeEmissionState((await env.chain.getAccount(emissionPda()[0]))!.data);
  const pool = async (k: 'token' | 'chip') => decodePool((await env.chain.getAccount((k === 'token' ? tokenPoolPda : chipPoolPda)()[0]))!.data);
  const skrPool = async () => decodeSkrPool((await env.chain.getAccount(skrPoolPda()[0]))!.data);
  const skrInvariant = async () => { const p = await skrPool(); expect(await tokenBalance(env.chain, env.mints.skr, skrPoolPda()[0])).toBeGreaterThanOrEqual(p.budget + p.reserved); return p; };

  beforeAll(async () => {
    env = await getEnv();
    staker = await env.player({ usdc: 100_000_000_000n, cg: 1_000_000n * CG, skr: 1_000_000n * CG });
  });

  it('S01 init_emission state + tick_day: slices = guarded budget × split, second tick the same day → DayAlreadyClosed', async () => {
    const e0 = await emission();
    expect(e0.admin.equals(env.admin.publicKey)).toBe(true);
    expect(e0.cgMint.equals(env.mints.cg)).toBe(true);
    expect(e0.splitBps).toEqual([EMISSION_SPLIT.chipStaking, EMISSION_SPLIT.tokenStaking, EMISSION_SPLIT.quests, EMISSION_SPLIT.pvpSeason, EMISSION_SPLIT.eventsReserve].map((p) => p * 100));
    expect(e0.questOracle.equals(QUEST_ORACLE.publicKey)).toBe(true);
    // day 0 tick (allowed once while nothing was minted)
    await env.chain.send([tickDayIx(env.admin.publicKey)], { signers: [env.admin] });
    const e1 = await emission();
    const cp = await pool('chip'); const tp = await pool('token');
    // year 0: play bucket 550 M × 18 % / 365 = 271 232.876… $CG/day; guard with 0 burn → 10 % floor
    const dailyCap = (550_000_000n * CG * 18n) / 100n / 365n;
    const guarded = (dailyCap * 1000n) / 10_000n;
    expect(cp.budgetRemaining).toBe((guarded * BigInt(e0.splitBps[0])) / 10_000n);
    expect(tp.budgetRemaining).toBe((guarded * BigInt(e0.splitBps[1])) / 10_000n);
    expect(cp.budgetPerSec).toBe(cp.budgetRemaining / DAY);
    expect(e1.sliceBudget[2]).toBe(e0.sliceBudget[2] + (guarded * BigInt(e0.splitBps[2])) / 10_000n);
    await expectFail(env.chain.send([tickDayIx(env.admin.publicKey)], { signers: [env.admin] }), Err.staking('DayAlreadyClosed'));
  });

  it('S02 stake_cg flex → claim after 1 day = budget_per_sec × 86 400 × share (sole staker gets the whole slice); unstake returns principal', async () => {
    if (!env.chain.canWarp) return;
    const amount = 1_000n * CG;
    const before = await tokenBalance(env.chain, env.mints.cg, staker.publicKey);
    await env.chain.send([stakeCgIx({ owner: staker.publicKey, tier: 0, amount, cgMint: env.mints.cg })], { signers: [staker] });
    expect(before - (await tokenBalance(env.chain, env.mints.cg, staker.publicKey))).toBe(amount);
    const st = decodeTokenStake((await env.chain.getAccount(tokenStakePda(staker.publicKey, 0)[0]))!.data);
    expect(st.amount).toBe(amount);
    expect(st.weight).toBe(amount); // flex boost 1.0
    const tp0 = await pool('token');
    await env.chain.warpSeconds(DAY);
    const b0 = await tokenBalance(env.chain, env.mints.cg, staker.publicKey);
    await env.chain.send([unstakeCgIx({ owner: staker.publicKey, tier: 0, amount: 0n, cgMint: env.mints.cg })], { signers: [staker] }); // claim only
    const claimed = (await tokenBalance(env.chain, env.mints.cg, staker.publicKey)) - b0;
    const expected = tp0.budgetPerSec * DAY > tp0.budgetRemaining ? tp0.budgetRemaining : tp0.budgetPerSec * DAY;
    // sole staker: reward = min(rate × dt, remaining); precision loss ≤ 1 micro
    expect(claimed >= expected - 1n && claimed <= expected).toBe(true);
    expect((await emission()).mintedTotal).toBeGreaterThanOrEqual(claimed);
    const b1 = await tokenBalance(env.chain, env.mints.cg, staker.publicKey);
    await env.chain.send([unstakeCgIx({ owner: staker.publicKey, tier: 0, amount, cgMint: env.mints.cg })], { signers: [staker] });
    expect((await tokenBalance(env.chain, env.mints.cg, staker.publicKey)) - b1).toBe(amount); // no penalty on flex
    // below minimum / bad tier
    await expectFail(env.chain.send([stakeCgIx({ owner: staker.publicKey, tier: 0, amount: 9n * CG, cgMint: env.mints.cg })], { signers: [staker] }), Err.staking('BelowMinimum'));
    await expectFail(env.chain.send([stakeCgIx({ owner: staker.publicKey, tier: 4, amount: 100n * CG, cgMint: env.mints.cg })], { signers: [staker] }), Err.staking('InvalidTier'));
  });

  it('S03 90-day tier: weight × 2.2, early exit burns 10 % of principal (record_internal_burn → burn_today), after unlock no penalty', async () => {
    const amount = 1_000n * CG;
    await env.chain.send([stakeCgIx({ owner: staker.publicKey, tier: 2, amount, cgMint: env.mints.cg })], { signers: [staker] });
    const st = decodeTokenStake((await env.chain.getAccount(tokenStakePda(staker.publicKey, 2)[0]))!.data);
    expect(st.weight).toBe((amount * 22_000n) / 10_000n);
    expect(st.unlockAt - (await env.chain.now())).toBeGreaterThanOrEqual(90n * DAY - 60n);
    const burn0 = (await emission()).burnToday;
    const b0 = await tokenBalance(env.chain, env.mints.cg, staker.publicKey);
    await env.chain.send([unstakeCgIx({ owner: staker.publicKey, tier: 2, amount: 500n * CG, cgMint: env.mints.cg })], { signers: [staker] });
    const got = (await tokenBalance(env.chain, env.mints.cg, staker.publicKey)) - b0;
    expect(got).toBeGreaterThanOrEqual(450n * CG); // 500 − 10 % penalty (+ any pending reward)
    expect(got).toBeLessThan(451n * CG + 10n * CG);
    expect((await emission()).burnToday - burn0).toBe(50n * CG);
    if (!env.chain.canWarp) return;
    await env.chain.warpSeconds(90n * DAY + 1n);
    const b1 = await tokenBalance(env.chain, env.mints.cg, staker.publicKey);
    await env.chain.send([unstakeCgIx({ owner: staker.publicKey, tier: 2, amount: 500n * CG, cgMint: env.mints.cg })], { signers: [staker] });
    expect((await tokenBalance(env.chain, env.mints.cg, staker.publicKey)) - b1).toBeGreaterThanOrEqual(500n * CG);
  });

  it('S03b SEC-F3 dust early exits cannot dodge the burn: penalty is rounded UP (19 micro @ 5 % → 1 burned, not 0)', async () => {
    const dust = await env.player({ cg: 100n * CG });
    await env.chain.send([stakeCgIx({ owner: dust.publicKey, tier: 1, amount: 10n * CG, cgMint: env.mints.cg })], { signers: [dust] });
    const stakeKey = tokenStakePda(dust.publicKey, 1)[0];
    let principal = decodeTokenStake((await env.chain.getAccount(stakeKey))!.data).amount;
    // 19 × 500 / 10 000 = 0.95 — the old floor burned 0; three different dust sizes, each burns exactly ⌈x·bps⌉
    for (const [chunk, burned] of [[19n, 1n], [1n, 1n], [201n, 11n]] as const) {
      const burn0 = (await emission()).burnToday;
      const b0 = await tokenBalance(env.chain, env.mints.cg, dust.publicKey);
      await env.chain.send([unstakeCgIx({ owner: dust.publicKey, tier: 1, amount: chunk, cgMint: env.mints.cg })], { signers: [dust] });
      expect((await emission()).burnToday - burn0, `chunk ${chunk}`).toBe(burned);
      const got = (await tokenBalance(env.chain, env.mints.cg, dust.publicKey)) - b0;
      expect(got, `chunk ${chunk}`).toBeGreaterThanOrEqual(chunk - burned); // (+ pending reward, if any accrued)
      expect(got).toBeLessThan(chunk - burned + 1n * CG);
      const after = decodeTokenStake((await env.chain.getAccount(stakeKey))!.data).amount;
      expect(principal - after).toBe(chunk);
      principal = after;
    }
  });

  it('S04 set_split: Δ > 10 pp or < 7 days since last change → SplitGuard; sum ≠ 10 000 → SplitSum; non-admin → has_one', async () => {
    const split = (v: number[]) => { const w = new BorshWriter(); for (const x of v) w.u16(x); return w.toBytes(); };
    await expectFail(env.chain.send([emissionAdmin('set_split', env.admin.publicKey, split([2000, 1000, 2200, 3300, 1501]))], { signers: [env.admin] }), Err.staking('SplitSum'));
    await expectFail(env.chain.send([emissionAdmin('set_split', env.admin.publicKey, split([3001, 1000, 1199, 3300, 1500]))], { signers: [env.admin] }), Err.staking('SplitGuard'), 'Δ 1 001');
    // within Δ but too soon after init (split_changed_at = init time)
    const e = await emission();
    if ((await env.chain.now()) - e.splitChangedAt < 7n * DAY) await expectFail(env.chain.send([emissionAdmin('set_split', env.admin.publicKey, split([2100, 900, 2200, 3300, 1500]))], { signers: [env.admin] }), Err.staking('SplitGuard'), 'too soon');
    if (env.chain.canWarp) {
      await env.chain.warpSeconds(7n * DAY + 1n);
      await env.chain.send([emissionAdmin('set_split', env.admin.publicKey, split([2100, 900, 2200, 3300, 1500]))], { signers: [env.admin] });
      expect((await emission()).splitBps).toEqual([2100, 900, 2200, 3300, 1500]);
      await env.chain.warpSeconds(7n * DAY + 1n);
      await env.chain.send([emissionAdmin('set_split', env.admin.publicKey, split([2000, 1000, 2200, 3300, 1500]))], { signers: [env.admin] });
    }
    const stranger = await env.player();
    await expectFail(env.chain.send([emissionAdmin('set_split', stranger.publicKey, split([2000, 1000, 2200, 3300, 1500]))], { signers: [stranger] }), Err.staking('Unauthorized'));
  });

  it('S05 report_burn: a wallet → NotBurnReporter; SEC-M1 burn oracle (set_oracles) may report, clamped at 3 × daily cap; admin clears it; tick_day rolls burn_today into the ring and the guard grows', async () => {
    const dailyCap = (550_000_000n * CG * 18n) / 100n / 365n;
    await expectFail(env.chain.send([reportBurnIx(env.admin.publicKey, 1n)], { signers: [env.admin] }), Err.staking('NotBurnReporter'), 'admin is not a reporter');
    const burnOracle = await env.player();
    await expectFail(env.chain.send([reportBurnIx(burnOracle.publicKey, 1n)], { signers: [burnOracle] }), Err.staking('NotBurnReporter'), 'before designation');
    // only the admin may designate; other oracles untouched by a burn-only patch
    await expectFail(env.chain.send([setOraclesIx(burnOracle.publicKey, { burn: burnOracle.publicKey })], { signers: [burnOracle] }), Err.staking('Unauthorized'), 'stranger set_oracles');
    const before = await emission();
    await env.chain.send([setOraclesIx(env.admin.publicKey, { burn: burnOracle.publicKey })], { signers: [env.admin] });
    const e0 = await emission();
    expect(e0.burnOracle.equals(burnOracle.publicKey)).toBe(true);
    expect(e0.questOracle.equals(before.questOracle) && e0.seasonOracle.equals(before.seasonOracle) && e0.setOracle.equals(before.setOracle)).toBe(true);
    // the oracle reports; burn_today grows by exactly the amount…
    await env.chain.send([reportBurnIx(burnOracle.publicKey, 7n * CG)], { signers: [burnOracle] });
    expect((await emission()).burnToday).toBe(e0.burnToday + 7n * CG);
    // …and is clamped at BURN_SANITY_MULT × daily cap — a lying oracle cannot push the guard past the schedule
    await env.chain.send([reportBurnIx(burnOracle.publicKey, 10n * dailyCap)], { signers: [burnOracle] });
    expect((await emission()).burnToday).toBe(3n * dailyCap);
    // Pubkey::default() clears the role
    await env.chain.send([setOraclesIx(env.admin.publicKey, { burn: PublicKey.default })], { signers: [env.admin] });
    await expectFail(env.chain.send([reportBurnIx(burnOracle.publicKey, 1n)], { signers: [burnOracle] }), Err.staking('NotBurnReporter'), 'cleared oracle');
    // program PDAs cannot sign from a test — the CPI path is covered by the unstake penalty (record_internal_burn) and the guard math below
    if (!env.chain.canWarp) return;
    const e1 = await emission();
    expect(e1.burnToday).toBeGreaterThan(0n);
    await env.chain.warpSeconds(DAY);
    await env.chain.send([tickDayIx(env.admin.publicKey)], { signers: [env.admin] });
    const e2 = await emission();
    expect(e2.burnToday).toBe(0n);
    expect(e2.burnRing.reduce((s, x) => s + x, 0n)).toBeGreaterThanOrEqual(e1.burnToday);
    const avg = e2.burnRing.reduce((s, x) => s + x, 0n) / 7n;
    const guarded = (dailyCap * 1000n) / 10_000n + (avg * 12_500n) / 10_000n;
    const cp = await pool('chip');
    // 3 × cap in one ring slot → 7-day average 0.43 × cap → guard = 0.10 + 1.25 × 0.43 ≈ 0.64 × cap (below the ceiling): the guard really moved off the floor
    expect(guarded).toBeGreaterThan((dailyCap * 1000n) / 10_000n);
    expect(cp.budgetRemaining).toBe(((guarded < dailyCap ? guarded : dailyCap) * BigInt(e2.splitBps[0])) / 10_000n);
  });

  it('S06 stake_compressed_chip: authenticated CPI sets claim.staked; unstake clears; staked claims cannot be listed', async () => {
    const chips = await mintCompressedChips(env, staker, 1, valueOf('S06'));
    const c = chips[0];
    // SEC-A1 (2026-10-02, M-5): an admin-staged claim carries no purchase, so it has no soulbound
    // window — this is the unlocked half of the lock check S06b adds. Without this assertion the
    // `ChipNotFree` guard in S06b would be equally satisfied by a check that always refuses.
    expect(decodeCompressedMintClaim((await env.chain.getAccount(c.claim))!.data).lockUntil).toBe(0n);
    await env.chain.send([stakeCompressedChipIx({ owner: staker.publicKey, claim: c.claim })], { signers: [staker] });
    let claim = decodeCompressedMintClaim((await env.chain.getAccount(c.claim))!.data);
    expect(claim.staked).toBe(true);
    const cs = decodeCompressedChipStake((await env.chain.getAccount(compressedChipStakePda(c.claim)[0]))!.data);
    expect(cs.weight).toBe(BigInt(RARITY_PROFILES[c.rarity].stakeWeight) * CG);
    expect((await pool('chip')).totalWeight).toBeGreaterThanOrEqual(cs.weight);
    await expectFail(env.chain.send([listCompressedIx({ seller: staker.publicKey, claim: c.claim, price: 1_000_000_000n, currency: MarketCurrency.SOL })], { signers: [staker] }), Err.market('CompressedClaimNotTradable'), 'list a staked claim');
    await expectFail(env.chain.send([stakeCompressedChipIx({ owner: staker.publicKey, claim: c.claim })], { signers: [staker] }), Err.system(0), 'stake twice (init on live PDA)');
    await env.chain.send([unstakeCompressedChipIx({ owner: staker.publicKey, claim: c.claim, cgMint: env.mints.cg })], { signers: [staker] });
    claim = decodeCompressedMintClaim((await env.chain.getAccount(c.claim))!.data);
    expect(claim.staked).toBe(false);
    expect(await env.chain.getAccount(compressedChipStakePda(c.claim)[0])).toBeNull();
    const other = await env.player({ usdc: 10_000_000_000n });
    const theirs = await mintCompressedChips(env, other, 1, valueOf('S06b'));
    await expectFail(env.chain.send([stakeCompressedChipIx({ owner: staker.publicKey, claim: theirs[0].claim })], { signers: [staker] }), Err.staking('NotOwner'));
  });

  // SEC-A1 (2026-10-02, M-5): `stake_compressed_chip` read `chip.flags & F_SOULBOUND == 0 || now >= chip.lock_until`
  // as documentation and never enforced it. A Starter is soulbound for 7 days (`soulbound_days` in
  // packages/economy), and the claim PDA carries the same window, so staking one before it expires
  // both bypasses the non-transferable rule (the stake PDA is what makes a chip spendable) and
  // locks the claim into the emission pools for a chip the design says must stay put. `stake_compressed_chip_v2`
  // got the same guard (its proof path is what 90-compressed covers).
  it('S06b SEC-A1 (M-5): a soulbound Starter cannot be staked before its lock expires', async () => {
    const buyer = await env.player({ usdc: 1_000_000_000n });
    const b = await buyPack(env, buyer, { sku: SKU.STARTER, currency: Currency.USDC });
    const [r] = await revealAndOpenCompressedAll(env, buyer, b);
    const claim = compressedMintClaimPda(buyer.publicKey, r.event.claimNonces[0])[0];
    const opened = decodeCompressedMintClaim((await env.chain.getAccount(claim))!.data);
    expect(opened.lockUntil).toBeGreaterThan(0n);
    await expectFail(env.chain.send([stakeCompressedChipIx({ owner: buyer.publicKey, claim })], { signers: [buyer] }), Err.staking('ChipNotFree'), 'stake a soulbound Starter');
    // The claim PDA itself is untouched: the refusal is at the gate, not a half-written stake.
    expect(decodeCompressedMintClaim((await env.chain.getAccount(claim))!.data).staked).toBe(false);
    if (!env.chain.canWarp) return;
    await env.chain.warpSeconds(BigInt(STARTER_SOULBOUND_DAYS) * DAY + 1n);
    // SEC-F04 meets SEC-A1. A Starter's claim deadline and its soulbound window are both `open + 7 d`
    // (`open_compressed_pack` writes `expires_at = now + 7 d` and `lock_until` from the Starter's
    // `soulbound_days`), so one second past the lock the claim is *also* past its DAS deadline — and
    // an unminted claim past that deadline can never be minted, which is what makes staking it a
    // weight backed by nothing. The first version of this test asserted the stake succeeds at that
    // instant and was red from the day it landed: an unminted Starter can never legally be staked.
    await expectFail(env.chain.send([stakeCompressedChipIx({ owner: buyer.publicKey, claim })], { signers: [buyer] }), Err.staking('ClaimExpired'), 'stake an unminted Starter past its deadline');
    // What SEC-A1 must let through is the *settled* claim — the one the DAS flipped after the
    // Bubblegum CPI (`minted`, `mpl-bubblegum` being a program this harness does not load: see the
    // header of helpers/v2leaf.ts). The state is written the same way that helper writes a claim,
    // and the offset is asserted by decoding the result rather than trusted.
    const settled = Uint8Array.from((await env.chain.getAccount(claim))!.data);
    settled[CLAIM_MINTED_OFFSET] = 1;
    await env.chain.setAccount(claim, { owner: CHIP_CORE_ID, data: settled });
    expect(decodeCompressedMintClaim(settled).minted).toBe(true);
    await env.chain.send([stakeCompressedChipIx({ owner: buyer.publicKey, claim })], { signers: [buyer] });
    expect(decodeCompressedMintClaim((await env.chain.getAccount(claim))!.data).staked).toBe(true);
    await env.chain.send([unstakeCompressedChipIx({ owner: buyer.publicKey, claim, cgMint: env.mints.cg })], { signers: [buyer] });
  }, 600_000);

  it('S07 sync_set_bonus: set oracle only; compressed stake weight includes the ×1.12 set bonus; 11 → TooManySets', async () => {
    const chips = await mintCompressedChips(env, staker, 1, valueOf('S07'));
    const c = chips[0];
    await expectFail(env.chain.send([syncSetBonusIx(env.admin.publicKey, env.admin.publicKey, staker.publicKey, 1)], { signers: [env.admin] }), Err.staking('BadOracle'), 'admin is not the set oracle');
    await expectFail(env.chain.send([syncSetBonusIx(SET_ORACLE.publicKey, env.admin.publicKey, staker.publicKey, 11)], { signers: [SET_ORACLE, env.admin] }), Err.staking('TooManySets'));
    await env.chain.send([syncSetBonusIx(SET_ORACLE.publicKey, env.admin.publicKey, staker.publicKey, 1)], { signers: [SET_ORACLE, env.admin] });
    expect(decodeSetBonus((await env.chain.getAccount(setBonusPda(staker.publicKey)[0]))!.data).completedSets).toBe(1);
    await env.chain.send([stakeCompressedChipIx({ owner: staker.publicKey, claim: c.claim })], { signers: [staker] });
    const cs = decodeCompressedChipStake((await env.chain.getAccount(compressedChipStakePda(c.claim)[0]))!.data);
    expect(cs.weight).toBe((BigInt(RARITY_PROFILES[c.rarity].stakeWeight) * CG * 11_200n) / 10_000n);
    await env.chain.send([syncSetBonusIx(SET_ORACLE.publicKey, env.admin.publicKey, staker.publicKey, 0)], { signers: [SET_ORACLE, env.admin] });
    await env.chain.send([unstakeCompressedChipIx({ owner: staker.publicKey, claim: c.claim, cgMint: env.mints.cg })], { signers: [staker] });
  });

  it('S08 paused emission: stake_cg → Paused, unstake still works', async () => {
    await env.chain.send([stakeCgIx({ owner: staker.publicKey, tier: 0, amount: 100n * CG, cgMint: env.mints.cg })], { signers: [staker] });
    await env.chain.send([emissionAdmin('set_paused', env.admin.publicKey, new BorshWriter().bool(true).toBytes())], { signers: [env.admin] });
    await expectFail(env.chain.send([stakeCgIx({ owner: staker.publicKey, tier: 0, amount: 100n * CG, cgMint: env.mints.cg })], { signers: [staker] }), Err.staking('Paused'));
    await env.chain.send([unstakeCgIx({ owner: staker.publicKey, tier: 0, amount: 100n * CG, cgMint: env.mints.cg })], { signers: [staker] });
    await env.chain.send([emissionAdmin('set_paused', env.admin.publicKey, new BorshWriter().bool(false).toBytes())], { signers: [env.admin] });
  });

  it('S10–S13 $CG Merkle roots: publish (oracle + slice budget), timelock, claim mints + receipt, replay refused, foreign proof, revoke returns the remainder, proof depth ≤ 24', async () => {
    const wallets = [staker, await env.player({ cg: CG }), await env.player({ cg: CG })];
    const amounts = [10n * CG, 20n * CG, 30n * CG];
    const epoch = nextEpoch();
    const kind = 2; // quests
    const { root, proofs } = buildRewardTree(wallets.map((w, i) => ({ wallet: w.publicKey, amountMicro: amounts[i], kind, epoch })));
    const e0 = await emission();
    const budget = 60n * CG;
    expect(e0.sliceBudget[kind]).toBeGreaterThanOrEqual(budget);
    await expectFail(env.chain.send([publishRootIx(SEASON_ORACLE.publicKey, kind, epoch, root, budget)], { signers: [SEASON_ORACLE] }), Err.staking('BadOracle'), 'season oracle on quests kind');
    await expectFail(env.chain.send([publishRootIx(QUEST_ORACLE.publicKey, kind, epoch, root, e0.sliceBudget[kind] + 1n)], { signers: [QUEST_ORACLE] }), Err.staking('BudgetExceeded'));
    await env.chain.send([publishRootIx(QUEST_ORACLE.publicKey, kind, epoch, root, budget)], { signers: [QUEST_ORACLE] });
    expect((await emission()).sliceBudget[kind]).toBe(e0.sliceBudget[kind] - budget);
    const rr = decodeRewardRoot((await env.chain.getAccount(rewardRootPda(kind, epoch)[0]))!.data);
    expect(Array.from(rr.root)).toEqual(Array.from(root));
    const claim = (i: number, amount = amounts[i], proof = proofs[i]) => env.chain.send([claimRootIx({ wallet: wallets[i].publicKey, kind, epoch, amount, proof, cgMint: env.mints.cg })], { signers: [wallets[i]] });
    await expectFail(claim(0), Err.staking('RootTimelocked'));
    if (!env.chain.canWarp) return;
    await env.chain.warpSeconds(3601n);
    const b0 = await tokenBalance(env.chain, env.mints.cg, wallets[0].publicKey);
    await claim(0);
    expect((await tokenBalance(env.chain, env.mints.cg, wallets[0].publicKey)) - b0).toBe(amounts[0]);
    expect(await env.chain.getAccount(claimReceiptPda(rewardRootPda(kind, epoch)[0], wallets[0].publicKey)[0])).not.toBeNull();
    await expectAnyFail(claim(0), 'claim twice (receipt init)');
    await expectFail(claim(1, 21n * CG), Err.staking('BadProof'), 'wrong amount');
    await expectFail(claim(1, amounts[1], proofs[2]), Err.staking('BadProof'), 'foreign proof');
    await expectFail(claim(1, amounts[1], Array.from({ length: 25 }, () => new Uint8Array(32))), Err.staking('BadProof'), '25-deep proof');
    // SKR kinds are rejected by the $CG claim path
    await expectFail(env.chain.send([publishRootIx(QUEST_ORACLE.publicKey, 5, epoch, root, budget)], { signers: [QUEST_ORACLE] }), Err.staking('BadOracle'), 'kind 5 via publish_root');
    // revoke → remainder back to the slice, further claims → RootRevoked
    const e1 = await emission();
    await expectFail(env.chain.send([revokeRootIx(QUEST_ORACLE.publicKey, kind, epoch)], { signers: [QUEST_ORACLE] }), Err.staking('Unauthorized'), 'oracle revokes');
    await env.chain.send([revokeRootIx(env.admin.publicKey, kind, epoch)], { signers: [env.admin] });
    expect((await emission()).sliceBudget[kind]).toBe(e1.sliceBudget[kind] + budget - amounts[0]);
    await expectFail(claim(1), Err.staking('RootRevoked'));
    await expectFail(env.chain.send([revokeRootIx(env.admin.publicKey, kind, epoch)], { signers: [env.admin] }), Err.staking('RootRevoked'), 'revoke twice');
  });

  it('S14 SKR pool: init state (max_root_budget = 100 000 SKR default), fund_skr moves SKR → budget, SkrFunded; zero → ZeroAmount', async () => {
    const p0 = await skrInvariant();
    expect(p0.skrMint.equals(env.mints.skr)).toBe(true);
    expect(p0.vault.equals(ata(env.mints.skr, skrPoolPda()[0]))).toBe(true);
    expect(p0.maxRootBudget).toBe(100_000n * CG);
    expect(p0.paused).toBe(false);
    await env.chain.send([fundSkrIx({ funder: staker.publicKey, amount: 1_000n * CG, skrMint: env.mints.skr })], { signers: [staker] });
    const p1 = await skrInvariant();
    expect(p1.budget).toBe(p0.budget + 1_000n * CG);
    expect(p1.fundedTotal).toBe(p0.fundedTotal + 1_000n * CG);
    await expectFail(env.chain.send([fundSkrIx({ funder: staker.publicKey, amount: 0n, skrMint: env.mints.skr })], { signers: [staker] }), Err.staking('ZeroAmount'));
  });

  it('S15–S17 SKR roots: publish_skr_root(kind 5) by the quest oracle reserves budget; wrong oracle / kind / over budget rejected; claim transfers from the vault; revoke returns the remainder', async () => {
    const wallets = [staker, await env.player({ skr: CG })];
    const amounts = [100n * CG, 200n * CG];
    const epoch = nextEpoch();
    const { root, proofs } = buildRewardTree(wallets.map((w, i) => ({ wallet: w.publicKey, amountMicro: amounts[i], kind: 5, epoch })));
    const p0 = await skrInvariant();
    await expectFail(env.chain.send([publishSkrRootIx(SEASON_ORACLE.publicKey, 5, epoch, root, 300n * CG)], { signers: [SEASON_ORACLE] }), Err.staking('BadOracle'), 'season oracle on kind 5');
    await expectFail(env.chain.send([publishSkrRootIx(QUEST_ORACLE.publicKey, 6, epoch, root, 300n * CG)], { signers: [QUEST_ORACLE] }), Err.staking('BadOracle'), 'quest oracle on kind 6');
    await expectFail(env.chain.send([publishSkrRootIx(QUEST_ORACLE.publicKey, 2, epoch, root, 300n * CG)], { signers: [QUEST_ORACLE] }), Err.staking('WrongRootCurrency'), '$CG kind via SKR path');
    await expectFail(env.chain.send([publishSkrRootIx(QUEST_ORACLE.publicKey, 5, epoch, root, p0.budget + 1n)], { signers: [QUEST_ORACLE] }), Err.staking('SkrBudgetExceeded'), 'over budget');
    await env.chain.send([setSkrPoolIx(env.admin.publicKey, 250n * CG, null)], { signers: [env.admin] });
    await expectFail(env.chain.send([publishSkrRootIx(QUEST_ORACLE.publicKey, 5, epoch, root, 300n * CG)], { signers: [QUEST_ORACLE] }), Err.staking('SkrBudgetExceeded'), 'over per-root cap');
    await env.chain.send([setSkrPoolIx(env.admin.publicKey, 100_000n * CG, null)], { signers: [env.admin] });
    await env.chain.send([publishSkrRootIx(QUEST_ORACLE.publicKey, 5, epoch, root, 300n * CG)], { signers: [QUEST_ORACLE] });
    const p1 = await skrInvariant();
    expect(p1.budget).toBe(p0.budget - 300n * CG);
    expect(p1.reserved).toBe(p0.reserved + 300n * CG);
    const claim = (i: number) => env.chain.send([claimSkrRootIx({ wallet: wallets[i].publicKey, kind: 5, epoch, amount: amounts[i], proof: proofs[i], skrMint: env.mints.skr })], { signers: [wallets[i]] });
    await expectFail(claim(0), Err.staking('RootTimelocked'));
    // the same leaf through the $CG path → WrongRootCurrency
    await expectFail(env.chain.send([claimRootIx({ wallet: wallets[0].publicKey, kind: 2, epoch, amount: amounts[0], proof: proofs[0], cgMint: env.mints.cg })], { signers: [wallets[0]] }), Err.anchor('AccountNotInitialized'), 'kind 2 root of this epoch does not exist');
    if (!env.chain.canWarp) return;
    await env.chain.warpSeconds(3601n);
    const s0 = await tokenBalance(env.chain, env.mints.skr, wallets[0].publicKey);
    await claim(0);
    expect((await tokenBalance(env.chain, env.mints.skr, wallets[0].publicKey)) - s0).toBe(amounts[0]);
    const p2 = await skrInvariant();
    expect(p2.reserved).toBe(p1.reserved - amounts[0]);
    expect(p2.paidTotal).toBe(p1.paidTotal + amounts[0]);
    await expectAnyFail(claim(0), 'claim twice');
    // revoke_root (the $CG admin path) on an SKR kind → WrongRootCurrency; revoke_skr_root returns the remainder
    await expectFail(env.chain.send([revokeRootIx(env.admin.publicKey, 5, epoch)], { signers: [env.admin] }), Err.staking('WrongRootCurrency'));
    await env.chain.send([revokeSkrRootIx(env.admin.publicKey, 5, epoch)], { signers: [env.admin] });
    const p3 = await skrInvariant();
    expect(p3.reserved).toBe(p2.reserved - amounts[1]);
    expect(p3.budget).toBe(p2.budget + amounts[1]);
    await expectFail(claim(1), Err.staking('RootRevoked'));
  });

  it('S22 item roots (#27): publish_item_root(kind 8) by the quest oracle only, caps 1 000 / 10, claim_item_root CPIs grant_booster via ["rewarder"] → PlayerItems, receipt blocks replay, revoke blocks claims', async () => {
    const wallets = [staker, await env.player(), await env.player()];
    const amounts = [2n, 10n, 11n]; // boosters; the 11 leaf must be refused at claim (chip_core count ≤ 10)
    const epoch = nextEpoch();
    const { root, proofs } = buildRewardTree(wallets.map((w, i) => ({ wallet: w.publicKey, amountMicro: amounts[i], kind: 8, epoch })));
    await expectFail(env.chain.send([publishItemRootIx(SEASON_ORACLE.publicKey, 8, epoch, root, 23n)], { signers: [SEASON_ORACLE] }), Err.staking('BadOracle'), 'season oracle on kind 8');
    await expectFail(env.chain.send([publishItemRootIx(QUEST_ORACLE.publicKey, 2, epoch, root, 23n)], { signers: [QUEST_ORACLE] }), Err.staking('WrongRootCurrency'), '$CG kind via item path');
    await expectFail(env.chain.send([publishItemRootIx(QUEST_ORACLE.publicKey, 8, epoch, root, 1_001n)], { signers: [QUEST_ORACLE] }), Err.staking('ItemBudgetExceeded'), 'over per-root cap');
    await expectFail(env.chain.send([publishItemRootIx(QUEST_ORACLE.publicKey, 8, epoch, root, 0n)], { signers: [QUEST_ORACLE] }), Err.staking('ZeroAmount'));
    await expectFail(env.chain.send([publishRootIx(QUEST_ORACLE.publicKey, 8, epoch, root, 23n)], { signers: [QUEST_ORACLE] }), Err.staking('BadOracle'), 'kind 8 via publish_root');
    const e0 = await emission();
    await env.chain.send([publishItemRootIx(QUEST_ORACLE.publicKey, 8, epoch, root, 23n)], { signers: [QUEST_ORACLE] });
    expect((await emission()).sliceBudget).toEqual(e0.sliceBudget); // nothing reserved from any slice
    const rr = decodeRewardRoot((await env.chain.getAccount(rewardRootPda(8, epoch)[0]))!.data);
    expect(rr.kind).toBe(8); expect(rr.budget).toBe(23n);
    const claim = (i: number, amount = amounts[i], proof = proofs[i]) => env.chain.send([claimItemRootIx({ wallet: wallets[i].publicKey, kind: 8, epoch, amount, proof })], { signers: [wallets[i]] });
    await expectFail(claim(0), Err.staking('RootTimelocked'));
    if (!env.chain.canWarp) return;
    await env.chain.warpSeconds(3601n);
    const boosters = async (w: Keypair) => { const a = await env.chain.getAccount(playerItemsPda(w.publicKey)[0]); return a ? decodePlayerItems(a.data).boosters : 0; };
    const b0 = await boosters(wallets[0]);
    await claim(0);
    expect((await boosters(wallets[0])) - b0).toBe(2);          // PlayerItems credited by the CPI (created on first claim if needed)
    expect(await env.chain.getAccount(claimReceiptPda(rewardRootPda(8, epoch)[0], wallets[0].publicKey)[0])).not.toBeNull();
    await expectAnyFail(claim(0), 'claim twice (receipt init)');
    await expectFail(claim(1, 9n), Err.staking('BadProof'), 'wrong amount');
    await claim(1);
    expect(await boosters(wallets[1])).toBe(10);
    expect(decodeRewardRoot((await env.chain.getAccount(rewardRootPda(8, epoch)[0]))!.data).claimed).toBe(12n);
    // the 11-booster leaf is refused client-side and on-chain (per-claim cap = chip_core grant_booster cap)
    expect(() => claimItemRootIx({ wallet: wallets[2].publicKey, kind: 8, epoch, amount: 11n, proof: proofs[2] })).toThrow(/1\.\.10/);
    // a $CG / SKR claim on the item root → WrongRootCurrency
    await expectFail(env.chain.send([claimRootIx({ wallet: wallets[1].publicKey, kind: 2, epoch, amount: amounts[1], proof: proofs[1], cgMint: env.mints.cg })], { signers: [wallets[1]] }), Err.anchor('AccountNotInitialized'), 'kind 2 root of this epoch does not exist');
    // revoke: $CG admin path refuses the kind; revoke_item_root blocks further claims (nothing to refund)
    await expectFail(env.chain.send([revokeRootIx(env.admin.publicKey, 8, epoch)], { signers: [env.admin] }), Err.staking('WrongRootCurrency'));
    await expectFail(env.chain.send([revokeItemRootIx(QUEST_ORACLE.publicKey, 8, epoch)], { signers: [QUEST_ORACLE] }), Err.staking('Unauthorized'), 'oracle revokes');
    await env.chain.send([revokeItemRootIx(env.admin.publicKey, 8, epoch)], { signers: [env.admin] });
    await expectFail(claim(2, 10n, proofs[2]), Err.staking('RootRevoked'));
    await expectFail(env.chain.send([revokeItemRootIx(env.admin.publicKey, 8, epoch)], { signers: [env.admin] }), Err.staking('RootRevoked'), 'revoke twice');
  });

  it('S23 chip voucher roots (#28): publish_chip_root(kind 9) quest oracle only, budget = leaf count ≤ 500; claim_chip_root(amount = template) CPIs open_voucher → free 1-chip PendingPack committed to Switchboard; the chip opens with the template odds, soulbound; receipt / revoke / bad template refused', async () => {
    const wallets = [staker, await env.player(), await env.player()];
    const templates = [0n, 1n, 4n]; // template 4 does not exist — its leaf must be refused at claim (MAX_CHIP_TEMPLATE = 3)
    const epoch = nextEpoch();
    const { root, proofs } = buildRewardTree(wallets.map((w, i) => ({ wallet: w.publicKey, amountMicro: templates[i], kind: 9, epoch })));
    await expectFail(env.chain.send([publishChipRootIx(SEASON_ORACLE.publicKey, 9, epoch, root, 3n)], { signers: [SEASON_ORACLE] }), Err.staking('BadOracle'), 'season oracle on kind 9');
    await expectFail(env.chain.send([publishChipRootIx(QUEST_ORACLE.publicKey, 8, epoch, root, 3n)], { signers: [QUEST_ORACLE] }), Err.staking('WrongRootCurrency'), 'item kind via chip path');
    await expectFail(env.chain.send([publishChipRootIx(QUEST_ORACLE.publicKey, 9, epoch, root, 501n)], { signers: [QUEST_ORACLE] }), Err.staking('ChipBudgetExceeded'), 'over per-root cap');
    await expectFail(env.chain.send([publishChipRootIx(QUEST_ORACLE.publicKey, 9, epoch, root, 0n)], { signers: [QUEST_ORACLE] }), Err.staking('ZeroAmount'));
    await expectFail(env.chain.send([publishItemRootIx(QUEST_ORACLE.publicKey, 9, epoch, root, 3n)], { signers: [QUEST_ORACLE] }), Err.staking('WrongRootCurrency'), 'kind 9 via publish_item_root');
    const e0 = await emission();
    await env.chain.send([publishChipRootIx(QUEST_ORACLE.publicKey, 9, epoch, root, 2n)], { signers: [QUEST_ORACLE] }); // budget 2 = the two valid vouchers
    expect((await emission()).sliceBudget).toEqual(e0.sliceBudget); // nothing reserved from any slice
    const rr = decodeRewardRoot((await env.chain.getAccount(rewardRootPda(9, epoch)[0]))!.data);
    expect(rr.kind).toBe(9); expect(rr.budget).toBe(2n);
    // one tx per voucher: init_randomness(0, nonce) + claim_chip_root(template, proof, nonce) — exactly the buy_pack shape
    const claimVoucher = async (i: number, nonce: bigint, amount = templates[i], proof = proofs[i]) => {
      const rng = rngAccounts(RNG_KIND.PACK, wallets[i].publicKey, nonce);
      return env.chain.send([
        initRandomnessIx({ ...rng, queue: SB_QUEUE, recentSlot: (await env.chain.slot()) - 1n }),
        claimChipRootIx({ wallet: wallets[i].publicKey, kind: 9, epoch, amount, proof, nonce, queue: SB_QUEUE, oracle: SB_ORACLE }),
      ], { signers: [wallets[i]], label: 'claim_chip_root' });
    };
    await expectFail(claimVoucher(0, 9_001n), Err.staking('RootTimelocked'));
    if (!env.chain.canWarp) return;
    await env.chain.warpSeconds(3601n);
    const balBefore = await env.chain.balance(wallets[0].publicKey);
    await claimVoucher(0, 9_002n);
    // the CPI created a free 1-chip PendingPack pinned to template 0 (paid 0, sku 0, qty 1, no pity snapshot use)
    const pendingKey = pendingPackPda(wallets[0].publicKey, 9_002n)[0];
    const p = (await loadPending(env.chain, pendingKey))!;
    expect(p).toMatchObject({ sku: 0, qty: 1, opened: 0, paidLamports: 0n, paidUsdc: 0n, paidCg: 0n, paidSkr: 0n, voucher: true, soulboundDays: QUEST_CHIP_TEMPLATES[0].soulboundDays });
    expect(p.voucherOdds).toEqual([...QUEST_CHIP_TEMPLATES[0].odds]);
    expect(p.randomness.equals(rngAccounts(RNG_KIND.PACK, wallets[0].publicKey, 9_002n).randomness)).toBe(true);
    expect(balBefore - (await env.chain.balance(wallets[0].publicKey))).toBeGreaterThan(0n); // wallet fronts the rents (pending + randomness + receipt + 1 chip reserve)
    expect(await env.chain.getAccount(claimReceiptPda(rewardRootPda(9, epoch)[0], wallets[0].publicKey)[0])).not.toBeNull();
    expect(decodeRewardRoot((await env.chain.getAccount(rewardRootPda(9, epoch)[0]))!.data).claimed).toBe(1n); // counts vouchers, not templates
    await expectAnyFail(claimVoucher(0, 9_003n), 'claim twice (receipt init)');
    // the crank / player opens it through the Bubblegum V2 claim path: ONE chip, rolled with the template odds.
    const [open] = await revealAndOpenCompressedAll(env, wallets[0], { nonce: 9_002n, randomness: p.randomness }, valueOf('pack'));
    expect(open.event.count).toBe(1);
    expect(open.event.claimNonces).toHaveLength(1);
    expect(QUEST_CHIP_TEMPLATES[0].odds[open.rolled[0].rarity]).toBeGreaterThan(0); // only rarities the template can roll
    const compressedClaim = decodeCompressedMintClaim((await env.chain.getAccount(compressedMintClaimPda(wallets[0].publicKey, open.event.claimNonces[0])[0]))!.data);
    expect(compressedClaim.buyer.equals(wallets[0].publicKey)).toBe(true);
    expect(compressedClaim.minted).toBe(false);
    expect(await env.chain.getAccount(pendingKey)).not.toBeNull(); // compressed settlement remains until DAS registration/cancellation
    // bad template: the leaf says 4 → refused client-side (0..3) and on-chain (ChipBudgetExceeded before the proof check)
    expect(() => claimChipRootIx({ wallet: wallets[2].publicKey, kind: 9, epoch, amount: 4n, proof: proofs[2], nonce: 9_004n, queue: SB_QUEUE, oracle: SB_ORACLE })).toThrow(/0\.\.3/);
    await expectFail(claimVoucher(1, 9_005n, 2n), Err.staking('BadProof'), 'wrong template for the proof');
    // an item / $CG claim on the chip root → WrongRootCurrency (the kind-9 root exists, so it is the currency check that fires)
    await expectFail(env.chain.send([claimItemRootRawIx(wallets[1].publicKey, 9, epoch, 1n, proofs[1])], { signers: [wallets[1]] }), Err.staking('WrongRootCurrency'));
    // revoke: item path refuses the kind; revoke_chip_root blocks the remaining claim
    await expectFail(env.chain.send([revokeItemRootIx(env.admin.publicKey, 9, epoch)], { signers: [env.admin] }), Err.staking('WrongRootCurrency'));
    await expectFail(env.chain.send([revokeChipRootIx(QUEST_ORACLE.publicKey, 9, epoch)], { signers: [QUEST_ORACLE] }), Err.staking('Unauthorized'), 'oracle revokes');
    await env.chain.send([revokeChipRootIx(env.admin.publicKey, 9, epoch)], { signers: [env.admin] });
    await expectFail(claimVoucher(1, 9_006n), Err.staking('RootRevoked'));
    await expectFail(env.chain.send([revokeChipRootIx(env.admin.publicKey, 9, epoch)], { signers: [env.admin] }), Err.staking('RootRevoked'), 'revoke twice');
  });

  it('S24 SEC-F18 voucher whose oracle never reveals: cancel_stale_pack refuses before the stale window (NotStale, not the old voucher constraint), then closes the PendingPack and returns the fronted rent + 1-chip reserve to the beneficiary; close_randomness reclaims the Switchboard rent afterwards', async () => {
    if (!env.chain.canWarp || process.env.LOCALNET_RPC) return; // needs slot warps + the sb_mock layout (lut_slot)
    const wallet = await env.player();
    const epoch = nextEpoch();
    const { root, proofs } = buildRewardTree([{ wallet: wallet.publicKey, amountMicro: 1n, kind: 9, epoch }]);
    await env.chain.send([publishChipRootIx(QUEST_ORACLE.publicKey, 9, epoch, root, 1n)], { signers: [QUEST_ORACLE] });
    await env.chain.warpSeconds(3601n); // ROOT_TIMELOCK
    const nonce = 9_101n;
    const rng = rngAccounts(RNG_KIND.PACK, wallet.publicKey, nonce);
    await env.chain.send([
      initRandomnessIx({ ...rng, queue: SB_QUEUE, recentSlot: (await env.chain.slot()) - 1n }),
      claimChipRootIx({ wallet: wallet.publicKey, kind: 9, epoch, amount: 1n, proof: proofs[0], nonce, queue: SB_QUEUE, oracle: SB_ORACLE }),
    ], { signers: [wallet], label: 'claim_chip_root' });
    const pendingKey = pendingPackPda(wallet.publicKey, nonce)[0];
    const p = (await loadPending(env.chain, pendingKey))!;
    expect(p.voucher).toBe(true);
    expect(p.paidLamports + p.paidUsdc + p.paidCg + p.paidSkr).toBe(0n);
    const led0 = await env.ledger();
    // inside the oracle window the refusal is the stale check itself — before the fix `constraint = !pending.voucher`
    // answered InvalidChipState here and after the window alike, and the reserve was gone for good
    await expectFail(cancelStale(env, wallet, { nonce, randomness: p.randomness }), Err.chip('NotStale'));
    await env.chain.warpSlots(10_800n + 1n); // STALE_PACK_SLOTS
    const escrowed = await env.chain.balance(pendingKey); // pending rent + RENT_RESERVE_PER_CHIP, both fronted by the beneficiary
    expect(escrowed).toBeGreaterThan(8_000_000n);
    const before = await env.chain.balance(wallet.publicKey);
    await cancelStale(env, wallet, { nonce, randomness: p.randomness });
    expect(lamportsClose((await env.chain.balance(wallet.publicKey)) - before, escrowed, 20_000n)).toBe(true); // − tx fee
    expect(await loadPending(env.chain, pendingKey)).toBeNull();
    // nothing was purchased, so nothing is released: the liability shards are exactly where they were
    const led = await env.ledger();
    expect([led.liabLamports, led.liabUsdc, led.liabCg, led.liabSkr]).toEqual([led0.liabLamports, led0.liabUsdc, led0.liabCg, led0.liabSkr]);
    // with the pending gone the Switchboard account is unpinned: close_randomness (permissionless) sends its rent to the beneficiary
    const lut = (await randomnessAccount(env.chain, p.randomness))!.lutSlot;
    const ownerBefore = await env.chain.balance(wallet.publicKey);
    await env.chain.send([closeRandomnessIx({ ...rng, payer: env.admin.publicKey, lutSlot: lut })], { signers: [env.admin] });
    expect(await env.chain.getAccount(p.randomness)).toBeNull();
    expect((await env.chain.balance(wallet.publicKey)) - ownerBefore).toBe(await env.chain.rentExempt(88));
  });

  it('S18–S20 withdraw_skr only from unreserved budget; sync_skr_pool absorbs direct transfers; pause blocks publish/claim but not fund', async () => {
    const p0 = await skrInvariant();
    const adminAta = ata(env.mints.skr, env.admin.publicKey);
    await env.chain.send([createAssociatedTokenAccountIdempotentInstruction(env.admin.publicKey, adminAta, env.admin.publicKey, env.mints.skr)], { signers: [env.admin] });
    const perCall = p0.budget / 10n > 0n ? p0.budget / 10n : 1n;
    await expectFail(env.chain.send([withdrawSkrIx(env.admin.publicKey, env.mints.skr, adminAta, p0.budget + 1n)], { signers: [env.admin] }), Err.staking('SkrBudgetExceeded'));
    await expectFail(env.chain.send([withdrawSkrIx(env.admin.publicKey, env.mints.skr, adminAta, perCall + 1n)], { signers: [env.admin] }), Err.staking('SkrBudgetExceeded'), 'over 10% per-call / daily cap');
    await expectFail(env.chain.send([withdrawSkrIx(env.admin.publicKey, env.mints.skr, adminAta, p0.budget)], { signers: [env.admin] }), Err.staking('SkrBudgetExceeded'), 'full unreserved budget in one call');
    await expectFail(env.chain.send([withdrawSkrIx(env.admin.publicKey, env.mints.skr, ata(env.mints.skr, TREASURY.publicKey), perCall)], { signers: [env.admin] }), Err.anchor('ConstraintTokenOwner'), 'destination must be the admin ATA');
    await expectFail(
      env.chain.send([
        withdrawSkrIx(env.admin.publicKey, env.mints.skr, adminAta, perCall),
        withdrawSkrIx(env.admin.publicKey, env.mints.skr, adminAta, 1n),
      ], { signers: [env.admin] }),
      Err.staking('SkrWithdrawRate'),
      'two withdrawals share a slot',
    );
    const t0 = await tokenBalance(env.chain, env.mints.skr, env.admin.publicKey);
    await env.chain.send([withdrawSkrIx(env.admin.publicKey, env.mints.skr, adminAta, perCall)], { signers: [env.admin] });
    expect((await tokenBalance(env.chain, env.mints.skr, env.admin.publicKey)) - t0).toBe(perCall);
    const p1 = await skrInvariant();
    expect(p1.budget).toBe(p0.budget - perCall);
    await expectFail(env.chain.send([withdrawSkrIx(env.admin.publicKey, env.mints.skr, adminAta, 1n)], { signers: [env.admin] }), Err.staking('SkrBudgetExceeded'), 'daily 10% already consumed');
    // direct SPL transfer + permissionless sync
    await env.chain.send([createTransferInstruction(ata(env.mints.skr, staker.publicKey), ata(env.mints.skr, skrPoolPda()[0]), staker.publicKey, 77n * CG)], { signers: [staker] });
    await env.chain.send([syncSkrPoolIx(env.mints.skr)], { signers: [env.admin] });
    const p2 = await skrInvariant();
    expect(p2.budget).toBe(p1.budget + 77n * CG);
    expect(p2.fundedTotal).toBe(p1.fundedTotal + 77n * CG);
    // pause
    await env.chain.send([setSkrPoolIx(env.admin.publicKey, null, true)], { signers: [env.admin] });
    const epoch = nextEpoch();
    const { root } = buildRewardTree([{ wallet: staker.publicKey, amountMicro: CG, kind: 5, epoch }]);
    await expectFail(env.chain.send([publishSkrRootIx(QUEST_ORACLE.publicKey, 5, epoch, root, CG)], { signers: [QUEST_ORACLE] }), Err.staking('SkrPoolPaused'));
    await env.chain.send([fundSkrIx({ funder: staker.publicKey, amount: CG, skrMint: env.mints.skr })], { signers: [staker] });
    await env.chain.send([setSkrPoolIx(env.admin.publicKey, null, false)], { signers: [env.admin] });
    const stranger = await env.player();
    await expectFail(env.chain.send([setSkrPoolIx(stranger.publicKey, null, true)], { signers: [stranger] }), Err.staking('Unauthorized'));
    await skrInvariant();
    expect(ACC).toBe(1_000_000_000_000n);
  });

  it('S21 SEC-L5 fund_slice: season oracle / admin burn the season pool into slice_budget[3] (recycled_total, SliceFunded); wrong kind / zero / over balance / stranger / quest oracle rejected; a kind-3 claim of the recycled amount leaves minted_total untouched', async () => {
    // the arena's season pool = $CG ATA of staking's ["season_pool"] PDA; seed it like resolve_battle would (rake_pool transfer)
    const poolAuth = seasonPoolAuthPda()[0];
    await mintCg(env.chain, env.admin, env.mints.cg, poolAuth, 10n * CG);
    const e0 = await emission();
    const supply0 = await tokenBalance(env.chain, env.mints.cg, poolAuth);
    expect(supply0).toBeGreaterThanOrEqual(10n * CG);
    const fund = (authority: Keypair, amount: bigint, kind?: number) => env.chain.send([fundSliceIx({ authority: authority.publicKey, amount, cgMint: env.mints.cg, kind })], { signers: [authority] });
    await expectFail(fund(SEASON_ORACLE, CG, 2), Err.staking('WrongSlice'), 'quests slice has no token source');
    await expectFail(fund(SEASON_ORACLE, 0n), Err.staking('ZeroAmount'));
    await expectFail(fund(SEASON_ORACLE, supply0 + 1n), Err.staking('InsufficientPool'));
    await expectFail(fund(QUEST_ORACLE, CG), Err.staking('Unauthorized'), 'quest oracle');
    await expectFail(fund(staker, CG), Err.staking('Unauthorized'), 'stranger');
    // season oracle recycles 4 $CG: pool −4, slice[3] +4, recycled_total +4, burn ring untouched (not demand)
    await fund(SEASON_ORACLE, 4n * CG);
    const e1 = await emission();
    expect((await tokenBalance(env.chain, env.mints.cg, poolAuth))).toBe(supply0 - 4n * CG);
    expect(e1.sliceBudget[3]).toBe(e0.sliceBudget[3] + 4n * CG);
    expect(e1.recycledTotal).toBe(e0.recycledTotal + 4n * CG);
    expect(e1.burnToday).toBe(e0.burnToday);
    expect(e1.mintedTotal).toBe(e0.mintedTotal);
    // admin may fund too
    await fund(env.admin, CG);
    expect((await emission()).recycledTotal).toBe(e0.recycledTotal + 5n * CG);
    // paused → blocked (like publish_root), unpause restores
    await env.chain.send([emissionAdmin('set_paused', env.admin.publicKey, new BorshWriter().bool(true).toBytes())], { signers: [env.admin] });
    await expectFail(fund(SEASON_ORACLE, CG), Err.staking('Paused'));
    await env.chain.send([emissionAdmin('set_paused', env.admin.publicKey, new BorshWriter().bool(false).toBytes())], { signers: [env.admin] });
    // a kind-3 root paid from the recycled budget: claim mints 3 $CG but minted_total (schedule) does not move, recycled_minted does
    const epoch = nextEpoch();
    const { root, proofs } = buildRewardTree([{ wallet: staker.publicKey, amountMicro: 3n * CG, kind: 3, epoch }]);
    await env.chain.send([publishRootIx(SEASON_ORACLE.publicKey, 3, epoch, root, 3n * CG)], { signers: [SEASON_ORACLE] });
    if (!env.chain.canWarp) return;
    await env.chain.warpSeconds(3601n);
    const e2 = await emission();
    const b0 = await tokenBalance(env.chain, env.mints.cg, staker.publicKey);
    await env.chain.send([claimRootIx({ wallet: staker.publicKey, kind: 3, epoch, amount: 3n * CG, proof: proofs[0], cgMint: env.mints.cg })], { signers: [staker] });
    const e3 = await emission();
    expect((await tokenBalance(env.chain, env.mints.cg, staker.publicKey)) - b0).toBe(3n * CG);
    expect(e3.mintedTotal).toBe(e2.mintedTotal);
    expect(e3.recycledMinted).toBe(e2.recycledMinted + 3n * CG);
    expect(e3.recycledMinted).toBeLessThanOrEqual(e3.recycledTotal);
  });
});
