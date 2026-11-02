// Reproducer: the emergency mark ("Аварийная метка") is a gear item earned from quests, the season
// pass, the arena, fusion and star milestones (client/src/features/guide/copy.ts:38), and
// GRID.emergencyHintAfterFails = 3 reads as "you get help after three failures on a sector"
// (packages/economy/src/grid.ts:29). settleFail (backend/src/grid.ts:315-320) instead re-grants one
// every time the counter is >= 3 and the previous one has been used — so from the third failure on,
// *every* failure hands out a free mark, and the counter is never reset. Five failures on one sector
// therefore yield four marks, not one.
import { describe, expect, it } from 'vitest';
import { Db } from '../src/db.ts';
import { startGridAttempt, failGridAttempt } from '../src/grid.ts';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const kp = () => { let s = ''; while (s.length < 44) s += B58[Math.floor(Math.random() * B58.length)]; return s; };
const T = 20_000 * 86_400;

describe('floodgrid emergency marks', () => {
  it('marks are granted once per threshold, not once per failure past it', () => {
    const db = new Db(':memory:');
    const owner = kp();
    const asset = kp();
    db.run(`INSERT INTO chips (asset, owner, collection_idx, rarity, level, flags, lock_until, origin, minted_at, burned_at, updated_slot)
            VALUES (?, ?, 0, 0, 1, 0, 0, 'pack', 1, NULL, 0)`, asset, owner);

    const grants: number[] = [];
    for (let i = 1; i <= 5; i++) {
      // consume whatever is available first, like a player would
      const before = db.get<{ available: number }>(`SELECT available FROM grid_emergency WHERE asset = ? AND level = 1`, asset)?.available ?? 0;
      const a = startGridAttempt(db, owner, { asset, level: 1, ...(before > 0 ? { useEmergency: true } : {}) }, T);
      const r = failGridAttempt(db, owner, { attemptId: a.attemptId }, T) as { emergencyGranted?: boolean };
      const after = db.get<{ available: number }>(`SELECT available FROM grid_emergency WHERE asset = ? AND level = 1`, asset)?.available ?? 0;
      if (r.emergencyGranted) grants.push(i);
      console.log(JSON.stringify({ fail: i, usedBefore: before, granted: !!r.emergencyGranted, availableAfter: after }));
    }
    // with emergencyHintAfterFails = 3 the expected schedule is one mark at the 3rd failure
    expect(grants).toEqual([3]);
  });
});
