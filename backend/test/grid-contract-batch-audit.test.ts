// Регрессия находки 39: контракт района можно было открыть пачкой и получить многократный прогресс.
//
// Старт контракта проверял только `grid_contract_done` (то есть «уже СДАН»), а сдача вставляла строку
// сдачи со `ON CONFLICT DO NOTHING` уже ПОСЛЕ выдачи наград:
//
//   backend/src/grid.ts  `SELECT 1 FROM grid_contract_done …` — только при старте
//   backend/src/grid.ts  `INSERT INTO grid_contract_done … ON CONFLICT DO NOTHING` — после saveRoute
//   backend/src/grid.ts  `INSERT INTO grid_completions … 'contract'` — безусловно
//
// Поэтому, открыв две (или десять) попыток одного слота до первой сдачи, игрок сдавал каждую: каждая
// давала капли (charge_drops), строку `grid_completions` (квест `grid_cleared_all`, очки недели/района)
// и счётчик «контракт сдан». Сутки и три слота превращались в неограниченный источник прогресса.
//
// Теперь слот занимается атомарно на сдаче (вставка сама — захват, до наград), а второй одновременный
// старт того же слота отклоняется.
import { describe, expect, it } from 'vitest';
import { generateLevel, orbitSize } from '@guttercaps/economy';
import { Db } from '../src/db.ts';
import { gridContractAt, gridDay, startGridAttempt, completeGridAttempt } from '../src/grid.ts';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const kp = () => { let s = ''; while (s.length < 44) s += B58[Math.floor(Math.random() * B58.length)]; return s; };
function mint(db: Db, owner: string) {
  const asset = kp();
  db.run(`INSERT INTO chips (asset, owner, collection_idx, rarity, level, flags, lock_until, origin, minted_at, burned_at, updated_slot)
          VALUES (?, ?, 0, 0, 1, 0, 0, 'pack', 1, NULL, 0)`, asset, owner);
  return asset;
}
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
const T = 20_000 * 86_400;

/** Чип района, прошедший весь спуск: контракты открываются только таким. */
function masteredChip(db: Db, owner: string) {
  const asset = mint(db, owner);
  db.run(`INSERT INTO grid_chip_routes (asset, next_level, charge_drops, charge_progress, updated_at) VALUES (?, 76, 0, 0, ?)`, asset, T);
  return asset;
}

describe('находка 39: контракт района сдаётся один раз за слот', () => {
  it('второй старт того же слота отклоняется, пока первый не закрыт', () => {
    const db = new Db(':memory:');
    const owner = kp();
    const asset = masteredChip(db, owner);
    const first = startGridAttempt(db, owner, { asset, kind: 'contract', slot: 0 }, T) as unknown as { attemptId: string };
    expect(first.attemptId).toBeTruthy();
    expect(() => startGridAttempt(db, owner, { asset, kind: 'contract', slot: 0 }, T)).toThrow(/already in progress/);
    // другой слот по-прежнему открывается (их три в день)
    const other = gridContractAt(T, 1);
    if (other.district === 0) expect(startGridAttempt(db, owner, { asset, kind: 'contract', slot: 1 }, T)).toMatchObject({ kind: 'contract' });
    // сдать первую попытку и открыть слот заново уже нельзя: он сдан
    const c = gridContractAt(T, 0);
    expect(completeGridAttempt(db, owner, { attemptId: first.attemptId, turns: solFor(c.configLevel, c.seed) }, T).ok).toBe(true);
    expect(() => startGridAttempt(db, owner, { asset, kind: 'contract', slot: 0 }, T)).toThrow(/already completed/);
  });

  it('вторая (параллельная) сдача того же слота не даёт ни капель, ни прогресса', () => {
    const db = new Db(':memory:');
    const owner = kp();
    const asset = masteredChip(db, owner);
    const c = gridContractAt(T, 0);
    // Обе попытки созданы ДО первой сдачи — это и есть «открыть пачкой». Вторую вставляем в обход
    // стартовой проверки: так выглядит состояние после гонки или после старой версии бэкенда.
    const a1 = startGridAttempt(db, owner, { asset, kind: 'contract', slot: 0 }, T) as unknown as { attemptId: string };
    const secondId = kp();
    db.run(`INSERT INTO grid_attempts (id, wallet, asset, level, hints_used, emergency_used, mode, seed, daily, settled, created_at)
            VALUES (?, ?, ?, ?, 0, 0, 'contract', ?, 0, 0, ?)`, secondId, owner, asset, c.configLevel, c.seed, T);
    const r1 = completeGridAttempt(db, owner, { attemptId: a1.attemptId, turns: solFor(c.configLevel, c.seed) }, T);
    expect(r1.ok).toBe(true);
    const dropsAfter1 = db.scalar(`SELECT charge_drops FROM grid_chip_routes WHERE asset = ?`, asset);
    const completionsAfter1 = db.scalar(`SELECT COUNT(*) FROM grid_completions WHERE wallet = ? AND kind = 'contract'`, owner);
    const r2 = completeGridAttempt(db, owner, { attemptId: secondId, turns: solFor(c.configLevel, c.seed) }, T);
    expect(r2).toMatchObject({ ok: false, reason: 'contract_already_done' });
    expect(db.scalar(`SELECT charge_drops FROM grid_chip_routes WHERE asset = ?`, asset)).toBe(dropsAfter1);
    expect(db.scalar(`SELECT COUNT(*) FROM grid_completions WHERE wallet = ? AND kind = 'contract'`, owner)).toBe(completionsAfter1);
    // и попытка закрыта — повторно её уже не сдать
    expect(db.scalar(`SELECT settled FROM grid_attempts WHERE id = ?`, secondId)).toBe(1);
    expect(db.scalar(`SELECT COUNT(*) FROM grid_contract_done WHERE wallet = ? AND day = ? AND slot = 0`, owner, gridDay(T))).toBe(1);
  });
});
