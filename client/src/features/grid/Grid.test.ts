import { describe, expect, it } from 'vitest';
import { generateLevel, levelSeed, orbitSize } from '@guttercaps/economy';
import { mockRequest } from '@/api/mock';

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

describe('floodgrid mock e2e (first chip path)', () => {
  it('attempt → solution proof → XP and route advance; future sector only in training', async () => {
    const me = (await mockRequest('get', '/grid/me', {})) as { chips: { asset: string; route: { nextLevel: number } }[] };
    const chip = me.chips[0];
    expect(chip.route.nextLevel).toBe(1);
    await expect(mockRequest('post', '/grid/attempt', { body: { asset: chip.asset, level: 2, mode: 'charge' } })).rejects.toMatchObject({ status: 409 });
    const a = (await mockRequest('post', '/grid/attempt', { body: { asset: chip.asset, level: 1, mode: 'charge' } })) as { attemptId: string; board: { tiles: unknown[] } };
    expect(a.board.tiles.length).toBeGreaterThan(0);
    const r = (await mockRequest('post', '/grid/complete', { body: { attemptId: a.attemptId, turns: solutionTurns(1) } })) as { ok: boolean; stars: number; xpGranted: number };
    expect(r).toMatchObject({ ok: true, stars: 3, xpGranted: 6 });
    const after = (await mockRequest('get', '/grid/me', {})) as { chips: { asset: string; route: { nextLevel: number } }[] };
    expect(after.chips.find((c) => c.asset === chip.asset)?.route.nextLevel).toBe(2);
    const tr = (await mockRequest('post', '/grid/attempt', { body: { asset: chip.asset, level: 50, mode: 'training' } })) as { attemptId: string };
    const trr = (await mockRequest('post', '/grid/complete', { body: { attemptId: tr.attemptId, turns: solutionTurns(50) } })) as { ok: boolean; training: boolean; xpGranted: number };
    expect(trr).toMatchObject({ ok: true, training: true, xpGranted: 0 });
  });
});
