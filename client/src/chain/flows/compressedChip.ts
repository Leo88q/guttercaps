// Resolve one registered Bubblegum V2 leaf into everything the V2 market / staking / arena
// instructions need.
//
// Why this exists: the Core-NFT paths the UI used to call (`list`, `buy`, `stake_chip`,
// `create_battle` …) need a Core asset and its `ChipState`, and neither can exist on a live
// deployment — `open_pack` is fail-closed (`params_version == 0` is unreachable after
// `initialize` writes 1). The V2 instructions take the same economic receipt (`claim` PDA), the
// chip projection (`["compressed_chip", asset]`) and a *fresh* Merkle proof.
//
// Split of responsibilities, deliberately:
//   * identity (claim, merkle tree, leaf index/nonce, hashes) comes from the on-chain
//     `CompressedChipState` — that is the account the programs re-verify against, so it cannot
//     be stale in the way a cached indexer row can;
//   * the Merkle path and root come from DAS, because only the indexer has them;
//   * the delegate comes from DAS too, and is cross-checked against the on-chain flags — a chip
//     that is listed or staked has a program-owned delegate and must not be re-used.
//
// Nothing here signs. A caller that gets a `ResolvedCompressedChip` still has to build the
// instruction, and the program still re-verifies the proof on chain.
import { Connection, PublicKey } from '@solana/web3.js';
import { DasClient } from '../das';
import { decodeCompressedChipState, type BubblegumTreeMeta } from '../accounts';
import { bubblegumTreeMetaPda, compressedChipStatePda } from '../pdas';
import { decodeBubblegumTreeMeta } from '../accounts';
import type { CompressedLeafProof } from '../ix/chipCore';
import type { BubblegumProof } from '../bubblegum';

export interface ResolvedCompressedChip {
  /** the Bubblegum V2 asset id (the leaf) */
  asset: PublicKey;
  /** the economic receipt PDA — stable across a leaf sale, which the asset id is not */
  claim: PublicKey;
  /** `["compressed_chip", asset]` — the chip projection the programs read */
  chip: PublicKey;
  merkleTree: PublicKey;
  treeConfig: PublicKey;
  coreCollection: PublicKey;
  collectionIdx: number;
  /** the live leaf delegate (DAS) — what the V2 instructions are authorized against */
  delegate: PublicKey;
  /** the full DAS proof, for the market instruction, which serializes it into its args */
  proof: BubblegumProof;
  /** the same proof in the leaf-argument shape the staking / arena instructions take */
  leaf: CompressedLeafProof;
}

/** The ChipState flag bits that mean "a program already holds this leaf". */
const F_LISTED = 1 << 1;
const F_STAKED = 1 << 0;
const F_FUSING = 1 << 2;

/**
 * Resolve `asset` (a registered Bubblegum V2 leaf) for a V2 instruction.
 *
 * Throws with a human message when the chip is not a registered V2 leaf, when its tree is not
 * active, or when a program currently holds it (listed / staked).
 *
 * Freshness is NOT checked here: the proof is resolved at call time and the programs re-verify the
 * root on chain, so a proof that went stale between resolving and signing is a failed transaction,
 * not a security hole. What IS checked is that DAS and the on-chain projection agree on the tree
 * and the leaf index — a mismatch there means the chip moved, and building an instruction from
 * either source alone would be wrong.
 */
export async function resolveCompressedChip(
  connection: Connection,
  das: DasClient,
  asset: PublicKey,
  opts: { tree?: BubblegumTreeMeta } = {},
): Promise<ResolvedCompressedChip> {
  const chipKey = compressedChipStatePda(asset)[0];
  const info = await connection.getAccountInfo(chipKey, 'confirmed');
  if (!info) throw new Error('this chip is not registered as a Bubblegum V2 leaf yet — finish its pack settlement first');
  const state = decodeCompressedChipState(new Uint8Array(info.data));

  let tree = opts.tree;
  if (!tree) {
    const meta = await connection.getAccountInfo(bubblegumTreeMetaPda(state.collectionIdx)[0], 'confirmed');
    if (!meta) throw new Error(`collection ${state.collectionIdx} has no Bubblegum tree configured`);
    tree = decodeBubblegumTreeMeta(new Uint8Array(meta.data));
  }
  if (!tree.active) throw new Error(`collection ${state.collectionIdx} has no active Bubblegum tree`);
  if (!tree.merkleTree.equals(state.merkleTree)) throw new Error('the registered tree does not match the collection meta');

  const proof = await das.getAssetWithProof(asset);
  if (!proof.merkleTree.equals(state.merkleTree)) throw new Error('DAS answered with a proof for a different tree');
  if (proof.leafIndex !== BigInt(state.leafIndex)) throw new Error('DAS answered with a different leaf index than the one registered on chain');
  if (state.flags & F_LISTED) throw new Error('this chip is listed — cancel the listing before using it again');
  if (state.flags & F_STAKED) throw new Error('this chip is staked — unstake it before using it again');
  if (state.flags & F_FUSING) throw new Error('this chip is mid-fusion — finish or cancel the fusion before using it');
  // `CompressedChipState::is_free` on chain also demands a clear leaf delegate and no active lock;
  // mirroring it here turns a guaranteed revert into a readable message.
  if (state.leafFlags & 0b11) throw new Error('this chip is still owned by a program delegate — reclaim it first');
  if (state.lockUntil > BigInt(Math.floor(Date.now() / 1000))) throw new Error('this chip is locked — wait for the cooldown to end');

  const leaf: CompressedLeafProof = {
    root: proof.root, dataHash: proof.dataHash, creatorHash: proof.creatorHash,
    collectionHash: proof.collectionHash, assetDataHash: proof.assetDataHash, flags: proof.flags,
    nonce: state.leafNonce, index: state.leafIndex, proofNodes: proof.proof,
  };
  return {
    asset, claim: state.claim, chip: chipKey, merkleTree: state.merkleTree,
    treeConfig: tree.treeConfig, coreCollection: tree.coreCollection, collectionIdx: state.collectionIdx,
    delegate: proof.leafDelegate, proof, leaf,
  };
}

/** Resolve a whole squad, in order. A missing member fails the squad — never a shorter one. */
export async function resolveCompressedSquad(
  connection: Connection,
  das: DasClient,
  assets: PublicKey[],
  opts: { tree?: BubblegumTreeMeta } = {},
): Promise<ResolvedCompressedChip[]> {
  if (assets.length === 0) throw new Error('a squad needs at least one chip');
  const seen = new Set<string>();
  for (const a of assets) {
    const k = a.toBase58();
    if (seen.has(k)) throw new Error('the same chip cannot appear twice in a squad');
    seen.add(k);
  }
  const out: ResolvedCompressedChip[] = [];
  for (const a of assets) out.push(await resolveCompressedChip(connection, das, a, opts));
  return out;
}
