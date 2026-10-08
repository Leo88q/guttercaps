import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { deriveBubblegumLeafAssetId, foldCompressionProof, resolveRegisteredLeafFromTreeAccount, v2LeafHash } from './bubblegum';

// Independently materialize every tree level after appends AND replacements. ChangeLog.path
// contains the changed branch, whereas rightmost_proof contains siblings. Both are real CMT layout.
function fixture(depth = 4, capacity = 8, canopyDepth = 0) {
  const merkleTree = Keypair.generate().publicKey, owner = Keypair.generate().publicKey;
  const input = (index: number, change = 0) => ({ assetId: deriveBubblegumLeafAssetId(merkleTree, index), owner,
    delegate: owner, merkleTree, leafIndex: index, leafNonce: BigInt(index), dataHash: new Uint8Array(32).fill(index + change + 1),
    creatorHash: new Uint8Array(32).fill(2), collectionHash: new Uint8Array(32).fill(3), assetDataHash: new Uint8Array(32).fill(4), flags: 0 });
  const leaves: Uint8Array[] = Array.from({ length: 2 ** depth }, () => new Uint8Array(32));
  const identities = new Map<number, ReturnType<typeof input>>();
  let next = 0, sequence = 0;
  const logs: { root: Uint8Array; path: Uint8Array[]; index: number }[] = [];
  function levels() {
    const rows = [leaves.slice()];
    for (let level = 0; level < depth; level++) {
      const children = rows[level];
      rows.push(Array.from({ length: children.length / 2 }, (_, i) => keccak_256(Uint8Array.from([...children[i * 2], ...children[i * 2 + 1]]))));
    }
    return rows;
  }
  function write(index: number, change = 0) {
    const id = input(index, change); identities.set(index, id);
    leaves[index] = v2LeafHash({ ...id, nonce: id.leafNonce }); next = Math.max(next, index + 1);
    const rows = levels();
    logs[sequence++ % capacity] = { root: rows[depth][0], path: rows.slice(0, depth).map((row, level) => row[index >>> level]), index };
  }
  function snapshot() {
    const stride = 40 + 32 * depth, rm = 56 + 24 + capacity * stride, end = rm + 32 * depth + 40;
    const data = new Uint8Array(end + (2 ** (canopyDepth + 1) - 2) * 32), dv = new DataView(data.buffer);
    data[0] = 1;
    dv.setUint32(2, capacity, true); dv.setUint32(6, depth, true);
    dv.setBigUint64(56, BigInt(sequence), true); dv.setBigUint64(64, BigInt((sequence - 1) % capacity), true); dv.setBigUint64(72, BigInt(Math.min(sequence, capacity)), true);
    logs.forEach((log, i) => {
      const base = 80 + i * stride;
      data.set(log.root, base); log.path.forEach((node, level) => data.set(node, base + 32 + level * 32));
      dv.setUint32(base + 32 + depth * 32, log.index, true);
    });
    const rows = levels();
    for (let level = 0; level < depth; level++) data.set(rows[level][((next - 1) >>> level) ^ 1], rm + level * 32);
    data.set(leaves[next - 1], rm + depth * 32); dv.setUint32(rm + (depth + 1) * 32, next, true);
    let offset = end;
    for (let level = depth - 1; level >= depth - canopyDepth; level--) for (const node of rows[level]) { data.set(node, offset); offset += 32; }
    return data;
  }
  return { write, snapshot, identities, levels, resolve(index: number) {
    return resolveRegisteredLeafFromTreeAccount({ ...identities.get(index)!, treeAccountData: snapshot() });
  } };
}

describe('registered leaf proof from a consistent CMT snapshot', () => {
  it('handles appends and a replacement after right siblings already exist (the reported arena failure)', () => {
    const tree = fixture();
    for (let i = 0; i < 5; i++) tree.write(i);
    tree.write(0, 90);
    for (let i = 0; i < 5; i++) {
      const proof = tree.resolve(i);
      expect(foldCompressionProof(v2LeafHash({ ...tree.identities.get(i)!, nonce: BigInt(i) }), BigInt(i), proof.proof.map(p => p.toBytes()))).toEqual(proof.root);
      expect(proof.root).toEqual(tree.levels()[4][0]);
    }
  });
  it('can reconstruct an old target from newer sibling subtrees after the changelog wraps', () => {
    const tree = fixture(4, 4);
    for (let i = 0; i < 16; i++) tree.write(i);
    for (const i of [1, 2, 4, 8]) tree.write(i, 70);
    expect(tree.resolve(0).root).toEqual(tree.levels()[4][0]);
  });
  it('uses canopy siblings when those subtrees have aged out of the changelog', () => {
    const tree = fixture(4, 2, 3);
    for (let i = 0; i < 16; i++) tree.write(i);
    tree.write(1, 30); tree.write(0, 40);
    expect(tree.resolve(0).root).toEqual(tree.levels()[4][0]);
  });
  it('fails closed when history is insufficient, rather than inventing an empty subtree', () => {
    const tree = fixture(4, 2);
    for (let i = 0; i < 16; i++) tree.write(i);
    expect(() => tree.resolve(0)).toThrow(/DAS-enabled RPC/);
  });
  it('rejects stale identity / owner data and malformed layouts', () => {
    const tree = fixture(); tree.write(0); tree.write(1);
    const input = { ...tree.identities.get(0)!, owner: Keypair.generate().publicKey, treeAccountData: tree.snapshot() };
    expect(() => resolveRegisteredLeafFromTreeAccount(input)).toThrow(/did not fold/);
    expect(() => resolveRegisteredLeafFromTreeAccount({ ...input, treeAccountData: new Uint8Array(2) })).toThrow(/layout/);
  });
});
