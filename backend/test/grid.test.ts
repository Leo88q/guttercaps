import { describe, expect, it } from 'vitest';
import { generateLevel, levelSeed, orbitSize } from '@guttercaps/economy';
import { Db } from '../src/db.ts';
import { startGridAttempt, completeGridAttempt, failGridAttempt, gridMe } from '../src/grid.ts';
import { creditChipXp } from '../src/chip-xp.ts';

const kp = () => {
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let s = '';
  while (s.length < 44) s += B58[Math.floor(Math.random() * B58.length)];
  return s;
};
function mint(db: Db, owner: string, asset = kp()) {
  db.run(`INSERT INTO chips (asset, owner, collection_idx, rarity, level, flags, lock_until, origin, minted_at, burned_at, updated_slot)
          VALUES (?, ?, 0, 0, 1, 0, 0, 'pack', 1, NULL, 0)`, asset, owner);
  return asset;
}
/** Shortest turn list taking a generated level to its solution (moves == par). */
function solutionTurns(level: number): [number, number][] {
  const lv = generateLevel(level, levelSeed(level));
  const turns: [number, number][] = [];
  lv.tiles.forEach((tile, i) => {
    if (tile.fixed) return;
    const period = orbitSize(tile.base);
    const fwd = ((lv.solutionRot[i] - tile.rot) % period + period) % period;
    const back = period - fwd;
    if (fwd === 0) return;
    if (fwd <= back) for (let k = 0; k < fwd; k++) turns.push([i, 1]);
    else for (let k = 0; k < back; k++) turns.push([i, -1]);
  });
  return turns;
}
const T = 20_000 * 86_400;

describe('floodgrid backend', () => {
  it('verifies an honest proof, grants 3-star XP and advances the route', () => {
    const db = new Db(':memory:');
    const owner = kp(); const asset = mint(db, owner);
    const a = startGridAttempt(db, owner, { asset, level: 1 }, T);
    const r = completeGridAttempt(db, owner, { attemptId: a.attemptId, turns: solutionTurns(1) }, T);
    expect(r.ok).toBe(true);
    if (r.ok && !r.training) {
      expect(r.stars).toBe(3);
      expect(r.xpGranted).toBe(6);
      expect(r.route?.nextLevel).toBe(2);
    } else throw new Error('expected settled solve');
    expect(db.scalar(`SELECT level FROM chips WHERE asset = ?`, asset)).toBe(1); // 6 XP < cost(1)=10
  });

  it('rejects skipping sectors for a chip route', () => {
    const db = new Db(':memory:');
    const owner = kp(); const asset = mint(db, owner);
    expect(() => startGridAttempt(db, owner, { asset, level: 2 }, T)).toThrow(/cannot be skipped/);
  });

  it('an unsolved proof settles as a fail (−6 path, fail counted)', () => {
    const db = new Db(':memory:');
    const owner = kp(); const asset = mint(db, owner);
    creditChipXp(db, asset, 100, 20_000);
    const a = startGridAttempt(db, owner, { asset, level: 1 }, T);
    const r = completeGridAttempt(db, owner, { attemptId: a.attemptId, turns: [[0, 1]] }, T);
    expect(r.ok).toBe(false);
    expect(db.scalar(`SELECT fails FROM grid_fails WHERE wallet = ? AND asset = ? AND level = 1`, owner, asset)).toBe(1);
  });

  it('hint caps the attempt at 2 stars and spends the item', () => {
    const db = new Db(':memory:');
    const owner = kp(); const asset = mint(db, owner);
    const a1 = startGridAttempt(db, owner, { asset, level: 1 }, T);
    completeGridAttempt(db, owner, { attemptId: a1.attemptId, turns: solutionTurns(1) }, T);
    const a2 = startGridAttempt(db, owner, { asset, level: 2, hintsUsed: 1 }, T);
    const r = completeGridAttempt(db, owner, { attemptId: a2.attemptId, turns: solutionTurns(2) }, T);
    expect(r.ok).toBe(true);
    if (r.ok && !r.training) { expect(r.stars).toBe(2); expect(r.xpGranted).toBe(5); } // floor(8*0.7)
    expect(gridMe(db, owner, T).wallet.hints).toBe(4);
  });

  it('XP over the daily cap is parked as pending and paid next day', () => {
    const db = new Db(':memory:');
    const owner = kp(); const asset = mint(db, owner);
    creditChipXp(db, asset, 200, 20_000);
    const a = startGridAttempt(db, owner, { asset, level: 1 }, T);
    const r = completeGridAttempt(db, owner, { attemptId: a.attemptId, turns: solutionTurns(1) }, T);
    expect(r.ok).toBe(true);
    if (r.ok && !r.training) { expect(r.xpGranted).toBe(0); expect(r.xpPending).toBe(6); }
    const me = gridMe(db, owner, T + 86_400);
    expect(me.pendingGranted).toBe(6);
  });

  it('three fails grant a sector emergency hint; fail endpoint settles once', () => {
    const db = new Db(':memory:');
    const owner = kp(); const asset = mint(db, owner);
    for (let i = 0; i < 3; i++) {
      const a = startGridAttempt(db, owner, { asset, level: 1 }, T);
      failGridAttempt(db, owner, { attemptId: a.attemptId }, T);
    }
    expect(db.scalar(`SELECT available FROM grid_emergency WHERE asset = ? AND level = 1`, asset)).toBe(1);
    expect(() => failGridAttempt(db, owner, { attemptId: 'nope' }, T)).toThrow(/Unknown grid attempt/);
  });
});

describe('floodgrid training, fusion and flood night', () => {
  it('training opens any sector without route progress or penalty', async () => {
    const { startGridAttempt, completeGridAttempt } = await import('../src/grid.ts');
    const db = new Db(':memory:');
    const owner = kp(); const asset = mint(db, owner);
    const a = startGridAttempt(db, owner, { asset, level: 40, mode: 'training' }, T);
    expect(a.board.tiles.length).toBeGreaterThan(0);
    const r = completeGridAttempt(db, owner, { attemptId: a.attemptId, turns: solutionTurns(40) }, T);
    expect(r.ok).toBe(true);
    expect(db.get(`SELECT 1 FROM grid_level_claims WHERE asset = ?`, asset)).toBeUndefined();
  });

  it('fusion result inherits the union route and droplets', async () => {
    const { mergeFusionRoutes, gridChip } = await import('../src/grid.ts');
    const db = new Db(':memory:');
    const owner = kp(); const m1 = mint(db, owner); const m2 = mint(db, owner); const res = mint(db, owner);
    const a1 = startGridAttempt(db, owner, { asset: m1, level: 1 }, T);
    completeGridAttempt(db, owner, { attemptId: a1.attemptId, turns: solutionTurns(1) }, T);
    const a2 = startGridAttempt(db, owner, { asset: m2, level: 1 }, T);
    completeGridAttempt(db, owner, { attemptId: a2.attemptId, turns: solutionTurns(1) }, T);
    mergeFusionRoutes(db, res, [m1, m2], T);
    expect(gridChip(db, owner, res, T).route.nextLevel).toBe(2);
  });

  it('flood night pays the winning district diver in gear, once', async () => {
    const { gridMe } = await import('../src/grid.ts');
    const db = new Db(':memory:');
    const owner = kp(); const asset = mint(db, owner);
    const a = startGridAttempt(db, owner, { asset, level: 1 }, T);
    completeGridAttempt(db, owner, { attemptId: a.attemptId, turns: solutionTurns(1) }, T);
    const nextWeek = T + 8 * 86_400;
    const me1 = gridMe(db, owner, nextWeek);
    expect(me1.floodReward?.hints).toBeGreaterThan(0);
    const me2 = gridMe(db, owner, nextWeek);
    expect(me2.floodReward).toBeNull();
  });
});
