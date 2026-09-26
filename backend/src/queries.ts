// Read-model queries behind the REST routes. Everything here is a plain SQL
// projection over the tables in db.ts; nothing touches the chain.
import { clampInt } from './params.ts';
import {
  RARITY_PROFILES, levelMult, PACKS, BUNDLES, effectiveOdds, expandRandomness, probabilityAtLeast, packExpectedValueMult, type PackDef, type PackId,
  SKR_POOL_FUNDING, SKR_TREASURY_WALLET, skrPoolDueMicro, marketFeeTreasuryPartMicro,
  PYTH_MAX_AGE_SECS, PYTH_PUSHER, QUEST_CHIP_TEMPLATES, COLLECTIONS,
} from '@guttercaps/economy';
import { type Db, now } from './db.ts';
import { prices } from './services.ts';
import { deviceStatus, humanStatus } from './human.ts';
import { jsonAt, jsonFlagEq } from './sql.ts';

/** Oracle cache health for /health and /prices — what the pusher last posted and how old it is now. */
export function priceStatus(db: Db) {
  const rows = db.all<{ symbol: string; usd: number; updated_at: number; publish_time: number | null; account: string | null; conf_bps: number | null }>(`SELECT * FROM oracle_prices`);
  const t = now();
  const feeds = Object.fromEntries(rows.map((r) => {
    const ageS = r.publish_time === null ? null : t - r.publish_time;
    return [r.symbol, { usd: r.usd, account: r.account, publishTime: iso(r.publish_time), ageS, confBps: r.conf_bps, cachedAt: iso(r.updated_at), healthy: ageS !== null && ageS <= PYTH_PUSHER.alertAgeS }];
  }));
  return { maxAgeS: PYTH_MAX_AGE_SECS, alertAgeS: PYTH_PUSHER.alertAgeS, feeds };
}

/**
 * Last line of defence for pagination (SEC-B2): SQLite reads a **negative** `LIMIT` as "no limit", so
 * an unbounded value here means "return the whole table". Routers validate their parameters
 * (`backend/src/params.ts`); this keeps a future caller from turning a clamp into a bypass.
 */
const page = (limit: number, max: number, def: number) => clampInt(Number.isFinite(limit) ? limit : def, 0, max);
const offsetOf = (cursor: string | undefined) => {
  if (!cursor) return 0;
  const n = Number(cursor);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

export const CURRENCY_SYMBOL = ['SOL', 'USDC', 'CG', 'SKR'] as const;
export const iso = (s: number | null | undefined) => (s === null || s === undefined ? null : new Date(s * 1000).toISOString());

export const SKUS: PackId[] = ['starter', 'standard', 'premium', 'limited'];

/** USD value of an on-chain amount in `currency` base units (SOL lamports, USDC/CG/SKR micro). */
export function toUsd(amount: string, currency: number, px: { solUsd: number; skrUsd: number }): number {
  const n = Number(amount);
  switch (currency) {
    case 0: return (n / 1e9) * px.solUsd;
    case 1: return n / 1e6;
    case 2: return n / 1e6 / 100;       // 1 $CG ≙ 1 ¢ reference price for display only
    case 3: return (n / 1e6) * px.skrUsd;
    default: return 0;
  }
}

export interface ChipRow { asset: string; owner: string; collection_idx: number; rarity: number; level: number; flags: number; lock_until: number; origin: string; origin_signature: string | null; skin: string | null; minted_at: number | null; burned_at: number | null; game_index: string | null }

/**
 * `chips.game_index` is the per-collection mint number, stored as TEXT (u64, same convention as
 * `compressed_claims.game_index`). `null` means *not resolved yet* — the compressed path writes it from
 * `CompressedChipRegistered`, a core `open_pack` chip gets it from its `ChipState` account via
 * `Crank.resolveChipIndexes`. It must never be faked with `0`: index 0 is the first chip ever minted in
 * that collection, so a placeholder collides with a real chip ("#0" for everything, which is what this
 * used to render). A value outside the safe-integer range is reported as `null` rather than rounded.
 */
export function chipIndexOf(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export function chipToApi(r: ChipRow) {
  const p = RARITY_PROFILES[r.rarity];
  const lm = levelMult(r.level);
  return {
    asset: r.asset,
    owner: r.owner,
    collection: r.collection_idx,
    rarity: r.rarity,
    level: r.level,
    index: chipIndexOf(r.game_index),
    flags: { staked: (r.flags & 1) !== 0, listed: (r.flags & 2) !== 0, fusing: (r.flags & 4) !== 0, soulbound: (r.flags & 8) !== 0 },
    lockUntil: r.lock_until > 0 ? iso(r.lock_until) : null,
    skin: r.skin ?? null,
    power: Math.round(p.basePower * lm),
    stakeWeight: String(Math.round(p.stakeWeight * lm * 1000)),
  };
}

export function myChips(db: Db, wallet: string, q: { collection?: number; rarity?: number; status?: string; limit?: number; cursor?: string }) {
  const where: string[] = ['owner = ?', 'burned_at IS NULL'];
  const params: (string | number)[] = [wallet];
  if (q.collection !== undefined) { where.push('collection_idx = ?'); params.push(q.collection); }
  if (q.rarity !== undefined) { where.push('rarity = ?'); params.push(q.rarity); }
  const t = now();
  switch (q.status) {
    case 'free': where.push('(flags & 7) = 0 AND lock_until <= ?'); params.push(t); break;
    case 'staked': where.push('(flags & 1) != 0'); break;
    case 'listed': where.push('(flags & 2) != 0'); break;
    case 'fusing': where.push('(flags & 4) != 0'); break;
    case 'locked': where.push('lock_until > ?'); params.push(t); break;
  }
  const limit = page(q.limit ?? 200, 500, 200);
  const offset = offsetOf(q.cursor);
  const total = db.scalar(`SELECT COUNT(*) FROM chips WHERE ${where.join(' AND ')}`, ...params);
  const rows = db.all<ChipRow>(`SELECT * FROM chips WHERE ${where.join(' AND ')} ORDER BY rarity DESC, level DESC, minted_at DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
  // `limit > 0`: with `?limit=0` a non-null cursor would point at the same offset forever (a client
  // following `nextCursor` would loop). No rows ⇒ no next page.
  return { items: rows.map(chipToApi), nextCursor: limit > 0 && offset + rows.length < total ? String(offset + rows.length) : null, total };
}

/**
 * N × 9 ownership grid (N = live collection count from lore). `maxSlot` (quest settlement passes the finalized horizon) only counts chips
 * whose last state change is finalized — conservative: a chip minted / bought / re-flagged in the
 * last minute is left out, so a set can be credited a pass later but never on a forked-away mint.
 */
export function myGrid(db: Db, wallet: string, maxSlot = Number.MAX_SAFE_INTEGER) {
  const cells = Array.from({ length: COLLECTIONS.length }, () => Array<number>(9).fill(0));
  for (const r of db.all<{ collection_idx: number; rarity: number; n: number }>(`SELECT collection_idx, rarity, COUNT(*) n FROM chips WHERE owner = ? AND burned_at IS NULL AND updated_slot <= ? GROUP BY collection_idx, rarity`, wallet, maxSlot)) {
    if (cells[r.collection_idx]) cells[r.collection_idx][r.rarity] = r.n;
  }
  const completedSets = cells.filter((row) => row.every((n) => n > 0)).length;
  const missingForSet = cells
    .map((row, collection) => ({ collection, rarities: row.map((n, r) => (n === 0 ? r : -1)).filter((r) => r >= 0) }))
    .filter((m) => m.rarities.length > 0 && m.rarities.length <= 3);
  return { cells, completedSets, missingForSet };
}

export function walletProfile(db: Db, wallet: string) {
  const w = db.get<{ address: string; handle: string | null; first_seen: number | null; country: string | null }>(`SELECT address, handle, first_seen, country FROM wallets WHERE address = ?`, wallet);
  return { address: wallet, handle: w?.handle ?? undefined, firstSeen: iso(w?.first_seen) ?? undefined, country: w?.country ?? undefined };
}

export function me(db: Db, wallet: string, geo?: { restricted: boolean; country: string | null }) {
  const profile = walletProfile(db, wallet);
  const grid = myGrid(db, wallet);
  const boughtToday = SKUS.map((_, sku) => db.scalar(`SELECT COALESCE(SUM(qty),0) FROM pack_purchases WHERE buyer = ? AND sku = ? AND COALESCE(block_time, ?) >= ?`, wallet, sku, now(), now() - 86_400));
  const counters = SKUS.map((_, sku) => db.get<{ pity_after: number }>(`SELECT pity_after FROM pack_opens WHERE buyer = ? AND sku = ? ORDER BY slot DESC LIMIT 1`, wallet, sku)?.pity_after ?? 0);
  const toGuarantee = SKUS.map((id, sku) => { const p = PACKS[id].pity; return p ? Math.max(0, p.hardAt - counters[sku]) : 0; });
  const starterClaimed = db.scalar(`SELECT COUNT(*) FROM pack_purchases WHERE buyer = ? AND sku = 0`, wallet) > 0;
  const hasPaidPack = db.scalar(`SELECT COUNT(*) FROM pack_purchases WHERE buyer = ? AND sku > 0`, wallet) > 0;
  const ageH = profile.firstSeen ? Math.floor((Date.now() - Date.parse(profile.firstSeen)) / 3_600_000) : 0;
  let ops: { rewardsPaused?: boolean; trusted?: boolean } = {};
  try { ops = JSON.parse(db.get<{ flags: string }>(`SELECT flags FROM wallets WHERE address = ?`, wallet)?.flags ?? '{}') as typeof ops; } catch { /* ignore */ }
  const device = deviceStatus(db, wallet);
  return {
    ...profile,
    balances: { lamports: '0', usdc: '0', cg: '0', skr: '0' }, // live balances come from the wallet; the API only knows chain events
    pity: { counters, toGuarantee, boughtToday, starterClaimed },
    boosters: 0,
    flags: { rewardsPaused: ops.rewardsPaused === true, geoRestricted: geo?.restricted === true, accountAgeH: ageH, hasPaidPack, deviceLimited: device.limited && ops.trusted !== true },
    human: humanStatus(db, wallet),                       // T-B-49: Turnstile pass state + site key for the widget
    completedSets: grid.completedSets,
  };
}

/** the payload keys an activity row can be "about" — one list, so the OR-branch cannot drift per dialect */
const ACTIVITY_OWNER_KEYS = ['buyer', 'owner', 'seller', 'winner', 'wallet'] as const;

export function activity(db: Db, wallet: string, limit = 50, cursor?: string) {
  const lim = page(limit, 200, 50);
  const offset = offsetOf(cursor);
  const rows = db.all<{ name: string; signature: string; block_time: number | null; data: string; program: string }>(
    `SELECT name, signature, block_time, data, program FROM events_raw
     WHERE name IN ('PackOpened','ChipFused','CompressedClaimsFused','ClaimFusionRevealed','ChipListed','ChipSold','BattleResolved','Claimed','RootClaimed','Staked','Unstaked','ServicePaid')
       AND (${ACTIVITY_OWNER_KEYS.map((k) => `${jsonAt('data', k)} = ?`).join(' OR ')})
     ORDER BY slot DESC, id DESC LIMIT ? OFFSET ?`,
    wallet, wallet, wallet, wallet, wallet, lim + 1, offset,
  );
  const KIND: Record<string, string> = { PackOpened: 'pack_opened', ChipFused: 'fused', CompressedClaimsFused: 'fused', ClaimFusionRevealed: 'fused', ChipListed: 'listed', ChipSold: 'sold', BattleResolved: 'match_won', Claimed: 'claimed', RootClaimed: 'claimed', Staked: 'staked', Unstaked: 'unstaked', ServicePaid: 'service' };
  const items = rows.slice(0, lim).map((r) => {
    const d = JSON.parse(r.data) as Record<string, unknown>;
    let kind = KIND[r.name] ?? r.name;
    if (r.name === 'ChipSold' && d.buyer === wallet) kind = 'bought';
    return { kind, signature: r.signature, blockTime: iso(r.block_time) ?? new Date().toISOString(), payload: d };
  });
  return { items, nextCursor: rows.length > lim ? String(offset + lim) : null };
}

// ---------------------------------------------------------------- packs
export function packCatalogue(db: Db) {
  const featured = 4;
  return {
    packs: SKUS.map((id, sku) => {
      const p = PACKS[id];
      const ev = ((packExpectedValueMult(p) * 3.5 * 0.62) / (p.priceUsdCents / 100)) * 100;
      return {
        sku, name: p.name, chips: p.chips, priceUsdCents: p.priceUsdCents, priceCgMicro: p.priceCgMicro === null ? null : String(p.priceCgMicro),
        currencies: p.priceCgMicro ? ['SOL', 'USDC', 'CG', 'SKR'] : ['SOL', 'USDC', 'SKR'], oddsBps: [...p.oddsBps], floor: p.floor, dailyCap: p.dailyCap,
        pity: p.pity ? { ...p.pity } : null, pool: p.pool, enabled: true, pAtLeastLegend: probabilityAtLeast(p, 6), evPct: Number(ev.toFixed(1)),
      };
    }),
    featuredCollection: featured,
    bundles: BUNDLES.map((b) => ({ ...b })),
    // live counters — useful for the shop's "opened today" ticker
    opened24h: db.scalar(`SELECT COUNT(*) FROM pack_opens WHERE COALESCE(block_time, 0) >= ?`, now() - 86_400),
  };
}

export function packOpen(db: Db, signature: string) {
  const r = db.get<{ signature: string; buyer: string; sku: number; nonce: string; count: number; assets: string; rarities: string; collections: string; roll_hex: string; pity_before: number; pity_after: number }>(`SELECT * FROM pack_opens WHERE signature = ?`, signature);
  if (!r) return undefined;
  const assets = JSON.parse(r.assets) as string[];
  const chips = assets.map((a) => db.get<ChipRow>(`SELECT * FROM chips WHERE asset = ?`, a)).filter((c): c is ChipRow => !!c).map(chipToApi);
  const rarities = JSON.parse(r.rarities) as number[];
  const collections = JSON.parse(r.collections) as number[];
  const owned = db.all<{ collection_idx: number; rarity: number; n: number }>(`SELECT collection_idx, rarity, COUNT(*) n FROM chips WHERE owner = ? AND burned_at IS NULL GROUP BY collection_idx, rarity`, r.buyer);
  const newForSet = collections.filter((c, i) => (owned.find((o) => o.collection_idx === c && o.rarity === rarities[i])?.n ?? 0) === 1);
  // (#28) a quest chip voucher opens as "sku 0" but rolls its TEMPLATE odds with no floor / pity — the verifier must show those
  const voucher = r.sku === 0 ? db.get<{ template: number }>(`SELECT template FROM vouchers WHERE wallet = ? AND nonce = ?`, r.buyer, r.nonce) : undefined;
  const template = voucher ? QUEST_CHIP_TEMPLATES[voucher.template] : undefined;
  return {
    signature: r.signature, sku: r.sku, chips, rollHex: r.roll_hex, pityBefore: r.pity_before, pityAfter: r.pity_after,
    highlights: { bestRarity: Math.max(...rarities), newForSet: [...new Set(newForSet)], completedSet: null },
    onChain: rarities.map((rarity, i) => ({ rarity, collection: collections[i] })),
    effectiveOddsBps: template ? [...template.odds] : effectiveOdds(PACKS[SKUS[r.sku]], r.pity_before),
    voucher: voucher ? { template: voucher.template, odds: template ? [...template.odds] : null, soulboundDays: template?.soulboundDays ?? null } : null,
  };
}

/**
 * SEC-B6 (2026-09-26): `/packs/verify` used to answer `matches: true` unconditionally — a verifier that
 * always agrees is worse than none, because the page (and any third-party checker) shows a "verified"
 * badge for a result nobody recomputed. Here the **rarity sequence** is recomputed from the randomness
 * bytes the program emitted (`PackOpened.roll`, the per-pack seed) with the published economy table (or,
 * for a quest voucher, its template odds) and compared with what the chain minted.
 *
 * What is deliberately *not* claimed: the district (`collection`) needs the live pool
 * (`collections_created` / the featured district) which the read model does not hold, and the admin can
 * change the pack table itself (`set_params` → `ParamsChanged`) — so a reproduction mismatch is reported
 * with the reason, and `assumed.basis` says which table was used. The client verifier reads the live
 * config from the chain and does check the districts.
 */
export function verifyPackOpen(db: Db, signature: string) {
  const row = db.get<{ signature: string; buyer: string; sku: number; nonce: string; count: number; rarities: string; collections: string; roll_hex: string; pity_before: number; slot: number }>(
    `SELECT signature, buyer, sku, nonce, count, rarities, collections, roll_hex, pity_before, slot FROM pack_opens WHERE signature = ?`, signature,
  );
  if (!row) return undefined;
  const base = packOpen(db, signature);
  if (!base) return undefined;
  const template = row.sku === 0 ? QUEST_CHIP_TEMPLATES[db.get<{ template: number }>(`SELECT template FROM vouchers WHERE wallet = ? AND nonce = ?`, row.buyer, row.nonce)?.template ?? -1] : undefined;
  // The voucher path mints exactly one chip with its TEMPLATE odds and no floor/pity (#28) — mirrors
  // `voucherEconPack` in crank.ts and `PackDef::voucher` in chip_core. Only these fields are read by
  // `expandRandomness`; the district pool is a separate, chain-only input.
  const def: PackDef = template ? { ...PACKS.starter, chips: 1, oddsBps: [...template.odds], floor: 0, pity: null } : PACKS[SKUS[row.sku]];
  const onChain = (JSON.parse(row.rarities) as number[]).slice(0, row.count).map((rarity, i) => ({ rarity, collection: (JSON.parse(row.collections) as number[])[i] }));
  const bytes = /^[0-9a-fA-F]{64}$/.test(row.roll_hex) ? Uint8Array.from(Buffer.from(row.roll_hex, 'hex')) : undefined;
  const paramsChangedBefore = db.scalar(`SELECT COUNT(*) FROM params_changes WHERE slot < ?`, row.slot) > 0;
  const notes: string[] = [];
  let recomputed: { rarity: number }[] = [];
  let matches = false;
  if (!bytes) {
    notes.push('the indexed randomness is not 32 bytes — there is nothing to recompute');
  } else if (def.chips !== row.count) {
    notes.push(`the published ${def.id} table holds ${def.chips} chips but the event records ${row.count}`);
  } else {
    recomputed = expandRandomness(bytes, def, row.pity_before, 1).map((r) => ({ rarity: r.rarity }));
    matches = recomputed.length === onChain.length && recomputed.every((r, i) => r.rarity === onChain[i].rarity);
    if (!matches) {
      notes.push(paramsChangedBefore
        ? 'a ParamsChanged event predates this open, so the on-chain pack table may differ from the published one — check the live config (client verifier) before reading this as a fairness failure'
        : 'the minted rarities do not follow from the randomness bytes under the published table — treat this as a fairness failure and report it');
    } else if (paramsChangedBefore) {
      notes.push('pack-table changes predate this open; the rarities still reproduce under the published table');
    }
  }
  return { ...base, recomputed, matches, assumed: { basis: 'published-defaults', sku: row.sku, chips: def.chips, floor: def.floor, pity: def.pity, paramsChangedBefore }, ...(notes.length ? { note: notes.join('; ') } : {}) };
}

// ---------------------------------------------------------------- market
export function listings(db: Db, q: Record<string, string | undefined>) {
  const px = prices(db);
  const where: string[] = ['c.burned_at IS NULL'];
  const params: (string | number)[] = [];
  if (q.collection) { where.push('c.collection_idx = ?'); params.push(Number(q.collection)); }
  if (q.rarity) { where.push('c.rarity = ?'); params.push(Number(q.rarity)); }
  if (q.rarityMin) { where.push('c.rarity >= ?'); params.push(Number(q.rarityMin)); }
  if (q.levelMin) { where.push('c.level >= ?'); params.push(Number(q.levelMin)); }
  // Mint-number range (SEC-B3 shape #27). Compared as integers, so a chip whose index is not resolved yet
  // is *excluded* by a range filter instead of silently matching it — an unresolved chip has no number to
  // compare, and pretending it is #0 would match the first chip of the collection.
  if (q.indexMin) { where.push('CAST(c.game_index AS INTEGER) >= ?'); params.push(Number(q.indexMin)); }
  if (q.indexMax) { where.push('CAST(c.game_index AS INTEGER) <= ?'); params.push(Number(q.indexMax)); }
  if (q.currency) { const code = CURRENCY_SYMBOL.indexOf(q.currency as never); if (code >= 0) { where.push('l.currency = ?'); params.push(code); } }
  const rows = db.all<ChipRow & { seller: string; price: string; currency: number; created_at: number | null }>(
    `SELECT c.*, l.seller, l.price, l.currency, l.created_at FROM listings l JOIN chips c ON c.asset = l.asset WHERE ${where.join(' AND ')}`, ...params,
  );
  let items = rows.map((r) => ({ asset: r.asset, seller: r.seller, price: r.price, currency: CURRENCY_SYMBOL[r.currency] ?? 'SOL', priceUsd: Number(toUsd(r.price, r.currency, px).toFixed(2)), createdAt: iso(r.created_at) ?? new Date().toISOString(), chip: chipToApi(r) }));
  if (q.priceMaxUsd) items = items.filter((i) => i.priceUsd <= Number(q.priceMaxUsd));
  const sort = q.sort ?? 'price_asc';
  // `index_asc` ("Low #"): unresolved chips sort last (they have no number) and ties fall back to price,
  // so the page stays total and deterministic for the paginated cursor.
  const byIndex = (i: number | null) => (i === null ? Number.MAX_SAFE_INTEGER : i);
  items.sort((a, b) =>
    sort === 'price_desc' ? b.priceUsd - a.priceUsd
    : sort === 'rarity_desc' ? b.chip.rarity - a.chip.rarity || a.priceUsd - b.priceUsd
    : sort === 'newest' ? b.createdAt.localeCompare(a.createdAt)
    : sort === 'index_asc' ? byIndex(a.chip.index) - byIndex(b.chip.index) || a.priceUsd - b.priceUsd
    : a.priceUsd - b.priceUsd);
  const offset = offsetOf(q.cursor);
  const limit = page(Number(q.limit), 200, 60);
  const slice = items.slice(offset, offset + limit);
  return { items: slice, nextCursor: limit > 0 && offset + limit < items.length ? String(offset + limit) : null, total: items.length };
}

export function floor(db: Db) {
  const px = prices(db);
  const floors: (number | null)[][] = Array.from({ length: COLLECTIONS.length }, () => Array(9).fill(null));
  const listedCount: number[][] = Array.from({ length: COLLECTIONS.length }, () => Array(9).fill(0));
  const rows = db.all<{ collection_idx: number; rarity: number; price: string; currency: number }>(`SELECT c.collection_idx, c.rarity, l.price, l.currency FROM listings l JOIN chips c ON c.asset = l.asset WHERE c.burned_at IS NULL`);
  for (const r of rows) {
    const usd = toUsd(r.price, r.currency, px);
    const cur = floors[r.collection_idx]?.[r.rarity];
    if (floors[r.collection_idx]) {
      floors[r.collection_idx][r.rarity] = cur === null || cur === undefined ? Number(usd.toFixed(2)) : Math.min(cur, Number(usd.toFixed(2)));
      listedCount[r.collection_idx][r.rarity]++;
    }
  }
  const sales = db.all<{ price: string; currency: number }>(`SELECT price, currency FROM sales WHERE COALESCE(block_time, 0) >= ?`, now() - 86_400);
  const volume24hUsd = Number(sales.reduce((s, r) => s + toUsd(r.price, r.currency, px), 0).toFixed(2));
  return { asOf: new Date().toISOString(), solUsd: px.solUsd, skrUsd: px.skrUsd, floors, listedCount, volume24hUsd };
}

export function history(db: Db, q: { asset?: string; collection?: string; rarity?: string; cursor?: string }) {
  const px = prices(db);
  const where: string[] = ['1=1'];
  const params: (string | number)[] = [];
  if (q.asset) { where.push('asset = ?'); params.push(q.asset); }
  if (q.collection) { where.push('collection_idx = ?'); params.push(Number(q.collection)); }
  if (q.rarity) { where.push('rarity = ?'); params.push(Number(q.rarity)); }
  const offset = offsetOf(q.cursor);
  const rows = db.all<{ asset: string; seller: string; buyer: string; price: string; currency: number; fee: string; royalty: string; signature: string; block_time: number | null; rarity: number | null }>(
    `SELECT * FROM sales WHERE ${where.join(' AND ')} ORDER BY slot DESC LIMIT 51 OFFSET ?`, ...params, offset,
  );
  return {
    items: rows.slice(0, 50).map((r) => ({ asset: r.asset, seller: r.seller, buyer: r.buyer, price: r.price, currency: CURRENCY_SYMBOL[r.currency] ?? 'SOL', priceUsd: Number(toUsd(r.price, r.currency, px).toFixed(2)), fee: r.fee, royalty: r.royalty, signature: r.signature, blockTime: iso(r.block_time) ?? new Date().toISOString(), rarity: r.rarity ?? undefined })),
    nextCursor: rows.length > 50 ? String(offset + 50) : null,
  };
}

/** The N × 9 archetype page (lore + live supply/floor/listed/recent sales) — `GET /collections/{idx}/chips/{rarity}`. */
export function chipArchetype(db: Db, collection: number, rarity: number, salesLimit = 12) {
  if (!Number.isInteger(collection) || collection < 0 || collection >= COLLECTIONS.length) return undefined;
  if (!Number.isInteger(rarity) || rarity < 0 || rarity >= RARITY_PROFILES.length) return undefined;
  const c = COLLECTIONS[collection];
  const p = RARITY_PROFILES[rarity];
  const supply = db.scalar(`SELECT COUNT(*) FROM chips WHERE collection_idx = ? AND rarity = ? AND burned_at IS NULL`, collection, rarity);
  const listed = db.scalar(`SELECT COUNT(*) FROM listings l JOIN chips c ON c.asset = l.asset WHERE c.collection_idx = ? AND c.rarity = ?`, collection, rarity);
  const fl = floor(db).floors[collection]?.[rarity] ?? null;
  const sales = history(db, { collection: String(collection), rarity: String(rarity) }).items.slice(0, salesLimit);
  return {
    collection, rarity, name: c.caps[rarity].name, lore: c.caps[rarity].desc, symbol: c.symbol,
    district: c.district, rim: p.rim, supply, floorUsd: fl, listed, basePower: p.basePower, maxLevel: p.maxLevel, sales,
  };
}

export function chipDetail(db: Db, asset: string) {
  const r = db.get<ChipRow & { burned_at: number | null }>(`SELECT * FROM chips WHERE asset = ?`, asset);
  if (!r) return undefined;
  const px = prices(db);
  const listing = db.get<{ seller: string; price: string; currency: number; created_at: number | null }>(`SELECT seller, price, currency, created_at FROM listings WHERE asset = ?`, asset);
  const sales = history(db, { asset }).items;
  const open = (r.origin === 'pack' || r.origin === 'voucher') && r.origin_signature ? db.get<{ roll_hex: string }>(`SELECT roll_hex FROM pack_opens WHERE signature = ?`, r.origin_signature) : undefined;
  const fusion = r.origin === 'fusion' && r.origin_signature ? db.get<{ recipe: number }>(`SELECT recipe FROM fusions WHERE signature = ? AND result = ?`, r.origin_signature, asset) : undefined;
  return {
    ...chipToApi(r),
    burned: r.burned_at !== null,
    listing: listing ? { asset, seller: listing.seller, price: listing.price, currency: CURRENCY_SYMBOL[listing.currency], priceUsd: Number(toUsd(listing.price, listing.currency, px).toFixed(2)), createdAt: iso(listing.created_at) } : null,
    provenance: { origin: r.origin, signature: r.origin_signature ?? '', rollHex: open?.roll_hex ?? '', recipe: fusion?.recipe ?? undefined },
    sales,
    archetype: chipArchetype(db, r.collection_idx, r.rarity, 4),
  };
}

export function collections(db: Db) {
  const minted = db.all<{ collection_idx: number; rarity: number; n: number }>(`SELECT collection_idx, rarity, COUNT(*) n FROM chips WHERE burned_at IS NULL GROUP BY collection_idx, rarity`);
  const fl = floor(db).floors;
  return Array.from({ length: COLLECTIONS.length }, (_, idx) => {
    const byR = Array(9).fill(0) as number[];
    for (const m of minted) if (m.collection_idx === idx) byR[m.rarity] = m.n;
    const lore = COLLECTIONS[idx];
    return { idx, symbol: lore.symbol, name: lore.name, district: lore.district, theme: lore.theme, minted: byR.reduce((a, b) => a + b, 0), mintedByRarity: byR, floors: fl[idx], featured: idx === 4 };
  });
}

// ---------------------------------------------------------------- leaderboards
/**
 * Public boards. `rating` is the arena's Glicko-lite ladder for one season (default: the season open
 * right now — docs/02 §4.4; `seasons` rows are created lazily by arena.currentSeason, so before the
 * first match the board is simply empty); `wins` counts chain-verified wager-battle wins (arena
 * program `BattleResolved`); the rest are inventory / staking / fusion projections.
 * Shadow-banned wallets (ops flag, antifraud.ts) are hidden from every board, but `me` is still
 * computed for them as if they were listed — a shadow ban must not be observable from the inside.
 */
export function leaderboard(db: Db, board: string, limit = 50, cursor?: string, meWallet?: string, season?: number) {
  const lim = page(limit, 200, 50);
  const offset = offsetOf(cursor);
  let sql: string;
  let seasonId = 0;
  const params: (string | number)[] = [];
  switch (board) {
    case 'rating': {   // arena season rating (server ladder: ratings table, games > 0)
      const t = now();
      seasonId = season ?? db.get<{ id: number }>(`SELECT id FROM seasons WHERE starts_at <= ? AND ends_at > ? ORDER BY id DESC LIMIT 1`, t, t)?.id ?? 0;
      sql = `SELECT wallet, ROUND(rating) AS value, league FROM ratings WHERE season = ? AND games > 0`; params.push(seasonId); break;
    }
    case 'wins':        // wager-battle wins the chain saw (escrowed $CG fights, any season)
      sql = `SELECT winner AS wallet, COUNT(*) AS value, 0 AS league FROM battles WHERE status = 'resolved' AND winner IS NOT NULL GROUP BY winner`; break;
    case 'collection':  // distinct (collection, rarity) archetypes owned, out of 90
      sql = `SELECT owner AS wallet, COUNT(DISTINCT collection_idx * 16 + rarity) AS value, 0 AS league FROM chips WHERE burned_at IS NULL GROUP BY owner`; break;
    case 'staking':     // active stake weight
      sql = `SELECT owner AS wallet, SUM(CAST(weight AS REAL)) AS value, 0 AS league FROM stakes WHERE active = 1 GROUP BY owner`; break;
    case 'fusion':
      sql = `SELECT owner AS wallet, COUNT(*) AS value, 0 AS league FROM fusions WHERE success = 1 GROUP BY owner`; break;
    default: throw new Error('unknown board');
  }
  const visible = `SELECT t.wallet, t.value, t.league, w.handle FROM (${sql}) t LEFT JOIN wallets w ON w.address = t.wallet WHERE ${jsonFlagEq('w.flags', 'shadowBanned', false)}`;
  const rows = db.all<{ wallet: string; value: number; league: number; handle: string | null }>(`${visible} ORDER BY t.value DESC, t.wallet ASC LIMIT ? OFFSET ?`, ...params, lim + 1, offset);
  const items = rows.slice(0, lim).map((r, i) => ({ rank: offset + i + 1, wallet: r.wallet, handle: r.handle ?? '', value: Number(r.value), league: r.league, avatar: '' }));
  let me: { rank: number; value: number } | null = null;
  if (meWallet) {
    const mine = db.get<{ value: number }>(`SELECT value FROM (${sql}) WHERE wallet = ?`, ...params, meWallet);
    if (mine) {
      // rank = 1 + visible rows ordered before me (same order as the list; a hidden wallet ranks as if it were listed)
      const above = db.scalar(`SELECT COUNT(*) FROM (${visible}) v WHERE v.value > ? OR (v.value = ? AND v.wallet < ?)`, ...params, mine.value, mine.value, meWallet);
      me = { rank: above + 1, value: Number(mine.value) };
    }
  }
  return { board, season: seasonId, me, items, nextCursor: rows.length > lim ? String(offset + lim) : null };
}

// ---------------------------------------------------------------- stats (legacy /stats, kept for the landing page)
/** Latest known pause state per program from the PauseChanged audit trail (SEC-H2). */
export function pauseStatus(db: Db) {
  const out: Record<string, { paused: boolean; by: string; slot: number; blockTime: number | null } | null> = { chip_core: null, staking: null, arena: null };
  for (const r of db.all<{ program: string; by_wallet: string; paused: number; slot: number; block_time: number | null }>(
    `SELECT program, by_wallet, paused, slot, block_time FROM pause_changes p WHERE slot = (SELECT MAX(slot) FROM pause_changes WHERE program = p.program)`,
  )) out[r.program] = { paused: r.paused === 1, by: r.by_wallet, slot: r.slot, blockTime: r.block_time };
  return out;
}

export function stats(db: Db) {
  return {
    chipsMinted: db.scalar(`SELECT COUNT(*) FROM chips`),
    chipsAlive: db.scalar(`SELECT COUNT(*) FROM chips WHERE burned_at IS NULL`),
    packsOpened: db.scalar(`SELECT COUNT(*) FROM pack_opens`),
    activeWallets: db.scalar(`SELECT COUNT(DISTINCT buyer) FROM pack_opens`),
    chipsCurrentlyStaked: db.scalar(`SELECT COUNT(*) FROM stakes WHERE kind = 1 AND active = 1`),
    tokenStakedMicro: String(db.all<{ amount: string }>(`SELECT amount FROM stakes WHERE kind = 0 AND active = 1`).reduce((s, r) => s + BigInt(r.amount), 0n)),
    totalBattlesResolved: db.scalar(`SELECT COUNT(*) FROM battles WHERE status = 'resolved'`),
    fusions: db.scalar(`SELECT COUNT(*) FROM fusions`),
    sales: db.scalar(`SELECT COUNT(*) FROM sales`),
    burnedCgMicro: String(db.all<{ amount: string }>(`SELECT amount FROM burns`).reduce((s, r) => s + BigInt(r.amount), 0n)),
    servicesSold: db.scalar(`SELECT COUNT(*) FROM service_payments`),
    skrRewardsPaidMicro: String(db.all<{ amount: string }>(`SELECT amount FROM reward_claims WHERE currency = 'SKR'`).reduce((s, r) => s + BigInt(r.amount), 0n)),
    lastSlot: db.scalar(`SELECT COALESCE(MAX(slot),0) FROM events_raw`),
  };
}

/** SKR prize pool: funded/paid totals and live roots — proves rewards ≤ funding (treasury liability, never supply). */
export function skrPool(db: Db) {
  const sum = (sql: string) => db.all<{ amount: string }>(sql).reduce((s, r) => s + BigInt(r.amount), 0n);
  const funded = sum(`SELECT amount FROM skr_pool_events WHERE kind = 'funded'`);
  const withdrawn = sum(`SELECT amount FROM skr_pool_events WHERE kind = 'withdrawn'`);
  const paid = sum(`SELECT amount FROM reward_claims WHERE currency = 'SKR'`);
  const roots = db.all<{ kind: number; epoch: number; budget: string; revoked: number; slot: number }>(`SELECT kind, epoch, budget, revoked, slot FROM reward_roots WHERE currency = 'SKR' ORDER BY slot DESC LIMIT 50`);
  const claimedByRoot = new Map(db.all<{ kind: number; epoch: number; amount: string }>(`SELECT kind, epoch, amount FROM reward_claims WHERE currency = 'SKR'`).reduce((m, r) => {
    const k = `${r.kind}:${r.epoch}`; m.set(k, (m.get(k) ?? 0n) + BigInt(r.amount)); return m;
  }, new Map<string, bigint>()));
  const reserved = roots.filter((r) => !r.revoked).reduce((s, r) => s + BigInt(r.budget) - (claimedByRoot.get(`${r.kind}:${r.epoch}`) ?? 0n), 0n);
  const last = db.get<{ max_root_budget: string | null; paused: number | null }>(`SELECT max_root_budget, paused FROM skr_pool_events WHERE kind = 'changed' ORDER BY slot DESC LIMIT 1`);
  const revenue = skrRevenue(db);
  const due = skrPoolDueMicro(revenue);
  return {
    fundedTotalMicro: funded.toString(),
    withdrawnTotalMicro: withdrawn.toString(),
    paidTotalMicro: paid.toString(),
    reservedMicro: reserved.toString(),
    budgetMicro: (funded - withdrawn - paid - reserved).toString(),
    maxRootBudgetMicro: last?.max_root_budget ?? null,
    paused: last?.paused === 1,
    roots: roots.map((r) => ({ kind: r.kind, epoch: r.epoch, budgetMicro: r.budget, claimedMicro: (claimedByRoot.get(`${r.kind}:${r.epoch}`) ?? 0n).toString(), revoked: r.revoked === 1, slot: r.slot })),
    /** Treasury policy audit: realised SKR revenue × the published shares vs. what was actually funded. */
    funding: {
      treasuryWallet: SKR_TREASURY_WALLET,
      policyBps: { packRevenue: SKR_POOL_FUNDING.packRevenueShareBps, marketFeeTreasury: SKR_POOL_FUNDING.marketFeeTreasuryShareBps, servicesRevenue: SKR_POOL_FUNDING.servicesRevenueShareBps },
      cadence: SKR_POOL_FUNDING.cadence,
      revenue: { packRevenueMicro: revenue.packRevenueMicro.toString(), marketFeeTreasuryMicro: revenue.marketFeeTreasuryMicro.toString(), servicesRevenueMicro: revenue.servicesRevenueMicro.toString() },
      dueMicro: due.dueMicro.toString(),
      dueBreakdownMicro: { packs: due.fromPacksMicro.toString(), market: due.fromMarketMicro.toString(), services: due.fromServicesMicro.toString() },
      /** funded − due; negative = the treasury is behind on the published policy */
      surplusMicro: (funded - due.dueMicro).toString(),
    },
  };
}

/**
 * Realised SKR revenue (micro) from on-chain events — the base the funding policy applies to.
 * Packs count only once fully opened (pending/cancelled purchases are refundable liabilities,
 * not revenue); sales count the protocol fee's treasury part (buyback slice excluded);
 * services count the full SKR price (nothing is burned on the SKR rail).
 */
export function skrRevenue(db: Db) {
  const SKR = CURRENCY_SYMBOL.indexOf('SKR');
  const sum = (sql: string, currency: number) => db.all<{ amount: string }>(sql, currency).reduce((s, r) => s + BigInt(r.amount), 0n);
  const packRevenueMicro = sum(`SELECT amount FROM pack_purchases WHERE currency = ? AND status = 'opened'`, SKR);
  const marketFeeTreasuryMicro = db.all<{ fee: string }>(`SELECT fee FROM sales WHERE currency = ?`, SKR).reduce((s, r) => s + marketFeeTreasuryPartMicro(BigInt(r.fee)), 0n);
  const servicesRevenueMicro = sum(`SELECT amount FROM service_payments WHERE currency = ?`, SKR);
  return { packRevenueMicro, marketFeeTreasuryMicro, servicesRevenueMicro };
}

export function walletEvents(db: Db, wallet: string, limit = 50) {
  return db.all<{ name: string; data: string; block_time: number | null; signature: string }>(
    // `name`, unaliased: the openapi RawEvent schema (and the generated client type) say `name`, and a
    // rename here is invisible to typecheck because the row type below is a cast, not an inference.
    // The `LIKE` scan is the accepted cost of querying a JSON blob (docs/06 §4.1); a wallet column with
    // an index would be the fix, and it is deliberately not worth a migration for an events feed.
    `SELECT name, data, block_time, signature FROM events_raw WHERE data LIKE '%' || ? || '%' ORDER BY slot DESC LIMIT ?`, wallet, page(limit, 200, 50),
  );
}

// ------------------------------------------------------------ crank (backend/src/crank.ts)
export type CrankPhase = 'pending' | 'stale' | 'settled' | 'closed' | 'abandoned';
/** Crank health for /health: queue depth, head age and abandoned jobs (SLA/alerts — docs/06 §4.3). Any process with the DB can answer. */
export function crankStatus(db: Db, nowMs = Date.now()) {
  const counts = Object.fromEntries(db.all<{ phase: CrankPhase; n: number }>(`SELECT phase, COUNT(*) AS n FROM crank_jobs GROUP BY phase`).map((r) => [r.phase, r.n]));
  const oldest = db.get<{ t: number | null }>(`SELECT MIN(created_at) AS t FROM crank_jobs WHERE phase = 'pending'`)?.t ?? null;
  const last = db.get<{ t: number | null }>(`SELECT MAX(updated_at) AS t FROM crank_jobs`)?.t ?? null;
  const headAgeS = oldest === null ? null : Math.round((nowMs - oldest) / 1000);
  return {
    pending: counts.pending ?? 0, stale: counts.stale ?? 0, settled: counts.settled ?? 0, closed: counts.closed ?? 0, abandoned: counts.abandoned ?? 0,
    headAgeS, lastActivity: last === null ? null : new Date(last).toISOString(),
    healthy: (counts.pending ?? 0) <= 200 && (headAgeS === null || headAgeS <= 60) && (counts.abandoned ?? 0) === 0,
  };
}
