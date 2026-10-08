import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  DasClient, DasError, combineDasAssetProof, discoverLeafNonce, foldCompressionProof, normalizeDasAsset, normalizeDasProof,
  v2LeafHash, type DasAssetWithProof,
} from '../src/das.ts';

const key = () => Keypair.generate().publicKey.toBase58();
const assetId = key();
const tree = key();
const owner = key();
const root = key();
const hash = key();
const proof = [key(), key()];

function rawAsset(overrides: Record<string, unknown> = {}) {
  return {
    id: assetId,
    interface: 'V1_NFT',
    ownership: { owner, delegate: null, frozen: false },
    compression: {
      compressed: true,
      tree,
      leaf_id: 1,
      seq: 7,
      data_hash: hash,
      creator_hash: hash,
      collection_hash: hash,
      asset_data_hash: hash,
      flags: 0,
    },
    ...overrides,
  };
}

function rawProof(overrides: Record<string, unknown> = {}) {
  return { root, proof, tree_id: tree, node_index: 5, leaf_id: 1, ...overrides };
}

describe('Bubblegum DAS normalization', () => {
  it('normalizes a V2-compatible compressed asset and proof', () => {
    const value = combineDasAssetProof(rawAsset(), rawProof());
    expect(value.asset.assetId.toBase58()).toBe(assetId);
    expect(value.asset.owner.toBase58()).toBe(owner);
    expect(value.asset.delegate.toBase58()).toBe(owner);
    expect(value.asset.leafId).toBe(1n);
    expect(value.proof.leafIndex).toBe(1n);
    expect(value.proofAccounts).toHaveLength(2);
  });

  it('fails closed when V2 commitments or flags are absent', () => {
    const compression = { ...rawAsset().compression };
    delete (compression as Record<string, unknown>).asset_data_hash;
    expect(() => normalizeDasAsset({ ...rawAsset(), compression })).toThrowError(/asset_data_hash/);
    const noFlags = { ...rawAsset().compression };
    delete (noFlags as Record<string, unknown>).flags;
    expect(() => normalizeDasAsset({ ...rawAsset(), compression: noFlags })).toThrowError(/flags/);
  });

  it('accepts a canopy-truncated proof when DAS supplies the explicit leaf id', () => {
    const value = normalizeDasProof({ root, proof: [], tree_id: tree, node_index: 1_049_000, leaf_id: 1 });
    expect(value.leafIndex).toBe(1n);
  });

  it('fails closed for an uncompressed asset', () => {
    expect(() => normalizeDasAsset({ ...rawAsset(), compression: { compressed: false } })).toThrowError(DasError);
  });

  it('fails closed when asset and proof refer to different trees', () => {
    expect(() => combineDasAssetProof(rawAsset(), rawProof({ tree_id: key() }))).toThrowError(/tree/);
  });

  it('fails closed for a forged leaf index', () => {
    expect(() => normalizeDasProof(rawProof({ leaf_id: 0 }))).toThrowError(/leaf_id/);
  });

  it('fails closed for a proof that is too deep', () => {
    expect(() => normalizeDasProof({ ...rawProof(), proof: Array.from({ length: 31 }, key), node_index: 2 ** 31 + 1 })).toThrowError(/proof length/);
  });
});

describe('local V2 leaf verification (mpl-bubblegum@2.1.1 LeafSchema::V2::to_node)', () => {
  const h = (n: number) => { const b = new Uint8Array(32); for (let i = 0; i < 32; i++) b[i] = (n * 31 + i * 7) & 0xff; return b; };
  const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
  const assetId = new PublicKey('11111111111111111111111111111111');
  const buyer = new PublicKey('HPMr5r9sS5ApWsPNJytZRLbm2jz1veFxTn1wepjAhtho');
  const preimage = { assetId, owner: buyer, delegate: buyer, nonce: 5n, dataHash: h(1), creatorHash: h(2), collectionHash: h(3), assetDataHash: h(4), flags: 0 };

  it('v2LeafHash pins the exact preimage: keccak(0x02 ‖ id ‖ owner ‖ delegate ‖ nonce_le ‖ 4 hashes ‖ flags)', () => {
    expect(hex(v2LeafHash(preimage))).toBe('25f95abfa2123c24fe9a62bd1de5787ee4b210418b56bf1e32f9d57b248dcee9');
    expect(hex(v2LeafHash({ ...preimage, nonce: 6n }))).toBe('66900117e571570342ab4998e3aff5db6e4c1fc74883d0179b96aed2d62651f8');
    expect(() => v2LeafHash({ ...preimage, flags: 256 })).toThrowError(/flags/);
    expect(() => v2LeafHash({ ...preimage, dataHash: h(1).subarray(1) })).toThrowError(/32 bytes/);
  });

  it('foldCompressionProof is index-directed: bit i of the index picks the side at level i', () => {
    const leaf = v2LeafHash(preimage);
    const sibs = [h(11), h(12), h(13)];
    expect(hex(foldCompressionProof(leaf, 5n, sibs))).toBe('52844f837f5cbdd6f6be88b697ff8d1ff5d5ca45e8cfd7bd8f81dd75c6f4e2db');
    expect(hex(foldCompressionProof(leaf, 4n, sibs))).not.toBe('52844f837f5cbdd6f6be88b697ff8d1ff5d5ca45e8cfd7bd8f81dd75c6f4e2db'); // …100 vs …101
  });

  const combinedFor = (nonce: bigint, ownerOverride?: PublicKey, rootOverride?: Uint8Array): DasAssetWithProof => {
    const o = ownerOverride ?? buyer;
    const siblings = [new PublicKey(h(11)), new PublicKey(h(12)), new PublicKey(h(13))];
    const leaf = v2LeafHash({ ...preimage, owner: o, delegate: o, nonce });
    const root = rootOverride ?? foldCompressionProof(leaf, 5n, siblings.map((s) => Uint8Array.from(s.toBytes())));
    return {
      asset: {
        assetId, interface: 'MplBubblegum', owner: o, delegate: o, frozen: false, merkleTree: new PublicKey(h(9)), leafId: 5n,
        sequence: undefined, dataHash: preimage.dataHash, creatorHash: preimage.creatorHash, collectionHash: preimage.collectionHash,
        assetDataHash: preimage.assetDataHash, flags: 0, jsonUri: undefined, raw: {} as never,
      },
      proof: { root, treeId: new PublicKey(h(9)), nodeIndex: 13n, leafIndex: 5n, proof: siblings, raw: {} as never },
      proofAccounts: siblings,
    };
  };

  it('discoverLeafNonce verifies a fresh mint (nonce == leaf_id) and a raced leaf (nonce == leaf_id + transfers)', () => {
    expect(discoverLeafNonce(combinedFor(5n), 3, 8, buyer)).toBe(5n);
    expect(discoverLeafNonce(combinedFor(6n), 3, 8, buyer)).toBe(6n); // buyer moved the leaf once before our register
    expect(discoverLeafNonce(combinedFor(13n), 3, 8, buyer)).toBe(13n); // boundary of the search window
    expect(() => discoverLeafNonce(combinedFor(14n), 3, 8, buyer)).toThrowError(/does not fold/);
  });

  it('fails closed on owner drift and on inconsistent pairs; short (canopied) proofs defer to on-chain verify_leaf', () => {
    expect(() => discoverLeafNonce(combinedFor(5n, Keypair.generate().publicKey), 3, 8, buyer)).toThrowError(/owner\/delegate/);
    expect(() => discoverLeafNonce(combinedFor(5n, undefined, h(21)), 3, 8, buyer)).toThrowError(/does not fold/);
    const short = combinedFor(5n);
    const truncated: DasAssetWithProof = { ...short, proof: { ...short.proof, proof: short.proof.proof.slice(0, 2) } };
    expect(discoverLeafNonce(truncated, 3, 8, buyer)).toBe(5n); // 2 nodes ≠ maxDepth 3: unchecked locally
  });
});

describe('resolveClaimAssetId (mint → register bridge)', () => {
  const buyer = Keypair.generate().publicKey;
  const core = Keypair.generate().publicKey;
  const assetPk = Keypair.generate().publicKey;
  const treePk = Keypair.generate().publicKey;
  const h = (n: number) => { const b = new Uint8Array(32); for (let i = 0; i < 32; i++) b[i] = (n * 13 + i) & 0xff; return new PublicKey(b).toBase58(); };
  const stubFetch = (itemsByPoll: unknown[][]) => {
    const calls: string[] = [];
    let polls = 0;
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      const req = JSON.parse(init.body) as { id: number; method: string; params: Record<string, unknown> };
      calls.push(req.method);
      expect(Array.isArray(req.params)).toBe(false);
      if (req.method === 'getAssetsByOwner') expect(req.params).toEqual({
        ownerAddress: buyer.toBase58(), page: 1, limit: 1000,
        sortBy: { sortBy: 'created', sortDirection: 'desc' },
        displayOptions: { showUnverifiedCollections: true, showCollectionMetadata: false },
      });
      else expect(req.params).toEqual({ id: assetPk.toBase58() });
      if (req.method === 'getAssetsByOwner') {
        const items = itemsByPoll[Math.min(polls, itemsByPoll.length - 1)];
        polls++;
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: req.id, result: { total: items.length, limit: 1000, page: 1, items } }) };
      }
      if (req.method === 'getAsset') {
        return {
          ok: true, json: async () => ({
            result: {
              id: assetPk.toBase58(), interface: 'MplBubblegum', ownership: { owner: buyer.toBase58(), delegate: buyer.toBase58() },
              compression: { compressed: true, tree: treePk.toBase58(), leaf_id: 5, data_hash: h(1), creator_hash: h(2), collection_hash: h(3), asset_data_hash: h(4), flags: 0 },
            },
          }),
        };
      }
      if (req.method === 'getAssetProof') {
        return { ok: true, json: async () => ({ result: { root: h(7), proof: [], tree_id: treePk.toBase58(), node_index: 1_000_005, leaf_id: 5 } }) };
      }
      throw new Error(`unexpected DAS method ${req.method}`);
    }) as unknown as typeof fetch;
    return { fetchImpl, calls, polls: () => polls };
  };
  const hit = { id: assetPk.toBase58(), grouping: [{ group_key: 'collection', group_value: core.toBase58() }], content: { metadata: { name: 'COL2 #9' } }, compression: { compressed: true } };

  it('polls getAssetsByOwner until the indexed name appears, then fetches asset + proof', async () => {
    const other = { ...hit, id: Keypair.generate().publicKey.toBase58(), content: { metadata: { name: 'COL2 #8' } } };
    const uncompressed = { ...hit, id: Keypair.generate().publicKey.toBase58(), compression: { compressed: false } };
    const { fetchImpl, calls, polls } = stubFetch([[], [other, uncompressed], [other, hit]]);
    const sleeps: number[] = [];
    const das = new DasClient({ endpoint: 'http://fake-das', fetchImpl });
    const combined = await das.resolveClaimAssetId(buyer, core, 'COL2 #9', { tries: 5, delayMs: 2500, sleep: async (ms) => { sleeps.push(ms); } });
    expect(combined.asset.assetId.equals(assetPk)).toBe(true);
    expect(combined.proof.leafIndex).toBe(5n);
    expect(polls()).toBe(3);
    expect(sleeps).toEqual([2500, 2500]);
    expect(calls.filter((m) => m === 'getAssetsByOwner').length).toBe(3);
    expect(calls).toContain('getAsset');
    expect(calls).toContain('getAssetProof');
  });

  it('gives up with a transport error after `tries` empty polls (never a phantom asset)', async () => {
    const { fetchImpl, polls } = stubFetch([[]]);
    const das = new DasClient({ endpoint: 'http://fake-das', fetchImpl });
    await expect(das.resolveClaimAssetId(buyer, core, 'COL2 #9', { tries: 3, delayMs: 1, sleep: async () => {} })).rejects.toThrowError(/did not index COL2 #9/);
    expect(polls()).toBe(3);
  });
});
