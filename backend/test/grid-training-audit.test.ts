import { describe, expect, it } from 'vitest';
import { Db } from '../src/db.ts';
import { startGridAttempt } from '../src/grid.ts';
import { metricValue } from '../src/quests.ts';

const kp = () => {
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let s = '';
  while (s.length < 44) s += B58[Math.floor(Math.random() * B58.length)];
  return s;
};
const T = 20_000 * 86_400;

describe('quest metric grid_training', () => {
  it('ten abandoned training starts count as ten training dives', () => {
    const db = new Db(':memory:');
    const owner = kp();
    const asset = kp();
    db.run(`INSERT INTO chips (asset, owner, collection_idx, rarity, level, flags, lock_until, origin, minted_at, burned_at, updated_slot)
            VALUES (?, ?, 0, 0, 1, 0, 0, 'pack', 1, NULL, 0)`, asset, owner);
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(startGridAttempt(db, owner, { asset, level: 1 + i, mode: 'training' }, T + i).attemptId);
    const v = metricValue(db, owner, 'grid_training', T - 86_400, T + 10, T + 10);
    const settled = db.scalar(`SELECT COUNT(*) FROM grid_attempts WHERE settled = 1`);
    const solved = db.scalar(`SELECT COUNT(*) FROM grid_level_claims`);
    console.log(JSON.stringify({ questProgress: v, attemptsSettled: settled, levelsSolved: solved }));
    expect(v).toBe(10);          // weekly quest w_train10 (target 10, reward: valve) is satisfied
    expect(settled).toBe(0);     // not one of them was finished
    expect(solved).toBe(0);      // no level was ever solved
  });
});
