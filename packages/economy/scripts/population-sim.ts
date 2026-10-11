// =============================================================================
// GUTTERCAPS economy — steady-state population model (read-only report)
// -----------------------------------------------------------------------------
// Question: at N daily players, how much $CG does the economy mint, how much
// does a player earn from staking, and how many days of staking buy a pack?
//
// The model mirrors `dailyFlows()` in tokenomics.ts (same sinks, same split,
// same fixed-point guard iteration) but makes two things explicit parameters:
//   - floorShare  (the guard floor; the code value is EMISSION_GUARD.floorShare)
//   - spending    "market" = pack buyers also buy $CG on the market (the code
//                 baseline, payerCgPackShare 0.35); "closed" = no market $CG,
//                 only in-game earnings can be spent.
// Staking pool budgets come from EMISSION_SPLIT; per-wallet claim caps come
// from STAKE_CLAIM_CAPS (= programs/staking state.rs take_daily_cap).
//
// Everything marked ASSUMPTION is a placeholder for the team to replace.
// Steady state, year-0 schedule only. Not a forecast.
//
// Run: node --experimental-strip-types scripts/population-sim.ts
// =============================================================================

import {
  BASELINE_ASSUMPTIONS, EMISSION_GUARD, EMISSION_SPLIT, FEES, FUSION_RECIPES, PACKS, STAKE_CLAIM_CAPS,
  dailyEmission, dailyFlows, guardedEmission, pvpDailyPotVolumeCg,
} from '../src/index.ts';

// ASSUMPTION: share of all players who hold and stake at least one chip / $CG.
export const CHIP_STAKER_SHARE = 0.5;
export const TOKEN_STAKER_SHARE = 0.2;
// ASSUMPTION: a pack costs this many $CG at the reference price (2 700 = Standard).
export const REFERENCE_PACK_CG = Number(PACKS.standard.priceCgMicro) / 1e6;

export type Spending = 'market' | 'closed';
export interface Scenario { n: number; floorShare: number; spending: Spending }

export interface Row {
  n: number;
  floorShare: number;
  spending: Spending;
  emissionCg: number;        // minted per day
  burnedCg: number;          // destroyed per day
  sinkRatio: number;         // burned / emitted
  cgPerPlayerDay: number;    // emission / players: everything a player can earn per day
  chipPoolCg: number;        // chip staking pool per day
  tokenPoolCg: number;       // token staking pool per day
  chipPerStakerDay: number;  // capped at STAKE_CLAIM_CAPS.chipDailyCg
  tokenPerStakerDay: number; // capped at STAKE_CLAIM_CAPS.tokenDailyCg
  stakerDaysToStandard: number; // days for a player who stakes both to earn one Standard pack
  incomeDaysToStandard: number; // days of ALL earnings to buy one Standard pack
  chipCapBinds: boolean;
  tokenCapBinds: boolean;
}

// Mirrors dailyFlows() with floorShare and spending as parameters.
export function steadyState(s: Scenario): Row {
  const a = BASELINE_ASSUMPTIONS;
  const dau = s.n;
  const cap = dailyEmission(0);
  const floorShare = s.floorShare;
  const guard = (burn: number) => Math.min(cap, floorShare * cap + EMISSION_GUARD.burnMultiple * burn);
  const payerCgPackShare = s.spending === 'market' ? a.payerCgPackShare : 0;
  const payers = dau * a.payingShare;
  const packsPerDay = (payers * a.packsPerPayerPerWeek) / 7;
  const payerCgPackSpend = packsPerDay * payerCgPackShare * REFERENCE_PACK_CG;
  const fusionBurn = dau * a.fusionsPerDauPerDay * a.avgFusionFeeCg;
  const pvpRake = pvpDailyPotVolumeCg({ ...a, dau }) * (FEES.pvpRakeBps / 10_000);
  const mktFee = dau * a.marketplaceVolumeCgPerDauPerDay * (FEES.marketplaceFeeBps / 10_000);
  const burnBps = FEES.cgPackBurnBps / 10_000;
  const rakeBurnShare = 1 - (FEES.pvpRakeTreasuryShareBps + FEES.pvpRakePoolShareBps) / 10_000;
  const mktBurnShare = FEES.marketplaceFeeBuybackShareBps / 10_000;

  let emission = cap;
  let burned = 0;
  for (let i = 0; i < 8; i++) {
    const activeIncome = emission * (EMISSION_SPLIT.quests + EMISSION_SPLIT.pvpSeason + EMISSION_SPLIT.eventsReserve) / 100;
    const stakerIncome = emission * (EMISSION_SPLIT.chipStaking + EMISSION_SPLIT.tokenStaking) / 100;
    const recycledPackSpend = activeIncome * a.activeSpendShare + stakerIncome * a.stakerSpendShare;
    const packSpend = recycledPackSpend + payerCgPackSpend;
    burned = fusionBurn + packSpend * burnBps + pvpRake * rakeBurnShare + mktFee * mktBurnShare;
    emission = guard(burned);
  }

  const chipPool = emission * EMISSION_SPLIT.chipStaking / 100;
  const tokenPool = emission * EMISSION_SPLIT.tokenStaking / 100;
  const chipStakers = Math.max(1, dau * CHIP_STAKER_SHARE);
  const tokenStakers = Math.max(1, dau * TOKEN_STAKER_SHARE);
  const chipRaw = chipPool / chipStakers;
  const tokenRaw = tokenPool / tokenStakers;
  const chipPer = Math.min(STAKE_CLAIM_CAPS.chipDailyCg, chipRaw);
  const tokenPer = Math.min(STAKE_CLAIM_CAPS.tokenDailyCg, tokenRaw);
  const stakerDay = chipPer + tokenPer;
  const perPlayer = emission / dau;

  return {
    n: dau, floorShare, spending: s.spending,
    emissionCg: emission, burnedCg: burned, sinkRatio: burned / emission,
    cgPerPlayerDay: perPlayer,
    chipPoolCg: chipPool, tokenPoolCg: tokenPool,
    chipPerStakerDay: chipPer, tokenPerStakerDay: tokenPer,
    stakerDaysToStandard: stakerDay > 0 ? REFERENCE_PACK_CG / stakerDay : Infinity,
    incomeDaysToStandard: perPlayer > 0 ? REFERENCE_PACK_CG / perPlayer : Infinity,
    chipCapBinds: chipRaw >= STAKE_CLAIM_CAPS.chipDailyCg,
    tokenCapBinds: tokenRaw >= STAKE_CLAIM_CAPS.tokenDailyCg,
  };
}

// Sybil: one player runs `wallets` staking wallets among `honestStakers` others.
// Each wallet is capped separately; the pool is shared pro-rata by wallet count.
export function farmer(s: Scenario, wallets: number, honestStakers: number) {
  const r = steadyState(s);
  const chipShare = wallets / (honestStakers + wallets);
  const tokenShare = chipShare;
  const chipTake = Math.min(wallets * STAKE_CLAIM_CAPS.chipDailyCg, r.chipPoolCg * chipShare);
  const tokenTake = Math.min(wallets * STAKE_CLAIM_CAPS.tokenDailyCg, r.tokenPoolCg * tokenShare);
  return { chipTake, tokenTake, total: chipTake + tokenTake, perWallet: (chipTake + tokenTake) / wallets };
}

// Sanity check: must reproduce dailyFlows() at 5 000 DAU with the code's own parameters.
export function checkAgainstDailyFlows(): void {
  const ref = dailyFlows(BASELINE_ASSUMPTIONS, 0);
  const mine = steadyState({ n: BASELINE_ASSUMPTIONS.dau, floorShare: EMISSION_GUARD.floorShare, spending: 'market' });
  const ok = Math.round(mine.emissionCg) === ref.emissionCg && Math.round(mine.burnedCg) === ref.burnedCg;
  if (!ok) throw new Error(`population-sim disagrees with dailyFlows: ${JSON.stringify({ ref, mine })}`);
}

const fmt = (x: number) => (Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : '∞');
const fmt1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '∞');

export function renderMarkdown(): string {
  const ns = [100, 300, 600, 1200, 2400];
  const floors = [EMISSION_GUARD.floorShare, 0.05, 0.10];
  const spends: Spending[] = ['market', 'closed'];
  const out: string[] = [];
  out.push('| Spending | Floor | Players | Emit CG/day | Burn CG/day | Emit per player/day | Chip pool/day | Token pool/day | Chip per staker/day | Token per staker/day | Days of staking → Standard (2 700 CG) | Days of all income → Standard | Chip cap binds | Token cap binds |');
  out.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const sp of spends) for (const f of floors) for (const n of ns) {
    const r = steadyState({ n, floorShare: f, spending: sp });
    out.push(`| ${sp} | ${(f * 100).toFixed(0)} % | ${n} | ${fmt(r.emissionCg)} | ${fmt(r.burnedCg)} | ${fmt1(r.cgPerPlayerDay)} | ${fmt(r.chipPoolCg)} | ${fmt(r.tokenPoolCg)} | ${fmt1(r.chipPerStakerDay)} | ${fmt1(r.tokenPerStakerDay)} | ${fmt1(r.stakerDaysToStandard)} | ${fmt1(r.incomeDaysToStandard)} | ${r.chipCapBinds ? 'yes' : 'no'} | ${r.tokenCapBinds ? 'yes' : 'no'} |`);
  }
  return out.join('\n');
}

export function renderFarmer(): string {
  const out: string[] = [];
  out.push('| Spending | Floor | Honest stakers | Farmer wallets | Farmer CG/day | Farmer share of pools | Farmer CG per wallet/day |');
  out.push('|---|---|---|---|---|---|---|');
  for (const sp of ['market', 'closed'] as Spending[]) for (const f of [EMISSION_GUARD.floorShare, 0.10]) for (const n of [300, 2400]) {
    const honest = n * CHIP_STAKER_SHARE;
    const wallets = 50;
    const s = { n, floorShare: f, spending: sp };
    const r = steadyState(s);
    const fm = farmer(s, wallets, honest);
    const poolTotal = r.chipPoolCg + r.tokenPoolCg;
    out.push(`| ${sp} | ${(f * 100).toFixed(0)} % | ${Math.round(honest)} | ${wallets} | ${fmt1(fm.total)} | ${(100 * fm.total / poolTotal).toFixed(1)} % | ${fmt1(fm.perWallet)} |`);
  }
  return out.join('\n');
}

export function renderPricing(): string {
  // For pricing: CG price of a Standard pack, expressed as days of ALL income
  // of a median player in each scenario (closed loop is the one that matters
  // when players cannot buy CG on the market).
  const out: string[] = [];
  out.push('| Players | Closed loop, floor 2 % — CG/player/day | Pack price that equals 30 days of income | Pack price that equals 60 days |');
  out.push('|---|---|---|---|');
  for (const n of [100, 300, 600, 1200, 2400]) {
    const r = steadyState({ n, floorShare: EMISSION_GUARD.floorShare, spending: 'closed' });
    out.push(`| ${n} | ${fmt1(r.cgPerPlayerDay)} | ${fmt(30 * r.cgPerPlayerDay)} CG | ${fmt(60 * r.cgPerPlayerDay)} CG |`);
  }
  return out.join('\n');
}

export function renderFusion(): string {
  // Fee-only cost of one rarity-8 chip from commons: fusions k→k+1 needed = 3^(7-k).
  const fees = FUSION_RECIPES.map((r) => ({ k: r.from, count: 3 ** (7 - r.from), fee: r.feeCgMicro / 1e6 }));
  const total = fees.reduce((acc, x) => acc + x.count * x.fee, 0);
  const commons = 3 ** 8;
  return `One rarity-8 chip from commons: ${commons.toLocaleString('en-US')} commons, ${fmt(total)} CG of fusion fees (burned). At the per-wallet staking cap of ${STAKE_CLAIM_CAPS.chipDailyCg + STAKE_CLAIM_CAPS.tokenDailyCg} CG/day that is ${fmt(total / (STAKE_CLAIM_CAPS.chipDailyCg + STAKE_CLAIM_CAPS.tokenDailyCg))} days.`;
}

// What emission would make a Standard pack cost D days of an average player's income?
export function renderRequired(): string {
  const cap = dailyEmission(0);
  const out: string[] = [];
  out.push('| Players | Emission needed for Standard = 30 days (CG/day) | % of year-0 cap | Emission needed for 60 days (CG/day) | % of year-0 cap | Floor 2 % (CG/day) |');
  out.push('|---|---|---|---|---|---|');
  for (const n of [100, 300, 600, 1200, 2400]) {
    const e30 = (n * REFERENCE_PACK_CG) / 30;
    const e60 = (n * REFERENCE_PACK_CG) / 60;
    out.push(`| ${n} | ${fmt(e30)} | ${(100 * e30 / cap).toFixed(1)} % | ${fmt(e60)} | ${(100 * e60 / cap).toFixed(1)} % | ${fmt(EMISSION_GUARD.floorShare * cap)} |`);
  }
  return out.join('\n');
}

{
  checkAgainstDailyFlows();
  console.log('## Steady state by player count\n');
  console.log(renderMarkdown());
  console.log('\n## Sybil: 50 wallets of one farmer\n');
  console.log(renderFarmer());
  console.log('\n## Pricing, closed loop\n');
  console.log(renderPricing());
  console.log('\n## Emission required for a 30 / 60-day pack price\n');
  console.log(renderRequired());
  console.log('\n## Fusion cost\n');
  console.log(renderFusion());
  console.log(`\nPvP pot volume at 5 000 DAU: ${fmt(pvpDailyPotVolumeCg())} CG/day; guard saturates at burn ≥ ${fmt((dailyEmission(0) * (1 - EMISSION_GUARD.floorShare)) / EMISSION_GUARD.burnMultiple)} CG/day.`);
}
