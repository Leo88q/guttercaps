// Deterministic in-browser backend used when VITE_API_MOCK=true or when the
// real API is unreachable in dev. Data is derived from @guttercaps/economy
// and shared/lib/lore so what you see matches the modelled numbers.
import {
  PACKS, FUSION_RECIPES, BOOSTER, RARITY_PROFILES, LOCK_TIERS, DAILY_QUESTS, WEEKLY_QUESTS, PERMANENT_QUESTS, MATCHMAKING, SEASON, FEES, SERVICES, REFERRAL,
  packExpectedValueMult, probabilityAtLeast, effectiveOdds, bundlePriceCents, impliedApy, unitsForCents, maxUnitsWithSlippage, type PackId,
  SKIN_BY_ID, PROFILE_THEME_BY_ID, EMOTE_PACK_BY_ID, EMOTE_PACK_OF, PASS_TRACK, passTierForXp,
} from '@guttercaps/economy';
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
  flags: { staked: boolean; listed: boolean; fusing: boolean; soulbound: boolean };
  lockUntil: string | null; power: number; stakeWeight: string;
  skin: string | null;
  art: { image: string; video?: string; vfxTier: number };
  listing?: { asset: string; seller: string; price: string; currency: 'SOL' | 'USDC'; priceUsd: number; createdAt: string };
}

const SOL_USD = 152.3;
const SKR_USD = 0.0174;
const floorUsd = (r: number) => Number((3.5 * RARITY_PROFILES[r].valueMult * 0.62).toFixed(2));

function makeChip(collection: number, rarity: number, owner = ME, opts: Partial<MockChip> = {}): MockChip {
  const level = 1 + Math.floor(rnd() * Math.min(6, RARITY_PROFILES[rarity].maxLevel - 1));
  const power = Math.round(RARITY_PROFILES[rarity].basePower * (1 + 0.025 * (level - 1)));
  return {
    asset: fakeKey('As'), owner, collection, rarity, level, index: 1 + Math.floor(rnd() * 5000),
    flags: { staked: false, listed: false, fusing: false, soulbound: false }, lockUntil: null, power, skin: null,
    stakeWeight: String(RARITY_PROFILES[rarity].stakeWeight), art: { image: `/art/${COLLECTIONS[collection]?.num ?? '01'}-${rarity}-256.webp`, vfxTier: RARITY_PROFILES[rarity].vfxTier },
    ...opts,
  };
}

const chips: MockChip[] = [];
// a believable mid-game inventory: lots of commons, a few epics, one legend
const inventoryPlan: [number, number][] = [[0, 14], [1, 9], [2, 7], [3, 4], [4, 3], [5, 1], [6, 1]];
for (const [r, n] of inventoryPlan) for (let i = 0; i < n; i++) chips.push(makeChip(Math.floor(rnd() * COLLECTIONS.length), r));
// one COMPLETE set for NIGHTMOTH (9/9) so the district-banner cosmetic is previewable
for (let r = 0; r <= 8; r++) if (!chips.some((c) => c.collection === 0 && c.rarity === r)) chips.push(makeChip(0, r));
chips[0].flags.staked = true; chips[1].flags.staked = true; chips[2].flags.staked = true;
chips[5].flags.soulbound = true; chips[5].lockUntil = iso(3 * 86_400_000);

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
  return { items, nextCursor: null, total: items.length };
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
  services: SERVICES.map((sv) => ({ id: sv.id, kind: sv.kind, name: sv.name, priceUsdCents: sv.priceUsdCents, dailyCap: sv.dailyCap, recurring: sv.recurring, quotes: {
    SOL: String(Math.round((sv.priceUsdCents / 100 / SOL_USD) * 1e9 * 1.01)), USDC: String(sv.priceUsdCents * 10_000), CG: String(sv.priceUsdCents * 1_000_000), SKR: String(Math.round((sv.priceUsdCents / 100 / SKR_USD) * 1e6 * 1.01)),
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
  const e = { id: `e${entitlements.length + 1}`, kind, payload, signature: `pass:3:${b.tier}`, currency: 'CG', amount: '0', grantedAt: iso(), expiresAt: null };
  entitlements.push(e);
  return e;
});

on('get', '/packs', () => ({
  packs: SKUS.map((id, sku) => {
    const p = PACKS[id];
    const ev = ((packExpectedValueMult(p) * 3.5 * 0.62) / (p.priceUsdCents / 100)) * 100;
    return {
      sku, name: p.name, chips: p.chips, priceUsdCents: p.priceUsdCents, priceCgMicro: p.priceCgMicro === null ? null : String(p.priceCgMicro),
      currencies: p.priceCgMicro ? ['SOL', 'USDC', 'CG'] : ['SOL', 'USDC'], oddsBps: [...p.oddsBps], floor: p.floor, dailyCap: p.dailyCap,
      pity: p.pity ? { ...p.pity } : null, pool: p.pool, enabled: id !== 'limited', pAtLeastLegend: probabilityAtLeast(p, 6), evPct: Number(ev.toFixed(1)),
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
  const volatile = b.currency === 'SOL' || b.currency === 'SKR';
  // same integer formula as chip_core::units_for_cents, priced from a synthetic Pyth update (expo −8)
  const pyth = b.currency === 'SKR' ? { price: BigInt(Math.round(SKR_USD * 1e8)), decimals: 6, account: PYTH_PRICE_ACCOUNTS.SKR.toBase58() } : { price: BigInt(Math.round(SOL_USD * 1e8)), decimals: 9, account: PYTH_PRICE_ACCOUNTS.SOL.toBase58() };
  const amount = volatile ? unitsForCents(cents, pyth.price, -8, pyth.decimals)
    : b.currency === 'USDC' ? BigInt(cents * 10_000)
    : BigInt(Math.floor(((p.priceCgMicro ?? 0) * b.qty * (10_000 - discountBps)) / 10_000));
  const priceAgeS = 5 + Math.floor(rnd() * 25); // our pusher posts every ≈ 30 s
  return {
    sku: b.sku, qty: b.qty, currency: b.currency, amount: String(amount), maxLamports: volatile ? String(maxUnitsWithSlippage(amount)) : '0', discountBps, priceUsdCents: cents,
    rentReserveLamports: String(8_000_000 * p.chips * b.qty), solUsd: SOL_USD, skrUsd: SKR_USD, pythUpdateData: [],
    ...(volatile ? { priceUpdateAccount: pyth.account, priceAgeS } : {}),
    effectiveOddsBps: effectiveOdds(p, pity), pityCounter: pity, hardPityIn: p.pity ? Math.max(0, p.pity.hardAt - pity) : 0,
    nonce: String(Date.now()), accounts: {}, switchboardQueue: 'EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7', expiresAt: iso(volatile ? (60 - priceAgeS) * 1000 : 300_000),
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
  const byR = new Map<number, MockChip[]>();
  for (const c of chips) if (!c.flags.staked && !c.flags.listed && !c.flags.soulbound) byR.set(c.rarity, [...(byR.get(c.rarity) ?? []), c]);
  const out: unknown[] = [];
  for (const [r, list] of byR) if (list.length >= 3 && r < 8) out.push({ materials: list.slice(0, 3), recipe: r, resultCollection: list[0].collection, breaksSet: false });
  return out;
});
on('post', '/fusion/plan', (o) => {
  const b = o.body as { materials: string[]; resultCollection?: number; useBooster?: boolean };
  const mats = b.materials.map((a) => chips.find((c) => c.asset === a)!).filter(Boolean);
  const r = FUSION_RECIPES[mats[0]?.rarity ?? 0];
  const successBps = b.useBooster && r.successBps < 10_000 ? Math.min(BOOSTER.capBps, r.successBps + BOOSTER.bonusBps) : r.successBps;
  return { materials: mats, recipe: { ...r, feeCgMicro: String(r.feeCgMicro), boosterBonusBps: BOOSTER.bonusBps, boosterCapBps: BOOSTER.capBps }, resultCollection: b.resultCollection ?? mats[0]?.collection ?? 0, resultRarity: r.to, successBps, feeCgMicro: String(r.feeCgMicro), breaksSet: false, warnings: [], nonce: String(Date.now()), accounts: {}, needsRandomness: r.successBps < 10_000 };
});

on('get', '/arena/me', () => ({ rating: 1184, rd: 62, league: 2, games: 41, wins: 24, streak: 3, rewardedMatchesLeft: 5, seasonRank: 412, projectedBracket: 'top 20%', season: 3, openBattles: [], currentMatch: null, queue: null, recent: [{ id: 'm-demo-1', opponent: fakeKey(), won: true, forfeit: false, reward: '2000000', endedAt: iso(-3_600_000) }], pendingRewardMicro: '4500000' }));
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
    id: p.id, season: 3, a: ME, b: b[0].owner, squadA: a, squadB: b, commitA: 'c'.repeat(64), commitB: 'd'.repeat(64), nonceA: 'n1', nonceB: 'n2', seed: 'e'.repeat(64),
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
on('post', '/arena/matches/{id}/reveal', (_o, p) => ({ ok: true, status: 'resolved', matchId: p.id, resolved: true, winner: ME }));

on('get', '/staking/overview', () => ({
  emission: { dayIndex: 143, year: 0, scheduleCapMicro: '271232876712', guardedMicro: '198000000000', burn7dAvgMicro: '93000000000', mintedTotalMicro: '28900000000000', splitBps: [3000, 1500, 1700, 2300, 1500] },
  tokenPool: { tvlMicro: '38200000000000', totalWeight: '68760000000000', budgetTodayMicro: '29700000000', apyByTier: (['flex', 'd30', 'd90', 'd180'] as const).map((t) => Number(impliedApy(10_000, t, 68_760_000, 29_700).toFixed(1))) },
  chipPool: { stakedChips: 18420, totalWeight: '1420000', budgetTodayMicro: '59400000000', dailyPerWeightUnit: '41830' },
}));
on('get', '/staking/me', () => ({
  tokenStakes: [{ tier: 1, amount: '500000000', weight: '750000000', pending: '3120000', unlockAt: iso(11 * 86_400_000), earlyExitPenalty: '25000000' }],
  chipStakes: chips.filter((c) => c.flags.staked).map((c) => ({ chip: c, weight: String(Number(c.stakeWeight) * 1000), pending: String(Math.round(rnd() * 900_000)), since: iso(-9 * 86_400_000) })),
  setBonus: { onChainSets: 0, computedSets: 0, multBps: 10_000, syncPending: false },
  totalPendingMicro: '4870000',
}));
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
      rewardChip: q.rewardChip ?? null, rewardBooster: q.rewardItem === 'booster' ? 1 : 0, completedAt: done ? iso(-3_600_000) : null, claimable: done && !st.claimed,
      ineligibleReason: null, resetsAt: iso(q.period === 'daily' ? 6 * 3_600_000 : q.period === 'weekly' ? 3 * 86_400_000 : 365 * 86_400_000),
    };
  });
});
on('get', '/quests/claims', () => [
  { kind: 2, epoch: 143, currency: 'CG', rootPda: fakeKey('Rt'), amountMicro: '9000000', proof: ['aa'.repeat(32), 'bb'.repeat(32)], claimableAt: iso(-60_000), claimed: false },
  // SKR root (kind 5 = Seeker-week quests) — paid from the treasury-funded prize pool
  { kind: 5, epoch: 21, currency: 'SKR', rootPda: fakeKey('Rs'), amountMicro: '12500000', proof: ['cc'.repeat(32)], claimableAt: iso(-30_000), claimed: false },
  // item root (kind 8 = fusion boosters, backlog #27) — amountMicro is the booster COUNT; claim_item_root CPIs chip_core grant_booster
  { kind: 8, epoch: 3, currency: 'ITEM', rootPda: fakeKey('Ri'), amountMicro: '2', proof: ['dd'.repeat(32)], claimableAt: iso(-20_000), claimed: false, memo: ['w_stake@w2971', 'p_set1@all'] },
  // chip voucher root (kind 9 = quest caps, backlog #28) — amountMicro is the voucher TEMPLATE (0 = 7-day streak cap); claim_chip_root CPIs chip_core open_voucher → a free 1-cap pack
  { kind: 9, epoch: 12, currency: 'CHIP', rootPda: fakeKey('Rc'), amountMicro: '0', proof: ['ee'.repeat(32)], claimableAt: iso(-10_000), claimed: false, memo: ['d_streak7@d20713', 'template:0'] },
]);
on('get', '/quests/streak', () => ({ days: 4, total: 11, nextChipAt: 7, resetsAt: iso(9 * 3_600_000), todayDone: false }));
on('post', '/quests/login', () => ({ day: Math.floor(Date.now() / 86_400_000), inserted: false }));

on('get', '/leaderboard/{board}', (_o, p) => ({
  board: p.board, season: 3,
  me: { rank: p.board === 'rating' ? 412 : 1287, value: p.board === 'rating' ? 1184 : p.board === 'wins' ? 9 : 41 },
  items: Array.from({ length: 50 }, (_, i) => ({ rank: i + 1, wallet: fakeKey(), handle: pick(['moth_king', 'railqueen', 'drain0', 'sk8_or_die', 'noise_boy', 'inkslinger', 'brakeless99', 'pixelbsmt', 'gutterbeast', 'citymyth']) + (i > 9 ? `_${i}` : ''), value: p.board === 'rating' ? 2400 - i * 21 : p.board === 'wins' ? 120 - i * 2 : p.board === 'collection' ? 72 - i : p.board === 'staking' ? 900_000 - i * 12_000 : 300 - i * 4, league: p.board === 'rating' ? Math.max(0, 5 - Math.floor(i / 10)) : 0, avatar: '' })),
  nextCursor: null,
}));

// ------------------------------------------------------------- ops panel (/admin — mirrors backend/src/admin.ts; the same guard-rails, nothing is signed)
const GUARD = { bpsDenom: 10_000, maxChipsPerPack: 5, minCommonBps: 500, maxTop2BpsStandard: 200, priceCentsRange: [50, 50_000], pity: { minHardAt: 10, maxSoftStepBps: 200 }, maxMarketFeeBps: 1_000, maxSkrDiscountBps: 1_500, split: { count: 5, maxDeltaBps: 1_000, minIntervalS: 7 * 86_400 }, evRatioRange: [0.55, 0.75] };
const adminState = {
  marketFeeBps: FEES.marketplaceFeeBps, skrDiscountBps: FEES.skrPackDiscountBps, featuredCollection: 4, paramsVersion: 3,
  splitBps: [3000, 1500, 1700, 2300, 1500], splitChangedAt: Math.floor(Date.now() / 1000) - 12 * 86_400, paused: { chip_core: false, staking: false, arena: false },
  packs: SKUS.map((id, sku) => { const p = PACKS[id]; return { sku, chips: p.chips, priceUsdCents: p.priceUsdCents, priceCgMicro: String(p.priceCgMicro ?? 0), oddsBps: [...p.oddsBps], floor: p.floor, dailyCap: p.dailyCap ?? 0, pity: p.pity ? { ...p.pity } : null, featuredOnly: p.pool === 'featured', enabled: id !== 'limited' }; }),
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
  guardRails: GUARD,
  history: [{ signature: fakeKey(), admin: 'HPMr5r9sS5ApWsPNJytZRLbm2jz1veFxTn1wepjAhtho', version: 3, slot: 311_900_000, blockTime: Math.floor(Date.now() / 1000) - 5 * 86_400 }, { signature: fakeKey(), admin: 'HPMr5r9sS5ApWsPNJytZRLbm2jz1veFxTn1wepjAhtho', version: 2, slot: 309_100_000, blockTime: Math.floor(Date.now() / 1000) - 19 * 86_400 }],
});
on('get', '/admin/params', adminParams);
on('post', '/admin/params', (o) => {
  const b = (o.body ?? {}) as { packs?: { sku: number; priceUsdCents?: number; oddsBps?: number[]; enabled?: boolean; dailyCap?: number }[]; marketFeeBps?: number; skrDiscountBps?: number; featuredCollection?: number; emissionSplitBps?: number[]; note?: string };
  const violations: { path: string; rule: string; message: string }[] = [];
  const warnings: string[] = [];
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  const instructions: { program: string; name: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string }[] = [];
  for (const [i, patch] of (b.packs ?? []).entries()) {
    const cur = adminState.packs[patch.sku];
    if (!cur) { violations.push({ path: `packs[${i}].sku`, rule: 'shape', message: 'sku 0..3' }); continue; }
    const next = { ...cur, ...patch, oddsBps: patch.oddsBps ?? cur.oddsBps };
    const sum = next.oddsBps.reduce((a, x) => a + x, 0);
    if (sum !== GUARD.bpsDenom) violations.push({ path: `packs[${i}].oddsBps`, rule: 'OddsSumInvalid', message: `odds sum to ${sum}, must be 10000` });
    if (next.oddsBps[0] < GUARD.minCommonBps) violations.push({ path: `packs[${i}].oddsBps[0]`, rule: 'OddsGuardRail', message: 'Common must stay ≥ 5 % (500 bps)' });
    const top2 = next.oddsBps[7] + next.oddsBps[8], cap = patch.sku <= 1 ? GUARD.maxTop2BpsStandard : 2 * GUARD.maxTop2BpsStandard;
    if (top2 > cap) violations.push({ path: `packs[${i}].oddsBps`, rule: 'OddsGuardRail', message: `Legend+ + Diamond = ${top2} bps exceeds the ${cap} bps cap for sku ${patch.sku}` });
    if (next.priceUsdCents < GUARD.priceCentsRange[0] || next.priceUsdCents > GUARD.priceCentsRange[1]) violations.push({ path: `packs[${i}].priceUsdCents`, rule: 'OddsGuardRail', message: 'price must be $0.50 … $500' });
    if (patch.sku !== 0 && next.priceUsdCents !== cur.priceUsdCents) { const ratio = (cur.priceUsdCents / next.priceUsdCents) * 0.65; if (ratio < GUARD.evRatioRange[0] || ratio > GUARD.evRatioRange[1]) warnings.push(`packs[${i}] (sku ${patch.sku}): EV/price ${(ratio * 100).toFixed(0)} % is outside the 55–75 % band the economy report enforces (Standard anchor = 65 %)`); }
    diff[`packs[${patch.sku}]`] = { from: cur, to: next };
  }
  if (b.marketFeeBps !== undefined) { if (b.marketFeeBps > GUARD.maxMarketFeeBps) violations.push({ path: 'marketFeeBps', rule: 'FeeTooHigh', message: 'market fee is capped at 1000 bps (10 %)' }); else diff.marketFeeBps = { from: adminState.marketFeeBps, to: b.marketFeeBps }; if (b.marketFeeBps < FEES.marketplaceFeeBps) warnings.push(`market fee below the modelled ${FEES.marketplaceFeeBps} bps lowers treasury + buyback flow (docs/02 §6)`); }
  if (b.skrDiscountBps !== undefined) { if (b.skrDiscountBps > GUARD.maxSkrDiscountBps) violations.push({ path: 'skrDiscountBps', rule: 'FeeTooHigh', message: 'SKR discount is capped at 1500 bps (15 %)' }); else diff.skrDiscountBps = { from: adminState.skrDiscountBps, to: b.skrDiscountBps }; }
  if (b.featuredCollection !== undefined) { if (b.featuredCollection < 0 || b.featuredCollection > 9) violations.push({ path: 'featuredCollection', rule: 'InvalidCollection', message: '0..9' }); else diff.featuredCollection = { from: adminState.featuredCollection, to: b.featuredCollection }; }
  if (b.emissionSplitBps !== undefined) {
    const s = b.emissionSplitBps, sum = s.reduce((a, x) => a + x, 0);
    if (s.length !== 5) violations.push({ path: 'emissionSplitBps', rule: 'shape', message: '5 integer bps (chip / token / quests / pvp / events)' });
    else if (sum !== 10_000) violations.push({ path: 'emissionSplitBps', rule: 'SplitSum', message: `split sums to ${sum}, must be 10000` });
    else { s.forEach((v, i) => { if (Math.abs(v - adminState.splitBps[i]) > GUARD.split.maxDeltaBps) violations.push({ path: `emissionSplitBps[${i}]`, rule: 'SplitGuard', message: `Δ ${v - adminState.splitBps[i]} bps exceeds ±1000 per change` }); }); if (!violations.some((v) => v.path.startsWith('emissionSplitBps'))) { diff.emissionSplitBps = { from: [...adminState.splitBps], to: s }; if (s[3] < adminState.splitBps[3]) warnings.push('pvpSeason slice shrinks: the current season pool estimate drops from the next DayClosed'); } }
  }
  if (Object.keys(diff).length === 0 && violations.length === 0) violations.push({ path: '', rule: 'empty', message: 'nothing to change' });
  const ok = violations.length === 0;
  if (ok) {
    if (Object.keys(diff).some((k) => k !== 'emissionSplitBps')) instructions.push({ program: 'chip_core', name: 'set_params', accounts: [{ pubkey: 'HPMr5r9sS5ApWsPNJytZRLbm2jz1veFxTn1wepjAhtho', isSigner: true, isWritable: false }, { pubkey: fakeKey('Cf'), isSigner: false, isWritable: true }], data: btoa(String.fromCharCode(...Array.from({ length: 40 }, () => Math.floor(rnd() * 256)))) });
    if (diff.emissionSplitBps) instructions.push({ program: 'staking', name: 'set_split', accounts: [{ pubkey: 'HPMr5r9sS5ApWsPNJytZRLbm2jz1veFxTn1wepjAhtho', isSigner: true, isWritable: false }, { pubkey: fakeKey('Em'), isSigner: false, isWritable: true }], data: btoa(String.fromCharCode(...Array.from({ length: 18 }, () => Math.floor(rnd() * 256)))) });
  }
  auditPush('params.propose', { body: b, result: { ok, violations: violations.length } });
  const proposal = { ok, violations, warnings, instructions, diff };
  if (!ok) throw new ApiError(422, 'guard_rail', violations.map((v) => `${v.path}: ${v.message}`).join('; '), proposal);
  return proposal;
});
on('post', '/admin/kill-switch', (o) => {
  const b = (o.body ?? {}) as { program: 'chip_core' | 'staking' | 'arena'; paused: boolean; reason?: string };
  if (b.paused && !(b.reason && b.reason.trim().length >= 8)) throw new ApiError(422, 'bad_request', 'reason: a pause needs a ≥ 8-char incident note (goes to the audit log + status page)', { ok: false, violations: [{ path: 'reason', rule: 'required', message: 'a pause needs a ≥ 8-char incident note' }], warnings: [], instructions: [], diff: {} });
  auditPush('kill_switch', { body: b, result: { ok: true } }, b.program);
  return {
    ok: true, violations: [], warnings: [b.paused ? 'pause blocks new purchases / listings / stakes / battles only — unstake, cancel, refund and withdraw keep working (docs/03 §2.5)' : 'un-pause is admin-only: this instruction needs the multisig (2/5 arena, 3/5 chip_core / staking)'],
    instructions: [{ program: b.program, name: b.paused ? 'pause' : b.program === 'arena' ? 'set_arena' : 'set_paused', accounts: [{ pubkey: fakeKey('Pa'), isSigner: true, isWritable: false }, { pubkey: fakeKey('Cf'), isSigner: false, isWritable: true }], data: btoa(String.fromCharCode(...Array.from({ length: 9 }, () => Math.floor(rnd() * 256)))) }],
    diff: { [`${b.program}.paused`]: { from: !b.paused, to: b.paused } },
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
    guard: { floorShare: 0.3, burnMultiple: 1.25, emissionAtZeroBurnCg: Math.round(scenario.scheduleCapCg * 0.3) },
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
