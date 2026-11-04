// Репродукция находки 44 (и её регрессия после исправления): слоты контрактов Floodgrid были захардкожены
// тройкой `[0, 1, 2]` в двух местах, хотя количество контрактов задаёт конфигурация `GRID.contractsPerDay`.
//
//   backend/src/grid.ts  доска `gridMe` рисовала `[0, 1, 2]`
//   backend/src/grid.ts  закрытие попытки искало слот среди `[0, 1, 2]` — при `contractsPerDay > 3` четвёртый
//                        контракт принимался стартом (`slot < contractsPerDay`), но никогда не попадал в доску
//                        и не находился при закрытии, то есть не отмечался выполненным и не давал прогресса
//
// Теперь оба места берут `GRID_CONTRACT_SLOTS`, выведенный из конфигурации. Тест держит и функциональную
// сторону (доска = конфигурация, последний слот проходится целиком), и статическую: литерала в коде нет.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GRID, generateLevel, levelSeed, orbitSize } from '@guttercaps/economy';
import { Db } from '../src/db.ts';
import { GRID_CONTRACT_SLOTS, completeGridAttempt, gridContractAt, gridDay, gridMe, startGridAttempt } from '../src/grid.ts';

const kp = () => {
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let s = '';
  while (s.length < 44) s += B58[Math.floor(Math.random() * B58.length)];
  return s;
};
const T = 20_000 * 86_400;

/** Кратчайший список поворотов, приводящий сгенерированный сектор к решению. */
function solutionTurns(level: number, seed?: number): [number, number][] {
  const lv = generateLevel(level, seed ?? levelSeed(level));
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

describe('находка 44: слоты контрактов берутся из конфигурации, а не из литерала', () => {
  it('список слотов совпадает с GRID.contractsPerDay, литерала в коде нет', () => {
    expect(GRID_CONTRACT_SLOTS).toEqual(Array.from({ length: GRID.contractsPerDay }, (_, i) => i));
    const src = readFileSync(path.resolve(process.cwd(), 'src/grid.ts'), 'utf8');
    expect(src).not.toContain('[0, 1, 2]');
    expect(src).toContain('GRID_CONTRACT_SLOTS');
  });

  it('доска отдаёт ровно столько контрактов, сколько заявлено в конфигурации', () => {
    const db = new Db(':memory:');
    const wallet = kp();
    const board = gridMe(db, wallet, T).contracts;
    expect(board.map((c) => c.slot)).toEqual([...GRID_CONTRACT_SLOTS]);
    for (const c of board) {
      const expected = gridContractAt(T, c.slot);
      expect({ district: c.district, depth: c.depth, configLevel: c.configLevel }).toEqual({
        district: expected.district, depth: expected.depth, configLevel: expected.configLevel,
      });
    }
  });

  it('последний слот (не только 0..2) открывается и закрывается как выполненный', () => {
    const db = new Db(':memory:');
    const wallet = kp();
    const asset = kp();
    const lastSlot = GRID_CONTRACT_SLOTS.at(-1)!;
    const contract = gridContractAt(T, lastSlot);
    // проводник этого района, уже прошедший весь спуск (75/75) — иначе контракт закрыт
    db.run(`INSERT INTO chips (asset, owner, collection_idx, rarity, level, flags, lock_until, origin, minted_at, burned_at, updated_slot)
            VALUES (?, ?, ?, 0, ?, 0, 0, 'pack', 1, NULL, 0)`, asset, wallet, contract.district, GRID.totalLevels);
    db.run(`INSERT INTO grid_chip_routes (asset, next_level, charge_drops, charge_progress, updated_at) VALUES (?, ?, 0, 0, ?)`, asset, GRID.totalLevels + 1, T);

    const started = startGridAttempt(db, wallet, { asset, kind: 'contract', slot: lastSlot }, T) as { attemptId: string; contract: { slot: number } };
    expect(started.contract.slot).toBe(lastSlot);
    // тот же слот второй раз не открыть: seed задаёт (день, слот) — значит и обратный поиск слота однозначен
    expect(() => startGridAttempt(db, wallet, { asset, kind: 'contract', slot: lastSlot }, T + 1)).toThrow(/already in progress/);
    // слот за границей конфигурации по-прежнему отвергается
    expect(() => startGridAttempt(db, wallet, { asset, kind: 'contract', slot: GRID.contractsPerDay }, T + 2)).toThrow(/slot 0\.\./);

    const done = completeGridAttempt(db, wallet, { attemptId: started.attemptId, turns: solutionTurns(contract.configLevel, contract.seed) }, T + 10);
    expect(done.ok).toBe(true);
    // ключевая регрессия: закрытая попытка нашла СВОЙ слот в доске (раньше поиск ограничивался 0..2)
    expect(db.get(`SELECT slot FROM grid_contract_done WHERE wallet = ? AND day = ? AND slot = ?`, wallet, gridDay(T + 10), lastSlot)).toBeTruthy();
    expect(gridMe(db, wallet, T + 10).contracts.find((c) => c.slot === lastSlot)!.done).toBeTruthy();
  });
});
