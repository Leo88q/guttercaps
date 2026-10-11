// =============================================================================
// GUTTERCAPS economy — $CG tokenomics
// -----------------------------------------------------------------------------
// $CG is a UTILITY token: it buys packs (secondary payment rail), pays
// fusion fees, enters PvP wagers and unlocks cosmetics. It is NOT sold in a
// public sale in this design — the only ways to get it are play (emission)
// and the open market. This keeps the token out of the "investment contract"
// blast radius while still giving it a real price via the marketplace.
//
// Supply: hard cap 1 000 000 000 $CG (6 decimals). Mint authority is the
// Emission PDA of the staking program; the PDA can never mint more than the
// schedule below allows (`EmissionState.minted_total <= cap_for(now)`), and
// the schedule itself is only adjustable DOWN by the multisig.
// =============================================================================

export const CG_DECIMALS = 6;
export const CG_HARD_CAP = 1_000_000_000; // whole tokens

/** Allocation of the hard cap. Everything except "Play-to-earn emission" is vested. */
export const ALLOCATION = [
  { bucket: 'Play emission (staking, quests, PvP, seasons)', pct: 55, vesting: 'Emission curve below (≈7 years to full)' },
  { bucket: 'Ecosystem & liquidity (DEX LP, market-making, grants)', pct: 15, vesting: '20% at TGE, rest linear 24 mo' },
  { bucket: 'Team & advisors', pct: 15, vesting: '12 mo cliff, then linear 36 mo' },
  { bucket: 'Treasury / DAO reserve', pct: 10, vesting: 'multisig-controlled, on-chain proposals' },
  { bucket: 'Community airdrops & referrals', pct: 5, vesting: 'campaign-based, max 1%/quarter' },
] as const;

/**
 * Emission schedule (share of the play bucket per year). Front-loaded to
 * bootstrap liquidity, decaying ~20%/yr. Sum over 8 years = 78%; the
 * remaining 22% is a governance-only reserve for future seasons — nothing
 * forces it out. The schedule is a CEILING: see `guardedEmission` below.
 */
export const YEARLY_EMISSION_PCT_OF_PLAY = [18, 15, 12, 10, 8, 6, 5, 4] as const;

/**
 * Activity-indexed guard ("burn-and-mint"): the program mints per day at most
 *   min( scheduleCap, 0.30 × scheduleCap + 1.25 × trailing-7d-avg-daily-burn )
 * so emission can never run far ahead of what the economy actually destroys.
 * The 2% floor bootstraps a new economy without printing a pack-a-day to
 * a 50-wallet launch; 1.25× lets net supply grow slowly
 * with real activity. On-chain: EmissionState keeps a 7-slot ring buffer of
 * daily burn totals. Feeding that buffer is NOT oracle-free: unstake penalties
 * are recorded in-program (`record_internal_burn`), while the other programs'
 * burns (fusion, pack-in-CG, listing fee, rake) are delivered hourly by the
 * backend burn-oracle keeper (`report_burn`, clamped to BURN_SANITY_MULT × cap
 * so a lying oracle can lift emission from the 30% floor to 100% of schedule,
 * never beyond). Direct ["burn_reporter"] CPIs from chip_core/market/arena are
 * the planned v2 and are currently unused — SEC-F02 of the 2026-09-21 audit.
 */
export const EMISSION_GUARD = { floorShare: 0.02, burnMultiple: 1.25 } as const;
export const guardedEmission = (scheduleCap: number, trailingDailyBurn: number) =>
  Math.min(scheduleCap, EMISSION_GUARD.floorShare * scheduleCap + EMISSION_GUARD.burnMultiple * trailingDailyBurn);

export const playBucketTokens = () => (CG_HARD_CAP * 55) / 100;
export const yearlyEmission = (year: number) => (playBucketTokens() * (YEARLY_EMISSION_PCT_OF_PLAY[year] ?? 0)) / 100;
export const dailyEmission = (year: number) => yearlyEmission(year) / 365;

/** How the daily emission is split between faucets (sum = 100). Admin-tunable within ±10pp without redeploy. */
export const EMISSION_SPLIT = {
  chipStaking: 20,
  tokenStaking: 5,
  quests: 22,
  pvpSeason: 33,     // ~60% per-match rewards, ~40% season ladder payouts
  eventsReserve: 20, // seasonal events, referrals, jackpots, tournaments (absorbs the 5 pp cut from token staking)
} as const;

// -----------------------------------------------------------------------------
// Sinks — every $CG that leaves circulation and where it goes
// -----------------------------------------------------------------------------
export const SINKS = [
  { source: 'Fusion fee',               burnPct: 100, treasuryPct: 0,  note: 'Primary sink; scales with top-tier crafting' },
  { source: 'Pack purchase in $CG',     burnPct: 75,  treasuryPct: 25, note: 'Buying packs with $CG destroys 75% of the price' },
  { source: 'Pack purchase in SKR',     burnPct: 0,   treasuryPct: 100, note: 'SKR cannot be burned; 15% of SKR pack revenue is routed to the SKR prize pool (skrRewards.ts, owner policy 15/10/5)' },
  { source: 'Marketplace fee (7.5%)',   burnPct: 33,  treasuryPct: 67, note: 'Taken in the payment token; ⅓ buys back $CG weekly and burns it, ⅔ → treasury' },
  { source: 'Creator royalty (2.5%)',   burnPct: 0,   treasuryPct: 100, note: 'Enforced by the Metaplex Core Royalties plugin — also earned on external marketplaces that honour it' },
  { source: 'PvP wager rake (5%)',      burnPct: 40,  treasuryPct: 40, note: 'Remaining 20% tops up the season prize pool' },
  { source: 'Early-unstake penalty',    burnPct: 100, treasuryPct: 0,  note: '5-15% of principal' },
  { source: 'Cosmetics / handles in $CG', burnPct: 100, treasuryPct: 0, note: 'Vanity sink — the same items are also sold for SOL/USDC/SKR (→ treasury)' },
  { source: 'Listing fee (0.5 $CG)',    burnPct: 100, treasuryPct: 0,  note: 'Anti-spam for marketplace listings' },
] as const;

/**
 * Fee schedule v2 (Phase 5 decision: "the studio must earn on fees and
 * services"). Every number here is mirrored on-chain and checked by
 * scripts/sync-check.ts. Rationale per line:
 *  - marketplace 7.5% + 2.5% royalty = 10% total take. Precedents: Steam
 *    Community Market 15%, Axie 4.25%, NBA Top Shot 5%, Star Atlas 6%. 10%
 *    is the top of the "game-internal market" band; above it, volume leaks
 *    to OTC/Discord trades. `marketplaceFeeBps` is LIVE-TUNABLE (0–10%)
 *    through GameConfig.market_fee_bps; the royalty is baked into the Core
 *    collection plugin and cannot be raised after mint.
 *  - PvP rake 5% (poker-room level). 40% → treasury, 40% burned, 20% → season pool.
 *  - $CG packs burn 75% so buying packs with earned $CG is the dominant sink.
 */
export const FEES = {
  marketplaceFeeBps: 750,      // 7.5% protocol fee (hard cap on-chain 10%, live-tunable)
  marketplaceFeeBuybackShareBps: 3_333, // ⅓ of the protocol fee → buyback-burn wallet, ⅔ → treasury
  creatorRoyaltyBps: 250,      // 2.5% enforced via Metaplex Core Royalties plugin → treasury
  pvpRakeBps: 500,             // 5% of the pot
  pvpRakeTreasuryShareBps: 4_000, // 40% of rake → treasury
  pvpRakePoolShareBps: 2_000,     // 20% of rake → season prize pool (rest burned)
  listingFeeCgMicro: 500_000,  // 0.5 $CG
  cgPackBurnBps: 7500,         // 75% of a $CG pack price is burned, 25% → treasury
  skrPackDiscountBps: 500,     // 5% off packs paid in SKR (Seeker ecosystem promo; live-tunable 0–15%)
} as const;

/**
 * Payment rails. Codes are shared by every program (chip_core, market) and the API.
 * `rewards`: can be paid out through Merkle reward roots — $CG from emission,
 * SKR from the treasury-funded prize pool (see ./skrRewards.ts).
 */
export const CURRENCIES = [
  { code: 0, symbol: 'SOL',  decimals: 9, kind: 'fixed',  oracle: 'fx:SOL/USD',  packs: true,  market: true,  services: true,  wagers: false, rewards: false },
  { code: 1, symbol: 'USDC', decimals: 6, kind: 'stable', oracle: null,          packs: true,  market: false, services: true,  wagers: false, rewards: false },
  { code: 2, symbol: 'CG',   decimals: 6, kind: 'game',   oracle: null,          packs: true,  market: false, services: true,  wagers: true,  rewards: true },
  { code: 3, symbol: 'SKR',  decimals: 6, kind: 'fixed',  oracle: 'fx:SKR/USD',  packs: true,  market: false, services: true,  wagers: false, rewards: true },
] as const;
export type CurrencyCode = (typeof CURRENCIES)[number]['code'];
export const CURRENCY_BY_CODE = Object.fromEntries(CURRENCIES.map((c) => [c.code, c])) as Record<CurrencyCode, (typeof CURRENCIES)[number]>;

/**
 * Seeker (SKR) — Solana Mobile ecosystem token. Classic SPL Token program, 6 decimals.
 * Mint authority = Solana Mobile's Squads vault → the game can neither mint nor burn
 * SKR. It is a PAYMENT rail (code 3) and, since Phase 6, a REWARD currency paid from
 * a treasury-funded prize pool (`role`). Never a wager/fee token.
 */
export const SKR = {
  mint: 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3',
  decimals: 6,
  pythFeedIdHex: '38846ec4d0dbe808091817f5c0d6ab8058e25422348ddf97db52b6c378a93bf9', // Crypto.SKR/USD
  role: 'payment + reward (prize pool); no mint, no burn, no wagers',
} as const;

// -----------------------------------------------------------------------------
// Flow model — used by the report to prove sinks ≥ ~60% of emission in Y1
// -----------------------------------------------------------------------------
export interface FlowAssumptions {
  dau: number;
  payingShare: number;              // share of DAU buying ≥1 pack / week with fiat/SOL/USDC
  packsPerPayerPerWeek: number;
  payerCgPackShare: number;         // share of payers' packs bought with market-bought $CG
  activeSpendShare: number;         // share of quest/PvP/event $CG income that gets spent on packs
  stakerSpendShare: number;         // share of staking income spent on packs
  fusionsPerDauPerDay: number;      // chip-limited: ~1.7 chips/DAU/week → ~0.08 fusions/day
  avgFusionFeeCg: number;           // frequency-weighted (≈70% of fusions are Common→Common+)
  pvpMatchesPerDauPerDay: number;
  wageredShare: number;             // share of matches that carry a $CG wager
  avgWagerCg: number;
  marketplaceVolumeCgPerDauPerDay: number; // $CG-equivalent volume
}

export const BASELINE_ASSUMPTIONS: FlowAssumptions = {
  dau: 5_000,
  payingShare: 0.08,
  packsPerPayerPerWeek: 3,
  payerCgPackShare: 0.35,
  activeSpendShare: 0.6,
  stakerSpendShare: 0.2,
  fusionsPerDauPerDay: 0.1,
  avgFusionFeeCg: 10,
  pvpMatchesPerDauPerDay: 2,
  wageredShare: 0.3,
  avgWagerCg: 20,
  marketplaceVolumeCgPerDauPerDay: 40,
};

const STANDARD_PACK_CG = 2700;

/** Σ of wager pots (both stakes, before rake) resolved per day under `a` — 120 000 $CG at baseline. */
export function pvpDailyPotVolumeCg(a: FlowAssumptions = BASELINE_ASSUMPTIONS): number {
  return a.dau * a.pvpMatchesPerDauPerDay * a.wageredShare * a.avgWagerCg * 2;
}

/**
 * Default for `ArenaConfig.oracle_daily_cap` at `scripts/setup.ts` time (SEC-F06): the arena program
 * refuses `resolve_battle` once the pots resolved in a 24 h window exceed the cap, which bounds what a
 * leaked battle-oracle key can misdirect to one day of *baseline* wager turnover instead of an
 * arbitrary number. Launch turnover is far below baseline, so this is headroom, not a limit; raise
 * it with `set_arena` when `arena_oracle_paid_today_cg` (ops/monitoring/alerts.yml) actually
 * approaches it. Whole $CG; `setup.ts` scales to micro.
 */
export const ARENA_ORACLE_DAILY_CAP_DEFAULT_CG = pvpDailyPotVolumeCg();

/**
 * Daily $CG flow model. Emission is split by EMISSION_SPLIT; income earned by
 * active players partially recycles into packs (the main sink, 75% burned).
 * The activity guard and recycling are mutually dependent, so we iterate to
 * a fixed point (converges in < 5 rounds).
 */
export function dailyFlows(a: FlowAssumptions, year = 0) {
  const cap = dailyEmission(year);
  const payers = a.dau * a.payingShare;
  const packsPerDay = (payers * a.packsPerPayerPerWeek) / 7;
  const payerCgPackSpend = packsPerDay * a.payerCgPackShare * STANDARD_PACK_CG;
  const fusionBurn = a.dau * a.fusionsPerDauPerDay * a.avgFusionFeeCg;
  const pvpRake = pvpDailyPotVolumeCg(a) * (FEES.pvpRakeBps / 10_000);
  const mktFee = a.dau * a.marketplaceVolumeCgPerDauPerDay * (FEES.marketplaceFeeBps / 10_000);

  let emission = cap;
  let burned = 0, toTreasury = 0, recycledPackSpend = 0;
  for (let i = 0; i < 8; i++) {
    const activeIncome = emission * (EMISSION_SPLIT.quests + EMISSION_SPLIT.pvpSeason + EMISSION_SPLIT.eventsReserve) / 100;
    const stakerIncome = emission * (EMISSION_SPLIT.chipStaking + EMISSION_SPLIT.tokenStaking) / 100;
    recycledPackSpend = activeIncome * a.activeSpendShare + stakerIncome * a.stakerSpendShare;
    const packSpend = recycledPackSpend + payerCgPackSpend;
    const burnBps = FEES.cgPackBurnBps / 10_000;
    const rakeBurnShare = 1 - (FEES.pvpRakeTreasuryShareBps + FEES.pvpRakePoolShareBps) / 10_000;
    const mktBurnShare = FEES.marketplaceFeeBuybackShareBps / 10_000;
    burned = fusionBurn + packSpend * burnBps + pvpRake * rakeBurnShare + mktFee * mktBurnShare;
    toTreasury = packSpend * (1 - burnBps) + pvpRake * (FEES.pvpRakeTreasuryShareBps / 10_000) + mktFee * (1 - mktBurnShare);
    emission = guardedEmission(cap, burned);
  }
  return {
    scheduleCapCg: Math.round(cap),
    emissionCg: Math.round(emission),
    burnedCg: Math.round(burned),
    treasuryCg: Math.round(toTreasury),
    netInflationCg: Math.round(emission - burned),
    sinkRatio: +(burned / emission).toFixed(2),
    perDauEmission: +(emission / a.dau).toFixed(1),
    recycledPackSpendCg: Math.round(recycledPackSpend),
  };
}
