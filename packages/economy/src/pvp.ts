// =============================================================================
// GUTTERCAPS economy — PvP ("Cap Slam")
// -----------------------------------------------------------------------------
// Format: 3v3 squad, best-of-3 rounds, resolved instantly server-side with a
// verifiable seed. Not turn-based-interactive: the reference audience plays
// in 30-second sessions on mobile, and instant resolution lets us run
// thousands of matches per minute without websockets-per-turn. Players still
// make decisions BEFORE the match (squad, lane order, one "tactic" card),
// which is where skill lives.
//
// Fairness: the server derives round rolls from
//   seed = sha256(matchId ‖ nonceA ‖ nonceB ‖ serverSecret)
// where each player's client commits sha256(nonce) when queueing and reveals
// the nonce on match start (so nobody can change it after seeing the pairing),
// and the server cannot pre-compute a seed while pairing because it only knows
// the commits; serverSecret is published per season after the season ends so
// every historical match becomes re-verifiable (backend/src/arena.ts). Wagered matches
// additionally pin the seed to a Switchboard randomness account revealed
// on-chain (see programs/…/battle.rs) so the payout can't be influenced.
// =============================================================================

import { profile, levelMult, type RarityIndex } from './rarity.ts';

export type Element = 'paint' | 'wheels' | 'steel' | 'noise' | 'shadow';

/** Each collection carries one element (rock-paper-scissors ring + 2 neutrals). */
export const COLLECTION_ELEMENT: Record<string, Element> = {
  NIGHTMOTH: 'shadow', ASPHALTDEV: 'wheels', RAILKINGS: 'steel', GUTTERSOLE: 'wheels',
  BOOMBOX: 'noise', GUTTERBEAST: 'shadow', PIXELBSMT: 'noise', BRAKELESS: 'wheels',
  INKED: 'paint', CITYMYTHS: 'paint',
};

/**
 * Same map by on-chain collection index (0 Night Moth … 9 City Myths) — what the indexer and the
 * client see. Mirrored in client/src/shared/lib/rarity.ts `ELEMENT_OF_COLLECTION`.
 */
export const ELEMENT_BY_COLLECTION: readonly Element[] = ['shadow', 'wheels', 'steel', 'wheels', 'noise', 'shadow', 'noise', 'wheels', 'paint', 'paint'];
export const elementOfCollection = (idx: number): Element => ELEMENT_BY_COLLECTION[idx] ?? 'paint';

/** attacker beats defender → +15% power. Ring: paint>steel>wheels>noise>shadow>paint */
const RING: Element[] = ['paint', 'steel', 'wheels', 'noise', 'shadow'];
export function elementEdge(a: Element, d: Element): number {
  const i = RING.indexOf(a);
  if (RING[(i + 1) % RING.length] === d) return 1.15;
  if (RING[(i + RING.length - 1) % RING.length] === d) return 0.87;
  return 1;
}

export interface SquadChip {
  rarity: RarityIndex;
  level: number;
  collection: string;
}

/** Chip power = basePower × levelMult. Squad power = sum + 8% synergy per matching element pair. */
export function chipPower(c: SquadChip): number {
  return profile(c.rarity).basePower * levelMult(c.level);
}

export function squadPower(squad: SquadChip[]): number {
  const raw = squad.reduce((s, c) => s + chipPower(c), 0);
  const elements = squad.map((c) => COLLECTION_ELEMENT[c.collection] ?? 'paint');
  const uniq = new Set(elements).size;
  const synergy = 1 + 0.08 * (squad.length - uniq); // 0, 1 or 2 pairs
  return raw * synergy;
}

/** Half-width of the per-round luck multiplier: each side rolls U[1-W, 1+W]. */
export const ROUND_LUCK_WIDTH = 0.5;

/**
 * Round resolution: each side rolls a multiplier in [0.5, 1.5] from the
 * seed; higher effective power wins the round. With best-of-3, a 1.2x power
 * edge wins ~74%, 1.35x ~84%, 2x ~99% — big enough to reward progression,
 * wide enough that a well-built lower squad still takes rounds and queues
 * stay honest. (Width 0.15 was tested and made 1.2x a 98% lock → P2W feel.)
 */
export function roundWinProbability(pA: number, pB: number): number {
  const w = ROUND_LUCK_WIDTH;
  const r = pA / pB;
  if (r >= (1 + w) / (1 - w)) return 1;
  if (r <= (1 - w) / (1 + w)) return 0;
  // numeric integration (reporting only; the server uses the direct roll)
  let acc = 0; const n = 1000;
  for (let i = 0; i < n; i++) {
    const uB = (1 - w) + (2 * w * (i + 0.5)) / n;
    const th = uB / r; // uA must exceed th
    acc += Math.max(0, Math.min(1, ((1 + w) - th) / (2 * w)));
  }
  return acc / n;
}

export function matchWinProbability(pA: number, pB: number): number {
  const p = roundWinProbability(pA, pB);
  return p * p * (3 - 2 * p); // best of 3
}

// -----------------------------------------------------------------------------
// Matchmaking & ranks
// -----------------------------------------------------------------------------
/** Glicko-lite: rating ± spread (starts at ±100, widens 5 pts/s up to ±300). Power bands prevent 3-Diamond stomping Commons. */
export const MATCHMAKING = {
  startRating: 1000,
  kFactorNew: 40, kFactorSettled: 20, settledAfterGames: 30,
  powerBandsUpper: [800, 1400, 2400, 4000, 7000, Infinity], // squad power → league
  leagueNames: ['Curb', 'Alley', 'Block', 'District', 'Skyline', 'Rooftop'],
  initialSpread: 100, queueWidenPerSec: 5, maxSpread: 300, botFillAfterSec: 45,
} as const;

/** Season = 6 weeks. Rewards from the pvpSeason emission slice + 50% of PvP rake. */
export const SEASON = {
  weeks: 6,
  /** share of the season pool by final rank bracket */
  payoutBrackets: [
    { topPct: 0.1, sharePct: 15 }, { topPct: 1, sharePct: 20 }, { topPct: 5, sharePct: 25 },
    { topPct: 20, sharePct: 25 }, { topPct: 50, sharePct: 15 },
  ],
  /** Chips as season rewards, tier by league — deliberately no Legend+/Diamond from free PvP */
  chipRewardByLeague: ['Common+', 'Rare', 'Rare', 'Rare+', 'Epic', 'Epic+'] as const,
  soulboundDays: 14, // reward chips are non-transferable for 14d → no reward-farming resale
  /**
   * Ladder payout eligibility: ≥ 10 resolved (non-forfeit) matches in the season. A wallet that
   * queued twice must not collect a top-50 % share — the brackets are percentiles of *participants*,
   * so sybil wallets with 1 game each would dilute real players. 10 games ≈ two evenings of play.
   */
  minGamesForPayout: 10,
  /** Share of the pvpSeason emission slice reserved for the ladder (the rest pays per-match rewards). */
  ladderSharePct: 40,
  /**
   * The full pool is paid only when ≥ this many wallets qualify; below it the paid pool scales
   * linearly (3 qualifiers → 0.3 %). A near-empty season must not hand a six-week emission slice to a
   * handful of wallets; whatever is not paid simply stays unminted in the slice.
   */
  fullPoolParticipants: 1000,
} as const;

/**
 * Split a season pool across ranked participants by `SEASON.payoutBrackets` (docs/02 §4.5).
 * Bands are cumulative percentiles of `n` qualified participants (rank ≤ ceil(n × topPct / 100)); a
 * band's share is divided equally among its members; the share of a band that ends up empty (small
 * seasons) rolls UP into the nearest better band so payouts stay monotone in rank. The pool itself is
 * scaled by min(1, n / fullPoolParticipants). Returns micro amounts per 1-based rank.
 */
export function seasonPayoutByRank(poolMicro: bigint, n: number): Map<number, bigint> {
  const out = new Map<number, bigint>();
  if (n <= 0 || poolMicro <= 0n) return out;
  const scaled = n >= SEASON.fullPoolParticipants ? poolMicro : (poolMicro * BigInt(n)) / BigInt(SEASON.fullPoolParticipants);
  const bands: { from: number; to: number; sharePct: number }[] = [];
  let prevCut = 0;
  let carry = 0;
  for (const b of SEASON.payoutBrackets) {
    const cut = Math.min(n, Math.ceil((n * b.topPct) / 100));
    if (cut > prevCut) { bands.push({ from: prevCut + 1, to: cut, sharePct: b.sharePct + carry }); carry = 0; prevCut = cut; }
    else if (bands.length) bands[bands.length - 1].sharePct += b.sharePct; // empty band → roll up
    else carry += b.sharePct;
  }
  for (const b of bands) {
    const each = (scaled * BigInt(b.sharePct)) / 100n / BigInt(b.to - b.from + 1);
    if (each > 0n) for (let r = b.from; r <= b.to; r++) out.set(r, each);
  }
  return out;
}

/** Per-match rewards — small, capped daily, to make queues live without a faucet. */
export const MATCH_REWARDS = {
  winCgMicro: 2_000_000,   // 2 $CG
  lossCgMicro: 500_000,    // 0.5 $CG (participation)
  dailyRewardedMatches: 8,
  minSquadPowerForRewards: 400,
} as const;

/** Wagers: escrow both stakes; rake 5%; the loser's chip is NOT lost (chips are never at risk in v1).
 *  v3 (2026-10): range raised to 25–25 000 $CG — small wagers were free noise (no skin in the
 *  game), and the old 5 000 cap kept whales out of the arena. */
export const WAGER = { minCgMicro: 25_000_000, maxCgMicro: 25_000_000_000, rakeBps: 500 } as const; // rake split: 40% treasury / 40% burn / 20% season pool
