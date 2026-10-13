// Population sim — Floodgrid cohort (docs/13 stage F).
//
// Question: if a cohort plays ONLY the Floodgrid loop, how much free value can it extract
// per week relative to a median payer (2 Standard packs/week)? The invariant is freeShare <= 20%.
//
// The sim deliberately computes two bounds from the live economy tables (never hard-coded rewards):
//   1. grid-only: only Floodgrid quest faucets (d_grid1 daily + w_grid10 weekly). The permanent
//      milestone p_grid_depth1 is one-time, so it is excluded from the steady-state week and
//      reported separately amortized over a 10-week route.
//   2. quest-upper: a grid player who also completes every other $CG daily/weekly quest — the
//      absolute quest-faucet ceiling under the daily/weekly caps. This overstates a "grid-only"
//      cohort on purpose; if even this passes, the grid cohort cannot break the invariant.
// $CG is converted to pack value exactly like faucets.freeValueReport: 2700 $CG ~ one Standard
// pack, and the paid baseline is two Standard packs of expected value per week.
import { ANTI_FARM, DAILY_QUESTS, PACKS, WEEKLY_QUESTS, packExpectedValueMult } from '../packages/economy/src/index.ts';

const CG_PER_STANDARD_PACK = 2700;
const paidCommonsPerWeek = 2 * packExpectedValueMult(PACKS.standard);
const cgToCommons = (cgPerWeek: number) => (cgPerWeek / CG_PER_STANDARD_PACK) * (paidCommonsPerWeek / 2);
const shareOf = (cgPerWeek: number) => cgToCommons(cgPerWeek) / paidCommonsPerWeek;

const byId = (id: string) => [...DAILY_QUESTS, ...WEEKLY_QUESTS].find((q) => q.id === id);
const gridDaily = byId('d_grid1');
const gridWeekly = byId('w_grid10');
const gridMilestone = byId('p_grid_depth1');
if (!gridDaily || !gridWeekly) throw new Error('Floodgrid quests missing from economy tables');

const gridOnlyCg = (gridDaily.rewardCgMicro * 7 + gridWeekly.rewardCgMicro) / 1e6;
const milestoneAmortizedCg = gridMilestone ? (gridMilestone.rewardCgMicro / 1e6) / 10 : 0;

const allDailyCg = DAILY_QUESTS.reduce((s, q) => s + q.rewardCgMicro, 0) / 1e6;
const allWeeklyCg = WEEKLY_QUESTS.reduce((s, q) => s + q.rewardCgMicro, 0) / 1e6;
const uncappedQuestCg = allDailyCg * 7 + allWeeklyCg;
const cappedQuestCg = Math.min(
  uncappedQuestCg,
  (ANTI_FARM.dailyQuestRewardCapCgMicro / 1e6) * 7 + ANTI_FARM.weeklyQuestRewardCapCgMicro / 1e6,
);

const rows = [
  { cohort: 'grid-only (steady week)', cgPerWeek: gridOnlyCg, freeShare: shareOf(gridOnlyCg) },
  { cohort: 'grid-only + milestone amortized /10w', cgPerWeek: gridOnlyCg + milestoneAmortizedCg, freeShare: shareOf(gridOnlyCg + milestoneAmortizedCg) },
  { cohort: 'quest-upper (all $CG quests, capped)', cgPerWeek: cappedQuestCg, freeShare: shareOf(cappedQuestCg) },
];
console.table(rows.map((r) => ({ ...r, cgPerWeek: +r.cgPerWeek.toFixed(2), freeShare: +(r.freeShare * 100).toFixed(2) + '%' })));
console.log(`paid baseline: 2 Standard packs/week = ${paidCommonsPerWeek.toFixed(3)} Common-EV; daily cap ${ANTI_FARM.dailyQuestRewardCapCgMicro / 1e6} $CG, weekly cap ${ANTI_FARM.weeklyQuestRewardCapCgMicro / 1e6} $CG`);

let failed = false;
for (const r of rows) {
  const ok = r.freeShare <= 0.2;
  if (!ok) failed = true;
  console.log(`${ok ? '✓' : '✗'} ${r.cohort}: free share ${(r.freeShare * 100).toFixed(2)}% <= 20%`);
}
if (failed) process.exit(1);
console.log('POPULATION SIM OK: a Floodgrid-only cohort stays within the free-value invariant.');
