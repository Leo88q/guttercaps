// =============================================================================
// GUTTERCAPS economy — Floodgrid («Решётка») approved rules (docs/13 checklist).
// Owner-approved values; changing them is an economy change, not a tweak.
// Board mechanics live in gridEngine.ts; this file is money/progression only.
// =============================================================================

export const GRID = {
  totalLevels: 75,
  levelsPerDepth: 15,
  depths: 5,
  /** baseXP(L) = xpBase + xpPerLevel·L */
  xpBase: 4,
  xpPerLevel: 2,
  passHintEveryTiers: 5, // every 5th claimed Season Pass tier also grants one Terminal mark
  starMultBps: [0, 4000, 7000, 10000] as readonly number[], // by stars 0..3 (0 = fail handled separately)
  failXp: -6,
  moveBudgetMult: 2, // charge attempt fails above 2×par
  /** charge droplets («Заряд паводка») */
  chargeMax: 3,
  chargePerSectorStreak: 5, // every 5 route sectors at >=2 stars -> +1 droplet progress
  chargeRefillPerDay: 1, // repeat-sector refill, per chip per day
  chargeStakeBonusBpsPerDrop: 500, // +5% staking weight per droplet
  chargeStakeEvaporateDays: 7,
  /** gear («Снаряжение ныряльщика») — earned only, never sold */
  hintStartStock: 5,
  hintStockCap: 10,
  valveStockCap: 2,
  hintMaxPerChargeAttempt: 1,
  emergencyHintAfterFails: 3,
  /** star milestones (account, best stars across campaign) */
  /** Flood Night: on Sunday the Drain district of the day pays double droplet progress/refills */
  floodSundayDropletMult: 2,
  floodDistricts: 8,
  /** Phase 3 endgame (docs/12, owner-approved 2026-10-13): district contracts, Deep Flood, Ghost of the day. */
  contractsPerDay: 3, // deterministic district offers; conductor must be a 75/75 chip of that district
  deepFreeAttemptsPerWeek: 1,
  deepPaidAttemptsPerWeek: 3, // extra weekly attempts: 30 $CG each, 100% burn via pay_service kind 10
  deepAttemptCgMicro: 30_000_000,
  deepMoveBudgetMult: 1.5, // Deep Flood modifier: no hints, tighter move budget
  ghostHintsPerDay: 1, // beat the ghost (<= par, no hints) -> +1 Terminal mark, once a day
  starMilestones: [
    { stars: 75, hints: 2, valves: 0 },
    { stars: 125, hints: 0, valves: 1 },
    { stars: 175, hints: 3, valves: 0 },
    { stars: 225, hints: 0, valves: 0, skin: 'perfect-flood' }, // + cosmetic «Идеальный паводок»
  ] as readonly { stars: number; hints: number; valves: number; skin?: string }[],
} as const;

export const GRID_DEPTHS = [
  { depth: 1, name: 'Верхние решётки', levels: [1, 15], material: 'zinc', grid: '4×4 → 5×5' },
  { depth: 2, name: 'Ртутный коллектор', levels: [16, 30], material: 'chrome', grid: '5×5 → 6×6' },
  { depth: 3, name: 'Терминальный коллектор', levels: [31, 45], material: 'rust', grid: '6×6 → 7×7' },
  { depth: 4, name: 'Глухие камеры', levels: [46, 60], material: 'cast', grid: '7×7' },
  { depth: 5, name: 'Сердце паводка', levels: [61, 75], material: 'glass', grid: '7×7 → 8×8' },
] as const;

export const depthOfLevel = (level: number): number => Math.min(GRID.depths, Math.max(1, Math.ceil(level / GRID.levelsPerDepth)));

/** Maximum (3-star) XP of a campaign level. */
export const gridBaseXp = (level: number): number => GRID.xpBase + GRID.xpPerLevel * Math.max(1, Math.floor(level));

/** XP granted for a solve at `stars` (0 = fail: returns GRID.failXp; success is at least 1). */
export function gridXpForStars(level: number, stars: number): number {
  if (stars <= 0) return GRID.failXp;
  const s = Math.min(3, Math.floor(stars));
  return Math.max(1, Math.floor((gridBaseXp(level) * GRID.starMultBps[s]) / 10000));
}

/** Stars from move count vs par (charge attempt budget = 2×par; above that the attempt failed, 0). */
export function gridStarsForMoves(moves: number, par: number): 0 | 1 | 2 | 3 {
  if (par <= 0 || moves < 0) return 0;
  if (moves <= par) return 3;
  if (moves <= Math.ceil(par * 1.5)) return 2;
  if (moves <= par * GRID.moveBudgetMult) return 1;
  return 0;
}

/** Total XP of a perfect (all 3★) 75-level route for one chip — invariant-checked in tests (6 000). */
export const gridRouteTotalXp = (): number => {
  let s = 0;
  for (let l = 1; l <= GRID.totalLevels; l++) s += gridBaseXp(l);
  return s;
};

export type GridGiftKind = 'booster' | 'xp_ticket' | 'chip_voucher' | 'skin' | 'theme' | 'banner' | 'title' | 'hints' | 'seal';
export interface GridGift { level: number; kind: GridGiftKind; amount: number; template?: number; key?: string }
/** Account gifts (once per wallet, first chip to reach the level). From level 35 by owner decision. */
export const GRID_GIFTS: readonly GridGift[] = [
  { level: 35, kind: 'booster', amount: 1 },
  { level: 40, kind: 'xp_ticket', amount: 1 }, { level: 40, kind: 'hints', amount: 3 },
  { level: 45, kind: 'chip_voucher', amount: 1, template: 0 },
  { level: 50, kind: 'skin', amount: 1, key: 'wet-rim' },
  { level: 55, kind: 'booster', amount: 2 }, { level: 55, kind: 'hints', amount: 3 },
  { level: 60, kind: 'theme', amount: 1, key: 'collector-heart' },
  { level: 65, kind: 'xp_ticket', amount: 1 },
  { level: 70, kind: 'banner', amount: 1, key: 'floodgrid-depth' }, { level: 70, kind: 'title', amount: 1, key: 'deep-diver' },
  { level: 75, kind: 'chip_voucher', amount: 1, template: 1 }, { level: 75, kind: 'seal', amount: 1, key: 'heart-of-flood' },
] as const;

/** Staking weight multiplier from charge droplets (budget pool: redistribution only, no extra emission). */
export const gridChargeStakeMult = (drops: number): number => 1 + (Math.min(GRID.chargeMax, Math.max(0, drops)) * GRID.chargeStakeBonusBpsPerDrop) / 10000;
