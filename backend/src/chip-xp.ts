// Chip XP: play Cap Slam (ranked or wager) with a cap in the squad → XP → auto level-up.
// Same trust model as ratings / pass XP (indexer-authoritative). On-chain
// `claim.level` stays at mint 1 until a merkle level_up caller ships with chip_core.
import { CHIP_XP, GRID, applyChipXp, applyChipXpDelta, profile, type RarityIndex } from '@guttercaps/economy';
import { type Db } from './db.ts';
import { insertIgnore, upsert } from './sql.ts';
import { deviceLimited } from './human.ts';
import { walletFlags } from './antifraud.ts';

const LEDGER_UPSERT = upsert('chip_xp_ledger', ['asset', 'day', 'xp'], ['asset', 'day'], ['xp = chip_xp_ledger.xp + excluded.xp']);
const POOL_UPSERT = upsert(
  'chip_xp',
  ['asset', 'xp', 'lifetime'],
  ['asset'],
  ['xp = excluded.xp', 'lifetime = chip_xp.lifetime + excluded.lifetime'],
);

const AWARD_INSERT = insertIgnore('chip_xp_awards', ['match_id', 'asset', 'xp', 'from_level', 'to_level']);


/** Floodgrid loss shield (docs/13 §0.3): a charge droplet on the chip pays an arena loss instead of −6 XP.
 *  SQL is inline here because grid.ts already imports this module (no import cycle). */
function consumeChargeDropInline(db: Db, asset: string): boolean {
  const r = db.get<{ charge_drops: number }>(`SELECT charge_drops FROM grid_chip_routes WHERE asset = ?`, asset);
  if (!r || r.charge_drops <= 0) return false;
  db.run(`UPDATE grid_chip_routes SET charge_drops = charge_drops - 1 WHERE asset = ? AND charge_drops > 0`, asset);
  return true;
}
/** First ranked win of the day grants a hint (Метка Клеммы), max 3/week (docs/13 §0.4). */
function grantArenaWinHint(db: Db, wallet: string, t: number): void {
  const day = Math.floor(t / 86_400);
  const today = db.get<{ amount: number }>(`SELECT amount FROM grid_item_grants WHERE wallet = ? AND source = 'arena_win' AND day = ?`, wallet, day)?.amount ?? 0;
  if (today >= 1) return;
  const week = db.scalar(`SELECT COALESCE(SUM(amount), 0) FROM grid_item_grants WHERE wallet = ? AND source = 'arena_win' AND day > ?`, wallet, day - 7);
  if (week >= 3) return;
  db.run(`INSERT INTO grid_wallet_state (wallet, hints, valves, starter_granted, total_best_stars, updated_at) VALUES (?, ?, 0, 1, 0, ?) ON CONFLICT(wallet) DO NOTHING`, wallet, GRID.hintStartStock, t);
  const hints = db.get<{ hints: number }>(`SELECT hints FROM grid_wallet_state WHERE wallet = ?`, wallet)?.hints ?? 0;
  if (hints >= GRID.hintStockCap) return;
  db.run(`UPDATE grid_wallet_state SET hints = hints + 1, updated_at = ? WHERE wallet = ?`, t, wallet);
  db.run(`INSERT INTO grid_item_grants (wallet, source, day, amount) VALUES (?, 'arena_win', ?, 1) ON CONFLICT(wallet, source, day) DO UPDATE SET amount = amount + 1`, wallet, day);
}

export type ChipXpCredit = { granted: number; fromLevel: number; toLevel: number };

export function grantSquadXp(db: Db, squadJson: string, won: boolean, t: number, wallet: string, matchId?: string): void {
  if (!wallet || wallet.startsWith('bot:')) return;
  if (walletFlags(db, wallet).rewardsPaused) return;
  if (deviceLimited(db, wallet)) return;
  let squad: unknown;
  try { squad = JSON.parse(squadJson); } catch { return; }
  if (!Array.isArray(squad)) return;
  const amount = won ? CHIP_XP.win : CHIP_XP.loss;
  if (won) grantArenaWinHint(db, wallet, t);
  const day = Math.floor(t / 86_400);
  for (const c of squad) {
    const asset = (c as { asset?: unknown } | null)?.asset;
    if (typeof asset !== 'string' || !asset || asset.startsWith('bot:')) continue;
    if (matchId && db.get(`SELECT 1 FROM chip_xp_awards WHERE match_id = ? AND asset = ?`, matchId, asset)) continue;
    if (!won && consumeChargeDropInline(db, asset)) continue; // droplet paid the loss: no XP cut, no award row
    const r = creditChipXp(db, asset, amount, day);
    db.run(`UPDATE chips SET last_played = ? WHERE asset = ? AND (last_played IS NULL OR last_played < ?)`, t, asset, t);
    if (matchId && r.granted > 0) {
      db.run(AWARD_INSERT, matchId, asset, r.granted, r.fromLevel, r.toLevel);
    }
  }
}

export function matchXpForSquad(db: Db, matchId: string, squadJson: string): { xp: number; leveled: number } {
  let squad: unknown;
  try { squad = JSON.parse(squadJson); } catch { return { xp: 0, leveled: 0 }; }
  if (!Array.isArray(squad)) return { xp: 0, leveled: 0 };
  let xp = 0, leveled = 0;
  for (const c of squad) {
    const asset = (c as { asset?: unknown } | null)?.asset;
    if (typeof asset !== 'string') continue;
    const a = db.get<{ xp: number; from_level: number; to_level: number }>(`SELECT xp, from_level, to_level FROM chip_xp_awards WHERE match_id = ? AND asset = ?`, matchId, asset);
    if (!a) continue;
    xp += a.xp;
    if (a.to_level > a.from_level) leveled += 1;
  }
  return { xp, leveled };
}

/**
 * Apply one XP event to a chip.
 *  - gains (win +10, XP tickets): capped by CHIP_XP.dailyCap per UTC day unless
 *    `bypassDailyCap` (perk tickets — PACK_PERKS);
 *  - losses (−6): demote level by level but NEVER below the chip's checkpoint
 *    (every CHIP_XP.checkpointEvery levels, floor 1); the damage that would fall
 *    under a checkpoint evaporates (economy v3 design). Losses are not capped.
 */
export function creditChipXp(db: Db, asset: string, amount: number, day: number, opts: { bypassDailyCap?: boolean } = {}): ChipXpCredit {
  const chip = db.get<{ level: number; rarity: number; burned_at: number | null }>(`SELECT level, rarity, burned_at FROM chips WHERE asset = ?`, asset);
  const fromLevel = chip?.level ?? 1;
  if (amount === 0 || !chip || chip.burned_at != null) return { granted: 0, fromLevel, toLevel: fromLevel };
  const maxLevel = profile(chip.rarity as RarityIndex).maxLevel;
  const unspent = db.get<{ xp: number }>(`SELECT xp FROM chip_xp WHERE asset = ?`, asset)?.xp ?? 0;
  if (amount < 0) {
    const next = applyChipXpDelta(chip.level, unspent, amount, maxLevel);
    db.run(POOL_UPSERT, asset, next.xp, 0);
    if (next.level !== chip.level) {
      // Ranked power only. `compressed_claims.level` is the on-chain mint (always 1 until merkle
      // level_up) — writing XP into it made wager resolve compare lv 2+ against mint-1 power.
      db.run(`UPDATE chips SET level = ? WHERE asset = ? AND burned_at IS NULL`, next.level, asset);
    }
    return { granted: 0, fromLevel, toLevel: next.level };
  }
  let grant = amount;
  if (!opts.bypassDailyCap) {
    const today = db.get<{ xp: number }>(`SELECT xp FROM chip_xp_ledger WHERE asset = ? AND day = ?`, asset, day)?.xp ?? 0;
    const room = CHIP_XP.dailyCap - today;
    if (room <= 0) return { granted: 0, fromLevel, toLevel: fromLevel };
    grant = Math.min(amount, room);
    db.run(LEDGER_UPSERT, asset, day, grant);
  }
  const next = applyChipXp(chip.level, unspent + grant, maxLevel);
  db.run(POOL_UPSERT, asset, next.xp, grant);
  if (next.level > chip.level) {
    db.run(`UPDATE chips SET level = ? WHERE asset = ? AND burned_at IS NULL AND level < ?`, next.level, asset, next.level);
  }
  return { granted: grant, fromLevel, toLevel: next.level };
}
