// Run: node --experimental-strip-types packages/economy/scripts/report.ts
// Prints every table used in docs/02-economy.md and asserts the invariants
// the economy relies on. Exit code 1 on any violated invariant.

import {
  RARITY_PROFILES, PACKS, BUNDLES, bundlePriceCents, packExpectedValueMult, probabilityAtLeast,
  effectiveOdds, FUSION_RECIPES, expectedBurn, commonsPerTier, fusionParityReport, impliedCommonFloorUsd,
  LOCK_TIERS, fullSetBonusMult, impliedApy, dailyEmission, EMISSION_SPLIT, dailyFlows, MODELLED_TOKEN_TVL_CG, MODELLED_AVG_BOOST,
  BASELINE_ASSUMPTIONS, matchWinProbability, MATCHMAKING, freeValueReport, ANTI_FARM,
  SKR_POOL_FUNDING, SKR_POOL_SPLIT, SKR_ANTI_FARM, BASELINE_SKR_ASSUMPTIONS, skrPoolMonthlyFunding, weeklySkrQuestCapUsd, REWARD_ROOT_KINDS, isSkrRootKind,
} from '../src/index.ts';

let failures = 0;
const check = (cond: boolean, msg: string) => { if (!cond) { failures++; console.error('  ✗ INVARIANT', msg); } else console.log('  ✓', msg); };
const pct = (x: number, d = 2) => `${(x * 100).toFixed(d)}%`;

console.log('\n=== 1. RARITY LADDER ===');
console.table(RARITY_PROFILES.map((p) => ({ tier: p.name, valueMult: p.valueMult, basePower: p.basePower, maxLevel: p.maxLevel, stakeWeight: p.stakeWeight, vfx: p.vfxTier, rim: p.rim })));

console.log('\n=== 2. PACKS ===');
const commonFloorUsd = impliedCommonFloorUsd();
console.log(`  Implied Common floor (Standard EV = 65% of price): $${commonFloorUsd.toFixed(4)}`);
for (const pack of Object.values(PACKS)) {
  const sum = pack.oddsBps.reduce((a, b) => a + b, 0);
  check(sum === 10_000, `${pack.id}: odds sum to 10 000 (got ${sum})`);
  const ev = packExpectedValueMult(pack);
  const evUsd = ev * commonFloorUsd;
  const ratio = evUsd / (pack.priceUsdCents / 100);
  console.log(`  ${pack.name}: ${pack.chips} chips, $${(pack.priceUsdCents / 100).toFixed(2)}  EV=${ev.toFixed(2)} Common-eq  (≈$${evUsd.toFixed(2)} → ${pct(ratio, 0)} of price)`);
  console.log(`     P(≥Rare)=${pct(probabilityAtLeast(pack, 2))}  P(≥Epic)=${pct(probabilityAtLeast(pack, 4))}  P(≥Legend)=${pct(probabilityAtLeast(pack, 6), 3)}  P(Diamond)=${pct(probabilityAtLeast(pack, 8), 3)}`);
  if (pack.id === 'starter') check(ratio > 1, `${pack.id}: starter is intentionally +EV (acquisition cost) (got ${pct(ratio, 0)})`);
  else if (pack.id === 'limited') check(ratio >= 0.28 && ratio <= 0.40, `${pack.id}: documented exception — sells featured access + purchase perks (PACK_PERKS), not EV; band [28%,40%] (got ${pct(ratio, 0)})`);
  else check(ratio >= 0.55 && ratio <= 0.75, `${pack.id}: EV/price in [55%,75%] (got ${pct(ratio, 0)})`);
  if (pack.id !== 'starter') check(probabilityAtLeast(pack, 6 as never) === 0, `${pack.id}: no Legend/Legend+/Diamond from packs — fusion only`);
}
console.log('\n  Odds table (bps per slot):');
console.table(Object.fromEntries(Object.values(PACKS).map((p) => [p.id, Object.fromEntries(p.oddsBps.map((b, i) => [RARITY_PROFILES[i].name, `${(b / 100).toFixed(2)}%`]))])));

const std = PACKS.standard;
const pityTier = std.pity!.tier;
console.log(`\n  Pity curve (standard pack, P(≥tier ${pityTier} = ${RARITY_PROFILES[pityTier].name}) per pack by counter):`);
for (const c of [0, 29, 30, 40, 50, 59]) {
  const o = effectiveOdds(std, c);
  const pSlot = o.slice(pityTier).reduce((a, b) => a + b, 0) / 10_000;
  console.log(`     counter=${c.toString().padStart(2)} → per-slot ${pct(pSlot, 2)}  per-pack ${pct(1 - Math.pow(1 - pSlot, std.chips), 2)}${c + 1 >= std.pity!.hardAt ? '  (HARD PITY → 100%)' : ''}`);
  check(o.reduce((a, b) => a + b, 0) === 10_000, `pity odds still sum to 10 000 at counter=${c}`);
}

console.log('\n  Bundles (standard):');
for (const b of BUNDLES) console.log(`     ×${b.qty}: $${(bundlePriceCents(std, b.qty) / 100).toFixed(2)}  (-${b.discountBps / 100}%)`);

console.log('\n=== 3. FUSION ===');
console.table(FUSION_RECIPES.map((r) => ({
  recipe: `${RARITY_PROFILES[r.from].name} → ${RARITY_PROFILES[r.to].name}`,
  burn: r.materials, rule: r.rule, success: `${r.successBps / 100}%`, refundOnFail: r.refundOnFail,
  feeCg: r.feeCgMicro / 1e6, 'E[burn]': +expectedBurn(r).toFixed(2), 'E[burn] boosted': +expectedBurn(r, true).toFixed(2),
  lockH: r.resultLockSeconds / 3600,
})));
console.log('  Per-step parity: value(N+1)/value(N) vs E[burn] — [0.8, 1.0]; the god step is a documented exception');
console.table(fusionParityReport());
for (const row of fusionParityReport()) {
  // Legend+ → Diamond is deliberately WORSE than parity (the "god tax": 40% success +
  // 200 000 $CG fee + max-level materials). Crafting a Diamond must never be the cheap
  // route — band [0.7, 0.85] pins it as a tax, not a typo.
  const top = row.step.startsWith('Legend+');
  const lo = top ? 0.7 : 0.8;
  const hi = top ? 0.85 : 1.0;
  check(row.parity >= lo && row.parity <= hi, `${row.step}: parity in [${lo},${hi}] (got ${row.parity})`);
}
console.log(`  Commons needed for one Diamond via pure fusion: ${commonsPerTier(8).toFixed(0)}  (boosted every step: ${commonsPerTier(8, true).toFixed(0)})`);
console.log(`  → at the implied floor that is ≈ $${(commonsPerTier(8) * commonFloorUsd).toFixed(0)} of Commons, or ${(commonsPerTier(8) / packExpectedValueMult(PACKS.standard)).toFixed(0)} Standard packs' worth of EV.`);

console.log('\n=== 4. STAKING ===');
console.table(Object.values(LOCK_TIERS).map((t) => ({ tier: t.id, lockDays: t.lockSeconds / 86_400, boost: t.boost, earlyExitPenalty: `${t.earlyExitPenaltyBps / 100}%`, targetApy: `${t.targetApyRange[0]}–${t.targetApyRange[1]}%` })));
const y1daily = dailyEmission(0);
const tokenPoolDaily = (y1daily * EMISSION_SPLIT.tokenStaking) / 100;
const modelledWeight = MODELLED_TOKEN_TVL_CG * MODELLED_AVG_BOOST;
console.log(`  Y1 daily emission ${y1daily.toFixed(0)} $CG; token-staking pool ${tokenPoolDaily.toFixed(0)} $CG/day; modelled TVL ${(MODELLED_TOKEN_TVL_CG / 1e6).toFixed(0)}M $CG`);
for (const t of Object.values(LOCK_TIERS)) {
  const apy = impliedApy(10_000, t.id, modelledWeight, tokenPoolDaily);
  console.log(`     ${t.id.padEnd(5)} implied APY @ modelled TVL: ${apy.toFixed(1)}%   (@ half TVL: ${impliedApy(10_000, t.id, modelledWeight / 2, tokenPoolDaily).toFixed(1)}%, @ 2x TVL: ${impliedApy(10_000, t.id, modelledWeight * 2, tokenPoolDaily).toFixed(1)}%)`);
  check(apy >= t.targetApyRange[0] && apy <= t.targetApyRange[1], `${t.id}: modelled APY inside published band ${t.targetApyRange[0]}–${t.targetApyRange[1]}%`);
}
console.log(`  Full-set bonus: 1 set ${fullSetBonusMult(1)}x · 5 sets ${fullSetBonusMult(5)}x · 10 sets ${fullSetBonusMult(10).toFixed(2)}x`);

console.log('\n=== 5. TOKENOMICS FLOWS (baseline: 5 000 DAU, year 1) ===');
const flows = dailyFlows(BASELINE_ASSUMPTIONS, 0);
console.table([flows]);
check(flows.sinkRatio >= 0.5, `sinks absorb ≥50% of daily emission at baseline (got ${flows.sinkRatio})`);
console.log('  Sensitivity (DAU → guarded emission / sink ratio / net inflation):');
for (const dau of [1_000, 5_000, 20_000, 50_000]) {
  const f = dailyFlows({ ...BASELINE_ASSUMPTIONS, dau }, 0);
  console.log(`     ${dau.toString().padStart(6)} DAU → emission ${f.emissionCg.toString().padStart(7)} (cap ${f.scheduleCapCg})  sink ${f.sinkRatio}  net +${f.netInflationCg}/day  per-DAU ${f.perDauEmission} $CG/day`);
}
console.log('  Year-by-year schedule cap (per day):', [0,1,2,3,4].map((y) => `Y${y+1} ${Math.round(dailyEmission(y)).toLocaleString('en')}`).join(' · '));

console.log('\n=== 6. PVP ===');
for (const r of [1.0, 1.1, 1.2, 1.35, 1.5]) console.log(`  power ratio ${r.toFixed(2)} → P(win match) = ${pct(matchWinProbability(r * 1000, 1000), 1)}`);
check(matchWinProbability(1350, 1000) < 0.95, 'a 1.35x power edge does not exceed 95% win rate (upsets remain possible)');
console.log(`  Leagues: ${MATCHMAKING.leagueNames.join(' < ')}`);

console.log('\n=== 7. FREE SOURCES vs PAID (median payer = 2 Standard packs / week) ===');
const fv = freeValueReport(2 * packExpectedValueMult(PACKS.standard));
console.table([fv]);
check(fv.freeShare <= 0.2, `free value (chips + $CG→packs) ≤ 20% of a median payer's weekly pack value (got ${pct(fv.freeShare, 1)})`);
console.log(`  Hard caps: ${ANTI_FARM.freeChipsPerWalletPerWeek} free chips / wallet / week, daily quest $CG cap ${ANTI_FARM.dailyQuestRewardCapCgMicro / 1e6} $CG`);

console.log('\n=== 8. SKR PRIZE POOL (reward currency #2 — funded from SKR revenue, never minted) ===');
const skr = skrPoolMonthlyFunding(BASELINE_SKR_ASSUMPTIONS);
console.table([{ ...skr.breakdownUsd, skrRevenueUsd: skr.skrRevenueUsd, poolUsd: skr.poolUsd, poolSkr: skr.poolSkr, weeklyPoolSkr: skr.weeklyPoolSkr, giveBackShare: skr.giveBackShare }]);
console.log(`  Split: quests ${SKR_POOL_SPLIT.quests}% (${skr.split.questsSkr} SKR/mo) · season ${SKR_POOL_SPLIT.season}% (${skr.split.seasonSkr}) · events ${SKR_POOL_SPLIT.events}% (${skr.split.eventsSkr})`);
console.log(`  Funding shares: packs ${SKR_POOL_FUNDING.packRevenueShareBps / 100}% · market fee (treasury part) ${SKR_POOL_FUNDING.marketFeeTreasuryShareBps / 100}% · services ${SKR_POOL_FUNDING.servicesRevenueShareBps / 100}% — ${SKR_POOL_FUNDING.cadence}`);
console.log(`  Caps: ${SKR_ANTI_FARM.weeklyQuestCapSkr} SKR/wallet/week from quests (≈ $${weeklySkrQuestCapUsd().toFixed(2)}), ${SKR_ANTI_FARM.seasonCapSkr} SKR/wallet/season, root ≤ ${SKR_ANTI_FARM.maxRootBudgetMicro / 1e6} SKR, paid pack + 7 d age required`);
check(SKR_POOL_SPLIT.quests + SKR_POOL_SPLIT.season + SKR_POOL_SPLIT.events === 100, 'SKR pool split sums to 100');
check(skr.giveBackShare <= 0.30, `SKR give-back ≤ 30% of SKR revenue — the studio keeps the majority (got ${pct(skr.giveBackShare, 1)})`);
check(skr.giveBackShare >= 0.10, `SKR give-back ≥ 10% so the Seeker reward loop stays visible to players (owner policy 15/10/5 → ≈ 14 %; got ${pct(skr.giveBackShare, 1)})`);
check(SKR_ANTI_FARM.weeklyQuestCapSkr * 4 <= SKR_ANTI_FARM.seasonCapSkr, 'quest cap × 4 weeks fits inside the season cap');
check(weeklySkrQuestCapUsd() <= 0.2 * 2 * (PACKS.standard.priceUsdCents / 100), `weekly SKR quest cap ≤ 20% of a median payer's weekly spend (got $${weeklySkrQuestCapUsd().toFixed(2)})`);
check(skr.weeklyPoolSkr * 1e6 <= SKR_ANTI_FARM.maxRootBudgetMicro * 3, 'a baseline week fits in ≤ 3 roots under the per-root cap');
check(Object.values(REWARD_ROOT_KINDS).filter(isSkrRootKind).length === 3 && !isSkrRootKind(REWARD_ROOT_KINDS.cgEvents), 'SKR root kinds are exactly 5..7');

console.log(`\n${failures === 0 ? 'ALL INVARIANTS HOLD' : `${failures} INVARIANT(S) VIOLATED`}\n`);
process.exit(failures === 0 ? 0 : 1);
