// Floodgrid («Решётка») backend: server-verified sectors (PlayProof replay), chip routes,
// star-XP accounting, charge droplets, gear items and account gifts (docs/13).
// Trust model mirrors chip XP / arena: the server replays every turn with the SAME
// deterministic engine the client runs (@guttercaps/economy gridEngine), so a claimed
// solution is proven, not believed. XP credits go through creditChipXp (daily cap 200,
// checkpoints on losses); uncredited remainder is kept as xp_pending, never burned.
import { randomUUID } from 'node:crypto';
import {
  GRID, GRID_GIFTS, DAILY_CONFIG_LEVEL, PASS_XP, dailySeed, depthOfLevel, generateLevel, levelSeed, applyRotate, isSolved, hashString,
  gridBaseXp, gridStarsForMoves, gridXpForStars, gridLoreUnlocked, QUEST_CHIP_TEMPLATES,
} from '@guttercaps/economy';
import { type Db, now } from './db.ts';
import { creditChipXp } from './chip-xp.ts';
import { ServiceError, claimGridDeepAttempt } from './services.ts';
import { addPassXp, passSeasonId } from './pass.ts';

const DAY = 86_400;
export const gridDay = (t: number) => Math.floor(t / DAY);
export const gridWeek = (t: number) => Math.floor((t - 4 * DAY) / (7 * DAY));


export const gridIsSunday = (t: number) => new Date(t * 1000).getUTCDay() === 0;
/** District highlighted by the Drain today (same rotation as client drainDay.featuredDistrict). */
export const gridFeaturedDistrict = (t: number) => ((gridDay(t) % GRID.floodDistricts) + GRID.floodDistricts) % GRID.floodDistricts;
/** Flood of the day: the shared 6x6 sector, or the epic 8x8 heart sector on Sundays. */
export const gridDailyLevel = (t: number) => (gridIsSunday(t) ? GRID.totalLevels : DAILY_CONFIG_LEVEL);

// ---------------------------------------------------------------------------
// Phase 3 endgame (docs/12, owner-approved): district contracts, Deep Flood, Ghost of the day.
// All three are server-seeded special attempts on the same PlayProof replay; none of them
// credits route XP — contracts feed weekly quest progress + droplet progress, Deep Flood is a
// weekly leaderboard bought with free/paid ($CG-burn) attempts, Ghost pays gear only.
// ---------------------------------------------------------------------------
export const gridWeekStart = (week: number) => week * 7 * DAY + 4 * DAY;
export interface GridContract { slot: number; district: number; depth: number; configLevel: number; seed: number }
export const gridContractAt = (t: number, slot: number): GridContract => {
  const day = gridDay(t);
  const district = (((day * GRID.contractsPerDay + slot) % GRID.floodDistricts) + GRID.floodDistricts) % GRID.floodDistricts;
  const depth = 1 + (((day + slot) % GRID.depths) + GRID.depths) % GRID.depths;
  return { slot, district, depth, configLevel: depth * GRID.levelsPerDepth, seed: hashString(`grid:contract:${day}:${slot}`) };
};
export const gridDeepSeed = (week: number) => hashString(`grid:deep:${week}`);
export const gridGhostSeed = (day: number) => hashString(`grid:ghost:${day}`);

/** Buy one extra Deep Flood attempt for this week with a 30 $CG burn (pay_service kind 10). */
export function buyGridDeepAttempt(db: Db, wallet: string, signature: string, t = now()) {
  return claimGridDeepAttempt(db, wallet, signature, gridWeek(t));
}

const GRID_COSMETIC_KIND = 10;
function grantGridCosmetic(db: Db, wallet: string, giftKind: string, key: string, signature: string, t: number, collection?: number): void {
  if (db.get(`SELECT 1 FROM entitlements WHERE wallet = ? AND signature = ?`, wallet, signature)) return;
  const kind = giftKind === 'skin' ? 2 : giftKind === 'theme' ? 3 : giftKind === 'banner' ? 9 : GRID_COSMETIC_KIND;
  const payload = giftKind === 'skin' ? { skin: key, source: 'grid_gift' } : giftKind === 'theme' ? { theme: key, source: 'grid_gift' } : giftKind === 'banner' ? { collection: collection ?? 0, source: 'grid_gift', cosmetic: key } : { cosmetic: key, giftKind, source: 'grid_gift' };
  db.run(`INSERT INTO entitlements (wallet, kind, payload, signature, currency, amount, granted_at, expires_at) VALUES (?, ?, ?, ?, 2, '0', ?, NULL)`, wallet, kind, JSON.stringify(payload), signature, t);
}

/** Apply an earn-only Floodgrid skin entitlement to one owned chip (one entitlement paints one cap). */
export function applyGridSkin(db: Db, wallet: string, body: { asset?: unknown; skin?: unknown }, t = now()) {
  const asset = typeof body.asset === 'string' ? body.asset : '';
  const skin = typeof body.skin === 'string' ? body.skin : '';
  if (!asset || !skin) throw new ServiceError(422, 'bad_request', 'asset and skin are required');
  chipOf(db, wallet, asset);
  const rows = db.all<{ id: number; payload: string }>(`SELECT id, payload FROM entitlements WHERE wallet = ? AND kind = 2 AND signature LIKE 'grid:%' ORDER BY id`, wallet);
  const ent = rows.map((r) => ({ ...r, parsed: JSON.parse(r.payload) as { skin?: string; asset?: string } })).find((r) => r.parsed.skin === skin && !r.parsed.asset);
  if (!ent) throw new ServiceError(409, 'no_skin_entitlement', 'No unused Floodgrid skin entitlement for that skin');
  db.run(`UPDATE entitlements SET payload = ? WHERE id = ?`, JSON.stringify({ ...ent.parsed, asset, appliedAt: t }), ent.id);
  db.run(`UPDATE chips SET skin = ? WHERE asset = ?`, skin, asset);
  return { asset, skin };
}

function awardDailyPassXp(db: Db, wallet: string, t: number): number {
  const day = gridDay(t);
  if (db.get(`SELECT 1 FROM grid_item_grants WHERE wallet = ? AND source = 'pass_daily' AND day = ?`, wallet, day)) return 0;
  if (!db.get(`SELECT 1 FROM seasons LIMIT 1`)) return 0; // no pass season yet: nothing to credit, do not burn the day marker
  db.run(`INSERT INTO grid_item_grants (wallet, source, day, amount) VALUES (?, 'pass_daily', ?, ?)`, wallet, day, PASS_XP.floodDaily);
  addPassXp(db, passSeasonId(db, t), wallet, PASS_XP.floodDaily);
  return PASS_XP.floodDaily;
}

interface ChipRow { asset: string; owner: string; collection_idx: number; rarity: number; level: number; flags: number; burned_at: number | null }

function chipOf(db: Db, wallet: string, asset: string): ChipRow {
  const chip = db.get<ChipRow>(`SELECT asset, owner, collection_idx, rarity, level, flags, burned_at FROM chips WHERE asset = ?`, asset);
  if (!chip || chip.burned_at != null) throw new ServiceError(404, 'chip_not_found', 'Chip not found');
  if (chip.owner !== wallet) throw new ServiceError(403, 'not_owner', 'Chip belongs to another wallet');
  if (chip.flags & 0b110) throw new ServiceError(409, 'chip_busy', 'Chip is listed or fusing and cannot dive');
  return chip;
}

export function ensureGridWallet(db: Db, wallet: string, t = now()): { hints: number; valves: number } {
  const row = db.get<{ hints: number; valves: number }>(`SELECT hints, valves FROM grid_wallet_state WHERE wallet = ?`, wallet);
  if (row) return row;
  db.run(`INSERT INTO grid_wallet_state (wallet, hints, valves, starter_granted, total_best_stars, updated_at) VALUES (?, ?, 0, 1, 0, ?)`, wallet, GRID.hintStartStock, t);
  return { hints: GRID.hintStartStock, valves: 0 };
}

export function gridRoute(db: Db, asset: string) {
  const r = db.get<{ next_level: number; charge_drops: number; charge_progress: number }>(`SELECT next_level, charge_drops, charge_progress FROM grid_chip_routes WHERE asset = ?`, asset);
  return { nextLevel: r?.next_level ?? 1, chargeDrops: r?.charge_drops ?? 0, chargeProgress: r?.charge_progress ?? 0 };
}

function saveRoute(db: Db, asset: string, nextLevel: number, drops: number, progress: number, t: number): void {
  db.run(`INSERT INTO grid_chip_routes (asset, next_level, charge_drops, charge_progress, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(asset) DO UPDATE SET next_level = excluded.next_level, charge_drops = excluded.charge_drops, charge_progress = excluded.charge_progress, updated_at = excluded.updated_at`,
    asset, nextLevel, drops, progress, t);
}

/** Earn-only gear grants (arena wins, fusion, staking quests call this; capped, overflow is lost by design). */
export function grantGridHints(db: Db, wallet: string, n: number, t = now()): number {
  const s = ensureGridWallet(db, wallet, t);
  const add = Math.max(0, Math.min(n, GRID.hintStockCap - s.hints));
  if (add > 0) db.run(`UPDATE grid_wallet_state SET hints = hints + ?, updated_at = ? WHERE wallet = ?`, add, t, wallet);
  return add;
}
export function grantGridValve(db: Db, wallet: string, t = now()): number {
  const s = ensureGridWallet(db, wallet, t);
  if (s.valves >= GRID.valveStockCap) return 0;
  db.run(`UPDATE grid_wallet_state SET valves = valves + 1, updated_at = ? WHERE wallet = ?`, t, wallet);
  return 1;
}

/** Arena loss shield: burn one charge droplet instead of −6 XP. Returns true when a droplet paid. */
export function consumeChargeDrop(db: Db, asset: string): boolean {
  const r = gridRoute(db, asset);
  if (r.chargeDrops <= 0) return false;
  db.run(`UPDATE grid_chip_routes SET charge_drops = charge_drops - 1, updated_at = ? WHERE asset = ? AND charge_drops > 0`, now(), asset);
  return true;
}

/** Credit xp_pending leftovers (daily cap was full when earned) for every chip of the wallet. */
export function settleGridPending(db: Db, wallet: string, t = now()): number {
  let granted = 0;
  const rows = db.all<{ asset: string; level: number; xp_pending: number }>(
    `SELECT c.asset, c.level, c.xp_pending FROM grid_level_claims c JOIN chips ch ON ch.asset = c.asset
      WHERE ch.owner = ? AND ch.burned_at IS NULL AND c.xp_pending > 0 ORDER BY c.level`, wallet);
  for (const r of rows) {
    const res = creditChipXp(db, r.asset, r.xp_pending, gridDay(t));
    if (res.granted > 0) {
      db.run(`UPDATE grid_level_claims SET xp_pending = xp_pending - ?, updated_at = ? WHERE asset = ? AND level = ?`, res.granted, t, r.asset, r.level);
      granted += res.granted;
    }
  }
  return granted;
}


/** Hint grant with per-source daily/weekly caps (arena wins, packs). Returns hints actually added. */
export function grantHintFromSource(db: Db, wallet: string, source: string, t: number, caps: { daily: number; weekly: number }): number {
  const day = gridDay(t);
  const today = db.get<{ amount: number }>(`SELECT amount FROM grid_item_grants WHERE wallet = ? AND source = ? AND day = ?`, wallet, source, day)?.amount ?? 0;
  if (today >= caps.daily) return 0;
  const weekSum = db.scalar(`SELECT COALESCE(SUM(amount), 0) FROM grid_item_grants WHERE wallet = ? AND source = ? AND day > ?`, wallet, source, day - 7);
  if (weekSum >= caps.weekly) return 0;
  const added = grantGridHints(db, wallet, 1, t);
  if (added > 0) db.run(`INSERT INTO grid_item_grants (wallet, source, day, amount) VALUES (?, ?, ?, 1) ON CONFLICT(wallet, source, day) DO UPDATE SET amount = amount + 1`, wallet, source, day);
  return added;
}

/** Fusion inheritance: result chip takes the union of material routes (longest sequential prefix),
 *  per-level best stars = max, accounted XP = sum capped at the level ceiling, droplets = sum capped at 3. */
export function mergeFusionRoutes(db: Db, resultAsset: string, materials: readonly string[], t = now()): void {
  if (!resultAsset || materials.length === 0) return;
  let nextLevel = 1;
  for (let level = 1; level <= GRID.totalLevels; level++) {
    const rows = materials.map((m) => db.get<{ best_stars: number; xp_accounted: number; xp_pending: number }>(`SELECT best_stars, xp_accounted, xp_pending FROM grid_level_claims WHERE asset = ? AND level = ?`, m, level)).filter(Boolean) as { best_stars: number; xp_accounted: number; xp_pending: number }[];
    if (rows.length === 0) break;
    const maxXp = gridBaseXp(level);
    db.run(`INSERT INTO grid_level_claims (asset, level, best_stars, xp_accounted, xp_pending, max_xp, completed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(asset, level) DO UPDATE SET best_stars = MAX(best_stars, excluded.best_stars), xp_accounted = excluded.xp_accounted, xp_pending = excluded.xp_pending, updated_at = excluded.updated_at`,
      resultAsset, level, Math.max(...rows.map((r) => r.best_stars)), Math.min(maxXp, rows.reduce((s, r) => s + r.xp_accounted, 0)), rows.reduce((s, r) => s + r.xp_pending, 0), maxXp, t, t);
    nextLevel = level + 1;
  }
  const drops = Math.min(GRID.chargeMax, materials.reduce((s, m) => s + gridRoute(db, m).chargeDrops, 0));
  const progress = Math.max(0, ...materials.map((m) => gridRoute(db, m).chargeProgress));
  saveRoute(db, resultAsset, Math.min(GRID.totalLevels + 1, nextLevel), drops, progress, t);
}

export interface GridAttemptInput { asset?: unknown; level?: unknown; hintsUsed?: unknown; useEmergency?: unknown; mode?: unknown; daily?: unknown; kind?: unknown; slot?: unknown }

export function startGridAttempt(db: Db, wallet: string, body: GridAttemptInput, t = now()) {
  if (body.kind === 'contract' || body.kind === 'deep' || body.kind === 'ghost' || body.kind === 'prestige') return startSpecialAttempt(db, wallet, body, t);
  const asset = typeof body.asset === 'string' ? body.asset : '';
  const level = typeof body.level === 'number' ? Math.floor(body.level) : NaN;
  const hintsUsed = body.hintsUsed === undefined ? 0 : Math.floor(Number(body.hintsUsed));
  if (!asset || !Number.isFinite(level) || level < 1 || level > GRID.totalLevels) throw new ServiceError(422, 'bad_request', 'asset and level 1..75 are required');
  if (!Number.isFinite(hintsUsed) || hintsUsed < 0 || hintsUsed > GRID.hintMaxPerChargeAttempt) throw new ServiceError(422, 'bad_request', `hintsUsed must be 0..${GRID.hintMaxPerChargeAttempt} for a charge attempt`);
  chipOf(db, wallet, asset);
  ensureGridWallet(db, wallet, t);
  settleGridPending(db, wallet, t);
  const route = gridRoute(db, asset);
  const training = body.mode === 'training' || body.daily === true;
  if (body.daily === true && level !== gridDailyLevel(t)) throw new ServiceError(422, 'bad_request', `Daily flood is sector ${gridDailyLevel(t)} today`);
  if (!training && level > route.nextLevel) throw new ServiceError(409, 'route_locked', `Chip route is at sector ${route.nextLevel}; sectors cannot be skipped (open it in training)`);
  // Replays of cleared sectors are always allowed (training / star top-up / droplet refill);
  // XP stays capped by the per-(chip, level) ceiling in completeGridAttempt, so nothing re-farms.
  let emergencyUsed = 0;
  if (!training && body.useEmergency === true) {
    const e = db.get<{ available: number }>(`SELECT available FROM grid_emergency WHERE asset = ? AND level = ?`, asset, level);
    if (!e || e.available <= 0) throw new ServiceError(409, 'no_emergency_hint', 'No emergency hint for this sector');
    db.run(`UPDATE grid_emergency SET available = 0 WHERE asset = ? AND level = ?`, asset, level);
    emergencyUsed = 1;
  }
  if (!training && hintsUsed > 0) {
    const s = ensureGridWallet(db, wallet, t);
    if (s.hints < hintsUsed) throw new ServiceError(409, 'no_hints', 'Not enough hints (Метки Клеммы)');
  }
  const id = randomUUID();
  const seed = body.daily === true ? dailySeed(gridDay(t)) : levelSeed(level);
  db.run(`INSERT INTO grid_attempts (id, wallet, asset, level, hints_used, emergency_used, mode, seed, daily, settled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`, id, wallet, asset, level, training ? 0 : hintsUsed, emergencyUsed, training ? 'training' : 'charge', seed, body.daily === true ? 1 : 0, t);
  const lv = generateLevel(level, seed);
  return {
    attemptId: id, level, par: lv.parMoves, moveBudget: lv.parMoves * GRID.moveBudgetMult, route,
    // Public board layout (never the solution): the client renders exactly this and replays turns locally.
    board: { size: lv.size, bus: lv.bus, receivers: lv.receivers, tiles: lv.tiles.map((tile) => ({ base: tile.base, rot: tile.rot, fixed: tile.fixed, role: tile.role })) },
  };
}

type SpecialKind = 'contract' | 'deep' | 'ghost' | 'prestige';
function startSpecialAttempt(db: Db, wallet: string, body: GridAttemptInput, t: number) {
  const kind = body.kind as SpecialKind;
  const asset = typeof body.asset === 'string' ? body.asset : '';
  const hintsUsed = body.hintsUsed === undefined ? 0 : Math.floor(Number(body.hintsUsed));
  if (!asset) throw new ServiceError(422, 'bad_request', 'asset is required');
  if (!Number.isFinite(hintsUsed) || hintsUsed < 0 || hintsUsed > GRID.hintMaxPerChargeAttempt) throw new ServiceError(422, 'bad_request', 'hintsUsed out of range');
  const chip = chipOf(db, wallet, asset);
  ensureGridWallet(db, wallet, t);
  settleGridPending(db, wallet, t);
  let level = 0; let seed = 0; let budgetMult: number = GRID.moveBudgetMult; let contract: GridContract | null = null;
  if (kind === 'contract') {
    const slot = typeof body.slot === 'number' ? Math.floor(body.slot) : NaN;
    if (!Number.isFinite(slot) || slot < 0 || slot >= GRID.contractsPerDay) throw new ServiceError(422, 'bad_request', `slot 0..${GRID.contractsPerDay - 1} is required`);
    contract = gridContractAt(t, slot);
    if (chip.collection_idx !== contract.district) throw new ServiceError(409, 'wrong_district', `Contract is for district ${contract.district + 1}; the conductor must be a chip of that district`);
    if (gridRoute(db, asset).nextLevel <= GRID.totalLevels) throw new ServiceError(409, 'contract_locked', 'District contracts open after the conductor finishes the 75-sector Descent');
    if (db.get(`SELECT 1 FROM grid_contract_done WHERE wallet = ? AND day = ? AND slot = ?`, wallet, gridDay(t), slot)) throw new ServiceError(409, 'contract_done', 'That contract is already completed today');
    level = contract.configLevel; seed = contract.seed;
    if (hintsUsed > 0 && ensureGridWallet(db, wallet, t).hints < hintsUsed) throw new ServiceError(409, 'no_hints', 'Not enough hints (Метки Клеммы)');
  } else if (kind === 'deep') {
    if (hintsUsed > 0) throw new ServiceError(422, 'deep_no_hints', 'Deep Flood is played without hints');
    const week = gridWeek(t); const from = gridWeekStart(week);
    const used = db.scalar(`SELECT COUNT(*) FROM grid_attempts WHERE wallet = ? AND mode = 'deep' AND created_at >= ? AND created_at < ?`, wallet, from, from + 7 * DAY);
    const credits = db.scalar(`SELECT COUNT(*) FROM grid_deep_credits WHERE wallet = ? AND week = ?`, wallet, week);
    if (used >= GRID.deepFreeAttemptsPerWeek + credits) throw new ServiceError(409, 'deep_attempts_exhausted', 'No Deep Flood attempts left this week — buy one for 30 $CG (burned)');
    level = GRID.totalLevels; seed = gridDeepSeed(week); budgetMult = GRID.deepMoveBudgetMult;
  } else if (kind === 'prestige') {
    if (hintsUsed > 0) throw new ServiceError(422, 'prestige_no_hints', 'Prestige descent is played without hints');
    if (gridRoute(db, asset).nextLevel <= GRID.totalLevels) throw new ServiceError(409, 'prestige_locked', 'Prestige opens after the conductor finishes the 75-sector Descent');
    const pr = db.get<{ prestige_level: number; next_sector: number }>(`SELECT prestige_level, next_sector FROM grid_prestige_routes WHERE asset = ?`, asset) ?? { prestige_level: 0, next_sector: 1 };
    if (pr.prestige_level >= GRID.prestigeMax) throw new ServiceError(409, 'prestige_maxed', 'This chip already carries all prestige seals');
    level = pr.next_sector; seed = hashString(`grid:prestige:${asset}:${pr.prestige_level}:${level}`); budgetMult = GRID.deepMoveBudgetMult;
  } else {
    if (hintsUsed > 0) throw new ServiceError(422, 'ghost_no_hints', 'The Ghost runs clean — no hints');
    level = DAILY_CONFIG_LEVEL; seed = gridGhostSeed(gridDay(t));
  }
  const id = randomUUID();
  db.run(`INSERT INTO grid_attempts (id, wallet, asset, level, hints_used, emergency_used, mode, seed, daily, settled, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, 0, 0, ?)`, id, wallet, asset, level, hintsUsed, kind, seed, t);
  const lv = generateLevel(level, seed);
  return {
    attemptId: id, kind, level, par: lv.parMoves, moveBudget: Math.ceil(lv.parMoves * budgetMult), route: gridRoute(db, asset),
    ...(contract ? { contract } : {}),
    board: { size: lv.size, bus: lv.bus, receivers: lv.receivers, tiles: lv.tiles.map((tile) => ({ base: tile.base, rot: tile.rot, fixed: tile.fixed, role: tile.role })) },
  };
}

function spendHints(db: Db, wallet: string, n: number, t: number): void {
  if (n <= 0) return;
  const s = ensureGridWallet(db, wallet, t);
  if (s.hints < n) throw new ServiceError(409, 'no_hints', 'Not enough hints (Метки Клеммы)');
  db.run(`UPDATE grid_wallet_state SET hints = hints - ?, updated_at = ? WHERE wallet = ?`, n, t, wallet);
}

function processGifts(db: Db, wallet: string, asset: string, level: number, t: number): { level: number; kind: string; amount: number }[] {
  const granted: { level: number; kind: string; amount: number }[] = [];
  for (const g of GRID_GIFTS.filter((x) => x.level === level)) {
    const key = g.key ?? (g.template !== undefined ? `template-${g.template}` : '');
    if (db.get(`SELECT 1 FROM grid_gifts WHERE wallet = ? AND level = ? AND kind = ? AND gift_key = ?`, wallet, level, g.kind, key)) continue;
    db.run(`INSERT INTO grid_gifts (wallet, level, kind, gift_key, claimed_at) VALUES (?, ?, ?, ?, ?)`, wallet, level, g.kind, key, t);
    if (g.kind === 'hints') grantGridHints(db, wallet, g.amount, t);
    else if (g.kind === 'xp_ticket') creditChipXp(db, asset, 100 * g.amount, gridDay(t), { bypassDailyCap: true });
    else if (g.kind === 'booster') {
      db.run(`INSERT INTO quest_completions (wallet, quest_id, period_key, amount, reward_chip, reward_booster, completed_at, day) VALUES (?, ?, 'all', '0', NULL, ?, ?, ?)`,
        wallet, `grid_gift_${level}`, g.amount, t, gridDay(t));
    } else if (g.kind === 'skin' || g.kind === 'theme' || g.kind === 'banner' || g.kind === 'title' || g.kind === 'seal') {
      grantGridCosmetic(db, wallet, g.kind, key, `grid:gift:${level}:${g.kind}:${key}`, t, db.get<{ collection_idx: number }>(`SELECT collection_idx FROM chips WHERE asset = ?`, asset)?.collection_idx);
    } else if (g.kind === 'chip_voucher' && g.template !== undefined) {
      const tpl = QUEST_CHIP_TEMPLATES[g.template];
      if (tpl) db.run(`INSERT INTO quest_completions (wallet, quest_id, period_key, amount, reward_chip, reward_booster, completed_at, day) VALUES (?, ?, 'all', '0', ?, 0, ?, ?)`,
        wallet, `grid_gift_${level}`, JSON.stringify(tpl), t, gridDay(t));
    }
    granted.push({ level, kind: g.kind, amount: g.amount });
  }
  return granted;
}

function settleFail(db: Db, wallet: string, attempt: { id: string; asset: string; level: number; hints_used: number }, t: number, useValve: boolean) {
  spendHints(db, wallet, attempt.hints_used, t);
  let valveUsed = false;
  if (useValve) {
    const s = ensureGridWallet(db, wallet, t);
    if (s.valves > 0) { db.run(`UPDATE grid_wallet_state SET valves = valves - 1, updated_at = ? WHERE wallet = ?`, t, wallet); valveUsed = true; }
  }
  const xpLoss = valveUsed ? 0 : GRID.failXp;
  if (!valveUsed) creditChipXp(db, attempt.asset, GRID.failXp, gridDay(t));
  db.run(`INSERT INTO grid_fails (wallet, asset, level, fails) VALUES (?, ?, ?, 1) ON CONFLICT(wallet, asset, level) DO UPDATE SET fails = fails + 1`, wallet, attempt.asset, attempt.level);
  const fails = db.get<{ fails: number }>(`SELECT fails FROM grid_fails WHERE wallet = ? AND asset = ? AND level = ?`, wallet, attempt.asset, attempt.level)?.fails ?? 0;
  let emergencyGranted = false;
  if (fails >= GRID.emergencyHintAfterFails) {
    const e = db.get<{ available: number }>(`SELECT available FROM grid_emergency WHERE asset = ? AND level = ?`, attempt.asset, attempt.level);
    if (!e || e.available <= 0) {
      db.run(`INSERT INTO grid_emergency (asset, level, available) VALUES (?, ?, 1) ON CONFLICT(asset, level) DO UPDATE SET available = 1`, attempt.asset, attempt.level);
      emergencyGranted = true;
    }
  }
  db.run(`UPDATE grid_attempts SET settled = 1, settled_at = ? WHERE id = ?`, t, attempt.id);
  return { ok: false as const, reason: 'flood_gone', xpLoss, valveUsed, fails, emergencyGranted, route: gridRoute(db, attempt.asset) };
}

export interface GridCompleteInput { attemptId?: unknown; turns?: unknown; useValve?: unknown }

export function completeGridAttempt(db: Db, wallet: string, body: GridCompleteInput, t = now()) {
  const attemptId = typeof body.attemptId === 'string' ? body.attemptId : '';
  const attempt = db.get<{ id: string; wallet: string; asset: string; level: number; hints_used: number; emergency_used: number; mode: string; seed: number | null; settled: number }>(`SELECT * FROM grid_attempts WHERE id = ?`, attemptId);
  if (!attempt || attempt.wallet !== wallet) throw new ServiceError(404, 'attempt_not_found', 'Unknown grid attempt');
  if (attempt.settled) throw new ServiceError(409, 'attempt_settled', 'Attempt already settled');
  const chip = chipOf(db, wallet, attempt.asset);
  const turns = body.turns;
  if (!Array.isArray(turns) || turns.length === 0 || turns.length > 5000) throw new ServiceError(422, 'bad_proof', 'turns must be a non-empty move list');
  const lv = generateLevel(attempt.level, attempt.seed ?? levelSeed(attempt.level));
  for (const turn of turns) {
    if (!Array.isArray(turn) || turn.length !== 2) throw new ServiceError(422, 'bad_proof', 'turn must be [index, dir]');
    const [index, dir] = turn as [number, number];
    if (!Number.isInteger(index) || (dir !== 1 && dir !== -1) || !lv.tiles[index]) throw new ServiceError(422, 'bad_proof', 'turn out of board');
    if (!applyRotate(lv, index, dir)) throw new ServiceError(422, 'bad_proof', 'fixed tile cannot rotate');
  }
  const moves = turns.length;
  if (attempt.mode === 'contract' || attempt.mode === 'deep' || attempt.mode === 'ghost' || attempt.mode === 'prestige') {
    return settleSpecialAttempt(db, wallet, attempt, chip.collection_idx, moves, isSolved(lv), lv.parMoves, t);
  }
  if (attempt.mode === 'training') {
    const solved = isSolved(lv);
    db.run(`UPDATE grid_attempts SET settled = 1, settled_at = ? WHERE id = ?`, t, attempt.id);
    const passXp = solved && (attempt as { daily?: number }).daily ? awardDailyPassXp(db, wallet, t) : 0;
    return { ok: solved, training: true as const, stars: 0, xpGranted: 0, xpPending: 0, passXp, moves, par: lv.parMoves };
  }
  if (!isSolved(lv)) {
    return { ...settleFail(db, wallet, attempt as never, t, body.useValve === true), solved: false };
  }
  const totalHints = attempt.hints_used + attempt.emergency_used;
  if (totalHints >= 2) {
    spendHints(db, wallet, attempt.hints_used, t);
    db.run(`UPDATE grid_attempts SET settled = 1, settled_at = ? WHERE id = ?`, t, attempt.id);
    return { ok: true as const, training: true, stars: 0, xpGranted: 0, xpPending: 0, message: 'Second hint converted the attempt to training' };
  }
  let stars = gridStarsForMoves(moves, lv.parMoves);
  if (totalHints === 1) stars = Math.min(stars, 2) as 0 | 1 | 2 | 3;
  if (stars <= 0) return { ...settleFail(db, wallet, attempt as never, t, body.useValve === true), solved: true };
  spendHints(db, wallet, attempt.hints_used, t);

  const routeBefore = gridRoute(db, attempt.asset);
  const existing = db.get<{ best_stars: number; xp_accounted: number; xp_pending: number }>(`SELECT best_stars, xp_accounted, xp_pending FROM grid_level_claims WHERE asset = ? AND level = ?`, attempt.asset, attempt.level);
  const firstCompletion = !existing;
  const maxXp = gridBaseXp(attempt.level);
  const targetXp = gridXpForStars(attempt.level, stars);
  const due = Math.max(0, targetXp - (existing?.xp_accounted ?? 0));
  const credit = due > 0 ? creditChipXp(db, attempt.asset, due, gridDay(t)) : { granted: 0, fromLevel: chip.level, toLevel: chip.level };
  const pendingAdd = due - credit.granted;
  const bestStars = Math.max(existing?.best_stars ?? 0, stars);
  db.run(`INSERT INTO grid_level_claims (asset, level, best_stars, xp_accounted, xp_pending, max_xp, completed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(asset, level) DO UPDATE SET best_stars = excluded.best_stars, xp_accounted = excluded.xp_accounted, xp_pending = xp_pending + excluded.xp_pending, updated_at = excluded.updated_at`,
    attempt.asset, attempt.level, bestStars, (existing?.xp_accounted ?? 0) + due, pendingAdd, maxXp, t, t);

  // Route advance (sequential only), droplet progress (>=2★ sectors), repeat refill (1/day/chip).
  let { nextLevel, chargeDrops, chargeProgress } = routeBefore;
  let dropletGained = false;
  if (firstCompletion && attempt.level === nextLevel) nextLevel = Math.min(GRID.totalLevels + 1, nextLevel + 1);
  const crossedToCharged = stars >= 2 && (existing?.best_stars ?? 0) < 2;
  // Flood Night Sunday: chips of the Drain district of the day earn droplet progress/refills x2.
  const dropletMult = gridIsSunday(t) && (chip.collection_idx === gridFeaturedDistrict(t) || districtGoalReached(db, chip.collection_idx, gridWeek(t) - 1)) ? GRID.floodSundayDropletMult : 1;
  if (crossedToCharged || (firstCompletion && stars >= 2)) {
    chargeProgress += dropletMult;
    while (chargeProgress >= GRID.chargePerSectorStreak && chargeDrops < GRID.chargeMax) { chargeDrops += 1; chargeProgress -= GRID.chargePerSectorStreak; dropletGained = true; }
  } else if (!firstCompletion) {
    const today = gridDay(t);
    const r = db.get<{ charge_day: number; charge_refills: number }>(`SELECT charge_day, charge_refills FROM grid_chip_routes WHERE asset = ?`, attempt.asset);
    if (moves <= Math.ceil(lv.parMoves * 1.5) && (r?.charge_day !== today || (r?.charge_refills ?? 0) < GRID.chargeRefillPerDay) && chargeDrops < GRID.chargeMax) {
      const gain = Math.min(dropletMult, GRID.chargeMax - chargeDrops);
      chargeDrops += gain; dropletGained = gain > 0;
      db.run(`INSERT INTO grid_chip_routes (asset, charge_day, charge_refills, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(asset) DO UPDATE SET charge_day = excluded.charge_day, charge_refills = 1, updated_at = excluded.updated_at`, attempt.asset, today, t);
    }
  }
  saveRoute(db, attempt.asset, nextLevel, chargeDrops, chargeProgress, t);

  if (firstCompletion && totalHints === 0) {
    // Clean-sector drip (docs/13 §0.4): every 3rd sector cleared without a hint earns a hint.
    db.run(`INSERT INTO grid_item_grants (wallet, source, day, amount) VALUES (?, 'clean_progress', 0, 1) ON CONFLICT(wallet, source, day) DO UPDATE SET amount = amount + 1`, wallet);
    const progress = db.get<{ amount: number }>(`SELECT amount FROM grid_item_grants WHERE wallet = ? AND source = 'clean_progress' AND day = 0`, wallet)?.amount ?? 0;
    if (progress % 3 === 0 && grantGridHints(db, wallet, 1, t) > 0) {
      db.run(`INSERT INTO grid_item_grants (wallet, source, day, amount) VALUES (?, 'grid_clean', ?, 1) ON CONFLICT(wallet, source, day) DO UPDATE SET amount = amount + 1`, wallet, gridDay(t));
    }
  }
  if (firstCompletion) {
    db.run(`INSERT INTO grid_completions (wallet, asset, level, stars, moves, day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, wallet, attempt.asset, attempt.level, stars, moves, gridDay(t), t);
    db.run(`INSERT INTO grid_flood (district, week, points) VALUES (?, ?, ?) ON CONFLICT(district, week) DO UPDATE SET points = points + excluded.points`, chip.collection_idx, gridWeek(t), depthOfLevel(attempt.level));
  }
  const gifts = firstCompletion ? processGifts(db, wallet, attempt.asset, attempt.level, t) : [];
  // Account best-stars total + star milestones.
  const totalStars = db.scalar(`SELECT COALESCE(SUM(best_stars), 0) FROM grid_level_claims WHERE asset IN (SELECT asset FROM chips WHERE owner = ? AND burned_at IS NULL)`, wallet);
  const prev = db.get<{ total_best_stars: number }>(`SELECT total_best_stars FROM grid_wallet_state WHERE wallet = ?`, wallet)?.total_best_stars ?? 0;
  if (totalStars > prev) {
    db.run(`UPDATE grid_wallet_state SET total_best_stars = ?, updated_at = ? WHERE wallet = ?`, totalStars, t, wallet);
    for (const m of GRID.starMilestones) if (prev < m.stars && totalStars >= m.stars) { grantGridHints(db, wallet, m.hints, t); if (m.valves) grantGridValve(db, wallet, t); if (m.skin) grantGridCosmetic(db, wallet, 'skin', m.skin, `grid:stars:${m.stars}:skin:${m.skin}`, t); }
  }
  db.run(`UPDATE grid_attempts SET settled = 1, settled_at = ? WHERE id = ?`, t, attempt.id);
  return {
    ok: true as const, training: false, level: attempt.level, moves, par: lv.parMoves, stars, hintsUsed: totalHints,
    xpGranted: credit.granted, xpPending: pendingAdd, fromLevel: credit.fromLevel, toLevel: credit.toLevel,
    dropletGained, gifts, route: gridRoute(db, attempt.asset), wallet: ensureGridWallet(db, wallet, t),
  };
}

function settleSpecialAttempt(db: Db, wallet: string, attempt: { id: string; asset: string; level: number; hints_used: number; mode: string; created_at?: number }, _district: number, moves: number, solved: boolean, par: number, t: number) {
  const kind = attempt.mode as SpecialKind;
  if (kind === 'contract') spendHints(db, wallet, attempt.hints_used, t);
  const settle = () => db.run(`UPDATE grid_attempts SET settled = 1, settled_at = ? WHERE id = ?`, t, attempt.id);
  if (!solved) { settle(); return { ok: false as const, kind, reason: 'not_solved', moves, par }; }
  const stars = gridStarsForMoves(moves, par);
  if (kind === 'contract') {
    if (stars <= 0) { settle(); return { ok: false as const, kind, reason: 'over_budget', moves, par }; }
    const routeBefore = gridRoute(db, attempt.asset);
    let { nextLevel, chargeDrops, chargeProgress } = routeBefore;
    let dropletGained = false;
    if (stars >= 2) {
      chargeProgress += 1;
      while (chargeProgress >= GRID.chargePerSectorStreak && chargeDrops < GRID.chargeMax) { chargeDrops += 1; chargeProgress -= GRID.chargePerSectorStreak; dropletGained = true; }
    }
    saveRoute(db, attempt.asset, nextLevel, chargeDrops, chargeProgress, t);
    // The contract board is re-derived from (day, slot); find which of today's offers this attempt was.
    const t0 = (attempt as { created_at?: number }).created_at ?? t;
    const storedSeed = db.get<{ seed: number }>(`SELECT seed FROM grid_attempts WHERE id = ?`, attempt.id)?.seed ?? -1;
    const contract = [0, 1, 2].map((slot) => gridContractAt(t0, slot)).find((c) => c.seed === storedSeed && c.configLevel === attempt.level);
    if (contract) db.run(`INSERT INTO grid_contract_done (wallet, day, slot, asset, stars, moves, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(wallet, day, slot) DO NOTHING`, wallet, gridDay(t), contract.slot, attempt.asset, stars, moves, t);
    db.run(`INSERT INTO grid_completions (wallet, asset, level, stars, moves, day, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, 'contract', ?)`, wallet, attempt.asset, attempt.level, stars, moves, gridDay(t), t);
    settle();
    return { ok: true as const, training: false as const, kind, stars, moves, par, xpGranted: 0, xpPending: 0, dropletGained, route: gridRoute(db, attempt.asset), wallet: ensureGridWallet(db, wallet, t) };
  }
  if (kind === 'ghost') {
    const beaten = moves <= par;
    let hintGranted = 0;
    if (beaten && !db.get(`SELECT 1 FROM grid_item_grants WHERE wallet = ? AND source = 'ghost_day' AND day = ?`, wallet, gridDay(t))) {
      hintGranted = grantGridHints(db, wallet, GRID.ghostHintsPerDay, t);
      db.run(`INSERT INTO grid_item_grants (wallet, source, day, amount) VALUES (?, 'ghost_day', ?, ?)`, wallet, gridDay(t), hintGranted);
    }
    settle();
    return { ok: true as const, training: false as const, kind, beaten, moves, par, xpGranted: 0, xpPending: 0, hintGranted, wallet: ensureGridWallet(db, wallet, t) };
  }
  if (kind === 'prestige') {
    const starsPrestige = moves <= par ? 3 : moves <= Math.ceil(par * 1.25) ? 2 : moves <= Math.ceil(par * GRID.deepMoveBudgetMult) ? 1 : 0;
    if (starsPrestige <= 0) { settle(); return { ok: false as const, kind, reason: 'over_budget', moves, par }; }
    const routeBefore = gridRoute(db, attempt.asset);
    let { nextLevel, chargeDrops, chargeProgress } = routeBefore;
    let dropletGained = false;
    if (starsPrestige >= 2) {
      chargeProgress += 1;
      while (chargeProgress >= GRID.chargePerSectorStreak && chargeDrops < GRID.chargeMax) { chargeDrops += 1; chargeProgress -= GRID.chargePerSectorStreak; dropletGained = true; }
    }
    saveRoute(db, attempt.asset, nextLevel, chargeDrops, chargeProgress, t);
    const pr = db.get<{ prestige_level: number; next_sector: number }>(`SELECT prestige_level, next_sector FROM grid_prestige_routes WHERE asset = ?`, attempt.asset) ?? { prestige_level: 0, next_sector: 1 };
    let sealGranted: string | null = null;
    if (attempt.level >= GRID.totalLevels) {
      const lvl = Math.min(GRID.prestigeMax, pr.prestige_level + 1);
      db.run(`INSERT INTO grid_prestige_routes (asset, prestige_level, next_sector, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(asset) DO UPDATE SET prestige_level = excluded.prestige_level, next_sector = 1, updated_at = excluded.updated_at`, attempt.asset, lvl, t);
      grantGridCosmetic(db, wallet, 'seal', 'prestige-seal', `grid:prestige:${attempt.asset}:p${lvl}`, t);
      if (lvl === 1) grantGridCosmetic(db, wallet, 'title', 'prestige-diver', `grid:prestige:title:${wallet}`, t);
      sealGranted = `P${lvl}`;
    } else {
      db.run(`INSERT INTO grid_prestige_routes (asset, prestige_level, next_sector, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(asset) DO UPDATE SET next_sector = excluded.next_sector, updated_at = excluded.updated_at`, attempt.asset, pr.prestige_level, attempt.level + 1, t);
    }
    settle();
    return { ok: true as const, training: false as const, kind, stars: starsPrestige, moves, par, xpGranted: 0, xpPending: 0, dropletGained, sealGranted, route: gridRoute(db, attempt.asset), wallet: ensureGridWallet(db, wallet, t) };
  }
  // Deep Flood
  const budget = Math.ceil(par * GRID.deepMoveBudgetMult);
  if (moves > budget) { settle(); return { ok: false as const, kind, reason: 'over_budget', moves, par, budget }; }
  const week = gridWeek(t);
  db.run(`INSERT INTO grid_deep_results (wallet, week, asset, moves, stars, created_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(wallet, week) DO UPDATE SET moves = excluded.moves, stars = excluded.stars, asset = excluded.asset, created_at = excluded.created_at WHERE excluded.moves < grid_deep_results.moves`, wallet, week, attempt.asset, moves, stars, t);
  const best = db.get<{ moves: number; stars: number }>(`SELECT moves, stars FROM grid_deep_results WHERE wallet = ? AND week = ?`, wallet, week);
  const rank = db.scalar(`SELECT COUNT(*) FROM grid_deep_results WHERE week = ? AND moves < ?`, week, best?.moves ?? moves) + 1;
  settle();
  return { ok: true as const, training: false as const, kind, stars, moves, par, xpGranted: 0, xpPending: 0, rank, wallet: ensureGridWallet(db, wallet, t) };
}

export function failGridAttempt(db: Db, wallet: string, body: GridCompleteInput, t = now()) {
  const attemptId = typeof body.attemptId === 'string' ? body.attemptId : '';
  const attempt = db.get<{ id: string; wallet: string; asset: string; level: number; hints_used: number; mode: string; settled: number }>(`SELECT * FROM grid_attempts WHERE id = ?`, attemptId);
  if (!attempt || attempt.wallet !== wallet) throw new ServiceError(404, 'attempt_not_found', 'Unknown grid attempt');
  if (attempt.settled) throw new ServiceError(409, 'attempt_settled', 'Attempt already settled');
  chipOf(db, wallet, attempt.asset);
  if (attempt.mode === 'contract' || attempt.mode === 'deep' || attempt.mode === 'ghost' || attempt.mode === 'prestige') {
    if (attempt.mode === 'contract') spendHints(db, wallet, attempt.hints_used, t);
    db.run(`UPDATE grid_attempts SET settled = 1, settled_at = ? WHERE id = ?`, t, attempt.id);
    return { ok: false as const, kind: attempt.mode, reason: 'gave_up' };
  }
  if ((attempt as { mode?: string }).mode === 'training') {
    db.run(`UPDATE grid_attempts SET settled = 1, settled_at = ? WHERE id = ?`, t, attempt.id);
    return { ok: false as const, training: true, xpLoss: 0, valveUsed: false };
  }
  return settleFail(db, wallet, attempt as never, t, body.useValve === true);
}


/** District co-op goal (owner-approved): a district whose weekly flood points reach the goal pays
 *  every participant a valve; on Sunday its chips also earn double droplet progress. */
export const districtGoalReached = (db: Db, district: number, week: number): boolean =>
  (db.get<{ points: number }>(`SELECT points FROM grid_flood WHERE district = ? AND week = ?`, district, week)?.points ?? 0) >= GRID.districtGoalPoints;

export function settleDistrictGoalForWallet(db: Db, wallet: string, t = now()): { week: number; district: number; valve: number } | null {
  const week = gridWeek(t) - 1;
  if (week < 0) return null;
  if (db.get(`SELECT 1 FROM grid_district_goal_settlements WHERE wallet = ? AND week = ?`, wallet, week)) return null;
  const from = gridWeekStart(week);
  const rows = db.all<{ district: number }>(
    `SELECT DISTINCT ch.collection_idx AS district FROM grid_completions c JOIN chips ch ON ch.asset = c.asset
      WHERE c.wallet = ? AND c.created_at >= ? AND c.created_at < ?`, wallet, from, from + 7 * DAY);
  const hit = rows.find((r) => districtGoalReached(db, r.district, week));
  if (!hit) return null;
  const valve = grantGridValve(db, wallet, t);
  db.run(`INSERT INTO grid_district_goal_settlements (wallet, week, district, valve, settled_at) VALUES (?, ?, ?, ?, ?)`, wallet, week, hit.district, valve, t);
  return { week, district: hit.district, valve };
}

// ---------------------------------------------------------------------------
// Seasonal PvE ladder (owner-approved brackets): points from weekly Deep Flood ranks + solved
// dailies; payouts are $CG rows rooted by the reward oracle through kind-4 (events) roots.
// ---------------------------------------------------------------------------
export function gridLadderPoints(db: Db, startsAt: number, endsAt: number): Map<string, number> {
  const points = new Map<string, number>();
  const add = (w: string, n: number) => points.set(w, (points.get(w) ?? 0) + n);
  for (let week = gridWeek(startsAt); week <= gridWeek(Math.max(startsAt, endsAt - 1)); week++) {
    const rows = db.all<{ wallet: string; moves: number }>(`SELECT wallet, moves FROM grid_deep_results WHERE week = ? ORDER BY moves ASC, wallet`, week);
    rows.forEach((r, i) => add(r.wallet, i === 0 ? GRID.ladderRankPoints[0] : i === 1 ? GRID.ladderRankPoints[1] : i === 2 ? GRID.ladderRankPoints[2] : i < 5 ? GRID.ladderRankPoints[3] : i < 10 ? GRID.ladderRankPoints[4] : 0));
  }
  for (const r of db.all<{ wallet: string; amount: number }>(`SELECT wallet, amount FROM grid_item_grants WHERE source = 'pass_daily' AND day >= ? AND day < ?`, gridDay(startsAt), gridDay(endsAt))) add(r.wallet, r.amount);
  return points;
}

export function settleGridLadder(db: Db, seasonId: number, t = now()): { season: number; rows: number } | null {
  const s = db.get<{ id: number; starts_at: number; ends_at: number }>(`SELECT id, starts_at, ends_at FROM seasons WHERE id = ?`, seasonId);
  if (!s || s.ends_at > t) return null;
  if (db.get(`SELECT 1 FROM grid_ladder_payouts WHERE season = ?`, seasonId)) return null;
  const ranked = [...gridLadderPoints(db, s.starts_at, s.ends_at).entries()].filter(([, pts]) => pts >= 3).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  if (ranked.length === 0) return null;
  const bracket = (rank: number): bigint => {
    if (rank === 1) return BigInt(GRID.ladderPayoutCgMicro.first);
    if (rank <= 3) return BigInt(GRID.ladderPayoutCgMicro.secondThird);
    if (rank <= 10) return BigInt(GRID.ladderPayoutCgMicro.top10);
    if (rank <= Math.ceil(ranked.length * 0.1)) return BigInt(GRID.ladderPayoutCgMicro.topDecile);
    return 0n;
  };
  const eligible = ranked.filter(([w]) => {
    const firstSeen = db.get<{ first_seen: number }>(`SELECT first_seen FROM wallets WHERE address = ?`, w)?.first_seen;
    if (!firstSeen || firstSeen > t - 7 * DAY) return false; // anti-farm: account >= 7 days
    return !!db.get(`SELECT 1 FROM pack_purchases WHERE buyer = ? AND sku > 0 LIMIT 1`, w); // and >= 1 paid pack
  });
  let amounts = eligible.map(([w, pts]) => { const rank = ranked.findIndex(([x]) => x === w) + 1; return { wallet: w, points: pts, rank, amount: bracket(rank) }; }).filter((r) => r.amount > 0n);
  const total = amounts.reduce((sum, r) => sum + r.amount, 0n);
  const cap = BigInt(GRID.ladderPoolCapMicro);
  if (total > cap) amounts = amounts.map((r) => ({ ...r, amount: (r.amount * cap) / total })).filter((r) => r.amount > 0n);
  db.tx(() => {
    for (const r of amounts) db.run(`INSERT INTO grid_ladder_payouts (season, wallet, rank, points, amount) VALUES (?, ?, ?, ?, ?)`, seasonId, r.wallet, r.rank, r.points, r.amount.toString());
  });
  return { season: seasonId, rows: amounts.length };
}
/** Flood Night settlement, lazily on read (docs/13 §0.6: no cron). Previous week's winning
 *  district pays its divers in gear only: participants +1 hint, top-3 +1 more, #1 also a valve. */
export function settleFloodForWallet(db: Db, wallet: string, t = now()): { week: number; hints: number; valve: number } | null {
  const week = gridWeek(t) - 1;
  if (week < 0) return null;
  if (db.get(`SELECT 1 FROM grid_flood_settlements WHERE wallet = ? AND week = ?`, wallet, week)) return null;
  const winner = db.get<{ district: number; points: number }>(`SELECT district, points FROM grid_flood WHERE week = ? ORDER BY points DESC, district LIMIT 1`, week);
  if (!winner || winner.points <= 0) return null;
  const from = week * 7 * DAY + 4 * DAY;
  const rows = db.all<{ wallet: string; pts: number }>(
    `SELECT c.wallet, SUM(c.level) AS pts FROM grid_completions c JOIN chips ch ON ch.asset = c.asset
      WHERE c.created_at >= ? AND c.created_at < ? AND ch.collection_idx = ? GROUP BY c.wallet ORDER BY pts DESC, c.wallet`, from, from + 7 * DAY, winner.district);
  const rank = rows.findIndex((r) => r.wallet === wallet);
  if (rank < 0) return null;
  let hints = 1;
  if (rank < 3) hints += 1;
  const valve = rank === 0 ? grantGridValve(db, wallet, t) : 0;
  const grantedHints = grantGridHints(db, wallet, hints, t);
  db.run(`INSERT INTO grid_flood_settlements (wallet, week, hints, valve, settled_at) VALUES (?, ?, ?, ?, ?)`, wallet, week, grantedHints, valve, t);
  return { week, hints: grantedHints, valve };
}

/** Deep Flood weekly settlement (lazy, on read like Flood Night): gear only.
 *  Participants +1 hint, top-3 +1 more, the week's best run also a valve. */
export function settleDeepForWallet(db: Db, wallet: string, t = now()): { week: number; hints: number; valve: number; rank: number } | null {
  const week = gridWeek(t) - 1;
  if (week < 0) return null;
  if (db.get(`SELECT 1 FROM grid_deep_settlements WHERE wallet = ? AND week = ?`, wallet, week)) return null;
  if (!db.get(`SELECT 1 FROM grid_deep_results WHERE wallet = ? AND week = ?`, wallet, week)) return null;
  const rows = db.all<{ wallet: string; moves: number }>(`SELECT wallet, moves FROM grid_deep_results WHERE week = ? ORDER BY moves ASC, wallet`, week);
  const rank = rows.findIndex((r) => r.wallet === wallet);
  if (rank < 0) return null;
  let hints = 1;
  if (rank < 3) hints += 1;
  const valve = rank === 0 ? grantGridValve(db, wallet, t) : 0;
  const grantedHints = grantGridHints(db, wallet, hints, t);
  db.run(`INSERT INTO grid_deep_settlements (wallet, week, hints, valve, settled_at) VALUES (?, ?, ?, ?, ?)`, wallet, week, grantedHints, valve, t);
  return { week, hints: grantedHints, valve, rank: rank + 1 };
}

export function gridMe(db: Db, wallet: string, t = now()) {
  const state = ensureGridWallet(db, wallet, t);
  const pendingGranted = settleGridPending(db, wallet, t);
  const floodReward = settleFloodForWallet(db, wallet, t);
  const deepReward = settleDeepForWallet(db, wallet, t);
  const coopReward = settleDistrictGoalForWallet(db, wallet, t);
  let ladderSettled: { season: number; rows: number } | null = null;
  const endedSeason = db.get<{ id: number }>(`SELECT id FROM seasons WHERE ends_at <= ? ORDER BY id DESC LIMIT 1`, t);
  if (endedSeason) ladderSettled = settleGridLadder(db, endedSeason.id, t);
  const masteredChips = db.scalar(`SELECT COUNT(*) FROM grid_chip_routes r JOIN chips ch ON ch.asset = r.asset WHERE ch.owner = ? AND ch.burned_at IS NULL AND r.next_level > ?`, wallet, GRID.totalLevels);
  const loreMaxCleared = db.scalar(`SELECT COALESCE(MAX(next_level - 1), 0) FROM grid_chip_routes WHERE asset IN (SELECT asset FROM chips WHERE owner = ? AND burned_at IS NULL)`, wallet);
  const lore = gridLoreUnlocked(loreMaxCleared);
  const districtMastery = db.all<{ district: number; stars: number; cleared: number }>(
    `SELECT ch.collection_idx AS district, COALESCE(SUM(c.best_stars), 0) AS stars, COUNT(c.level) AS cleared FROM grid_level_claims c JOIN chips ch ON ch.asset = c.asset WHERE ch.owner = ? AND ch.burned_at IS NULL GROUP BY ch.collection_idx ORDER BY ch.collection_idx`, wallet);
  const chips = db.all<{ asset: string; collection_idx: number; rarity: number; level: number; skin: string | null }>(
    `SELECT asset, collection_idx, rarity, level, skin FROM chips WHERE owner = ? AND burned_at IS NULL ORDER BY collection_idx, rarity, asset`, wallet)
    .map((c) => {
      const r = gridRoute(db, c.asset);
      const claims = db.all<{ level: number; best_stars: number; xp_accounted: number; xp_pending: number; max_xp: number }>(
        `SELECT level, best_stars, xp_accounted, xp_pending, max_xp FROM grid_level_claims WHERE asset = ? ORDER BY level`, c.asset);
      const prestige = db.get<{ prestige_level: number; next_sector: number }>(`SELECT prestige_level, next_sector FROM grid_prestige_routes WHERE asset = ?`, c.asset) ?? { prestige_level: 0, next_sector: 1 };
      return { asset: c.asset, collection: c.collection_idx, rarity: c.rarity, chipLevel: c.level, skin: c.skin, route: r, prestige: { level: prestige.prestige_level, next: prestige.next_sector }, claims };
    });
  const gifts = db.all<{ level: number; kind: string; gift_key: string }>(`SELECT level, kind, gift_key FROM grid_gifts WHERE wallet = ? ORDER BY level`, wallet);
  const week = gridWeek(t);
  const flood = db.all<{ district: number; points: number }>(`SELECT district, points FROM grid_flood WHERE week = ? ORDER BY district`, week);
  const cosmetics = db.all<{ id: number; kind: number; payload: string; signature: string }>(`SELECT id, kind, payload, signature FROM entitlements WHERE wallet = ? AND signature LIKE 'grid:%' ORDER BY id`, wallet)
    .map((r) => ({ id: r.id, kind: r.kind, payload: JSON.parse(r.payload) as Record<string, unknown>, signature: r.signature }));
  const contracts = [0, 1, 2].map((slot) => {
    const c = gridContractAt(t, slot);
    const done = db.get<{ asset: string; stars: number; moves: number }>(`SELECT asset, stars, moves FROM grid_contract_done WHERE wallet = ? AND day = ? AND slot = ?`, wallet, gridDay(t), slot);
    return { ...c, size: generateLevel(c.configLevel, c.seed).size, done: done ?? null };
  });
  const deepWeek = gridWeek(t); const deepFrom = gridWeekStart(deepWeek);
  const deepUsed = db.scalar(`SELECT COUNT(*) FROM grid_attempts WHERE wallet = ? AND mode = 'deep' AND created_at >= ? AND created_at < ?`, wallet, deepFrom, deepFrom + 7 * DAY);
  const deepCredits = db.scalar(`SELECT COUNT(*) FROM grid_deep_credits WHERE wallet = ? AND week = ?`, wallet, deepWeek);
  const deepBoard = db.all<{ wallet: string; moves: number; stars: number }>(`SELECT wallet, moves, stars FROM grid_deep_results WHERE week = ? ORDER BY moves ASC, wallet LIMIT 10`, deepWeek);
  const deepMine = db.get<{ moves: number; stars: number }>(`SELECT moves, stars FROM grid_deep_results WHERE wallet = ? AND week = ?`, wallet, deepWeek);
  const ghostLv = generateLevel(DAILY_CONFIG_LEVEL, gridGhostSeed(gridDay(t)));
  const ghost = { day: gridDay(t), level: DAILY_CONFIG_LEVEL, targetMoves: ghostLv.parMoves, beaten: !!db.get(`SELECT 1 FROM grid_item_grants WHERE wallet = ? AND source = 'ghost_day' AND day = ?`, wallet, gridDay(t)) };
  const fieldThemes = db.all<{ payload: string }>(`SELECT payload FROM entitlements WHERE wallet = ? AND kind = 11 ORDER BY id`, wallet).map((r) => String((JSON.parse(r.payload) as { theme?: string }).theme ?? '')).filter(Boolean);
  const districtGoal = (db.all<{ district: number; points: number }>(`SELECT district, points FROM grid_flood WHERE week = ? ORDER BY district`, week)).map((f) => ({ district: f.district, points: f.points, goal: GRID.districtGoalPoints, reached: f.points >= GRID.districtGoalPoints }));
  const ladderSeason = db.get<{ id: number; starts_at: number; ends_at: number }>(`SELECT id, starts_at, ends_at FROM seasons WHERE starts_at <= ? ORDER BY starts_at DESC LIMIT 1`, t);
  let ladder: unknown = null;
  if (ladderSeason) {
    const pts = gridLadderPoints(db, ladderSeason.starts_at, Math.min(ladderSeason.ends_at, t));
    const sorted = [...pts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    ladder = { season: ladderSeason.id, myPoints: pts.get(wallet) ?? 0, myRank: sorted.findIndex(([w]) => w === wallet) + 1 || null, top: sorted.slice(0, 10).map(([w, n], i) => ({ rank: i + 1, wallet: w, points: n, me: w === wallet })), settled: ladderSettled, myPayout: db.get<{ season: number; rank: number; amount: string; root_kind: number | null }>(`SELECT season, rank, amount, root_kind FROM grid_ladder_payouts WHERE wallet = ? ORDER BY season DESC LIMIT 1`, wallet) ?? null };
  }
  const deep = { week: deepWeek, level: GRID.totalLevels, attemptsUsed: deepUsed, paidCredits: deepCredits, attemptsLeft: Math.max(0, GRID.deepFreeAttemptsPerWeek + deepCredits - deepUsed), paidAttemptsLeft: Math.max(0, GRID.deepPaidAttemptsPerWeek - deepCredits), attemptPriceCgMicro: GRID.deepAttemptCgMicro, myBest: deepMine ?? null, leaderboard: deepBoard.map((r, i) => ({ rank: i + 1, wallet: r.wallet, moves: r.moves, stars: r.stars, me: r.wallet === wallet })) };
  return { wallet: ensureGridWallet(db, wallet, t), pendingGranted, floodReward, deepReward, coopReward, districtGoal, ladder, lore: { unlockedDepths: lore.depths, pages: lore.pages }, masteredChips, districtMastery, cosmetics, contracts, deep, ghost, fieldThemes, daily: { day: gridDay(t), level: gridDailyLevel(t), district: gridFeaturedDistrict(t), sunday: gridIsSunday(t), epic: gridIsSunday(t) }, chips, gifts, floodWeek: week, flood };
}

const ONBOARD_EVENTS = new Set(['shown', 'clicked', 'dismissed']);
/** Onboarding funnel (Home first-sector card): one row per wallet/event/day. */
export function recordGridOnboard(db: Db, wallet: string, event: string, t = now()): { ok: true } {
  if (!ONBOARD_EVENTS.has(event)) throw new ServiceError(422, 'bad_request', 'event must be shown|clicked|dismissed');
  db.run(`INSERT INTO grid_onboard_events (wallet, event, day, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(wallet, event, day) DO NOTHING`, wallet, event, gridDay(t), t);
  return { ok: true };
}

/** Public diver showcase (no auth): depth, stars, mastery and prestige of a wallet's chips. */
export function publicDiver(db: Db, wallet: string) {
  const stars = db.scalar(`SELECT COALESCE(SUM(c.best_stars), 0) FROM grid_level_claims c JOIN chips ch ON ch.asset = c.asset WHERE ch.owner = ? AND ch.burned_at IS NULL`, wallet);
  const deepest = db.scalar(`SELECT COALESCE(MAX(next_level - 1), 0) FROM grid_chip_routes WHERE asset IN (SELECT asset FROM chips WHERE owner = ? AND burned_at IS NULL)`, wallet);
  const mastered = db.scalar(`SELECT COUNT(*) FROM grid_chip_routes r JOIN chips ch ON ch.asset = r.asset WHERE ch.owner = ? AND ch.burned_at IS NULL AND r.next_level > ?`, wallet, GRID.totalLevels);
  const prestigeMax = db.scalar(`SELECT COALESCE(MAX(pr.prestige_level), 0) FROM grid_prestige_routes pr JOIN chips ch ON ch.asset = pr.asset WHERE ch.owner = ? AND ch.burned_at IS NULL`, wallet);
  const ladderBest = db.get<{ season: number; rank: number; amount: string }>(`SELECT season, rank, amount FROM grid_ladder_payouts WHERE wallet = ? ORDER BY rank ASC, season DESC LIMIT 1`, wallet);
  return { wallet, stars, deepest, mastered, prestigeMax, heartOfFlood: mastered > 0, ladderBest: ladderBest ?? null };
}

export function gridChip(db: Db, wallet: string, asset: string, t = now()) {
  const chip = chipOf(db, wallet, asset);
  settleGridPending(db, wallet, t);
  const claims = db.all<{ level: number; best_stars: number; xp_accounted: number; xp_pending: number; max_xp: number }>(
    `SELECT level, best_stars, xp_accounted, xp_pending, max_xp FROM grid_level_claims WHERE asset = ? ORDER BY level`, asset);
  const fails = db.all<{ level: number; fails: number }>(`SELECT level, fails FROM grid_fails WHERE wallet = ? AND asset = ?`, wallet, asset);
  const emergency = db.all<{ level: number }>(`SELECT level FROM grid_emergency WHERE asset = ? AND available > 0`, asset).map((r) => r.level);
  return { asset, collection: chip.collection_idx, rarity: chip.rarity, chipLevel: chip.level, route: gridRoute(db, asset), claims, fails, emergency };
}
