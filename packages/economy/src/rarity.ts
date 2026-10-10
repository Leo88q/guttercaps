// =============================================================================
// GUTTERCAPS economy — rarity ladder (single source of truth)
// -----------------------------------------------------------------------------
// Everything that depends on the 9-tier ladder (pack odds, fusion recipes,
// staking multipliers, PvP power, marketplace filters, site copy) imports
// from here. The on-chain program mirrors these numbers in
// programs/chip_core/src/economy.rs (`base_power` / `stake_weight` /
// `max_level`) — `npm run economy:check` asserts they agree, so the two can't
// drift silently. (Up to 2026-09-18 this comment named the v0.1 monolith, which
// the check never read.)
// =============================================================================

export const RARITIES = [
  'Common',
  'Common+',
  'Rare',
  'Rare+',
  'Epic',
  'Epic+',
  'Legend',
  'Legend+',
  'Diamond',
] as const;

export type Rarity = (typeof RARITIES)[number];
export type RarityIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export const rarityIndex = (r: Rarity): RarityIndex => RARITIES.indexOf(r) as RarityIndex;

/** Anchor enum variant names, in order — used by the client/indexer decoders. */
export const RARITY_ANCHOR_KEYS = [
  'common', 'commonPlus', 'rare', 'rarePlus', 'epic', 'epicPlus', 'legend', 'legendPlus', 'diamond',
] as const;

export interface RarityProfile {
  tier: RarityIndex;
  name: Rarity;
  /**
   * Modelled equilibrium value vs Common. Fusion sets a hard price CEILING
   * per step — nobody pays more for N+1 than E[burn]·price(N) + fee, and
   * arbitrage (buy N, fuse, sell N+1) pushes prices toward it. We model
   * each tier at 0.9 × that ceiling (the 10% gap = fee + result lock + risk).
   * `economy:check` asserts the per-step ratio stays within [0.8, 1.0] of
   * E[burn] so the two files cannot drift apart.
   */
  valueMult: number;
  /** PvP base power. Grows ~1.45x per tier: a Diamond is ~20x a Common, not 1000x —
   *  keeps low-tier squads viable in ranked and prevents pure pay-to-win. */
  basePower: number;
  /** Level cap (kept from current on-chain values). */
  maxLevel: number;
  /**
   * Staking weight (share units) when staked. This is a WEIGHT, not an APY:
   * rewards come from a fixed daily emission budget split pro-rata, so total
   * payout never exceeds budget no matter how many chips are staked.
   */
  stakeWeight: number;
  /** Visual tier for the UI: 0 = flat, 4 = full holographic + screen shake. */
  vfxTier: 0 | 1 | 2 | 3 | 4;
  /** Rim finish from the collection bible (drives the chip-frame CSS class). */
  rim: string;
}

export const RARITY_PROFILES: readonly RarityProfile[] = [
  { tier: 0, name: 'Common',   valueMult: 1,    basePower: 100,  maxLevel: 12, stakeWeight: 1,    vfxTier: 0, rim: 'zinc-scratched' },
  { tier: 1, name: 'Common+',  valueMult: 2.7,  basePower: 145,  maxLevel: 16, stakeWeight: 2,    vfxTier: 0, rim: 'zinc-wet' },
  { tier: 2, name: 'Rare',     valueMult: 7.3,  basePower: 210,  maxLevel: 20, stakeWeight: 5,    vfxTier: 1, rim: 'steel-polished' },
  { tier: 3, name: 'Rare+',    valueMult: 19.7, basePower: 305,  maxLevel: 24, stakeWeight: 12,   vfxTier: 1, rim: 'steel-oilslick' },
  { tier: 4, name: 'Epic',     valueMult: 53,   basePower: 440,  maxLevel: 28, stakeWeight: 30,   vfxTier: 2, rim: 'enamel' },
  { tier: 5, name: 'Epic+',    valueMult: 160,  basePower: 640,  maxLevel: 32, stakeWeight: 80,   vfxTier: 2, rim: 'enamel-crackle' },
  { tier: 6, name: 'Legend',   valueMult: 528,  basePower: 930,  maxLevel: 36, stakeWeight: 220,  vfxTier: 3, rim: 'bronze-patina' },
  { tier: 7, name: 'Legend+',  valueMult: 1850, basePower: 1350, maxLevel: 40, stakeWeight: 650,  vfxTier: 3, rim: 'bronze-glow' },
  { tier: 8, name: 'Diamond',  valueMult: 8300, basePower: 2000, maxLevel: 50, stakeWeight: 2200, vfxTier: 4, rim: 'prism-holo' },
];

export const profile = (r: Rarity | RarityIndex): RarityProfile =>
  typeof r === 'number' ? RARITY_PROFILES[r] : RARITY_PROFILES[rarityIndex(r)];

/** Level multiplier shared by PvP power and staking weight: +2.5% per level above 1. */
export const levelMult = (level: number): number => 1 + 0.025 * Math.max(0, level - 1);

/**
 * Ranked chip XP (indexer-authoritative, same trust model as ratings / pass XP).
 * Caps mint at 1; a win/loss of a ranked Cap Slam credits the three squad caps.
 * Ranked power uses the new level; on-chain wagers still snapshot `claim.level` (mint 1)
 * until a merkle `level_up` caller ships with chip_core.
 */
export const CHIP_XP = {
  win: 10,
  loss: 3,
  /** Unspent XP one cap may earn from ranked play in one UTC day. 8 wins = the $CG match cap. */
  dailyCap: 80,
  /** XP to go from `level` → `level + 1`. */
  cost(level: number): number {
    return 10 * Math.max(1, level);
  },
} as const;

/** Total XP needed for the next level, or `null` at the rarity cap. */
export function xpToNext(level: number, maxLevel: number): number | null {
  if (level >= maxLevel) return null;
  return CHIP_XP.cost(level);
}

/** Spend `xp` starting at `level`, never past `maxLevel`. Remainder stays unspent. */
export function applyChipXp(level: number, xp: number, maxLevel: number): { level: number; xp: number; gained: number } {
  let lvl = Math.max(1, Math.floor(level) || 1);
  let pool = Math.max(0, Math.floor(xp) || 0);
  let gained = 0;
  while (lvl < maxLevel) {
    const cost = CHIP_XP.cost(lvl);
    if (pool < cost) break;
    pool -= cost;
    lvl += 1;
    gained += 1;
  }
  return { level: lvl, xp: pool, gained };
}
