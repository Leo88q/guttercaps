import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GRID, gridBaseXp, gridRouteTotalXp, gridStarsForMoves, gridXpForStars, gridChargeStakeMult,
  generateLevel, applySolution, isSolved, parMoves, hint, levelSeed,
} from '../src/index.ts';

describe('floodgrid economy (approved values)', () => {
  it('base XP formula and route total', () => {
    assert.equal(gridBaseXp(1), 6);
    assert.equal(gridBaseXp(75), 154);
    assert.equal(gridRouteTotalXp(), 6000);
  });
  it('star multipliers 100/70/40 and fail -6', () => {
    assert.equal(gridXpForStars(50, 3), 104);
    assert.equal(gridXpForStars(50, 2), 72);
    assert.equal(gridXpForStars(50, 1), 41);
    assert.equal(gridXpForStars(50, 0), -6);
    assert.equal(gridXpForStars(1, 1), 2);
  });
  it('stars from moves vs par and 2x budget', () => {
    assert.equal(gridStarsForMoves(20, 20), 3);
    assert.equal(gridStarsForMoves(30, 20), 2);
    assert.equal(gridStarsForMoves(40, 20), 1);
    assert.equal(gridStarsForMoves(41, 20), 0);
  });
  it('charge stake multiplier capped at +15%', () => {
    assert.equal(gridChargeStakeMult(0), 1);
    assert.equal(gridChargeStakeMult(3), 1.15);
    assert.equal(gridChargeStakeMult(9), 1.15);
  });
});

describe('floodgrid engine (all 75 levels)', () => {
  it('every campaign level: solution solves, start does not, par matches', () => {
    for (let n = 1; n <= GRID.totalLevels; n++) {
      const lv = generateLevel(n, levelSeed(n));
      assert.equal(isSolved(lv), false, `level ${n} starts solved`);
      const par = parMoves(lv);
      assert.equal(par, lv.parMoves, `level ${n} par mismatch`);
      assert.ok(par > 0, `level ${n} par`);
      applySolution(lv);
      assert.equal(isSolved(lv), true, `level ${n} solution does not solve`);
    }
  });
  it('hint leads a level to solution', () => {
    const lv = generateLevel(7, levelSeed(7));
    for (let guard = 0; guard < 500 && !isSolved(lv); guard++) {
      const h = hint(lv);
      assert.ok(h, 'hint missing');
      lv.tiles[h!.index].rot = h!.rot;
    }
    assert.equal(isSolved(lv), true);
  });
});
