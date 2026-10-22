import { isRightsPath, mockRights } from './rights';
// Deterministic in-browser backend used when VITE_API_MOCK=true or when the
// real API is unreachable in dev. Data is derived from @guttercaps/economy
// and shared/lib/lore so what you see matches the modelled numbers.
import { ACHIEVEMENTS, BOOSTER, CHIP_XP, DAILY_QUESTS, LINE, EMISSION_GUARD, EMOTE_PACK_BY_ID, EMOTE_PACK_OF, FEES, FUSION_RECIPES, FX, GRID, GRID as GRID_RULES, LOCK_TIERS, MATCHMAKING, PACKS, PASS_TRACK, PERMANENT_QUESTS, PROFILE_THEME_BY_ID, RARITY_PROFILES, REFERRAL, SEASON, SERVICES, SERVICE_BY_ID, SKIN_BY_ID, WEEKLY_QUESTS, applyRotate, botReplay, bundlePriceCents, CREW, CREW_NAME_RE, TOURNAMENT, crewTier, crewWeekScore, effectiveOdds, generateLevel, gridBaseXp, gridStarsForMoves, gridXpForStars, impliedApy, isSolved, levelSeed, lineLayout, lineSeed, lineTier, packExpectedValueMult, passTierForXp, partById, probabilityAtLeast, runPassXp, simulateRun, skrMicroForUsdCents, solLamportsForUsdCents, stockLoadout, tournamentBandOfRank, tournamentPrizeSchedule, usdCentsFromSolLamports, usdcMicroForUsdCents, xpToNext, BOARD_SET_SLOTS, boardDistrictOfWeek, boardSetDistrict, type PackId } from '@guttercaps/economy';
import { PYTH_PRICE_ACCOUNTS } from '@/chain/ids';
import { COLLECTIONS } from '@/shared/lib/lore';
import { ApiError, type RequestOpts } from '../client';

// ------------------------------------------------------------- utilities
let seed = 0x1234_5678;
function rnd(): number { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) % 1_000_000) / 1_000_000; }
const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function fakeKey(prefix = ''): string {
  let s = prefix;
  while (s.length < 44) s += B58[Math.floor(rnd() * B58.length)];
  return s.slice(0, 44);
}
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const SKUS: PackId[] = ['starter', 'standard', 'premium', 'limited'];
const ME = 'GCmockWa11etXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
let mockHandle = 'gutter_rat';

// ------------------------------------------------------------- state
interface MockChip {
  asset: string; owner: string; collection: number; rarity: number; level: number; index: number | null;
  flags: { staked: boolean; listed: boolean; fusing: boolean; soulbound: boolean; founder: boolean };
  lockUntil: string | null; power: number; stakeWeight: string;
  skin: string | null;
  xp: number; xpToNext: number | null; maxLevel: number; xpToday?: number; xpDailyCap?: number;
  art: { image: string; video?: string; vfxTier: number };
  listing?: { asset: string; seller: string; price: string; currency: 'SOL' | 'USDC'; priceUsd: number; createdAt: string };
}

const SOL_USD = FX.solUsd;
const SKR_USD = FX.skrUsd;
const floorUsd = (r: number) => Number((3.5 * RARITY_PROFILES[r].valueMult * 0.62).toFixed(2));

function makeChip(collection: number, rarity: number, owner = ME, opts: Partial<MockChip> = {}): MockChip {
  const maxLevel = RARITY_PROFILES[rarity].maxLevel;
  const level = 1 + Math.floor(rnd() * Math.min(6, maxLevel - 1));
  const need = xpToNext(level, maxLevel);
  const xp = need ? Math.floor(rnd() * need) : 0;
  const power = Math.round(RARITY_PROFILES[rarity].basePower * (1 + 0.025 * (level - 1)));
  return {
    asset: fakeKey('As'), owner, collection, rarity, level, index: 1 + Math.floor(rnd() * 5000),
    flags: { staked: false, listed: false, fusing: false, soulbound: false, founder: false }, lockUntil: null, power, skin: null,
    xp, xpToNext: need, maxLevel,
    stakeWeight: String(RARITY_PROFILES[rarity].stakeWeight), art: { image: `/art/${COLLECTIONS[collection]?.num ?? '01'}-${rarity}-256.webp`, vfxTier: RARITY_PROFILES[rarity].vfxTier },
    ...opts,
  };
}

// SEC-B24: each program checks its own authority pair — the arena reads `ArenaConfig`, not chip_core's.
const CHIP_ADMIN = 'HPMr5r9sS5ApWsPNJytZRLbm2jz1veFxTn1wepjAhtho';
const CHIP_PAUSER = 'GCmockPau5erXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const STAKING_ADMIN = CHIP_ADMIN;
const STAKING_PAUSER = 'GCmockStak1ngPau5erXXXXXXXXXXXXXXXXXXXXXXXX';
const ARENA_ADMIN = 'GCmockArenaAdm1nXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const ARENA_PAUSER = 'GCmockArenaPau5erXXXXXXXXXXXXXXXXXXXXXXXXX';
const chips: MockChip[] = [];
// a believable mid-game inventory: lots of commons, a few epics, one legend
const inventoryPlan: [number, number][] = [[0, 14], [1, 9], [2, 7], [3, 4], [4, 3], [5, 1], [6, 1]];
for (const [r, n] of inventoryPlan) for (let i = 0; i < n; i++) chips.push(makeChip(Math.floor(rnd() * COLLECTIONS.length), r));
// one COMPLETE set for NIGHTMOTH (9/9) so the district-banner cosmetic is previewable
for (let r = 0; r <= 8; r++) if (!chips.some((c) => c.collection === 0 && c.rarity === r)) chips.push(makeChip(0, r));
// Fusion suggestions are one district only (backend `suggest`), so a probabilistic (85 %) bench
// triple needs same-district epics: three to fuse plus one that stays, because the backend never
// suggests a triple that would break a complete set. Top NIGHTMOTH's epics up to four with copies
// of the first one — fixed asset ids and mint numbers, no draw from `rnd()`, so every other piece
// of seeded mock data (inventory, listings, request-time values) stays exactly what it was.
{
  const epic = chips.find((c) => c.collection === 0 && c.rarity === 4)!;
  for (let k = chips.filter((c) => c.collection === 0 && c.rarity === 4).length; k < 4; k++) {
    chips.push({ ...epic, flags: { ...epic.flags }, asset: `AsMockNightmothEpic${'ABCD'[k]}`.padEnd(44, 'X'), index: 4_001 + k });
  }
}
chips[0].flags.staked = true; chips[1].flags.staked = true; chips[2].flags.staked = true;
chips[5].flags.soulbound = true; chips[5].lockUntil = iso(3 * 86_400_000);
chips[0].flags.founder = true; // pre-sale founder frame demo (docs/preorder-beta.md)

const listings: MockChip[] = [];
for (let i = 0; i < 60; i++) {
  const r = pick([0, 0, 0, 1, 1, 1, 2, 2, 3, 3, 4, 5, 6, 7]);
  const c = makeChip(Math.floor(rnd() * COLLECTIONS.length), r, fakeKey('Se'));
  const usd = floorUsd(r) * (0.9 + rnd() * 0.6);
  const currency = rnd() < 0.6 ? 'SOL' : 'USDC';
  c.flags.listed = true;
  c.listing = {
    asset: c.asset, seller: c.owner, currency, priceUsd: Number(usd.toFixed(2)),
    price: currency === 'SOL' ? String(Math.round((usd / SOL_USD) * 1e9)) : String(Math.round(usd * 1e6)),
    createdAt: iso(-Math.floor(rnd() * 3 * 86_400_000)),
  };
  listings.push(c);
}

const questState = new Map<string, { value: number; claimed: boolean }>();
const seasonEnd = Date.now() + 23 * 86_400_000;

// ------------------------------------------------------------- handlers
type Handler = (opts: RequestOpts, params: Record<string, string>) => unknown;
const routes: { method: string; pattern: RegExp; keys: string[]; h: Handler }[] = [];
function on(method: string, path: string, h: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp('^' + path.replace(/\{(\w+)\}/g, (_m, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, pattern, keys, h });
}

const me = () => ({
  address: ME, handle: mockHandle, firstSeen: iso(-40 * 86_400_000), country: 'NL',
  balances: { lamports: '2314500000', usdc: '48250000', cg: '1875400000', skr: '1240000000' },
  pity: { counters: [0, 23, 4, 0], toGuarantee: [0, 37, 36, 25], boughtToday: [0, 1, 0, 0], starterClaimed: true },
  boosters: 2,
  flags: { rewardsPaused: false, geoRestricted: false, accountAgeH: 960, hasPaidPack: true, deviceLimited: false },
  human: humanState(),
  completedSets: 1,
  isAdmin: true, // the mock wallet is an operator so the ops panel (/admin) is reachable offline
});

on('get', '/health', () => ({ ok: true }));
on('post', '/auth/siws/nonce', () => ({ nonce: fakeKey(), statement: 'Sign in to GUTTERCAPS', expiresAt: iso(5 * 60_000) }));
on('post', '/auth/siws/verify', () => ({ csrf: 'mock-csrf', wallet: { address: ME, handle: 'gutter_rat' } }));
// proof of human (T-B-49): the mock starts unverified so the challenge card is visible; any token passes
let humanVerifiedAt: number | null = null;
const humanState = () => ({ required: true, verified: humanVerifiedAt !== null, verifiedAt: humanVerifiedAt ? iso(humanVerifiedAt - Date.now()) : null, expiresAt: humanVerifiedAt ? iso(humanVerifiedAt + 7 * 86_400_000 - Date.now()) : null, siteKey: '1x00000000000000000000AA' });
on('get', '/me/human', humanState);
on('post', '/me/human', (o) => { const b = (o.body ?? {}) as { token?: string }; if (!b.token) throw new ApiError(400, 'turnstile_failed', 'token is required'); humanVerifiedAt = Date.now(); return humanState(); });
on('post', '/auth/logout', () => undefined);
on('get', '/me', me);
on('get', '/me/chips', (o) => {
  const q = o.query ?? {};
  let items = chips.filter((c) => (q.collection === undefined || c.collection === Number(q.collection)) && (q.rarity === undefined || c.rarity === Number(q.rarity)));
  if (q.status === 'free') items = items.filter((c) => !c.flags.staked && !c.flags.listed && !c.flags.fusing && !c.lockUntil);
  if (q.status === 'staked') items = items.filter((c) => c.flags.staked);
  if (q.status === 'listed') items = items.filter((c) => c.flags.listed);
  items = [...items].sort((a, b) => b.rarity - a.rarity || b.level - a.level);
  // Маршрут Решётки едет с фишкой и в моке: иначе капли на карточках не видны в демо-режиме.
  return { items: items.map((c) => { const r = mockRoute(c.asset); return { ...c, gridRoute: { nextLevel: r.nextLevel, chargeDrops: r.chargeDrops } }; }), nextCursor: null, total: items.length };
});
on('get', '/me/grid', () => {
  const cells = Array.from({ length: COLLECTIONS.length }, () => Array<number>(9).fill(0));
  for (const c of chips) cells[c.collection][c.rarity]++;
  const missingForSet = cells.map((row, collection) => ({ collection, rarities: row.map((n, r) => (n === 0 ? r : -1)).filter((r) => r >= 0) })).filter((m) => m.rarities.length > 0 && m.rarities.length <= 3);
  return { cells, completedSets: 1, missingForSet };
});
on('get', '/me/pending', () => ({ compressed: [], packs: [], fusions: [] }));
on('get', '/me/referrals', () => ({
  link: { param: 'ref', wallet: ME },
  rules: { rewardBps: REFERRAL.referrerRewardBps, capCgMicroPerReferee: String(REFERRAL.referrerCapCgPerRefereeMicro), refereeWelcomeCgMicro: String(REFERRAL.refereeWelcomeCgMicro), countedCurrencies: ['SOL', 'USDC', 'SKR'], rootKind: 4 },
  referees: [
    { wallet: fakeKey('Rf'), handle: 'rail_queen', joinedAt: iso(-12 * 86_400_000), paidPurchases: 3, spendUsd: 30.97, earnedCgMicro: '154850000', capLeftCgMicro: '45150000' },
    { wallet: fakeKey('Rg'), handle: null, joinedAt: iso(-3 * 86_400_000), paidPurchases: 1, spendUsd: 4.99, earnedCgMicro: '24950000', capLeftCgMicro: '175050000' },
    { wallet: fakeKey('Rh'), handle: null, joinedAt: iso(-86_400_000), paidPurchases: 0, spendUsd: 0, earnedCgMicro: '0', capLeftCgMicro: String(REFERRAL.referrerCapCgPerRefereeMicro) },
  ],
  totals: { referees: 3, paying: 2, earnedCgMicro: '179800000', inRootsCgMicro: '154850000', awaitingRootCgMicro: '24950000', unsettledPurchases: 1 },
  welcome: { amountCgMicro: String(REFERRAL.refereeWelcomeCgMicro), inRoot: true },
  asOf: iso(),
}));

// ------------------------------------------------------------- Floodgrid (demo backend)
// Same deterministic engine, verified locally — mirrors backend/src/grid.ts rules (docs/13).
interface MockGridRoute { nextLevel: number; chargeDrops: number; chargeProgress: number; claims: Map<number, { best_stars: number; xp_accounted: number }> }
const mockGridRoutes = new Map<string, MockGridRoute>();
const mockGridAttempts = new Map<string, { asset: string; level: number; seed: number; hintsUsed: number; mode: string }>();
let mockGhostBeatenDay = -1;
let mockDeepUsed = 0;
let mockDeepCredits = 0;
let mockGridHints: number = GRID_RULES.hintStartStock;
let mockGridValves = 0;
const mockRoute = (asset: string): MockGridRoute => {
  let r = mockGridRoutes.get(asset);
  if (!r) { r = { nextLevel: 1, chargeDrops: 0, chargeProgress: 0, claims: new Map() }; mockGridRoutes.set(asset, r); }
  return r;
};
on('get', '/grid/me', () => ({
  wallet: { hints: mockGridHints, valves: mockGridValves, total_best_stars: [...mockGridRoutes.values()].reduce((s, r) => s + [...r.claims.values()].reduce((a, c) => a + c.best_stars, 0), 0) },
  pendingGranted: 0,
  chips: chips.map((c) => { const r = mockRoute(c.asset); return { asset: c.asset, collection: c.collection, rarity: c.rarity, chipLevel: c.level, route: { nextLevel: r.nextLevel, chargeDrops: r.chargeDrops, chargeProgress: r.chargeProgress }, claims: [...r.claims.entries()].map(([level, v]) => ({ level, best_stars: v.best_stars, xp_accounted: v.xp_accounted, xp_pending: 0, max_xp: gridBaseXp(level) })) }; }),
  gifts: [], floodWeek: 0, flood: [],
  contracts: [0, 1, 2].map((slot) => { const day = Math.floor(Date.now() / 86_400_000); const depth = 1 + ((day + slot) % 5); const configLevel = depth * 15; return { slot, district: (day * 3 + slot) % 8, depth, configLevel, size: generateLevel(configLevel, 1).size, done: null }; }),
  deep: { week: Math.floor((Date.now() / 1000 - 4 * 86_400) / (7 * 86_400)), level: 75, attemptsUsed: mockDeepUsed, paidCredits: mockDeepCredits, attemptsLeft: Math.max(0, 1 + mockDeepCredits - mockDeepUsed), paidAttemptsLeft: Math.max(0, 3 - mockDeepCredits), attemptPriceCgMicro: 30_000_000, myBest: null, leaderboard: [] },
  ghost: { day: Math.floor(Date.now() / 86_400_000), level: 33, targetMoves: generateLevel(33, 7).parMoves, beaten: mockGhostBeatenDay === Math.floor(Date.now() / 86_400_000) },
  lore: { unlockedDepths: [1], pages: 12 },
  // Пустые карточки «ладдер» и «цель района» читаются как сломанные: мок показывает те же
  // структуры, что отдаёт бэкенд (8 районов целиком, таблица лидеров сезона).
  districtGoal: Array.from({ length: 8 }, (_, district) => ({ district, points: 0, goal: GRID.districtGoalPoints, reached: false })),
  ladder: { season: 1, myPoints: 0, myRank: null, top: [], myPayout: null },
  fieldThemes: entitlements.filter((e) => e.kind === 11).map((e) => String((e.payload as { theme?: string }).theme ?? '')).filter(Boolean),
}));
on('get', '/grid/chip/{asset}', (o) => {
  const asset = chips.find((c) => o.path?.asset === c.asset)?.asset ?? String(o.path?.asset ?? '');
  const r = mockRoute(asset);
  return { asset, route: { nextLevel: r.nextLevel, chargeDrops: r.chargeDrops, chargeProgress: r.chargeProgress }, claims: [...r.claims.entries()].map(([level, v]) => ({ level, best_stars: v.best_stars, xp_accounted: v.xp_accounted, xp_pending: 0, max_xp: gridBaseXp(level) })), fails: [], emergency: [] };
});
on('post', '/grid/attempt', (o) => {
  const b = (o.body ?? {}) as { asset: string; level: number; hintsUsed?: number; mode?: string; kind?: string; slot?: number };
  const r = mockRoute(b.asset);
  const day = Math.floor(Date.now() / 86_400_000);
  let level = b.level; let seed = levelSeed(b.level); let mode = b.mode ?? 'charge'; let budgetMult: number = GRID_RULES.moveBudgetMult;
  if (b.kind === 'ghost') { level = 33; seed = 7; mode = 'ghost'; }
  else if (b.kind === 'deep') { if (mockDeepUsed >= 1 + mockDeepCredits) throw new ApiError(409, 'deep_attempts_exhausted', 'No Deep Flood attempts left this week'); mockDeepUsed += 1; level = 75; seed = 11; mode = 'deep'; budgetMult = 1.5; }
  else if (b.kind === 'contract') { if (r.nextLevel <= 75) throw new ApiError(409, 'contract_locked', 'Contracts open after the Descent'); level = (1 + ((day + (b.slot ?? 0)) % 5)) * 15; seed = 13 + (b.slot ?? 0); mode = 'contract'; }
  else if (b.mode !== 'training' && b.level > r.nextLevel) throw new ApiError(409, 'route_locked', 'Chip route is at a lower sector; sectors cannot be skipped (open it in training)');
  const lv = generateLevel(level, seed);
  const id = `mock-grid-${Math.floor(rnd() * 1e9)}`;
  mockGridAttempts.set(id, { asset: b.asset, level, seed, hintsUsed: b.hintsUsed ?? 0, mode });
  return { attemptId: id, level, par: lv.parMoves, moveBudget: Math.ceil(lv.parMoves * budgetMult), route: { nextLevel: r.nextLevel, chargeDrops: r.chargeDrops, chargeProgress: r.chargeProgress }, board: { size: lv.size, bus: lv.bus, receivers: lv.receivers, tiles: lv.tiles.map((tile) => ({ base: tile.base, rot: tile.rot, fixed: tile.fixed, role: tile.role })) } };
});
on('post', '/grid/deep/buy', () => { mockDeepCredits = Math.min(3, mockDeepCredits + 1); return { week: 0, credits: mockDeepCredits }; });
on('post', '/grid/onboard', () => ({ ok: true }));
on('post', '/grid/complete', (o) => {
  const b = (o.body ?? {}) as { attemptId: string; turns: [number, number][]; useValve?: boolean };
  const a = mockGridAttempts.get(b.attemptId);
  if (!a) throw new ApiError(404, 'attempt_not_found', 'Unknown grid attempt');
  mockGridAttempts.delete(b.attemptId);
  const lv = generateLevel(a.level, a.seed);
  for (const [i, d] of b.turns) applyRotate(lv, i, d);
  const r = mockRoute(a.asset);
  if (a.mode === 'ghost') { const beaten = isSolved(lv) && b.turns.length <= lv.parMoves; let hintGranted = 0; const day = Math.floor(Date.now() / 86_400_000); if (beaten && mockGhostBeatenDay !== day) { mockGhostBeatenDay = day; hintGranted = mockGridHints < 10 ? 1 : 0; mockGridHints += hintGranted; } return { ok: isSolved(lv), training: false, kind: 'ghost', beaten, stars: 0, xpGranted: 0, xpPending: 0, hintGranted }; }
  if (a.mode === 'contract' || a.mode === 'deep') { const solved = isSolved(lv); const stars: number = solved ? gridStarsForMoves(b.turns.length, lv.parMoves) : 0; if (a.mode === 'contract' && solved && stars >= 2) { r.chargeProgress += 1; while (r.chargeProgress >= 5 && r.chargeDrops < 3) { r.chargeDrops += 1; r.chargeProgress -= 5; } } let deepPart: string | null = null; if (a.mode === 'deep' && solved) { deepPart = !mockBoardParts.has('deck_trophy') ? giveMockPart('deck_trophy', 'deep') : !mockBoardParts.has('grip_trophy') ? giveMockPart('grip_trophy', 'deep') : null; } return { ok: solved && stars > 0, training: false, kind: a.mode, stars, xpGranted: 0, xpPending: 0, dropletGained: false, gifts: [], boardPart: deepPart }; }
  if (a.mode === 'training') return { ok: isSolved(lv), training: true, stars: 0, xpGranted: 0, xpPending: 0 };
  if (!isSolved(lv)) return { ok: false, xpLoss: b.useValve ? 0 : GRID_RULES.failXp, emergencyGranted: false };
  let stars: number = gridStarsForMoves(b.turns.length, lv.parMoves);
  if (a.hintsUsed > 0) { mockGridHints = Math.max(0, mockGridHints - a.hintsUsed); stars = Math.min(stars, 2); }
  if (stars <= 0) return { ok: false, xpLoss: b.useValve ? 0 : GRID_RULES.failXp, emergencyGranted: false };
  const prev = r.claims.get(a.level);
  const due = Math.max(0, gridXpForStars(a.level, stars) - (prev?.xp_accounted ?? 0));
  r.claims.set(a.level, { best_stars: Math.max(prev?.best_stars ?? 0, stars), xp_accounted: (prev?.xp_accounted ?? 0) + due });
  if (!prev && a.level === r.nextLevel) r.nextLevel = Math.min(GRID_RULES.totalLevels + 1, r.nextLevel + 1);
  // Доски через Floodgrid (2026-10-19): сектор на 2+ звезды раз в неделю даёт
  // недостающую часть района недели — как серверный grantWeeklyGridPart.
  let boardPart: string | null = null;
  if (stars >= 2 && !mockBoardWeekGranted.has(String(mockBoardWeek()))) {
    const district = boardDistrictOfWeek(mockBoardWeek());
    const missingSlot = BOARD_SET_SLOTS.find((slot) => !mockBoardParts.has(`${slot}_d${district}`));
    if (missingSlot) {
      boardPart = giveMockPart(`${missingSlot}_d${district}`, 'grid');
      mockBoardWeekGranted.add(String(mockBoardWeek()));
    }
  }
  // Первый 3★-сектор фишкой района даёт часть именно этого района
  // (серверный grantDistrictGridPart): район выбирает игрок своей фишкой.
  if (!boardPart && stars >= 3 && (prev?.best_stars ?? 0) < 3) {
    const chip = chips.find((c) => c.asset === a.asset);
    const d = chip?.collection;
    if (typeof d === 'number') {
      const missingSlot = BOARD_SET_SLOTS.find((slot) => !mockBoardParts.has(`${slot}_d${d}`));
      if (missingSlot) boardPart = giveMockPart(`${missingSlot}_d${d}`, 'grid');
    }
  }
  return { ok: true, training: false, stars, xpGranted: due, xpPending: 0, dropletGained: false, gifts: [], boardPart };
});
on('post', '/grid/fail', (o) => {
  const b = (o.body ?? {}) as { attemptId: string; useValve?: boolean };
  if (!mockGridAttempts.delete(b.attemptId)) throw new ApiError(404, 'attempt_not_found', 'Unknown grid attempt');
  return { ok: false, xpLoss: b.useValve ? 0 : GRID_RULES.failXp, emergencyGranted: false };
});

on('get', '/me/activity', () => ({
  items: [
    { kind: 'pack_opened', signature: fakeKey(), blockTime: iso(-3_600_000), payload: { sku: 1, best: 4 } },
    { kind: 'fused', signature: fakeKey(), blockTime: iso(-7_200_000), payload: { recipe: 1, success: true } },
    { kind: 'listed', signature: fakeKey(), blockTime: iso(-86_400_000), payload: { priceUsd: 12.5 } },
    { kind: 'match_won', signature: '', blockTime: iso(-90_000_000), payload: { rating: '+18' } },
  ],
  nextCursor: null,
}));
const TAKEN = new Set(['admin', 'guttercaps', 'moth_king', 'railqueen']);
on('get', '/me/handle/check', (o) => {
  const h = String(o.query?.handle ?? '').toLowerCase();
  const taken = TAKEN.has(h);
  return { available: !taken && /^[a-z0-9_]{3,16}$/.test(h), reason: taken ? 'taken' : undefined, kind: mockHandle ? 1 : 0, refHash: '00'.repeat(32), priceUsdCents: mockHandle ? 99 : 199, reservedUntil: iso(120_000) };
});
on('put', '/me/handle', (o) => { mockHandle = String((o.body as { handle: string }).handle); return { address: ME, handle: mockHandle }; });
const entitlements: { id: string; kind: number; payload: Record<string, unknown>; signature: string; currency: string; amount: string; grantedAt: string; expiresAt: string | null }[] = [
  { id: 'e1', kind: 8, payload: {}, signature: 'mock', currency: 'CG', amount: '99000000', grantedAt: iso(-3 * 86_400_000), expiresAt: null },
  { id: 'e2', kind: 3, payload: { theme: 'magenta' }, signature: 'mock', currency: 'CG', amount: '299000000', grantedAt: iso(-3 * 86_400_000), expiresAt: null },
  { id: 'e3', kind: 5, payload: {}, signature: 'mock', currency: 'CG', amount: '199000000', grantedAt: iso(-3 * 86_400_000), expiresAt: null },
  { id: 'e4', kind: 9, payload: { collection: 0 }, signature: 'mock', currency: 'CG', amount: '199000000', grantedAt: iso(-3 * 86_400_000), expiresAt: null },
  { id: 'e5', kind: 6, payload: {}, signature: 'mock', currency: 'CG', amount: '999000000', grantedAt: iso(-9 * 86_400_000), expiresAt: iso(33 * 86_400_000) },
  { id: 'e6', kind: 4, payload: { pack: 'tags-v1' }, signature: 'mock', currency: 'CG', amount: '249000000', grantedAt: iso(-2 * 86_400_000), expiresAt: null },
];
on('get', '/me/services', () => ({ entitlements, dailyLeft: { '7': 3, '0': 1, '1': 1 } }));
on('get', '/services', () => ({
  services: SERVICES.filter((sv) => !sv.retired).map((sv) => ({ id: sv.id, kind: sv.kind, name: sv.name, priceUsdCents: sv.priceUsdCents, dailyCap: sv.dailyCap, recurring: sv.recurring, quotes: {
    SOL: String(solLamportsForUsdCents(sv.priceUsdCents)), USDC: String(usdcMicroForUsdCents(sv.priceUsdCents)), CG: String(sv.priceUsdCents * 1_000_000), SKR: String(skrMicroForUsdCents(sv.priceUsdCents)),
  } })),
  solUsd: SOL_USD, skrUsd: SKR_USD,
}));
const districtCompleted = (collection: number) => {
  const have = new Set(chips.filter((c) => c.collection === collection && c.owner === ME).map((c) => c.rarity));
  return have.size >= 9;
};
on('post', '/services/claim', (o) => {
  const b = o.body as { signature: string; kind: number; payload: Record<string, unknown> };
  const p = b.payload ?? {};
  if (b.kind === 2) {
    if (typeof p.asset !== 'string' || typeof p.skin !== 'string' || !SKIN_BY_ID[p.skin]) throw new ApiError(400, 'bad_payload', 'payload needs {asset, skin} with a known skin id');
    const c = chips.find((x) => x.asset === p.asset);
    if (!c || c.owner !== ME) throw new ApiError(409, 'not_owner', 'You do not own that cap');
    c.skin = p.skin;
  }
  if (b.kind === 3 && (typeof p.theme !== 'string' || !PROFILE_THEME_BY_ID[p.theme])) throw new ApiError(400, 'bad_payload', 'payload needs {theme} with a known theme id');
  if (b.kind === 4 && (typeof p.pack !== 'string' || !EMOTE_PACK_BY_ID[p.pack])) throw new ApiError(400, 'bad_payload', 'payload needs {pack} with a known pack id');
  if (b.kind === 9) {
    if (typeof p.collection !== 'number' || p.collection < 0 || p.collection >= COLLECTIONS.length) throw new ApiError(400, 'bad_payload', 'payload needs {collection} with a live district index');
    if (!districtCompleted(p.collection)) throw new ApiError(409, 'set_not_completed', 'Finish the district set first');
  }
  const e = { id: `e${entitlements.length + 1}`, kind: b.kind, payload: b.payload, signature: b.signature, currency: 'CG', amount: '0', grantedAt: iso(), expiresAt: b.kind === 6 ? iso(42 * 86_400_000) : null };
  entitlements.push(e);
  return e;
});
// ── «Свой тег» (docs/16 §3.2–3.3): мок повторяет серверную пересборку, чтобы
// редактор офлайн видел те же отказы, что и боевой бэкенд.
const mockTags: Array<{ id: string; wallet: string; sha256: string; svg: string; bytes: number; commands: number; status: string; createdAt: string; reports: number }> = [];
const tagId = (wallet: string, hash: string) => `${hash.slice(0, 24)}${wallet.slice(0, 8)}`;
const mockTagView = (t: (typeof mockTags)[number]) => ({ ...t, mine: t.wallet === ME });
on('post', '/tags', (o) => {
  const svg = String((o.body as { svg?: unknown } | undefined)?.svg ?? '');
  if (!svg.trim()) throw new ApiError(400, 'tag_empty', 'The tag is empty');
  if (/<script|javascript:|\son[a-z]+\s*=/i.test(svg)) throw new ApiError(400, 'tag_forbidden', 'A tag may only contain paths and our own stencil images');
  const commands = (svg.match(/[ML]/g) ?? []).length;
  if (commands > 400) throw new ApiError(400, 'tag_too_many_commands', 'A tag is at most 400 path commands');
  const bytes = new TextEncoder().encode(svg).length;
  if (bytes > 24 * 1024) throw new ApiError(413, 'tag_too_large', 'A tag is at most 24 KB');
  // Стойкий, но дешёвый отпечаток содержимого: в моке он заменяет sha256 —
  // совпадение означает «тот же тег», а криптография здесь никому не нужна.
  // Раньше здесь был свёрточный хеш, который брал `charCodeAt(0)` от строки:
  // он почти не зависел от начала строки, и два разных тега с одинаковым
  // хвостом считались одним и тем же. FNV-1a — такой же дешёвый, но честный.
  let h = 0x811c9dc5;
  for (let i = 0; i < svg.length; i++) h = Math.imul(h ^ svg.charCodeAt(i), 0x01000193) >>> 0;
  const hash = h.toString(16).padStart(8, '0');
  const dupe = mockTags.find((t) => t.wallet === ME && t.sha256 === hash && t.status !== 'removed');
  if (dupe) return mockTagView(dupe);
  const t = { id: tagId(ME, hash), wallet: ME, sha256: hash, svg, bytes, commands, status: 'live', createdAt: iso(), reports: 0 };
  mockTags.push(t);
  return mockTagView(t);
});
on('get', '/me/tags', () => ({ items: mockTags.filter((t) => t.wallet === ME).map(mockTagView).reverse() }));
on('get', '/tags/{id}', (_o, params) => {
  const t = mockTags.find((x) => x.id === params.id);
  if (!t || (t.status !== 'live' && t.wallet !== ME)) throw new ApiError(404, 'not_found', 'No tag with that id');
  return mockTagView(t);
});
// ── Модерация (docs/16 §3.3). Мок ведёт жалобы по одной на пару «тег — кошелёк»
// и умеет считать SLA, потому что экран модератора без сроков — это просто
// список картинок: в демо-режиме очередь должна выглядеть так же, как в бою.
const MOD_SLA_HOURS = 24;
const mockReports: Array<{ tagId: string; reporter: string; reason: string; createdAt: number; resolvedAt: number | null; resolution: string | null }> = [];
const openReportsOf = (tagId: string) => mockReports.filter((r) => r.tagId === tagId && r.resolution === null);

on('post', '/tags/{id}/report', (o, params) => {
  const t = mockTags.find((x) => x.id === params.id);
  if (!t || t.status !== 'live') throw new ApiError(404, 'not_found', 'No live tag with that id');
  const reporter = ME;
  if (mockReports.some((r) => r.tagId === t.id && r.reporter === reporter)) throw new ApiError(409, 'already_reported', 'You have already reported this tag');
  mockReports.push({ tagId: t.id, reporter, reason: String((o.body as { reason?: unknown })?.reason ?? 'other'), createdAt: Date.now(), resolvedAt: null, resolution: null });
  t.reports += 1;
  return { ok: true, reports: t.reports };
});

on('get', '/mod/tags/queue', () => {
  const t0 = Date.now();
  const items = mockTags
    .filter((t) => t.status === 'live' && openReportsOf(t.id).length > 0)
    .map((t) => {
      const open = openReportsOf(t.id);
      const oldest = Math.min(...open.map((r) => r.createdAt));
      const hoursLeft = Math.round(((oldest + MOD_SLA_HOURS * 3600_000 - t0) / 3600_000) * 10) / 10;
      const reasons = [...new Set(open.map((r) => r.reason))].map((reason) => ({ reason, n: open.filter((r) => r.reason === reason).length }));
      return { ...mockTagView(t), openReports: open.length, oldestOpenAt: new Date(oldest).toISOString(), hoursLeft, overdue: hoursLeft <= 0, reasons, appealNote: null, appealAt: null };
    })
    // просроченные первыми, дальше по числу открытых жалоб — как на бэкенде
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || b.openReports - a.openReports || Date.parse(a.oldestOpenAt) - Date.parse(b.oldestOpenAt));
  return { slaHours: MOD_SLA_HOURS, items };
});

on('get', '/mod/tags/stats', () => {
  const t0 = Date.now();
  const open = mockReports.filter((r) => r.resolution === null);
  const overdue = open.filter((r) => r.createdAt <= t0 - MOD_SLA_HOURS * 3600_000);
  const resolved = mockReports.filter((r) => r.resolution !== null && r.resolvedAt !== null);
  const hours = resolved.map((r) => (r.resolvedAt! - r.createdAt) / 3600_000).sort((a, b) => a - b);
  const mid = hours.length === 0 ? null : hours.length % 2 === 1 ? hours[(hours.length - 1) / 2]! : (hours[hours.length / 2 - 1]! + hours[hours.length / 2]!) / 2;
  const count = (status: string) => mockTags.filter((t) => t.status === status).length;
  return {
    slaHours: MOD_SLA_HOURS,
    openReports: open.length,
    overdueReports: overdue.length,
    medianReactionHours: mid === null ? null : Math.round(mid * 100) / 100,
    actionedShare: resolved.length === 0 ? null : resolved.filter((r) => r.resolution !== 'tag_live').length / resolved.length,
    tags: { live: count('live'), hidden: count('hidden'), removed: count('removed') },
  };
});

on('put', '/mod/tags/{id}', (o, params) => {
  const t = mockTags.find((x) => x.id === params.id);
  if (!t) throw new ApiError(404, 'not_found', 'No tag with that id');
  const status = String((o.body as { status?: unknown })?.status ?? '');
  if (!['live', 'hidden', 'removed'].includes(status)) throw new ApiError(400, 'bad_status', 'status must be live | hidden | removed');
  t.status = status;
  // решение закрывает все открытые жалобы по тегу — так же, как на бэкенде
  if (status !== 'live') for (const r of openReportsOf(t.id)) { r.resolvedAt = Date.now(); r.resolution = `tag_${status}`; }
  else for (const r of openReportsOf(t.id)) { r.resolvedAt = Date.now(); r.resolution = 'tag_restored'; }
  return mockTagView(t);
});

// ── Стена района (docs/16 §3.4): слоты занимаются активностью, но мок не
// моделирует ни логины, ни стейкинг — он один и тот же «операторский» кошелёк,
// у которого всё есть. Проверки живут в бэкенде (backend/src/wall.ts).
const mockWall: Array<{ district: number; slot: number; wallet: string; tagId: string; appliedAt: string; expiresAt: string }> = [];
const mockWallView = (district: number) => {
  const items = mockWall.filter((s) => s.district === district);
  return {
    district, slots: 200, taken: items.length,
    items: items.map((s) => ({ slot: s.slot, wallet: s.wallet, tagId: s.tagId, appliedAt: s.appliedAt, expiresAt: s.expiresAt, renewedAt: null })),
    layers: [],
    me: { activeDays: 7, activeDaysNeeded: 7, stakedCaps: 1, stakedCapsNeeded: 1, eligible: true, reason: null, mySlot: items.find((s) => s.wallet === ME)?.slot ?? null },
  };
};
// Доска недели: в моке город маленький, поэтому доска считается из той же стены,
// что и экран стены — иначе витрина и стена в демо-режиме расходятся.
on('get', '/wall/board', (o) => {
  const week = o.query?.week === undefined ? undefined : Number(o.query.week);
  const slots = [...mockWall].sort((a, b) => (a.district - b.district) || (a.slot - b.slot));
  const items = slots.slice(0, 5).map((x) => ({ tagId: x.tagId, wallet: x.wallet, district: x.district, slot: x.slot }));
  const lines = items.map((i) => `${i.district}:${i.slot}:${i.tagId}`).join('\n');
  return {
    week: week ?? Math.floor((Date.now() / 1000 - 4 * 86_400) / (7 * 86_400)),
    weekStart: iso(0), weekEnd: iso(7 * 86_400), drawnAt: iso(0),
    slot: 1, seedHex: '0'.repeat(64), tagsHash: lines ? `mock${lines.length}` : 'mock0',
    candidates: slots.length, items,
  };
});
// Сброс мок-мира между тестами: мок живёт в памяти модуля, а тестам нужен
// город, в котором стена пустая — иначе «пустая доска» унаследует чужие теги.
export function resetMockWorld() {
  mockWall.length = 0;
  mockTags.length = 0;
  mockReports.length = 0;
  mockAchieved.clear();
  mockAchAt.clear();
  mockLineRuns.length = 0;
  mockLineCredits = 0;
  mockLineReward = null;
  mockLineXp = { day: lineDay(), xp: 0 };
  mockTournamentBought = 0;
  mockTournamentUnused = 0;
  mockTournamentRuns.length = 0;
  mockBoardParts.clear();
  mockBoardLoadout.clear();
  mockBoardWeekGranted.clear();
  seedMockBoard();
}

on('get', '/wall/{district}', (_o, params) => mockWallView(Number(params.district)));
on('post', '/wall/{district}/claim', (o, params) => {
  const district = Number(params.district);
  const b = o.body as { tagId?: string; slot?: number };
  const tag = mockTags.find((x) => x.id === b.tagId);
  if (!tag) throw new ApiError(400, 'tag_not_live', 'The tag must be yours and live');
  const taken = new Set(mockWall.filter((s) => s.district === district).map((s) => s.slot));
  const mine = mockWall.find((s) => s.district === district && s.wallet === ME);
  if (mine) {
    mine.tagId = tag.id;
    mine.appliedAt = iso();
    mine.expiresAt = iso(30 * 86_400_000);
    return mine;
  }
  let slot = typeof b.slot === 'number' && !taken.has(b.slot) ? b.slot : -1;
  if (slot < 0) for (let i = 0; i < 200; i++) if (!taken.has(i)) { slot = i; break; }
  if (slot < 0) throw new ApiError(409, 'wall_full', 'Every slot on this wall is taken');
  const row = { district, slot, wallet: ME as string, tagId: tag.id, appliedAt: iso(), expiresAt: iso(30 * 86_400_000) };
  mockWall.push(row);
  return row;
});
on('post', '/wall/{district}/renew', (_o, params) => {
  const row = mockWall.find((s) => s.district === Number(params.district) && s.wallet === ME);
  if (!row) throw new ApiError(404, 'no_slot', 'You hold no slot on this wall');
  row.expiresAt = iso(30 * 86_400_000);
  return row;
});
on('post', '/wall/{district}/release', (_o, params) => {
  const i = mockWall.findIndex((s) => s.district === Number(params.district) && s.wallet === ME);
  if (i < 0) throw new ApiError(404, 'no_slot', 'You hold no slot on this wall');
  mockWall.splice(i, 1);
  return { ok: true };
});
on('get', '/me/wall', () => ({
  eligibility: { activeDays: 7, activeDaysNeeded: 7, stakedCaps: 1, stakedCapsNeeded: 1, eligible: true, reason: null },
  items: mockWall.filter((s) => s.wallet === ME).map((s) => ({ district: s.district, slot: s.slot, tagId: s.tagId, appliedAt: s.appliedAt, expiresAt: s.expiresAt, daysLeft: 30 })),
}));

// ------------------------------------------------- экспозиция крышек (docs/16 §4.3) и витрина (§4.5)
// Мок повторяет правило бэкенда: слот открыт при 0 / 12 / 36 разных крышках, а
// владение проверяется при каждом чтении (проданная крышка оставляет слот пустым).
const RIG_UNLOCK_AT = [0, 12, 36];
const mockRig = new Map<number, string>();          // slot → asset (только свои)
let mockRigPublic = false;
const rigCaps = (wallet = ME) => {
  const byKey = new Map<string, { asset: string; collection: number; rarity: number; level: number; copies: number }>();
  for (const c of chips) {
    if (c.owner !== wallet) continue;
    const key = `${c.collection}:${c.rarity}`;
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, { asset: c.asset, collection: c.collection, rarity: c.rarity, level: c.level, copies: 1 }); continue; }
    prev.copies++;
    if (c.level > prev.level || (c.level === prev.level && c.asset < prev.asset)) { prev.asset = c.asset; prev.level = c.level; }
  }
  return [...byKey.values()];
};
/** Райдер (§4.6) в моке: такой же объект, что отдаёт бэкенд. */
/** Чужой райдер детерминирован по адресу: витрина одного кошелька всегда одна и та же. */

const rigView = (wallet = ME) => {
  const caps = rigCaps(wallet);
  const owned = new Map(caps.map((c) => [c.asset, c]));
  const slots = [0, 1, 2].map((slot) => {
    const unlockAt = RIG_UNLOCK_AT[slot];
    const chip = wallet === ME ? owned.get(mockRig.get(slot) ?? '') : undefined;
    return {
      slot, place: slot === 0 ? 'deck' : 'grip', unlocked: caps.length >= unlockAt, unlockAt,
      chip: chip ? { asset: chip.asset, collection: chip.collection, rarity: chip.rarity, level: chip.level, skin: null, founder: false } : null,
      updatedAt: chip ? iso(0) : null,
    };
  });
  const locked = slots.find((s) => !s.unlocked);
  return {
    wallet, public: wallet === ME ? mockRigPublic : true,
    // Чужая витрина показывает три крышки на доске, а не всю коллекцию.
    caps: wallet === ME ? caps : [],
    slots, next: locked ? { slot: locked.slot, need: locked.unlockAt - caps.length } : null,
  };
};
on('get', '/rig', () => rigView(ME));
on('put', '/rig', (o) => {
  const b = (o.body ?? {}) as { slots?: Array<{ slot?: number; asset?: string | null }>; public?: boolean };
  const owned = new Set(rigCaps(ME).map((c) => c.asset));
  for (const u of b.slots ?? []) {
    const slot = Number(u?.slot);
    if (!Number.isInteger(slot) || slot < 0 || slot > 2) throw new ApiError(400, 'bad_slot', 'slot must be 0..2');
    if (!u?.asset) { mockRig.delete(slot); continue; }
    if (rigCaps(ME).length < RIG_UNLOCK_AT[slot]) throw new ApiError(409, 'slot_locked', `Slot ${slot + 1} opens at ${RIG_UNLOCK_AT[slot]} caps`);
    if (!owned.has(u.asset)) throw new ApiError(403, 'not_your_chip', 'You can only exhibit a cap you own');
    for (const [other, asset] of [...mockRig]) if (asset === u.asset && other !== slot) mockRig.delete(other);
    mockRig.set(slot, u.asset);
  }
  if (typeof b.public === 'boolean') mockRigPublic = b.public;
  return rigView(ME);
});
// --------------------------------------------------- конструктор доски (docs/16 §4.2)
// Мок повторяет три правила бэкенда: доска никогда не пустая (сток закрывает
// все шесть слотов), надеть можно только добытое, а выдача за заезд закрывает
// дыру в сете района недели, а не плодит четыре деки подряд.
const mockBoardParts = new Map<string, { qty: number; source: string; createdAt: number }>();
const mockBoardLoadout = new Map<string, string>();
const mockBoardWeekGranted = new Set<string>();
const mockBoardWeek = () => Math.floor(Date.now() / 1000 / (7 * 86_400));
/** Старт мок-города: две части прошлой недели и одна покупная — экран не пустой,
 *  но и «всё уже собрано» он тоже не показывает (собирать должно быть что). */
const seedMockBoard = () => {
  const prev = boardDistrictOfWeek(mockBoardWeek() - 1);
  mockBoardParts.set(`deck_d${prev}`, { qty: 1, source: 'grid', createdAt: Date.now() / 1000 - 9 * 86_400 });
  mockBoardParts.set(`wheels_d${prev}`, { qty: 1, source: 'grid', createdAt: Date.now() / 1000 - 8 * 86_400 });
  mockBoardParts.set('bolts_acid', { qty: 1, source: 'shop', createdAt: Date.now() / 1000 - 3 * 86_400 });
  mockBoardParts.set('sticker_moth', { qty: 1, source: 'achievement', createdAt: Date.now() / 1000 - 2 * 86_400 });
  // Деку прошлой недели надеваем сразу: экран открывается собранным, а не с
  // приглашением «поставь что-нибудь».
  mockBoardLoadout.set('deck', `deck_d${prev}`);
  mockBoardLoadout.set('bolts', 'bolts_acid');
};
seedMockBoard();

const boardLoadoutOf = () => {
  const stock = stockLoadout();
  const out = stock;
  for (const [slot, part] of mockBoardLoadout) {
    const known = partById(part);
    if (!known || known.slot !== slot) continue;
    // Надеть можно только добытое — ровно та проверка, что на сервере.
    const stockPart = stock[slot as keyof typeof stock];
    if (part !== stockPart && !mockBoardParts.has(part)) continue;
    (out as Record<string, string>)[slot] = part;
  }
  return { ...out, set: boardSetDistrict(out) };
};


/** Выдача части доски в моке: тот же инвариант, что серверный grantPart. */
function giveMockPart(part: string, source: string): string {
  const cur = mockBoardParts.get(part);
  mockBoardParts.set(part, { qty: Math.min(3, (cur?.qty ?? 0) + 1), source, createdAt: Date.now() / 1000 });
  return part;
}

const boardViewOf = () => {
  const district = boardDistrictOfWeek(mockBoardWeek());
  const owned = [...mockBoardParts].map(([part, v]) => ({ part, qty: v.qty, source: v.source, createdAt: iso(v.createdAt * 1000 - Date.now()) }));
  const missing = BOARD_SET_SLOTS.filter((slot) => !mockBoardParts.has(`${slot}_d${district}`));
  return {
    ...boardLoadoutOf(),
    wallet: ME,
    owned,
    week: { district, part: `${missing[0] ?? 'deck'}_d${district}`, claimed: mockBoardWeekGranted.has(String(mockBoardWeek())), missing },
    weekProgress: { have: BOARD_SET_SLOTS.length - missing.length, total: BOARD_SET_SLOTS.length },
  };
};

on('get', '/me/board', () => boardViewOf());
on('put', '/me/board', (o) => {
  const b = (o.body ?? {}) as { slots?: Array<{ slot?: string; part?: string | null }> };
  const stock = stockLoadout();
  for (const u of b.slots ?? []) {
    const slot = String(u?.slot ?? '');
    if (!(slot in stock)) throw new ApiError(400, 'bad_slot', `unknown slot ${slot}`);
    if (!u?.part) { mockBoardLoadout.delete(slot); continue; }
    const part = partById(u.part);
    if (!part || part.slot !== slot) throw new ApiError(400, 'bad_part', `${u.part} does not fit ${slot}`);
    const stockPart = stock[slot as keyof typeof stock];
    if (u.part !== stockPart && !mockBoardParts.has(u.part)) throw new ApiError(403, 'part_not_owned', 'Earn this part before wearing it');
    mockBoardLoadout.set(slot, u.part);
  }
  return boardViewOf();
});
on('get', '/board/{wallet}', (_o, params) => ({ wallet: String(params.wallet), ...boardLoadoutOf() }));

// ---------------------------------------------------------- достижения (docs/16 §4.7)
// Прогресс в моке считается из того же инвентаря, что и остальные экраны: полная
// коллекция Ночного мотылька (район 0) делает «закрыть район» достигнутым, а
// остальные метрики берутся из мок-состояния стены, тегов и рефералов.
const mockAchieved = new Set<string>();
/** Когда забрали: «Получено 01.01.1970» в демо читается как баг, а не как демо. */
const mockAchAt = new Map<string, number>();
const achProgress: Record<string, number> = {
  sets: 1,                                                     // район 0 собран полностью (см. инвентарь)
  caps: new Set(chips.map((c) => `${c.collection}:${c.rarity}`)).size,
  wallDays: mockWall.length > 0 ? 12 : 0,
  tags: mockTags.length,
  arenaWins: 18,
  gridDepth: 3,
  fusions: 6,
  referrals: 2,                                                // двое платящих из трёх приведённых
};
const achView = (a: (typeof ACHIEVEMENTS)[number]) => {
  const have = Math.min(achProgress[a.metric] ?? 0, a.target);
  return {
    id: a.id, metric: a.metric, target: a.target, have,
    done: (achProgress[a.metric] ?? 0) >= a.target,
    claimed: mockAchieved.has(a.id),
    claimedAt: mockAchAt.get(a.id) !== undefined ? iso((mockAchAt.get(a.id) as number) * 1000) : null,
    icon: a.icon, reward: a.reward,
    bannerCollection: a.reward.kind === 'banner' ? 0 : null,
  };
};
/** Награда как настоящий entitlement: проверки владения в остальном клиенте те же. */
const achGrant = (a: (typeof ACHIEVEMENTS)[number]) => {
  const r = a.reward as { kind: string; pack?: string; theme?: string; n?: number };
  const kind = r.kind === 'banner' ? 9 : r.kind === 'emotes' ? 4 : r.kind === 'stencils' ? 12
    : r.kind === 'fieldTheme' ? 11 : r.kind === 'bench' ? 5 : r.kind === 'skip' ? 8 : 0;
  if (kind === 0) return;                                      // подсказки Флудгрида — не entitlement
  const payload = r.kind === 'banner' ? { collection: 0, source: 'achievement' }
    : r.kind === 'emotes' ? { pack: r.pack, source: 'achievement' }
    : r.kind === 'stencils' ? { pack: r.pack ?? 'district', source: 'achievement' }
    : r.kind === 'fieldTheme' ? { theme: r.theme, source: 'achievement' } : { source: 'achievement' };
  entitlements.push({ id: `ach-${a.id}`, kind, payload, signature: `ach:${a.id}`, currency: 'CG', amount: '0', grantedAt: iso(), expiresAt: null });
};
on('get', '/me/achievements', () => ({ items: ACHIEVEMENTS.map(achView) }));
on('post', '/me/achievements/{id}/claim', (_o, params) => {
  const id = String(params.id ?? '');
  const a = ACHIEVEMENTS.find((x) => x.id === id);
  if (!a) throw new ApiError(400, 'unknown_achievement', `Unknown achievement ${id}`);
  if ((achProgress[a.metric] ?? 0) < a.target) throw new ApiError(409, 'not_earned', `Achievement needs ${a.target}`);
  if (mockAchieved.has(id)) throw new ApiError(409, 'already_claimed', `Achievement ${id} already claimed`);
  mockAchieved.add(id);
  mockAchAt.set(id, Math.floor(Date.now() / 1000));
  achGrant(a);
  return achView(a);
});

// ---------------------------------------------------------- линия (docs/16 §5.1)
// Мок считает заезд той же функцией, что продакшен: реплей введён — очки
// посчитаны переигрыванием. Иначе демо врало бы о единственном, что в заезде
// важно: очки считает сервер, а не клиент.
const lineDay = () => Math.floor(Date.now() / 86_400_000);
interface MockRun { id: number; wallet: string; day: number; week: number; seed: number; inputs: [number, number][]; score: number; tricks: number; bestCombo: number; bails: number; paid: number; at: number }
const mockLineRuns: MockRun[] = [];
let mockLineCredits = 0;
let mockLineReward: { day: number; tier: string; score: number; hints: number; valve: number } | null = null;
let mockLineXp: { day: number; xp: number } = { day: lineDay(), xp: 0 };
/**
 * Чужая езда на доске недели: та же раскладка дня, другие руки.
 *
 * Строки доски — не выдуманные числа. У каждой есть настоящий реплей, и его
 * очки посчитаны тем же переигрыванием, что у живого заезда: иначе «посмотреть
 * реплей» в демо показывало бы не то, что написано в строке. Чем выше строка,
 * тем ровнее руки — дрожание растёт с номером.
 */
const mockLineBoard = Array.from({ length: 11 }, (_, i) => {
  const wallet = fakeKey();
  const handle = pick(['moth_king', 'railqueen', 'drain0', 'sk8_or_die', 'noise_boy', 'inkslinger', 'brakeless99', 'pixelbsmt', 'gutterbeast', 'citymyth', 'coping_cat']);
  const day = lineDay();
  const jitter = i; // дрожание в тиках (1 тик = 20 мс): первая строка едет ровно, последняя — как придётся
  // Реплей хранится в том же виде, в каком уходит на сервер: [тик, действие].
  const inputs = botReplay(lineLayout(day), jitter, i + 7).map((x) => [x.tick, x.action] as [number, number]);
  const res = simulateRun(lineLayout(day), inputs.map(([tick, action]) => ({ tick, action: action === 1 ? 1 : 0 })));
  return {
    id: 1000 + i, wallet, handle, day, week: Math.floor(day / 7), seed: lineSeed(day), inputs,
    score: res.score, tricks: res.tricks, bestCombo: res.bestCombo, bails: res.bails, at: Math.floor(Date.now() / 1000) - i * 3600,
  };
});
const lineRewardOf = (day: number, score: number) => {
  const tier = lineTier(score);
  if (tier === 'none') return { tier, hints: 0, valve: 0 };
  const prev = mockLineReward && mockLineReward.day === day ? mockLineReward : null;
  const order = { none: 0, bronze: 1, silver: 2, gold: 3 } as const;
  if (prev && order[tier] <= order[prev.tier as keyof typeof order]) return { tier, hints: 0, valve: 0 };
  const reward = tier === 'gold' ? { hints: 1, valve: 1 } : tier === 'silver' ? { hints: 1, valve: 0 } : { hints: 0, valve: 0 };
  mockLineReward = { day, tier, score, ...reward };
  return { tier, ...reward };
};
const lineStateView = () => {
  const day = lineDay();
  const mine = mockLineRuns.filter((r) => r.day === day);
  const best = mine.reduce((m, r) => Math.max(m, r.score), 0);
  return {
    day, week: Math.floor(day / 7), seed: lineSeed(day), ticks: LINE.runSeconds * LINE.tickHz,
    length: LINE.trackLength, freeRunsPerDay: LINE.freeRunsPerDay,
    freeLeft: Math.max(0, LINE.freeRunsPerDay - mine.filter((r) => !r.paid).length),
    paidLeft: Math.max(0, LINE.maxPaidRunsPerDay - mine.filter((r) => r.paid).length),
    runsToday: mine.length, bestToday: best, tierToday: lineTier(best),
    rewardsToday: {
      passXp: mockLineXp.day === day ? mockLineXp.xp : 0,
      hints: mockLineReward?.day === day ? mockLineReward.hints : 0,
      valve: mockLineReward?.day === day ? mockLineReward.valve : 0,
    },
    bestWeek: mockLineRuns.filter((r) => r.week === Math.floor(day / 7)).reduce((m, r) => Math.max(m, r.score), 0),
    extraRunCgMicro: LINE.extraRunCgMicro,
  };
};
on('get', '/me/line', () => lineStateView());
on('post', '/me/line/runs', (o) => {
  const b = (o.body ?? {}) as { day?: number; inputs?: unknown; tournament?: boolean };
  const day = Number(b.day);
  const today = lineDay();
  if (!Number.isInteger(day) || day > today || day < today - 1) throw new ApiError(400, 'bad_day', `day must be today (${today}) or yesterday`);
  const raw = Array.isArray(b.inputs) ? b.inputs : [];
  if (raw.length > LINE.maxInputs) throw new ApiError(400, 'bad_replay', `At most ${LINE.maxInputs} inputs per run`);
  const inputs: [number, number][] = raw.map((i) => {
    const pair = Array.isArray(i) ? i : [];
    const tick = Number(pair[0]); const action = Number(pair[1]);
    if (!Number.isInteger(tick) || tick < 0 || tick >= LINE.runSeconds * LINE.tickHz || (action !== 0 && action !== 1)) {
      throw new ApiError(400, 'bad_replay', 'inputs must be [tick, 0|1]');
    }
    return [tick, action] as [number, number];
  });
  const st = lineStateView();
  const tournament = b.tournament === true;
  let paid = 0;
  if (tournament) {
    // Турнирная попытка оплачена входом (не бесплатной и не
    // кредитом доп. заезда), но считается в общем paid-потолке.
    if (mockTournamentUnused <= 0) throw new ApiError(402, 'tournament_entries_exhausted', 'No unused tournament entry for today — enter the tournament first');
    if (st.paidLeft <= 0) throw new ApiError(409, 'run_credit_cap', `At most ${LINE.maxPaidRunsPerDay} paid runs per day`);
    mockTournamentUnused -= 1;
    paid = 1;
  } else if (st.freeLeft > 0) paid = 0;
  else if (mockLineCredits > 0 && st.paidLeft > 0) { mockLineCredits -= 1; paid = 1; }
  else throw new ApiError(402, 'runs_exhausted', 'Free runs are over for today — buy an extra one (30 $CG, burned)');
  const res = simulateRun(lineLayout(day), inputs.map(([tick, action]) => ({ tick, action: action === 1 ? 1 : 0 })));
  const run: MockRun = {
    id: mockLineRuns.length + 1, wallet: ME, day, week: Math.floor(day / 7), seed: lineSeed(day), inputs,
    score: res.score, tricks: res.tricks, bestCombo: res.bestCombo, bails: res.bails, paid, at: Math.floor(Date.now() / 1000),
  };
  mockLineRuns.push(run);
  if (tournament) mockTournamentRuns.push({ id: run.id, wallet: ME, day, score: res.score, at: run.at });
  const xp = runPassXp(res.score);
  if (mockLineXp.day !== day) mockLineXp = { day, xp: 0 };
  mockLineXp.xp += xp;
  const items = lineRewardOf(day, res.score);
  return {
    run: { id: run.id, day: run.day, week: run.week, score: run.score, tricks: run.tricks, bestCombo: run.bestCombo, bails: run.bails, paid: run.paid === 1, tier: lineTier(run.score), submittedAt: iso() },
    granted: { passXp: xp, hints: items.hints, valve: items.valve, tier: items.tier },
    state: lineStateView(),
  };
});
on('post', '/me/line/runs/buy', (o) => {
  const b = (o.body ?? {}) as { day?: number; signature?: string };
  const day = Number(b.day);
  const today = lineDay();
  if (!Number.isInteger(day) || day > today || day < today - 1) throw new ApiError(400, 'bad_day', `day must be today (${today}) or yesterday`);
  if (typeof b.signature !== 'string' || b.signature.length < 32) throw new ApiError(402, 'payment_not_found', 'No ServicePaid event from this wallet in that transaction');
  if (lineStateView().paidLeft <= 0) throw new ApiError(409, 'run_credit_cap', `At most ${LINE.maxPaidRunsPerDay} paid runs per day`);
  mockLineCredits += 1;
  return { day, credits: mockLineCredits };
});
// Реплей смотрят, а не скачивают (docs/16 §5.5): строка доски публична, и
// нажатия в заезде — не секрет. Смотрим и свои заезды, и чужие с доски.
const runReplayView = (id: number) => {
  const run = mockLineRuns.find((r) => r.id === id) ?? mockLineBoard.find((r) => r.id === id);
  if (!run) throw new ApiError(404, 'not_found', 'No such run');
  return {
    runId: run.id, day: run.day, seed: run.seed, score: run.score, tricks: run.tricks, bails: run.bails,
    wallet: run.wallet, handle: ('handle' in run ? run.handle : null) as string | null, at: iso(run.at * 1000), inputs: run.inputs,
  };
};
on('get', '/line/runs/{id}/replay', (_o, p) => runReplayView(Number(p.id)));
on('get', '/line/leaderboard', (o) => {
  const week = Number((o.query as { week?: unknown } | undefined)?.week);
  const w = Number.isFinite(week) && week > 0 ? Math.floor(week) : Math.floor(lineDay() / 7);
  const mine = mockLineRuns.filter((r) => r.week === w);
  // Своя строка — это настоящий заезд из mockLineRuns, а не «сводка по лучшим
  // полям»: иначе очки на доске и очки в реплее были бы двумя разными числами.
  const best = mine.length ? mine.reduce((a, b) => (b.score > a.score ? b : a)) : null;
  const rows = [...(best ? [{ ...best, handle: mockHandle }] : []), ...mockLineBoard]
    .sort((a, b) => b.score - a.score)
    .slice(0, 50)
    .map((r, i) => ({ ...r, rank: i + 1, runId: r.id, at: iso(r.at * 1000), hasReplay: r.inputs.length > 0 }));
  return { week: w, rows };
});

// ------------------------------------------------- турнир линии (docs/16 §5.4)
// Свои турнирные заезды — настоящие (из POST /me/line/runs с
// tournament:true); чужие строки — бот-реплеи той же чаши дня,
// как на доске недели: демо не показывает чисел, которых
// не могло получиться переигрыванием.
let mockTournamentBought = 0;
let mockTournamentUnused = 0;
const mockTournamentRuns: { id: number; wallet: string; day: number; score: number; at: number }[] = [];
const mockTournamentRivals = Array.from({ length: 9 }, (_, i) => {
  const day = lineDay();
  const layout = lineLayout(day);
  const inputs = botReplay(layout, i + 3, i + 11);
  const res = simulateRun(layout, inputs.map((x) => ({ tick: x.tick, action: x.action === 1 ? 1 : 0 })));
  return {
    wallet: fakeKey(), handle: pick(['moth_king', 'railqueen', 'drain0', 'sk8_or_die', 'noise_boy', 'inkslinger', 'brakeless99', 'pixelbsmt', 'gutterbeast']),
    day, score: res.score, at: Math.floor(Date.now() / 1000) - i * 720,
  };
});
const tournamentBoardRows = (day: number) => {
  const mine = mockTournamentRuns.filter((r) => r.day === day);
  const best = mine.length ? mine.reduce((a, b) => (b.score > a.score ? b : a)) : null;
  return [
    ...mockTournamentRivals.filter((r) => r.day === day).map((r) => ({ wallet: r.wallet, handle: r.handle, score: r.score, runId: 0, at: r.at, hasReplay: false })),
    ...(best ? [{ wallet: ME, handle: mockHandle, score: best.score, runId: best.id, at: best.at, hasReplay: true }] : []),
  ].sort((a, b) => b.score - a.score || a.runId - b.runId);
};
const tournamentStateView = () => {
  const day = lineDay();
  const week = Math.floor(day / 7);
  const rows = tournamentBoardRows(day);
  const entrants = rows.length;
  const myRank = rows.findIndex((r) => r.wallet === ME);
  const st = lineStateView();
  return {
    day, week,
    entries: {
      bought: mockTournamentBought, unused: mockTournamentUnused,
      left: Math.max(0, LINE.maxPaidRunsPerDay - (st.runsToday - st.freeLeft) - mockLineCredits - mockTournamentUnused),
    },
    best: rows.find((r) => r.wallet === ME) ? { score: rows.find((r) => r.wallet === ME)!.score, runId: rows.find((r) => r.wallet === ME)!.runId, at: iso(rows.find((r) => r.wallet === ME)!.at * 1000) } : null,
    rank: myRank >= 0 ? myRank + 1 : null,
    entrants,
    poolCgMicro: String(BigInt(entrants) * BigInt(TOURNAMENT.entryCgMicro) * BigInt(TOURNAMENT.poolBps) / 10_000n),
    settled: false,
    schedule: tournamentPrizeSchedule().map((b, i) => ({ band: i, topPct: b.topPct, trophies: [...b.trophies], districtSlots: b.districtSlots })),
    prizesYesterday: [],
  };
};
on('get', '/me/line/tournament', () => tournamentStateView());
on('post', '/me/line/tournament/enter', (o) => {
  const b = (o.body ?? {}) as { day?: number; signature?: string };
  const day = Number(b.day);
  const today = lineDay();
  if (!Number.isInteger(day) || day !== today) throw new ApiError(400, 'bad_day', `day must be today (${today})`);
  if (typeof b.signature !== 'string' || b.signature.length < 32) throw new ApiError(402, 'payment_not_found', 'No ServicePaid event from this wallet in that transaction');
  const st = lineStateView();
  const paidUsed = st.runsToday - st.freeLeft;
  if (paidUsed + mockLineCredits + mockTournamentUnused >= LINE.maxPaidRunsPerDay) throw new ApiError(409, 'run_credit_cap', `At most ${LINE.maxPaidRunsPerDay} paid runs per day`);
  mockTournamentBought += 1;
  mockTournamentUnused += 1;
  return { day, entries: mockTournamentUnused };
});
on('get', '/line/tournament/board', (o) => {
  const day = Number((o.query as { day?: unknown } | undefined)?.day);
  const d = Number.isFinite(day) && day > 0 ? Math.floor(day) : lineDay();
  const rows = tournamentBoardRows(d);
  return {
    day: d, entrants: rows.length,
    poolCgMicro: String(BigInt(rows.length) * BigInt(TOURNAMENT.entryCgMicro) * BigInt(TOURNAMENT.poolBps) / 10_000n),
    settled: false,
    rows: rows.map((r, i) => ({ ...r, rank: i + 1, band: tournamentBandOfRank(i + 1, rows.length) })),
  };
});

// ------------------------------------------------- команды (docs/16 §5.6)
// Команда в моке — настоящая модель, а не картинка: имя проверяется тем же
// алфавитом, состав считается по тем же правилам «пять лучших», а очки
// участников берутся из заездов линии. Иначе демо показывало бы одну правду на
// экране и другую в коде.
interface MockCrewMember { wallet: string; handle: string | null; joinedAt: number; leftAt: number | null; best: number }
interface MockCrew { id: number; name: string; captain: string; district: number; segment: number; code: string; createdAt: number; renamedAt: number | null; members: MockCrewMember[] }
let mockCrewSeq = 100;
/** Очки участника — его лучший заезд недели: доска линии и командная доска считают одно и то же. */
const crewMemberScores = (n: number, top: number, spread: number) =>
  Array.from({ length: n }, (_, i) => Math.max(120, Math.round(top - i * spread - (i % 3) * 40)));
function makeCrew(name: string, captainHandle: string, district: number, segment: number, size: number, top: number): MockCrew {
  const id = ++mockCrewSeq;
  const handles = [captainHandle, 'railqueen', 'drain0', 'sk8_or_die', 'noise_boy', 'inkslinger', 'brakeless99', 'pixelbsmt', 'gutterbeast', 'coping_cat'];
  const best = crewMemberScores(size, top, Math.round(top / 12));
  const t = Math.floor(Date.now() / 1000);
  return {
    id, name, captain: fakeKey(), district, segment, code: `${name.slice(0, 4).toUpperCase()}${1000 + id}`,
    createdAt: t - 40 * 86_400, renamedAt: null,
    members: Array.from({ length: size }, (_, i) => ({
      wallet: fakeKey(), handle: handles[i] ?? `rider_${i}`, joinedAt: t - (size - i) * 86_400, leftAt: null, best: best[i],
    })),
  };
}
const mockCrews: MockCrew[] = [
  makeCrew('SlabSisters', 'moth_king', 0, 0, 7, 3120),
  makeCrew('NightCrew', 'inkslinger', 2, 3, 5, 2860),
  makeCrew('CopingBlock', 'brakeless99', 4, 1, 6, 1900),
];
const crewLive = (c: MockCrew) => c.members.filter((m) => m.leftAt === null);
/** Пять лучших — не весь состав: формула одна с бэкендом и ончейн-программой. */
const crewScoreOf = (c: MockCrew) => crewWeekScore(crewLive(c).map((m) => m.best));
const crewViewOf = (c: MockCrew, viewer?: string) => {
  const live = crewLive(c);
  const bests = live.map((m) => m.best).sort((a, b) => b - a);
  const cut = bests[Math.min(bests.length, CREW.boardCountingMembers) - 1] ?? 0;
  const mine = viewer !== undefined && live.some((m) => m.wallet === viewer);
  const from = c.segment * CREW.wallSegmentSlots;
  return {
    id: c.id, name: c.name, captain: c.captain, captainHandle: live.find((m) => m.wallet === c.captain)?.handle ?? null,
    district: c.district, segment: c.segment,
    slots: { from, to: from + CREW.wallSegmentSlots, size: CREW.wallSegmentSlots },
    createdAt: iso(c.createdAt * 1000 - Date.now()),
    members: live.map((m) => ({ wallet: m.wallet, handle: m.handle, joinedAt: iso(m.joinedAt * 1000 - Date.now()), bestWeek: m.best, counting: m.best > 0 && m.best >= cut })),
    memberCount: live.length, minMembers: CREW.minMembers, maxMembers: CREW.maxMembers,
    counts: live.length >= CREW.minMembers && live.filter((m) => m.best > 0).length >= CREW.minMembers,
    week: Math.floor(lineDay() / 7), score: crewScoreOf(c), tier: crewTier(crewScoreOf(c)),
    inviteCode: mine ? c.code : undefined, mine, iAmCaptain: viewer !== undefined && viewer === c.captain, reports: 0,
  };
};
const crewByKey = (raw: string) => {
  const key = String(raw ?? '').trim().toLowerCase();
  return mockCrews.find((c) => c.name.toLowerCase() === key || String(c.id) === key);
};
const myMockCrew = () => mockCrews.find((c) => crewLive(c).some((m) => m.wallet === ME)) ?? null;
const CREW_BLOCKLIST = new Set(['admin', 'guttercaps', 'support', 'moderator', 'treasury', 'solana', 'official', 'team', 'root', 'system']);

on('get', '/me/crew', () => { const c = myMockCrew(); return c ? crewViewOf(c, ME) : null; });
// Порядок важен: доска и проверка имени стоят РАНЬШЕ '/crew/{name}' — мок матчит
// маршруты в порядке регистрации, поэтому иначе слово 'board' уехало бы в имя
// команды и вернуло 404 (в проде порядок тот же — см. backend/src/server.ts).
on('get', '/crew/board', () => {
  const week = Math.floor(lineDay() / 7);
  const rows = mockCrews
    .filter((c) => crewLive(c).length >= CREW.minMembers && crewLive(c).filter((m) => m.best > 0).length >= CREW.minMembers)
    .map((c) => ({ rank: 0, id: c.id, name: c.name, district: c.district, segment: c.segment, members: crewLive(c).length, score: crewScoreOf(c), tier: crewTier(crewScoreOf(c)) }))
    .sort((a, b) => b.score - a.score || a.id - b.id)
    .map((r, i) => ({ ...r, rank: i + 1 }));
  return { week, rows };
});
// Ежемесячный конкурс (§5.6): демо-стойка со СВОИМИ командами —
// в месячный зачёт попадает другой срез экипажей, чем в недельную
// гонку, поэтому имена не дублируют недельную доску на экране.
const mockMonthCrews = [
  { id: 901, name: 'VertRats', district: 1, score: 12_480 },
  { id: 902, name: 'ConcretePoets', district: 3, score: 11_205 },
  { id: 903, name: 'Hillcrest', district: 5, score: 9_730 },
];
on('get', '/crew/month', (o) => {
  const month = Number((o.query as { month?: unknown } | undefined)?.month);
  const d = new Date();
  const m = Number.isFinite(month) && month > 202600 ? Math.floor(month) : d.getUTCFullYear() * 100 + d.getUTCMonth() + 1;
  const rows = mockMonthCrews
    .map((c) => ({ rank: 0, id: c.id, name: c.name, district: c.district, score: c.score, part: `deck_crew_d${c.district}` }))
    .sort((a, b) => b.score - a.score || a.id - b.id)
    .map((r, i) => ({ ...r, rank: i + 1 }));
  return { month: m, rows };
});
on('get', '/crew/check', (o) => {
  const name = String((o.query as { name?: unknown } | undefined)?.name ?? '').trim();
  const mine = myMockCrew();
  const kind = mine ? SERVICE_BY_ID.crewRename.kind : SERVICE_BY_ID.crewCharter.kind;
  const price = (mine ? SERVICE_BY_ID.crewRename : SERVICE_BY_ID.crewCharter).priceUsdCents;
  const base = { kind, refHash: 'mock', priceUsdCents: price };
  if (!name) return { available: false, reason: 'format', ...base };
  if (!CREW_NAME_RE.test(name)) return { available: false, reason: 'invalid', ...base };
  const key = name.toLowerCase();
  if (CREW_BLOCKLIST.has(key)) return { available: false, reason: 'blocked', ...base };
  if (mine && Math.floor(Date.now() / 1000) - (mine.renamedAt ?? mine.createdAt) < CREW.renameCooldownDays * 86_400) return { available: false, reason: 'cooldown', ...base };
  const taken = crewByKey(name);
  if (taken && taken.id !== mine?.id) return { available: false, reason: 'taken', ...base };
  return { available: true, ...base, reservedUntil: iso(120_000) };
});
on('get', '/crew/{name}', (_o, params) => {
  const c = crewByKey(String(params.name));
  if (!c) throw new ApiError(404, 'no_crew', 'No crew with that name');
  return crewViewOf(c, ME);
});
on('post', '/crew/charter', (o) => {
  const b = (o.body ?? {}) as { name?: string; district?: number; signature?: string };
  const name = String(b.name ?? '').trim();
  if (!CREW_NAME_RE.test(name)) throw new ApiError(400, 'invalid_name', 'Crew name must be 3–16 chars [a-zA-Z0-9_]');
  if (myMockCrew()) throw new ApiError(409, 'already_in_crew', 'Leave your crew before chartering a new one');
  if (crewByKey(name)) throw new ApiError(409, 'crew_taken', 'That name is taken');
  const district = Number(b.district ?? 0);
  const takenSegments = new Set(mockCrews.filter((c) => c.district === district).map((c) => c.segment));
  let segment = 0;
  while (takenSegments.has(segment)) segment += 1;
  if (segment >= Math.floor(200 / CREW.wallSegmentSlots)) throw new ApiError(409, 'district_full', 'No free segment in this district');
  const c = makeCrew(name, mockHandle, district, segment, 1, 0);
  c.captain = ME;
  c.members[0] = { wallet: ME, handle: mockHandle, joinedAt: Math.floor(Date.now() / 1000), leftAt: null, best: 0 };
  c.createdAt = Math.floor(Date.now() / 1000);
  mockCrews.push(c);
  return crewViewOf(c, ME);
});
on('post', '/crew/rename', (o) => {
  const b = (o.body ?? {}) as { name?: string; signature?: string };
  const name = String(b.name ?? '').trim();
  if (!CREW_NAME_RE.test(name)) throw new ApiError(400, 'invalid_name', 'Crew name must be 3–16 chars [a-zA-Z0-9_]');
  const mine = myMockCrew();
  if (!mine) throw new ApiError(409, 'no_crew', 'You are not in a crew');
  if (mine.captain !== ME) throw new ApiError(403, 'not_captain', 'Only the captain can rename the crew');
  if (crewByKey(name)) throw new ApiError(409, 'crew_taken', 'That name is taken');
  mine.name = name;
  mine.renamedAt = Math.floor(Date.now() / 1000);
  return crewViewOf(mine, ME);
});
on('post', '/crew/join', (o) => {
  const b = (o.body ?? {}) as { code?: string };
  const code = String(b.code ?? '').trim().toUpperCase();
  const c = mockCrews.find((x) => x.code === code);
  if (!c) throw new ApiError(404, 'bad_code', 'No crew with that invite code');
  if (myMockCrew()) throw new ApiError(409, 'already_in_crew', 'Leave your crew first');
  if (crewLive(c).length >= CREW.maxMembers) throw new ApiError(409, 'crew_full', `A crew holds at most ${CREW.maxMembers} riders`);
  const prior = c.members.find((m) => m.wallet === ME);
  if (prior) prior.leftAt = null;
  else c.members.push({ wallet: ME, handle: mockHandle, joinedAt: Math.floor(Date.now() / 1000), leftAt: null, best: 0 });
  return crewViewOf(c, ME);
});
on('post', '/crew/leave', () => {
  const c = myMockCrew();
  if (!c) throw new ApiError(409, 'no_crew', 'You are not in a crew');
  const me = crewLive(c).find((m) => m.wallet === ME)!;
  me.leftAt = Math.floor(Date.now() / 1000);
  let captain: string | undefined;
  if (c.captain === ME) {
    const heir = crewLive(c).sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (heir) { c.captain = heir.wallet; captain = heir.wallet; }
  }
  return { ok: true, crew: null, captain };
});
on('post', '/crew/{name}/report', (o, params) => {
  const c = crewByKey(String(params.name));
  if (!c) throw new ApiError(404, 'no_crew', 'No crew with that name');
  const reason = String((o.body ?? {}) as { reason?: string } ?? '').trim();
  if (!reason) throw new ApiError(400, 'bad_reason', 'Say what is wrong with the name');
  return { ok: true, crew: c.id, reports: 1 };
});

on('get', '/rig/{wallet}', (_o, params) => {
  const wallet = String(params.wallet);
  // Мок показывает витрину любого кошелька: реальная проверка флага живёт в бэкенде.
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) throw new ApiError(400, 'bad_request', 'wallet must be an address');
  return rigView(wallet);
});

// season pass state (tier ~11 with unclaimed tiers + a skinned showcase cap)
let mockPassXp = 2360;
const mockPassClaimed: number[] = [1, 2];
chips[10].skin = 'gold-rim';
entitlements.push({ id: 'e7', kind: 2, payload: { asset: chips[10].asset, skin: 'gold-rim' }, signature: 'mock', currency: 'CG', amount: '149000000', grantedAt: iso(-86_400_000), expiresAt: null });
const mockPass = () => {
  const pass = entitlements.find((e) => e.kind === 6);
  return { seasonId: 3, xp: mockPassXp, tier: passTierForXp(mockPassXp), claimed: [...mockPassClaimed], hasPass: !!pass, passExpiresAt: pass?.expiresAt ?? null };
};
on('get', '/me/pass', () => mockPass());
on('post', '/me/pass/claim', (o) => {
  const b = (o.body ?? {}) as { tier: number; asset?: string };
  const def = PASS_TRACK.find((x) => x.tier === b.tier);
  if (!def) throw new ApiError(400, 'bad_tier', `Unknown pass tier ${b.tier}`);
  const st = mockPass();
  if (!st.hasPass) throw new ApiError(402, 'no_pass', 'Season pass required');
  if (st.xp < def.xp) throw new ApiError(409, 'tier_locked', `Tier ${b.tier} needs ${def.xp} XP`);
  if (mockPassClaimed.includes(b.tier)) throw new ApiError(409, 'already_claimed', `Tier ${b.tier} already claimed`);
  const r = def.reward;
  let kind = 8;
  let payload: Record<string, unknown> = {};
  if (r.kind === 'skin') {
    const c = chips.find((x) => x.asset === b.asset);
    if (!b.asset || !c || c.owner !== ME) throw new ApiError(409, 'not_owner', 'Pick an owned cap to paint');
    kind = 2; payload = { asset: b.asset, skin: r.skin }; c.skin = r.skin;
  } else if (r.kind === 'theme') { kind = 3; payload = { theme: r.theme }; }
  else if (r.kind === 'emotes') { kind = 4; payload = { pack: r.pack }; }
  else if (r.kind === 'banner') {
    if (!districtCompleted(r.collection)) throw new ApiError(409, 'set_not_completed', 'Finish the district set first');
    kind = 9; payload = { collection: r.collection };
  }
  mockPassClaimed.push(b.tier);
  const hintsGranted = b.tier % GRID_RULES.passHintEveryTiers === 0 && mockGridHints < GRID_RULES.hintStockCap ? 1 : 0;
  if (hintsGranted) mockGridHints += hintsGranted;
  const e = { id: `e${entitlements.length + 1}`, kind, payload, signature: `pass:3:${b.tier}`, currency: 'CG', amount: '0', grantedAt: iso(), expiresAt: null };
  entitlements.push(e);
  return hintsGranted ? { ...e, hintsGranted } : e;
});

on('get', '/packs', () => ({
  packs: SKUS.map((id, sku) => {
    const p = PACKS[id];
    const ev = ((packExpectedValueMult(p) * 3.5 * 0.62) / (p.priceUsdCents / 100)) * 100;
    return {
      sku, name: p.name, chips: p.chips, priceUsdCents: p.priceUsdCents, priceCgMicro: p.priceCgMicro === null ? null : String(p.priceCgMicro),
      currencies: p.priceCgMicro ? ['SOL', 'USDC', 'CG'] : ['SOL', 'USDC'], oddsBps: [...p.oddsBps], floor: p.floor, dailyCap: p.dailyCap,
      pity: p.pity ? { ...p.pity } : null, pool: p.pool, enabled: true, pAtLeastLegend: probabilityAtLeast(p, 6), evPct: Number(ev.toFixed(1)),
    };
  }),
  featuredCollection: 4,
  bundles: [{ qty: 1, discountBps: 0 }, { qty: 5, discountBps: 700 }, { qty: 10, discountBps: 1200 }, { qty: 25, discountBps: 1800 }],
}));
on('post', '/packs/quote', (o) => {
  const b = o.body as { sku: number; qty: number; currency: 'SOL' | 'USDC' | 'CG' | 'SKR' };
  const p = PACKS[SKUS[b.sku]];
  const baseCents = bundlePriceCents(p, b.qty);
  // SKR promo (5 %) stacks with the bundle discount, capped at 30 % — same integer math as buy_pack
  const bundleBps = 10_000 - Math.floor((baseCents * 10_000) / Math.max(1, p.priceUsdCents * b.qty));
  const discountBps = b.currency === 'SKR' ? Math.min(bundleBps + FEES.skrPackDiscountBps, 3_000) : bundleBps;
  const cents = b.currency === 'SKR' ? Math.floor((p.priceUsdCents * b.qty * (10_000 - discountBps)) / 10_000) : baseCents;
  const pity = me().pity.counters[b.sku];
  const amount = b.currency === 'SOL' ? solLamportsForUsdCents(cents)
    : b.currency === 'SKR' ? skrMicroForUsdCents(cents)
    : b.currency === 'USDC' ? usdcMicroForUsdCents(cents)
    : BigInt(Math.floor(((p.priceCgMicro ?? 0) * b.qty * (10_000 - discountBps)) / 10_000));
  const cap = b.currency === 'SOL' || b.currency === 'SKR';
  return {
    sku: b.sku, qty: b.qty, currency: b.currency, amount: String(amount), maxLamports: cap ? String(amount) : '0', discountBps, priceUsdCents: cents,
    rentReserveLamports: String(8_000_000 * p.chips * b.qty), solUsd: SOL_USD, skrUsd: SKR_USD, pythUpdateData: [],
    effectiveOddsBps: effectiveOdds(p, pity), pityCounter: pity, hardPityIn: p.pity ? Math.max(0, p.pity.hardAt - pity) : 0,
    nonce: String(Date.now()), accounts: {}, switchboardQueue: 'EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7', expiresAt: iso(24 * 3_600_000),
  };
});
on('post', '/packs/verify', (o) => {
  const { signature } = o.body as { signature: string };
  const roll = Array.from({ length: 32 }, () => Math.floor(rnd() * 256));
  // SEC-B6: the real endpoint recomputes RARITIES from the emitted bytes and compares them with the chain
  // (`onChain` keeps the districts; the pool is live chain state the API does not mirror) — mirror that shape,
  // so the mock cannot hide a regression in the verifier UI.
  const onChain = [{ rarity: 0, collection: 3 }, { rarity: 2, collection: 7 }, { rarity: 1, collection: 1 }];
  const recomputed = onChain.map((c) => ({ rarity: c.rarity }));
  return {
    signature, randomnessAccount: fakeKey('Rn'), rollHex: roll.map((b) => b.toString(16).padStart(2, '0')).join(''), pityBefore: 22,
    effectiveOddsBps: effectiveOdds(PACKS.standard, 22), recomputed, onChain, matches: true,
    assumed: { basis: 'published-defaults', sku: 1, chips: 3, floor: PACKS.standard.floor, pity: PACKS.standard.pity, paramsChangedBefore: false },
  };
});
on('get', '/packs/opens/{signature}', (_o, p) => ({ signature: p.signature, sku: 1, chips: chips.slice(0, 3), rollHex: '00'.repeat(32), pityBefore: 22, pityAfter: 23, highlights: { bestRarity: 2, newForSet: [7], completedSet: null } }));

on('get', '/collections', () => COLLECTIONS.map((c, idx) => ({
  idx, symbol: c.symbol, name: c.name, element: ['shadow', 'wheels', 'steel', 'wheels', 'noise', 'shadow', 'noise', 'wheels', 'paint', 'paint'][idx],
  palette: [c.color], lore: c.history, minted: 1200 + Math.floor(rnd() * 4000),
  mintedByRarity: [2600, 1500, 900, 480, 260, 100, 28, 9, 1].map((n) => Math.round(n * (0.6 + rnd() * 0.8))),
  floors: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((r) => (r >= 7 ? null : floorUsd(r))), featured: idx === 4,
})));
on('get', '/collections/{idx}/chips/{rarity}', (_o, p) => {
  const c = COLLECTIONS[Number(p.idx)]; const r = Number(p.rarity);
  return { collection: Number(p.idx), rarity: r, name: c.caps[r].name, lore: c.caps[r].desc, rim: RARITY_PROFILES[r].rim, supply: 300 - r * 30, floorUsd: r >= 7 ? null : floorUsd(r), listed: 3, basePower: RARITY_PROFILES[r].basePower, maxLevel: RARITY_PROFILES[r].maxLevel };
});
on('get', '/chips/{asset}', (_o, p) => {
  const c = chips.find((x) => x.asset === p.asset) ?? listings.find((x) => x.asset === p.asset) ?? chips[0];
  const arche = COLLECTIONS[c.collection].caps[c.rarity];
  return {
    ...c,
    provenance: { origin: c.rarity >= 3 ? 'fusion' : 'pack', signature: fakeKey(), rollHex: '9f'.repeat(32), recipe: c.rarity - 1 },
    sales: [{ asset: c.asset, seller: fakeKey(), buyer: fakeKey(), price: '120000000', currency: 'SOL', priceUsd: 18.3, fee: '6000000', royalty: '3000000', signature: fakeKey(), blockTime: iso(-5 * 86_400_000) }],
    archetype: { collection: c.collection, rarity: c.rarity, name: arche.name, lore: arche.desc, rim: RARITY_PROFILES[c.rarity].rim, supply: 420, floorUsd: floorUsd(c.rarity), listed: 4, basePower: RARITY_PROFILES[c.rarity].basePower, maxLevel: RARITY_PROFILES[c.rarity].maxLevel },
  };
});

on('get', '/market/listings', (o) => {
  const q = o.query ?? {};
  let items = listings.filter((c) =>
    (q.collection === undefined || c.collection === Number(q.collection)) &&
    (q.rarity === undefined || c.rarity === Number(q.rarity)) &&
    (q.rarityMin === undefined || c.rarity >= Number(q.rarityMin)) &&
    (q.currency === undefined || c.listing!.currency === q.currency) &&
    (q.levelMin === undefined || c.level >= Number(q.levelMin)) &&
    // mint-number range, same rule as the API: a chip whose `#N` is not resolved (`index: null`) never
    // matches a range filter (it has no number to compare — `#0` is a real chip)
    (q.indexMin === undefined || (c.index !== null && c.index >= Number(q.indexMin))) &&
    (q.indexMax === undefined || (c.index !== null && c.index <= Number(q.indexMax))) &&
    (q.priceMaxUsd === undefined || c.listing!.priceUsd <= Number(q.priceMaxUsd)),
  );
  if (q.missingForMySet) items = items.filter((c) => !chips.some((m) => m.collection === c.collection && m.rarity === c.rarity));
  const sort = String(q.sort ?? 'price_asc');
  const byIndex = (i: number | null) => (i === null ? Number.MAX_SAFE_INTEGER : i); // unresolved sorts last, as on the API
  items = [...items].sort((a, b) =>
    sort === 'price_desc' ? b.listing!.priceUsd - a.listing!.priceUsd
    : sort === 'rarity_desc' ? b.rarity - a.rarity || a.listing!.priceUsd - b.listing!.priceUsd
    : sort === 'newest' ? b.listing!.createdAt.localeCompare(a.listing!.createdAt)
    : sort === 'index_asc' ? byIndex(a.index) - byIndex(b.index) || a.listing!.priceUsd - b.listing!.priceUsd
    : a.listing!.priceUsd - b.listing!.priceUsd,
  );
  return { items: items.map((c) => ({ ...c.listing!, chip: c })), nextCursor: null, total: items.length };
});
on('get', '/market/floor', () => ({
  asOf: iso(), solUsd: SOL_USD, skrUsd: SKR_USD,
  floors: COLLECTIONS.map(() => [0, 1, 2, 3, 4, 5, 6, 7, 8].map((r) => (r >= 7 ? null : Number((floorUsd(r) * (0.85 + rnd() * 0.3)).toFixed(2))))),
  listedCount: COLLECTIONS.map(() => [0, 1, 2, 3, 4, 5, 6, 7, 8].map((r) => Math.max(0, 8 - r))),
  volume24hUsd: 4180.5,
}));
on('get', '/market/history', () => ({
  items: Array.from({ length: 12 }, (_, i) => { const r = pick([0, 1, 1, 2, 2, 3, 4]); const usd = floorUsd(r) * (0.9 + rnd() * 0.4); return { asset: fakeKey('As'), seller: fakeKey(), buyer: fakeKey(), price: String(Math.round((usd / SOL_USD) * 1e9)), currency: 'SOL', priceUsd: Number(usd.toFixed(2)), fee: '0', royalty: '0', signature: fakeKey(), blockTime: iso(-i * 3_600_000), rarity: r }; }),
  nextCursor: null,
}));
on('get', '/market/offers', () => []);

on('get', '/fusion/recipes', () => FUSION_RECIPES.map((r) => ({ from: r.from, to: r.to, rule: r.rule, successBps: r.successBps, refundOnFail: r.refundOnFail, feeCgMicro: String(r.feeCgMicro), resultLockSeconds: r.resultLockSeconds, boosterBonusBps: BOOSTER.bonusBps, boosterCapBps: BOOSTER.capBps })));
on('get', '/fusion/suggest', () => {
  const out: unknown[] = [];
  const free = chips.filter((c) => !c.flags.staked && !c.flags.listed && !c.flags.soulbound && c.rarity < 8);
  const groups = new Map<string, MockChip[]>();
  for (const c of free) {
    const k = `${c.rarity}:${c.collection}`;
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  for (const list of groups.values()) {
    if (list.length < 3) continue;
    out.push({ materials: list.slice(0, 3), recipe: list[0].rarity, resultCollection: list[0].collection, breaksSet: false });
  }
  return out;
});
on('post', '/fusion/plan', (o) => {
  const b = o.body as { materials: string[]; resultCollection?: number; useBooster?: boolean };
  const mats = b.materials.map((a) => chips.find((c) => c.asset === a)!).filter(Boolean);
  const r = FUSION_RECIPES[mats[0]?.rarity ?? 0];
  const successBps = b.useBooster && r.successBps < 10_000 ? Math.min(BOOSTER.capBps, r.successBps + BOOSTER.bonusBps) : r.successBps;
  return { materials: mats, recipe: { ...r, feeCgMicro: String(r.feeCgMicro), boosterBonusBps: BOOSTER.bonusBps, boosterCapBps: BOOSTER.capBps }, resultCollection: b.resultCollection ?? mats[0]?.collection ?? 0, resultRarity: r.to, successBps, feeCgMicro: String(r.feeCgMicro), breaksSet: false, warnings: [], nonce: String(Date.now()), accounts: {}, needsRandomness: r.successBps < 10_000 };
});

on('get', '/arena/me', () => ({ rating: 1184, rd: 62, league: 2, games: 41, wins: 24, streak: 3, rewardedMatchesLeft: 5, seasonRank: 412, projectedBracket: 'top 20%', season: 3, openBattles: [], currentMatch: null, queue: null, recent: [{ id: 'm-demo-1', opponent: fakeKey(), won: true, forfeit: false, reward: '2000000', endedAt: iso(-3_600_000), xp: CHIP_XP.win * 3, leveled: 1 }], pendingRewardMicro: '4500000' }));
on('get', '/arena/seasons/current', () => ({ id: 3, startsAt: iso(-19 * 86_400_000), endsAt: new Date(seasonEnd).toISOString(), poolCgMicro: '412500000000', brackets: SEASON.payoutBrackets, serverSecretHash: 'a1'.repeat(32), serverSecret: null, previous: { id: 2, serverSecretHash: 'b2'.repeat(32), serverSecret: 'c3'.repeat(32) }, weeks: SEASON.weeks, chipRewardByLeague: SEASON.chipRewardByLeague, soulboundDays: SEASON.soulboundDays }));
on('post', '/arena/queue', () => ({ ticket: fakeKey(), league: 2, squadPower: 1210, synergy: 1.08, estimatedWaitSec: 12, wsChannel: 'arena:mock', matchId: null }));
on('delete', '/arena/queue', () => undefined);
on('post', '/arena/simulate', (o) => {
  const b = o.body as { squadA: string[]; squadB: string[] };
  const pa = b.squadA.reduce((s, a) => s + (chips.find((c) => c.asset === a)?.power ?? 0), 0);
  const pb = b.squadB.reduce((s, a) => s + (listings.find((c) => c.asset === a)?.power ?? chips.find((c) => c.asset === a)?.power ?? 0), 0);
  return { powerA: pa, powerB: pb, winProbA: pa / Math.max(1, pa + pb), elementEdgeA: 0.02, synergyA: 1.08, synergyB: 1.0 };
});
on('get', '/arena/matches/{id}', (_o, p) => {
  const a = chips.filter((c) => !c.flags.listed).slice(0, 3); const b = listings.slice(0, 3);
  return {
    id: p.id, season: 3, a: ME, b: b[0].owner, squadA: a.map((c, i) => ({ ...c, xpGained: CHIP_XP.win, leveledTo: i === 0 ? (c.level ?? 1) + 1 : null })), squadB: b.map((c) => ({ ...c, xpGained: CHIP_XP.loss, leveledTo: null })), commitA: 'c'.repeat(64), commitB: 'd'.repeat(64), nonceA: 'n1', nonceB: 'n2', seed: 'e'.repeat(64),
    rounds: [0, 1, 2].map((i) => ({ lane: i, attacker: a[i].asset, defender: b[i].asset, elementEdge: i === 1 ? 0.15 : 0, luckA: 0.5 + rnd(), luckB: 0.5 + rnd(), effA: a[i].power, effB: b[i].power, winner: i === 1 ? b[0].owner : ME })),
    winner: ME, wagerCgMicro: '0', rewarded: true, rewardA: '2000000', rewardB: '500000', status: 'resolved', forfeit: false, bot: false, powerA: 1210, powerB: 1180, league: 2,
    startedAt: iso(-3_700_000), endedAt: iso(-3_600_000), serverSecretHash: 'a1'.repeat(32), serverSecret: null, seedFormula: 'sha256(matchId ‖ nonceA ‖ nonceB ‖ serverSecret)',
    emotes: mockEmotes(p.id),
  };
});
const emoteState: Record<string, { wallet: string; side: string; emote: string; at: string }[]> = {};
function mockEmotes(id: string) {
  if (!emoteState[id]) {
    emoteState[id] = [
      { wallet: ME, side: 'a', emote: 'gg', at: iso(-3_500_000) },
      { wallet: fakeKey('Op'), side: 'b', emote: 'rekt', at: iso(-3_400_000) },
    ];
  }
  return emoteState[id];
}
on('post', '/arena/matches/{id}/emotes', (o, p) => {
  const emote = String((o.body as { emote?: string })?.emote ?? '');
  const pack = EMOTE_PACK_OF[emote];
  if (!pack) throw new ApiError(400, 'bad_emote', 'unknown emote id');
  if (!entitlements.some((e) => e.kind === 4 && (e.payload as { pack?: string }).pack === pack)) throw new ApiError(402, 'pack_required', 'Own the emote pack first');
  const list = mockEmotes(p.id);
  if (list.some((e) => e.wallet === ME && Date.parse(e.at) > Date.now() - 5000)) throw new ApiError(429, 'slow_down', 'one tag every 5 seconds');
  const e = { wallet: ME, side: 'a', emote, at: iso() };
  list.push(e);
  return e;
});
on('post', '/arena/matches/{id}/reveal', (_o, p) => ({ ok: true, status: 'resolved', matchId: p.id, resolved: true, winner: ME, xp: CHIP_XP.win * 3, leveled: 1 }));

on('get', '/staking/overview', () => ({
  emission: { dayIndex: 143, year: 0, scheduleCapMicro: '271232876712', guardedMicro: '198000000000', burn7dAvgMicro: '93000000000', mintedTotalMicro: '28900000000000', splitBps: [2000, 500, 2200, 3300, 2000] },
  claimCaps: { chipDailyCg: 30, tokenDailyCg: 15, aliveWindowDays: 7, idleWeight: 0.25 },
  tokenPool: { tvlMicro: '38200000000000', totalWeight: '68760000000000', budgetTodayMicro: '29700000000', apyByTier: (['flex', 'd30', 'd90', 'd180'] as const).map((t) => Number(impliedApy(10_000, t, 68_760_000, 29_700).toFixed(1))) },
  chipPool: { stakedChips: 18420, totalWeight: '1420000', budgetTodayMicro: '59400000000', dailyPerWeightUnit: '41830' },
}));
on('get', '/staking/me', () => ({
  tokenStakes: [{ tier: 1, amount: '500000000', weight: '750000000', pending: '3120000', unlockAt: iso(11 * 86_400_000), earlyExitPenalty: '25000000' }],
  chipStakes: chips.filter((c) => c.flags.staked).map((c) => ({ chip: c, weight: String(Number(c.stakeWeight) * 1000), pending: String(Math.round(rnd() * 900_000)), since: iso(-9 * 86_400_000) })),
  setBonus: { onChainSets: 0, computedSets: 0, multBps: 10_000, syncPending: false },
  totalPendingMicro: '4870000',
}));
on('get', '/staking/pot', () => {
  const week = 2912;
  const weekStartsAt = week * 7 * 86_400 + 4 * 86_400;
  return {
    week,
    weekStartsAt,
    weekEndsAt: weekStartsAt + 7 * 86_400,
    winnersPerWeek: 10,
    soulboundDays: 7,
    template: 4,
    oddsBps: [0, 0, 5000, 4000, 1000, 0, 0, 0, 0],
    seedPrefix: 'gutter-pot:v1',
    live: { wallets: 18420, totalWeight: '1420000000000' },
    lastDraw: {
      week: week - 1,
      drawnAt: weekStartsAt - 60,
      slot: 312_000_000,
      seedHex: 'a'.repeat(64),
      ticketsHash: 'b'.repeat(64),
      totalWeight: '1380000000000',
      wallets: 17_900,
      winners: [{ wallet: ME, weight: '8800000' }],
    },
    me: { weight: '8800000', shareBps: 6, wonLast: true, pendingClaim: true },
  };
});
on('post', '/staking/estimate', (o) => {
  const b = o.body as { amountCgMicro: string; tier: number };
  const tier = (['flex', 'd30', 'd90', 'd180'] as const)[b.tier];
  const amt = Number(b.amountCgMicro) / 1e6;
  const apy = impliedApy(Math.max(1, amt), tier, 68_760_000, 29_700);
  return { apyPct: Number(apy.toFixed(1)), dailyCgMicro: String(Math.round((amt * apy) / 100 / 365 * 1e6)), unlockAt: iso(LOCK_TIERS[tier].lockSeconds * 1000), earlyExitPenaltyBps: LOCK_TIERS[tier].earlyExitPenaltyBps };
});

on('get', '/quests', () => {
  const all = [...DAILY_QUESTS, ...WEEKLY_QUESTS, ...PERMANENT_QUESTS];
  return all.map((q) => {
    const st = questState.get(q.id) ?? { value: Math.floor(rnd() * (q.target + 1)), claimed: false };
    questState.set(q.id, st);
    const done = st.value >= q.target;
    return {
      id: q.id, cadence: q.period, title: q.title, description: '', metric: q.metric, target: q.target, value: st.value, rewardCgMicro: String(q.rewardCgMicro),
      rewardChip: q.rewardChip ?? null, rewardBooster: q.rewardItem === 'booster' || q.rewardItems?.includes('booster') ? 1 : 0, rewardHint: q.rewardItem === 'hint' || q.rewardItems?.includes('hint') ? 1 : 0, completedAt: done ? iso(-3_600_000) : null, claimable: done && !st.claimed,
      ineligibleReason: null, resetsAt: iso(q.period === 'daily' ? 6 * 3_600_000 : q.period === 'weekly' ? 3 * 86_400_000 : 365 * 86_400_000),
    };
  });
});
on('get', '/quests/claims', () => [
  { kind: 2, epoch: 143, currency: 'CG', rootPda: fakeKey('Rt'), amountMicro: '9000000', proof: ['aa'.repeat(32), 'bb'.repeat(32)], claimableAt: iso(-60_000), claimed: false, published: true },
  // SKR root (kind 5 = Seeker-week quests) — paid from the treasury-funded prize pool
  { kind: 5, epoch: 21, currency: 'SKR', rootPda: fakeKey('Rs'), amountMicro: '12500000', proof: ['cc'.repeat(32)], claimableAt: iso(-30_000), claimed: false, published: true },
  // item root (kind 8 = fusion boosters, backlog #27) — amountMicro is the booster COUNT; claim_item_root CPIs chip_core grant_booster
  { kind: 8, epoch: 3, currency: 'ITEM', rootPda: fakeKey('Ri'), amountMicro: '2', proof: ['dd'.repeat(32)], claimableAt: iso(-20_000), claimed: false, published: true, memo: ['w_stake@w2971', 'p_set1@all'] },
  // chip voucher root (kind 9 = quest caps, backlog #28) — amountMicro is the voucher TEMPLATE (0 = 7-day streak cap); claim_chip_root CPIs chip_core open_voucher → a free 1-cap pack
  { kind: 9, epoch: 12, currency: 'CHIP', rootPda: fakeKey('Rc'), amountMicro: '0', proof: ['ee'.repeat(32)], claimableAt: iso(-10_000), claimed: false, published: true, memo: ['d_streak7@d20713', 'template:0'] },
]);
let mockLoginDay = -1;
on('get', '/quests/streak', () => ({ days: mockLoginDay === Math.floor(Date.now() / 86_400_000) ? 5 : 4, total: 11, nextChipAt: 7, resetsAt: iso(9 * 3_600_000), todayDone: mockLoginDay === Math.floor(Date.now() / 86_400_000) }));
on('post', '/quests/login', () => {
  const day = Math.floor(Date.now() / 86_400_000);
  const inserted = mockLoginDay !== day;
  mockLoginDay = day;
  return { day, inserted };
});
on('post', '/quests/visit', () => ({ day: Math.floor(Date.now() / 86_400_000), inserted: true }));

// ------------------------------------------------------------- beta pre-sale (docs/preorder-beta.md)
const PREORDER_TREASURY = fakeKey('Tr');
// Mirrors backend `preorderPayTo`: SOL pays the treasury wallet; USDC/SKR pay the treasury's token account
// for that mint. The token accounts are derived from the treasury key (deterministic, so the mock's random
// sequence is not shifted); they are display stand-ins, not real ATAs.
const PREORDER_MINTS = { USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', SKR: 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3' } as const;
const PREORDER_TOKEN_ACCOUNTS = { USDC: 'Tu' + PREORDER_TREASURY.slice(2), SKR: 'Ts' + PREORDER_TREASURY.slice(2) } as const;
const mockPreorderPayTo = (currency: 'SOL' | 'USDC' | 'SKR'): { payTo: string; mint?: string } =>
  currency === 'SOL' ? { payTo: PREORDER_TREASURY } : { payTo: PREORDER_TOKEN_ACCOUNTS[currency], mint: PREORDER_MINTS[currency] };
const PREORDER_PRICE = '300000000'; // 0.30 SOL per single
const PREORDER_CHEST_PRICE = '999000000';
const PREORDER_TOTAL = 500;
const PREORDER_CHEST_TOTAL = 125;
const PREORDER_TTL_S = 72 * 3_600;
let preorderSeq = 41;
interface MockPreorder { ref_id: number; wallet: string; sku: number; qty: number; offer: 'pack' | 'chest'; currency: 'SOL' | 'USDC' | 'SKR'; lamports: string; status: 'intent' | 'paid' | 'granted' | 'expired'; tx_sig: string | null; nonce: string | null; grant_sig: string | null; created_at: number; paid_at: number | null; granted_at: number | null }
const mockPreorderAmount = (solLamports: string, currency: 'SOL' | 'USDC' | 'SKR') => {
  if (currency === 'SOL') return solLamports;
  const cents = usdCentsFromSolLamports(BigInt(solLamports));
  return currency === 'USDC' ? usdcMicroForUsdCents(cents).toString() : skrMicroForUsdCents(cents).toString();
};
const mockPreorderPrices = (solLamports: string) => ({ SOL: solLamports, USDC: mockPreorderAmount(solLamports, 'USDC'), SKR: mockPreorderAmount(solLamports, 'SKR') });
const preorderRows: MockPreorder[] = [];
const preorderStats = () => {
  const sold = preorderRows.filter((r) => r.status === 'paid' || r.status === 'granted').reduce((s, r) => s + r.qty, 0) + 137;
  const granted = preorderRows.filter((r) => r.status === 'granted').reduce((s, r) => s + r.qty, 0);
  const packSold = preorderRows.filter((r) => r.offer !== 'chest' && (r.status === 'paid' || r.status === 'granted')).reduce((s, r) => s + r.qty, 0) + 137;
  const chestSold = preorderRows.filter((r) => r.offer === 'chest' && (r.status === 'paid' || r.status === 'granted')).length;
  return {
    active: true, sku: 3, priceLamports: PREORDER_PRICE, treasury: PREORDER_TREASURY, total: PREORDER_TOTAL,
    remaining: Math.max(0, PREORDER_TOTAL - packSold), sold, granted, memoPrefix: 'GC-PRE', intentTtlS: PREORDER_TTL_S,
    offers: [
      { id: 'pack', packs: 1, priceLamports: PREORDER_PRICE, prices: mockPreorderPrices(PREORDER_PRICE), total: PREORDER_TOTAL, remaining: Math.max(0, PREORDER_TOTAL - packSold), sold: packSold, maxPerWallet: 5, maxQty: 5 },
      { id: 'chest', packs: 4, priceLamports: PREORDER_CHEST_PRICE, prices: mockPreorderPrices(PREORDER_CHEST_PRICE), total: PREORDER_CHEST_TOTAL, remaining: Math.max(0, PREORDER_CHEST_TOTAL - chestSold), sold: chestSold, maxPerWallet: 1, maxQty: 1 },
    ],
  };
};
const preorderItem = (r: MockPreorder) => ({ ...r, memo: `GC-PRE|${r.ref_id}`, expiresAt: r.created_at + PREORDER_TTL_S });
on('get', '/preorder', () => preorderStats());
on('get', '/preorder/me', () => ({ items: preorderRows.filter((r) => r.wallet === ME).map(preorderItem).reverse() }));
on('get', '/preorder/registry', () => ({ campaign: preorderStats(), rows: preorderRows.filter((r) => r.status === 'paid' || r.status === 'granted').map((r) => ({ refId: r.ref_id, qty: r.qty, status: r.status, paidAt: r.paid_at, grantedAt: r.granted_at })) }));
on('post', '/preorder/intent', (o) => {
  const body = (o.body ?? {}) as { qty?: number; offer?: string; currency?: string };
  const offer = body.offer === 'chest' ? 'chest' as const : 'pack' as const;
  const currency = (body.currency === 'USDC' || body.currency === 'SKR' ? body.currency : 'SOL') as 'SOL' | 'USDC' | 'SKR';
  const qty = offer === 'chest' ? 1 : Number(body.qty ?? 1);
  if (offer === 'pack' && (!Number.isInteger(qty) || qty < 1 || qty > 5)) throw Object.assign(new Error('qty must be 1..5'), { status: 400, code: 'bad_qty' });
  const minePacks = preorderRows.filter((r) => r.wallet === ME && r.offer !== 'chest' && r.status !== 'expired').reduce((s, r) => s + r.qty, 0);
  const mineChests = preorderRows.filter((r) => r.wallet === ME && r.offer === 'chest' && r.status !== 'expired').length;
  if (offer === 'pack' && minePacks + qty > 5) throw Object.assign(new Error('At most 5 packs per wallet'), { status: 409, code: 'wallet_cap' });
  if (offer === 'chest' && mineChests >= 1) throw Object.assign(new Error('At most 1 chest per wallet'), { status: 409, code: 'wallet_cap' });
  const packs = offer === 'chest' ? 4 : qty;
  const solLamports = offer === 'chest' ? PREORDER_CHEST_PRICE : String(BigInt(PREORDER_PRICE) * BigInt(qty));
  const lamports = mockPreorderAmount(solLamports, currency);
  const row: MockPreorder = { ref_id: ++preorderSeq, wallet: ME, sku: 3, qty: packs, offer, currency, lamports, status: 'intent', tx_sig: null, nonce: null, grant_sig: null, created_at: Math.floor(Date.now() / 1000), paid_at: null, granted_at: null };
  preorderRows.push(row);
  const dest = mockPreorderPayTo(currency);
  return { refId: row.ref_id, wallet: ME, sku: 3, qty: packs, offer, currency, lamports: row.lamports, amount: row.lamports, treasury: PREORDER_TREASURY, ...dest, memo: `GC-PRE|${row.ref_id}`, expiresAt: row.created_at + PREORDER_TTL_S };
});
on('post', '/preorder/confirm', (o) => {
  const { refId, signature } = (o.body ?? {}) as { refId?: number; signature?: string };
  const row = preorderRows.find((r) => r.ref_id === Number(refId));
  if (!row) throw Object.assign(new Error('Unknown preorder reference'), { status: 404, code: 'not_found' });
  if (row.status === 'paid' && row.tx_sig === signature) return preorderItem(row);
  if (row.status !== 'intent') throw Object.assign(new Error(`Reservation is ${row.status}`), { status: 409, code: 'not_payable' });
  if (!signature || String(signature).length < 32) throw Object.assign(new Error('Transaction not found on mainnet (finalized)'), { status: 404, code: 'tx_not_found' });
  row.status = 'paid'; row.tx_sig = String(signature); row.paid_at = Math.floor(Date.now() / 1000);
  return preorderItem(row);
});

on('get', '/leaderboard/{board}', (_o, p) => ({
  board: p.board, season: 3,
  me: { rank: p.board === 'rating' ? 412 : 1287, value: p.board === 'rating' ? 1184 : p.board === 'wins' ? 9 : 41 },
  items: Array.from({ length: 50 }, (_, i) => ({ rank: i + 1, wallet: fakeKey(), handle: pick(['moth_king', 'railqueen', 'drain0', 'sk8_or_die', 'noise_boy', 'inkslinger', 'brakeless99', 'pixelbsmt', 'gutterbeast', 'citymyth']) + (i > 9 ? `_${i}` : ''), value: p.board === 'rating' ? 2400 - i * 21 : p.board === 'wins' ? 120 - i * 2 : p.board === 'collection' ? 72 - i : p.board === 'staking' ? 900_000 - i * 12_000 : 300 - i * 4, league: p.board === 'rating' ? Math.max(0, 5 - Math.floor(i / 10)) : 0, avatar: '' })),
  nextCursor: null,
}));

// ------------------------------------------------------------- ops panel (/admin — mirrors backend/src/admin.ts; the same guard-rails, nothing is signed)
const GUARD = { bpsDenom: 10_000, maxChipsPerPack: 5, minCommonBps: 500, maxTopTierBps: 0, priceCentsRange: [50, 50_000], pity: { minHardAt: 10, maxSoftStepBps: 200 }, maxMarketFeeBps: 1_000, maxSkrDiscountBps: 1_500, maxPackCgPriceMicro: 1_000_000_000_000, cgPriceMoveFactor: 2, split: { count: 5, maxDeltaBps: 1_000, minIntervalS: 7 * 86_400 }, evRatioRange: [0.55, 0.75] };
const adminState = {
  marketFeeBps: FEES.marketplaceFeeBps, skrDiscountBps: FEES.skrPackDiscountBps, featuredCollection: 4, paramsVersion: 3,
  splitBps: [3000, 1500, 1700, 2300, 1500], splitChangedAt: Math.floor(Date.now() / 1000) - 12 * 86_400, paused: { chip_core: false, staking: false, arena: false },
  packs: SKUS.map((id, sku) => { const p = PACKS[id]; return { sku, chips: p.chips, priceUsdCents: p.priceUsdCents, priceCgMicro: String(p.priceCgMicro ?? 0), oddsBps: [...p.oddsBps], floor: p.floor, dailyCap: p.dailyCap ?? 0, pity: p.pity ? { ...p.pity } : null, featuredOnly: p.pool === 'featured', enabled: true }; }),
};
const auditRows: { id: number; wallet: string; action: string; target: string | null; payload: unknown; ip: string | null; ok: boolean; ts: number }[] = [
  { id: 3, wallet: ME, action: 'params.propose', target: null, payload: { body: { marketFeeBps: 750 }, result: { ok: true, violations: 0 } }, ip: '10.0.0.7', ok: true, ts: Math.floor(Date.now() / 1000) - 3_600 },
  { id: 2, wallet: fakeKey('St'), action: 'denied:GET /v1/admin/kpi', target: null, payload: null, ip: '10.0.0.9', ok: false, ts: Math.floor(Date.now() / 1000) - 7_200 },
  { id: 1, wallet: ME, action: 'fraud.resolve', target: fakeKey('Wa'), payload: { body: { resolution: 'shadow_ban' }, result: { closed: 2 } }, ip: '10.0.0.7', ok: true, ts: Math.floor(Date.now() / 1000) - 86_400 },
];
const fraudRows = [
  { id: 11, wallet: fakeKey('Wt'), kind: 'win_trading', score: 82, evidence: { pair: 'A↔B', matches7d: 9, lopsided: 0.89, ratingGap: 40 }, ts: Math.floor(Date.now() / 1000) - 1_800, flags: {} },
  { id: 10, wallet: fakeKey('Ws'), kind: 'wash_trade', score: 71, evidence: { asset: fakeKey('As'), hops: 3, priceVsFloor: 3.4 }, ts: Math.floor(Date.now() / 1000) - 9_000, flags: {} },
  { id: 9, wallet: fakeKey('Wq'), kind: 'quest_bot', score: 64, evidence: { loginsSameMinute: 25, otherActivity: 0 }, ts: Math.floor(Date.now() / 1000) - 40_000, flags: { rewardsPaused: true } },
  { id: 8, wallet: fakeKey('Wm'), kind: 'multi_account', score: 58, evidence: { referrer: fakeKey('Wr'), starterOnlySiblings: 6 }, ts: Math.floor(Date.now() / 1000) - 90_000, flags: {} },
];
const auditPush = (action: string, payload: unknown, target: string | null = null) => { auditRows.unshift({ id: auditRows.length + 1, wallet: ME, action, target, payload, ip: '10.0.0.7', ok: true, ts: Math.floor(Date.now() / 1000) }); };
const adminParams = () => ({
  fetchedSlot: 312_456_789 + Math.floor(rnd() * 1000),
  gameConfig: {
    admin: 'HPMr5r9sS5ApWsPNJytZRLbm2jz1veFxTn1wepjAhtho', pendingAdmin: '11111111111111111111111111111111', pauser: fakeKey('Pa'), treasury: 'HPMr5r9sS5ApWsPNJytZRLbm2jz1veFxTn1wepjAhtho', buybackWallet: 'HPMr5r9sS5ApWsPNJytZRLbm2jz1veFxTn1wepjAhtho',
    cgMint: fakeKey('CG'), skrMint: 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3', pythSolUsdFeed: PYTH_PRICE_ACCOUNTS.SOL.toBase58(), pythSkrUsdFeed: PYTH_PRICE_ACCOUNTS.SKR.toBase58(),
    featuredCollection: adminState.featuredCollection, paused: adminState.paused.chip_core, marketFeeBps: adminState.marketFeeBps, skrDiscountBps: adminState.skrDiscountBps, collectionsCreated: 10, paramsVersion: adminState.paramsVersion,
    packs: adminState.packs.map((p) => ({ ...p, oddsBps: [...p.oddsBps], pity: p.pity ? { ...p.pity } : null })),
    liabilities: { lamports: '18450000000', usdc: '1240000000', cgMicro: '9750000000', skr: '212000000000' }, burnedTotalMicro: '184320000000',
    ledgerShards: [0, 1, 2, 3].map((shard) => ({ shard, initialized: true, lamports: String(4_000_000_000 + shard * 612_500_000), usdc: String(310_000_000), cgMicro: String(2_437_500_000), skr: String(53_000_000_000), burnedTotalMicro: String(46_080_000_000) })),
    ledgerShardsMissing: 0, ledgerShardCount: 4,
  },
  emission: {
    admin: 'HPMr5r9sS5ApWsPNJytZRLbm2jz1veFxTn1wepjAhtho', pauser: fakeKey('Pa'), questOracle: fakeKey('Qo'), seasonOracle: fakeKey('So'), setOracle: fakeKey('Se'), burnOracle: fakeKey('Bo'),
    dayIndex: 41, paused: adminState.paused.staking, splitBps: [...adminState.splitBps], splitChangedAt: adminState.splitChangedAt, nextSplitChangeAt: adminState.splitChangedAt + GUARD.split.minIntervalS,
    mintedTotalMicro: '2818000000000', burnTodayMicro: '61200000000', burn7dAvgMicro: '58400000000', sliceBudgetMicro: ['0', '0', '9600000000', '14100000000', '8200000000'],
  },
  // SEC-B24: the arena authority pair is its own account — `pause` / `set_arena` read these keys
  arena: { admin: ARENA_ADMIN, pauser: ARENA_PAUSER, paused: adminState.paused.arena },
  guardRails: GUARD,
  history: [{ signature: fakeKey(), admin: 'HPMr5r9sS5ApWsPNJytZRLbm2jz1veFxTn1wepjAhtho', version: 3, slot: 311_900_000, blockTime: Math.floor(Date.now() / 1000) - 5 * 86_400 }, { signature: fakeKey(), admin: 'HPMr5r9sS5ApWsPNJytZRLbm2jz1veFxTn1wepjAhtho', version: 2, slot: 309_100_000, blockTime: Math.floor(Date.now() / 1000) - 19 * 86_400 }],
});
on('get', '/admin/params', adminParams);
on('post', '/admin/params', (o) => {
  const b = (o.body ?? {}) as { packs?: { sku: number; priceUsdCents?: number; oddsBps?: number[]; enabled?: boolean; dailyCap?: number }[]; marketFeeBps?: number; skrDiscountBps?: number; featuredCollection?: number; emissionSplitBps?: number[]; note?: string };
  const violations: { path: string; rule: string; message: string; i18n?: { code: string; params?: Record<string, number | string> } }[] = [];
  const warnings: string[] = [];
  const warningDetails: { code: string; params?: Record<string, number | string>; message: string; context?: string }[] = [];
  const warn = (message: string, code: string, params?: Record<string, number | string>, context?: string) => { warnings.push(message); warningDetails.push({ message, code, params, context }); };
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  const instructions: { program: string; name: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string }[] = [];
  for (const [i, patch] of (b.packs ?? []).entries()) {
    const cur = adminState.packs[patch.sku];
    if (!cur) { violations.push({ path: `packs[${i}].sku`, rule: 'shape', message: 'sku 0..3', i18n: { code: 'sku' } }); continue; }
    const next = { ...cur, ...patch, oddsBps: patch.oddsBps ?? cur.oddsBps };
    const sum = next.oddsBps.reduce((a, x) => a + x, 0);
    if (sum !== GUARD.bpsDenom) violations.push({ path: `packs[${i}].oddsBps`, rule: 'OddsSumInvalid', message: `odds sum to ${sum}, must be 10000`, i18n: { code: 'oddsSum', params: { sum } } });
    if (next.oddsBps[0] < GUARD.minCommonBps) violations.push({ path: `packs[${i}].oddsBps[0]`, rule: 'OddsGuardRail', message: 'Common must stay ≥ 5 % (500 bps)', i18n: { code: 'commonFloor', params: { min: GUARD.minCommonBps } } });
    const top2 = next.oddsBps[6] + next.oddsBps[7] + next.oddsBps[8], cap = GUARD.maxTopTierBps;
    if (top2 > cap) violations.push({ path: `packs[${i}].oddsBps`, rule: 'OddsGuardRail', message: `Legend and above = ${top2} bps exceeds the ${cap} bps cap for sku ${patch.sku}`, i18n: { code: 'topOdds', params: { sum: top2, max: cap, sku: patch.sku } } });
    if (next.priceUsdCents < GUARD.priceCentsRange[0] || next.priceUsdCents > GUARD.priceCentsRange[1]) violations.push({ path: `packs[${i}].priceUsdCents`, rule: 'OddsGuardRail', message: 'price must be $0.50 … $500', i18n: { code: 'usdRange', params: { min: GUARD.priceCentsRange[0] / 100, max: GUARD.priceCentsRange[1] / 100 } } });
    if (patch.sku !== 0 && next.priceUsdCents !== cur.priceUsdCents) { const ratio = (cur.priceUsdCents / next.priceUsdCents) * 0.65; if (ratio < GUARD.evRatioRange[0] || ratio > GUARD.evRatioRange[1]) warn(`packs[${i}] (sku ${patch.sku}): EV/price ${(ratio * 100).toFixed(0)} % is outside the 55–75 % band the economy report enforces (Standard anchor = 65 %)`, 'evBand', { ratio: Number.isFinite(ratio) ? Math.round(ratio * 100) : '∞', min: 55, max: 75, anchor: 65 }, `packs[${i}] / SKU ${patch.sku}`); }
    diff[`packs[${patch.sku}]`] = { from: cur, to: next };
  }
  if (b.marketFeeBps !== undefined) { if (b.marketFeeBps > GUARD.maxMarketFeeBps) violations.push({ path: 'marketFeeBps', rule: 'FeeTooHigh', message: 'market fee is capped at 1000 bps (10 %)', i18n: { code: 'marketCap', params: { max: GUARD.maxMarketFeeBps } } }); else diff.marketFeeBps = { from: adminState.marketFeeBps, to: b.marketFeeBps }; if (b.marketFeeBps < FEES.marketplaceFeeBps) warn(`market fee below the modelled ${FEES.marketplaceFeeBps} bps lowers treasury + buyback flow (docs/02 §6)`, 'lowMarketFee', { bps: FEES.marketplaceFeeBps }); }
  if (b.skrDiscountBps !== undefined) { if (b.skrDiscountBps > GUARD.maxSkrDiscountBps) violations.push({ path: 'skrDiscountBps', rule: 'FeeTooHigh', message: 'SKR discount is capped at 1500 bps (15 %)', i18n: { code: 'skrCap', params: { max: GUARD.maxSkrDiscountBps } } }); else diff.skrDiscountBps = { from: adminState.skrDiscountBps, to: b.skrDiscountBps }; }
  if (b.featuredCollection !== undefined) { if (b.featuredCollection < 0 || b.featuredCollection > 9) violations.push({ path: 'featuredCollection', rule: 'InvalidCollection', message: '0..9', i18n: { code: 'collection', params: { max: 9 } } }); else diff.featuredCollection = { from: adminState.featuredCollection, to: b.featuredCollection }; }
  if (b.emissionSplitBps !== undefined) {
    const s = b.emissionSplitBps, sum = s.reduce((a, x) => a + x, 0);
    if (s.length !== 5) violations.push({ path: 'emissionSplitBps', rule: 'shape', message: '5 integer bps (chip / token / quests / pvp / events)', i18n: { code: 'splitShape', params: { n: 5 } } });
    else if (sum !== 10_000) violations.push({ path: 'emissionSplitBps', rule: 'SplitSum', message: `split sums to ${sum}, must be 10000`, i18n: { code: 'splitSum', params: { sum } } });
    else { s.forEach((v, i) => { if (Math.abs(v - adminState.splitBps[i]) > GUARD.split.maxDeltaBps) violations.push({ path: `emissionSplitBps[${i}]`, rule: 'SplitGuard', message: `Δ ${v - adminState.splitBps[i]} bps exceeds ±1000 per change`, i18n: { code: 'splitDelta', params: { delta: v - adminState.splitBps[i], max: GUARD.split.maxDeltaBps } } }); }); if (!violations.some((v) => v.path.startsWith('emissionSplitBps'))) { diff.emissionSplitBps = { from: [...adminState.splitBps], to: s }; if (s[3] < adminState.splitBps[3]) warn('pvpSeason slice shrinks: the current season pool estimate drops from the next DayClosed', 'seasonShrinks'); } }
  }
  if (Object.keys(diff).length === 0 && violations.length === 0) violations.push({ path: '', rule: 'empty', message: 'nothing to change', i18n: { code: 'empty' } });
  const ok = violations.length === 0;
  if (ok) {
    if (Object.keys(diff).some((k) => k !== 'emissionSplitBps')) instructions.push({ program: 'chip_core', name: 'set_params', accounts: [{ pubkey: 'HPMr5r9sS5ApWsPNJytZRLbm2jz1veFxTn1wepjAhtho', isSigner: true, isWritable: false }, { pubkey: fakeKey('Cf'), isSigner: false, isWritable: true }], data: btoa(String.fromCharCode(...Array.from({ length: 40 }, () => Math.floor(rnd() * 256)))) });
    if (diff.emissionSplitBps) instructions.push({ program: 'staking', name: 'set_split', accounts: [{ pubkey: 'HPMr5r9sS5ApWsPNJytZRLbm2jz1veFxTn1wepjAhtho', isSigner: true, isWritable: false }, { pubkey: fakeKey('Em'), isSigner: false, isWritable: true }], data: btoa(String.fromCharCode(...Array.from({ length: 18 }, () => Math.floor(rnd() * 256)))) });
  }
  auditPush('params.propose', { body: b, result: { ok, violations: violations.length } });
  const proposal = { ok, violations, warnings, warningDetails, instructions, diff };
  if (!ok) throw new ApiError(422, 'guard_rail', violations.map((v) => `${v.path}: ${v.message}`).join('; '), proposal);
  return proposal;
});
on('post', '/admin/kill-switch', (o) => {
  const b = (o.body ?? {}) as { program: 'chip_core' | 'staking' | 'arena'; paused: boolean; reason?: string };
  const current = adminState.paused[b.program] ?? false;
  const signer = b.paused
    ? (b.program === 'arena' ? ARENA_PAUSER : b.program === 'staking' ? STAKING_PAUSER : CHIP_PAUSER)
    : (b.program === 'arena' ? ARENA_ADMIN : b.program === 'staking' ? STAKING_ADMIN : CHIP_ADMIN);
  if (b.paused && !(b.reason && b.reason.trim().length >= 8)) throw new ApiError(422, 'bad_request', 'reason: a pause needs a ≥ 8-char incident note (goes to the audit log + status page)', { ok: false, violations: [{ path: 'reason', rule: 'required', message: 'a pause needs a ≥ 8-char incident note', i18n: { code: 'incidentNote' } }], warnings: [], instructions: [], diff: {} });
  auditPush('kill_switch', { body: b, result: { ok: true } }, b.program);
  const warnings = [...(current === b.paused ? [`${b.program} is already ${b.paused ? 'paused' : 'running'} — this transaction changes nothing`] : []), b.paused ? 'pause blocks new purchases / listings / stakes / battles only — unstake, cancel, refund and withdraw keep working (docs/03 §2.5)' : 'un-pause is admin-only: this instruction needs the multisig (2/5 arena, 3/5 chip_core / staking)'];
  return {
    ok: true, violations: [],
    instructions: [{ program: b.program, name: b.paused ? 'pause' : b.program === 'arena' ? 'set_arena' : 'set_paused', accounts: [{ pubkey: signer, isSigner: true, isWritable: false }, { pubkey: b.program === 'arena' ? fakeKey('Ac') : fakeKey('Cf'), isSigner: false, isWritable: true }], data: btoa(String.fromCharCode(...Array.from({ length: 9 }, () => Math.floor(rnd() * 256)))) }],
    warnings,
    warningDetails: warnings.map((message, i) => ({ message, code: current === b.paused && i === 0 ? (b.paused ? 'alreadyPaused' : 'alreadyRunning') : b.paused ? 'pauseExits' : 'resumeMultisig', params: { program: b.program } })),
    diff: { [`${b.program}.paused`]: { from: current, to: b.paused } },
  };
});
on('post', '/admin/simulate', (o) => {
  const b = (o.body ?? {}) as { assumptions?: Record<string, number>; year?: number; splitBps?: number[] };
  const base = { dau: 5_000, payingShare: 0.08, packsPerPayerPerWeek: 3, payerCgPackShare: 0.35, activeSpendShare: 0.6, stakerSpendShare: 0.2, fusionsPerDauPerDay: 0.1, avgFusionFeeCg: 10, pvpMatchesPerDauPerDay: 2, wageredShare: 0.3, avgWagerCg: 20, marketplaceVolumeCgPerDauPerDay: 40 };
  const a = { ...base, ...(b.assumptions ?? {}) };
  const year = b.year ?? 0;
  const flows = (x: typeof base) => { const cap = Math.round(68_760_000 * [0.18, 0.14, 0.11, 0.09, 0.07, 0.055, 0.045, 0.04][Math.min(7, year)] / 365); const packs = (x.dau * x.payingShare * x.packsPerPayerPerWeek) / 7; const burned = Math.round(packs * x.payerCgPackShare * 750 * 0.75 + x.dau * x.fusionsPerDauPerDay * x.avgFusionFeeCg + x.dau * x.pvpMatchesPerDauPerDay * x.wageredShare * x.avgWagerCg * 0.02 + x.dau * x.marketplaceVolumeCgPerDauPerDay * 0.075 * 0.5); const emission = Math.min(cap, Math.max(Math.round(cap * 0.3), Math.round(burned * 1.25))); return { scheduleCapCg: cap, emissionCg: emission, burnedCg: burned, treasuryCg: Math.round(burned * 0.2), netInflationCg: emission - burned, sinkRatio: +(burned / Math.max(1, emission)).toFixed(2), perDauEmission: +(emission / Math.max(1, x.dau)).toFixed(2) }; };
  const baseline = flows(base), scenario = flows(a);
  const split = b.splitBps && b.splitBps.length === 5 ? b.splitBps : adminState.splitBps;
  auditPush('simulate', { body: b, result: { ok: true } });
  return {
    year, assumptions: a, baseline, scenario,
    delta: Object.fromEntries(Object.keys(scenario).map((k) => [k, +((scenario as Record<string, number>)[k] - (baseline as Record<string, number>)[k]).toFixed(2)])),
    slices: ['chipStaking', 'tokenStaking', 'quests', 'pvpSeason', 'eventsReserve'].map((name, i) => ({ name, bps: split[i], cgPerDay: Math.round((scenario.emissionCg * split[i]) / 10_000) })),
    guard: { floorShare: EMISSION_GUARD.floorShare, burnMultiple: EMISSION_GUARD.burnMultiple, emissionAtZeroBurnCg: Math.round(scenario.scheduleCapCg * EMISSION_GUARD.floorShare) },
    packs: SKUS.map((id) => ({ id, evCommonEq: +packExpectedValueMult(PACKS[id]).toFixed(2), pLegend: +probabilityAtLeast(PACKS[id], 6).toFixed(4) })),
    rarityValueMult: RARITY_PROFILES.map((r) => r.valueMult),
  };
});
on('get', '/admin/kpi', () => ({
  asOf: iso(),
  players: { wallets: 18_420, dau: 4_310, payersLifetime: 1_612, payers30d: 1_188, conversionToFirstPack: 0.0875, starterToPaidConversion: 0.231 },
  retention: { d1: { cohort: 812, retained: 341, rate: 0.42 }, d7: { cohort: 690, retained: 152, rate: 0.22 }, d30: { cohort: 402, retained: 44, rate: 0.109 } },
  revenue: { usd30d: 41_280.5, arppu30d: 34.75, packs30d: 9_814, services30d: 1_037 },
  economy: { burned7dMicro: '408800000000', emitted7dMicro: '512400000000', sinkRatio7d: 0.798, guardedDailyMicro: '73200000000', guardSource: 'chain', floorIndexUsdPerCommonEq: 0.104, floorsByRarityUsd: [0, 1, 2, 3, 4, 5, 6].map((r) => ({ rarity: r, usd: floorUsd(r) })) },
  market: { listings: 1_204, volume7dUsd: 12_930.2 },
  arena: { season: 3, endsAt: Math.floor(Date.now() / 1000) + 17 * 86_400, poolCgMicro: '182000000000', matches7d: 41_200, botShare7d: 0.18, wagerBattles7d: 2_140 },
  fraud: { openSignals: { win_trading: 1, wash_trade: 1, quest_bot: 1, multi_account: 1 }, lastSignalAt: Math.floor(Date.now() / 1000) - 1_800, paused: 4, shadowBanned: 2, trusted: 3, human: { verified7d: 3_950, required: true } },
  finality: { horizonSlot: 312_456_000, lagSlots: 32, evictedTotal: 0, consumedAlerts: 0 },
}));
on('get', '/admin/fraud', () => fraudRows);
on('post', '/admin/fraud/{wallet}', (o, p) => {
  const b = (o.body ?? {}) as { resolution: string; note?: string };
  const flags: Record<string, unknown> = {};
  if (b.resolution === 'shadow_ban' || b.resolution === 'ban') flags.shadowBanned = true;
  if (b.resolution === 'rewards_pause' || b.resolution === 'ban') flags.rewardsPaused = true;
  if (b.resolution === 'trust') flags.trusted = true;
  if (b.note) flags.note = b.note;
  let closed = 0;
  for (let i = fraudRows.length - 1; i >= 0; i--) if (fraudRows[i].wallet === p.wallet) { fraudRows.splice(i, 1); closed++; }
  auditPush('fraud.resolve', { body: b, result: { flags, closed } }, p.wallet);
  return { flags, closed };
});
on('get', '/admin/audit', () => auditRows);

// ------------------------------------------------------------- dispatcher
export async function mockRequest(method: string, path: string, opts: RequestOpts): Promise<unknown> {
  await new Promise((f) => setTimeout(f, 80 + Math.random() * 160));
  let p = path;
  if (opts.path) for (const [k, v] of Object.entries(opts.path)) p = p.replace(`{${k}}`, String(v));
  if (isRightsPath(p)) return mockRights(method, p, opts);
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.pattern.exec(p);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    return r.h(opts, params);
  }
  throw Object.assign(new Error(`mock: no route ${method.toUpperCase()} ${p}`), { status: 404 });
}

// ------------------------------------------------------------- phase-G launch simulator
// The mock stands in for the phase-G backend: an order is created with a seed
// commitment, 'confirm' marks it paid, and the next polls 'mint' it — the same
// states the real backend walks through, nothing hidden.
interface MockOrder { id: number; sku: number; qty: number; currency: string; status: string; polls: number; assets: { assetId: string; collectionIdx: number; rarity: number; gameIndex: number }[] }
const mockOrders = new Map<number, MockOrder>();
let mockOrderSeq = 1000;
const MOCK_TREASURY = 'MockTreasury1111111111111111111111111111111';
on('post', '/packs/order', (o) => {
  const b = (o.body ?? {}) as { sku: number; qty: number; currency: string };
  const id = ++mockOrderSeq;
  mockOrders.set(id, { id, sku: b.sku, qty: b.qty, currency: b.currency, status: 'created', polls: 0, assets: [] });
  return { orderId: id, memo: `GC-ORD|${id}`, payTo: MOCK_TREASURY, payToOwner: MOCK_TREASURY, mint: null, amount: '54454545', currency: b.currency, seedHash: 'ab'.repeat(32), expiresAt: Math.floor(Date.now() / 1000) + 1800 };
});
on('post', '/packs/order/{id}/confirm', (_o, p) => {
  const m = mockOrders.get(Number(p.id));
  if (!m) throw new ApiError(404, 'not_found', 'Unknown order');
  m.status = 'paid';
  return mockOrderView(m);
});
function mockOrderView(m: MockOrder) {
  if (m.status === 'paid' && ++m.polls >= 2) {
    m.status = 'minted';
    const roll = mockRoll(m.sku, m.qty).flat();
    m.assets = roll.map((r, i) => ({ assetId: `mockAsset${m.id}x${i}`, collectionIdx: r.collection, rarity: r.rarity, gameIndex: i + 1 }));
  }
  return {
    orderId: m.id, sku: m.sku, qty: m.qty, currency: m.currency, amount: '54454545', payTo: MOCK_TREASURY, mint: null,
    memo: `GC-ORD|${m.id}`, status: m.status, seedHash: 'ab'.repeat(32), seed: m.status === 'minted' ? 'cd'.repeat(32) : null,
    txSig: 'mock-payment', assets: m.status === 'minted' ? m.assets : null,
    createdAt: Math.floor(Date.now() / 1000), expiresAt: Math.floor(Date.now() / 1000) + 1800, mintedAt: m.status === 'minted' ? Math.floor(Date.now() / 1000) : null,
  };
}
on('get', '/packs/order/{id}', (_o, p) => {
  const m = mockOrders.get(Number(p.id));
  if (!m) throw new ApiError(404, 'not_found', 'Unknown order');
  return mockOrderView(m);
});
on('get', '/packs/order/{id}/verify', (_o, p) => {
  const m = mockOrders.get(Number(p.id));
  if (!m || m.status !== 'minted') throw new ApiError(404, 'not_found', 'Unknown or unminted order');
  return { orderId: m.id, matches: true, rarities: m.assets.map((a) => a.rarity), collections: m.assets.map((a) => a.collectionIdx), assets: m.assets };
});
on('get', '/packs/mint-journal', () => ({
  tree: null,
  entries: [...mockOrders.values()].filter((m) => m.status === 'minted').map((m) => ({
    orderId: m.id, wallet: ME, sku: m.sku, qty: m.qty, seedHash: 'ab'.repeat(32), seed: 'cd'.repeat(32), assets: m.assets, txSig: 'mock-payment', mintedAt: Math.floor(Date.now() / 1000),
  })),
}));
const mockSoftStakes = new Set<string>();
on('post', '/staking/soft/stake', (o) => { const a = String((o.body as { asset?: string })?.asset ?? ''); mockSoftStakes.add(a); return { asset: a, stakedAt: Math.floor(Date.now() / 1000) }; });
on('post', '/staking/soft/unstake', (o) => { const a = String((o.body as { asset?: string })?.asset ?? ''); mockSoftStakes.delete(a); return { asset: a, unstakedAt: Math.floor(Date.now() / 1000) }; });
on('get', '/staking/soft/me', () => ({ staked: [...mockSoftStakes].map((asset) => ({ asset, stakedAt: Math.floor(Date.now() / 1000) })), pendingMicro: '125000000', claimedMicro: '0', payouts: [] }));
on('post', '/staking/soft/claim', () => ({ payoutId: 1, amountMicro: '125000000', status: 'sent' }));

/** Used by the mock pack flow to fabricate a believable result. */
export function mockRoll(sku: number, qty: number) {
  const p = PACKS[SKUS[sku]];
  const out: { rarity: number; collection: number }[][] = [];
  for (let n = 0; n < qty; n++) {
    const pack: { rarity: number; collection: number }[] = [];
    for (let i = 0; i < p.chips; i++) {
      let x = rnd() * 10_000; let r = 0;
      for (let k = 0; k < 9; k++) { x -= p.oddsBps[k]; if (x < 0) { r = k; break; } }
      if (i === p.chips - 1 && r < p.floor) r = p.floor;
      pack.push({ rarity: r, collection: Math.floor(rnd() * COLLECTIONS.length) });
    }
    out.push(pack);
  }
  return out;
}

export const MOCK_WALLET = ME;
export { MATCHMAKING };
