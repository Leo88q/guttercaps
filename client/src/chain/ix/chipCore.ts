// Instruction builders for programs/chip_core. Account order MUST match the
// #[derive(Accounts)] structs (see programs/chip_core/src/instructions/*).
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { BorshWriter } from '../borsh';
import { ixData, optional, ro, rw, signer } from '../anchor';
import { CHIP_CORE_ID, MPL_ACCOUNT_COMPRESSION_ID, MPL_BUBBLEGUM_V2_ID, MPL_CORE_ID, MPL_NOOP_ID, SWITCHBOARD_ON_DEMAND_ID, SYSTEM_PROGRAM_ID, SYSVAR_SLOT_HASHES_ID, TOKEN_PROGRAM_ID } from '../ids';
import {
  RNG_KIND, assetPda, ata, bubblegumTreeMetaPda, chipStatePda, claimFusionPda, collectionMetaPda, compressedChipStatePda, compressedMintClaimPda, compressedSettlementPda, configPda, ledgerPdaOf, pendingFusionPda, pendingPackPda, pityPda, playerItemsPda, rngAuthPda, serviceLedgerPda, vaultPda,
} from '../pdas';
import { commitAccountMetas } from './rng';

/** Create the Bubblegum V2 TreeConfig through chip_core so the registered
 * collection PDA can be the tree creator/delegate signer. `merkleTree` must be
 * preallocated with Account Compression as owner by the operations transaction. */
export interface CreateBubblegumTreeArgs {
  admin: PublicKey;
  collectionIdx: number;
  merkleTree: PublicKey;
  treeConfig: PublicKey;
  maxDepth: number;
  canopy: number;
  maxBufferSize: number;
}

export function createBubblegumTreeIx(a: CreateBubblegumTreeArgs): TransactionInstruction {
  const [config] = configPda();
  const [collection] = collectionMetaPda(a.collectionIdx);
  const [treeMeta] = bubblegumTreeMetaPda(a.collectionIdx);
  const data = new BorshWriter().u8(a.collectionIdx).u8(a.maxDepth).u8(a.canopy).u32(a.maxBufferSize).toBytes();
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [
      signer(a.admin), ro(config), ro(collection), rw(treeMeta), rw(a.merkleTree), rw(a.treeConfig),
      ro(MPL_BUBBLEGUM_V2_ID), ro(MPL_NOOP_ID), ro(MPL_ACCOUNT_COMPRESSION_ID), ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('create_bubblegum_tree', data)),
  });
}

/** One-time admin binding for a Bubblegum V2 tree created by the operations script. */
interface ConfigureBubblegumTreeArgs {
  admin: PublicKey;
  collectionIdx: number;
  merkleTree: PublicKey;
  treeConfig: PublicKey;
  treeAuthority: PublicKey;
  maxDepth: number;
  canopy: number;
}

export function configureBubblegumTreeIx(a: ConfigureBubblegumTreeArgs): TransactionInstruction {
  const [config] = configPda();
  const [meta] = collectionMetaPda(a.collectionIdx);
  const [treeMeta] = bubblegumTreeMetaPda(a.collectionIdx);
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [
      signer(a.admin), ro(config), ro(meta), rw(treeMeta), ro(a.merkleTree), ro(a.treeConfig), ro(a.treeAuthority), ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('configure_bubblegum_tree', new BorshWriter().u8(a.collectionIdx).u8(a.maxDepth).u8(a.canopy).toBytes())),
  });
}

export interface CompressedLeafProof {
  root: Uint8Array;
  dataHash: Uint8Array;
  creatorHash: Uint8Array;
  collectionHash: Uint8Array;
  assetDataHash: Uint8Array;
  flags: number;
  nonce: bigint;
  index: number;
  proofNodes: PublicKey[];
}

export const COMPRESSED_CLAIM_PACK_STRIDE = 128n;

export function compressedClaimNonce(purchaseNonce: bigint, packNo: number, chipNo: number): bigint {
  if (!Number.isInteger(packNo) || packNo < 0 || !Number.isInteger(chipNo) || chipNo < 0 || chipNo >= 5) throw new Error('Invalid compressed claim coordinates');
  return purchaseNonce * COMPRESSED_CLAIM_PACK_STRIDE + BigInt(packNo * 5 + chipNo);
}

export interface OpenCompressedPackArgs {
  payer: PublicKey;
  buyer: PublicKey;
  nonce: bigint;
  packNo: number;
  chips: number;
  collectionIdx: number[];
  randomness: PublicKey;
}

/** Permissionless roll-to-claim transition. Each collection/tree pair is
 * transport data only; the program re-derives and validates every account. */
export function openCompressedPackIx(a: OpenCompressedPackArgs): TransactionInstruction {
  if (!Number.isInteger(a.chips) || a.chips < 1 || a.chips > 5 || a.collectionIdx.length !== a.chips) throw new Error('Invalid compressed pack chip count');
  const [config] = configPda();
  const [pending] = pendingPackPda(a.buyer, a.nonce);
  const [pity] = pityPda(a.buyer);
  const [settlement] = compressedSettlementPda(a.buyer, a.nonce);
  const keys = [signer(a.payer), ro(config), rw(pending), ro(a.randomness), rw(pity), rw(settlement), ro(a.buyer), ro(SYSTEM_PROGRAM_ID)];
  for (let i = 0; i < a.chips; i++) {
    keys.push(rw(compressedMintClaimPda(a.buyer, compressedClaimNonce(a.nonce, a.packNo, i))[0]));
    keys.push(rw(collectionMetaPda(a.collectionIdx[i])[0]));
    keys.push(ro(bubblegumTreeMetaPda(a.collectionIdx[i])[0]));
  }
  const data = new BorshWriter().u64(a.nonce).u8(a.packNo).toBytes();
  return new TransactionInstruction({ programId: CHIP_CORE_ID, keys, data: Buffer.from(ixData('open_compressed_pack', data)) });
}

interface FuseCompressedClaimsArgs {
  owner: PublicKey;
  resultClaimNonce: bigint;
  resultCollectionIdx: number;
  cgMint: PublicKey;
  materialClaims: PublicKey[];
}

export function fuseCompressedClaimsIx(a: FuseCompressedClaimsArgs): TransactionInstruction {
  if (a.materialClaims.length !== 3) throw new Error('compressed fusion requires three claims');
  const [config] = configPda();
  const [resultClaim] = compressedMintClaimPda(a.owner, a.resultClaimNonce);
  const data = new BorshWriter().u64(a.resultClaimNonce).u8(a.resultCollectionIdx).toBytes();
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [
      signer(a.owner), ro(config), rw(ledgerPdaOf(a.owner)[0]), rw(collectionMetaPda(a.resultCollectionIdx)[0]),
      rw(resultClaim), rw(a.cgMint), rw(ata(a.cgMint, a.owner)), ro(TOKEN_PROGRAM_ID), ro(SYSTEM_PROGRAM_ID),
      ...a.materialClaims.map(rw),
    ],
    data: Buffer.from(ixData('fuse_compressed_claims', data)),
  });
}

export interface FuseClaimsCommitArgs {
  owner: PublicKey;
  nonce: bigint;
  resultCollectionIdx: number;
  useBooster: boolean;
  /** program-owned randomness PDA `["rng", 3, owner, nonce]` created by `init_randomness` in the same tx */
  randomness: PublicKey;
  queue: PublicKey;
  oracle: PublicKey;
  cgMint: PublicKey;
  /** exactly 3 material claim PDAs */
  materials: PublicKey[];
}

/**
 * Randomized claim fusion (H3): commit three claims + escrow the fee, randomness kind 3.
 * Committer UIs must keep fusion nonces out of the pack-claim `purchase_nonce * 128 + …`
 * stride space (the reveal reuses the commit nonce as the result claim nonce).
 */
export function fuseClaimsCommitIx(a: FuseClaimsCommitArgs): TransactionInstruction {
  if (a.materials.length !== 3) throw new Error('Claim fusion needs exactly 3 material claims');
  const [config] = configPda();
  const [pending] = claimFusionPda(a.owner, a.nonce);
  const [items] = playerItemsPda(a.owner);
  const [resultMeta] = collectionMetaPda(a.resultCollectionIdx);
  const [vault] = vaultPda();
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [
      signer(a.owner), ro(config), rw(ledgerPdaOf(a.owner)[0]), rw(pending), rw(a.randomness), ro(rngAuthPda(RNG_KIND.CLAIM_FUSION)[0]),
      ro(SWITCHBOARD_ON_DEMAND_ID), ro(a.queue), rw(a.oracle), ro(SYSVAR_SLOT_HASHES_ID), rw(items), rw(resultMeta),
      rw(a.cgMint), rw(ata(a.cgMint, a.owner)), ro(vault), rw(ata(a.cgMint, vault)), ro(TOKEN_PROGRAM_ID), ro(SYSTEM_PROGRAM_ID),
      ...a.materials.map(rw),
    ],
    data: Buffer.from(ixData('fuse_claims_commit', new BorshWriter().u64(a.nonce).bool(a.useBooster).toBytes())),
  });
}

export interface FuseClaimsRevealArgs {
  payer: PublicKey;
  owner: PublicKey;
  nonce: bigint;
  /** protocol convention: `resultClaimNonce == nonce` (see backend `chain.ts`) */
  resultClaimNonce: bigint;
  resultCollectionIdx: number;
  randomness: PublicKey;
  cgMint: PublicKey;
  materials: PublicKey[];
}

/** `fuse_claims_reveal(nonce, result_claim_nonce)` — permissionless; survivors refunded or the result claim is created. */
export function fuseClaimsRevealIx(a: FuseClaimsRevealArgs): TransactionInstruction {
  if (a.materials.length !== 3) throw new Error('Claim fusion needs exactly 3 material claims');
  const [config] = configPda();
  const [pending] = claimFusionPda(a.owner, a.nonce);
  const [resultMeta] = collectionMetaPda(a.resultCollectionIdx);
  const [resultClaim] = compressedMintClaimPda(a.owner, a.resultClaimNonce);
  const [vault] = vaultPda();
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [
      signer(a.payer), ro(config), rw(ledgerPdaOf(a.owner)[0]), rw(pending), ro(a.randomness), rw(a.owner),
      rw(resultMeta), rw(resultClaim), rw(vault), rw(a.cgMint), rw(ata(a.cgMint, vault)), ro(TOKEN_PROGRAM_ID), ro(SYSTEM_PROGRAM_ID),
      ...a.materials.map(rw),
    ],
    data: Buffer.from(ixData('fuse_claims_reveal', new BorshWriter().u64(a.nonce).u64(a.resultClaimNonce).toBytes())),
  });
}

export interface CancelStaleClaimFusionArgs {
  owner: PublicKey;
  nonce: bigint;
  randomness: PublicKey;
  cgMint: PublicKey;
  materials: PublicKey[];
}

/** `cancel_stale_claim_fusion(nonce)` — oracle outage only; fee refunded, materials un-consumed. */
export function cancelStaleClaimFusionIx(a: CancelStaleClaimFusionArgs): TransactionInstruction {
  if (a.materials.length !== 3) throw new Error('Claim fusion needs exactly 3 material claims');
  const [config] = configPda();
  const [pending] = claimFusionPda(a.owner, a.nonce);
  const [vault] = vaultPda();
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [
      signer(a.owner), ro(config), rw(ledgerPdaOf(a.owner)[0]), rw(pending), ro(a.randomness),
      rw(vault), rw(ata(a.cgMint, vault)), rw(ata(a.cgMint, a.owner)), ro(TOKEN_PROGRAM_ID), ro(SYSTEM_PROGRAM_ID),
      ...a.materials.map(rw),
    ],
    data: Buffer.from(ixData('cancel_stale_claim_fusion', new BorshWriter().u64(a.nonce).toBytes())),
  });
}

/** `close_expired_claim(claim_nonce)` — buyer reclaims the rent of an expired settlement-free claim shell. */
export function closeExpiredClaimIx(a: { buyer: PublicKey; claimNonce: bigint }): TransactionInstruction {
  const [claim] = compressedMintClaimPda(a.buyer, a.claimNonce);
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [signer(a.buyer), rw(claim), ro(SYSTEM_PROGRAM_ID)],
    data: Buffer.from(ixData('close_expired_claim', new BorshWriter().u64(a.claimNonce).toBytes())),
  });
}

export interface StageCompressedChipArgs {
  admin: PublicKey;
  buyer: PublicKey;
  collectionIdx: number;
  claimNonce: bigint;
  rarity: number;
  level: number;
  gameIndex: bigint;
  expiresAt: bigint;
}

export function stageCompressedChipIx(a: StageCompressedChipArgs): TransactionInstruction {
  const [config] = configPda();
  const [collection] = collectionMetaPda(a.collectionIdx);
  const [treeMeta] = bubblegumTreeMetaPda(a.collectionIdx);
  const [claim] = compressedMintClaimPda(a.buyer, a.claimNonce);
  const data = new BorshWriter()
    .pubkey(a.buyer).u8(a.collectionIdx).u64(a.claimNonce).u8(a.rarity).u8(a.level).u64(a.gameIndex).i64(a.expiresAt).toBytes();
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [signer(a.admin), ro(config), ro(collection), ro(treeMeta), rw(claim), ro(a.buyer), ro(SYSTEM_PROGRAM_ID)],
    data: Buffer.from(ixData('stage_compressed_chip', data)),
  });
}

export interface MintCompressedChipArgs {
  payer: PublicKey;
  buyer: PublicKey;
  collectionIdx: number;
  claimNonce: bigint;
  treeConfig: PublicKey;
  merkleTree: PublicKey;
  coreCollection: PublicKey;
}

/** Bubblegum V2 mint CPI for a previously staged claim. The collection PDA is
 * deliberately supplied as both collection authority and tree delegate; the
 * program derives the corresponding signer seeds on chain. */
export function mintCompressedChipIx(a: MintCompressedChipArgs): TransactionInstruction {
  const [config] = configPda();
  const [collection] = collectionMetaPda(a.collectionIdx);
  const [treeMeta] = bubblegumTreeMetaPda(a.collectionIdx);
  const [claim] = compressedMintClaimPda(a.buyer, a.claimNonce);
  const data = new BorshWriter().pubkey(a.buyer).u8(a.collectionIdx).u64(a.claimNonce).toBytes();
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [
      signer(a.payer), ro(config), ro(collection), ro(treeMeta), rw(claim), ro(a.buyer),
      rw(a.treeConfig), rw(a.merkleTree), ro(collection), rw(a.coreCollection),
      ro(PublicKey.findProgramAddressSync([Buffer.from('mpl_core_cpi_signer')], MPL_BUBBLEGUM_V2_ID)[0]),
      ro(MPL_BUBBLEGUM_V2_ID), ro(MPL_NOOP_ID), ro(MPL_ACCOUNT_COMPRESSION_ID), ro(MPL_CORE_ID), ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('mint_compressed_chip', data)),
  });
}

export interface RegisterCompressedChipArgs {
  payer: PublicKey;
  buyer: PublicKey;
  claimNonce: bigint;
  asset: PublicKey;
  merkleTree: PublicKey;
  treeConfig: PublicKey;
  collectionIdx: number;
  owner: PublicKey;
  delegate: PublicKey;
  proof: CompressedLeafProof;
  rarity: number;
  level: number;
  gameIndex: bigint;
  /** Settlement PDA for claims created by open_compressed_pack. Omit for
   * legacy/admin-staged claims. */
  settlement?: PublicKey;
}

/** Proof-backed registration. DAS values are transport only; the program
 * verifies the reconstructed V2 leaf against Account Compression. */
export function registerCompressedChipIx(a: RegisterCompressedChipArgs): TransactionInstruction {
  if (a.proof.root.length !== 32 || a.proof.dataHash.length !== 32 || a.proof.creatorHash.length !== 32 ||
      a.proof.collectionHash.length !== 32 || a.proof.assetDataHash.length !== 32) {
    throw new Error('Bubblegum V2 hashes and root must be exactly 32 bytes');
  }
  if (!Number.isInteger(a.proof.index) || a.proof.index < 0 || a.proof.index > 0xffff_ffff) throw new Error('Invalid Bubblegum leaf index');
  if (!Number.isInteger(a.proof.flags) || a.proof.flags < 0 || a.proof.flags > 255) throw new Error('Invalid Bubblegum flags');
  if (a.proof.nonce < 0n || a.gameIndex < 0n || a.claimNonce < 0n || a.proof.proofNodes.length > 30) throw new Error('Invalid Bubblegum proof coordinates');
  const [config] = configPda();
  const [collection] = collectionMetaPda(a.collectionIdx);
  const [treeMeta] = bubblegumTreeMetaPda(a.collectionIdx);
  const [chip] = compressedChipStatePda(a.asset);
  const data = new BorshWriter()
    .pubkey(a.asset)
    .u8(a.collectionIdx)
    .pubkey(a.owner)
    .pubkey(a.delegate)
    .pubkey(a.buyer)
    .u64(a.claimNonce)
    .bytes(a.proof.root)
    .bytes(a.proof.dataHash)
    .bytes(a.proof.creatorHash)
    .bytes(a.proof.collectionHash)
    .bytes(a.proof.assetDataHash)
    .u8(a.proof.flags)
    .u64(a.proof.nonce)
    .u32(a.proof.index)
    .u8(a.rarity)
    .u8(a.level)
    .u64(a.gameIndex)
    .toBytes();
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [
      signer(a.payer), ro(config), rw(collection), ro(treeMeta), rw(compressedMintClaimPda(a.buyer, a.claimNonce)[0]), a.settlement ? rw(a.settlement) : ro(SYSTEM_PROGRAM_ID), ro(a.buyer), rw(chip), ro(a.asset),
      ro(a.owner), ro(a.delegate), ro(a.merkleTree), ro(a.treeConfig), ro(MPL_BUBBLEGUM_V2_ID),
      ro(MPL_ACCOUNT_COMPRESSION_ID), ro(SYSTEM_PROGRAM_ID),
      ...a.proof.proofNodes.map(ro),
    ],
    data: Buffer.from(ixData('register_compressed_chip', data)),
  });
}

export interface CancelCompressedClaimArgs { buyer: PublicKey; claimNonce: bigint; nonce: bigint }
export function cancelCompressedClaimIx(a: CancelCompressedClaimArgs): TransactionInstruction {
  const [settlement] = compressedSettlementPda(a.buyer, a.nonce);
  const [pending] = pendingPackPda(a.buyer, a.nonce);
  const [claim] = compressedMintClaimPda(a.buyer, a.claimNonce);
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [signer(a.buyer), rw(settlement), ro(pending), rw(claim), ro(SYSTEM_PROGRAM_ID)],
    data: Buffer.from(ixData('cancel_compressed_claim', new BorshWriter().u64(a.claimNonce).u64(a.nonce).toBytes())),
  });
}

export interface FinalizeCompressedPackArgs {
  payer: PublicKey;
  buyer: PublicKey;
  nonce: bigint;
  cg?: { cgMint: PublicKey; vaultCg: PublicKey; treasuryCg: PublicKey };
  /** Token accounts used only by the expiry refund branch. */
  refundToken?: { vault: PublicKey; buyer: PublicKey };
}

export function finalizeCompressedPackIx(a: FinalizeCompressedPackArgs): TransactionInstruction {
  const [config] = configPda();
  const [settlement] = compressedSettlementPda(a.buyer, a.nonce);
  const [pending] = pendingPackPda(a.buyer, a.nonce);
  const [ledger] = ledgerPdaOf(a.buyer);
  const [vault] = vaultPda();
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [
      signer(a.payer), ro(config), rw(settlement), rw(pending), rw(a.buyer), rw(ledger), rw(vault),
      optional(a.cg?.cgMint, CHIP_CORE_ID), optional(a.cg?.vaultCg, CHIP_CORE_ID), optional(a.cg?.treasuryCg, CHIP_CORE_ID),
      optional(a.refundToken?.vault, CHIP_CORE_ID), optional(a.refundToken?.buyer, CHIP_CORE_ID),
      ro(TOKEN_PROGRAM_ID), ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('finalize_compressed_pack', new BorshWriter().u64(a.nonce).toBytes())),
  });
}

export const Currency = { SOL: 0, USDC: 1, CG: 2, SKR: 3 } as const;
export type CurrencyCode = (typeof Currency)[keyof typeof Currency];

/** 0.008 SOL per chip reserved in PendingPack so any cranker can open the pack (unspent part returned to the buyer at the last open — SEC-L3). */
export const RENT_RESERVE_PER_CHIP = 8_000_000n;
/** Refund window (≈ 72 min at 400 ms slots) — mirrors chip_core::economy::STALE_PACK_SLOTS and @guttercaps/economy `STALE_PACK_SLOTS` (sync-check pins all three); refunds are only possible after the oracle's 1 h reveal window has expired (SEC-C3). */
export const STALE_PACK_SLOTS = 10_800n;

interface BuyPackArgs {
  buyer: PublicKey;
  sku: number;
  qty: number;
  currency: CurrencyCode;
  nonce: bigint;
  /** buyer cap for SOL lamports / micro-SKR (frozen FX amount); pass 0n otherwise */
  maxLamports: bigint;
  /** program-owned randomness PDA `["rng", 0, buyer, nonce]` created by `init_randomness` in the same tx */
  randomness: PublicKey;
  /** commit CPI accounts (SEC-C3 part 2): the pinned queue and the oracle chosen for this request */
  queue: PublicKey;
  oracle: PublicKey;
  /** unused (frozen FX); kept so the IDL account list stays optional */
  priceUpdate?: PublicKey;
  /** mints from GameConfig */
  usdcMint: PublicKey;
  cgMint: PublicKey;
  skrMint?: PublicKey;
}

/** SPL mint that pays for `currency`, or undefined for SOL. */
export function payMintFor(currency: CurrencyCode, mints: { usdcMint: PublicKey; cgMint: PublicKey; skrMint?: PublicKey }): PublicKey | undefined {
  if (currency === Currency.USDC) return mints.usdcMint;
  if (currency === Currency.CG) return mints.cgMint;
  if (currency === Currency.SKR) return mints.skrMint;
  return undefined;
}

export function buyPackIx(a: BuyPackArgs): TransactionInstruction {
  const [config] = configPda();
  const [pity] = pityPda(a.buyer);
  const [pending] = pendingPackPda(a.buyer, a.nonce);
  const [vault] = vaultPda();
  const payMint = payMintFor(a.currency, a);
  const data = ixData(
    'buy_pack',
    new BorshWriter().u8(a.sku).u8(a.qty).u8(a.currency).u64(a.nonce).u64(a.maxLamports).toBytes(),
  );
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [
      signer(a.buyer),
      ro(config),                       // #12: config is read-only in every player instruction
      rw(ledgerPdaOf(a.buyer)[0]),      // buyer's liability shard
      rw(pity),
      rw(pending),
      rw(a.randomness),
      ...commitAccountMetas({ kind: RNG_KIND.PACK, queue: a.queue, oracle: a.oracle }),
      a.currency === Currency.SOL ? rw(vault) : ro(vault), // vault lamports change only on the SOL path
      optional(undefined, CHIP_CORE_ID, false), // frozen FX: price_update is always None
      optional(payMint ? ata(payMint, a.buyer) : undefined, CHIP_CORE_ID),
      optional(payMint ? ata(payMint, vault) : undefined, CHIP_CORE_ID),
      ro(TOKEN_PROGRAM_ID),
      ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(data),
  });
}

export interface OpenPackArgs {
  payer: PublicKey;
  buyer: PublicKey;
  nonce: bigint;
  packNo: number;
  /** packs in the purchase — the LAST pack (`packNo === qty − 1`) settles and needs the ledger shard writable (#12); default 1 */
  qty?: number;
  randomness: PublicKey;
  /** rolled collection index per chip slot (from expandRandomness) */
  rolledCollections: number[];
  /** CollectionMeta.core_collection for each collection index */
  coreCollectionOf: (idx: number) => PublicKey;
  /** only for $CG-paid packs (settlement happens on the last open) */
  cg?: { cgMint: PublicKey; treasury: PublicKey };
}

/** Legacy MPL-Core path. The on-chain handler is fail-closed during the full
 * Bubblegum V2 migration; callers must use claim -> mint -> registration.
 * @deprecated Use {@link openCompressedPackIx} and the V2 settlement pipeline instead. */
export function openPackIx(a: OpenPackArgs): TransactionInstruction {
  const [config] = configPda();
  const [pending] = pendingPackPda(a.buyer, a.nonce);
  const [pity] = pityPda(a.buyer);
  const [vault] = vaultPda();
  const settles = a.packNo === (a.qty ?? 1) - 1;
  const keys = [
    signer(a.payer),
    ro(config),
    settles ? rw(ledgerPdaOf(a.buyer)[0]) : ro(ledgerPdaOf(a.buyer)[0]), // #12: shard writable only on the settling pack
    rw(pending),
    ro(a.randomness),
    rw(pity),
    rw(a.buyer),
    ro(vault),                                                            // signs the $CG split, never changes here
    optional(a.cg?.cgMint, CHIP_CORE_ID),
    optional(a.cg ? ata(a.cg.cgMint, vault) : undefined, CHIP_CORE_ID),
    optional(a.cg ? ata(a.cg.cgMint, a.cg.treasury) : undefined, CHIP_CORE_ID),
    ro(MPL_CORE_ID),
    ro(TOKEN_PROGRAM_ID),
    ro(SYSTEM_PROGRAM_ID),
  ];
  a.rolledCollections.forEach((col, i) => {
    const [asset] = assetPda(pending, a.packNo, i);
    const [state] = chipStatePda(asset);
    const [meta] = collectionMetaPda(col);
    keys.push(rw(asset), rw(state), rw(meta), rw(a.coreCollectionOf(col)));
  });
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys,
    data: Buffer.from(ixData('open_pack', new BorshWriter().u64(a.nonce).u8(a.packNo).toBytes())),
  });
}

interface CancelStalePackArgs {
  buyer: PublicKey;
  nonce: bigint;
  randomness: PublicKey;
  /** mint of the SPL currency that was paid (USDC, CG or SKR); undefined for SOL */
  paidMint?: PublicKey;
}

export function cancelStalePackIx(a: CancelStalePackArgs): TransactionInstruction {
  const [config] = configPda();
  const [pending] = pendingPackPda(a.buyer, a.nonce);
  const [vault] = vaultPda();
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [
      signer(a.buyer),
      ro(config),
      rw(ledgerPdaOf(a.buyer)[0]), // #12
      rw(pending),
      ro(a.randomness),
      rw(vault),
      optional(a.paidMint ? ata(a.paidMint, vault) : undefined, CHIP_CORE_ID),
      optional(a.paidMint ? ata(a.paidMint, a.buyer) : undefined, CHIP_CORE_ID),
      ro(TOKEN_PROGRAM_ID),
      ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('cancel_stale_pack', new BorshWriter().u64(a.nonce).toBytes())),
  });
}

// ---------------------------------------------------------------- fusion
export interface FuseMaterial { asset: PublicKey; collectionIdx: number }

interface FuseArgs {
  owner: PublicKey;
  nonce: bigint;
  useBooster: boolean;
  /**
   * Randomized recipes (< 100 %): the program-owned randomness PDA `["rng", 1, owner, nonce]` created
   * by `init_randomness` in the same tx + the commit CPI accounts. Omit for atomic recipes (the five
   * optional slots collapse to the program id).
   */
  rng?: { randomness: PublicKey; queue: PublicKey; oracle: PublicKey };
  materials: FuseMaterial[]; // exactly 3
  resultCollectionIdx: number;
  cgMint: PublicKey;
  coreCollectionOf: (idx: number) => PublicKey;
}

export function fuseIx(a: FuseArgs): TransactionInstruction {
  const [config] = configPda();
  const [pending] = pendingFusionPda(a.owner, a.nonce);
  const [items] = playerItemsPda(a.owner);
  const [resultMeta] = collectionMetaPda(a.resultCollectionIdx);
  const [resultAsset] = assetPda(pending, 0, 0);
  const [resultState] = chipStatePda(resultAsset);
  const keys = [
    signer(a.owner),
    ro(config),
    rw(ledgerPdaOf(a.owner)[0]), // #12: fee burn / escrow accounting
    rw(pending),
    optional(a.rng?.randomness, CHIP_CORE_ID),
    ro(rngAuthPda(RNG_KIND.FUSION)[0]),
    optional(a.rng ? SWITCHBOARD_ON_DEMAND_ID : undefined, CHIP_CORE_ID, false),
    optional(a.rng?.queue, CHIP_CORE_ID, false),
    optional(a.rng?.oracle, CHIP_CORE_ID),
    optional(a.rng ? SYSVAR_SLOT_HASHES_ID : undefined, CHIP_CORE_ID, false),
    rw(items),
    rw(resultMeta),
    rw(a.coreCollectionOf(a.resultCollectionIdx)),
    rw(resultAsset),
    rw(resultState),
    rw(a.cgMint),
    rw(ata(a.cgMint, a.owner)),
    ro(vaultPda()[0]),                 // SEC-M3: fee escrow authority
    rw(ata(a.cgMint, vaultPda()[0])),  // vault $CG ATA (randomized recipes park the fee here)
    ro(MPL_CORE_ID),
    ro(TOKEN_PROGRAM_ID),
    ro(SYSTEM_PROGRAM_ID),
  ];
  // remaining: [asset, state] × 3, then [meta, core_collection] × 3
  for (const m of a.materials) keys.push(rw(m.asset), rw(chipStatePda(m.asset)[0]));
  for (const m of a.materials) keys.push(rw(collectionMetaPda(m.collectionIdx)[0]), rw(a.coreCollectionOf(m.collectionIdx)));
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys,
    data: Buffer.from(ixData('fuse', new BorshWriter().u64(a.nonce).bool(a.useBooster).toBytes())),
  });
}

export interface FuseRevealArgs {
  payer: PublicKey;
  owner: PublicKey;
  nonce: bigint;
  randomness: PublicKey;
  resultCollectionIdx: number;
  materials: FuseMaterial[];
  coreCollectionOf: (idx: number) => PublicKey;
  /** $CG mint — the escrowed fee (SEC-M3) is burned from the vault ATA at reveal / refunded at cancel */
  cgMint: PublicKey;
}

export function fuseRevealIx(a: FuseRevealArgs): TransactionInstruction {
  const [config] = configPda();
  const [pending] = pendingFusionPda(a.owner, a.nonce);
  const [resultMeta] = collectionMetaPda(a.resultCollectionIdx);
  const [resultAsset] = assetPda(pending, 0, 0);
  const [resultState] = chipStatePda(resultAsset);
  const [vault] = vaultPda();
  const keys = [
    signer(a.payer),
    ro(config),
    rw(ledgerPdaOf(a.owner)[0]), // #12
    rw(pending),
    ro(a.randomness),
    rw(a.owner),
    rw(resultMeta),
    rw(a.coreCollectionOf(a.resultCollectionIdx)),
    rw(resultAsset),
    rw(resultState),
    ro(MPL_CORE_ID),
    ro(SYSTEM_PROGRAM_ID),
    rw(vault),
    rw(a.cgMint),
    rw(ata(a.cgMint, vault)),
    ro(TOKEN_PROGRAM_ID),
  ];
  for (const m of a.materials) {
    keys.push(rw(m.asset), rw(chipStatePda(m.asset)[0]), rw(collectionMetaPda(m.collectionIdx)[0]), rw(a.coreCollectionOf(m.collectionIdx)));
  }
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys,
    data: Buffer.from(ixData('fuse_reveal', new BorshWriter().u64(a.nonce).toBytes())),
  });
}

export function cancelStaleFusionIx(a: Omit<FuseRevealArgs, 'payer' | 'resultCollectionIdx'>): TransactionInstruction {
  const [config] = configPda();
  const [pending] = pendingFusionPda(a.owner, a.nonce);
  const [vault] = vaultPda();
  const keys = [
    signer(a.owner), ro(config), rw(ledgerPdaOf(a.owner)[0]) /* #12 */, rw(pending), ro(a.randomness), ro(MPL_CORE_ID), ro(SYSTEM_PROGRAM_ID),
    rw(vault), rw(ata(a.cgMint, vault)), rw(ata(a.cgMint, a.owner)), ro(TOKEN_PROGRAM_ID), // SEC-M3 fee refund
  ];
  for (const m of a.materials) {
    keys.push(rw(m.asset), rw(chipStatePda(m.asset)[0]), rw(collectionMetaPda(m.collectionIdx)[0]), rw(a.coreCollectionOf(m.collectionIdx)));
  }
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys,
    data: Buffer.from(ixData('cancel_stale_fusion', new BorshWriter().u64(a.nonce).toBytes())),
  });
}

// ---------------------------------------------------------------- thaw (soulbound / result lock expired)
export function thawChipIx(a: { owner: PublicKey; asset: PublicKey; collectionIdx: number; coreCollection: PublicKey }): TransactionInstruction {
  const [config] = configPda();
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [
      signer(a.owner), ro(config), rw(a.asset), rw(chipStatePda(a.asset)[0]), ro(collectionMetaPda(a.collectionIdx)[0]), rw(a.coreCollection),
      ro(MPL_CORE_ID), ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('thaw_chip')),
  });
}

// ---------------------------------------------------------------- paid services
interface PayServiceArgs {
  buyer: PublicKey;
  kind: number;
  currency: CurrencyCode;
  /** buyer cap for SOL lamports / micro-SKR at frozen FX; 0n otherwise */
  maxUnits: bigint;
  /** keccak(kind ‖ wallet ‖ canonical payload) — binds the payment to e.g. a handle string */
  refHash: Uint8Array;
  treasury: PublicKey;
  priceUpdate?: PublicKey;
  usdcMint: PublicKey;
  cgMint: PublicKey;
  skrMint?: PublicKey;
}

export function payServiceIx(a: PayServiceArgs): TransactionInstruction {
  const [config] = configPda();
  const [ledger] = serviceLedgerPda(a.buyer);
  const [items] = playerItemsPda(a.buyer);
  const payMint = payMintFor(a.currency, a);
  const cg = a.currency === Currency.CG;
  if (a.refHash.length !== 32) throw new Error('refHash must be 32 bytes');
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [
      signer(a.buyer),
      ro(config),
      rw(ledger),
      rw(ledgerPdaOf(a.buyer)[0]), // #12: vault_ledger (burn shard)
      rw(items),
      rw(a.treasury),
      optional(undefined, CHIP_CORE_ID, false), // frozen FX: price_update is always None
      optional(payMint ? ata(payMint, a.buyer) : undefined, CHIP_CORE_ID),
      optional(payMint && !cg ? ata(payMint, a.treasury) : undefined, CHIP_CORE_ID),
      optional(cg ? a.cgMint : undefined, CHIP_CORE_ID),
      ro(TOKEN_PROGRAM_ID),
      ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('pay_service', new BorshWriter().u8(a.kind).u8(a.currency).u64(a.maxUnits).bytes(a.refHash).toBytes())),
  });
}
