/**
 * Metaplex DAS transport and fail-closed Bubblegum V2 proof normalization.
 *
 * DAS is an index, not an authority. This module never treats a missing, stale,
 * uncompressed, or malformed response as "not owned"; it throws a typed error
 * so callers can retry or leave the on-chain state pending.
 */
import { PublicKey } from '@solana/web3.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { MPL_BUBBLEGUM_V2_ID } from './chain.ts';

export const DAS_GET_ASSET = 'getAsset';
export const DAS_GET_ASSET_PROOF = 'getAssetProof';
export const DAS_GET_ASSETS_BY_OWNER = 'getAssetsByOwner';
export const DAS_MAX_PROOF_DEPTH = 30;

export class DasError extends Error {
  readonly code: 'transport' | 'rpc' | 'schema' | 'unsupported' | 'mismatch';
  constructor(code: DasError['code'], message: string) {
    super(message);
    this.name = 'DasError';
    this.code = code;
  }
}

export interface DasRpcError { code?: number; message?: string; data?: unknown }
export interface DasRpcResponse<T> { jsonrpc?: string; id?: number | string; result?: T; error?: DasRpcError }

export interface RawDasAsset {
  id: string;
  interface?: string;
  ownership?: { owner?: string; delegate?: string | null; frozen?: boolean };
  compression?: {
    compressed?: boolean;
    tree?: string;
    leaf_id?: number | string;
    seq?: number | string | null;
    data_hash?: string;
    creator_hash?: string;
    collection_hash?: string;
    asset_data_hash?: string;
    flags?: number | string;
  };
  grouping?: Array<{ group_key?: string; group_value?: string }>;
  content?: { json_uri?: string; metadata?: Record<string, unknown> };
}

export interface RawDasProof {
  root?: string;
  proof?: string[];
  node_index?: number | string;
  leaf_id?: number | string;
  tree_id?: string;
}

export interface NormalizedDasAsset {
  assetId: PublicKey;
  interface: string | undefined;
  owner: PublicKey;
  delegate: PublicKey;
  frozen: boolean;
  merkleTree: PublicKey;
  leafId: bigint;
  sequence: bigint | undefined;
  dataHash: Uint8Array;
  creatorHash: Uint8Array;
  collectionHash: Uint8Array;
  assetDataHash: Uint8Array;
  /** Bubblegum V2 leaf flags; never inferred from the DAS frozen display field. */
  flags: number;
  jsonUri: string | undefined;
  raw: RawDasAsset;
}

export interface NormalizedDasProof {
  root: Uint8Array;
  treeId: PublicKey;
  nodeIndex: bigint;
  leafIndex: bigint;
  proof: PublicKey[];
  raw: RawDasProof;
}

export interface DasAssetWithProof {
  asset: NormalizedDasAsset;
  proof: NormalizedDasProof;
  /** Remaining accounts for Bubblegum leaf-replacing instructions. */
  proofAccounts: PublicKey[];
}

function fail(code: DasError['code'], message: string): never {
  throw new DasError(code, message);
}

function pk(value: unknown, label: string): PublicKey {
  if (typeof value !== 'string' || value.length === 0) fail('schema', `${label} must be a base58 public key`);
  try { return new PublicKey(value); } catch { fail('schema', `${label} is not a valid public key`); }
}

function hash32(value: unknown, label: string): Uint8Array {
  // PublicKey is deliberately used only as a strict base58/32-byte decoder; hashes
  // are not addresses and are never compared by PublicKey semantics.
  const p = pk(value, label);
  return Uint8Array.from(p.toBytes());
}

function integer(value: unknown, label: string): bigint {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '') fail('schema', `${label} must be an integer`);
  if (typeof value === 'number' && !Number.isSafeInteger(value)) fail('schema', `${label} must be a safe integer when encoded as a number`);
  try {
    const n = BigInt(value);
    if (n < 0n) fail('schema', `${label} must be non-negative`);
    return n;
  } catch { fail('schema', `${label} must be an integer`); }
}

function requiredHash(value: unknown, label: string): Uint8Array {
  if (value == null) fail('schema', `${label} is required for Bubblegum V2 leaf reconstruction`);
  return hash32(value, label);
}

function byte(value: unknown, label: string): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '') fail('schema', `${label} must be an integer byte`);
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n > 255) fail('schema', `${label} must be an integer in 0..255`);
  return n;
}

export function normalizeDasAsset(raw: unknown): NormalizedDasAsset {
  if (!raw || typeof raw !== 'object') fail('schema', 'DAS getAsset result must be an object');
  const a = raw as RawDasAsset;
  const c = a.compression;
  if (!c || c.compressed !== true) fail('unsupported', 'asset is not a compressed Bubblegum asset');
  // DAS currently reports compressed Bubblegum assets as `V1_NFT` as well as
  // provider-specific compressed interfaces. `compression.compressed` is the
  // portable discriminator; V1/V2 tree compatibility is proven by the on-chain
  // Bubblegum CPI and the configured collection/tree, not by this display field.
  const ownership = a.ownership;
  if (!ownership) fail('schema', 'DAS asset is missing ownership');
  const owner = pk(ownership.owner, 'ownership.owner');
  const delegate = ownership.delegate == null ? owner : pk(ownership.delegate, 'ownership.delegate');
  const assetId = pk(a.id, 'asset.id');
  const merkleTree = pk(c.tree, 'compression.tree');
  const leafId = integer(c.leaf_id, 'compression.leaf_id');
  const dataHash = hash32(c.data_hash, 'compression.data_hash');
  const creatorHash = hash32(c.creator_hash, 'compression.creator_hash');
  const collectionHash = requiredHash(c.collection_hash, 'compression.collection_hash');
  const assetDataHash = requiredHash(c.asset_data_hash, 'compression.asset_data_hash');
  const flags = byte(c.flags, 'compression.flags');
  return {
    assetId,
    interface: a.interface,
    owner,
    delegate,
    frozen: ownership.frozen === true,
    merkleTree,
    leafId,
    sequence: c.seq == null ? undefined : integer(c.seq, 'compression.seq'),
    dataHash,
    creatorHash,
    collectionHash,
    assetDataHash,
    flags,
    jsonUri: typeof a.content?.json_uri === 'string' ? a.content.json_uri : undefined,
    raw: a,
  };
}

export function normalizeDasProof(raw: unknown): NormalizedDasProof {
  if (!raw || typeof raw !== 'object') fail('schema', 'DAS getAssetProof result must be an object');
  const p = raw as RawDasProof;
  const proof = p.proof;
  // A fully-canopied tree legitimately returns no remote proof nodes. The
  // compression program fills the path from the canopy; zero is therefore a
  // valid proof length, not an absent proof.
  if (!Array.isArray(proof) || proof.length > DAS_MAX_PROOF_DEPTH) {
    fail('schema', `DAS proof length must be 0..${DAS_MAX_PROOF_DEPTH}`);
  }
  const treeId = pk(p.tree_id, 'proof.tree_id');
  const root = hash32(p.root, 'proof.root');
  const nodeIndex = integer(p.node_index, 'proof.node_index');
  // Bubblegum DAS documents leaf index as node_index - 2^max_depth, where the
  // proof path gives max_depth. Do this with bigint so a malformed large number
  // cannot pass through a JS safe-integer conversion.
  if (nodeIndex < 1n) fail('schema', 'proof.node_index must be positive');
  const base = 1n << BigInt(proof.length);
  const proofLeafIndex = nodeIndex >= base ? nodeIndex - base : undefined;
  const proofAccounts = proof.map((node, i) => pk(node, `proof.proof[${i}]`));
  const leafId = p.leaf_id == null ? undefined : integer(p.leaf_id, 'proof.leaf_id');
  // Providers retain the full node index when canopy nodes are omitted. Prefer
  // their explicit leaf_id in that case; the old node_index - 2^proof.length
  // derivation is only valid for a complete remote path.
  const leafIndex = leafId ?? proofLeafIndex;
  if (leafIndex == null) fail('schema', 'proof.leaf_id is required for a canopy-truncated proof');
  if (leafId != null && proofLeafIndex != null && proof.length > 0 && leafId !== proofLeafIndex) {
    // A provider may use full-depth node_index with a truncated proof, so only
    // reject this mismatch when node_index has the exact proof-depth base.
    const exactNodeIndex = base + leafId;
    if (nodeIndex < (base << 1n) && nodeIndex !== exactNodeIndex) fail('mismatch', 'proof.leaf_id does not match node_index');
  }
  return { root, treeId, nodeIndex, leafIndex, proof: proofAccounts, raw: p };
}

export function combineDasAssetProof(assetRaw: unknown, proofRaw: unknown): DasAssetWithProof {
  const asset = normalizeDasAsset(assetRaw);
  const proof = normalizeDasProof(proofRaw);
  if (!asset.merkleTree.equals(proof.treeId)) fail('mismatch', 'asset tree does not match proof tree');
  if (asset.leafId !== proof.leafIndex) fail('mismatch', 'asset leaf_id does not match proof leaf index');
  return { asset, proof, proofAccounts: proof.proof };
}

// ------------------------------------------------------------------ local V2 leaf verification
/**
 * Bubblegum V2 leaf hash, byte-for-byte `mpl-bubblegum@2.1.1`
 * `LeafSchema::V2::to_node` (`programs/bubblegum/program/src/state/leaf_schema.rs`):
 * `keccak(0x02 ‖ id ‖ owner ‖ delegate ‖ nonce_le ‖ data_hash ‖ creator_hash ‖
 * collection_hash ‖ asset_data_hash ‖ flags)`.
 *
 * A freshly minted V2 leaf carries `nonce == leaf_index`: Bubblegum's `mint_v2`
 * (`processor/mint.rs`) sets both from `tree_authority.num_minted`. DAS never
 * returns the nonce, so the crank/register path uses this invariant — and the
 * on-chain `verify_leaf` CPI stays the authority boundary: a wrong nonce (a
 * leaf that moved after the mint) fails closed there, never mis-registers.
 */
export interface V2LeafPreimage {
  assetId: PublicKey; owner: PublicKey; delegate: PublicKey; nonce: bigint;
  dataHash: Uint8Array; creatorHash: Uint8Array; collectionHash: Uint8Array; assetDataHash: Uint8Array; flags: number;
}
export function v2LeafHash(l: V2LeafPreimage): Uint8Array {
  for (const [h, n] of [[l.dataHash, 'dataHash'], [l.creatorHash, 'creatorHash'], [l.collectionHash, 'collectionHash'], [l.assetDataHash, 'assetDataHash']] as const) {
    if (h.length !== 32) throw new DasError('schema', `V2 leaf ${n} must be 32 bytes`);
  }
  if (!Number.isInteger(l.flags) || l.flags < 0 || l.flags > 255) throw new DasError('schema', 'V2 leaf flags must be a byte');
  if (l.nonce < 0n || l.nonce > 0xffff_ffff_ffff_ffffn) throw new DasError('schema', 'V2 leaf nonce must fit u64');
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
  if (leaf.length !== 32) throw new DasError('schema', 'leaf must be 32 bytes');
  let node = leaf, idx = index;
  for (const sib of nodes) {
    if (sib.length !== 32) throw new DasError('schema', 'proof node must be 32 bytes');
    const buf = new Uint8Array(64);
    if (idx & 1n) { buf.set(sib, 0); buf.set(node, 32); } else { buf.set(node, 0); buf.set(sib, 32); }
    node = keccak_256(buf);
    idx >>= 1n;
  }
  return node;
}

const bytesEq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Preflight a DAS pair before it goes into a register transaction: rebuild the
 * V2 leaf with the fresh-mint `nonce == leaf_index` invariant and fold the
 * full path. Returns the verified nonce (= leaf index as u64).
 *
 * Only full-length proofs (`proof.length == maxDepth`, read from our own
 * `BubblegumTreeMeta`) are checkable: a canopied tree omits cached nodes from
 * the DAS response and recomputation needs them. Short proofs skip the local
 * check — the on-chain `verify_leaf` still authenticates them.
 *
 * A mismatch here means DAS served an internally inconsistent pair (typically
 * the leaf moved between the `getAsset` and `getAssetProof` calls): the caller
 * must re-fetch, not send.
 */
export function verifyDasProofLocal(combined: DasAssetWithProof, maxDepth: number, expectedOwner?: PublicKey): bigint {
  return discoverLeafNonce(combined, maxDepth, 0, expectedOwner);
}

/**
 * Find the live V2 leaf nonce by local verification. Normally 0 transfers have
 * happened and this is just `leaf_index`; if the buyer raced the crank and
 * moved the leaf between our mint and register transactions, Bubblegum
 * incremented the nonce and the fresh-mint assumption would fail closed
 * on chain. Trying the next few nonces keeps that race recoverable (the buyer
 * can also move the leaf back — owner/delegate must equal the buyer either
 * way, enforced here AND by `register_compressed_chip`).
 */
export function discoverLeafNonce(combined: DasAssetWithProof, maxDepth: number, maxTransfers = 8, expectedOwner?: PublicKey): bigint {
  const { asset, proof } = combined;
  if (expectedOwner && (!asset.owner.equals(expectedOwner) || !asset.delegate.equals(expectedOwner))) {
    throw new DasError('mismatch', 'DAS leaf owner/delegate is not the expected buyer (leaf moved?)');
  }
  if (asset.leafId > 0xffff_ffffn || proof.leafIndex > 0xffff_ffffn) throw new DasError('schema', 'leaf index must fit u32');
  if (proof.proof.length !== maxDepth) return asset.leafId; // canopied path: on-chain verify_leaf is the check
  const nodes = proof.proof.map((p) => Uint8Array.from(p.toBytes()));
  for (let t = 0n; t <= BigInt(Math.max(0, maxTransfers)); t++) {
    const nonce = asset.leafId + t;
    if (nonce > 0xffff_ffff_ffff_ffffn) break;
    const leaf = v2LeafHash({
      assetId: asset.assetId, owner: asset.owner, delegate: asset.delegate, nonce,
      dataHash: asset.dataHash, creatorHash: asset.creatorHash, collectionHash: asset.collectionHash,
      assetDataHash: asset.assetDataHash, flags: asset.flags,
    });
    if (bytesEq(foldCompressionProof(leaf, asset.leafId, nodes), proof.root)) return nonce;
  }
  throw new DasError('mismatch', 'DAS proof does not fold to the DAS root for the V2 leaf (stale/inconsistent pair — refetch)');
}

export interface RawDasOwnerPage {
  total?: number | string;
  limit?: number | string;
  page?: number | string;
  items?: unknown[];
}

/** Lightweight owner-enumeration row: enough to MATCH an asset, never to register it. */
export interface DasAssetSummary {
  assetId: PublicKey;
  collection: PublicKey | undefined;
  name: string | undefined;
  compressed: boolean;
}

export function normalizeDasAssetSummary(raw: unknown): DasAssetSummary {
  if (!raw || typeof raw !== 'object') fail('schema', 'DAS asset item must be an object');
  const a = raw as RawDasAsset;
  const assetId = pk(a.id, 'asset.id');
  const grouping = Array.isArray(a.grouping) ? a.grouping : [];
  const col = grouping.find((g) => g?.group_key === 'collection')?.group_value;
  let collection: PublicKey | undefined;
  if (typeof col === 'string' && col.length > 0) {
    try { collection = new PublicKey(col); } catch { collection = undefined; }
  }
  const content = a.content as { metadata?: { name?: unknown } } | undefined;
  const name = typeof content?.metadata?.name === 'string' ? content.metadata.name : undefined;
  return { assetId, collection, name, compressed: a.compression?.compressed === true };
}

export interface DasClientOptions {
  endpoint: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class DasClient {
  readonly endpoint: string;
  readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private nextId = 1;

  constructor(options: DasClientOptions) {
    if (!options.endpoint) throw new DasError('transport', 'DAS endpoint is empty');
    this.endpoint = options.endpoint;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new DasError('transport', `DAS ${method} request failed: ${(e as Error).message}`);
    }
    if (!response.ok) throw new DasError('transport', `DAS ${method} returned HTTP ${response.status}`);
    let body: DasRpcResponse<T>;
    try { body = await response.json() as DasRpcResponse<T>; } catch { throw new DasError('rpc', `DAS ${method} returned invalid JSON`); }
    if (body.error) throw new DasError('rpc', `DAS ${method} RPC error ${body.error.code ?? ''}: ${body.error.message ?? 'unknown error'}`.trim());
    if (body.result === undefined) throw new DasError('rpc', `DAS ${method} response has no result`);
    return body.result;
  }

  async getAsset(assetId: PublicKey | string): Promise<NormalizedDasAsset> {
    const id = typeof assetId === 'string' ? pk(assetId, 'assetId') : assetId;
    const asset = normalizeDasAsset(await this.rpc<RawDasAsset>(DAS_GET_ASSET, { id: id.toBase58() }));
    if (!asset.assetId.equals(id)) throw new DasError('mismatch', 'DAS returned a different asset id than requested');
    return asset;
  }

  async getAssetProof(assetId: PublicKey | string): Promise<NormalizedDasProof> {
    const id = typeof assetId === 'string' ? pk(assetId, 'assetId') : assetId;
    return normalizeDasProof(await this.rpc<RawDasProof>(DAS_GET_ASSET_PROOF, { id: id.toBase58() }));
  }

  async getAssetWithProof(assetId: PublicKey | string): Promise<DasAssetWithProof> {
    const id = typeof assetId === 'string' ? pk(assetId, 'assetId') : assetId;
    const [assetRaw, proof] = await Promise.all([
      this.rpc<RawDasAsset>(DAS_GET_ASSET, { id: id.toBase58() }),
      this.rpc<RawDasProof>(DAS_GET_ASSET_PROOF, { id: id.toBase58() }),
    ]);
    const combined = combineDasAssetProof(assetRaw, proof);
    if (!combined.asset.assetId.equals(id)) throw new DasError('mismatch', 'DAS returned a different asset id than requested');
    return combined;
  }

  async getAssetsByOwner(owner: PublicKey | string, page = 1, limit = 1000): Promise<{ total: number; items: DasAssetSummary[] }> {
    const id = typeof owner === 'string' ? pk(owner, 'owner') : owner;
    const res = await this.rpc<RawDasOwnerPage>(DAS_GET_ASSETS_BY_OWNER, {
      ownerAddress: id.toBase58(), sortBy: { sortBy: 'created', sortDirection: 'desc' }, limit, page,
      displayOptions: { showUnverifiedCollections: true, showCollectionMetadata: false },
    });
    const items = Array.isArray(res.items) ? res.items.map(normalizeDasAssetSummary) : [];
    return { total: Number(res.total ?? items.length), items };
  }

  /**
   * Resolve the Bubblegum asset id of a freshly minted claim. `mint_compressed_chip` does not
   * know the leaf index (Bubblegum assigns it inside the CPI), so the crank matches the leaf by
   * its unique name (`{symbol} #{game_index}` — game_index is a per-collection monotonic counter,
   * so the (collection, name) pair is unambiguous) and then fetches the full proof for it.
   * Matching is transport only: `register_compressed_chip` re-verifies collection, owner and the
   * live Merkle proof on chain, so a wrong match fails closed instead of mis-registering.
   */
  async resolveClaimAssetId(
    owner: PublicKey | string,
    coreCollection: PublicKey,
    expectedName: string,
    opts: { tries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
  ): Promise<DasAssetWithProof> {
    const tries = opts.tries ?? 12;
    const delayMs = opts.delayMs ?? 2500;
    const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    let lastTotal = 0;
    for (let attempt = 0; attempt < tries; attempt++) {
      if (attempt > 0) await sleep(delayMs);
      const page = await this.getAssetsByOwner(owner);
      lastTotal = page.total;
      const hit = page.items.find((a) => a.compressed && a.name === expectedName && a.collection?.equals(coreCollection));
      if (hit) return this.getAssetWithProof(hit.assetId);
    }
    throw new DasError('transport', `DAS did not index ${expectedName} for this owner within ${(tries * delayMs) / 1000}s (owner holds ${lastTotal} assets)`);
  }
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
 * Reconstruct a `DasAssetWithProof` directly from the on-chain `ConcurrentMerkleTree`
 * account and the deterministic `MetadataArgsV2` minted by `mint_compressed_chip`.
 */
export function resolveClaimFromTreeAccount(input: OnChainClaimTreeInput): DasAssetWithProof {
  const enc = new TextEncoder();
  const nameBytes = enc.encode(`${input.symbol} #${input.gameIndex.toString()}`);
  const symBytes = enc.encode(input.symbol);
  const uri = `https://cdn.guttercaps.gg/m/${input.collectionIdx}/${input.rarity}.json`;
  const uriBytes = enc.encode(uri);
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
    mdv.setUint16(pos, 250, true); pos += 2;
    metaBuf[pos++] = 0;
    metaBuf[pos++] = 0;
    metaBuf[pos++] = 1; metaBuf[pos++] = 0;
    mdv.setUint32(pos, 1, true); pos += 4;
    metaBuf.set(input.collectionMeta.toBytes(), pos); pos += 32;
    metaBuf[pos++] = 1;
    metaBuf[pos++] = 100;
    if (withCollection) {
      metaBuf[pos++] = 1;
      metaBuf.set(input.coreCollection.toBytes(), pos);
    } else {
      metaBuf[pos++] = 0;
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
    throw new DasError('schema', 'Invalid ConcurrentMerkleTree account layout');
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
    throw new DasError('transport', 'Minted Bubblegum V2 leaf not found in on-chain ConcurrentMerkleTree changelog');
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
    throw new DasError('mismatch', 'On-chain ConcurrentMerkleTree proof did not fold to active root');
  }

  const proofPubkeys = proofNodes.map((n) => new PublicKey(n));
  const leafIdxBig = BigInt(matched.leafIndex);
  return {
    asset: {
      assetId: matched.assetId,
      interface: 'V2_NFT',
      owner: input.buyer,
      delegate: input.buyer,
      frozen: false,
      merkleTree: input.merkleTree,
      leafId: leafIdxBig,
      sequence: undefined,
      dataHash: matched.dataHash,
      creatorHash,
      collectionHash: matched.collectionHash,
      assetDataHash,
      flags,
      jsonUri: uri,
      raw: { id: matched.assetId.toBase58() },
    },
    proof: {
      root: activeRoot,
      treeId: input.merkleTree,
      nodeIndex: leafIdxBig + (1n << BigInt(maxDepth)),
      leafIndex: leafIdxBig,
      proof: proofPubkeys,
      raw: {},
    },
    proofAccounts: proofPubkeys,
  };
}
