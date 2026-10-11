// =============================================================================
// GUTTERCAPS economy — proposed pricing/emission policy, steady state (read-only)
// -----------------------------------------------------------------------------
// Proposal under review (NOT applied to code): see reports/TOKEN-POLICY-PROPOSAL-2026-10-11.md
//
// Rules modelled:
//   - Quote peg: CG per $1 (PEG). Every CG price = USD price x PEG.
//   - Emission rule:  E = f * N + m * B   (B = CG burned per day)
//       m = 1.0 (code: 1.25), f = inflation budget per player per day (code: 2 % of schedule, absolute).
//   - Income per player:  I = E / N.  With spend per player sigma (CG burned per player per day):
//       I = f + m * sigma   (sigma does not depend on I here; a proportional term is in `propShare`)
//   - Staking: pools = I*N*20 % (chips) and I*N*5 % (tokens) split across stakers
//       chip staker  = min(30, 0.2*I*N / (0.5*N))  = min(30, 0.4 I)
//       token staker = min(15, 0.05*I*N / (0.2*N)) = min(15, 0.25 I)
//     (stakers shares 50 % / 20 % are ASSUMPTIONS, as in population-sim.ts)
//   - Days to a full Standard pack = packCg / (chip + token staker income).
//   - Capacity: E must fit the emission schedule of the year (dailyEmission(year)).
//
// Run: node --experimental-strip-types scripts/policy-sim.ts
// =============================================================================

import { STAKE_CLAIM_CAPS, dailyEmission, FUSION_RECIPES, PACKS, SERVICES } from '../src/index.ts';

export const PEG = 45;                       // CG per $1 (working quote, must be set vs market price at TGE)
export const STANDARD_USD = 5.99;
export const STANDARD_CG = Math.round(STANDARD_USD * PEG); // 270
export const CHIP_STAKER_SHARE = 0.5;        // ASSUMPTION
export const TOKEN_STAKER_SHARE = 0.2;       // ASSUMPTION
export const CHIP_SPLIT = 0.2;               // EMISSION_SPLIT.chipStaking
export const TOKEN_SPLIT = 0.05;             // EMISSION_SPLIT.tokenStaking

export interface Policy {
  name: string;
  f: number;                 // inflation budget, CG per player per day
  m: number;                 // burn multiple in the emission rule
  sigma: number;             // CG burned per player per day (fixed part, from spend)
  packBurnShare: number;     // share of CG pack price that is burned
}

export interface Row {
  n: number; I: number; E: number; B: number; burnShare: number;
  chipPer: number; tokenPer: number; stakerIncome: number; daysToPack: number;
  capacityYear0: number;     // E / schedule year 0
  capacityYear4: number;     // E / schedule year 4 (8 % of play bucket)
  inflationPctYear: number;  // net issuance per year, % of the 1 B hard cap
  packsPerWeekPerPlayer: number;
}

// Spend per player per day, in CG, as a function of the policy's spend assumptions.
export function sigmaFromSpend(p: { packsPerWeek: number; packBurnShare: number; rankedEntryCg: number; matchesPerDay: number; fusionCgPerDay: number; cosmeticsCgPerDay: number; seasonPassCgPerDay: number }) {
  const packs = (p.packsPerWeek / 7) * STANDARD_CG * p.packBurnShare;
  const entry = p.rankedEntryCg * p.matchesPerDay;
  return packs + entry + p.fusionCgPerDay + p.cosmeticsCgPerDay + p.seasonPassCgPerDay;
}

export function solve(n: number, pol: Policy): Row {
  // I = f + m * sigma  (closed form, sigma fixed per player)
  const I = pol.f + pol.m * pol.sigma;
  const E = I * n;
  const B = pol.sigma * n;
  const chipPer = Math.min(STAKE_CLAIM_CAPS.chipDailyCg, (CHIP_SPLIT * I * n) / (CHIP_STAKER_SHARE * n));
  const tokenPer = Math.min(STAKE_CLAIM_CAPS.tokenDailyCg, (TOKEN_SPLIT * I * n) / (TOKEN_STAKER_SHARE * n));
  const stakerIncome = chipPer + tokenPer;
  const cap0 = dailyEmission(0);
  const cap4 = dailyEmission(4);
  return {
    n, I, E, B, burnShare: B / E,
    chipPer, tokenPer, stakerIncome,
    daysToPack: stakerIncome > 0 ? STANDARD_CG / stakerIncome : Infinity,
    capacityYear0: E / cap0,
    capacityYear4: E / cap4,
    inflationPctYear: ((E - B) * 365 / 1_000_000_000) * 100,
    packsPerWeekPerPlayer: 0,
  };
}

// The proposed spend profile: one Standard pack per week for every player + ranked entries.
export const PROPOSAL_SPEND = {
  packsPerWeek: 1,
  packBurnShare: 1.0,        // was 0.75 (25 % to treasury)
  rankedEntryCg: 5,          // new: burned entry fee per ranked match
  matchesPerDay: 2,          // baseline from BASELINE_ASSUMPTIONS.pvpMatchesPerDauPerDay
  fusionCgPerDay: 1,         // baseline 0.1 fusions/day x 10 CG, fees /10 under the proposal would be 0.1 x 1 = 0.1; kept at 1 as a margin
  cosmeticsCgPerDay: 3,      // services/cosmetics in CG (USD x PEG), assumption
  seasonPassCgPerDay: 3.2,   // 450 CG per 6 weeks x 30 % of players, assumption
};

export const PROPOSAL: Policy = {
  name: 'proposal (m=1, f=12, full pack burn, entry fee)',
  f: 12,
  m: 1.0,
  sigma: sigmaFromSpend(PROPOSAL_SPEND),
  packBurnShare: 1.0,
};

// Same policy, but players buy one pack every 2 weeks (half the spend) — stress test.
export const LOW_SPEND: Policy = { ...PROPOSAL, name: 'stress: half the pack spend', sigma: sigmaFromSpend({ ...PROPOSAL_SPEND, packsPerWeek: 0.5 }) };

// Current code (for reference): m = 1.25, 2 % of schedule floor, pack burn 75 %, pack price 2 700 CG.
export const CURRENT_PACK_CG = 2700;

export function renderTable(pol: Policy, label: string): string {
  const rows = [100, 300, 600, 1200, 2400].map((n) => solve(n, pol));
  const f = (x: number, d = 0) => (Number.isFinite(x) ? x.toLocaleString('en-US', { maximumFractionDigits: d }) : '∞');
  const out: string[] = [];
  out.push(`### ${label}`);
  out.push(`sigma = ${f(pol.sigma, 1)} CG/player/day burned; f = ${pol.f}; m = ${pol.m}; pack = ${STANDARD_CG} CG`);
  out.push('');
  out.push('| Players | Income CG/player/day | Emission CG/day | Burn CG/day | Burn / emission | Chip staker /day | Token staker /day | Days of staking to pack | Capacity vs schedule, year 0 | Capacity vs schedule, year 4 | Net issuance %/yr of 1 B |');
  out.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    out.push(`| ${r.n} | ${f(r.I, 1)} | ${f(r.E)} | ${f(r.B)} | ${f(100 * r.burnShare, 0)} % | ${f(r.chipPer, 1)} | ${f(r.tokenPer, 1)} | ${f(r.daysToPack, 1)} | ${f(100 * r.capacityYear0, 0)} % | ${f(100 * r.capacityYear4, 0)} % | ${f(r.inflationPctYear, 2)} % |`);
  }
  return out.join('\n');
}

export function renderStakingBand(): string {
  const out: string[] = ['| Income CG/player/day | Chip staker | Token staker | Days to a 270-CG pack |', '|---|---|---|---|'];
  for (const I of [40, 50, 60, 70, 80]) {
    const c = Math.min(STAKE_CLAIM_CAPS.chipDailyCg, CHIP_SPLIT * I / CHIP_STAKER_SHARE);
    const t = Math.min(STAKE_CLAIM_CAPS.tokenDailyCg, TOKEN_SPLIT * I / TOKEN_STAKER_SHARE);
    out.push(`| ${I} | ${c.toFixed(1)} | ${t.toFixed(1)} | ${(STANDARD_CG / (c + t)).toFixed(1)} |`);
  }
  return out.join('\n');
}

export function renderFusion(): string {
  const out: string[] = ['| Step | Fee now (CG) | Fee at peg 45 (CG, /10) | Days of income at I = 60 (proposal) |', '|---|---|---|---|'];
  for (const r of FUSION_RECIPES) {
    const now = r.feeCgMicro / 1e6;
    const prop = now / 10;
    out.push(`| ${r.from}→${r.from + 1} | ${now.toLocaleString('en-US')} | ${prop.toLocaleString('en-US', { maximumFractionDigits: 1 })} | ${(prop / 60).toFixed(2)} |`);
  }
  return out.join('\n');
}

export function renderPrices(): string {
  // Source of truth: packs.ts + services.ts. Services: 1 US cent = 1 CG today (services.ts).
  const rows: [string, number, number | null][] = [
    ['Standard pack', PACKS.standard.priceUsdCents / 100, PACKS.standard.priceCgMicro! / 1e6],
    ['Premium pack', PACKS.premium.priceUsdCents / 100, PACKS.premium.priceCgMicro! / 1e6],
    ...SERVICES.filter((s) => s.priceUsdCents > 0 && s.id !== 'booster').map((s): [string, number, number] => [s.name, s.priceUsdCents / 100, s.priceUsdCents]),
  ];
  const out: string[] = ['| Item | USD (code) | CG now (code) | CG per $1 now | CG under the peg |', '|---|---|---|---|---|'];
  for (const [name, usd, cg] of rows) {
    const perUsd = cg === null ? '—' : Math.round(cg / usd).toLocaleString('en-US');
    const under = Math.round(usd * PEG).toLocaleString('en-US');
    out.push(`| ${name} | $${usd.toFixed(2)} | ${cg === null ? 'SOL/USDC only' : cg.toLocaleString('en-US')} | ${perUsd} | ${under} |`);
  }
  return out.join('\n');
}

// Scenario grid: how the 5–7-day target depends on real spend and on the inflation budget f.
// Spend scenarios (CG burned per player per day):
//   proposal:  1 Standard pack/week for EVERY player + ranked entries + fusion + cosmetics + pass
//   payers:    baseline payers only (8 % buy 3 packs/week) at the new 270-CG price + entries + fusion + cosmetics
export const SPEND_PAYERS = { packsPerWeek: 0.08 * 3, packBurnShare: 1.0, rankedEntryCg: 5, matchesPerDay: 2, fusionCgPerDay: 1, cosmeticsCgPerDay: 1.5, seasonPassCgPerDay: 0 };
export function renderGrid(): string {
  const scen: [string, number][] = [
    ['proposal (1 pack/wk all)', sigmaFromSpend(PROPOSAL_SPEND)],
    ['payers only (8 % x 3 packs/wk)', sigmaFromSpend(SPEND_PAYERS)],
  ];
  const out: string[] = ['| Spend scenario | sigma CG/day | f (floor per player) | Income I | Days to 270-CG pack | Capacity vs schedule, year 4 at 600 / 2 400 players |', '|---|---|---|---|---|---|'];
  for (const [name, sg] of scen) {
    for (const f of [12, 20, 30]) {
      const r6 = solve(600, { name, f, m: 1, sigma: sg, packBurnShare: 1 });
      const r24 = solve(2400, { name, f, m: 1, sigma: sg, packBurnShare: 1 });
      out.push(`| ${name} | ${sg.toFixed(1)} | ${f} | ${r6.I.toFixed(1)} | ${r6.daysToPack.toFixed(1)} | ${(100 * r6.capacityYear4).toFixed(0)} % / ${(100 * r24.capacityYear4).toFixed(0)} % |`);
    }
  }
  return out.join('\n');
}

{
  console.log('## Scenario grid (5-7 day target)\n');
  console.log(renderGrid());
  console.log('\n## Proposed policy, steady state\n');
  console.log(renderTable(PROPOSAL, 'Proposal'));
  console.log('\n' + renderTable(LOW_SPEND, 'Stress: half the pack spend'));
  console.log('\n## Staking band (days to a 270-CG pack vs income)\n');
  console.log(renderStakingBand());
  console.log('\n## Prices at peg ' + PEG + ' CG/$\n');
  console.log(renderPrices());
  console.log('\n## Fusion fees, peg /10\n');
  console.log(renderFusion());
}
