// Reproducer: settleCrewMonth (backend/src/crew.ts:523-561) pays the first three crews *in table
// order*, not the three highest-scoring ones. `scored` is filled inside `for (const c of crews)` and
// never sorted before `scored.slice(0, CREW.monthlyContestPlaces)`, while the public board
// (`crewMonthBoard`, crew.ts:583-605) sorts by `score DESC, id ASC`. So the crew the screen shows as
// #1 can be a different, poorer crew than the one that receives the district deck part — and a crew
// that scored 0-padding but was chartered early takes the prize from the real winner.
import { describe, expect, it } from 'vitest';
import { Db } from '../src/db.ts';
import { settleCrewMonth, crewMonthBoard } from '../src/crew.ts';
import { DAY, WEEK, WEEK_EPOCH_OFFSET, weekIndex } from '../src/quests.ts';
import { CREW } from '@guttercaps/economy';

const MONTH = 202411;
const START = Date.UTC(2024, 10, 1) / 1000;
const END = Date.UTC(2024, 11, 1) / 1000;

function crew(db: Db, name: string, district: number, segment: number) {
  db.run(
    `INSERT INTO crews (name, name_key, captain, charter_sig, wall_district, wall_segment, created_at, status, invite_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'live', ?)`,
    name, name.toLowerCase(), `${name}-captain`, `sig-${name}`, district, segment, START - 86_400, `inv-${name}`,
  );
  return Number(db.get<{ id: number }>(`SELECT id FROM crews WHERE name = ?`, name)!.id);
}

function member(db: Db, crewId: number, wallet: string) {
  db.run(`INSERT INTO crew_members (crew_id, wallet, joined_at) VALUES (?, ?, ?)`, crewId, wallet, START - 3600);
}

function run(db: Db, wallet: string, score: number, week: number) {
  db.run(
    `INSERT INTO line_runs (wallet, day, week, seed, inputs, score, tricks, best_combo, bails, paid, submitted_at, replay_ttl)
     VALUES (?, ?, ?, 1, '[]', ?, 0, 0, 0, 0, ?, ?)`,
    wallet, Math.floor((START + 3600) / DAY), week, score, START + 7200, START + 14 * DAY,
  );
}

describe('crew monthly contest', () => {
  // П. 58 (R2) — ещё не исправлено: `it.fails` заставит обновить тест, когда `settleCrewMonth`
  // начнёт сортировать по очкам (сейчас платит первые три строки таблицы).
  it.fails('the highest-scoring crews get the prizes, as the board shows', () => {
    const db = new Db(':memory:');
    // a week whose Monday-of-the-board (week start) actually lies inside the month
    let week = -1;
    for (let w = weekIndex(START); w <= weekIndex(END - 1); w++) {
      const ws = w * WEEK + WEEK_EPOCH_OFFSET;
      if (ws >= START && ws < END) { week = w; break; }
    }
    expect(week).toBeGreaterThan(-1);
    // chartered first, mediocre: 5 members × 100
    const early = crew(db, 'EARLY_WEAK', 1, 1);
    // chartered second, best in the month: 5 members × 9000
    const strong = crew(db, 'LATE_STRONG', 1, 2);
    for (let i = 0; i < CREW.minMembers; i++) {
      member(db, early, `weak${i}`);
      member(db, strong, `strong${i}`);
      run(db, `weak${i}`, 100, week);
      run(db, `strong${i}`, 9_000, week);
    }

    const board = crewMonthBoard(db, MONTH);
    const settled = settleCrewMonth(db, MONTH, END + 3600);
    const paidOrder = settled.prizes.map((p) => `${p.name}:${p.score}`);
    console.log(JSON.stringify({ board: board.rows.map((r) => `${r.rank}.${r.name}:${r.score}`), paidOrder }));

    // board says LATE_STRONG is #1 …
    expect(board.rows[0]!.name).toBe('LATE_STRONG');
    // … and the prize must go to the same crew
    expect(settled.prizes[0]!.name).toBe('LATE_STRONG');
    expect(settled.prizes.map((p) => p.name)).toEqual(board.rows.slice(0, CREW.monthlyContestPlaces).map((r) => r.name));
  });
});
