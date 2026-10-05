// A registered Bubblegum V2 leaf, forged into LiteSVM.
//
// Why this exists: `list_compressed_asset` / `cancel_compressed_asset` / `buy_compressed_asset` are
// the production market, and until this helper they had ZERO on-chain coverage — every scenario in
// 30-market.spec.ts drives the *claim* market instead. The obvious reason is that LiteSVM cannot
// serve a DAS read. The real reason is deeper: the only creator of a `CompressedChipState` is
// `register_compressed_chip`, which CPIs into Account Compression to verify the Merkle path, and
// neither `spl-account-compression` nor `mpl-bubblegum` is loaded into the harness (see
// `programBinaries()` in env.ts — five project programs plus a Metaplex Core dump, nothing else).
//
// So the leaf is written straight into SVM state with `setAccount`, the same mechanism the retired
// 31-market-core.spec.ts used for the Core asset it could not mint either. What that buys, honestly:
//   * the market handlers' own bodies — guards, PDA derivation, the chip_core CPI, the event, the
//     listing account — run for real against real-shaped state;
//   * `register_compressed_chip` stays allow-listed in the coverage matrix with its reason, because
//     reaching the state is still its job and this helper does not pretend otherwise.
//
// What it does NOT buy: any assertion about the Bubblegum `TransferV2` leg of `buy_compressed_asset`,
// which is a real CPI into a program the harness does not have. That boundary is asserted too — the
// transaction must get past every guard and every lamport transfer and fail only at the CPI — but it
// is a boundary, not a settlement test.
import { createHash } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { accountDiscriminator } from '@/chain/anchor';
import { BorshWriter } from '@/chain/borsh';
import { decodeBubblegumTreeMeta, decodeCollectionMeta } from '@/chain/accounts';
import type { BubblegumProof } from '@/chain/bubblegum';
import { CHIP_CORE_ID, MPL_ACCOUNT_COMPRESSION_ID, MPL_BUBBLEGUM_V2_ID } from '@/chain/ids';
import { bubblegumTreeMetaPda, collectionMetaPda, compressedChipStatePda, compressedMintClaimPda } from '@/chain/pdas';
import type { Chain } from './chain';

const u64le = (v: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v >>> 0)); return b; };

/** `leaf_asset_id` in chip_core/src/bubblegum.rs — PDA(["asset", tree, (index as u64)_le], BUBBLEGUM_V2). */
export const leafAssetId = (merkleTree: PublicKey, index: number): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from('asset'), merkleTree.toBytes(), u64le(index)], MPL_BUBBLEGUM_V2_ID)[0];

/**
 * Monotonic leaf index handed out by `forgeLeaf`.
 *
 * The first version of this helper hardcoded index 3, and that is a trap worth writing down: the
 * asset id is `PDA(["asset", tree, index])`, so with a fixed tree every forged leaf in a file lands
 * on the SAME asset — and therefore on the same `["compressed_asset_listing", asset]` PDA. The first
 * successful `list_compressed_asset` in a spec then poisons every later scenario: the second one
 * fails with `Allocate: account ... already in use` (system error 0), which reads as "the guard did
 * not fire" and sends you hunting for a handler bug that does not exist. Eight of the ten failures
 * the first CI run reported were exactly that.
 *
 * The bound is read from the live `BubblegumTreeMeta` rather than assumed: `maxDepth` 5 means the
 * index must stay below 32, and a spec that forges more leaves than a tree can hold is a bug in the
 * spec, not something to paper over.
 */
let nextLeafIndex = 1;

/**
 * `mpl_bubblegum::hash::hash_collection_option(Some(collection))` — `keccak256(pubkey)`, per the
 * Bubblegum V2 leaf schema (Metaplex, "Hashing NFT Data": the `None` case substitutes a default
 * collection key, the `Some` case hashes the key alone).
 *
 * Written out here rather than imported because the vendored crate is not reachable from the TS
 * side, and the localnet suite needs the exact bytes the program will compare against. The market
 * spec proves the formula by using it in a positive case: a wrong formula fails with
 * `CompressedClaimNotTradable` at the collection-hash check, which is a different error from the
 * CPI failure a correct formula produces.
 */
export const collectionHash = (coreCollection: PublicKey): Uint8Array => keccak_256(coreCollection.toBytes());

/** Deterministic 32-byte fill so two leaves never collide by accident. */
const h = (seed: string) => new Uint8Array(createHash('sha256').update(seed).digest());

export interface ForgedLeaf {
  /** the Bubblegum asset id — a real PDA under the Bubblegum program, as the program derives it */
  asset: PublicKey;
  /** `["compressed_chip", asset]` — the projection the market and arena read */
  chip: PublicKey;
  /** `["compressed_claim", buyer, nonce]` — the economic receipt */
  claim: PublicKey;
  claimNonce: bigint;
  owner: PublicKey;
  merkleTree: PublicKey;
  treeConfig: PublicKey;
  coreCollection: PublicKey;
  collectionIdx: number;
  leafIndex: number;
  /** a `BubblegumProof` shaped exactly as the V2 builders serialize it — DAS's half, forged */
  proof: BubblegumProof;
  /** the claim's live `listed` flag, so a test can assert it moved */
  listed: () => Promise<boolean>;
}

export interface ForgeLeafOptions {
  /** who owns the leaf and the claim — defaults to the seller the caller passes in */
  owner?: PublicKey;
  collectionIdx?: number;
  /** overrides for the guard scenarios */
  claim?: { minted?: boolean; registered?: boolean; consumed?: boolean; listed?: boolean; staked?: boolean; lockUntil?: bigint };
  chip?: { flags?: number; lockUntil?: bigint; leafIndex?: number; asset?: PublicKey; assetField?: PublicKey; merkleTree?: PublicKey };
  /** proof hashes that do NOT match the chip state — for the mismatch guards */
  badProof?: boolean;
}

/**
 * Byte offset of `listed` inside `CompressedMintClaim`, counted from the start of the account data
 * (8-byte Anchor discriminator included). Field order is the decoder in `@/chain/accounts`:
 * disc ‖ buyer ‖ collection_idx ‖ rarity ‖ level ‖ game_index ‖ expires_at ‖ settlement ‖
 * index_reserved ‖ minted ‖ registered ‖ consumed ‖ **listed** ‖ bump ‖ staked ‖ origin ‖ lock_until.
 */
const CLAIM_LISTED_OFFSET = 8 + 32 + 1 + 1 + 1 + 8 + 8 + 32 + 1 + 1 + 1 + 1;

/**
 * Write a registered leaf into SVM state. The tree meta and the collection meta are read live (the
 * env already configured one per collection), so the leaf is bound to the same tree and Core
 * collection the deployment would use.
 */
export async function forgeLeaf(
  chain: Chain,
  seller: PublicKey,
  claimNonce: bigint,
  o: ForgeLeafOptions = {},
): Promise<ForgedLeaf> {
  const owner = o.owner ?? seller;
  const collectionIdx = o.collectionIdx ?? 0;
  const meta = decodeBubblegumTreeMeta(new Uint8Array((await chain.getAccount(bubblegumTreeMetaPda(collectionIdx)[0]))!.data));
  const coreCollection = decodeCollectionMeta(new Uint8Array((await chain.getAccount(collectionMetaPda(collectionIdx)[0]))!.data)).coreCollection;
  const merkleTree = o.chip?.merkleTree ?? meta.merkleTree;
  // A distinct index per leaf, so no two forged leaves share an asset id — see the note above.
  const leafIndex = o.chip?.leafIndex ?? nextLeafIndex;
  nextLeafIndex = Math.max(nextLeafIndex, leafIndex) + 1;
  const maxLeaves = 2 ** meta.maxDepth;
  if (leafIndex >= maxLeaves) {
    throw new Error(`forgeLeaf: leafIndex ${leafIndex} is outside the tree (maxDepth ${meta.maxDepth} holds ${maxLeaves} leaves)`);
  }
  const asset = o.chip?.asset ?? leafAssetId(merkleTree, leafIndex);
  const claim = compressedMintClaimPda(owner, claimNonce)[0];
  const [chip, chipBump] = compressedChipStatePda(asset);

  // The four hashes are the ones the program re-verifies against the chip state. `badProof` derives
  // them from a different seed so every mismatch guard has a realistic (non-zero) input.
  const seed = (label: string) => (o.badProof ? h(`bad/${label}/${claimNonce}`) : h(`${label}/${claimNonce}`));
  const proof: BubblegumProof = {
    assetId: asset, leafOwner: owner, leafDelegate: owner, merkleTree,
    root: h(`root/${claimNonce}`), dataHash: seed('data'), creatorHash: seed('creator'),
    collectionHash: collectionHash(coreCollection), assetDataHash: seed('assetData'),
    flags: 0, leafNonce: BigInt(leafIndex), leafIndex: BigInt(leafIndex),
    proof: [Keypair.generate().publicKey, Keypair.generate().publicKey],
  };

  // The leaf id, the tree and the tree config all have to EXIST, because `buy_compressed_asset`
  // names them as writable and a missing writable account is a transaction-level rejection in some
  // SVM builds. They are owned by the programs that own them on a live deployment.
  await chain.setAccount(asset, { owner: MPL_BUBBLEGUM_V2_ID, data: new Uint8Array(0), lamports: 1_000_000n });
  await chain.setAccount(merkleTree, { owner: MPL_ACCOUNT_COMPRESSION_ID, data: new Uint8Array(0), lamports: 1_000_000n });
  await chain.setAccount(meta.treeConfig, { owner: MPL_BUBBLEGUM_V2_ID, data: new Uint8Array(0), lamports: 1_000_000n });

  const c = new BorshWriter();
  c.bytes(accountDiscriminator('CompressedChipState'));
  // `asset` is the *field*; `assetField` lets a test forge a projection bound to a different asset
  // than the PDA it is stored at, which is what guard 5 of the list handler rejects.
  c.pubkey(o.chip?.assetField ?? asset).pubkey(claim).u8(collectionIdx).pubkey(merkleTree).u32(leafIndex).u64(proof.leafNonce);
  c.bytes(proof.dataHash).bytes(proof.creatorHash).bytes(proof.collectionHash).bytes(proof.assetDataHash);
  // `bump = chip.bump` is an Anchor seeds constraint, so the forged state must carry the REAL bump —
  // a hand-written 255 fails ConstraintSeeds before the handler ever runs.
  c.u8(proof.flags).u8(0).u8(2).u64(claimNonce).u8(o.chip?.flags ?? 0).i64(o.chip?.lockUntil ?? 0n).i64(1n).u8(chipBump);
  await chain.setAccount(chip, { owner: CHIP_CORE_ID, data: c.toBytes(), lamports: 1_000_000n });

  const m = new BorshWriter();
  m.bytes(accountDiscriminator('CompressedMintClaim'));
  m.pubkey(owner).u8(collectionIdx).u8(0).u8(2).u64(claimNonce).i64(0n).pubkey(PublicKey.default);
  m.bool(true).bool(o.claim?.minted ?? true).bool(o.claim?.registered ?? true).bool(o.claim?.consumed ?? false)
    .bool(o.claim?.listed ?? false).u8(255).bool(o.claim?.staked ?? false).pubkey(owner).i64(o.claim?.lockUntil ?? 0n);
  await chain.setAccount(claim, { owner: CHIP_CORE_ID, data: m.toBytes(), lamports: 1_000_000n });

  return {
    asset, chip, claim, claimNonce, owner, merkleTree, treeConfig: meta.treeConfig, coreCollection,
    collectionIdx, leafIndex, proof,
    listed: async () => {
      const a = await chain.getAccount(claim);
      return a ? a.data[CLAIM_LISTED_OFFSET] === 1 : false;
    },
  };
}
