// Shared compressed-claim settlement: mint → DAS resolve → local V2 preflight →
// register. Used by PackFlow (per pack chip) and ClaimFusionFlow (fusion
// result). Idempotent by construction: already-minted claims skip the mint,
// already-registered ones only resolve the leaf for display — racing the crank
// is harmless.
import { Connection, PublicKey, SystemProgram, type AddressLookupTableAccount } from '@solana/web3.js';
import { fitsInTx, sendTx, type WalletLike } from '../tx';
import { mintCompressedChipIx, registerCompressedChipIx } from '../ix/chipCore';
import { collectionMetaPda, compressedMintClaimPda } from '../pdas';
import {
  decodeCompressedMintClaim, type BubblegumTreeMeta, type CollectionMeta, type CompressedMintClaim,
} from '../accounts';
import { discoverLeafNonce, resolveClaimFromTreeAccount, type BubblegumProof } from '../bubblegum';
import type { DasClient } from '../das';

export interface ClaimSettleCtx {
  connection: Connection;
  wallet: WalletLike;
  das: DasClient;
  buyer: PublicKey;
  metas: Map<number, CollectionMeta>;
  trees: Map<number, BubblegumTreeMeta>;
  lookupTables: AddressLookupTableAccount[];
  onSignature: (sig: string) => void;
}

export interface SettledChip { asset: PublicKey; rarity: number; collectionIdx: number; gameIndex: bigint }

/**
 * Settle one claim by nonce. Returns null for missing/consumed claims (buyer-cancelled —
 * the settlement counters track them) and for expired-unminted ones (cancel first).
 */
export async function settleClaim(ctx: ClaimSettleCtx, claimNonce: bigint): Promise<SettledChip | null> {
  const { connection, wallet, das, buyer, metas, trees, lookupTables } = ctx;
  const [claimKey] = compressedMintClaimPda(buyer, claimNonce);
  const info = await connection.getAccountInfo(claimKey, 'confirmed');
  const claim = info ? decodeCompressedMintClaim(new Uint8Array(info.data)) : null;
  if (!claim || claim.consumed) return null;
  if (claim.registered) return displayClaim(ctx, claim);
  const expired = !claim.minted && claim.expiresAt <= BigInt(Math.floor(Date.now() / 1000));
  if (expired) return null;
  const tree = trees.get(claim.collectionIdx);
  if (!tree || !tree.active) throw new Error(`collection ${claim.collectionIdx} has no active Bubblegum tree`);
  let live: CompressedMintClaim = claim;
  if (!live.minted) {
    try {
      const { signature } = await sendTx(connection, wallet, [mintCompressedChipIx({
        payer: wallet.publicKey, buyer, collectionIdx: live.collectionIdx, claimNonce,
        treeConfig: tree.treeConfig, merkleTree: tree.merkleTree, coreCollection: tree.coreCollection,
      })], { cuLimit: 500_000, lookupTables });
      ctx.onSignature(signature);
    } catch (e) {
      const raced = await connection.getAccountInfo(claimKey, 'confirmed');
      const racedClaim = raced ? decodeCompressedMintClaim(new Uint8Array(raced.data)) : null;
      if (!racedClaim || racedClaim.consumed) return null;
      if (!racedClaim.minted) throw e;
    }
    const reloaded = await connection.getAccountInfo(claimKey, 'confirmed');
    live = reloaded ? decodeCompressedMintClaim(new Uint8Array(reloaded.data)) : live;
    if (!live.minted) throw new Error('mint transaction landed but the claim is still unminted');
    if (live.registered) return displayClaim(ctx, live);
  }
  const meta = metas.get(live.collectionIdx);
  if (!meta) throw new Error(`collection ${live.collectionIdx} not created`);
  const proof = await resolveClaimProof(ctx, live, meta, tree);
  const preReg = await connection.getAccountInfo(claimKey, 'confirmed');
  if (preReg) {
    const preClaim = decodeCompressedMintClaim(new Uint8Array(preReg.data));
    if (preClaim.consumed) return null;
    if (preClaim.registered) {
      return { asset: proof.assetId, rarity: live.rarity, collectionIdx: live.collectionIdx, gameIndex: live.gameIndex };
    }
  }
  proof.leafNonce = discoverLeafNonce(proof, tree.maxDepth, 8, buyer);
  const register = registerCompressedChipIx({
    payer: wallet.publicKey, buyer, claimNonce, asset: proof.assetId, merkleTree: tree.merkleTree,
    treeConfig: tree.treeConfig, collectionIdx: live.collectionIdx, owner: buyer, delegate: buyer,
    proof: {
      root: proof.root, dataHash: proof.dataHash, creatorHash: proof.creatorHash, collectionHash: proof.collectionHash,
      assetDataHash: proof.assetDataHash, flags: proof.flags, nonce: proof.leafNonce, index: Number(proof.leafIndex), proofNodes: proof.proof,
    },
    rarity: live.rarity, level: live.level, gameIndex: live.gameIndex,
    settlement: live.settlement.equals(SystemProgram.programId) ? undefined : live.settlement,
  });
  if (!fitsInTx(wallet.publicKey, [register], lookupTables)) {
    throw new Error('Bubblegum proof does not fit this transaction — the app lookup table is not configured for this wallet (the crank will register this chip instead)');
  }
  try {
    const { signature } = await sendTx(connection, wallet, [register], { cuLimit: 600_000, lookupTables });
    ctx.onSignature(signature);
  } catch (e) {
    // Lost the race against the crank while the wallet popup was open → verify it is now registered and move on.
    const fresh = await connection.getAccountInfo(claimKey, 'confirmed');
    const freshClaim = fresh ? decodeCompressedMintClaim(new Uint8Array(fresh.data)) : null;
    if (!freshClaim || freshClaim.consumed) return null;
    if (!freshClaim.registered) throw e;
  }
  return { asset: proof.assetId, rarity: live.rarity, collectionIdx: live.collectionIdx, gameIndex: live.gameIndex };
}

async function resolveClaimProof(
  ctx: ClaimSettleCtx,
  claim: CompressedMintClaim,
  meta: CollectionMeta,
  tree: BubblegumTreeMeta,
): Promise<BubblegumProof> {
  try {
    return await ctx.das.resolveClaimAsset(ctx.buyer, tree.coreCollection, `${meta.symbol} #${claim.gameIndex}`);
  } catch (dasErr) {
    const treeAcct = await ctx.connection.getAccountInfo(tree.merkleTree, 'confirmed');
    if (!treeAcct) throw dasErr;
    return resolveClaimFromTreeAccount({
      buyer: ctx.buyer,
      merkleTree: tree.merkleTree,
      collectionMeta: collectionMetaPda(claim.collectionIdx)[0],
      coreCollection: tree.coreCollection,
      symbol: meta.symbol,
      collectionIdx: claim.collectionIdx,
      rarity: claim.rarity,
      gameIndex: claim.gameIndex,
      treeAccountData: new Uint8Array(treeAcct.data),
    });
  }
}

/** Resolve an already-registered claim's leaf purely for display (no preflight, no signature). */
export async function displayClaim(ctx: ClaimSettleCtx, claim: CompressedMintClaim): Promise<SettledChip> {
  const meta = ctx.metas.get(claim.collectionIdx);
  const tree = ctx.trees.get(claim.collectionIdx);
  if (!meta || !tree) throw new Error(`collection ${claim.collectionIdx} not created`);
  const proof = await resolveClaimProof(ctx, claim, meta, tree);
  return { asset: proof.assetId, rarity: claim.rarity, collectionIdx: claim.collectionIdx, gameIndex: claim.gameIndex };
}
