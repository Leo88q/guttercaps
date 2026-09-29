// =============================================================================
// GUTTERCAPS economy — fusion (merge) recipes
// -----------------------------------------------------------------------------
// Decision summary:
//  * Materials must be the SAME RARITY, always 3 of them. The collection
//    rule alternates by half-step:
//      N   → N+   "RECHARGE": any collection. The primary material keeps its
//                 identity (the result belongs to ITS collection); the other
//                 two are "charge donors". Lore: a cap is recharged by the
//                 energy of two others in the second flood. This makes the
//                 very first fusion reachable in ~2-3 packs (the "aha" moment)
//                 and keeps off-collection dupes useful forever.
//      N+  → next "NEW STORY": same collection. The district's story moves
//                 on only with that district's charge → creates targeted
//                 demand for specific dupes, set-completion pressure and
//                 real reasons to trade. Half the ladder asks you to trade.
//    Since each collection has exactly ONE chip per tier, "same collection"
//    and "same chip" are the same constraint.
//  * Success chance is 100% up to Epic, then < 100% with 1 material refunded
//    on failure. Reason: at the top of the ladder the burn count alone can't
//    absorb supply without an absurd stack per attempt; a chance with partial
//    refund gives the same expected cost with a smaller barrier per attempt
//    and a much better "moment" (the fusion screen is a slot machine at the
//    top, a crafting bench at the bottom).
//  * $CG fee on every fusion is the primary $CG sink (see tokenomics.ts).
//  * A "Charge Booster" consumable (+15% success, capped at 95%) is a
//    quest/PvP-only item — never sold for money, so P2W is capped.
// =============================================================================

import { RARITY_PROFILES, type RarityIndex } from './rarity.ts';

export type CollectionRule = 'same-collection' | 'any';

export interface FusionRecipe {
  from: RarityIndex;
  to: RarityIndex;
  /** materials burned (all of rarity `from`) */
  materials: number;
  rule: CollectionRule;
  /** success chance in bps; 10_000 = guaranteed */
  successBps: number;
  /** materials returned on failure (rest are burned) */
  refundOnFail: number;
  /** $CG fee (micro) burned 100% on both success and failure */
  feeCgMicro: number;
  /** cooldown on the RESULT chip before it can be fused again / listed (anti-wash) */
  resultLockSeconds: number;
}

const HOUR = 3600;

export const FUSION_RECIPES: readonly FusionRecipe[] = [
  { from: 0, to: 1, materials: 3, rule: 'any',             successBps: 10_000, refundOnFail: 0, feeCgMicro:     5_000_000, resultLockSeconds: 0 },
  { from: 1, to: 2, materials: 3, rule: 'same-collection', successBps: 10_000, refundOnFail: 0, feeCgMicro:    12_000_000, resultLockSeconds: 0 },
  { from: 2, to: 3, materials: 3, rule: 'any',             successBps: 10_000, refundOnFail: 0, feeCgMicro:    30_000_000, resultLockSeconds: 0 },
  { from: 3, to: 4, materials: 3, rule: 'same-collection', successBps: 10_000, refundOnFail: 0, feeCgMicro:    60_000_000, resultLockSeconds: HOUR },
  { from: 4, to: 5, materials: 3, rule: 'any',             successBps:  8_500, refundOnFail: 1, feeCgMicro:   120_000_000, resultLockSeconds: 6 * HOUR },
  { from: 5, to: 6, materials: 3, rule: 'same-collection', successBps:  7_500, refundOnFail: 1, feeCgMicro:   400_000_000, resultLockSeconds: 24 * HOUR },
  { from: 6, to: 7, materials: 3, rule: 'any',             successBps:  7_000, refundOnFail: 1, feeCgMicro: 1_400_000_000, resultLockSeconds: 48 * HOUR },
  { from: 7, to: 8, materials: 3, rule: 'same-collection', successBps:  5_000, refundOnFail: 1, feeCgMicro: 6_000_000_000, resultLockSeconds: 72 * HOUR },
];

export const BOOSTER = { bonusBps: 1500, capBps: 9500 } as const;

export const recipeFor = (from: RarityIndex): FusionRecipe | undefined => FUSION_RECIPES.find((r) => r.from === from);

/**
 * Expected number of `from`-rarity chips consumed per successful fusion.
 * With chance p, refund r of m materials: each attempt burns (m - r) on fail
 * and m on success. Expected attempts = 1/p.
 *   E[burn] = m + (1/p - 1) * (m - r)
 */
export function expectedBurn(recipe: FusionRecipe, boosted = false): number {
  const p = Math.min(recipe.successBps + (boosted ? BOOSTER.bonusBps : 0), recipe.successBps === 10_000 ? 10_000 : BOOSTER.capBps) / 10_000;
  return recipe.materials + (1 / p - 1) * (recipe.materials - recipe.refundOnFail);
}

/** Expected Commons consumed to craft one chip of tier `to` purely by fusion (no drops). */
export function commonsPerTier(to: RarityIndex, boosted = false): number {
  let commons = 1;
  for (let t = 0; t < to; t++) commons *= expectedBurn(FUSION_RECIPES[t], boosted);
  return commons;
}

/**
 * Per-step parity: market value ratio of N+1 to N vs E[burn] for that step.
 * Target 0.8–1.0: fusing is never a free arbitrage (ratio > 1) and never
 * pointless (ratio < 0.8 → buying N+1 is far cheaper than crafting it).
 */
export function fusionParityReport() {
  return FUSION_RECIPES.map((r) => {
    const stepValueRatio = RARITY_PROFILES[r.to].valueMult / RARITY_PROFILES[r.from].valueMult;
    const eb = expectedBurn(r);
    return {
      step: `${RARITY_PROFILES[r.from].name} → ${RARITY_PROFILES[r.to].name}`,
      valueRatio: +stepValueRatio.toFixed(2),
      expectedBurn: +eb.toFixed(2),
      parity: +(stepValueRatio / eb).toFixed(2),
      cumulativeCommons: +commonsPerTier(r.to).toFixed(0),
    };
  });
}
