// Limited-pack purchase perks (economy v3 — PACK_PERKS in packages/economy/src/packs.ts).
// With Legend/Legend+/Diamond dropping from no pack, the event SKU sells access + grind
// acceleration instead of top-tier EV:
//   * 1 fusion booster per day (first Limited purchase of the day) — delivered through the
//     EXISTING quest item-root pipeline: a synthetic `quest_completions` row (quest_id
//     'perk_limited_booster', amount 0, reward_booster 1) rides buildItemBatch →
//     publish_item_root → claim_item_root → chip_core grant_booster. Nothing new on-chain.
//   * up to 2 XP tickets per day (+PACK_PERKS.xpTicketXp XP each), redeemed by the wallet on a
//     chip of its choice (POST /me/pack-perks/xp-ticket) ABOVE the daily XP cap. Day-scoped:
//     unspent tickets expire at midnight UTC — no stockpiling, no trading (soulbound perks).
// Grants are driven by the indexed PackBought event (finality follows the projections), one row
// per (wallet, UTC day) — replays are idempotent.
import { PACK_PERKS, PACKS } from '@guttercaps/economy';
import { type Db, now } from './db.ts';
import { insertIgnore } from './sql.ts';
import { ServiceError } from './services.ts';
import { creditChipXp } from './chip-xp.ts';
import { grantHintFromSource } from './grid.ts';

export const PERK_BOOSTER_QUEST_ID = 'perk_limited_booster';
const LIMITED_SKU = ['starter', 'standard', 'premium', 'limited'].indexOf(PACK_PERKS.packId);
const DAY = 86_400;

/** Called from the PackBought projection. Idempotent per (wallet, day). */
export function grantPackPerks(db: Db, buyer: string, sku: number, t = now()): void {
  // Floodgrid hint perk (docs/13 §0.4): Premium (2) and Limited (3) carry one Метка Клеммы, cap 1/day.
  if ((sku === 2 || sku === LIMITED_SKU) && buyer && !buyer.startsWith('bot:')) grantHintFromSource(db, buyer, 'pack', t, { daily: 1, weekly: 7 });
  if (sku !== LIMITED_SKU || !buyer || buyer.startsWith('bot:')) return;
  const day = Math.floor(t / DAY);
  const row = db.get<{ b: number; tk: number }>(`SELECT boosters_granted AS b, tickets_granted AS tk FROM pack_perks WHERE wallet = ? AND day = ?`, buyer, day);
  const addBooster = (row?.b ?? 0) < PACK_PERKS.boosterPerDay;
  const addTicket = (row?.tk ?? 0) < PACK_PERKS.xpTicketPerDay;
  if (!addBooster && !addTicket) return;
  db.run(
    `INSERT INTO pack_perks (wallet, day, boosters_granted, tickets_granted, tickets_used) VALUES (?, ?, ?, ?, 0)
     ON CONFLICT(wallet, day) DO UPDATE SET boosters_granted = excluded.boosters_granted, tickets_granted = excluded.tickets_granted`,
    buyer, day, (row?.b ?? 0) + (addBooster ? 1 : 0), (row?.tk ?? 0) + (addTicket ? 1 : 0),
  );
  if (addBooster) {
    // UNIQUE (wallet, quest_id, period_key) makes the synthetic completion 1/day by construction.
    db.run(
      insertIgnore('quest_completions', ['wallet', 'quest_id', 'period_key', 'amount', 'reward_booster', 'completed_at', 'day']),
      buyer, PERK_BOOSTER_QUEST_ID, `d${day}`, '0', 1, t, day,
    );
  }
}

export interface PackPerksView { day: number; boosters: number; tickets: number; ticketsLeft: number; ticketXp: number }

export function packPerksView(db: Db, wallet: string, t = now()): PackPerksView {
  const day = Math.floor(t / DAY);
  const row = db.get<{ b: number; g: number; u: number }>(`SELECT boosters_granted AS b, tickets_granted AS g, tickets_used AS u FROM pack_perks WHERE wallet = ? AND day = ?`, wallet, day);
  return { day, boosters: row?.b ?? 0, tickets: row?.g ?? 0, ticketsLeft: Math.max(0, (row?.g ?? 0) - (row?.u ?? 0)), ticketXp: PACK_PERKS.xpTicketXp };
}

/** Redeem one XP ticket on a chip this wallet owns. Same UTC day only. */
export function redeemXpTicket(db: Db, wallet: string, asset: string, t = now()): { asset: string; xp: number; fromLevel: number; toLevel: number } {
  if (!asset) throw new ServiceError(400, 'missing_asset', 'asset is required');
  const day = Math.floor(t / DAY);
  const row = db.get<{ g: number; u: number }>(`SELECT tickets_granted AS g, tickets_used AS u FROM pack_perks WHERE wallet = ? AND day = ?`, wallet, day);
  if (!row || row.u >= row.g) throw new ServiceError(409, 'no_ticket', 'No unused XP ticket today (tickets come with Limited pack purchases and expire at midnight UTC)');
  const chip = db.get<{ asset: string }>(`SELECT asset FROM chips WHERE asset = ? AND owner = ? AND burned_at IS NULL`, asset, wallet);
  if (!chip) throw new ServiceError(404, 'chip_not_found', 'No live chip with that asset owned by this wallet');
  db.run(`UPDATE pack_perks SET tickets_used = tickets_used + 1 WHERE wallet = ? AND day = ? AND tickets_used < tickets_granted`, wallet, day);
  const r = db.get<{ u: number }>(`SELECT tickets_used AS u FROM pack_perks WHERE wallet = ? AND day = ?`, wallet, day);
  if ((r?.u ?? 0) < (row.u + 1)) throw new ServiceError(409, 'no_ticket', 'Ticket already spent');
  const credit = creditChipXp(db, asset, PACK_PERKS.xpTicketXp, day, { bypassDailyCap: true });
  return { asset, xp: credit.granted, fromLevel: credit.fromLevel, toLevel: credit.toLevel };
}
