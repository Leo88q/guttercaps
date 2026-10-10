// Decide the on-chain fusion args from live CompressedMintClaim accounts.
// The bench UI reads indexer chip rows; claim.collection_idx / rarity are what
// fuse_compressed_claims actually checks (same_collection recipes especially).
import { PublicKey } from '@solana/web3.js';
import { FUSION_RECIPES } from '@guttercaps/economy';
import { claimFusionBlock, type ClaimFusionBlock, type CompressedMintClaim } from '../accounts';

export type FusionPlanBlock = ClaimFusionBlock | 'rarity' | 'mixed';

export function planClaimFusion(
  claims: CompressedMintClaim[],
  owner: PublicKey,
  requestedResult: number,
  nowSec?: number,
): { resultCollectionIdx: number; recipeFrom: number; block?: FusionPlanBlock } {
  if (claims.length !== 3) return { resultCollectionIdx: requestedResult, recipeFrom: 0, block: 'unregistered' };
  for (const c of claims) {
    const block = claimFusionBlock(c, owner, nowSec);
    if (block) return { resultCollectionIdx: requestedResult, recipeFrom: c.rarity, block };
  }
  const recipeFrom = claims[0].rarity;
  if (claims.some((c) => c.rarity !== recipeFrom)) {
    return { resultCollectionIdx: requestedResult, recipeFrom, block: 'rarity' };
  }
  const recipe = FUSION_RECIPES[recipeFrom];
  if (!recipe) return { resultCollectionIdx: requestedResult, recipeFrom, block: 'unregistered' };
  const home = claims[0].collectionIdx;
  if (recipe.rule === 'same-collection') {
    if (claims.some((c) => c.collectionIdx !== home)) {
      return { resultCollectionIdx: requestedResult, recipeFrom, block: 'mixed' };
    }
    return { resultCollectionIdx: home, recipeFrom };
  }
  const resultCollectionIdx = claims.some((c) => c.collectionIdx === requestedResult) ? requestedResult : home;
  return { resultCollectionIdx, recipeFrom };
}
