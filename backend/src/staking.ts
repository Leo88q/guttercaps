// Staking read-model — `/staking/overview`, `/staking/me`, `/staking/estimate`.
//
// Everything here is derived from indexed events (DayClosed / Staked / Unstaked / Claimed /
// SetBonusSynced) plus the economy constants that the programs mirror (sync-check pins them).
// Pending rewards are an ESTIMATE: the exact number lives in the pool accumulator on chain
// (`acc_reward_per_weight`), which the client reads directly (`useStakingChain`); the API value is
// share-of-pool × daily budget × elapsed time since the last claim, good enough for the list view
// and flagged `pendingEstimated: true`.
import { PublicKey } from '@solana/web3.js';
import { EMISSION_SPLIT, LOCK_TIERS, RARITY_PROFILES, dailyEmission, impliedApy, levelMult, type LockTier } from '@guttercaps/economy';
import { type Db, now } from './db.ts';
import { chipToApi, iso, myGrid, type ChipRow } from './queries.ts';
import { ServiceError } from './services.ts';
import { PROGRAMS } from './config.ts';

export const TIERS: readonly LockTier[] = ['flex', 'd30', 'd90', 'd180'];
export const MICRO = 1_000_000n;
/** staking::state — `SetBonus::mult_bps`: +12 % per set ≤ 5, +2 % beyond, cap 170 %. */
export const setBonusMultBps = (sets: number): number => Math.min(17_000, 10_000 + 1_200 * Math.min(sets, 5) + 200 * Math.max(0, sets - 5));
/** staking::stake::chip_weight — stake_weight × 1e6 × level_mult × set_mult (raw on-chain units). */
export function chipWeightRaw(rarity: number, level: number, sets: number): bigint {
  const p = RARITY_PROFILES[rarity];
  const levelBps = 10_000n + 250n * BigInt(Math.max(1, level) - 1);
  return (BigInt(p.stakeWeight) * MICRO * levelBps) / 10_000n * BigInt(setBonusMultBps(sets)) / 10_000n;
}
export const tokenStakePda = (owner: PublicKey, tier: number) => PublicKey.findProgramAddressSync([Buffer.from('tstake'), owner.toBytes(), Buffer.from([tier])], PROGRAMS.staking)[0];

const sumBig = (db: Db, sql: string, ...params: (string | number)[]) => db.all<{ v: string }>(sql, ...params).reduce((s, r) => s + BigInt(r.v || '0'), 0n);

export interface EmissionDay { dayIndex: number; year: number; scheduleCapMicro: bigint; guardedMicro: bigint; burn7dAvgMicro: bigint; source: 'chain' | 'schedule' }

/** Latest closed day; before the first `tick_day` is indexed the year-0 schedule floor (30 %) is assumed. */
export function latestEmissionDay(db: Db): EmissionDay {
  const r = db.get<{ day_index: number; year: number; schedule_cap: string; guarded: string; burn_7d_avg: string }>(`SELECT day_index, year, schedule_cap, guarded, burn_7d_avg FROM emission_days ORDER BY day_index DESC LIMIT 1`);
  if (r) return { dayIndex: r.day_index, year: r.year, scheduleCapMicro: BigInt(r.schedule_cap), guardedMicro: BigInt(r.guarded), burn7dAvgMicro: BigInt(r.burn_7d_avg), source: 'chain' };
  const cap = BigInt(Math.floor(dailyEmission(0) * 1e6));
  return { dayIndex: 0, year: 0, scheduleCapMicro: cap, guardedMicro: (cap * 3_000n) / 10_000n, burn7dAvgMicro: 0n, source: 'schedule' };
}

export function poolTotals(db: Db) {
  const tokenTvl = sumBig(db, `SELECT amount v FROM stakes WHERE kind = 0 AND active = 1`);
  const tokenWeight = sumBig(db, `SELECT weight v FROM stakes WHERE kind = 0 AND active = 1`);
  const chipWeight = sumBig(db, `SELECT weight v FROM stakes WHERE kind = 1 AND active = 1`);
  const stakedChips = db.scalar(`SELECT COUNT(*) FROM stakes WHERE kind = 1 AND active = 1`);
  return { tokenTvl, tokenWeight, chipWeight, stakedChips };
}

export function overview(db: Db) {
  const e = latestEmissionDay(db);
  const p = poolTotals(db);
  const tokenBudget = (e.guardedMicro * BigInt(EMISSION_SPLIT.tokenStaking)) / 100n;
  const chipBudget = (e.guardedMicro * BigInt(EMISSION_SPLIT.chipStaking)) / 100n;
  const weightCg = Number(p.tokenWeight) / 1e6;           // impliedApy works in whole $CG
  const budgetCg = Number(tokenBudget) / 1e6;
  const apyByTier = TIERS.map((t) => Number(impliedApy(10_000, t, weightCg, budgetCg).toFixed(1)));
  // micro-$CG per day for one Common-equivalent of chip weight (raw weight 1e6)
  const perUnit = p.chipWeight > 0n ? (chipBudget * MICRO) / p.chipWeight : 0n;
  const splitBps = [EMISSION_SPLIT.chipStaking, EMISSION_SPLIT.tokenStaking, EMISSION_SPLIT.quests, EMISSION_SPLIT.pvpSeason, EMISSION_SPLIT.eventsReserve].map((x) => x * 100);
  const minted = sumBig(db, `SELECT amount v FROM claims`) + sumBig(db, `SELECT amount v FROM reward_claims WHERE currency = 'CG'`);
  return {
    emission: { dayIndex: e.dayIndex, year: e.year, scheduleCapMicro: e.scheduleCapMicro.toString(), guardedMicro: e.guardedMicro.toString(), burn7dAvgMicro: e.burn7dAvgMicro.toString(), mintedTotalMicro: minted.toString(), splitBps, source: e.source },
    tokenPool: { tvlMicro: p.tokenTvl.toString(), totalWeight: p.tokenWeight.toString(), budgetTodayMicro: tokenBudget.toString(), apyByTier },
    chipPool: { stakedChips: p.stakedChips, totalWeight: p.chipWeight.toString(), budgetTodayMicro: chipBudget.toString(), dailyPerWeightUnit: perUnit.toString() },
  };
}

/**
 * Micro-$CG a pool emitted during [from, to): each indexed DayClosed funds `guarded × split` spread
 * evenly over the 24 h that follow it (staking::Pool.budget_per_sec). Before the first tick_day the
 * pools have no budget, so nothing accrues — the estimate can never exceed what the chain minted.
 */
export function poolEmitted(db: Db, splitPct: number, from: number, to: number): bigint {
  if (to <= from) return 0n;
  let out = 0n;
  for (const d of db.all<{ guarded: string; block_time: number | null }>(`SELECT guarded, block_time FROM emission_days WHERE block_time IS NOT NULL AND block_time < ? AND block_time + 86400 > ? ORDER BY day_index ASC`, to, from)) {
    const start = Math.max(d.block_time!, from), end = Math.min(d.block_time! + 86_400, to);
    if (end <= start) continue;
    out += (BigInt(d.guarded) * BigInt(splitPct) * BigInt(end - start)) / (100n * 86_400n);
  }
  return out;
}

/**
 * Start of the accrual window for a stake: the later of its opening and the owner's last claim of that kind.
 *
 * SEC-B13: a claim first seen over the websocket has no `block_time` until the healer re-reads its
 * signature (`patchLateTimes`). `MAX(COALESCE(block_time, 0))` read that as "claimed at the epoch", i.e.
 * it *ignored the newest claim* and accrued from an earlier one — over-stating `pending`, the number a
 * player reads as money. An undated claim is by construction a recently ingested one, so the honest
 * answer is the conservative one: accrue nothing from before it (the display under-states until the
 * time lands, and the chain is the only thing that actually pays).
 */
function accrualFrom(db: Db, owner: string, kind: number, since: number | null, t = now()): number {
  const r = db.get<{ bt: number | null; unknown: number }>(`SELECT MAX(COALESCE(block_time, 0)) bt, SUM(block_time IS NULL) unknown FROM claims WHERE owner = ? AND kind = ?`, owner, kind);
  const last = !r ? 0 : r.unknown > 0 ? t : r.bt ?? 0;
  return Math.max(since ?? 0, last);
}

export function me(db: Db, wallet: string) {
  const t = now();
  const p = poolTotals(db);
  const share = (weight: bigint, total: bigint, emitted: bigint) => (total > 0n ? (weight * emitted) / total : 0n);
  const ownerPk = new PublicKey(wallet);
  const tierByKey = new Map(TIERS.map((_, i) => [tokenStakePda(ownerPk, i).toBase58(), i]));
  let total = 0n;

  const tokenStakes = db.all<{ key: string; amount: string; weight: string; unlock_at: number; since: number | null }>(`SELECT key, amount, weight, unlock_at, since FROM stakes WHERE owner = ? AND kind = 0 AND active = 1`, wallet).map((r) => {
    const tier = tierByKey.get(r.key) ?? 0;
    const pending = share(BigInt(r.weight), p.tokenWeight, poolEmitted(db, EMISSION_SPLIT.tokenStaking, accrualFrom(db, wallet, 0, r.since, t), t));
    total += pending;
    const penalty = r.unlock_at > t ? (BigInt(r.amount) * BigInt(LOCK_TIERS[TIERS[tier]].earlyExitPenaltyBps) + 9_999n) / 10_000n /* ceil, = on-chain early_exit_penalty (SEC-F3) */ : 0n;
    return { tier, amount: r.amount, weight: r.weight, pending: pending.toString(), unlockAt: iso(r.unlock_at) ?? new Date(0).toISOString(), earlyExitPenalty: penalty.toString() };
  });

  const chipStakes = db.all<ChipRow & { s_weight: string; since: number | null }>(`SELECT c.*, s.weight s_weight, s.since FROM stakes s JOIN chips c ON c.asset = s.key WHERE s.owner = ? AND s.kind = 1 AND s.active = 1 ORDER BY c.rarity DESC, c.level DESC`, wallet).map((r) => {
    const pending = share(BigInt(r.s_weight), p.chipWeight, poolEmitted(db, EMISSION_SPLIT.chipStaking, accrualFrom(db, wallet, 1, r.since, t), t));
    total += pending;
    return { chip: chipToApi(r), weight: r.s_weight, pending: pending.toString(), since: iso(r.since) ?? new Date(0).toISOString() };
  });

  const onChainSets = db.get<{ sets: number }>(`SELECT sets FROM set_bonus WHERE owner = ?`, wallet)?.sets ?? 0;
  const computedSets = myGrid(db, wallet).completedSets;
  return {
    tokenStakes, chipStakes,
    setBonus: { onChainSets, computedSets, multBps: setBonusMultBps(onChainSets), syncPending: onChainSets !== computedSets },
    totalPendingMicro: total.toString(),
    pendingEstimated: true,
  };
}

export function validateEstimate(body: unknown): { amountCgMicro: bigint; tier: number } {
  const b = (body ?? {}) as { amountCgMicro?: unknown; tier?: unknown };
  const tier = Number(b.tier);
  if (!Number.isInteger(tier) || tier < 0 || tier > 3) throw new ServiceError(400, 'bad_tier', 'tier must be 0..3 (flex / 30 d / 90 d / 180 d)');
  let amount: bigint;
  try { amount = BigInt(String(b.amountCgMicro ?? '')); } catch { throw new ServiceError(400, 'bad_amount', 'amountCgMicro must be an integer string'); }
  if (amount <= 0n || amount > 1_000_000_000n * MICRO) throw new ServiceError(400, 'bad_amount', 'amountCgMicro out of range');
  return { amountCgMicro: amount, tier };
}

export function estimate(db: Db, req: { amountCgMicro: bigint; tier: number }) {
  const e = latestEmissionDay(db);
  const p = poolTotals(db);
  const tokenBudget = (e.guardedMicro * BigInt(EMISSION_SPLIT.tokenStaking)) / 100n;
  const tier = TIERS[req.tier];
  const amountCg = Number(req.amountCgMicro) / 1e6;
  const apy = impliedApy(amountCg, tier, Number(p.tokenWeight) / 1e6, Number(tokenBudget) / 1e6);
  const dailyMicro = BigInt(Math.floor((amountCg * apy) / 100 / 365 * 1e6));
  const def = LOCK_TIERS[tier];
  return {
    apyPct: Number(apy.toFixed(2)), dailyCgMicro: dailyMicro.toString(), unlockAt: new Date((now() + def.lockSeconds) * 1000).toISOString(),
    earlyExitPenaltyBps: def.earlyExitPenaltyBps, boostBps: Math.round(def.boost * 10_000), minStakeCgMicro: (10n * MICRO).toString(),
    indicativeApyRange: def.targetApyRange, emissionSource: e.source,
  };
}

export const chipLevelMult = levelMult;
