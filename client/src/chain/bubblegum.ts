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
import { MPL_BUBBLEGUM_V2_ID } from './ids';

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

function assertHash32(value: Uint8Array, label: string): void {
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

export interface OnChainClaimTreeInput {
  buyer: PublicKey;
  merkleTree: PublicKey;
  collectionMeta: PublicKey;
  coreCollection: PublicKey;
  symbol: string;
  collectionIdx: number;
  rarity: number;
  gameIndex: bigint;
  treeAccountData: Uint8Array;
}

const CMT_HEADER_SIZE = 56;
const ROYALTY_BPS_LE = Uint8Array.of(250, 0);

function emptyTreeNode(level: number): Uint8Array {
  let node: Uint8Array = new Uint8Array(32);
  for (let i = 0; i < level; i++) {
    const pair = new Uint8Array(64);
    pair.set(node, 0);
    pair.set(node, 32);
    node = keccak_256(pair);
  }
  return node;
}

export function deriveBubblegumLeafAssetId(merkleTree: PublicKey, leafIndex: number): PublicKey {
  const idx = new Uint8Array(8);
  new DataView(idx.buffer).setBigUint64(0, BigInt(leafIndex >>> 0), true);
  return PublicKey.findProgramAddressSync([new TextEncoder().encode('asset'), merkleTree.toBytes(), idx], MPL_BUBBLEGUM_V2_ID)[0];
}

/**
 * Reconstruct a `BubblegumProof` directly from the on-chain `ConcurrentMerkleTree`
 * account and the deterministic `MetadataArgsV2` minted by `mint_compressed_chip`.
 * Used as an immediate fallback when the RPC endpoint does not expose Metaplex
 * DAS (`getAssetsByOwner` / `getAssetProof`, e.g. `https://api.devnet.solana.com`)
 * or when DAS has not indexed the newly minted leaf yet.
 */
export function resolveClaimFromTreeAccount(input: OnChainClaimTreeInput): BubblegumProof {
  const enc = new TextEncoder();
  const nameBytes = enc.encode(`${input.symbol} #${input.gameIndex.toString()}`);
  const symBytes = enc.encode(input.symbol);
  const uriBytes = enc.encode(`https://cdn.guttercaps.gg/m/${input.collectionIdx}/${input.rarity}.json`);
  const buildHashes = (withCollection: boolean) => {
    const metaLen = 4 + nameBytes.length + 4 + symBytes.length + 4 + uriBytes.length + 2 + 1 + 1 + 2 + 4 + 34 + 1 + (withCollection ? 32 : 0);
    const metaBuf = new Uint8Array(metaLen);
    const mdv = new DataView(metaBuf.buffer);
    let pos = 0;
    for (const s of [nameBytes, symBytes, uriBytes]) {
      mdv.setUint32(pos, s.length, true);
      pos += 4;
      metaBuf.set(s, pos);
      pos += s.length;
    }
    mdv.setUint16(pos, 250, true); pos += 2; // seller_fee_basis_points = ROYALTY_BPS (250)
    metaBuf[pos++] = 0; // primary_sale_happened = false
    metaBuf[pos++] = 0; // is_mutable = false
    metaBuf[pos++] = 1; metaBuf[pos++] = 0; // Some(TokenStandard::NonFungible)
    mdv.setUint32(pos, 1, true); pos += 4; // creators.len() = 1
    metaBuf.set(input.collectionMeta.toBytes(), pos); pos += 32;
    metaBuf[pos++] = 1; // verified = true
    metaBuf[pos++] = 100; // share = 100
    if (withCollection) {
      metaBuf[pos++] = 1; // collection = Some(...)
      metaBuf.set(input.coreCollection.toBytes(), pos);
    } else {
      metaBuf[pos++] = 0; // collection = None
    }
    const metaHash = keccak_256(metaBuf);
    const dataPre = new Uint8Array(34);
    dataPre.set(metaHash, 0);
    dataPre.set(ROYALTY_BPS_LE, 32);
    return {
      dataHash: keccak_256(dataPre),
      collectionHash: keccak_256(withCollection ? input.coreCollection.toBytes() : new Uint8Array(32)),
    };
  };
  const candidates = [buildHashes(true), buildHashes(false)];
  const creatorPre = new Uint8Array(34);
  creatorPre.set(input.collectionMeta.toBytes(), 0);
  creatorPre[32] = 1;
  creatorPre[33] = 100;
  const creatorHash = keccak_256(creatorPre);
  const assetDataHash = keccak_256(new Uint8Array(0));
  const flags = 0;

  const data = input.treeAccountData;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const maxBufferSize = dv.getUint32(2, true);
  const maxDepth = dv.getUint32(6, true);
  const clStride = 40 + 32 * maxDepth;
  const minBytes = CMT_HEADER_SIZE + 24 + maxBufferSize * clStride + 32 * maxDepth + 40;
  if (maxDepth === 0 || maxDepth > 30 || maxBufferSize === 0 || data.byteLength < minBytes) {
    throw new Error('Invalid ConcurrentMerkleTree account layout');
  }
  const activeIndex = Number(dv.getBigUint64(CMT_HEADER_SIZE + 8, true));
  const bufferSize = Math.min(maxBufferSize, Number(dv.getBigUint64(CMT_HEADER_SIZE + 16, true)));
  const changeLogs = Array.from({ length: maxBufferSize }, (_, k) => {
    const base = CMT_HEADER_SIZE + 24 + k * clStride;
    const root = data.slice(base, base + 32);
    const path = Array.from({ length: maxDepth }, (__, i) => data.slice(base + 32 + i * 32, base + 64 + i * 32));
    const index = dv.getUint32(base + 32 + 32 * maxDepth, true);
    return { root, path, index };
  });
  const rmBase = CMT_HEADER_SIZE + 24 + maxBufferSize * clStride;
  const rightmostProof = Array.from({ length: maxDepth }, (_, i) => data.slice(rmBase + i * 32, rmBase + (i + 1) * 32));
  const rightmostIndex = dv.getUint32(rmBase + 32 * (maxDepth + 1), true);

  const empty0 = emptyTreeNode(0);
  const findLog = (targetIdx: number) => {
    for (let s = 0; s < bufferSize; s++) {
      const k = (activeIndex - s + maxBufferSize) % maxBufferSize;
      if (changeLogs[k].index === targetIdx && !bytesEq(changeLogs[k].path[0], empty0)) {
        return { step: s, cl: changeLogs[k] };
      }
    }
    return null;
  };

  let matched: { step: number; leafIndex: number; assetId: PublicKey; leaf: Uint8Array; dataHash: Uint8Array; collectionHash: Uint8Array } | null = null;
  for (let s = 0; s < bufferSize && !matched; s++) {
    const k = (activeIndex - s + maxBufferSize) % maxBufferSize;
    const cl = changeLogs[k];
    if (bytesEq(cl.path[0], empty0)) continue;
    const leafIndex = cl.index;
    const assetId = deriveBubblegumLeafAssetId(input.merkleTree, leafIndex);
    for (const cand of candidates) {
      const leaf = v2LeafHash({
        assetId,
        owner: input.buyer,
        delegate: input.buyer,
        nonce: BigInt(leafIndex),
        dataHash: cand.dataHash,
        creatorHash,
        collectionHash: cand.collectionHash,
        assetDataHash,
        flags,
      });
      if (bytesEq(cl.path[0], leaf)) {
        matched = { step: s, leafIndex, assetId, leaf, dataHash: cand.dataHash, collectionHash: cand.collectionHash };
        break;
      }
    }
  }
  if (!matched) {
    throw new Error('Minted Bubblegum V2 leaf not found in on-chain ConcurrentMerkleTree changelog');
  }

  let proofNodes: Uint8Array[];
  if (matched.leafIndex === rightmostIndex - 1) {
    proofNodes = rightmostProof.slice();
  } else {
    proofNodes = [];
    for (let i = 0; i < maxDepth; i++) {
      if (((matched.leafIndex >>> i) & 1) === 0) {
        proofNodes.push(emptyTreeNode(i));
      } else {
        const leftLast = ((matched.leafIndex >>> i) << i) - 1;
        const leftHit = findLog(leftLast);
        proofNodes.push(leftHit ? leftHit.cl.path[i] : rightmostProof[i]);
      }
    }
    for (let s = matched.step - 1; s >= 0; s--) {
      const cl = changeLogs[(activeIndex - s + maxBufferSize) % maxBufferSize];
      if (cl.index !== matched.leafIndex) {
        const xor = (matched.leafIndex ^ cl.index) << (32 - maxDepth);
        const common = Math.clz32(xor);
        const crit = maxDepth - 1 - common;
        if (crit >= 0 && crit < maxDepth) proofNodes[crit] = cl.path[crit];
      }
    }
  }

  const activeRoot = changeLogs[activeIndex].root;
  if (!bytesEq(foldCompressionProof(matched.leaf, BigInt(matched.leafIndex), proofNodes), activeRoot)) {
    throw new Error('On-chain ConcurrentMerkleTree proof did not fold to active root');
  }

  return {
    assetId: matched.assetId,
    leafOwner: input.buyer,
    leafDelegate: input.buyer,
    merkleTree: input.merkleTree,
    root: activeRoot,
    dataHash: matched.dataHash,
    creatorHash,
    collectionHash: matched.collectionHash,
    assetDataHash,
    flags,
    leafNonce: BigInt(matched.leafIndex),
    leafIndex: BigInt(matched.leafIndex),
    proof: proofNodes.map((n) => new PublicKey(n)),
  };
}

/**
 * Reconstruct a `BubblegumProof` for an ALREADY-REGISTERED `CompressedChipState` directly from the
 * on-chain `ConcurrentMerkleTree` account when the RPC does not support Metaplex DAS (`getAsset` / `getAssetProof`).
 */
export function resolveRegisteredLeafFromTreeAccount(input: {
  assetId: PublicKey;
  owner: PublicKey;
  delegate?: PublicKey;
  merkleTree: PublicKey;
  leafIndex: number;
  leafNonce: bigint;
  dataHash: Uint8Array;
  creatorHash: Uint8Array;
  collectionHash: Uint8Array;
  assetDataHash: Uint8Array;
  flags: number;
  treeAccountData: Uint8Array;
}): BubblegumProof {
  const delegate = input.delegate ?? input.owner;
  const data = input.treeAccountData;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const maxBufferSize = dv.getUint32(2, true);
  const maxDepth = dv.getUint32(6, true);
  const clStride = 40 + 32 * maxDepth;
  const minBytes = CMT_HEADER_SIZE + 24 + maxBufferSize * clStride + 32 * maxDepth + 40;
  if (maxDepth === 0 || maxDepth > 30 || maxBufferSize === 0 || data.byteLength < minBytes) {
    throw new Error('Invalid ConcurrentMerkleTree account layout');
  }
  const activeIndex = Number(dv.getBigUint64(CMT_HEADER_SIZE + 8, true));
  const bufferSize = Math.min(maxBufferSize, Number(dv.getBigUint64(CMT_HEADER_SIZE + 16, true)));
  const changeLogs = Array.from({ length: maxBufferSize }, (_, k) => {
    const base = CMT_HEADER_SIZE + 24 + k * clStride;
    const root = data.slice(base, base + 32);
    const path = Array.from({ length: maxDepth }, (__, i) => data.slice(base + 32 + i * 32, base + 64 + i * 32));
    const index = dv.getUint32(base + 32 + 32 * maxDepth, true);
    return { root, path, index };
  });
  const rmBase = CMT_HEADER_SIZE + 24 + maxBufferSize * clStride;
  const rightmostProof = Array.from({ length: maxDepth }, (_, i) => data.slice(rmBase + i * 32, rmBase + (i + 1) * 32));
  const rightmostIndex = dv.getUint32(rmBase + 32 * (maxDepth + 1), true);

  const empty0 = emptyTreeNode(0);
  const findLog = (targetIdx: number) => {
    for (let s = 0; s < bufferSize; s++) {
      const k = (activeIndex - s + maxBufferSize) % maxBufferSize;
      if (changeLogs[k].index === targetIdx && !bytesEq(changeLogs[k].path[0], empty0)) {
        return { step: s, cl: changeLogs[k] };
      }
    }
    return null;
  };

  const leaf = v2LeafHash({
    assetId: input.assetId,
    owner: input.owner,
    delegate,
    nonce: input.leafNonce,
    dataHash: input.dataHash,
    creatorHash: input.creatorHash,
    collectionHash: input.collectionHash,
    assetDataHash: input.assetDataHash,
    flags: input.flags,
  });

  const hit = findLog(input.leafIndex);
  let proofNodes: Uint8Array[];
  if (input.leafIndex === rightmostIndex - 1) {
    proofNodes = rightmostProof.slice();
  } else if (hit) {
    proofNodes = [];
    for (let i = 0; i < maxDepth; i++) {
      if (((input.leafIndex >>> i) & 1) === 0) {
        proofNodes.push(emptyTreeNode(i));
      } else {
        const leftLast = ((input.leafIndex >>> i) << i) - 1;
        const leftHit = findLog(leftLast);
        proofNodes.push(leftHit ? leftHit.cl.path[i] : rightmostProof[i]);
      }
    }
    for (let s = hit.step - 1; s >= 0; s--) {
      const cl = changeLogs[(activeIndex - s + maxBufferSize) % maxBufferSize];
      if (cl.index !== input.leafIndex) {
        const xor = (input.leafIndex ^ cl.index) << (32 - maxDepth);
        const common = Math.clz32(xor);
        const crit = maxDepth - 1 - common;
        if (crit >= 0 && crit < maxDepth) proofNodes[crit] = cl.path[crit];
      }
    }
  } else {
    throw new Error('Registered Bubblegum V2 leaf not found in on-chain ConcurrentMerkleTree changelog');
  }

  const activeRoot = changeLogs[activeIndex].root;
  if (!bytesEq(foldCompressionProof(leaf, BigInt(input.leafIndex), proofNodes), activeRoot)) {
    throw new Error('On-chain ConcurrentMerkleTree proof did not fold to active root');
  }

  return {
    assetId: input.assetId,
    leafOwner: input.owner,
    leafDelegate: delegate,
    merkleTree: input.merkleTree,
    root: activeRoot,
    dataHash: input.dataHash,
    creatorHash: input.creatorHash,
    collectionHash: input.collectionHash,
    assetDataHash: input.assetDataHash,
    flags: input.flags,
    leafNonce: input.leafNonce,
    leafIndex: BigInt(input.leafIndex),
    proof: proofNodes.map((n) => new PublicKey(n)),
  };
}
