// =============================================================================
// GUTTERCAPS economy — packs, odds, pity, bundles
// -----------------------------------------------------------------------------
// Design goals (why these numbers):
//  * A pack must feel exciting at least every ~4 opens (something ≥ Rare) and
//    life-changing at least once in a player's first serious month (≥ Legend
//    across ~60 packs with pity).
//  * Free sources (quests/PvP) must never produce more than ~15% of the value
//    that paid packs produce per active player per week — see faucets.ts.
//  * Pricing anchor: the STANDARD pack defines the Common floor. We set
//    EV(standard) = 65% of its price → implied Common floor ≈ $0.0638
//    at the $5.99 price (`impliedCommonFloorUsd()` is the exact value).
//    Every other SKU is then priced
//    so its EV/price sits in [55%, 75%]: the 25-45% gap is the standard
//    gacha "entertainment + platform" margin; above ~80% pack-opening becomes
//    a strictly dominant arbitrage vs. the marketplace and floors collapse,
//    below ~50% players feel robbed and stop buying.
//  * Premium/Limited never offer better $/EV than Standard — they sell
//    variance compression (fewer dead packs, higher Legend odds) and access
//    (featured collection), not a discount. Otherwise whales would only
//    ever buy the top SKU and the entry SKU would be dead.
// =============================================================================

import { RARITIES, RARITY_PROFILES, type Rarity, type RarityIndex } from './rarity.ts';

export type PackId = 'starter' | 'standard' | 'premium' | 'limited';

export interface PackDef {
  id: PackId;
  name: string;
  /** Number of chips inside. */
  chips: number;
  /** Price in USDC-cents (stable) — SOL price is derived from a Pyth feed at checkout. */
  priceUsdCents: number;
  /** Optional $CG price (micro-CG, 6 dp). `null` = not purchasable with $CG. */
  priceCgMicro: number | null;
  /** Odds per chip slot, in basis points of 10_000. Sum must be 10_000. */
  oddsBps: readonly number[]; // index = RarityIndex
  /**
   * Guaranteed floor for the LAST chip in the pack: that slot re-rolls
   * everything below `floor` into `floor`. Multi-chip packs therefore
   * always contain at least one chip of `floor` rarity.
   */
  floor: RarityIndex;
  /** Per-wallet purchase cap per rolling 24h (anti-whale on limited SKUs). null = none. */
  dailyCap: number | null;
  /** Hard pity: after this many packs without a chip ≥ pityTier, next pack forces one. */
  pity: { tier: RarityIndex; hardAt: number; softStart: number; softStepBps: number } | null;
  /** Which collections it can roll from. 'all' | 'featured' (event) | list of symbols. */
  pool: 'all' | 'featured';
  purchasable: boolean; // starter is one-per-wallet
}

/**
 * Baseline odds (per chip slot). Compare with the collection bible's
 * headline 45/25/15/8/4.5/1.8/0.5/0.18/0.02 — we keep Common..Epic+ almost
 * identical and cut the three top tiers slightly on the STANDARD pack
 * because pity adds back ~25% of Legend+ supply deterministically.
 */
const STANDARD_ODDS = [4500, 2500, 1500, 800, 450, 180, 50, 18, 2] as const;

// Premium shifts mass out of Common/Common+ into Rare/Rare+, raises
// Legend/Legend+/Diamond odds ×1.4-2.5, floor Rare + 5 chips → no dead packs.
// EV/price ≈ 63% (vs 65% Standard): you pay a small premium for consistency.
// 2026-09-29: price $12.99 → $14.99 at 5 chips (6 is impossible: MAX_CHIPS_PER_PACK = 5 is baked into
// the compressed-claim stride and PackOpened layout) → mass moved from Common into Rare+..Legend to keep EV ≥ 55 %.
const PREMIUM_ODDS = [2320, 2600, 2250, 1600, 800, 310, 90, 25, 5] as const;

// Starter is deliberately +EV (floor Rare, 4 chips, $1.99) — it is a
// customer-acquisition cost, not a product. One-per-wallet, and its chips
// are non-tradeable for STARTER_SOULBOUND_DAYS (soulbound window written onto
// PendingPack / CompressedMintClaim.lock_until) so sybil wallets cannot farm
// and dump them.
export const STARTER_SOULBOUND_DAYS = 7;
const STARTER_ODDS = [2900, 3000, 2500, 1200, 350, 50, 0, 0, 0] as const;

// Limited event pack: only the featured (seasonal) collection, floor Rare+,
// top-end odds ×2.4-15 vs standard, hard daily cap of 5 per wallet so the
// event doesn't get vacuumed by bots in the first minute.
const LIMITED_ODDS = [2200, 2400, 2400, 1600, 850, 350, 120, 50, 30] as const;

export const PACKS: Record<PackId, PackDef> = {
  starter: {
    id: 'starter', name: 'Starter Pack', chips: 4,
    priceUsdCents: 199, priceCgMicro: null,
    oddsBps: STARTER_ODDS, floor: 2, dailyCap: 1, pity: null, pool: 'all', purchasable: true,
  },
  standard: {
    id: 'standard', name: 'Standard Pack', chips: 4,
    priceUsdCents: 599, priceCgMicro: 900_000_000, // 900 $CG
    oddsBps: STANDARD_ODDS, floor: 1, dailyCap: null,
    pity: { tier: 6 /* Legend */, hardAt: 60, softStart: 30, softStepBps: 25 },
    pool: 'all', purchasable: true,
  },
  premium: {
    id: 'premium', name: 'Premium Pack', chips: 5,
    priceUsdCents: 1499, priceCgMicro: 2_250_000_000, // 2 250 $CG
    oddsBps: PREMIUM_ODDS, floor: 2, dailyCap: null,
    pity: { tier: 6, hardAt: 40, softStart: 20, softStepBps: 40 },
    pool: 'all', purchasable: true,
  },
  limited: {
    id: 'limited', name: 'Limited Event Pack', chips: 5,
    priceUsdCents: 2999, priceCgMicro: null, // event packs are SOL/USDC only → real revenue for prize pools
    oddsBps: LIMITED_ODDS, floor: 3, dailyCap: 5,
    pity: { tier: 6, hardAt: 25, softStart: 12, softStepBps: 60 },
    pool: 'featured', purchasable: true,
  },
};

/**
 * Commit-reveal refund window, in slots. Switchboard stops signing a reveal 1 h after the
 * commit; at 400 ms slots 10 800 ≈ 72 min, so `cancel_stale_pack`/`cancel_stale_fusion` can only
 * succeed once nobody (buyer included) can still learn the value — no free re-rolls (SEC-C3, Q3).
 * Mirrored in chip_core::economy::STALE_PACK_SLOTS and client `STALE_PACK_SLOTS`; sync-check + the
 * landing check pin the number.
 */
export const STALE_PACK_SLOTS = 10_800;
export const STALE_PACK_MINUTES = Math.round((STALE_PACK_SLOTS * 0.4) / 60); // ≈ 72

/** Bundle discounts — apply to standard/premium only (not limited: caps matter more than volume). */
export const BUNDLES = [
  { qty: 1, discountBps: 0 },
  { qty: 5, discountBps: 700 },   // -7%
  { qty: 10, discountBps: 1200 }, // -12%
  { qty: 25, discountBps: 1800 }, // -18% (largest; deeper discounts start to undercut the marketplace floor)
] as const;

export function bundlePriceCents(pack: PackDef, qty: number): number {
  const tier = [...BUNDLES].reverse().find((b) => qty >= b.qty) ?? BUNDLES[0];
  return Math.round((pack.priceUsdCents * qty * (10_000 - tier.discountBps)) / 10_000);
}

// -----------------------------------------------------------------------------
// Pity
// -----------------------------------------------------------------------------
// Two layers, both deterministic and checkable on-chain from PlayerPity PDA:
//   soft pity: from `softStart` packs without a ≥tier drop, each additional
//              pack adds `softStepBps` to the ≥tier probability mass (taken
//              from Common's share);
//   hard pity: at `hardAt` the last chip in the pack is forced to ≥tier.
// The counter resets on any natural or forced ≥tier drop.
// Effective Legend+ rate for STANDARD with pity ≈ 0.70% + 0.55% (pity) ≈ 1.25%
// per pack, i.e. ~1 Legend per 80 packs for an unlucky player, guaranteed by 60.

export function effectiveOdds(pack: PackDef, pityCounter: number): number[] {
  // MUST stay byte-identical to `effective_odds` in programs/chip_core/src/economy.rs
  const odds = [...pack.oddsBps];
  if (!pack.pity) return odds;
  const { tier, softStart, softStepBps } = pack.pity;
  if (pityCounter < softStart) return odds;
  const extra = Math.min((pityCounter - softStart + 1) * softStepBps, Math.max(0, odds[0] - 500)); // never drain Common below 5%
  const topMass = pack.oddsBps.slice(tier).reduce((a, b) => a + b, 0);
  if (topMass === 0 || extra === 0) return odds;
  odds[0] -= extra;
  // Spread extra over tier..8 proportionally to their base odds (integer floor division, like on-chain).
  let added = 0;
  for (let i = tier; i < odds.length; i++) {
    const add = Math.floor((extra * pack.oddsBps[i]) / topMass);
    odds[i] += add;
    added += add;
  }
  odds[0] += extra - added; // rounding remainder back to Common → Σ == 10_000 exactly
  return odds;
}

/** Map a uniform u16 roll (0..9999) to a rarity using cumulative odds. */
export function rollRarity(roll: number, oddsBps: readonly number[]): RarityIndex {
  let acc = 0;
  for (let i = 0; i < oddsBps.length; i++) {
    acc += oddsBps[i];
    if (roll < acc) return i as RarityIndex;
  }
  return 0;
}

/**
 * Uniform u16 in [0, 10_000) from the 32-byte VRF output, slot-indexed, with
 * rejection sampling — MUST stay byte-identical to `uniform_bps` in
 * programs/chip_core/src/economy.rs (the crank pre-simulates the roll to know
 * which collection accounts to pass; the program re-derives and verifies).
 */
export function uniformBps(vrf: Uint8Array, slot: number): number {
  const RANGE = 10_000;
  const LIMIT = 2 ** 32 - ((2 ** 32) % RANGE);
  for (let attempt = 0; attempt < 4; attempt++) {
    const o = (slot * 5 + attempt * 7) % 28;
    const v = (vrf[o] | (vrf[o + 1] << 8) | (vrf[o + 2] << 16) | (vrf[o + 3] << 24)) >>> 0;
    if (v < LIMIT) return v % RANGE;
  }
  // fold fallback (probability ≈ (7296/2^32)^4): a.wrapping_mul(31).wrapping_add(b) over u64
  let fold = 0n;
  for (const b of vrf) fold = (fold * 31n + BigInt(b)) & 0xffff_ffff_ffff_ffffn;
  return Number(fold % BigInt(RANGE));
}

/**
 * Uniform collection slot in [0, pool) from the 32-byte VRF output, with
 * rejection sampling — MUST stay byte-identical to `uniform_pool` in
 * programs/chip_core/src/economy.rs. (A single byte mod pool over-weights
 * the first collections: 10.16 % vs 9.77 % at pool = 10.)
 */
export function uniformPool(vrf: Uint8Array, slot: number, pool: number): number {
  if (pool <= 1) return 0;
  const LIMIT = 2 ** 32 - ((2 ** 32) % pool);
  for (let attempt = 0; attempt < 4; attempt++) {
    const o = (slot * 5 + attempt * 7 + 16) % 28;
    const v = (vrf[o] | (vrf[o + 1] << 8) | (vrf[o + 2] << 16) | (vrf[o + 3] << 24)) >>> 0;
    if (v < LIMIT) return v % pool;
  }
  let fold = 0n;
  for (const b of vrf) fold = (fold * 31n + BigInt(b)) & 0xffff_ffff_ffff_ffffn;
  return Number(fold % BigInt(pool));
}

/**
 * Deterministic expansion of one 32-byte VRF output into N chip slots.
 * Slot i: rarity from uniformBps(vrf, i); collection from uniformPool(vrf, i).
 * Last slot gets the SKU floor and the hard-pity guarantee.
 */
export function expandRandomness(
  vrf: Uint8Array,
  pack: PackDef,
  pityCounter: number,
  poolSize: number,
): { rarity: RarityIndex; collectionIdx: number }[] {
  if (vrf.length < 32) throw new Error('VRF output must be 32 bytes');
  const odds = effectiveOdds(pack, pityCounter);
  const out: { rarity: RarityIndex; collectionIdx: number }[] = [];
  for (let i = 0; i < pack.chips; i++) {
    let rarity = rollRarity(uniformBps(vrf, i), odds);
    const isLast = i === pack.chips - 1;
    if (isLast && rarity < pack.floor) rarity = pack.floor;
    if (isLast && pack.pity && pityCounter + 1 >= pack.pity.hardAt && rarity < pack.pity.tier) rarity = pack.pity.tier;
    out.push({ rarity, collectionIdx: uniformPool(vrf, i, Math.max(1, poolSize)) });
  }
  return out;
}

// -----------------------------------------------------------------------------
// Expected value helpers (used by the economy report + admin dashboard)
// -----------------------------------------------------------------------------
export function packExpectedValueMult(pack: PackDef): number {
  const odds = pack.oddsBps;
  const evSlot = odds.reduce((acc, bps, i) => acc + (bps / 10_000) * RARITY_PROFILES[i].valueMult, 0);
  // floor on the last slot: mass below floor collapses into floor
  const below = odds.slice(0, pack.floor).reduce((a, b) => a + b, 0) / 10_000;
  const evBelow = odds.slice(0, pack.floor).reduce((acc, bps, i) => acc + (bps / 10_000) * RARITY_PROFILES[i].valueMult, 0);
  const evLast = evSlot - evBelow + below * RARITY_PROFILES[pack.floor].valueMult;
  return evSlot * (pack.chips - 1) + evLast;
}

export function probabilityAtLeast(pack: PackDef, tier: RarityIndex): number {
  const pSlot = pack.oddsBps.slice(tier).reduce((a, b) => a + b, 0) / 10_000;
  const pLast = pack.floor >= tier ? 1 : pSlot;
  return 1 - Math.pow(1 - pSlot, pack.chips - 1) * (1 - pLast);
}

export const rarityName = (i: RarityIndex): Rarity => RARITIES[i];

/** Target EV/price for the anchor SKU; defines the modelled Common floor. */
export const STANDARD_EV_TARGET = 0.65;
export function impliedCommonFloorUsd(): number {
  return (PACKS.standard.priceUsdCents / 100) * STANDARD_EV_TARGET / packExpectedValueMult(PACKS.standard);
}
