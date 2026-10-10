// Chip XP: play Cap Slam (ranked or wager) with a cap in the squad → XP → auto level-up.
// Same trust model as ratings / pass XP (indexer-authoritative). On-chain
// `claim.level` stays at mint 1 until a merkle level_up caller ships with chip_core.
import { CHIP_XP, applyChipXp, profile, type RarityIndex } from '@guttercaps/economy';
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

export type ChipXpCredit = { granted: number; fromLevel: number; toLevel: number };

export function grantSquadXp(db: Db, squadJson: string, won: boolean, t: number, wallet: string, matchId?: string): void {
  if (!wallet || wallet.startsWith('bot:')) return;
  if (walletFlags(db, wallet).rewardsPaused) return;
  if (deviceLimited(db, wallet)) return;
  let squad: unknown;
  try { squad = JSON.parse(squadJson); } catch { return; }
  if (!Array.isArray(squad)) return;
  const amount = won ? CHIP_XP.win : CHIP_XP.loss;
  const day = Math.floor(t / 86_400);
  for (const c of squad) {
    const asset = (c as { asset?: unknown } | null)?.asset;
    if (typeof asset !== 'string' || !asset || asset.startsWith('bot:')) continue;
    if (matchId && db.get(`SELECT 1 FROM chip_xp_awards WHERE match_id = ? AND asset = ?`, matchId, asset)) continue;
    const r = creditChipXp(db, asset, amount, day);
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

export function creditChipXp(db: Db, asset: string, amount: number, day: number): ChipXpCredit {
  const chip = db.get<{ level: number; rarity: number; burned_at: number | null }>(`SELECT level, rarity, burned_at FROM chips WHERE asset = ?`, asset);
  const fromLevel = chip?.level ?? 1;
  if (amount <= 0 || !chip || chip.burned_at != null) return { granted: 0, fromLevel, toLevel: fromLevel };
  const today = db.get<{ xp: number }>(`SELECT xp FROM chip_xp_ledger WHERE asset = ? AND day = ?`, asset, day)?.xp ?? 0;
  const room = CHIP_XP.dailyCap - today;
  if (room <= 0) return { granted: 0, fromLevel, toLevel: fromLevel };
  const grant = Math.min(amount, room);
  db.run(LEDGER_UPSERT, asset, day, grant);
  const unspent = db.get<{ xp: number }>(`SELECT xp FROM chip_xp WHERE asset = ?`, asset)?.xp ?? 0;
  const next = applyChipXp(chip.level, unspent + grant, profile(chip.rarity as RarityIndex).maxLevel);
  db.run(POOL_UPSERT, asset, next.xp, grant);
  if (next.level > chip.level) {
    // Ranked power only. `compressed_claims.level` is the on-chain mint (always 1 until merkle
    // level_up) — writing XP into it made wager resolve compare lv 2+ against mint-1 power.
    db.run(`UPDATE chips SET level = ? WHERE asset = ? AND burned_at IS NULL AND level < ?`, next.level, asset, next.level);
  }
  return { granted: grant, fromLevel, toLevel: next.level };
}
