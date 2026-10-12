import { describe, it, expect, beforeEach } from 'vitest';
import { Db } from '../src/db.ts';
import { ingestTx } from '../src/ingest.ts';
import { tx, kp } from './fixtures.ts';
import { grantPackPerks, packPerksView, redeemXpTicket } from '../src/pack-perks.ts';
import { creditChipXp } from '../src/chip-xp.ts';
import { PACK_PERKS } from '@guttercaps/economy';

const LIMITED_SKU = 3;
const T = 1_800_000_000;

function mintChip(db: Db, owner: string, asset: string, rarity = 2): string {
  db.run(`INSERT INTO chips (asset, owner, collection_idx, rarity, level, flags, lock_until, origin, updated_slot) VALUES (?, ?, 1, ?, 1, 0, 0, 'pack', 1)`, asset, owner, rarity);
  db.run(`INSERT INTO chip_xp (asset, xp, lifetime) VALUES (?, 0, 0)`, asset);
  return asset;
}

describe('Limited-pack purchase perks', () => {
  let db: Db; let w: string;
  beforeEach(() => { db = new Db(':memory:'); w = kp(); });

  it('grants 1 booster + 2 XP tickets per UTC day, idempotent across replays', () => {
    ingestTx(tx([{ program: 'chip_core', name: 'PackBought', data: { buyer: w, sku: LIMITED_SKU, qty: 1, currency: 0, amount: '33000000', nonce: '1', randomness: kp() } }], { blockTime: T }), db);
    expect(packPerksView(db, w, T)).toMatchObject({ boosters: 1, tickets: 1, ticketsLeft: 1, ticketXp: PACK_PERKS.xpTicketXp });
    ingestTx(tx([{ program: 'chip_core', name: 'PackBought', data: { buyer: w, sku: LIMITED_SKU, qty: 1, currency: 0, amount: '33000000', nonce: '2', randomness: kp() } }], { blockTime: T + 60 }), db);
    expect(packPerksView(db, w, T)).toMatchObject({ boosters: 1, tickets: 2, ticketsLeft: 2 });
    // third purchase: caps hold
    ingestTx(tx([{ program: 'chip_core', name: 'PackBought', data: { buyer: w, sku: LIMITED_SKU, qty: 1, currency: 0, amount: '33000000', nonce: '3', randomness: kp() } }], { blockTime: T + 120 }), db);
    expect(packPerksView(db, w, T)).toMatchObject({ boosters: 1, tickets: 2, ticketsLeft: 2 });
    // the booster rides the item-root pipeline as a synthetic completion, exactly one per day
    const boosters = db.all(`SELECT quest_id, period_key, reward_booster FROM quest_completions WHERE wallet = ?`, w);
    expect(boosters).toEqual([{ quest_id: 'perk_limited_booster', period_key: `d${Math.floor(T / 86_400)}`, reward_booster: 1 }]);
    // non-limited SKUs grant nothing
    const other = kp();
    grantPackPerks(db, other, 1, T);
    expect(packPerksView(db, other, T)).toMatchObject({ boosters: 0, tickets: 0 });
  });

  it('redeems a ticket above the daily XP cap; tickets run out with a 409', () => {
    grantPackPerks(db, w, LIMITED_SKU, T);
    grantPackPerks(db, w, LIMITED_SKU, T + 60);
    const asset = mintChip(db, w, kp());
    // saturate the daily cap through the normal path first
    const day = Math.floor(T / 86_400);
    for (let i = 0; i < 25; i++) creditChipXp(db, asset, 10, day); // 250 offered → capped at 200
    const r = redeemXpTicket(db, w, asset, T);
    expect(r.xp).toBe(PACK_PERKS.xpTicketXp);
    // lvl 1 cap: 200 + 100 = 300 XP spent against 10+20+30+...; level must reflect the bypass
    const chip = db.get<{ level: number }>(`SELECT level FROM chips WHERE asset = ?`, asset)!;
    expect(chip.level).toBeGreaterThan(1);
    expect(packPerksView(db, w, T).ticketsLeft).toBe(1);
    redeemXpTicket(db, w, asset, T);
    expect(() => redeemXpTicket(db, w, asset, T)).toThrowError(/No unused XP ticket/);
    // not your chip → 404
    const stranger = kp();
    grantPackPerks(db, stranger, LIMITED_SKU, T);
    expect(() => redeemXpTicket(db, stranger, asset, T)).toThrowError(/No live chip/);
  });
});
