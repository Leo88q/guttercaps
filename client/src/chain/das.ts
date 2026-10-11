/**
 * Minimal Metaplex DAS client for the browser (web3.js 1.x exposes no DAS
 * methods). Mirrors `backend/src/das.ts` normalization byte-for-byte; the only
 * difference is the output shape — `BubblegumProof` from `./bubblegum` instead
 * of the backend's `DasAssetWithProof`.
 *
 * DAS is an index, not an authority. This module never treats a missing, stale,
 * uncompressed, or malformed response as "not owned"; it throws a typed error
 * so the UI can retry or leave the on-chain state pending.
 */
import { PublicKey } from '@solana/web3.js';
import type { BubblegumProof } from './bubblegum';

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

export interface NormalizedDasAsset {
  assetId: PublicKey;
  owner: PublicKey;
  delegate: PublicKey;
  merkleTree: PublicKey;
  leafId: bigint;
  dataHash: Uint8Array;
  creatorHash: Uint8Array;
  collectionHash: Uint8Array;
  assetDataHash: Uint8Array;
  flags: number;
}

export function normalizeDasAsset(raw: unknown): NormalizedDasAsset {
  if (!raw || typeof raw !== 'object') fail('schema', 'DAS getAsset result must be an object');
  const a = raw as RawDasAsset;
  const c = a.compression;
  if (!c || c.compressed !== true) fail('unsupported', 'asset is not a compressed Bubblegum asset');
  const ownership = a.ownership;
  if (!ownership) fail('schema', 'DAS asset is missing ownership');
  const owner = pk(ownership.owner, 'ownership.owner');
  return {
    assetId: pk(a.id, 'asset.id'),
    owner,
    delegate: ownership.delegate == null ? owner : pk(ownership.delegate, 'ownership.delegate'),
    merkleTree: pk(c.tree, 'compression.tree'),
    leafId: integer(c.leaf_id, 'compression.leaf_id'),
    dataHash: hash32(c.data_hash, 'compression.data_hash'),
    creatorHash: hash32(c.creator_hash, 'compression.creator_hash'),
    collectionHash: requiredHash(c.collection_hash, 'compression.collection_hash'),
    assetDataHash: requiredHash(c.asset_data_hash, 'compression.asset_data_hash'),
    flags: byte(c.flags, 'compression.flags'),
  };
}

export interface NormalizedDasProof {
  root: Uint8Array;
  treeId: PublicKey;
  leafIndex: bigint;
  proof: PublicKey[];
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
  if (nodeIndex < 1n) fail('schema', 'proof.node_index must be positive');
  const base = 1n << BigInt(proof.length);
  const proofLeafIndex = nodeIndex >= base ? nodeIndex - base : undefined;
  const proofAccounts = proof.map((node, i) => pk(node, `proof.proof[${i}]`));
  const leafId = p.leaf_id == null ? undefined : integer(p.leaf_id, 'proof.leaf_id');
  const leafIndex = leafId ?? proofLeafIndex;
  if (leafIndex == null) fail('schema', 'proof.leaf_id is required for a canopy-truncated proof');
  if (leafId != null && proofLeafIndex != null && proof.length > 0 && leafId !== proofLeafIndex) {
    const exactNodeIndex = base + leafId;
    if (nodeIndex < (base << 1n) && nodeIndex !== exactNodeIndex) fail('mismatch', 'proof.leaf_id does not match node_index');
  }
  return { root, treeId, leafIndex, proof: proofAccounts };
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
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
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

  async getAssetWithProof(assetId: PublicKey | string): Promise<BubblegumProof> {
    const id = typeof assetId === 'string' ? pk(assetId, 'assetId') : assetId;
    const [assetRaw, proofRaw] = await Promise.all([
      this.rpc<RawDasAsset>(DAS_GET_ASSET, { id: id.toBase58() }),
      this.rpc<RawDasProof>(DAS_GET_ASSET_PROOF, { id: id.toBase58() }),
    ]);
    const asset = normalizeDasAsset(assetRaw);
    const proof = normalizeDasProof(proofRaw);
    if (!asset.merkleTree.equals(proof.treeId)) fail('mismatch', 'asset tree does not match proof tree');
    if (asset.leafId !== proof.leafIndex) fail('mismatch', 'asset leaf_id does not match proof leaf index');
    if (!asset.assetId.equals(id)) fail('mismatch', 'DAS returned a different asset id than requested');
    return {
      assetId: asset.assetId, leafOwner: asset.owner, leafDelegate: asset.delegate, merkleTree: asset.merkleTree,
      root: proof.root, dataHash: asset.dataHash, creatorHash: asset.creatorHash, collectionHash: asset.collectionHash,
      assetDataHash: asset.assetDataHash, flags: asset.flags, leafNonce: asset.leafId, leafIndex: asset.leafId, proof: proof.proof,
    };
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
   * Resolve the Bubblegum leaf of a freshly minted claim by its unique name
   * (`{symbol} #{game_index}`) and return a `BubblegumProof` for it. `leafNonce`
   * is seeded with the fresh-mint `nonce == leaf_index` invariant — callers
   * must run `discoverLeafNonce` before signing a register transaction.
   * Matching is transport only: `register_compressed_chip` re-verifies
   * collection, owner and the live Merkle proof on chain.
   */
  async resolveClaimAsset(
    owner: PublicKey | string,
    coreCollection: PublicKey,
    expectedName: string,
    opts: { tries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
  ): Promise<BubblegumProof> {
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
