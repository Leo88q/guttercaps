// Art-layer contracts for the Floodgrid sprite board (docs/14a):
// material per depth mirrors GRID_DEPTHS, sprite pics sit in canonical masks, and the flow
// wave distance is a pure BFS from the bus — presentation must never disagree with the engine.
import { describe, expect, it } from 'vitest';
import { GRID, GRID_DEPTHS, generateLevel, isSolved, levelSeed, orbitSize, poweredCells, rotateMask, tileMask } from '@guttercaps/economy';
import { canonicalRotOf, flowDistance, gridAtlasUrl, gridBoardBgUrl, gridMaterialForLevel, gridStripBgUrl, shapeIndexOf } from './gridArt';

describe('floodgrid art mapping (docs/14a)', () => {
  it('material of a level equals GRID_DEPTHS material of its depth', () => {
    const cases: [number, string][] = [
      [1, 'glass'], [15, 'glass'], [16, 'chrome'], [30, 'chrome'], [31, 'rust'], [45, 'rust'],
      [46, 'cast'], [60, 'cast'], [61, 'glass'], [75, 'glass'],
    ];
    for (const [level, material] of cases) expect(gridMaterialForLevel(level)).toBe(material);
    expect(GRID_DEPTHS).toHaveLength(GRID.depths);
  });

  it('shape sprites cover every mask used by all 75 sectors', () => {
    const kinds = new Set<number>();
    for (let l = 1; l <= GRID.totalLevels; l++) {
      const lv = generateLevel(l, levelSeed(l));
      for (const tile of lv.tiles) kinds.add(shapeIndexOf(rotateMask(tile.base, tile.rot)));
    }
    // stub|straight|elbow|tee|cross = 0..4, иначе у какой-то клетки нет спрайта
    expect([...kinds].sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it('canonical rotation maps every reachable mask back onto its sprite', () => {
    for (const canon of [1, 3, 5, 7, 15]) {
      for (let r = 0; r < 4; r++) {
        const mask = rotateMask(canon, r);
        expect(rotateMask(canon, canonicalRotOf(mask)) & 0xf).toBe(mask);
      }
    }
  });

  it('urls stay in the committed art bundle', () => {
    expect(gridAtlasUrl('glass')).toBe('/art/grid/tiles-glass.webp');
    expect(gridBoardBgUrl(4)).toBe('/art/grid/bg-depth-4.webp');
    expect(gridStripBgUrl(2)).toBe('/art/grid/strip-depth-2.webp');
  });

  it('flow distance is BFS from the bus: powered cells are reachable, bus is 0', () => {
    for (const l of [1, 5, 25, 40, 61, 75]) {
      const lv = generateLevel(l, levelSeed(l));
      const flow = flowDistance(lv);
      expect(flow).toHaveLength(lv.size * lv.size);
      expect(flow[lv.bus]).toBe(0);
      const powered = poweredCells(lv);
      for (let i = 0; i < powered.length; i++) {
        if (powered[i]) expect(flow[i]).toBeGreaterThanOrEqual(0);
        else expect(flow[i]).toBe(-1);
      }
      expect(isSolved(lv)).toBe(false); // уровень стартует несобранным — волна не обязана достигать всех
    }
  });

  it('fixed tiles keep zero rotation drift: cross masks never animate visually', () => {
    const lv = generateLevel(40, levelSeed(40));
    for (const tile of lv.tiles) {
      if (tileMask(lv, lv.tiles.indexOf(tile)) === 15) expect(canonicalRotOf(15)).toBe(0);
    }
    expect(orbitSize(15)).toBe(1);
  });
});
