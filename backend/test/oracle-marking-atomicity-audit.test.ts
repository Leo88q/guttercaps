// Регрессия находки 37: листья бустеров могли задвоиться при сбое между батчем и разметкой.
//
// `buildItemBatch` сначала коммитил батч с листьями (`insertBatch` — своя транзакция), и только
// ПОТОМ отдельной транзакцией помечал строки `quest_completions` (`item_root_kind`). Сбой между двумя
// транзакциями (перезапуск воркера, падение процесса, ошибка записи) оставлял уже выпущенные листья
// при неразмеченных строках: `pendingBoosterRows` снова отдавал их в следующий эпох, строился второй
// корень на того же кошелька, и клейм `claim_item_root` платил бустеры дважды. Тот же дефект был у
// kind 9 (ваучеры на чипы: `chip_root_kind`).
//
// Проверка детерминированная: разметка обрывается исключением (как при падении процесса), и после
// этого в БД не должно остаться ни батча, ни листьев, а строки остаются неразмеченными — то есть
// система либо размечает и выпускает вместе, либо не делает ничего.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Db } from '../src/db.ts';
import { buildChipBatch, buildItemBatch, KIND_CHIP_VOUCHERS, KIND_ITEM_BOOSTERS } from '../src/reward-oracle.ts';

const A = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const root = path.resolve(process.cwd(), process.cwd().endsWith('/backend') ? '..' : '.');
const src = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

function seedBoosters(db: Db) {
  db.run(`INSERT INTO wallets (address, first_seen) VALUES (?, ?)`, A, 1000);
  db.run(`INSERT INTO quest_completions (wallet, quest_id, period_key, amount, reward_booster, completed_at, day) VALUES (?, 'd_login', 'd1', '3000000', 1, 1000, 1)`, A);
  db.run(`INSERT INTO quest_completions (wallet, quest_id, period_key, amount, reward_booster, completed_at, day) VALUES (?, 'd_fuse1', 'd1', '4000000', 1, 1001, 1)`, A);
}

/** Падение «между батчем и разметкой»: любая запись разметки обрывается — как при убийстве процесса. */
function crashOnMark(db: Db, marker: RegExp) {
  const orig = db.run.bind(db);
  (db as unknown as { run: typeof orig }).run = (sql: string, ...args: unknown[]) => {
    if (marker.test(sql)) throw new Error('процесс упал посреди разметки');
    return orig(sql, ...(args as never[]));
  };
  return () => { (db as unknown as { run: typeof orig }).run = orig; };
}

describe('находка 37: батч и разметка строк — одна транзакция', () => {
  it('kind 8: обрыв на разметке не оставляет выпущенных листьев и не платит бустеры дважды', () => {
    const db = new Db(':memory:');
    seedBoosters(db);
    const restore = crashOnMark(db, /UPDATE quest_completions SET item_root_kind/);
    expect(() => buildItemBatch(db, 2000, 1)).toThrow(/упал/);
    restore();
    // транзакция откатилась целиком: ни батча, ни листьев, строки по-прежнему неразмеченные
    expect(db.scalar(`SELECT COUNT(*) FROM reward_batches WHERE kind = ?`, KIND_ITEM_BOOSTERS)).toBe(0);
    expect(db.scalar(`SELECT COUNT(*) FROM reward_leaves WHERE kind = ?`, KIND_ITEM_BOOSTERS)).toBe(0);
    expect(db.scalar(`SELECT COUNT(*) FROM quest_completions WHERE item_root_kind IS NULL`)).toBe(2);
    // штатный проход выпускает РОВНО один корень на оба гранта и размечает обе строки
    const batch = buildItemBatch(db, 2100, 1)!;
    expect(batch).toMatchObject({ kind: KIND_ITEM_BOOSTERS, leaves: 1 });
    expect(db.scalar(`SELECT COUNT(*) FROM reward_leaves WHERE kind = ?`, KIND_ITEM_BOOSTERS)).toBe(1);
    expect(db.scalar(`SELECT COUNT(*) FROM quest_completions WHERE item_root_kind IS NULL`)).toBe(0);
    // и повторный проход больше ничего не выпускает: строки заняты этим эпохом
    expect(buildItemBatch(db, 2200, 1)).toBeUndefined();
    expect(db.scalar(`SELECT COUNT(*) FROM reward_batches WHERE kind = ?`, KIND_ITEM_BOOSTERS)).toBe(1);
  });

  it('kind 9: тот же обрыв не выпускает второй ваучер на чип', () => {
    const db = new Db(':memory:');
    db.run(`INSERT INTO wallets (address, first_seen) VALUES (?, ?)`, A, 1000);
    db.run(`INSERT INTO quest_completions (wallet, quest_id, period_key, amount, reward_chip, completed_at, day) VALUES (?, 'd_streak7', 'd1', '0', ?, 1000, 1)`,
      A, JSON.stringify({ template: 1, odds: [1], soulboundDays: 3 }));
    const restore = crashOnMark(db, /UPDATE quest_completions SET chip_root_kind/);
    expect(() => buildChipBatch(db, 2000, 1)).toThrow(/упал/);
    restore();
    expect(db.scalar(`SELECT COUNT(*) FROM reward_batches WHERE kind = ?`, KIND_CHIP_VOUCHERS)).toBe(0);
    expect(db.scalar(`SELECT COUNT(*) FROM reward_leaves WHERE kind = ?`, KIND_CHIP_VOUCHERS)).toBe(0);
    expect(db.scalar(`SELECT COUNT(*) FROM quest_completions WHERE chip_root_kind IS NULL`)).toBe(1);
    const batch = buildChipBatch(db, 2100, 1)!;
    expect(batch).toMatchObject({ kind: KIND_CHIP_VOUCHERS, leaves: 1 });
    expect(db.scalar(`SELECT COUNT(*) FROM quest_completions WHERE chip_root_kind IS NULL`)).toBe(0);
    expect(db.scalar(`SELECT COUNT(*) FROM reward_batches WHERE kind = ?`, KIND_CHIP_VOUCHERS)).toBe(1);
  });

  it('разметка передаётся в insertBatch, а не отдельной транзакцией после него', () => {
    const code = src('backend/src/reward-oracle.ts');
    // kind 8: mark-колбэк последним аргументом insertBatch
    const item = code.slice(code.indexOf('export function buildItemBatch'), code.indexOf('export function pendingVoucherRows'));
    expect(item).toContain('return insertBatch(db, kind,');
    expect(item).toContain('item_root_kind = ?, item_root_epoch = ?');
    expect(item).not.toMatch(/insertBatch\([^;]*\);\s*\n\s*db\.tx\(/); // нет второг�� транзакции после батча
    // kind 9: то же
    const chip = code.slice(code.indexOf('export function buildChipBatch'), code.indexOf('// ---------------------------------------------------------------- board parts (kind 10)'));
    expect(chip).toContain('return insertBatch(db, kind,');
    expect(chip).not.toMatch(/insertBatch\([^;]*\);\s*\n\s*db\.tx\(/);
  });
});
