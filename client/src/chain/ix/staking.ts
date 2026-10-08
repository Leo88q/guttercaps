// Instruction builders for programs/staking ($CG tiers, compressed-chip staking, Merkle claims).
// The Core-chip pair (`stake_chip` / `unstake_chip`) was deleted with its instructions: both loaded
// the ["chip", asset] ChipState, and only the fail-closed `open_pack` can create one. `claim_chip`
// survives — it still owns the reward accounting for stakes opened before the migration.
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { BorshWriter } from '../borsh';
import { ixData, ro, rw, signer } from '../anchor';
import { CHIP_CORE_ID, MPL_ACCOUNT_COMPRESSION_ID, STAKING_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../ids';
import {
  ata, chipPoolPda, claimReceiptPda, compressedChipStakePda, configPda, emissionPda, pendingPackPda, pityPda, playerItemsPda, rewardRootPda,
  rewarderPda, RNG_KIND, rngAuthPda, rngPda, seasonPoolAuthPda, setBonusPda, skrPoolPda, stakeAuthPda, tokenPoolPda, tokenStakePda,
} from '../pdas';
import { SWITCHBOARD_ON_DEMAND_ID, SYSVAR_SLOT_HASHES_ID } from '../ids';
import { CHIP_VOUCHER_REWARDS, ITEM_REWARDS, isChipRootKind, isItemRootKind, isSkrRootKind } from '@guttercaps/economy';
import type { CompressedLeafProof } from './chipCore';
import { createAtaIdempotentIx } from './spl';

export const TIER_LOCK_SECS = [0, 30 * 86_400, 90 * 86_400, 180 * 86_400] as const;
export const TIER_BOOST_BPS = [10_000, 15_000, 22_000, 30_000] as const;
export const TIER_PENALTY_BPS = [0, 500, 1_000, 1_500] as const;
export const MIN_STAKE_MICRO = 10_000_000n;

export function stakeCgIx(a: { owner: PublicKey; tier: number; amount: bigint; cgMint: PublicKey }): TransactionInstruction {
  const [emission] = emissionPda();
  return new TransactionInstruction({
    programId: STAKING_ID,
    keys: [
      signer(a.owner), rw(emission), rw(tokenPoolPda()[0]), rw(tokenStakePda(a.owner, a.tier)[0]),
      rw(a.cgMint), rw(ata(a.cgMint, a.owner)), rw(ata(a.cgMint, emission)),
      ro(TOKEN_PROGRAM_ID), ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('stake_cg', new BorshWriter().u8(a.tier).u64(a.amount).toBytes())),
  });
}

/** First-use preparation belongs in the SAME transaction as the deposit. StakeCg requires
 * vault_cg to exist; init_emission creates the pools, but not this SPL token account.
 * Anyone may create the canonical ATA; only the emission PDA can authorize its funds. */
export function stakeCgIxs(a: Parameters<typeof stakeCgIx>[0]): TransactionInstruction[] {
  return [
    createAtaIdempotentIx(a.owner, a.owner, a.cgMint),
    createAtaIdempotentIx(a.owner, emissionPda()[0], a.cgMint),
    stakeCgIx(a),
  ];
}

/** amount = 0n → claim only */
export function unstakeCgIx(a: { owner: PublicKey; tier: number; amount: bigint; cgMint: PublicKey }): TransactionInstruction {
  const [emission] = emissionPda();
  return new TransactionInstruction({
    programId: STAKING_ID,
    keys: [
      signer(a.owner), rw(emission), rw(tokenPoolPda()[0]), rw(tokenStakePda(a.owner, a.tier)[0]),
      rw(a.cgMint), rw(ata(a.cgMint, a.owner)), rw(ata(a.cgMint, emission)), ro(TOKEN_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('unstake_cg', new BorshWriter().u8(a.tier).u64(a.amount).toBytes())),
  });
}



/** Bubblegum V2 claim staking: staking state is separate and chip_core owns the claim transition. */
export function stakeCompressedChipIx(a: { owner: PublicKey; claim: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: STAKING_ID,
    keys: [
      signer(a.owner), rw(emissionPda()[0]), rw(chipPoolPda()[0]), rw(compressedChipStakePda(a.claim)[0]),
      rw(setBonusPda(a.owner)[0]), ro(stakeAuthPda()[0]), rw(a.claim), ro(CHIP_CORE_ID), ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('stake_compressed_chip')),
  });
}

/** Production Bubblegum V2 staking. The proof nodes are remaining accounts and
 * are verified against the registered projection before weight is added. */
export function stakeCompressedChipV2Ix(a: {
  owner: PublicKey;
  claim: PublicKey;
  chip: PublicKey;
  merkleTree: PublicKey;
  delegate: PublicKey;
  proof: CompressedLeafProof;
}): TransactionInstruction {
  const w = new BorshWriter()
    .pubkey(a.delegate)
    .bytes(a.proof.root)
    .bytes(a.proof.dataHash)
    .bytes(a.proof.creatorHash)
    .bytes(a.proof.collectionHash)
    .bytes(a.proof.assetDataHash)
    .u8(a.proof.flags)
    .u64(a.proof.nonce)
    .u32(a.proof.index)
    .toBytes();
  return new TransactionInstruction({
    programId: STAKING_ID,
    keys: [
      signer(a.owner), rw(emissionPda()[0]), rw(chipPoolPda()[0]), rw(compressedChipStakePda(a.claim)[0]),
      rw(setBonusPda(a.owner)[0]), ro(stakeAuthPda()[0]), rw(a.claim), ro(a.chip), ro(a.merkleTree),
      ro(MPL_ACCOUNT_COMPRESSION_ID), ro(CHIP_CORE_ID), ro(SYSTEM_PROGRAM_ID),
      ...a.proof.proofNodes.map(ro),
    ],
    data: Buffer.from(ixData('stake_compressed_chip_v2', w)),
  });
}

export function unstakeCompressedChipIx(a: { owner: PublicKey; claim: PublicKey; cgMint: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: STAKING_ID,
    keys: [
      signer(a.owner), rw(emissionPda()[0]), rw(chipPoolPda()[0]), rw(compressedChipStakePda(a.claim)[0]),
      ro(stakeAuthPda()[0]), rw(a.claim), rw(a.cgMint), rw(ata(a.cgMint, a.owner)), ro(CHIP_CORE_ID),
      ro(TOKEN_PROGRAM_ID), ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('unstake_compressed_chip')),
  });
}



/** $CG Merkle claim (kinds 2..4) — mints from the emission slice. Rejects SKR / item kinds: use `claimSkrRootIx` / `claimItemRootIx`. */
export function claimRootIx(a: { wallet: PublicKey; kind: number; epoch: number; amount: bigint; proof: Uint8Array[]; cgMint: PublicKey }): TransactionInstruction {
  if (isSkrRootKind(a.kind)) throw new Error(`kind ${a.kind} is an SKR root — use claimSkrRootIx`);
  if (isItemRootKind(a.kind)) throw new Error(`kind ${a.kind} is an item root — use claimItemRootIx`);
  const [root] = rewardRootPda(a.kind, a.epoch);
  const w = new BorshWriter().u64(a.amount);
  w.vec(a.proof, (p) => w.bytes(p));
  return new TransactionInstruction({
    programId: STAKING_ID,
    keys: [
      signer(a.wallet), rw(emissionPda()[0]), rw(root), rw(claimReceiptPda(root, a.wallet)[0]),
      rw(a.cgMint), rw(ata(a.cgMint, a.wallet)), ro(TOKEN_PROGRAM_ID), ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('claim_root', w.toBytes())),
  });
}

/** SKR Merkle claim (kinds 5..7) — transfers from the treasury-funded prize pool vault (never minted). */
export function claimSkrRootIx(a: { wallet: PublicKey; kind: number; epoch: number; amount: bigint; proof: Uint8Array[]; skrMint: PublicKey }): TransactionInstruction {
  if (!isSkrRootKind(a.kind)) throw new Error(`kind ${a.kind} is a $CG root — use claimRootIx`);
  const [root] = rewardRootPda(a.kind, a.epoch);
  const [pool] = skrPoolPda();
  const w = new BorshWriter().u64(a.amount);
  w.vec(a.proof, (p) => w.bytes(p));
  return new TransactionInstruction({
    programId: STAKING_ID,
    keys: [
      signer(a.wallet), ro(emissionPda()[0]), rw(pool), rw(root), rw(claimReceiptPda(root, a.wallet)[0]),
      rw(ata(a.skrMint, pool)), rw(ata(a.skrMint, a.wallet)), ro(TOKEN_PROGRAM_ID), ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('claim_skr_root', w.toBytes())),
  });
}

/**
 * Item Merkle claim (kind 8 = fusion boosters, backlog #27) — `amount` is the booster COUNT (≤ 10). The program
 * verifies the proof and CPIs chip_core `grant_booster` signed by its `["rewarder"]` PDA, so the boosters land in
 * `PlayerItems` (`["items", wallet]`, created on first claim with the wallet as payer) in this transaction.
 */
export function claimItemRootIx(a: { wallet: PublicKey; kind: number; epoch: number; amount: bigint; proof: Uint8Array[] }): TransactionInstruction {
  if (!isItemRootKind(a.kind)) throw new Error(`kind ${a.kind} is not an item root — use claimRootIx / claimSkrRootIx`);
  if (a.amount <= 0n || a.amount > BigInt(ITEM_REWARDS.maxClaim)) throw new Error(`item claim must be 1..${ITEM_REWARDS.maxClaim} boosters`);
  const [root] = rewardRootPda(a.kind, a.epoch);
  const w = new BorshWriter().u64(a.amount);
  w.vec(a.proof, (p) => w.bytes(p));
  return new TransactionInstruction({
    programId: STAKING_ID,
    keys: [
      signer(a.wallet), ro(emissionPda()[0]), rw(root), rw(claimReceiptPda(root, a.wallet)[0]),
      ro(rewarderPda()[0]), ro(configPda()[0]), rw(playerItemsPda(a.wallet)[0]), ro(CHIP_CORE_ID), ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('claim_item_root', w.toBytes())),
  });
}

/**
 * Chip voucher Merkle claim (kind 9 = quest chips, backlog #28) — `amount` is the voucher TEMPLATE id (0..3). The program
 * verifies the proof and CPIs chip_core `open_voucher(nonce, template)` signed by its `["rewarder"]` PDA: a free 1-chip
 * `PendingPack` `["pending", wallet, nonce]` is created and committed to Switchboard in this tx, so the SAME transaction
 * must carry chip_core `init_randomness(0, nonce)` first (see `prepareRandomness`) — exactly like `buy_pack`. The chip is
 * then minted by the regular `open_pack` crank / `PackFlow.open()` (soulbound for the template's days). The wallet fronts
 * the pending rent + one chip's rent reserve + the Switchboard request, all returned when the pending closes.
 */
export function claimChipRootIx(a: { wallet: PublicKey; kind: number; epoch: number; amount: bigint; proof: Uint8Array[]; nonce: bigint; queue: PublicKey; oracle: PublicKey }): TransactionInstruction {
  if (!isChipRootKind(a.kind)) throw new Error(`kind ${a.kind} is not a chip voucher root — use claimRootIx / claimSkrRootIx / claimItemRootIx`);
  if (a.amount < 0n || a.amount > BigInt(CHIP_VOUCHER_REWARDS.maxTemplate)) throw new Error(`chip voucher template must be 0..${CHIP_VOUCHER_REWARDS.maxTemplate}`);
  const [root] = rewardRootPda(a.kind, a.epoch);
  const w = new BorshWriter().u64(a.amount);
  w.vec(a.proof, (p) => w.bytes(p));
  w.u64(a.nonce);
  return new TransactionInstruction({
    programId: STAKING_ID,
    keys: [
      signer(a.wallet), ro(emissionPda()[0]), rw(root), rw(claimReceiptPda(root, a.wallet)[0]),
      ro(rewarderPda()[0]), ro(configPda()[0]), rw(pityPda(a.wallet)[0]), rw(pendingPackPda(a.wallet, a.nonce)[0]),
      rw(rngPda(RNG_KIND.PACK, a.wallet, a.nonce)[0]), ro(rngAuthPda(RNG_KIND.PACK)[0]), ro(SWITCHBOARD_ON_DEMAND_ID), ro(a.queue), rw(a.oracle), ro(SYSVAR_SLOT_HASHES_ID),
      ro(CHIP_CORE_ID), ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('claim_chip_root', w.toBytes())),
  });
}

/** Route a claim leaf to the right instruction by its root kind (2..4 $CG, 5..7 SKR, 8 boosters). Kind 9 (chip vouchers) needs its own tx — `claimChipRootIx`. */
export function claimAnyRootIx(a: { wallet: PublicKey; kind: number; epoch: number; amount: bigint; proof: Uint8Array[]; cgMint?: PublicKey; skrMint?: PublicKey }): TransactionInstruction {
  if (isChipRootKind(a.kind)) throw new Error('chip voucher claims need a randomness account in the same tx — use claimChipRootIx');
  if (isItemRootKind(a.kind)) return claimItemRootIx(a);
  if (isSkrRootKind(a.kind)) {
    if (!a.skrMint) throw new Error('SKR mint not configured');
    return claimSkrRootIx({ ...a, skrMint: a.skrMint });
  }
  if (!a.cgMint) throw new Error('$CG mint not configured');
  return claimRootIx({ ...a, cgMint: a.cgMint });
}

/** Treasury / anyone tops up the SKR prize pool (multisig runs this weekly from SKR revenue). */
export function fundSkrIx(a: { funder: PublicKey; amount: bigint; skrMint: PublicKey }): TransactionInstruction {
  const [pool] = skrPoolPda();
  return new TransactionInstruction({
    programId: STAKING_ID,
    keys: [signer(a.funder, false), rw(pool), rw(ata(a.skrMint, a.funder)), rw(ata(a.skrMint, pool)), ro(TOKEN_PROGRAM_ID)],
    data: Buffer.from(ixData('fund_skr', new BorshWriter().u64(a.amount).toBytes())),
  });
}

/** SEC-L5 `fund_slice(kind, amount)` — season oracle / admin burns the arena's 20 % wager rake (season pool ATA) into `slice_budget[kind]`; only kind 3 (PvpSeason) is accepted. */
export const SLICE_PVP_SEASON = 3;
export function fundSliceIx(a: { authority: PublicKey; amount: bigint; cgMint: PublicKey; kind?: number }): TransactionInstruction {
  const [auth] = seasonPoolAuthPda();
  return new TransactionInstruction({
    programId: STAKING_ID,
    keys: [signer(a.authority, false), rw(emissionPda()[0]), rw(a.cgMint), ro(auth), rw(ata(a.cgMint, auth)), ro(TOKEN_PROGRAM_ID)],
    data: Buffer.from(ixData('fund_slice', new BorshWriter().u8(a.kind ?? SLICE_PVP_SEASON).u64(a.amount).toBytes())),
  });
}

/** Early-exit penalty preview (bps of principal, burned), rounded UP exactly like on-chain
 *  `staking::state::early_exit_penalty` (SEC-F3 — a floor let dust-sized exits skip the burn). */
export function unstakePenalty(amount: bigint, tier: number, unlockAt: bigint, nowSec = Math.floor(Date.now() / 1000)): bigint {
  if (BigInt(nowSec) >= unlockAt) return 0n;
  return (amount * BigInt(TIER_PENALTY_BPS[tier] ?? 0) + 9_999n) / 10_000n;
}
