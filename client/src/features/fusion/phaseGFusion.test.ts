import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { buildBurnV2Ix, BUBBLEGUM_PROGRAM, treeConfigPda } from './phaseGFusion';
import type { BubblegumProof } from '@/chain/bubblegum';

function proof(): BubblegumProof {
  const fill = (n: number) => new Uint8Array(32).fill(n);
  return {
    assetId: Keypair.generate().publicKey,
    leafOwner: Keypair.generate().publicKey,
    leafDelegate: Keypair.generate().publicKey,
    merkleTree: Keypair.generate().publicKey,
    root: fill(1), dataHash: fill(2), creatorHash: fill(3), collectionHash: fill(4), assetDataHash: fill(5),
    flags: 0, leafNonce: 42n, leafIndex: 7n,
    proof: [Keypair.generate().publicKey, Keypair.generate().publicKey],
  } as BubblegumProof;
}

describe('phase-G burn_v2 instruction', () => {
  it('layout: discriminator, LeafProofArgs order, accounts + proof metas', () => {
    const p = proof();
    const payer = Keypair.generate().publicKey;
    const ix = buildBurnV2Ix(p, payer);
    expect(ix.programId.equals(BUBBLEGUM_PROGRAM)).toBe(true);
    // 8 disc + 5*32 hashes + 1 flags + 8 nonce + 4 index
    expect(ix.data.length).toBe(8 + 160 + 1 + 8 + 4);
    expect(ix.data.subarray(8, 40)).toEqual(Buffer.from(p.root));
    expect(ix.data.subarray(8 + 128, 8 + 160)).toEqual(Buffer.from(p.assetDataHash));
    expect(ix.data[8 + 160]).toBe(0);
    expect(ix.data.readBigUInt64LE(8 + 161)).toBe(42n);
    expect(ix.data.readUInt32LE(8 + 169)).toBe(7);
    expect(ix.keys[0].pubkey.equals(treeConfigPda(p.merkleTree))).toBe(true);
    expect(ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[2].pubkey.equals(p.leafOwner)).toBe(true);
    expect(ix.keys[2].isSigner).toBe(true);
    expect(ix.keys[5].pubkey.equals(p.merkleTree)).toBe(true);
    // no collection in the proof -> program-id sentinels at 6/7, mpl_core at 10
    expect(ix.keys[6].pubkey.equals(BUBBLEGUM_PROGRAM)).toBe(true);
    expect(ix.programId.equals(BUBBLEGUM_PROGRAM)).toBe(true);
    expect(ix.keys.length).toBe(12 + p.proof.length);
  });
});
  it('with a Core collection: collection + cpi signer occupy slots 6/7', () => {
    const p = proof();
    const collection = Keypair.generate().publicKey;
    const payer = Keypair.generate().publicKey;
    const ix = buildBurnV2Ix({ ...p, collection }, payer);
    expect(ix.keys[6].pubkey.equals(collection)).toBe(true);
    expect(ix.keys[6].isWritable).toBe(true);
    expect(ix.keys.length).toBe(12 + p.proof.length);
  });
