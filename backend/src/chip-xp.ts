// Ranked chip XP: play Cap Slam with a cap in the squad → XP → auto level-up.
// Same trust model as ratings / pass XP (server-authoritative ranked). On-chain
// `claim.level` stays at mint 1 until a merkle level_up caller ships with chip_core.
import { CHIP_XP, applyChipXp, profile, type RarityIndex } from '@guttercaps/economy';
import { type Db } from './db.ts';
import { upsert } from './sql.ts';
import { deviceLimited } from './human.ts';
import { walletFlags } from './antifraud.ts';

const LEDGER_UPSERT = upsert('chip_xp_ledger', ['asset', 'day', 'xp'], ['asset', 'day'], ['xp = chip_xp_ledger.xp + excluded.xp']);
const POOL_UPSERT = upsert(
  'chip_xp',
  ['asset', 'xp', 'lifetime'],
  ['asset'],
  ['xp = excluded.xp', 'lifetime = chip_xp.lifetime + excluded.lifetime'],
);

export function grantSquadXp(db: Db, squadJson: string, won: boolean, t: number, wallet: string): void {
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
    creditChipXp(db, asset, amount, day);
  }
}

export function creditChipXp(db: Db, asset: string, amount: number, day: number): void {
  if (amount <= 0) return;
  const chip = db.get<{ level: number; rarity: number; burned_at: number | null }>(`SELECT level, rarity, burned_at FROM chips WHERE asset = ?`, asset);
  if (!chip || chip.burned_at != null) return;
  const today = db.get<{ xp: number }>(`SELECT xp FROM chip_xp_ledger WHERE asset = ? AND day = ?`, asset, day)?.xp ?? 0;
  const room = CHIP_XP.dailyCap - today;
  if (room <= 0) return;
  const grant = Math.min(amount, room);
  db.run(LEDGER_UPSERT, asset, day, grant);
  const unspent = db.get<{ xp: number }>(`SELECT xp FROM chip_xp WHERE asset = ?`, asset)?.xp ?? 0;
  const next = applyChipXp(chip.level, unspent + grant, profile(chip.rarity as RarityIndex).maxLevel);
  db.run(POOL_UPSERT, asset, next.xp, grant);
  if (next.level > chip.level) {
    db.run(`UPDATE chips SET level = ? WHERE asset = ? AND burned_at IS NULL AND level < ?`, next.level, asset, next.level);
    db.run(`UPDATE compressed_claims SET level = ? WHERE asset = ? AND level < ?`, next.level, asset, next.level);
  }
}
