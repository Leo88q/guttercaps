/**
 * Bubblegum V2 proof transport shared by UI transaction builders.
 *
 * The backend owns DAS fetching and returns the same normalized fields. This
 * module intentionally does not decode display JSON and does not infer owner
 * from an asset id; callers must provide a fresh proof for every leaf write.
 *
 * The local V2 preflight below (`v2LeafHash` / `discoverLeafNonce`) mirrors
 * `backend/src/das.ts` byte-for-byte: it lets the UI verify a DAS pair before
 * the user signs a register transaction instead of failing closed on chain.
 */
import { PublicKey, type AccountMeta } from '@solana/web3.js';
import { keccak_256 } from '@noble/hashes/sha3';

export interface BubblegumProof {
  assetId: PublicKey;
  leafOwner: PublicKey;
  leafDelegate: PublicKey;
  merkleTree: PublicKey;
  root: Uint8Array;
  dataHash: Uint8Array;
  creatorHash: Uint8Array;
  collectionHash: Uint8Array;
  assetDataHash: Uint8Array;
  /** Exact Bubblegum V2 flags byte; never inferred from UI frozen state. */
  flags: number;
  leafNonce: bigint;
  leafIndex: bigint;
  proof: PublicKey[];
}

/** Remaining proof node metas. Bubblegum's fixed accounts are added by each ix builder. */
export function bubblegumProofMetas(proof: BubblegumProof, writable = false): AccountMeta[] {
  return proof.proof.map((pubkey) => ({ pubkey, isSigner: false, isWritable: writable }));
}

export function assertHash32(value: Uint8Array, label: string): void {
  if (value.byteLength !== 32) throw new Error(`${label} must be exactly 32 bytes`);
}

export function assertFreshProof(proof: BubblegumProof): void {
  assertHash32(proof.root, 'Bubblegum root');
  assertHash32(proof.dataHash, 'Bubblegum data hash');
  assertHash32(proof.creatorHash, 'Bubblegum creator hash');
  assertHash32(proof.collectionHash, 'Bubblegum collection hash');
  assertHash32(proof.assetDataHash, 'Bubblegum asset data hash');
  if (!Number.isInteger(proof.flags) || proof.flags < 0 || proof.flags > 255) throw new Error('Bubblegum flags must be a byte');
  if (proof.leafIndex < 0n || proof.leafNonce < 0n) throw new Error('Bubblegum leaf coordinates must be non-negative');
}

// ------------------------------------------------------------------ local V2 leaf verification
/**
 * Bubblegum V2 leaf hash, byte-for-byte `mpl-bubblegum@2.1.1`
 * `LeafSchema::V2::to_node`: `keccak(0x02 ‖ id ‖ owner ‖ delegate ‖ nonce_le ‖
 * data_hash ‖ creator_hash ‖ collection_hash ‖ asset_data_hash ‖ flags)`.
 *
 * A freshly minted V2 leaf carries `nonce == leaf_index` (`mint_v2` sets both
 * from `tree_authority.num_minted`). DAS never returns the nonce, so this
 * invariant seeds local verification — the on-chain `verify_leaf` CPI stays
 * the authority boundary.
 */
export interface V2LeafPreimage {
  assetId: PublicKey; owner: PublicKey; delegate: PublicKey; nonce: bigint;
  dataHash: Uint8Array; creatorHash: Uint8Array; collectionHash: Uint8Array; assetDataHash: Uint8Array; flags: number;
}
export function v2LeafHash(l: V2LeafPreimage): Uint8Array {
  for (const [h, n] of [[l.dataHash, 'dataHash'], [l.creatorHash, 'creatorHash'], [l.collectionHash, 'collectionHash'], [l.assetDataHash, 'assetDataHash']] as const) {
    if (h.length !== 32) throw new Error(`V2 leaf ${n} must be 32 bytes`);
  }
  if (!Number.isInteger(l.flags) || l.flags < 0 || l.flags > 255) throw new Error('V2 leaf flags must be a byte');
  if (l.nonce < 0n || l.nonce > 0xffff_ffff_ffff_ffffn) throw new Error('V2 leaf nonce must fit u64');
  const buf = new Uint8Array(1 + 32 * 3 + 8 + 32 * 4 + 1);
  const dv = new DataView(buf.buffer);
  buf[0] = 2;
  buf.set(l.assetId.toBytes(), 1);
  buf.set(l.owner.toBytes(), 33);
  buf.set(l.delegate.toBytes(), 65);
  dv.setBigUint64(97, l.nonce, true);
  buf.set(l.dataHash, 105);
  buf.set(l.creatorHash, 137);
  buf.set(l.collectionHash, 169);
  buf.set(l.assetDataHash, 201);
  buf[233] = l.flags;
  return keccak_256(buf);
}

/** Index-directed concurrent-Merkle-tree fold (`hash_to_parent`): bit i of the index picks the side. */
export function foldCompressionProof(leaf: Uint8Array, index: bigint, nodes: readonly Uint8Array[]): Uint8Array {
  if (leaf.length !== 32) throw new Error('leaf must be 32 bytes');
  let node = leaf, idx = index;
  for (const sib of nodes) {
    if (sib.length !== 32) throw new Error('proof node must be 32 bytes');
    const buf = new Uint8Array(64);
    if (idx & 1n) { buf.set(sib, 0); buf.set(node, 32); } else { buf.set(node, 0); buf.set(sib, 32); }
    node = keccak_256(buf);
    idx >>= 1n;
  }
  return node;
}

const bytesEq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Find the live V2 leaf nonce by local verification over a `BubblegumProof`.
 * Normally 0 transfers have happened and this is just `leafIndex`; the search
 * window keeps a raced leaf recoverable. Only full-length proofs
 * (`proof.length == maxDepth`, from our own `BubblegumTreeMeta`) are checkable;
 * short (canopied) proofs return `leafIndex` unchecked — on-chain `verify_leaf`
 * still authenticates them. Throws on owner drift or an inconsistent pair.
 */
export function discoverLeafNonce(proof: BubblegumProof, maxDepth: number, maxTransfers = 8, expectedOwner?: PublicKey): bigint {
  if (expectedOwner && (!proof.leafOwner.equals(expectedOwner) || !proof.leafDelegate.equals(expectedOwner))) {
    throw new Error('Bubblegum leaf owner/delegate is not the expected buyer (leaf moved?)');
  }
  if (proof.leafIndex > 0xffff_ffffn) throw new Error('leaf index must fit u32');
  if (proof.proof.length !== maxDepth) return proof.leafIndex; // canopied path: on-chain verify_leaf is the check
  const nodes = proof.proof.map((p) => Uint8Array.from(p.toBytes()));
  for (let t = 0n; t <= BigInt(Math.max(0, maxTransfers)); t++) {
    const nonce = proof.leafIndex + t;
    if (nonce > 0xffff_ffff_ffff_ffffn) break;
    const leaf = v2LeafHash({
      assetId: proof.assetId, owner: proof.leafOwner, delegate: proof.leafDelegate, nonce,
      dataHash: proof.dataHash, creatorHash: proof.creatorHash, collectionHash: proof.collectionHash,
      assetDataHash: proof.assetDataHash, flags: proof.flags,
    });
    if (bytesEq(foldCompressionProof(leaf, proof.leafIndex, nodes), proof.root)) return nonce;
  }
  throw new Error('Bubblegum proof does not fold to the DAS root for the V2 leaf (stale/inconsistent pair — refetch)');
}

/** Fresh-mint-only preflight: `discoverLeafNonce` with a zero search window. */
export function verifyBubblegumProofLocal(proof: BubblegumProof, maxDepth: number, expectedOwner?: PublicKey): bigint {
  return discoverLeafNonce(proof, maxDepth, 0, expectedOwner);
}
