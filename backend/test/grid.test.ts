import { describe, expect, it } from 'vitest';
import { generateLevel, levelSeed, orbitSize } from '@guttercaps/economy';
import { Db } from '../src/db.ts';
import { startGridAttempt, completeGridAttempt, failGridAttempt, gridMe, gridGhostSeed, gridDay } from '../src/grid.ts';
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

describe('floodgrid daily pass, sunday flood and cosmetic gifts', () => {
  it('daily flood solve grants Pass XP once per day', async () => {
    const { startGridAttempt, completeGridAttempt, gridDay, gridDailyLevel } = await import('../src/grid.ts');
    const { dailySeed } = await import('@guttercaps/economy');
    const db = new Db(':memory:');
    const owner = kp(); const asset = mint(db, owner);
    db.run(`INSERT INTO seasons (id, starts_at, ends_at, server_secret, server_secret_hash) VALUES (1, ?, ?, 'aa', 'bb')`, T - 100, T + 100_000);
    const lv = gridDailyLevel(T);
    const turns = (() => {
      const level = generateLevel(lv, dailySeed(gridDay(T)));
      const out: [number, number][] = [];
      level.tiles.forEach((tile, i) => {
        if (tile.fixed) return;
        const period = orbitSize(tile.base);
        const fwd = ((level.solutionRot[i] - tile.rot) % period + period) % period;
        const back = period - fwd;
        if (fwd === 0) return;
        if (fwd <= back) for (let k = 0; k < fwd; k++) out.push([i, 1]); else for (let k = 0; k < back; k++) out.push([i, -1]);
      });
      return out;
    })();
    const a = startGridAttempt(db, owner, { asset, level: lv, mode: 'training', daily: true }, T);
    const r = completeGridAttempt(db, owner, { attemptId: a.attemptId, turns }, T);
    expect(r.ok).toBe(true);
    if (r.training) expect(r.passXp).toBe(30);
    expect(db.scalar(`SELECT xp FROM pass_xp WHERE wallet = ?`, owner)).toBe(30);
  });

  it('sunday district chips gain double droplet progress', async () => {
    const { startGridAttempt, completeGridAttempt, gridRoute } = await import('../src/grid.ts');
    const db = new Db(':memory:');
    const owner = kp(); const asset = mint(db, owner);
    const sunday = 24 * 86_400 + 3600; // day 24: Sunday, Drain district 0
    db.run(`INSERT INTO grid_chip_routes (asset, next_level, charge_drops, charge_progress, updated_at) VALUES (?, 1, 0, 4, ?)`, asset, sunday);
    const a = startGridAttempt(db, owner, { asset, level: 1 }, sunday);
    const r = completeGridAttempt(db, owner, { attemptId: a.attemptId, turns: solutionTurns(1) }, sunday);
    expect(r.ok).toBe(true);
    expect(gridRoute(db, asset).chargeDrops).toBe(1); // 4 + x2 progress crosses the 5-sector streak
  });

  it('depth-50 skin gift becomes an entitlement and paints the diving chip', async () => {
    const { startGridAttempt, completeGridAttempt, applyGridSkin } = await import('../src/grid.ts');
    const db = new Db(':memory:');
    const owner = kp(); const asset = mint(db, owner);
    for (let l = 1; l < 50; l++) db.run(`INSERT INTO grid_level_claims (asset, level, best_stars, xp_accounted, xp_pending, max_xp, completed_at, updated_at) VALUES (?, ?, 3, 10, 0, 10, ?, ?)`, asset, l, T, T);
    db.run(`INSERT INTO grid_chip_routes (asset, next_level, charge_drops, charge_progress, updated_at) VALUES (?, 50, 0, 0, ?)`, asset, T);
    const a = startGridAttempt(db, owner, { asset, level: 50 }, T);
    const r = completeGridAttempt(db, owner, { attemptId: a.attemptId, turns: solutionTurns(50) }, T);
    expect(r.ok).toBe(true);
    const ent = db.get<{ kind: number; payload: string }>(`SELECT kind, payload FROM entitlements WHERE wallet = ? AND signature = 'grid:gift:50:skin:wet-rim'`, owner);
    expect(ent?.kind).toBe(2);
    expect(JSON.parse(ent!.payload).skin).toBe('wet-rim');
    applyGridSkin(db, owner, { asset, skin: 'wet-rim' }, T);
    expect(db.get<{ skin: string }>(`SELECT skin FROM chips WHERE asset = ?`, asset)?.skin).toBe('wet-rim');
  });
});

describe('floodgrid phase 3 (contracts, deep flood, ghost)', () => {
  const solFor = (level: number, seed: number): [number, number][] => {
    const lv = generateLevel(level, seed);
    const turns: [number, number][] = [];
    lv.tiles.forEach((tile, i) => {
      if (tile.fixed) return;
      const period = orbitSize(tile.base);
      const fwd = (((lv.solutionRot[i] - tile.rot) % period) + period) % period;
      const back = period - fwd;
      if (fwd === 0) return;
      if (fwd <= back) for (let k = 0; k < fwd; k++) turns.push([i, 1]);
      else for (let k = 0; k < back; k++) turns.push([i, -1]);
    });
    return turns;
  };

  it('district contract requires a mastered conductor of the district and pays quest progress + droplet progress, no XP', async () => {
    const { gridContractAt } = await import('../src/grid.ts');
    const db = new Db(':memory:');
    const owner = kp(); const asset = mint(db, owner); // district 0
    // not mastered yet -> locked
    expect(() => startGridAttempt(db, owner, { asset, kind: 'contract', slot: 0 }, T)).toThrow(/contracts open after/);
    db.run(`INSERT INTO grid_chip_routes (asset, next_level, charge_drops, charge_progress, updated_at) VALUES (?, 76, 0, 4, ?)`, asset, T);
    const c = gridContractAt(T, 0);
    const a = startGridAttempt(db, owner, { asset, kind: 'contract', slot: 0 }, T) as unknown as { attemptId: string; level: number };
    const r = completeGridAttempt(db, owner, { attemptId: a.attemptId, turns: solFor(c.configLevel, c.seed) }, T);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.xpGranted).toBe(0); expect(r.dropletGained).toBe(true); }
    expect(db.scalar(`SELECT COUNT(*) FROM grid_completions WHERE wallet = ? AND kind = 'contract'`, owner)).toBe(1);
    expect(db.scalar(`SELECT charge_drops FROM grid_chip_routes WHERE asset = ?`, asset)).toBe(1);
    const me = gridMe(db, owner, T) as unknown as { contracts: { done: unknown }[] };
    expect(me.contracts[0].done).not.toBeNull();
  });

  it('ghost of the day: beating par clean pays one hint once a day', () => {
    const db = new Db(':memory:');
    const owner = kp(); const asset = mint(db, owner);
    const a = startGridAttempt(db, owner, { asset, kind: 'ghost' }, T) as unknown as { attemptId: string; level: number };
    const r = completeGridAttempt(db, owner, { attemptId: a.attemptId, turns: solFor(33, gridGhostSeed(gridDay(T))) }, T);
    expect(r.ok).toBe(true);
    if (r.ok && 'beaten' in r) { expect(r.beaten).toBe(true); expect(r.hintGranted).toBe(1); }
    const a2 = startGridAttempt(db, owner, { asset, kind: 'ghost' }, T) as unknown as { attemptId: string };
    const r2 = completeGridAttempt(db, owner, { attemptId: a2.attemptId, turns: solFor(33, gridGhostSeed(gridDay(T))) }, T);
    if (r2.ok && 'hintGranted' in r2) expect(r2.hintGranted).toBe(0);
  });

  it('deep flood: one free weekly attempt, extra attempt is a 30 CG burn credit, best run ranks and settles gear next week', async () => {
    const grid = await import('../src/grid.ts');
    const { serviceRefHash, toHex } = await import('../src/services.ts');
    const db = new Db(':memory:');
    const owner = 'So11111111111111111111111111111111111111112'; const asset = mint(db, owner);
    const week = grid.gridWeek(T);
    const a = startGridAttempt(db, owner, { asset, kind: 'deep' }, T) as unknown as { attemptId: string };
    const r = completeGridAttempt(db, owner, { attemptId: a.attemptId, turns: solFor(75, grid.gridDeepSeed(week)) }, T);
    expect(r.ok).toBe(true);
    if (r.ok && 'rank' in r) expect(r.rank).toBe(1);
    expect(() => startGridAttempt(db, owner, { asset, kind: 'deep' }, T)).toThrow(/attempts left/);
    const sig = 'deepsig'.padEnd(80, 'x');
    const ref = toHex(serviceRefHash(10, owner, { id: 'gridDeepAttempt', week }));
    db.run(`INSERT INTO service_payments (signature, event_index, buyer, kind, currency, amount, burned, ref_hash, block_time, slot, consumed_by) VALUES (?, 0, ?, 10, 2, '30000000', '30000000', ?, ?, 1, NULL)`, sig, owner, ref, T);
    db.run(`INSERT INTO events_raw (signature, ix_index, event_index, program, name, data, slot, finalized_at) VALUES (?, 0, 0, 'services', 'ServicePaid', '{}', 1, ?)`, sig, T);
    expect(grid.buyGridDeepAttempt(db, owner, sig, T).credits).toBe(1);
    const a2 = startGridAttempt(db, owner, { asset, kind: 'deep' }, T) as unknown as { attemptId: string };
    expect(a2.attemptId).toBeTruthy();
    const me = gridMe(db, owner, T + 7 * 86_400) as unknown as { deepReward: { rank: number; hints: number } | null };
    expect(me.deepReward?.rank).toBe(1);
    expect(me.deepReward?.hints).toBeGreaterThanOrEqual(1);
  });
});
