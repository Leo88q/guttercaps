// Instruction builders for programs/arena (wagered 3v3 battles with $CG escrow).
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { BorshWriter } from '../borsh';
import { ixData, optional, ro, rw, signer } from '../anchor';
import { ARENA_ID, ASSOCIATED_TOKEN_PROGRAM_ID, MPL_ACCOUNT_COMPRESSION_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../ids';
import { RNG_KIND, arenaConfigPda, ata, battlePda, chipStatePda } from '../pdas';
import { commitAccountMetas } from './rng';
import type { CompressedLeafProof } from './chipCore';

export const MIN_WAGER = 5_000_000n;
export const MAX_WAGER = 5_000_000_000n;
export const RAKE_BPS = 500;
export const RAKE_TREASURY_BPS = 4_000;
export const RAKE_POOL_BPS = 2_000;
export const MIN_SQUAD_POWER = 400;
export const LEAGUE_UPPER = [800, 1400, 2400, 4000, 7000, Infinity] as const;
export const leagueOf = (power: number) => LEAGUE_UPPER.findIndex((u) => power < u);

export function createBattleIx(a: { challenger: PublicKey; nonce: bigint; wager: bigint; randomness: PublicKey; queue: PublicKey; oracle: PublicKey; squad: PublicKey[]; cgMint: PublicKey }): TransactionInstruction {
  const [battle] = battlePda(a.challenger, a.nonce);
  const keys = [
    signer(a.challenger), ro(arenaConfigPda()[0]), rw(battle), rw(a.randomness),
    ...commitAccountMetas({ kind: RNG_KIND.BATTLE, queue: a.queue, oracle: a.oracle }),
    ro(a.cgMint),
    rw(ata(a.cgMint, a.challenger)), rw(ata(a.cgMint, battle)),
    ro(TOKEN_PROGRAM_ID), ro(ASSOCIATED_TOKEN_PROGRAM_ID), ro(SYSTEM_PROGRAM_ID),
  ];
  for (const asset of a.squad) keys.push(ro(asset), ro(chipStatePda(asset)[0]));
  return new TransactionInstruction({
    programId: ARENA_ID,
    keys,
    data: Buffer.from(ixData('create_battle', new BorshWriter().u64(a.nonce).u64(a.wager).toBytes())),
  });
}

export function acceptBattleIx(a: { opponent: PublicKey; challenger: PublicKey; nonce: bigint; squad: PublicKey[]; cgMint: PublicKey }): TransactionInstruction {
  const [battle] = battlePda(a.challenger, a.nonce);
  const keys = [
    signer(a.opponent), ro(arenaConfigPda()[0]), rw(battle), rw(ata(a.cgMint, a.opponent)), rw(ata(a.cgMint, battle)), ro(TOKEN_PROGRAM_ID),
  ];
  for (const asset of a.squad) keys.push(ro(asset), ro(chipStatePda(asset)[0]));
  return new TransactionInstruction({ programId: ARENA_ID, keys, data: Buffer.from(ixData('accept_battle')) });
}

/** Same wager escrow as create_battle, but the pinned squad is a set of
 * chip_core-owned CompressedMintClaim accounts (one account per claim). */
export function createCompressedBattleIx(a: { challenger: PublicKey; nonce: bigint; wager: bigint; randomness: PublicKey; queue: PublicKey; oracle: PublicKey; claims: PublicKey[]; cgMint: PublicKey }): TransactionInstruction {
  const [battle] = battlePda(a.challenger, a.nonce);
  const keys = [
    signer(a.challenger), ro(arenaConfigPda()[0]), rw(battle), rw(a.randomness),
    ...commitAccountMetas({ kind: RNG_KIND.BATTLE, queue: a.queue, oracle: a.oracle }),
    ro(a.cgMint), rw(ata(a.cgMint, a.challenger)), rw(ata(a.cgMint, battle)),
    ro(TOKEN_PROGRAM_ID), ro(ASSOCIATED_TOKEN_PROGRAM_ID), ro(SYSTEM_PROGRAM_ID),
    ...a.claims.map(ro),
  ];
  return new TransactionInstruction({ programId: ARENA_ID, keys, data: Buffer.from(ixData('create_battle', new BorshWriter().u64(a.nonce).u64(a.wager).toBytes())) });
}

export function acceptCompressedBattleIx(a: { opponent: PublicKey; challenger: PublicKey; nonce: bigint; claims: PublicKey[]; cgMint: PublicKey }): TransactionInstruction {
  const [battle] = battlePda(a.challenger, a.nonce);
  const keys = [
    signer(a.opponent), ro(arenaConfigPda()[0]), rw(battle), rw(ata(a.cgMint, a.opponent)), rw(ata(a.cgMint, battle)), ro(TOKEN_PROGRAM_ID),
    ...a.claims.map(ro),
  ];
  return new TransactionInstruction({ programId: ARENA_ID, keys, data: Buffer.from(ixData('accept_battle')) });
}

export interface CompressedArenaChipProof {
  claim: PublicKey;
  chip: PublicKey;
  merkleTree: PublicKey;
  proof: CompressedLeafProof;
  /**
   * The leaf's live delegate. It is carried alongside the proof rather than derived from it because
   * the caller resolved both from the same DAS answer, and the program checks the delegate it is
   * given against the leaf — a delegate from a different read is a proof that does not match.
   */
  delegate: PublicKey;
}

function compressedBattleV2Data(name: string, delegates: PublicKey[], proofs: CompressedLeafProof[], depths: number[], nonce?: bigint, wager?: bigint): Buffer {
  if (delegates.length !== 3 || proofs.length !== 3 || depths.length !== 3) throw new Error('A compressed squad must contain exactly three proofs');
  const w = new BorshWriter();
  if (nonce !== undefined) w.u64(nonce);
  if (wager !== undefined) w.u64(wager);
  for (const delegate of delegates) w.pubkey(delegate);
  for (const proof of proofs) {
    w.bytes(proof.root).bytes(proof.dataHash).bytes(proof.creatorHash).bytes(proof.collectionHash).bytes(proof.assetDataHash)
      .u8(proof.flags).u64(proof.nonce).u32(proof.index);
  }
  for (const depth of depths) w.u8(depth);
  return Buffer.from(ixData(name, w.toBytes()));
}

/** Production arena entry point: each squad slot carries a registered chip
 * projection and its current Bubblegum V2 proof, never a claim-only handle. */
export function createCompressedBattleV2Ix(a: {
  challenger: PublicKey; nonce: bigint; wager: bigint; randomness: PublicKey; queue: PublicKey; oracle: PublicKey;
  squad: CompressedArenaChipProof[]; delegates: PublicKey[]; cgMint: PublicKey;
}): TransactionInstruction {
  if (a.squad.length !== 3) throw new Error('A compressed squad must contain exactly three chips');
  const [battle] = battlePda(a.challenger, a.nonce);
  const keys = [
    signer(a.challenger), ro(arenaConfigPda()[0]), rw(battle), rw(a.randomness),
    ...commitAccountMetas({ kind: RNG_KIND.BATTLE, queue: a.queue, oracle: a.oracle }), ro(a.cgMint),
    rw(ata(a.cgMint, a.challenger)), rw(ata(a.cgMint, battle)), ro(MPL_ACCOUNT_COMPRESSION_ID),
    ro(TOKEN_PROGRAM_ID), ro(ASSOCIATED_TOKEN_PROGRAM_ID), ro(SYSTEM_PROGRAM_ID),
  ];
  for (const chip of a.squad) keys.push(ro(chip.claim), ro(chip.chip), ro(chip.merkleTree), ...chip.proof.proofNodes.map(ro));
  return new TransactionInstruction({
    programId: ARENA_ID,
    keys,
    data: compressedBattleV2Data('create_battle_v2', a.delegates, a.squad.map((x) => x.proof), a.squad.map((x) => x.proof.proofNodes.length), a.nonce, a.wager),
  });
}

export function acceptCompressedBattleV2Ix(a: {
  opponent: PublicKey; challenger: PublicKey; nonce: bigint; squad: CompressedArenaChipProof[]; delegates: PublicKey[]; cgMint: PublicKey;
}): TransactionInstruction {
  if (a.squad.length !== 3) throw new Error('A compressed squad must contain exactly three chips');
  const [battle] = battlePda(a.challenger, a.nonce);
  const keys = [
    signer(a.opponent), ro(arenaConfigPda()[0]), rw(battle), rw(ata(a.cgMint, a.opponent)), rw(ata(a.cgMint, battle)),
    ro(MPL_ACCOUNT_COMPRESSION_ID), ro(TOKEN_PROGRAM_ID),
  ];
  for (const chip of a.squad) keys.push(ro(chip.claim), ro(chip.chip), ro(chip.merkleTree), ...chip.proof.proofNodes.map(ro));
  return new TransactionInstruction({
    programId: ARENA_ID,
    keys,
    data: compressedBattleV2Data('accept_battle_v2', a.delegates, a.squad.map((x) => x.proof), a.squad.map((x) => x.proof.proofNodes.length)),
  });
}

export function cancelStaleBattleIx(a: { caller: PublicKey; challenger: PublicKey; opponent?: PublicKey; nonce: bigint; cgMint: PublicKey }): TransactionInstruction {
  const [battle] = battlePda(a.challenger, a.nonce);
  return new TransactionInstruction({
    programId: ARENA_ID,
    keys: [
      signer(a.caller), ro(arenaConfigPda()[0]), rw(battle), rw(ata(a.cgMint, battle)), rw(ata(a.cgMint, a.challenger)),
      optional(a.opponent ? ata(a.cgMint, a.opponent) : undefined, ARENA_ID), rw(a.challenger), ro(TOKEN_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('cancel_stale_battle')),
  });
}

/** Pot math shown before signing: winner gets 2×wager − 5 % rake; rake → 40 % treasury / 40 % burned / 20 % season pool. */
export function wagerSplit(wager: bigint) {
  const pot = wager * 2n;
  const rake = (pot * BigInt(RAKE_BPS)) / 10_000n;
  const treasury = (rake * BigInt(RAKE_TREASURY_BPS)) / 10_000n;
  const seasonPool = (rake * BigInt(RAKE_POOL_BPS)) / 10_000n;
  return { pot, rake, treasury, seasonPool, burn: rake - treasury - seasonPool, payout: pot - rake };
}
