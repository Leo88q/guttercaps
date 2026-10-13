// Floodgrid («Решётка») backend: server-verified sectors (PlayProof replay), chip routes,
// star-XP accounting, charge droplets, gear items and account gifts (docs/13).
// Trust model mirrors chip XP / arena: the server replays every turn with the SAME
// deterministic engine the client runs (@guttercaps/economy gridEngine), so a claimed
// solution is proven, not believed. XP credits go through creditChipXp (daily cap 200,
// checkpoints on losses); uncredited remainder is kept as xp_pending, never burned.
import { randomUUID } from 'node:crypto';
import {
  GRID, GRID_GIFTS, DAILY_CONFIG_LEVEL, dailySeed, depthOfLevel, generateLevel, levelSeed, applyRotate, isSolved,
  gridBaseXp, gridStarsForMoves, gridXpForStars, QUEST_CHIP_TEMPLATES,
} from '@guttercaps/economy';
import { type Db, now } from './db.ts';
import { creditChipXp } from './chip-xp.ts';
import { ServiceError } from './services.ts';

const DAY = 86_400;
export const gridDay = (t: number) => Math.floor(t / DAY);
export const gridWeek = (t: number) => Math.floor((t - 4 * DAY) / (7 * DAY));

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

export interface GridAttemptInput { asset?: unknown; level?: unknown; hintsUsed?: unknown; useEmergency?: unknown; mode?: unknown; daily?: unknown }

export function startGridAttempt(db: Db, wallet: string, body: GridAttemptInput, t = now()) {
  const asset = typeof body.asset === 'string' ? body.asset : '';
  const level = typeof body.level === 'number' ? Math.floor(body.level) : NaN;
  const hintsUsed = body.hintsUsed === undefined ? 0 : Math.floor(Number(body.hintsUsed));
  if (!asset || !Number.isFinite(level) || level < 1 || level > GRID.totalLevels) throw new ServiceError(422, 'bad_request', 'asset and level 1..75 are required');
  if (!Number.isFinite(hintsUsed) || hintsUsed < 0 || hintsUsed > GRID.hintMaxPerChargeAttempt) throw new ServiceError(422, 'bad_request', `hintsUsed must be 0..${GRID.hintMaxPerChargeAttempt} for a charge attempt`);
  chipOf(db, wallet, asset);
  ensureGridWallet(db, wallet, t);
  settleGridPending(db, wallet, t);
  const route = gridRoute(db, asset);
  const training = body.mode === 'training';
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
  db.run(`INSERT INTO grid_attempts (id, wallet, asset, level, hints_used, emergency_used, mode, seed, settled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`, id, wallet, asset, level, training ? 0 : hintsUsed, emergencyUsed, training ? 'training' : 'charge', seed, t);
  const lv = generateLevel(level, seed);
  return {
    attemptId: id, level, par: lv.parMoves, moveBudget: lv.parMoves * GRID.moveBudgetMult, route,
    // Public board layout (never the solution): the client renders exactly this and replays turns locally.
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
  if (attempt.mode === 'training') {
    db.run(`UPDATE grid_attempts SET settled = 1, settled_at = ? WHERE id = ?`, t, attempt.id);
    return { ok: isSolved(lv), training: true as const, stars: 0, xpGranted: 0, xpPending: 0, moves, par: lv.parMoves };
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
  if (crossedToCharged || (firstCompletion && stars >= 2)) {
    chargeProgress += 1;
    if (chargeProgress >= GRID.chargePerSectorStreak && chargeDrops < GRID.chargeMax) { chargeDrops += 1; chargeProgress -= GRID.chargePerSectorStreak; dropletGained = true; }
  } else if (!firstCompletion) {
    const today = gridDay(t);
    const r = db.get<{ charge_day: number; charge_refills: number }>(`SELECT charge_day, charge_refills FROM grid_chip_routes WHERE asset = ?`, attempt.asset);
    if (moves <= Math.ceil(lv.parMoves * 1.5) && (r?.charge_day !== today || (r?.charge_refills ?? 0) < GRID.chargeRefillPerDay) && chargeDrops < GRID.chargeMax) {
      chargeDrops += 1; dropletGained = true;
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
    for (const m of GRID.starMilestones) if (prev < m.stars && totalStars >= m.stars) { grantGridHints(db, wallet, m.hints, t); if (m.valves) grantGridValve(db, wallet, t); }
  }
  db.run(`UPDATE grid_attempts SET settled = 1, settled_at = ? WHERE id = ?`, t, attempt.id);
  return {
    ok: true as const, training: false, level: attempt.level, moves, par: lv.parMoves, stars, hintsUsed: totalHints,
    xpGranted: credit.granted, xpPending: pendingAdd, fromLevel: credit.fromLevel, toLevel: credit.toLevel,
    dropletGained, gifts, route: gridRoute(db, attempt.asset), wallet: ensureGridWallet(db, wallet, t),
  };
}

export function failGridAttempt(db: Db, wallet: string, body: GridCompleteInput, t = now()) {
  const attemptId = typeof body.attemptId === 'string' ? body.attemptId : '';
  const attempt = db.get<{ id: string; wallet: string; asset: string; level: number; hints_used: number; settled: number }>(`SELECT * FROM grid_attempts WHERE id = ?`, attemptId);
  if (!attempt || attempt.wallet !== wallet) throw new ServiceError(404, 'attempt_not_found', 'Unknown grid attempt');
  if (attempt.settled) throw new ServiceError(409, 'attempt_settled', 'Attempt already settled');
  chipOf(db, wallet, attempt.asset);
  if ((attempt as { mode?: string }).mode === 'training') {
    db.run(`UPDATE grid_attempts SET settled = 1, settled_at = ? WHERE id = ?`, t, attempt.id);
    return { ok: false as const, training: true, xpLoss: 0, valveUsed: false };
  }
  return settleFail(db, wallet, attempt as never, t, body.useValve === true);
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

export function gridMe(db: Db, wallet: string, t = now()) {
  const state = ensureGridWallet(db, wallet, t);
  const pendingGranted = settleGridPending(db, wallet, t);
  const floodReward = settleFloodForWallet(db, wallet, t);
  const masteredChips = db.scalar(`SELECT COUNT(*) FROM grid_chip_routes r JOIN chips ch ON ch.asset = r.asset WHERE ch.owner = ? AND ch.burned_at IS NULL AND r.next_level > ?`, wallet, GRID.totalLevels);
  const districtMastery = db.all<{ district: number; stars: number; cleared: number }>(
    `SELECT ch.collection_idx AS district, COALESCE(SUM(c.best_stars), 0) AS stars, COUNT(c.level) AS cleared FROM grid_level_claims c JOIN chips ch ON ch.asset = c.asset WHERE ch.owner = ? AND ch.burned_at IS NULL GROUP BY ch.collection_idx ORDER BY ch.collection_idx`, wallet);
  const chips = db.all<{ asset: string; collection_idx: number; rarity: number; level: number }>(
    `SELECT asset, collection_idx, rarity, level FROM chips WHERE owner = ? AND burned_at IS NULL ORDER BY collection_idx, rarity, asset`, wallet)
    .map((c) => {
      const r = gridRoute(db, c.asset);
      const claims = db.all<{ level: number; best_stars: number; xp_accounted: number; xp_pending: number; max_xp: number }>(
        `SELECT level, best_stars, xp_accounted, xp_pending, max_xp FROM grid_level_claims WHERE asset = ? ORDER BY level`, c.asset);
      return { asset: c.asset, collection: c.collection_idx, rarity: c.rarity, chipLevel: c.level, route: r, claims };
    });
  const gifts = db.all<{ level: number; kind: string; gift_key: string }>(`SELECT level, kind, gift_key FROM grid_gifts WHERE wallet = ? ORDER BY level`, wallet);
  const week = gridWeek(t);
  const flood = db.all<{ district: number; points: number }>(`SELECT district, points FROM grid_flood WHERE week = ? ORDER BY district`, week);
  return { wallet: ensureGridWallet(db, wallet, t), pendingGranted, floodReward, masteredChips, districtMastery, daily: { day: gridDay(t), level: DAILY_CONFIG_LEVEL }, chips, gifts, floodWeek: week, flood };
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
