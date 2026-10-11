// =============================================================================
// GUTTERCAPS economy — staking
// -----------------------------------------------------------------------------
// Two staking products, both fed from ONE capped emission schedule
// (tokenomics.ts) — never from an open mint:
//
//  1. $CG staking (token lock)   — tiers: flex / 30d / 90d / 180d.
//     Rewards = share of the daily $CG budget for the token-staking pool,
//     weighted by (amount × tierBoost). APY is therefore an OUTPUT of TVL,
//     not a promise. We publish a target range and the admin can rebalance
//     the pool split quarterly.
//  2. Chip staking (NFT lock)    — the existing mechanic, but converted from
//     "fixed rate per hour, unlimited" to "stakeWeight share of the chip pool
//     budget". Full-set bonus and level multiplier apply here.
//
// Why pro-rata instead of fixed APY: a fixed rate is an uncapped faucet whose
// inflation is proportional to adoption — the more successful the game, the
// faster the token dies. A budgeted pool inverts that: more stakers → lower
// APY → natural equilibrium, and total emission is known in advance.
// =============================================================================

export type LockTier = 'flex' | 'd30' | 'd90' | 'd180';

export interface LockTierDef {
  id: LockTier;
  lockSeconds: number;
  /** Weight multiplier applied to staked amount. */
  boost: number;
  /** Early-unlock penalty, bps of principal → burned. Flex has none. */
  earlyExitPenaltyBps: number;
  /** Indicative APY band at the modelled TVL (see report). Marketing only. */
  targetApyRange: [number, number];
}

const DAY = 86_400;

export const LOCK_TIERS: Record<LockTier, LockTierDef> = {
  flex: { id: 'flex', lockSeconds: 0,         boost: 1.0, earlyExitPenaltyBps: 0,    targetApyRange: [4, 12] },
  d30:  { id: 'd30',  lockSeconds: 30 * DAY,  boost: 1.5, earlyExitPenaltyBps: 500,  targetApyRange: [6, 18] },
  d90:  { id: 'd90',  lockSeconds: 90 * DAY,  boost: 2.2, earlyExitPenaltyBps: 1000, targetApyRange: [10, 24] },
  d180: { id: 'd180', lockSeconds: 180 * DAY, boost: 3.0, earlyExitPenaltyBps: 1500, targetApyRange: [14, 32] },
};

/**
 * Launch cash rails (mirrored on-chain in programs/staking). Per-wallet daily
 * claim caps stop a 50-DAU network from printing a Standard pack per staker per
 * day. Alive-stake: a chip that has not been in a Cap Slam for `aliveWindowDays`
 * keeps 25 % weight — AFK farm dies, fighters keep the full share.
 */
export const STAKE_CLAIM_CAPS = {
  chipDailyCg: 30,
  tokenDailyCg: 15,
  aliveWindowDays: 7,
  idleWeight: 0.25,
} as const;

export function aliveStakeMult(lastPlayedAt: number | null | undefined, now = Date.now() / 1000): number {
  if (!lastPlayedAt || lastPlayedAt <= 0) return STAKE_CLAIM_CAPS.idleWeight;
  return (now - lastPlayedAt) <= STAKE_CLAIM_CAPS.aliveWindowDays * DAY
    ? 1
    : STAKE_CLAIM_CAPS.idleWeight;
}

/**
 * Modelled mid-Y1 token-staking TVL for the indicative APY bands: ~40M $CG
 * (≈ 35% of what has been emitted by then + part of the ecosystem bucket),
 * average boost 1.8. APY is an OUTPUT: half the TVL → double the APY, and
 * vice versa. The daily budget never changes; only its split does. The
 * published bands are ±50% around the modelled point; year-2+ bands fall
 * with the emission schedule and are re-published each season.
 */
export const MODELLED_TOKEN_TVL_CG = 40_000_000;
export const MODELLED_AVG_BOOST = 1.8;

/**
 * Full-set bonus (own all 9 tiers of one collection, all staked or held):
 *   +12% chip-staking weight per completed collection, max +60% (5 sets),
 *   +2% additional per set beyond 5 (cap +70% at 10/10).
 * Justification: completing a set costs ~4 000 Common-equivalents (one
 * Diamond!). A 12% yield boost is meaningful for whales but doesn't create
 * a separate class of returns that dwarfs everyone else.
 */
export function fullSetBonusMult(completedSets: number): number {
  const first = Math.min(completedSets, 5) * 0.12;
  const rest = Math.max(0, completedSets - 5) * 0.02;
  return 1 + first + rest;
}

/** Weight of a staked chip: rarity weight × level multiplier × set bonus. */
export function chipStakeWeight(stakeWeight: number, level: number, completedSets: number): number {
  return stakeWeight * (1 + 0.025 * Math.max(0, level - 1)) * fullSetBonusMult(completedSets);
}

/** Token-staking weight. amount in whole $CG. */
export function tokenStakeWeight(amount: number, tier: LockTier): number {
  return amount * LOCK_TIERS[tier].boost;
}

/**
 * Pro-rata reward per second for a participant with weight w in a pool with
 * total weight W and daily budget B (micro-CG). Integer math on-chain uses a
 * "reward per weight-unit" accumulator (MasterChef-style acc_reward_per_share
 * scaled by 1e12) so that N stakers cost O(1) per update.
 */
export function rewardPerSecond(w: number, W: number, dailyBudgetMicro: number): number {
  if (W === 0) return 0;
  return (dailyBudgetMicro / DAY) * (w / W);
}

export function impliedApy(amount: number, tier: LockTier, poolTotalWeight: number, dailyBudgetCg: number): number {
  const w = tokenStakeWeight(amount, tier);
  const perYear = dailyBudgetCg * 365 * (w / (poolTotalWeight + w));
  return (perYear / amount) * 100;
}
