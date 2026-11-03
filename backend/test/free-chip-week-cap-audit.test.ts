// Репродукция находки 38: недельный лимит бесплатных чипов обходился «старой» датой выполнения.
//
// `vouchersRootedThisWeek` считал выданные ваучеры по `completed_at` (когда квест выполнен), а не по
// моменту выдачи. Строка, выполненная больше недели назад и всё ещё не ушедшая в корень, в счётчик не
// попадала вовсе — и за одну неделю уходило сколько угодно бесплатных чипов: кап видел ноль.
//
// Исправлено: `quest_completions.chip_root_at` пишется в момент, когда лист уходит в корень (kind 9), и
// окно `ANTI_FARM.freeChipsPerWalletPerWeek` считается по нему (`COALESCE` держит исторические строки).
import { describe, expect, it } from 'vitest';
import { ANTI_FARM, QUEST_CHIP_TEMPLATES } from '@guttercaps/economy';
import { Db } from '../src/db.ts';
import * as oracle from '../src/reward-oracle.ts';
import { kp } from './fixtures.ts';

const T = 1_800_000_000;
const DAY = 86_400;

/** Строка квеста, выполненная `daysAgo` дней назад и всё ещё не ушедшая в корень. */
function oldCompletion(db: Db, wallet: string, key: string, daysAgo: number) {
  db.run(
    `INSERT INTO quest_completions (wallet, quest_id, period_key, amount, reward_chip, completed_at, day)
     VALUES (?, 'd_streak7', ?, '0', ?, ?, ?)`,
    wallet, key, JSON.stringify(QUEST_CHIP_TEMPLATES[0]), T - daysAgo * DAY, Math.floor((T - daysAgo * DAY) / DAY),
  );
}

describe('находка 38: недельный лимит бесплатных чипов считается по факту выдачи', () => {
  it('старые выполнения больше не обходят кап: за неделю уходит не больше freeChipsPerWalletPerWeek', () => {
    const db = new Db(':memory:');
    const w = kp();
    for (let i = 0; i < 4; i++) oldCompletion(db, w, `d${100 + i}`, 30); // выполнены 30 дней назад
    expect(oracle.vouchersRootedThisWeek(db, w, T)).toBe(0);

    const rooted: number[] = [];
    // Каждый эпох — не больше одного ваучера на кошелёк; окно в 7 дней не должно пропустить больше капа.
    for (let epoch = 0; epoch < 4; epoch++) {
      const at = T + epoch * 60;
      const batch = oracle.buildChipBatch(db, at, 1);
      if (!batch) break;
      rooted.push(db.scalar(`SELECT COUNT(*) FROM quest_completions WHERE chip_root_kind = 9 AND chip_root_epoch = ?`, batch.epoch));
      // Корень опубликован — следующий эпох может собирать следующий батч.
      db.run(`UPDATE reward_batches SET status = 'published', published_at = ? WHERE kind = 9 AND status = 'pending'`, at);
    }
    console.log(JSON.stringify({ cap: ANTI_FARM.freeChipsPerWalletPerWeek, rooted: rooted.length, counted: oracle.vouchersRootedThisWeek(db, w, T + 180) }));
    expect(rooted.length).toBe(ANTI_FARM.freeChipsPerWalletPerWeek);
    // Счётчик видит выдачу, хотя дата выполнения — месячной давности.
    expect(oracle.vouchersRootedThisWeek(db, w, T + 180)).toBe(ANTI_FARM.freeChipsPerWalletPerWeek);
    // И кап перестаёт мешать только со следующей недели.
    expect(oracle.vouchersRootedThisWeek(db, w, T + 8 * DAY)).toBe(0);
    // следующий эпох после публикации корня снова выдаёт ваучер
    expect(oracle.buildChipBatch(db, T + 8 * DAY, 1)).toBeTruthy();
  });
});
