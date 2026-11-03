// Reproducer: the wall board's "a moderator-confirmed report takes the tag off this week's board"
// filter looks for resolution values the product never writes.
//
//   backend/src/wallBoard.ts:92-95   NOT EXISTS (… r.resolution IN ('hidden', 'removed'))
//   backend/src/tags.ts:318          setTagStatus() resolves open reports with `resolution = 'tag_' || status`
//                                    → 'tag_hidden' | 'tag_removed' | 'tag_live'  — and nothing else writes it
//   backend/src/tags.ts:295          modStats() already looks for the `tag_hidden`/`tag_removed` spelling
//   backend/test/wall-board.test.ts:87  inserts 'hidden' by hand, so the suite pins a vocabulary that
//                                    production never produces
//
// Today the visible gap is narrow, because `tag_registry.status = 'live'` already drops a hidden tag from
// the candidate join. The rule stops working exactly when a hidden tag is put back to 'live' in the same
// week (appeal granted, or a moderator revisiting the case): the confirmed report no longer keeps it off
// that week's board, although docs/16 §3.7 and the module header say it must. The test below drives the
// real `setTagStatus`, not a hand-written row.
import { describe, expect, it } from 'vitest';
import { Db } from '../src/db.ts';
import { kp } from './fixtures.ts';
import * as board from '../src/wallBoard.ts';
import { reportTag, saveTag, setTagStatus } from '../src/tags.ts';
import { WEEK, WEEK_EPOCH_OFFSET } from '../src/quests.ts';

const weekUnix = (week: number, extra = 60) => week * WEEK + WEEK_EPOCH_OFFSET + extra;
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 512"><path d="M10 10L200 120" stroke="#FF2E8A" stroke-width="8" fill="none"/></svg>';

describe('wall board × tag moderation', () => {
  // П. 69 (R3) — ещё не исправлено: фильтр ищет значения resolution, которых продукт не пишет.
  it.fails('a report confirmed by a moderator keeps the tag off the board for that week', () => {
    const db = new Db(':memory:');
    const t = weekUnix(9);
    const author = kp();
    const tag = saveTag(db, author, SVG);
    db.run(`INSERT INTO wall_slots (district, slot, wallet, tag_id, applied_at, expires_at) VALUES (0, 0, ?, ?, ?, ?)`,
      author, tag.id, t - 86_400, t + 30 * 86_400);
    expect(board.boardCandidates(db, t).map((c) => c.tagId)).toContain(tag.id);

    reportTag(db, kp(), tag.id, 'hate');
    // the moderator's hide (the only writer of wall_reports.resolution)
    setTagStatus(db, tag.id, 'hidden', 'hate speech', t);
    const resolved = db.get<{ resolution: string }>(`SELECT resolution FROM wall_reports WHERE tag_id = ?`, tag.id)!.resolution;
    expect(board.boardCandidates(db, t).map((c) => c.tagId)).not.toContain(tag.id); // excluded via status

    // appeal granted: back on the wall the same week, report still confirmed this week
    setTagStatus(db, tag.id, 'live', undefined, t + 60);
    const after = board.boardCandidates(db, t + 120).map((c) => c.tagId);
    console.log(JSON.stringify({ resolutionWrittenByProduct: resolved, onBoardAfterRestore: after.includes(tag.id) }));
    expect(resolved).toBe('tag_hidden');           // what tags.ts actually writes
    expect(after).not.toContain(tag.id);           // what wallBoard.ts promised to enforce
  });
});
