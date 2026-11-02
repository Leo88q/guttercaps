// Reproducer: the weekly wall board draws from (district, slot) candidates, not from distinct tags.
//
//   backend/src/wall.ts:139-141  claimSlot() allows one slot PER WALLET PER DISTRICT — the same tag
//                                (tag_registry.id is per artwork) can hang on up to 8 walls at once
//   backend/src/wallBoard.ts:81-104  boardCandidates() returns one row per wall_slots row, with no
//                                de-duplication by tag_id
//   backend/src/wallBoard.ts:118-128 drawBoard() samples candidates "without replacement" — of
//                                candidate ROWS, so the same tag gets one ticket per wall it hangs on
//
// The header of wallBoard.ts says the draw is "тег, а не кошелёк" and the view promises "Пять тегов
// города". With one artwork on three walls that tag occupies up to three of the five places (and a
// board of two candidates is the same tag twice), while its author's odds scale with the number of
// walls he claimed — the exact wallet-weighting the module says it does not do.
import { describe, expect, it } from 'vitest';
import { Db } from '../src/db.ts';
import { kp } from './fixtures.ts';
import * as board from '../src/wallBoard.ts';
import { saveTag } from '../src/tags.ts';
import { WEEK, WEEK_EPOCH_OFFSET } from '../src/quests.ts';

const weekUnix = (week: number, extra = 60) => week * WEEK + WEEK_EPOCH_OFFSET + extra;
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 512"><path d="M10 10L200 120" stroke="#FF2E8A" stroke-width="8" fill="none"/></svg>';

describe('wall board × duplicate candidates', () => {
  it('one tag on several walls gets several tickets and can fill the board with itself', () => {
    const db = new Db(':memory:');
    const t = weekUnix(9);
    const author = kp();
    const tag = saveTag(db, author, SVG);
    // the product's own path: one slot per district, the same tag in three districts
    for (const district of [0, 1, 2]) {
      db.run(
        `INSERT INTO wall_slots (district, slot, wallet, tag_id, applied_at, expires_at) VALUES (?, 0, ?, ?, ?, ?)`,
        district, author, tag.id, t - 86_400, t + 30 * 86_400,
      );
    }
    const candidates = board.boardCandidates(db, t);
    const seed = board.boardSeed({ week: 9, slot: 1000, tagsHash: board.tagsHash(candidates), candidates: candidates.length });
    const picks = board.drawBoard(candidates, seed);
    const tagIds = picks.map((p) => p.tagId);
    console.log(JSON.stringify({
      candidates: candidates.length,
      distinctTags: new Set(candidates.map((c) => c.tagId)).size,
      boardSlots: picks.length,
      boardDistinctTags: new Set(tagIds).size,
      board: picks.map((p) => `${p.district}:${p.slot}`),
    }));
    expect(candidates.length).toBe(3);              // one tag, three tickets
    expect(new Set(tagIds).size).toBeLessThan(picks.length); // the same tag twice on a 3-slot board
  });
});
