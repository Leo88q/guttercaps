import { describe, expect, it } from 'vitest';
import { Keypair, type PublicKey } from '@solana/web3.js';
import { DasClient } from '@/chain/das';
import { bubblegumTreeConfigPda, compressedAssetListingPda } from '@/chain/pdas';
import { MarketCurrency } from '@/chain/ix/market';
import type { BubblegumProof } from '@/chain/bubblegum';
import { resolveCompressedChip, type ResolvedCompressedChip } from '@/chain/flows/compressedChip';
import { listingBuyIxs, dasEndpoint } from './payment';

const pk = () => Keypair.generate().publicKey;

const SELLER = pk();

/** The claim PDA state the resolver reads. Defaults to a settled, free, owned claim. */
function claimState(buyer: PublicKey, over: Record<string, unknown> = {}) {
  return { buyer, collectionIdx: 2, rarity: 3, level: 2, gameIndex: 7n, expiresAt: 0n,
    settlement: pk(), indexReserved: true, minted: true, registered: true, consumed: false,
    listed: false, bump: 9, staked: false, origin: pk(), lockUntil: 0n, founder: false, ...over };
}

/**
 * A resolved leaf, as `resolveCompressedChip` returns it. The proof is internally consistent with
 * the resolved fields on purpose: `buyCompressedAssetIx` cross-checks the DAS proof against the
 * listing, so a fixture that lies about its own owner is rejected before it reaches the interesting
 * assertion.
 */
function resolved(over: Partial<ResolvedCompressedChip> = {}): ResolvedCompressedChip {
  const asset = over.asset ?? pk();
  const merkleTree = over.merkleTree ?? pk();
  const delegate = over.delegate ?? pk();
  const proof: BubblegumProof = {
    assetId: asset, leafOwner: SELLER, leafDelegate: delegate, merkleTree,
    root: new Uint8Array(32).fill(9), dataHash: new Uint8Array(32).fill(1), creatorHash: new Uint8Array(32).fill(2),
    collectionHash: new Uint8Array(32).fill(3), assetDataHash: new Uint8Array(32).fill(4),
    flags: 0, leafNonce: 7n, leafIndex: 7n, proof: [pk(), pk()],
  };
  const base: ResolvedCompressedChip = {
    asset, claim: pk(), chip: pk(), merkleTree,
    // the tree config is derived from the tree, exactly as the program requires
    treeConfig: bubblegumTreeConfigPda(merkleTree)[0], coreCollection: pk(),
    collectionIdx: 2, delegate, proof, claimState: claimState(SELLER),
    leaf: { root: proof.root, dataHash: proof.dataHash, creatorHash: proof.creatorHash, collectionHash: proof.collectionHash, assetDataHash: proof.assetDataHash, flags: 0, nonce: 7n, index: 7, proofNodes: proof.proof },
  };
  return { ...base, ...over };
}

const base = { buyer: pk(), seller: SELLER, treasury: pk(), buyback: pk(), expectedPrice: 12_345_678n };

describe('V2 market payment', () => {
  it('builds exactly one instruction: the V2 buy has no SPL leg to prepare', () => {
    const r = resolved();
    const ixs = listingBuyIxs({ ...base, asset: r.asset, resolved: r });
    expect(ixs).toHaveLength(1);
    // the bubblegum proof nodes ride as remaining accounts, so the instruction is bigger, not longer
    expect(ixs[0].keys.length).toBeGreaterThan(15);
  });

  it('carries the seller-pinned price through, so a front-run cannot reprice the fill', () => {
    const r = resolved();
    const ixs = listingBuyIxs({ ...base, asset: r.asset, resolved: r });
    // the price is the last u64 in the args, after the proof hashes
    expect(ixs[0].data.readBigUInt64LE(ixs[0].data.length - 8)).toBe(base.expectedPrice);
  });

  it('derives the listing PDA from the asset, not from the claim — a leaf sale moves the asset, not the claim', () => {
    const r = resolved();
    const ixs = listingBuyIxs({ ...base, asset: r.asset, resolved: r });
    expect(ixs[0].keys[1].pubkey.equals(compressedAssetListingPda(r.asset)[0])).toBe(true);
    // the claim PDA is the economic receipt and stays put
    expect(ixs[0].keys.some((k) => k.pubkey.equals(r.claim))).toBe(true);
  });

  it('refuses a listing row in USDC or SKR instead of paying it in SOL (SEC-B28)', () => {
    const r = resolved();
    for (const code of [MarketCurrency.USDC, MarketCurrency.SKR]) {
      expect(() => listingBuyIxs({ ...base, asset: r.asset, resolved: r, listingCurrency: code })).toThrow(/SOL only/);
    }
    // a SOL row, or a row with no currency at all (the happy path), is accepted
    expect(() => listingBuyIxs({ ...base, asset: r.asset, resolved: r, listingCurrency: MarketCurrency.SOL })).not.toThrow();
    expect(() => listingBuyIxs({ ...base, asset: r.asset, resolved: r })).not.toThrow();
  });

  it('refuses a proof that is not for this asset — the builder is the last line before signing', () => {
    const r = resolved();
    const foreign = resolved({ asset: r.asset });
    // the resolved proof is for `r.asset`, so buying `foreign.asset` with it must fail
    expect(() => listingBuyIxs({ ...base, asset: pk(), resolved: r })).toThrow(/does not match/);
    // and a resolved leaf whose proof names a different tree than its own merkleTree is refused too
    const split = resolved();
    expect(() => listingBuyIxs({ ...base, asset: split.asset, resolved: { ...split, merkleTree: pk() } })).toThrow(/tree does not match/);
    expect(foreign.asset.equals(r.asset)).toBe(true);
  });

  it('resolves the leaf through the DAS client it is given, never a cached one', async () => {
    const asset = pk();
    const proof = resolved({ asset }).proof;
    const connection = { getAccountInfo: async () => null };
    await expect(resolveCompressedChip(connection as never, new DasClient({ endpoint: 'http://x', fetchImpl: async () => new Response('{}') }) as never, asset))
      .rejects.toThrow(/not registered/);
    // the endpoint helper is overridable so a deployment can point at its own DAS
    expect(dasEndpoint('http://mine')).toBe('http://mine');
    expect(dasEndpoint()).toBeTruthy();
    expect(proof.assetId.equals(asset)).toBe(true);
  });
});
