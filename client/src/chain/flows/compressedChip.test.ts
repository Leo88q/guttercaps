import { describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { accountDiscriminator as disc } from '@/chain/anchor';
import { BorshWriter } from '@/chain/borsh';
import { bubblegumTreeMetaPda, compressedChipStatePda } from '@/chain/pdas';
import { resolveCompressedChip, resolveCompressedSquad } from './compressedChip';

/** A real `CompressedChipState` buffer, byte for byte what chip_core stores. */
function chipStateBytes(a: {
  asset: PublicKey; claim: PublicKey; collectionIdx: number; merkleTree: PublicKey;
  leafIndex: number; leafNonce: bigint; flags: number; leafFlags?: number; lockUntil?: bigint; rarity?: number; level?: number;
}): Uint8Array {
  const w = new BorshWriter();
  w.pubkey(a.asset).pubkey(a.claim).u8(a.collectionIdx).pubkey(a.merkleTree).u32(a.leafIndex).u64(a.leafNonce);
  for (let i = 0; i < 4; i++) w.bytes(new Uint8Array(32).fill(i + 1));
  w.u8(a.leafFlags ?? 0).u8(a.rarity ?? 3).u8(a.level ?? 2).u64(77n).u8(a.flags).i64(a.lockUntil ?? 0n).i64(1n).u8(255);
  const body = w.toBytes();
  const out = new Uint8Array(8 + body.length);
  out.set(Buffer.from(disc('CompressedChipState')), 0);
  out.set(body, 8);
  return out;
}

/** A real `BubblegumTreeMeta` buffer. */
function treeMetaBytes(a: { collectionIdx: number; coreCollection: PublicKey; merkleTree: PublicKey; treeConfig: PublicKey; active: boolean }): Uint8Array {
  const w = new BorshWriter();
  w.u8(a.collectionIdx).pubkey(a.coreCollection).pubkey(a.merkleTree).pubkey(a.treeConfig).pubkey(PublicKey.default).u8(14).u8(8).bool(a.active).u8(254);
  const body = w.toBytes();
  const out = new Uint8Array(8 + body.length);
  out.set(Buffer.from(disc('BubblegumTreeMeta')), 0);
  out.set(body, 8);
  return out;
}

function dasProof(asset: PublicKey, merkleTree: PublicKey, leafIndex: bigint) {
  return {
    assetId: asset, leafOwner: PublicKey.default, leafDelegate: PublicKey.default, merkleTree,
    root: new Uint8Array(32).fill(9), dataHash: new Uint8Array(32).fill(1), creatorHash: new Uint8Array(32).fill(2),
    collectionHash: new Uint8Array(32).fill(3), assetDataHash: new Uint8Array(32).fill(4), flags: 0,
    leafNonce: leafIndex, leafIndex, proof: [Keypair.generate().publicKey, Keypair.generate().publicKey],
  };
}

function env(over: { flags?: number; leafFlags?: number; lockUntil?: bigint; active?: boolean; leafIndex?: bigint; dasLeafIndex?: bigint; dasTree?: PublicKey; asset?: PublicKey; merkleTree?: PublicKey; treeConfig?: PublicKey; coreCollection?: PublicKey } = {}) {
  const asset = over.asset ?? Keypair.generate().publicKey;
  const claim = Keypair.generate().publicKey;
  const merkleTree = over.merkleTree ?? Keypair.generate().publicKey;
  const coreCollection = over.coreCollection ?? Keypair.generate().publicKey;
  const treeConfig = over.treeConfig ?? Keypair.generate().publicKey;
  const leafIndex = over.leafIndex ?? 41n;
  const accounts = new Map<string, Uint8Array>([
    [compressedChipStatePda(asset)[0].toBase58(), chipStateBytes({ asset, claim, collectionIdx: 2, merkleTree, leafIndex: Number(leafIndex), leafNonce: leafIndex, flags: over.flags ?? 0, leafFlags: over.leafFlags ?? 0, lockUntil: over.lockUntil ?? 0n })],
    [bubblegumTreeMetaPda(2)[0].toBase58(), treeMetaBytes({ collectionIdx: 2, coreCollection, merkleTree, treeConfig, active: over.active ?? true })],
  ]);
  const connection = { getAccountInfo: vi.fn(async (k: PublicKey) => (accounts.has(k.toBase58()) ? { data: accounts.get(k.toBase58()) } : null)) };
  const das = { getAssetWithProof: vi.fn(async () => dasProof(asset, over.dasTree ?? merkleTree, over.dasLeafIndex ?? leafIndex)) };
  return { asset, claim, merkleTree, coreCollection, treeConfig, leafIndex, connection: connection as never, das: das as never };
}

describe('resolveCompressedChip', () => {
  it('joins the on-chain projection with a fresh DAS proof and keeps the on-chain leaf identity', async () => {
    const e = env();
    const r = await resolveCompressedChip(e.connection, e.das, e.asset);
    expect(r.asset.equals(e.asset)).toBe(true);
    expect(r.claim.equals(e.claim)).toBe(true);
    expect(r.chip.equals(compressedChipStatePda(e.asset)[0])).toBe(true);
    expect(r.merkleTree.equals(e.merkleTree)).toBe(true);
    expect(r.treeConfig.equals(e.treeConfig)).toBe(true);
    expect(r.coreCollection.equals(e.coreCollection)).toBe(true);
    expect(r.collectionIdx).toBe(2);
    // the leaf nonce/index come from chain, NOT from DAS: they are what the program re-verifies
    expect(r.leaf.nonce).toBe(e.leafIndex);
    expect(r.leaf.index).toBe(Number(e.leafIndex));
    expect(r.leaf.proofNodes).toHaveLength(2);
    // the market instruction serializes the DAS proof verbatim, so it is handed back untouched
    expect(r.proof.leafIndex).toBe(e.leafIndex);
    expect(r.proof.proof).toHaveLength(2);
  });

  it('refuses a chip that is not a registered V2 leaf, with a message that says what to do', async () => {
    const e = env();
    const connection = { getAccountInfo: vi.fn(async () => null) };
    await expect(resolveCompressedChip(connection as never, e.das, e.asset)).rejects.toThrow(/not registered/);
  });

  it('refuses a chip whose collection has no active tree', async () => {
    const e = env({ active: false });
    await expect(resolveCompressedChip(e.connection, e.das, e.asset)).rejects.toThrow(/no active Bubblegum tree/);
  });

  it('refuses when DAS answers for a different tree — a moved leaf must not be signed for', async () => {
    const e = env({ dasTree: Keypair.generate().publicKey });
    await expect(resolveCompressedChip(e.connection, e.das, e.asset)).rejects.toThrow(/different tree/);
  });

  it('refuses when DAS answers with a different leaf index than the one registered on chain', async () => {
    const e = env({ dasLeafIndex: 999n });
    await expect(resolveCompressedChip(e.connection, e.das, e.asset)).rejects.toThrow(/different leaf index/);
  });

  it('refuses a listed chip and a staked chip — a program already holds the leaf', async () => {
    const listed = env({ flags: 1 << 1 });
    await expect(resolveCompressedChip(listed.connection, listed.das, listed.asset)).rejects.toThrow(/listed/);
    const staked = env({ flags: 1 << 0 });
    await expect(resolveCompressedChip(staked.connection, staked.das, staked.asset)).rejects.toThrow(/staked/);
  });

  it('refuses a chip that a program delegate still owns, exactly as `is_free` does on chain', async () => {
    const e = env({ leafFlags: 0b01 });
    await expect(resolveCompressedChip(e.connection, e.das, e.asset)).rejects.toThrow(/program delegate/);
  });

  it('refuses a chip still inside its lock window, so a fusion cooldown cannot be skipped', async () => {
    const e = env({ lockUntil: BigInt(Math.floor(Date.now() / 1000)) + 3600n });
    await expect(resolveCompressedChip(e.connection, e.das, e.asset)).rejects.toThrow(/locked/);
  });

  it('accepts a chip whose lock has already expired', async () => {
    const e = env({ lockUntil: BigInt(Math.floor(Date.now() / 1000)) - 60n });
    await expect(resolveCompressedChip(e.connection, e.das, e.asset)).resolves.toMatchObject({ asset: e.asset });
  });

  it('refuses a mid-fusion chip', async () => {
    const e = env({ flags: 1 << 2 });
    await expect(resolveCompressedChip(e.connection, e.das, e.asset)).rejects.toThrow(/mid-fusion/);
  });

  it('takes a pre-fetched tree meta instead of reading it again', async () => {
    const e = env();
    const spy = vi.spyOn(e.connection as unknown as { getAccountInfo: () => void }, 'getAccountInfo');
    await resolveCompressedChip(e.connection, e.das, e.asset, { tree: { collectionIdx: 2, coreCollection: e.coreCollection, merkleTree: e.merkleTree, treeConfig: e.treeConfig, treeAuthority: PublicKey.default, maxDepth: 14, canopy: 8, active: true, bump: 254 } });
    expect(spy).toHaveBeenCalledTimes(1); // only the chip state, never the tree meta
  });
});

describe('resolveCompressedSquad', () => {
  it('resolves every member in order', async () => {
    const a = env();
    // one collection, one tree — which is what a real deployment has
    const b = env({ asset: Keypair.generate().publicKey, merkleTree: a.merkleTree, treeConfig: a.treeConfig, coreCollection: a.coreCollection });
    const accounts = new Map<string, Uint8Array>([
      [bubblegumTreeMetaPda(2)[0].toBase58(), treeMetaBytes({ collectionIdx: 2, coreCollection: a.coreCollection, merkleTree: a.merkleTree, treeConfig: a.treeConfig, active: true })],
    ]);
    for (const e of [a, b]) accounts.set(compressedChipStatePda(e.asset)[0].toBase58(), chipStateBytes({ asset: e.asset, claim: e.claim, collectionIdx: 2, merkleTree: a.merkleTree, leafIndex: 7, leafNonce: 7n, flags: 0 }));
    const connection = { getAccountInfo: async (k: PublicKey) => (accounts.has(k.toBase58()) ? { data: accounts.get(k.toBase58()) } : null) };
    const das = { getAssetWithProof: async (k: PublicKey) => dasProof(k, a.merkleTree, 7n) };
    const squad = await resolveCompressedSquad(connection as never, das as never, [a.asset, b.asset]);
    expect(squad.map((s) => s.asset.toBase58())).toEqual([a.asset.toBase58(), b.asset.toBase58()]);
    expect(squad.every((s) => s.leaf.index === 7)).toBe(true);
  });

  it('refuses the same chip twice — the arena would reject it as a duplicate anyway', async () => {
    const a = env();
    await expect(resolveCompressedSquad(a.connection, a.das, [a.asset, a.asset])).rejects.toThrow(/twice/);
  });

  it('refuses an empty squad rather than sending a short one', async () => {
    await expect(resolveCompressedSquad({} as never, {} as never, [])).rejects.toThrow(/at least one chip/);
  });
});
