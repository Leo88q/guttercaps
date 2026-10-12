// =============================================================================
// GUTTERCAPS economy — free chip sources & anti-inflation caps
// -----------------------------------------------------------------------------
// The rule: free sources are allowed to give AT MOST ~15% of the chip value
// a paying player buys in a week (measured in Common-equivalents), and NEVER
// hand out Legend+ or Diamond directly. Anything above Epic from a free
// source is soulbound for a window so it can't be dumped on the market.
// =============================================================================

import { profile, type RarityIndex } from './rarity.ts';

export type QuestPeriod = 'daily' | 'weekly' | 'permanent';

/**
 * Quest chip voucher templates (backlog #28) — the ONLY shapes a free chip can take. `template` is what a
 * kind-9 reward leaf carries and what chip_core's `open_voucher` looks up in `VOUCHER_DEFS`
 * (programs/chip_core/src/economy.rs — pinned by sync-check): a mini-pack roll table (bps over 9 tiers,
 * one chip, no floor, no pity, all districts) + the soulbound window of the minted chip.
 */
export interface ChipVoucherTemplate { template: number; odds: readonly number[]; soulboundDays: number }
/** Gutter Pot weekly raffle odds (Rare / Rare+ / Epic). Shared with template 4; referrals (template 3) use the same table with a longer soulbound window. */
const GUTTER_POT_ODDS = [0, 0, 5000, 4000, 1000, 0, 0, 0, 0] as const;

export const QUEST_CHIP_TEMPLATES: readonly ChipVoucherTemplate[] = [
  { template: 0, odds: [8000, 1800, 200, 0, 0, 0, 0, 0, 0],    soulboundDays: 3 },  // 7-day streak
  { template: 1, odds: [3000, 5000, 1800, 200, 0, 0, 0, 0, 0], soulboundDays: 7 },  // all weeklies
  { template: 2, odds: [0, 0, 0, 0, 10000, 0, 0, 0, 0],        soulboundDays: 30 }, // 500 wins — the only free Epic
  { template: 3, odds: GUTTER_POT_ODDS,                        soulboundDays: 14 }, // 5 paying referrals
  { template: 4, odds: GUTTER_POT_ODDS,                        soulboundDays: 7 },  // Gutter Pot weekly staking raffle
];
const voucher = (template: number): ChipVoucherTemplate => QUEST_CHIP_TEMPLATES[template];

export interface QuestDef {
  id: string;
  period: QuestPeriod;
  title: string;
  /** progress key — what the indexer/back end counts */
  metric: string;
  target: number;
  rewardCgMicro: number;
  /** chip reward: one of `QUEST_CHIP_TEMPLATES` (rooted as a kind-9 voucher leaf carrying `template`) */
  rewardChip?: ChipVoucherTemplate | null;
  rewardItem?: 'booster' | 'ticket' | null;
}

// Daily: 24 $CG total (cap 25) — v3 rebalance: fusion fees grew ~5×, so free
// daily income grew ~1.8× to keep the loop alive; free share of a median payer's
// value stays ~11% (invariant ≤ 20%). No chip drop — dailies pay in $CG only,
// the bridge to packs (2 700 $CG = one Standard pack ≈ 3.9 months of perfect
// dailies). A 7-day streak grants ONE Common-tier roll.
// ORDER MATTERS: the streak / weekly-meta math below reads DAILY_QUESTS[4] and
// WEEKLY_QUESTS[4] — the meta quests must stay at index 4, new entries go after.
//
// Cross-game check-ins: NeuroForge (age of intelligence) and ARES-1 are separate
// apps, so the only server-side evidence of a visit is an explicit ping — the same
// trust level as the daily login (quest_logins), the same eligibility gate and the
// same daily/weekly caps at settlement. They are deliberately EXCLUDED from the
// streak: the streak tracks core in-game dailies, and a week shouldn't be lost
// because a partner site was down.
export const DAILY_QUESTS: QuestDef[] = [
  { id: 'd_login',   period: 'daily', title: 'Check the drains (log in)',       metric: 'login',        target: 1, rewardCgMicro: 3_000_000 },
  { id: 'd_pvp3',    period: 'daily', title: 'Play 3 Cap Slam matches',         metric: 'pvp_played',   target: 3, rewardCgMicro: 6_000_000 },
  { id: 'd_win1',    period: 'daily', title: 'Win a match',                     metric: 'pvp_won',      target: 1, rewardCgMicro: 6_000_000 },
  { id: 'd_fuse1',   period: 'daily', title: 'Fuse once',                       metric: 'fusions',      target: 1, rewardCgMicro: 5_000_000 },
  { id: 'd_streak7', period: 'daily', title: '7-day streak (all dailies)',      metric: 'streak_days',  target: 7, rewardCgMicro: 0,
    rewardChip: voucher(0) },
  { id: 'd_visit_neuroforge', period: 'daily', title: 'Visit NeuroForge (our 2nd game)', metric: 'visit_neuroforge', target: 1, rewardCgMicro: 2_000_000 },
  { id: 'd_visit_ares1',      period: 'daily', title: 'Visit ARES-1 (our 3rd game)',     metric: 'visit_ares1',      target: 1, rewardCgMicro: 2_000_000 },
];

// Weekly: 120 $CG + one Common+/Rare roll + 1 booster (cap 140 $CG/week) — v3 rebalance.
// The two partner weeklies count distinct visit DAYS (the daily ping above feeds them).
export const WEEKLY_QUESTS: QuestDef[] = [
  { id: 'w_pvp20',   period: 'weekly', title: 'Play 20 matches',                metric: 'pvp_played',   target: 20, rewardCgMicro: 25_000_000 },
  { id: 'w_win8',    period: 'weekly', title: 'Win 8 matches',                  metric: 'pvp_won',      target: 8,  rewardCgMicro: 30_000_000 },
  { id: 'w_trade',   period: 'weekly', title: 'Complete a marketplace trade',   metric: 'trades',       target: 1,  rewardCgMicro: 15_000_000 },
  { id: 'w_stake',   period: 'weekly', title: 'Keep ≥ 3 chips staked 5 days',   metric: 'stake_days',   target: 5,  rewardCgMicro: 20_000_000, rewardItem: 'booster' },
  { id: 'w_all',     period: 'weekly', title: 'All weeklies done',              metric: 'weeklies_done',target: 6,  rewardCgMicro: 0,
    rewardChip: voucher(1) },
  { id: 'w_visit_neuroforge', period: 'weekly', title: 'Visit NeuroForge on 3 days', metric: 'visit_neuroforge', target: 3, rewardCgMicro: 15_000_000 },
  { id: 'w_visit_ares1',      period: 'weekly', title: 'Visit ARES-1 on 3 days',     metric: 'visit_ares1',      target: 3, rewardCgMicro: 15_000_000 },
];

// Permanent (one-time milestones): the only free route to Epic — soulbound 30 days.
export const PERMANENT_QUESTS: QuestDef[] = [
  { id: 'p_first_fusion', period: 'permanent', title: 'First fusion',                 metric: 'fusions',      target: 1,   rewardCgMicro: 10_000_000 },
  { id: 'p_win50',        period: 'permanent', title: 'Win 50 matches',               metric: 'pvp_won',      target: 50,  rewardCgMicro: 50_000_000 },
  { id: 'p_win500',       period: 'permanent', title: 'Win 500 matches',              metric: 'pvp_won',      target: 500, rewardCgMicro: 200_000_000,
    rewardChip: voucher(2) },
  { id: 'p_set1',         period: 'permanent', title: 'Complete a full district set', metric: 'sets_done',    target: 1,   rewardCgMicro: 100_000_000, rewardItem: 'booster' },
  { id: 'p_diamond_hand', period: 'permanent', title: 'Hold any chip staked 90 days', metric: 'max_stake_days', target: 90, rewardCgMicro: 60_000_000 },
  { id: 'p_referral5',    period: 'permanent', title: 'Refer 5 players who buy a pack', metric: 'referrals_paid', target: 5, rewardCgMicro: 100_000_000,
    rewardChip: voucher(3) },
  { id: 'p_visit_neuroforge', period: 'permanent', title: 'First visit to NeuroForge', metric: 'visit_neuroforge', target: 1, rewardCgMicro: 10_000_000 },
  { id: 'p_visit_ares1',      period: 'permanent', title: 'First visit to ARES-1',     metric: 'visit_ares1',      target: 1, rewardCgMicro: 10_000_000 },
  { id: 'p_stake30',          period: 'permanent', title: 'Keep a chip staked for 30 days', metric: 'max_stake_days', target: 30, rewardCgMicro: 30_000_000 },
  { id: 'p_trades5',          period: 'permanent', title: 'Complete 5 marketplace trades',  metric: 'trades',       target: 5,  rewardCgMicro: 25_000_000 },
];

/**
 * Referrals — paid from the Events slice (emission split index 4, root kind 4, signer = season oracle).
 *
 * Accrual rule (backend/src/referrals.ts, settled by the reward oracle from FINALIZED events):
 *   * only the referee's *real-revenue* pack purchases count: sku > 0 paid in SOL / USDC / SKR.
 *     $CG-paid packs are a sink, not revenue, and would let free quest $CG recycle into referral
 *     $CG — they are excluded, not discounted.
 *   * a purchase counts once its first pack is opened (the on-chain `PendingPack.revealed` flag makes
 *     the payment irrevocable — SEC-C3); a still-refundable purchase waits.
 *   * spend = the SKU list price × qty with the bundle discount (and the SKR discount when paid in
 *     SKR) — the USD amount the buyer agreed to at checkout, derived from indexed fields only, so the
 *     accrual is deterministic and auditable without a historical price feed.
 *   * $CG per USD cent = 1 (the same convention the on-chain services price list uses); the referrer
 *     earns `referrerRewardBps` of the spend, capped per referee for life.
 *   * the referee gets a one-off welcome bonus after that first counted purchase — the Starter pack's
 *     price in $CG at the same convention (the program has no coupon path for a literally free pack;
 *     the value is identical and it is only paid to a wallet that has already spent real money).
 * Anti-farm: both wallets pass the device gates (a referrer/referee pair seen on one device earns
 * nothing — self-referral costs the pack price and returns 0), the referrer must be reward-eligible
 * itself (paid pack or 24 h + 10 matches, human check), review holds postpone, shadow bans zero out.
 * `publish_root` enforces `budget ≤ slice_budget[4]` on chain, so referral payouts can never exceed
 * what the Events slice has actually accrued — a spike simply waits for the next epochs.
 */
export const REFERRAL = {
  /** referrer gets 5% of referee's pack spend in $CG (from the events reserve), capped */
  referrerRewardBps: 500,
  referrerCapCgPerRefereeMicro: 200_000_000, // 200 $CG per referee lifetime
  /** micro-$CG per USD cent of counted spend (1 ¢ ≙ 1 $CG — the services price-list convention) */
  cgMicroPerUsdCent: 1_000_000,
  /** referee's one-off welcome bonus after the first counted purchase (was the Starter price; kept at 149 $CG when Starter moved to $1.99) */
  refereeWelcomeCgMicro: 149_000_000,
  /** currency codes whose pack purchases count (0 SOL, 1 USDC, 3 SKR) — $CG (2) is a sink, excluded */
  countedCurrencies: [0, 1, 3],
  refereeBonus: '149 $CG welcome bonus after the first paid pack (≙ a Starter pack)',
  requirement: 'referee buys ≥ 1 paid pack (SOL / USDC / SKR) and opens it; both wallets pass device dedupe; referrer is reward-eligible',
} as const;

/**
 * Gutter Pot — named weekly raffle among **chip** stakers (not $CG locks).
 * Ticket = live chip-stake `weight` at the Monday 00:00 UTC snapshot; 10 unique wallets;
 * each winner claims a kind-9 voucher (template 4). Outside `ANTI_FARM.freeChipsPerWalletPerWeek`
 * (that cap is streak + weekly quest chips only).
 */
export const GUTTER_POT = {
  id: 'gutter_pot',
  template: 4,
  odds: GUTTER_POT_ODDS,
  winnersPerWeek: 10,
  soulboundDays: 7,
  seedPrefix: 'gutter-pot:v1',
} as const;
/** @deprecated use `GUTTER_POT` — same numbers, old name. */
export const STAKING_JACKPOT = GUTTER_POT;

export const ANTI_FARM = {
  dailyQuestRewardCapCgMicro: 25_000_000,
  weeklyQuestRewardCapCgMicro: 140_000_000,
  freeChipsPerWalletPerWeek: 2,          // hard cap on quest chips (streak + weekly); Gutter Pot is extra
  minAccountAgeForRewardsSec: 24 * 3600, // wallet must have ≥1 paid pack OR be 24h old with 10 matches
  deviceFingerprintDedupe: true,
  /** Wallets that may earn rewards from one device (salted client fingerprint); the newer ones beyond this get `device_limit`. */
  maxWalletsPerDevice: 3,
  proofOfHuman: 'Turnstile on claim + rate-limited claims per IP /24',
  /** A Turnstile pass is fresh for this long; quest settlement is postponed (not zeroed) while it is stale. */
  humanCheckTtlSec: 7 * 86_400,
  pvpSameOpponentDailyCap: 3,            // rewards stop after 3 matches vs the same wallet per day
  pvpMinMatchDurationSec: 20,            // instant-forfeit farming is not rewarded
} as const;

// -----------------------------------------------------------------------------
// Faucet share report: value of free chips per active player per week vs the
// value a "median payer" buys (2 standard packs).
// -----------------------------------------------------------------------------
function evOfOdds(odds: readonly number[]): number {
  return odds.reduce((acc, bps, i) => acc + (bps / 10_000) * profile(i as RarityIndex).valueMult, 0);
}

export function freeValueReport(paidCommonsPerWeek: number, activeStakers = 5000) {
  const streakChipEv = evOfOdds(DAILY_QUESTS[4].rewardChip!.odds); // one per 7-day streak
  const weeklyChipEv = evOfOdds(WEEKLY_QUESTS[4].rewardChip!.odds);
  const jackpotEvPerWallet = (evOfOdds(STAKING_JACKPOT.odds) * STAKING_JACKPOT.winnersPerWeek) / activeStakers;
  // $CG side: perfect dailies + weeklies (derived from the tables — can never
  // drift) + PvP match rewards (8 rewarded matches/day at 50% WR:
  // 4×2 + 4×0.5 = 10/day).
  const dailyCg = DAILY_QUESTS.reduce((s, q) => s + q.rewardCgMicro, 0) / 1e6;
  const weeklyCg = WEEKLY_QUESTS.reduce((s, q) => s + q.rewardCgMicro, 0) / 1e6;
  const cgPerWeek = dailyCg * 7 + weeklyCg + 10 * 7;
  const cgAsCommons = (cgPerWeek / 2700) * paidCommonsPerWeek / 2; // /2: paid baseline is 2 packs
  const freeCommonsPerWeek = streakChipEv + weeklyChipEv + jackpotEvPerWallet + cgAsCommons;
  return {
    streakChipEv: +streakChipEv.toFixed(2),
    weeklyChipEv: +weeklyChipEv.toFixed(2),
    jackpotEvPerWallet: +jackpotEvPerWallet.toFixed(3),
    cgAsCommons: +cgAsCommons.toFixed(2),
    freeCommonsPerWeek: +freeCommonsPerWeek.toFixed(2),
    paidCommonsPerWeek: +paidCommonsPerWeek.toFixed(2),
    freeShare: +(freeCommonsPerWeek / paidCommonsPerWeek).toFixed(3),
  };
}
