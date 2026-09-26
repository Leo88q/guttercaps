// Program-owned Switchboard randomness (SEC-C3 part 2): init / reveal / close
// wrappers of chip_core (kinds 0 pack, 1 fusion, 3 claim fusion) and arena (kind 2 battle).
// The *commit* has no client instruction any more — buy_pack / fuse / fuse_claims_commit /
// create_battle CPI `randomness_commit` themselves with the `rng_auth` PDA
// signature. Account order MUST match programs/chip_core/src/instructions/rng.rs
// and the InitBattleRandomness / RevealBattleRandomness / CloseBattleRandomness
// structs in programs/arena/src/lib.rs.
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { BorshWriter } from '../borsh';
import { ixData, ro, rw, signer } from '../anchor';
import {
  ADDRESS_LOOKUP_TABLE_PROGRAM_ID, ARENA_ID, ASSOCIATED_TOKEN_PROGRAM_ID, CHIP_CORE_ID, SWITCHBOARD_ON_DEMAND_ID, SYSTEM_PROGRAM_ID,
  SYSVAR_SLOT_HASHES_ID, TOKEN_PROGRAM_ID, WSOL_MINT,
} from '../ids';
import {
  RNG_KIND, battlePda, claimFusionPda, pendingFusionPda, pendingPackPda, rngAuthPda, rngPda, sbLutPda, sbLutSignerPda, sbOracleStatsPda, sbRewardEscrow, sbStatePda,
  type RngKind,
} from '../pdas';

const programOf = (kind: RngKind) => (kind === RNG_KIND.BATTLE ? ARENA_ID : CHIP_CORE_ID);

/** Everything a flow needs to know about one randomness account. */
export interface RngAccounts {
  kind: RngKind;
  owner: PublicKey;
  nonce: bigint;
  randomness: PublicKey;
  rngAuth: PublicKey;
}
export function rngAccounts(kind: RngKind, owner: PublicKey, nonce: bigint): RngAccounts {
  return { kind, owner, nonce, randomness: rngPda(kind, owner, nonce)[0], rngAuth: rngAuthPda(kind)[0] };
}

/**
 * `init_randomness(kind, nonce, recent_slot)` (chip_core) / `init_battle_randomness(nonce, recent_slot)` (arena).
 * `recentSlot` must be a *finalized* slot (the LUT address is derived from it and Switchboard
 * checks it against SlotHashes) — `connection.getSlot('finalized')`.
 */
export function initRandomnessIx(a: RngAccounts & { queue: PublicKey; recentSlot: bigint }): TransactionInstruction {
  const lutSigner = sbLutSignerPda(a.randomness)[0];
  const keys = [
    signer(a.owner),
    rw(a.randomness),
    ro(a.rngAuth),
    rw(sbRewardEscrow(a.randomness)),
    rw(a.queue),
    ro(sbStatePda()[0]),
    ro(lutSigner),
    rw(sbLutPda(lutSigner, a.recentSlot)[0]),
    ro(SWITCHBOARD_ON_DEMAND_ID),
    ro(WSOL_MINT),
    ro(ADDRESS_LOOKUP_TABLE_PROGRAM_ID),
    ro(TOKEN_PROGRAM_ID),
    ro(ASSOCIATED_TOKEN_PROGRAM_ID),
    ro(SYSTEM_PROGRAM_ID),
  ];
  const data = a.kind === RNG_KIND.BATTLE
    ? ixData('init_battle_randomness', new BorshWriter().u64(a.nonce).u64(a.recentSlot).toBytes())
    : ixData('init_randomness', new BorshWriter().u8(a.kind).u64(a.nonce).u64(a.recentSlot).toBytes());
  return new TransactionInstruction({ programId: programOf(a.kind), keys, data: Buffer.from(data) });
}

/** Extra accounts `buy_pack` / `fuse` / `create_battle` take for the commit CPI (in program order). */
export function commitAccountMetas(a: { kind: RngKind; queue: PublicKey; oracle: PublicKey }) {
  return [ro(rngAuthPda(a.kind)[0]), ro(SWITCHBOARD_ON_DEMAND_ID), ro(a.queue), rw(a.oracle), ro(SYSVAR_SLOT_HASHES_ID)];
}

export interface RevealArgs {
  kind: RngKind;
  payer: PublicKey;
  randomness: PublicKey;
  /** `RandomnessAccountData.oracle` / `.queue` of the committed account */
  oracle: PublicKey;
  queue: PublicKey;
  /** oracle gateway response */
  signature: Uint8Array; // 64
  recoveryId: number;
  value: Uint8Array; // 32
}

/** `reveal_randomness(signature, recovery_id, value)` (chip_core) / `reveal_battle_randomness` (arena) — permissionless. */
export function revealRandomnessIx(a: RevealArgs): TransactionInstruction {
  if (a.signature.length !== 64) throw new Error('oracle signature must be 64 bytes');
  if (a.value.length !== 32) throw new Error('revealed value must be 32 bytes');
  const keys = [
    signer(a.payer),
    rw(a.randomness),
    ro(rngAuthPda(a.kind)[0]),
    ro(a.oracle),
    ro(a.queue),
    rw(sbOracleStatsPda(a.oracle)[0]),
    rw(sbRewardEscrow(a.randomness)),
    ro(sbStatePda()[0]),
    ro(SYSVAR_SLOT_HASHES_ID),
    ro(SWITCHBOARD_ON_DEMAND_ID),
    ro(WSOL_MINT),
    ro(TOKEN_PROGRAM_ID),
    ro(SYSTEM_PROGRAM_ID),
  ];
  const name = a.kind === RNG_KIND.BATTLE ? 'reveal_battle_randomness' : 'reveal_randomness';
  const data = ixData(name, new BorshWriter().bytes(a.signature).u8(a.recoveryId).bytes(a.value).toBytes());
  return new TransactionInstruction({ programId: programOf(a.kind), keys, data: Buffer.from(data) });
}

/**
 * `close_randomness(kind, nonce)` / `close_battle_randomness(nonce)` — permissionless once the
 * pending pack / fusion is closed (battle resolved or cancelled). Rent → `owner` (SEC-M7).
 * `lutSlot` = `RandomnessAccountData.lut_slot` (readRandomness).
 */
/**
 * `close_randomness_lut(kind, nonce, lut_slot)` / `close_battle_randomness_lut(nonce, lut_slot)` —
 * the SECOND half of a request's Switchboard rent (backlog #23): the lookup table (~0.0015 SOL) that
 * `randomness_init` paid for. Callable once the randomness account is gone (Switchboard deactivates
 * the table as it closes the account) and the ALT cooldown (~1 epoch) has passed; permissionless and
 * idempotent, and the rent always goes to `owner`, never to the relayer.
 *
 * `lutSlot` = `RandomnessAccountData.lut_slot` — read it *before* calling `closeRandomnessIx`: the
 * account that holds it is deleted by that call. The program re-derives the table address from the
 * slot and requires the passed accounts to match, so a wrong slot fails closed instead of paying
 * somebody else.
 */
export function closeRandomnessLutIx(a: RngAccounts & { payer: PublicKey; lutSlot: bigint }): TransactionInstruction {
  const lutSigner = sbLutSignerPda(a.randomness)[0];
  const pinned = a.kind === RNG_KIND.PACK ? pendingPackPda(a.owner, a.nonce)[0]
    : a.kind === RNG_KIND.FUSION ? pendingFusionPda(a.owner, a.nonce)[0]
    : a.kind === RNG_KIND.CLAIM_FUSION ? claimFusionPda(a.owner, a.nonce)[0]
    : battlePda(a.owner, a.nonce)[0];
  const keys = [
    signer(a.payer),
    rw(a.owner),
    ro(a.randomness),
    ro(pinned),
    ro(lutSigner),
    rw(sbLutPda(lutSigner, a.lutSlot)[0]),
    ro(SWITCHBOARD_ON_DEMAND_ID),
    ro(ADDRESS_LOOKUP_TABLE_PROGRAM_ID),
  ];
  const data = a.kind === RNG_KIND.BATTLE
    ? ixData('close_battle_randomness_lut', new BorshWriter().u64(a.nonce).u64(a.lutSlot).toBytes())
    : ixData('close_randomness_lut', new BorshWriter().u8(a.kind).u64(a.nonce).u64(a.lutSlot).toBytes());
  return new TransactionInstruction({ programId: programOf(a.kind), keys, data: Buffer.from(data) });
}

export function closeRandomnessIx(a: RngAccounts & { payer: PublicKey; lutSlot: bigint }): TransactionInstruction {
  const lutSigner = sbLutSignerPda(a.randomness)[0];
  const pinned = a.kind === RNG_KIND.PACK ? pendingPackPda(a.owner, a.nonce)[0]
    : a.kind === RNG_KIND.FUSION ? pendingFusionPda(a.owner, a.nonce)[0]
    : a.kind === RNG_KIND.CLAIM_FUSION ? claimFusionPda(a.owner, a.nonce)[0]
    : battlePda(a.owner, a.nonce)[0];
  const keys = [
    signer(a.payer),
    rw(a.owner),
    rw(a.randomness),
    rw(a.rngAuth),
    ro(pinned),
    rw(sbRewardEscrow(a.randomness)),
    ro(sbStatePda()[0]),
    rw(sbLutPda(lutSigner, a.lutSlot)[0]),
    ro(lutSigner),
    ro(SWITCHBOARD_ON_DEMAND_ID),
    ro(WSOL_MINT),
    ro(ADDRESS_LOOKUP_TABLE_PROGRAM_ID),
    ro(TOKEN_PROGRAM_ID),
    ro(SYSTEM_PROGRAM_ID),
  ];
  const data = a.kind === RNG_KIND.BATTLE
    ? ixData('close_battle_randomness', new BorshWriter().u64(a.nonce).toBytes())
    : ixData('close_randomness', new BorshWriter().u8(a.kind).u64(a.nonce).toBytes());
  return new TransactionInstruction({ programId: programOf(a.kind), keys, data: Buffer.from(data) });
}
