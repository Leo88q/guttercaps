// @vitest-environment node
// Мост «головоломка → гидравлика»: собранный квартал даёт расход на
// приёмники и ноль открытых концов; разобранный — течёт в никуда.
import { describe, expect, it } from 'vitest';
import { E, N, S, W, type Level, type Tile } from '@guttercaps/economy';
import { FLUIDS, PipeNetwork } from './pipeSolver';
import { networkFromLevel, openEnds, solveLevel } from './gutterNetwork';

const tile = (base: number, rot = 0): Tile => ({
  kind: 'straight', base, rot, fixed: false, role: 'line',
});

/** Кольцо 2×2: шина в 0, приёмник в 3, все порты замкнуты друг на друга. */
const ring = (rot0 = 0): Level => ({
  level: 1, seed: 0, size: 2, bus: 0, receivers: [3], solutionRot: [0, 0, 0, 0], parMoves: 4,
  tiles: [tile(E | S, rot0), tile(W | S), tile(N | E), tile(W | N)],
});

describe('networkFromLevel — головоломка Grid в решателе труб', () => {
  it('собранное кольцо: 4 трубы, приёмник получает воду, открытых концов нет', () => {
    const level = ring();
    const def = networkFromLevel(level);
    expect(def.links.length).toBe(4);
    expect(openEnds(level)).toBe(0);
    const net = new PipeNetwork(def, FLUIDS.water20);
    net.solve();
    expect(net.lastConverged).toBe(true);
    expect(net.nodeStates.get('c3')?.outflow ?? 0).toBeGreaterThan(0);
  });

  it('повёрнутый фрагмент у шины: появляются открытые концы', () => {
    const broken = ring(1); // у шины порты уехали с востока/юга на юг/запад
    expect(openEnds(broken)).toBeGreaterThan(0);
    const def = networkFromLevel(broken);
    expect(def.links.length).toBeLessThan(4);
  });

  it('solveLevel для доски: в собранном кольце вода есть и не течёт, в сломанном — течёт', () => {
    const good = solveLevel(ring());
    expect(good.totalFlow).toBeGreaterThan(0);
    expect(good.fed).toBe(1);
    expect(good.speed[3]).toBeGreaterThan(0);
    expect(good.leaking.some(Boolean)).toBe(false);
    const bad = solveLevel(ring(1));
    expect(bad.leaking.some(Boolean)).toBe(true);
  });
});
