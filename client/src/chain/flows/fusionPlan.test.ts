import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { planClaimFusion } from './fusionPlan';
import type { CompressedMintClaim } from '../accounts';

function claim(over: Partial<CompressedMintClaim> & { buyer: PublicKey }): CompressedMintClaim {
  return {
    collectionIdx: 0, rarity: 1, level: 1, gameIndex: 1n, expiresAt: 9_999_999_999n,
    settlement: PublicKey.default, indexReserved: true, minted: true, registered: true,
    consumed: false, listed: false, bump: 1, staked: false, origin: over.buyer, lockUntil: 0n, founder: false,
    ...over,
  };
}

describe('planClaimFusion', () => {
  const owner = Keypair.generate().publicKey;

  it('forces result district to the materials for a same-collection recipe', () => {
    const claims = [0, 0, 0].map((collectionIdx) => claim({ buyer: owner, rarity: 1, collectionIdx }));
    const plan = planClaimFusion(claims, owner, 4);
    expect(plan.block).toBeUndefined();
    expect(plan.resultCollectionIdx).toBe(0);
    expect(plan.recipeFrom).toBe(1);
  });

  it('blocks mixed districts on Common+ / Rare+ / …', () => {
    const claims = [0, 1, 0].map((collectionIdx) => claim({ buyer: owner, rarity: 1, collectionIdx }));
    expect(planClaimFusion(claims, owner, 0).block).toBe('mixed');
  });

  it('keeps a requested result district on an any-collection recipe when it is one of the materials', () => {
    const claims = [0, 2, 0].map((collectionIdx) => claim({ buyer: owner, rarity: 0, collectionIdx }));
    expect(planClaimFusion(claims, owner, 2).resultCollectionIdx).toBe(2);
    expect(planClaimFusion(claims, owner, 5).resultCollectionIdx).toBe(0);
  });
});
