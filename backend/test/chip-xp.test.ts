import { describe, expect, it } from 'vitest';
import { CHIP_XP, applyChipXp } from '@guttercaps/economy';
import { Db } from '../src/db.ts';
import { creditChipXp, grantSquadXp } from '../src/chip-xp.ts';

const kp = () => {
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let s = '';
  while (s.length < 44) s += B58[Math.floor(Math.random() * B58.length)];
  return s;
};

function mint(db: Db, owner: string, rarity = 0, asset = kp()) {
  db.run(
    `INSERT INTO chips (asset, owner, collection_idx, rarity, level, flags, lock_until, origin, minted_at, burned_at, updated_slot)
     VALUES (?, ?, 0, ?, 1, 0, 0, 'pack', 1, NULL, 0)`,
    asset, owner, rarity,
  );
  return asset;
}

describe('ranked chip XP', () => {
  it('credits a squad, spends at the cost curve, and stops at the rarity cap', () => {
    const db = new Db(':memory:');
    const owner = kp();
    const a = mint(db, owner, 0);
    grantSquadXp(db, JSON.stringify([{ asset: a }]), true, 1_800_000_000, owner);
    // cost(1) = 10 = one win, so the first win promotes immediately
    expect(db.get<{ xp: number; lifetime: number }>(`SELECT xp, lifetime FROM chip_xp WHERE asset = ?`, a)).toEqual({ xp: 0, lifetime: CHIP_XP.win });
    expect(db.scalar(`SELECT level FROM chips WHERE asset = ?`, a)).toBe(2);

    creditChipXp(db, a, CHIP_XP.win, 1);
    expect(db.scalar(`SELECT level FROM chips WHERE asset = ?`, a)).toBe(2);
    expect(db.get<{ xp: number }>(`SELECT xp FROM chip_xp WHERE asset = ?`, a)!.xp).toBe(CHIP_XP.win);

    for (let d = 2; d < 40; d++) creditChipXp(db, a, CHIP_XP.dailyCap, d);
    expect(db.scalar(`SELECT level FROM chips WHERE asset = ?`, a)).toBe(12);
    expect(applyChipXp(1, 660, 12).level).toBe(12);
  });

  it('respects the per-cap daily cap and ignores bots / burned chips', () => {
    const db = new Db(':memory:');
    const owner = kp();
    const a = mint(db, owner, 0);
    creditChipXp(db, a, CHIP_XP.dailyCap, 42);
    creditChipXp(db, a, CHIP_XP.win, 42);
    expect(db.get<{ lifetime: number }>(`SELECT lifetime FROM chip_xp WHERE asset = ?`, a)!.lifetime).toBe(CHIP_XP.dailyCap);

    grantSquadXp(db, JSON.stringify([{ asset: a }]), true, 1_800_000_000, 'bot:x');
    expect(db.get<{ lifetime: number }>(`SELECT lifetime FROM chip_xp WHERE asset = ?`, a)!.lifetime).toBe(CHIP_XP.dailyCap);

    const dead = mint(db, owner, 0);
    db.run(`UPDATE chips SET burned_at = 1 WHERE asset = ?`, dead);
    creditChipXp(db, dead, CHIP_XP.win, 0);
    expect(db.get(`SELECT 1 FROM chip_xp WHERE asset = ?`, dead)).toBeUndefined();
  });
});
