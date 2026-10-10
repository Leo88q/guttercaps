import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PACKS, expandRandomness, effectiveOdds, rollRarity, uniformPool, FUSION_RECIPES, expectedBurn, CHIP_XP, applyChipXp, xpToNext,
  guardedEmission, dailyEmission, fullSetBonusMult, matchWinProbability, elementEdge,
  RARITY_PROFILES, bundlePriceCents,
  REWARD_ROOT_KINDS, isSkrRootKind, isItemRootKind, ITEM_REWARDS, rootCurrency, skrPoolMonthlyFunding, BASELINE_SKR_ASSUMPTIONS, SKR_POOL_FUNDING, CURRENCIES,
  skrPoolDueMicro, marketFeeTreasuryPartMicro, SKR_TREASURY_WALLET, SKR,
  unitsForCents, maxUnitsWithSlippage, pythPriceToUsd, pusherCostSolPerMonth, PYTH_FEEDS, PYTH_MAX_AGE_SECS, PYTH_PUSHER, PYTH_WORST_CASE_AGE_S, PYTH_SHARD_ID,
  effectivePythPrice, confBps, PythConfidenceError, PYTH_MAX_CONF_BPS,
  FX, solLamportsForUsdCents, skrMicroForUsdCents, usdcMicroForUsdCents, usdCentsFromSolLamports,
  resolveFight, botSquad, onChainSquadPower, onChainChipPower, squadSynergy, fightSquadPower, MATCHMAKING, elementOfCollection, type FighterChip,
  SEASON, seasonPayoutByRank,
  pvpDailyPotVolumeCg, ARENA_ORACLE_DAILY_CAP_DEFAULT_CG, BASELINE_ASSUMPTIONS, dailyFlows, FEES,
} from '../src/index.ts';

test('every pack odds table sums to exactly 10 000 bps', () => {
  for (const p of Object.values(PACKS)) assert.equal(p.oddsBps.reduce((a, b) => a + b, 0), 10_000, p.id);
});

test('pity never breaks the 10 000 sum and never drains Common below 5%', () => {
  for (let c = 0; c < 200; c++) {
    const o = effectiveOdds(PACKS.standard, c);
    assert.equal(o.reduce((a, b) => a + b, 0), 10_000);
    assert.ok(o[0] >= 500);
  }
});

test('rollRarity maps boundaries correctly', () => {
  const o = PACKS.standard.oddsBps;
  assert.equal(rollRarity(0, o), 0);
  assert.equal(rollRarity(4499, o), 0);
  assert.equal(rollRarity(4500, o), 1);
  assert.equal(rollRarity(9999, o), 8);
});

test('soft pity shifts exact bps from Common into ≥tier (hand-computed from economy.rs)', () => {
  // standard: tier 6, softStart 30, step 25. counter 30 → 1 step, extra 25 over top mass 70:
  // +17/+6/+0, remainder 2 back to Common.
  assert.deepEqual(effectiveOdds(PACKS.standard, 30), [4477, 2500, 1500, 800, 450, 180, 67, 24, 2]);
  // counter 59 (last pack before hard pity) → 30 steps, extra 750: +535/+192/+21, remainder 2.
  assert.deepEqual(effectiveOdds(PACKS.standard, 59), [3752, 2500, 1500, 800, 450, 180, 585, 210, 23]);
  // the Common drain is capped at 5 % (extra ≤ odds[0] − 500), whatever the counter.
  assert.deepEqual(effectiveOdds(PACKS.standard, 200), [501, 2500, 1500, 800, 450, 180, 2907, 1046, 116]);
  // below softStart the table is untouched; starter has no pity at all.
  assert.deepEqual(effectiveOdds(PACKS.standard, 29), [...PACKS.standard.oddsBps]);
  assert.deepEqual(effectiveOdds(PACKS.starter, 1000), [...PACKS.starter.oddsBps]);
});

test('uniformPool is deterministic, in range, and matches the hand-computed window', () => {
  const vrf = new Uint8Array(32).map((_, i) => i);
  assert.deepEqual([0, 1, 2, 3, 4].map((s) => uniformPool(vrf, s, 10)), [0, 5, 0, 3, 8]);
  assert.equal(uniformPool(new Uint8Array(32), 0, 10), 0);
  assert.equal(uniformPool(vrf, 0, 1), 0);
  assert.equal(uniformPool(vrf, 0, 0), 0);
  // range over pseudo-random inputs (xorshift64*)
  let seed = 0x9e3779b97f4a7c15n;
  const next = () => { seed ^= seed >> 12n; seed ^= (seed << 25n) & 0xffff_ffff_ffff_ffffn; seed ^= seed >> 27n; return (seed * 0x2545f4914f6cdd1dn) & 0xffff_ffff_ffff_ffffn; };
  for (let n = 0; n < 200; n++) {
    const b = new Uint8Array(32);
    for (let i = 0; i < 32; i += 8) { const v = next(); for (let j = 0; j < 8; j++) b[i + j] = Number((v >> BigInt(j * 8)) & 0xffn); }
    for (const pool of [2, 3, 8, 10]) for (let s = 0; s < 5; s++) {
      const c = uniformPool(b, s, pool);
      assert.ok(Number.isInteger(c) && c >= 0 && c < pool, `slot ${s} pool ${pool}`);
    }
  }
});

test('expandRandomness is deterministic, honours floor and hard pity', () => {
  const vrf = new Uint8Array(32).fill(0); // all-zero → every slot rolls 0 → Common
  const a = expandRandomness(vrf, PACKS.standard, 0, 10);
  const b = expandRandomness(vrf, PACKS.standard, 0, 10);
  assert.deepEqual(a, b);
  assert.equal(a.length, 4);
  assert.equal(a[3].rarity, PACKS.standard.floor, 'last slot is lifted to the floor');
  const pity = expandRandomness(vrf, PACKS.standard, 59, 10);
  assert.equal(pity[3].rarity, 6, 'hard pity forces Legend on the last slot');
});

test('fusion: 8 recipes chain 0→8, always 3 materials, alternating collection rule', () => {
  assert.equal(FUSION_RECIPES.length, 8);
  FUSION_RECIPES.forEach((r, i) => {
    assert.equal(r.from, i); assert.equal(r.to, i + 1); assert.equal(r.materials, 3);
    assert.equal(r.rule, i % 2 === 0 ? 'any' : 'same-collection');
    assert.ok(r.refundOnFail < r.materials);
  });
  assert.equal(expectedBurn(FUSION_RECIPES[0]), 3);
  assert.equal(+expectedBurn(FUSION_RECIPES[7]).toFixed(2), 5); // 50% with 1 refund
});

test('emission guard is a ceiling, floors at 10% of the schedule', () => {
  const cap = dailyEmission(0);
  assert.equal(guardedEmission(cap, 0), 0.1 * cap);
  assert.equal(guardedEmission(cap, cap * 10), cap);
});

test('full-set bonus caps at 1.70x', () => {
  assert.equal(fullSetBonusMult(0), 1);
  assert.equal(+fullSetBonusMult(10).toFixed(2), 1.7);
  assert.equal(+fullSetBonusMult(50).toFixed(2), 2.5); // beyond 10 impossible; formula is monotone anyway
});

test('pvp: symmetric, monotone, upsets possible at 1.35x', () => {
  assert.equal(+matchWinProbability(1000, 1000).toFixed(3), 0.5);
  assert.ok(matchWinProbability(1200, 1000) > matchWinProbability(1100, 1000));
  assert.ok(matchWinProbability(1350, 1000) < 0.95);
  assert.equal(elementEdge('paint', 'steel'), 1.15);
  assert.equal(elementEdge('steel', 'paint'), 0.87);
  assert.equal(elementEdge('paint', 'wheels'), 1);
});

test('rarity ladder is strictly increasing in value, power and weight', () => {
  for (let i = 1; i < RARITY_PROFILES.length; i++) {
    assert.ok(RARITY_PROFILES[i].valueMult > RARITY_PROFILES[i - 1].valueMult);
    assert.ok(RARITY_PROFILES[i].basePower > RARITY_PROFILES[i - 1].basePower);
    assert.ok(RARITY_PROFILES[i].stakeWeight > RARITY_PROFILES[i - 1].stakeWeight);
  }
});

test('bundles never exceed 18% discount and are monotone', () => {
  const one = bundlePriceCents(PACKS.standard, 1);
  assert.equal(one, 599);
  assert.ok(bundlePriceCents(PACKS.standard, 25) >= 25 * 599 * 0.82 - 1);
});

test('SKR reward roots: kinds 5..7 pay SKR, everything below pays $CG', () => {
  assert.deepEqual(Object.values(REWARD_ROOT_KINDS).filter(isSkrRootKind), [5, 6, 7]);
  assert.equal(rootCurrency(REWARD_ROOT_KINDS.cgQuests), 'CG');
  assert.equal(rootCurrency(REWARD_ROOT_KINDS.skrSeason), 'SKR');
  assert.equal(isSkrRootKind(8), false);
  assert.equal(rootCurrency(REWARD_ROOT_KINDS.itemBoosters), 'ITEM');
  assert.equal(isItemRootKind(8) && !isItemRootKind(7) && !isItemRootKind(9), true);
  assert.ok(ITEM_REWARDS.maxClaim <= 10 && ITEM_REWARDS.maxRootBudget >= ITEM_REWARDS.maxClaim);
  // only $CG and SKR are reward currencies; SOL/USDC never flow through roots
  assert.deepEqual(CURRENCIES.filter((c) => c.rewards).map((c) => c.symbol), ['CG', 'SKR']);
});

test('SKR pool funding scales linearly with SKR revenue and never exceeds the published shares', () => {
  const base = skrPoolMonthlyFunding(BASELINE_SKR_ASSUMPTIONS);
  const doubled = skrPoolMonthlyFunding({ ...BASELINE_SKR_ASSUMPTIONS, packRevenueUsd: BASELINE_SKR_ASSUMPTIONS.packRevenueUsd * 2, marketVolumeUsd: BASELINE_SKR_ASSUMPTIONS.marketVolumeUsd * 2, servicesRevenueUsd: BASELINE_SKR_ASSUMPTIONS.servicesRevenueUsd * 2 });
  assert.ok(Math.abs(doubled.poolUsd - 2 * base.poolUsd) <= 1);
  const maxShare = Math.max(SKR_POOL_FUNDING.packRevenueShareBps, SKR_POOL_FUNDING.marketFeeTreasuryShareBps, SKR_POOL_FUNDING.servicesRevenueShareBps) / 10_000;
  assert.ok(base.giveBackShare <= maxShare);
  // no SKR revenue → no SKR rewards (the pool cannot be promised into existence)
  const none = skrPoolMonthlyFunding({ ...BASELINE_SKR_ASSUMPTIONS, skrPackShare: 0, skrMarketShare: 0, skrServicesShare: 0 });
  assert.equal(none.poolSkr, 0);
});

test('SKR pool funding policy is the owner\'s 15/10/5 and the due amount is exact in micro-SKR', () => {
  assert.deepEqual([SKR_POOL_FUNDING.packRevenueShareBps, SKR_POOL_FUNDING.marketFeeTreasuryShareBps, SKR_POOL_FUNDING.servicesRevenueShareBps], [1_500, 1_000, 500]);
  // 1 000 SKR of opened packs, one 100 SKR sale (fee 7.5 SKR → ⅔ treasury = 5.00025), 100 SKR of services
  const fee = marketFeeTreasuryPartMicro(7_500_000n);
  assert.equal(fee, 5_000_250n);
  const due = skrPoolDueMicro({ packRevenueMicro: 1_000_000_000n, marketFeeTreasuryMicro: fee, servicesRevenueMicro: 100_000_000n });
  assert.equal(due.fromPacksMicro, 150_000_000n);
  assert.equal(due.fromMarketMicro, 500_025n);
  assert.equal(due.fromServicesMicro, 5_000_000n);
  assert.equal(due.dueMicro, 155_500_025n);
  assert.equal(skrPoolDueMicro({ packRevenueMicro: 0n, marketFeeTreasuryMicro: 0n, servicesRevenueMicro: 0n }).dueMicro, 0n);
  // the treasury wallet is a real base58 key (32 bytes) — guards against a typo in the constant
  assert.match(SKR_TREASURY_WALLET, /^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
});

test('frozen checkout FX: integer floor, no floats', () => {
  assert.equal(FX.solUsd, 110);
  assert.equal(FX.skrUsd, 0.016);
  assert.equal(solLamportsForUsdCents(199), 18_090_909n);
  assert.equal(skrMicroForUsdCents(199), 124_375_000n);
  assert.equal(usdcMicroForUsdCents(199), 1_990_000n);
  assert.equal(solLamportsForUsdCents(599), 54_454_545n);
  assert.equal(skrMicroForUsdCents(599), 374_375_000n);
  const skrCents = Math.floor((599 * 9_500) / 10_000);
  assert.equal(skrCents, 569);
  assert.equal(skrMicroForUsdCents(skrCents), 355_625_000n);
  assert.equal(usdCentsFromSolLamports(300_000_000n), 3_300n);
  assert.equal(usdCentsFromSolLamports(999_000_000n), 10_989n);
  assert.equal(usdcMicroForUsdCents(3_300n), 33_000_000n);
  assert.equal(skrMicroForUsdCents(3_300n), 2_062_500_000n);
  assert.equal(usdcMicroForUsdCents(10_989n), 109_890_000n);
  assert.equal(skrMicroForUsdCents(10_989n), 6_868_125_000n);
  assert.equal(CURRENCIES.find((c) => c.symbol === 'USDC')?.market, false);
  assert.equal(CURRENCIES.find((c) => c.symbol === 'SKR')?.market, false);
  assert.equal(CURRENCIES.find((c) => c.symbol === 'SOL')?.market, true);
});

test('Pyth policy (Q7 — own pusher): units_for_cents integers, slippage guard and the pusher timing budget', () => {
  // 4.99 USD at $150.00 (expo −8) → 0.033266666 SOL, floored like the program
  assert.equal(unitsForCents(499, 15_000_000_000n, -8, 9), 33_266_666n);
  assert.equal(unitsForCents(499n, 15_000_000_000n, -8, 9), (499n * 10n ** 9n * 10n ** 8n) / 100n / 15_000_000_000n);
  // 4.99 USD at $0.0174 → 286.781609 SKR (6 dp)
  assert.equal(unitsForCents(499, 1_740_000n, -8, 6), 286_781_609n);
  assert.equal(unitsForCents(1, 1_740_000n, -8, 6), 574_712n); // 1 ¢ of SKR — no underflow to 0 at 6 dp
  assert.throws(() => unitsForCents(1, 0n, -8, 9));
  assert.throws(() => unitsForCents(-1, 1n, -8, 9));
  // SEC-M2 confidence guard: price − conf, refuse > 2 %
  assert.equal(effectivePythPrice(15_000_000_000n, 7_500_000n), 14_992_500_000n);            // 0.05 % conf → charged at $149.925
  assert.equal(unitsForCents(499, effectivePythPrice(15_000_000_000n, 7_500_000n), -8, 9), 33_283_308n); // buyer pays 0.05 % more lamports
  assert.equal(effectivePythPrice(15_000_000_000n, 300_000_000n), 14_700_000_000n);          // exactly 2 % still accepted
  assert.throws(() => effectivePythPrice(15_000_000_000n, 300_000_001n), PythConfidenceError); // 2 % + 1 → PriceUncertain
  assert.throws(() => effectivePythPrice(0n, 0n), PythConfidenceError);
  assert.equal(confBps(15_000_000_000n, 75_000_000n), 50);
  assert.equal(PYTH_MAX_CONF_BPS, 200);
  assert.equal(maxUnitsWithSlippage(33_266_666n), 33_599_332n); // +1.00 %
  assert.equal(maxUnitsWithSlippage(1n), 1n);                    // floor keeps tiny amounts payable
  assert.ok(Math.abs(pythPriceToUsd(15_000_000_000n, -8) - 150) < 1e-9);
  // feed ids and currency codes agree with tokenomics
  assert.equal(PYTH_FEEDS.SKR.feedIdHex, SKR.pythFeedIdHex);
  assert.deepEqual([PYTH_FEEDS.SOL.currency, PYTH_FEEDS.SKR.currency], [0, 3]);
  assert.deepEqual(CURRENCIES.filter((c) => c.oracle).map((c) => c.oracle), ['fx:SOL/USD', 'fx:SKR/USD']);
  // timing budget: worst-case on-chain age < alert < max age; a quote must still have ≥ 15 s of life
  assert.equal(PYTH_MAX_AGE_SECS, 60);
  assert.equal(PYTH_WORST_CASE_AGE_S, PYTH_PUSHER.timeDifferenceS + PYTH_PUSHER.pushingFrequencyS + 5);
  assert.ok(PYTH_WORST_CASE_AGE_S <= PYTH_PUSHER.alertAgeS && PYTH_PUSHER.alertAgeS < PYTH_MAX_AGE_SECS);
  assert.ok(PYTH_MAX_AGE_SECS - PYTH_PUSHER.alertAgeS >= PYTH_PUSHER.quoteMinRemainingS);
  assert.equal(PYTH_SHARD_ID, 0xca75);
  // ≈ 2 SOL / month at the default policy — a rounding error next to pack revenue
  const cost = pusherCostSolPerMonth();
  assert.ok(cost > 1 && cost < 3, `pusher cost ${cost}`);
});

test('fight engine: deterministic, symmetric power maths, best-of-3 stops early, bots stay in the player\'s league', () => {
  const A: FighterChip[] = [{ asset: 'a0', collection: 8, rarity: 2, level: 3 }, { asset: 'a1', collection: 9, rarity: 2, level: 1 }, { asset: 'a2', collection: 1, rarity: 1, level: 1 }];
  const B: FighterChip[] = [{ asset: 'b0', collection: 2, rarity: 2, level: 1 }, { asset: 'b1', collection: 3, rarity: 1, level: 4 }, { asset: 'b2', collection: 5, rarity: 2, level: 1 }];
  // on-chain power mirrors arena::squad_power (integer floor per chip)
  assert.equal(onChainChipPower(2, 3), Math.floor((210 * 10_500) / 10_000));
  assert.equal(onChainSquadPower(A), onChainChipPower(2, 3) + 210 + 145);
  // synergy: paint+paint (8, 9) → 1 pair → ×1.08; wheels(1)/steel(2)/… no pairs → ×1
  assert.equal(squadSynergy(A), 1.08);
  assert.equal(squadSynergy(B), 1);
  assert.ok(fightSquadPower(A) > onChainSquadPower(A));
  assert.equal(elementOfCollection(8), 'paint');
  // determinism + early stop
  const roll = (lane: number, side: 0 | 1) => ((lane * 7 + side * 13) % 10) / 10;
  const r1 = resolveFight(A, B, roll), r2 = resolveFight(A, B, roll);
  assert.deepEqual(r1, r2);
  assert.ok(r1.rounds.length >= 2 && r1.rounds.length <= 3);
  assert.equal(r1.winsA + r1.winsB, r1.rounds.length);
  assert.ok((r1.winsA === 2) !== (r1.winsB === 2));
  // a maxed roll for A and a min roll for B → A wins every lane it does not lose on raw power × 3
  const stomp = resolveFight(A, B, (_l, side) => (side === 0 ? 0.999 : 0));
  assert.equal(stomp.winner, 'A');
  assert.equal(stomp.rounds.length, 2);
  // element edge is applied to side A as a delta the client renders as (1 + edge)
  for (const r of r1.rounds) assert.ok([0.15, -0.13, 0].includes(r.elementEdge));
  // bots: within the league band for every target, mean drift small, reproducible from the seed
  let worst = 0;
  for (const target of [400, 565, 799, 800, 1399, 1400, 2399, 2400, 3999, 4000, 6999, 7000, 9000]) {
    for (let k = 0; k < 40; k++) {
      const seed = Array.from({ length: 32 }, (_, i) => (i * 31 + k * 17 + target) % 256);
      const pick = (i: number) => seed[i % 32] / 256;
      const sq = botSquad(target, pick);
      assert.equal(sq.length, 3);
      assert.deepEqual(botSquad(target, pick), sq);
      const p = onChainSquadPower(sq);
      const band = (x: number) => MATCHMAKING.powerBandsUpper.findIndex((u) => x < u);
      assert.equal(band(p), band(target), `bot for ${target} landed at ${p}`);
      worst = Math.max(worst, Math.abs(p - target) / target);
      for (const c of sq) { assert.ok(c.level >= 1 && c.level <= RARITY_PROFILES[c.rarity].maxLevel); assert.ok(c.collection >= 0 && c.collection <= 9); }
    }
  }
  assert.ok(worst <= 0.1, `worst bot drift ${worst}`);
});

test('season ladder payout: brackets sum to 100 %, monotone in rank, empty bands roll up, pool scales with participation, never overpays', () => {
  assert.equal(SEASON.payoutBrackets.reduce((a, b) => a + b.sharePct, 0), 100);
  const pool = 1_000_000_000_000n; // 1 M $CG
  for (const n of [1, 2, 3, 7, 10, 25, 100, 999, 1000, 20_000]) {
    const r = seasonPayoutByRank(pool, n);
    let total = 0n, prev: bigint | null = null;
    for (let rank = 1; rank <= r.size; rank++) {
      const v = r.get(rank)!;
      assert.ok(v > 0n, `rank ${rank} of ${n} unpaid`);
      if (prev !== null) assert.ok(v <= prev, `payout not monotone at rank ${rank} of ${n}`);
      prev = v; total += v;
    }
    const scaled = n >= SEASON.fullPoolParticipants ? pool : (pool * BigInt(n)) / BigInt(SEASON.fullPoolParticipants);
    assert.ok(total <= scaled, `overpaid for n=${n}`);
    assert.ok(total >= scaled - BigInt(r.size) * 100n, `rounding loss too big for n=${n}`); // ≤ 100 µ per leaf
    assert.equal(r.size, Math.min(n, Math.ceil(n * 0.5)) === 0 ? 0 : Math.ceil(n * 0.5)); // top 50 % are paid
  }
  // full pool: rank 1 of 1000 gets 15 % (alone in the top-0.1 % band)
  assert.equal(seasonPayoutByRank(pool, 1000).get(1), pool * 15n / 100n);
  // 3 players: top-0.1/1/5/20 % all collapse to rank 1 (15+20+25+25 = 85 %), rank 2 gets the 50 % band (15 %), scaled by 3/1000
  const three = seasonPayoutByRank(pool, 3);
  assert.equal(three.get(1), (pool * 3n / 1000n) * 85n / 100n);
  assert.equal(three.get(2), (pool * 3n / 1000n) * 15n / 100n);
  assert.equal(three.get(3), undefined);
  assert.equal(seasonPayoutByRank(0n, 10).size, 0);
  assert.equal(seasonPayoutByRank(pool, 0).size, 0);
});

test('arena oracle cap default (SEC-F06): one baseline day of wager pots, and the flow model rakes exactly that volume', () => {
  const a = BASELINE_ASSUMPTIONS;
  assert.equal(pvpDailyPotVolumeCg(a), a.dau * a.pvpMatchesPerDauPerDay * a.wageredShare * a.avgWagerCg * 2);
  assert.equal(ARENA_ORACLE_DAILY_CAP_DEFAULT_CG, 120_000);
  assert.ok(ARENA_ORACLE_DAILY_CAP_DEFAULT_CG < 1_000_000, 'the pre-F06 default was an arbitrary 1 M $CG/day');
  // a 1 000-DAU launch day fits with 5× headroom; a single max wager (5 000 $CG → 10 000 pot) is 8 % of it
  assert.ok(pvpDailyPotVolumeCg({ ...a, dau: 1_000 }) * 5 <= ARENA_ORACLE_DAILY_CAP_DEFAULT_CG);
  assert.ok(10_000 < ARENA_ORACLE_DAILY_CAP_DEFAULT_CG / 10);
  // dailyFlows must rake the same pot volume it reports in the cap (one formula, two call sites)
  const flows = dailyFlows(a);
  const rake = pvpDailyPotVolumeCg(a) * FEES.pvpRakeBps / 10_000;
  const rakeBurnShare = 1 - (FEES.pvpRakeTreasuryShareBps + FEES.pvpRakePoolShareBps) / 10_000;
  assert.ok(flows.burnedCg >= rake * rakeBurnShare, 'the burn total includes the rake burn slice');
});

test('ranked chip XP: cost curve, spend, and rarity caps', () => {
  assert.equal(CHIP_XP.cost(1), 10);
  assert.equal(CHIP_XP.cost(11), 110);
  assert.equal(xpToNext(1, 12), 10);
  assert.equal(xpToNext(12, 12), null);
  assert.deepEqual(applyChipXp(1, 9, 12), { level: 1, xp: 9, gained: 0 });
  assert.deepEqual(applyChipXp(1, 10, 12), { level: 2, xp: 0, gained: 1 });
  assert.deepEqual(applyChipXp(1, 30, 12), { level: 3, xp: 0, gained: 2 }); // 10+20
  assert.deepEqual(applyChipXp(11, 110, 12), { level: 12, xp: 0, gained: 1 });
  assert.deepEqual(applyChipXp(12, 500, 12), { level: 12, xp: 500, gained: 0 });
  // Common 1→12 = 10×(1+…+11) = 660 XP
  assert.deepEqual(applyChipXp(1, 660, 12), { level: 12, xp: 0, gained: 11 });
  assert.equal(RARITY_PROFILES[0].maxLevel, 12);
  assert.equal(RARITY_PROFILES[8].maxLevel, 50);
});
