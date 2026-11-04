// Находка 75 — регрессия. `claimSlot` разрешает один слот на кошелёк В РАЙОНЕ, поэтому один и тот же тег
// (`tag_registry.id` — про произведение, а не про размещение) может висеть на восьми стенах. `boardCandidates`
// отдавал строку на каждый слот `wall_slots` без дедупликации по `tag_id`, а `drawBoard` тянул «без
// возвращения» из СТРОК: тег получал билет за каждую стену, мог занять несколько мест из пяти (в репро —
// всю доску) и весил в жеребьёвке ровно во столько раз больше, во сколько стен занял. Заголовок модуля
// при этом обещает «тег, а не кошелёк», а витрина — пять тегов города.
//
// Правило после правки: билет — тег. Дедупликация стоит ДО `tagsHash`/`boardSeed`, иначе сид зависел бы
// от числа стен, а не от состава снимка. Размещение (район, слот) выбирается детерминированно — первое по
// (район, слот), поэтому та же неделя из того же снимка даёт ту же доску.
import { describe, expect, it } from 'vitest';
import { Db } from '../src/db.ts';
import { kp } from './fixtures.ts';
import * as board from '../src/wallBoard.ts';
import { saveTag } from '../src/tags.ts';
import { WEEK, WEEK_EPOCH_OFFSET } from '../src/quests.ts';

const weekUnix = (week: number, extra = 60) => week * WEEK + WEEK_EPOCH_OFFSET + extra;
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 512"><path d="M10 10L200 120" stroke="#FF2E8A" stroke-width="8" fill="none"/></svg>';

/** Живой тег на стене района `district` — тем же путём, что и продукт (один слот на кошелёк в районе). */
function hang(db: Db, tagId: string, wallet: string, district: number, t: number, slot = 0) {
  db.run(
    `INSERT INTO wall_slots (district, slot, wallet, tag_id, applied_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
    district, slot, wallet, tagId, t - 86_400, t + 30 * 86_400,
  );
}

const draw = (candidates: ReturnType<typeof board.boardCandidates>, week: number) => {
  const seed = board.boardSeed({ week, slot: 1000, tagsHash: board.tagsHash(candidates), candidates: candidates.length });
  return board.drawBoard(candidates, seed);
};

describe('доска недели × билет на тег, а не на стену', () => {
  it('тег на трёх стенах получает один билет и одно место', () => {
    const db = new Db(':memory:');
    const t = weekUnix(9);
    const author = kp();
    const tag = saveTag(db, author, SVG);
    for (const district of [0, 1, 2]) hang(db, tag.id, author, district, t);

    const candidates = board.boardCandidates(db, t);
    const picks = draw(candidates, 9);
    const tagIds = picks.map((p) => p.tagId);
    console.log(JSON.stringify({
      walls: 3,
      candidates: candidates.length,
      distinctTags: new Set(candidates.map((c) => c.tagId)).size,
      boardSlots: picks.length,
      boardDistinctTags: new Set(tagIds).size,
      placement: picks.map((p) => `${p.district}:${p.slot}`),
    }));
    expect(candidates).toHaveLength(1);                    // один тег — один билет
    expect(new Set(tagIds).size).toBe(tagIds.length);      // и одно место на доске
    expect(tagIds).toEqual([tag.id]);
    // размещение детерминированно: первый район, где тег висит
    expect(picks[0]).toMatchObject({ district: 0, slot: 0 });
  });

  it('число стен не даёт веса: два тега дают по билету независимо от того, сколько стен занял каждый', () => {
    const db = new Db(':memory:');
    const t = weekUnix(11);
    const a = saveTag(db, kp(), SVG);
    const b = saveTag(db, kp(), SVG.replace('#FF2E8A', '#00E5FF'));
    for (const district of [0, 1, 2, 3, 4, 5, 6, 7]) hang(db, a.id, kp(), district, t); // восемь стен
    hang(db, b.id, kp(), 7, t, 1);                                                    // одна стена (слот 1: слот 0 занят первым тегом)

    const candidates = board.boardCandidates(db, t);
    expect(candidates.map((c) => c.tagId).sort()).toEqual([a.id, b.id].sort());
    // доска из двух тегов — оба на ней, ни один не дублируется
    const picks = draw(candidates, 11);
    expect(picks.map((p) => p.tagId).sort()).toEqual([a.id, b.id].sort());
    // и сид зависит от состава снимка, а не от числа стен: снимок тот же — сид тот же
    const again = board.boardCandidates(db, t);
    expect(board.tagsHash(again)).toBe(board.tagsHash(candidates));
  });
});
