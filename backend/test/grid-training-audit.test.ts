// Репродукция находки 43 (и её регрессия после исправления): квест «десять тренировочных спусков»
// (w_train10, награда — вентиль) считался по СТАРТАМ, а не по пройденным спускам.
//
//   backend/src/quests.ts  `SELECT COUNT(*) FROM grid_attempts WHERE mode = 'training' …` — каждая строка
//                          старта, независимо от того, чем заход кончился
//   backend/src/grid.ts    попытка закрывается с `settled = 1` и при провале, и при сдаче, и при
//                          превращении в тренировку подсказками, но «пройдено» нигде не отмечалось
//
// Достаточно было десять раз открыть тренировку (даже не ходя) — недельный квест закрывался, награда
// выдавалась за пустые заходы. Теперь попытка помнит `solved`, и метрика считает только `settled = 1 AND
// solved = 1`: пройденные спуски.
import { describe, expect, it } from 'vitest';
import { generateLevel, levelSeed, orbitSize } from '@guttercaps/economy';
import { Db } from '../src/db.ts';
import { startGridAttempt, completeGridAttempt, failGridAttempt } from '../src/grid.ts';
import { metricValue } from '../src/quests.ts';

const kp = () => {
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let s = '';
  while (s.length < 44) s += B58[Math.floor(Math.random() * B58.length)];
  return s;
};
const T = 20_000 * 86_400;

/** Кратчайший список поворотов, приводящий сгенерированный сектор к решению. */
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

function seedChip(db: Db) {
  const owner = kp();
  const asset = kp();
  db.run(`INSERT INTO chips (asset, owner, collection_idx, rarity, level, flags, lock_until, origin, minted_at, burned_at, updated_slot)
          VALUES (?, ?, 0, 0, 1, 0, 0, 'pack', 1, NULL, 0)`, asset, owner);
  return { owner, asset };
}

describe('находка 43: квест считает пройденные спуски, а не открытые попытки', () => {
  it('десять брошенных тренировок не закрывают недельный квест', () => {
    const db = new Db(':memory:');
    const { owner, asset } = seedChip(db);
    for (let i = 0; i < 10; i++) startGridAttempt(db, owner, { asset, level: 1 + i, mode: 'training' }, T + i);
    expect(metricValue(db, owner, 'grid_training', T - 86_400, T + 10, T + 10)).toBe(0);
    // даже если все заходы закрыты «сдался» — это не пройденные спуски
    for (const row of db.all<{ id: string }>(`SELECT id FROM grid_attempts WHERE wallet = ?`, owner)) {
      failGridAttempt(db, owner, { attemptId: row.id }, T + 20);
    }
    expect(metricValue(db, owner, 'grid_training', T - 86_400, T + 30, T + 30)).toBe(0);
    expect(db.scalar(`SELECT COUNT(*) FROM grid_attempts WHERE wallet = ? AND settled = 1`, owner)).toBe(10);
  });

  it('пройденный спуск считается, проваленный и превращённый в тренировку — нет', () => {
    const db = new Db(':memory:');
    const { owner, asset } = seedChip(db);
    // 1) пройденный
    const ok = startGridAttempt(db, owner, { asset, level: 1, mode: 'training' }, T);
    expect(completeGridAttempt(db, owner, { attemptId: ok.attemptId, turns: solutionTurns(1) }, T + 1).ok).toBe(true);
    // 2) проваленный: не решение, а один бессмысленный поворот
    const bad = startGridAttempt(db, owner, { asset, level: 2, mode: 'training' }, T + 2);
    completeGridAttempt(db, owner, { attemptId: bad.attemptId, turns: [[0, 1]] }, T + 3);
    // 3) сданный досрочно
    const quit = startGridAttempt(db, owner, { asset, level: 3, mode: 'training' }, T + 4);
    failGridAttempt(db, owner, { attemptId: quit.attemptId }, T + 5);
    expect(metricValue(db, owner, 'grid_training', T, T + 10, T + 10)).toBe(1);
    expect(db.scalar(`SELECT COUNT(*) FROM grid_attempts WHERE wallet = ? AND solved = 1`, owner)).toBe(1);
    // счётчик совпадает с числом пройденных попыток и не зависит от числа открытых
    expect(db.scalar(`SELECT COUNT(*) FROM grid_attempts WHERE wallet = ?`, owner)).toBe(3);
  });
});
