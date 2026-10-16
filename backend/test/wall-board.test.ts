// Доска недели (docs/16 §3.7).
//
// Доска выбрана жеребьёвкой, а не рейтингом, и тесты держат именно эту линию:
// тот же вход даёт тех же пятерых, доска замораживается на неделю, а жалоба —
// фильтр допуска, а не минус к счёту. Неподтверждённая жалоба не двигает ничьё
// место: иначе кнопка «пожаловаться» становится оружием, и это ровно то, от чего
// мы отказались.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { Db } from '../src/db.ts';
import { createApp } from '../src/server.ts';
import { kp } from './fixtures.ts';
import * as board from '../src/wallBoard.ts';
import { WEEK, WEEK_EPOCH_OFFSET, weekIndex } from '../src/quests.ts';

const weekUnix = (week: number, extra = 60) => week * WEEK + WEEK_EPOCH_OFFSET + extra;
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 512"><path d="M10 10L200 120" stroke="#FF2E8A" stroke-width="8" fill="none"/></svg>';

/** Живой тег на стене района `district`, слот `slot`. */
function tagOnWall(db: Db, district: number, slot: number, at: number, wallet = kp(), id = 'a'.repeat(32) + district.toString(16).padStart(2, '0') + slot.toString(16).padStart(2, '0')) {
  db.run(`INSERT INTO tag_registry (id, wallet, sha256, svg, bytes, commands, status, created_at, reports) VALUES (?, ?, 'sha', ?, 100, 2, 'live', ?, 0)`,
    id, wallet, SVG, at - 86_400);
  db.run(`INSERT INTO wall_slots (district, slot, wallet, tag_id, applied_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
    district, slot, wallet, id, at - 86_400, at + 30 * 86_400);
  return { id, wallet };
}

describe('wall board — доска недели', () => {
  let db: Db;
  beforeEach(() => { db = new Db(':memory:'); });

  it('тот же вход даёт тех же пятерых, а розыгрыш без возвращения', () => {
    const cands = Array.from({ length: 12 }, (_, i) => ({ tagId: `t${i}`, wallet: kp(), district: i % 8, slot: i }));
    const hash = board.tagsHash(cands);
    const seed = board.boardSeed({ week: 7, slot: 99, tagsHash: hash, candidates: cands.length });
    const a = board.drawBoard(cands, seed);
    const b = board.drawBoard(cands, seed);
    expect(a).toEqual(b);
    expect(a).toHaveLength(board.WALL_BOARD_SIZE);
    expect(new Set(a.map((c) => c.tagId)).size).toBe(board.WALL_BOARD_SIZE);
  });

  it('порядок кандидатов не влияет на hashes, а состав — влияет', () => {
    const a = [{ tagId: 'x', wallet: 'w', district: 1, slot: 2 }, { tagId: 'y', wallet: 'w', district: 0, slot: 1 }];
    expect(board.tagsHash(a)).toBe(board.tagsHash([...a].reverse()));
    expect(board.tagsHash(a)).not.toBe(board.tagsHash(a.slice(1)));
  });

  it('доска замораживается на неделю и пишет событие автору', () => {
    const t = weekUnix(5);
    const made: { id: string; wallet: string }[] = [];
    for (let i = 0; i < 8; i++) made.push(tagOnWall(db, i % 8, i, t, kp(), `${i}`.repeat(32)));

    const first = board.settleWallBoard(db, t, 4242);
    expect(first.drawn).toBe(true);
    expect(first.items).toHaveLength(5);
    const view = board.wallBoardView(db, undefined, t)!;
    expect(view.week).toBe(5);
    expect(view.candidates).toBe(8);
    expect(view.slot).toBe(4242);

    // второй вызов ничего не переписывает, даже если стена изменилась
    const before = JSON.stringify(board.wallBoardView(db, undefined, t + 10)!.items);
    for (const m of made) db.run(`DELETE FROM wall_slots WHERE tag_id = ?`, m.id);
    const again = board.settleWallBoard(db, t + 10, 9999);
    expect(again.drawn).toBe(false);
    expect(JSON.stringify(board.wallBoardView(db, undefined, t + 10)!.items)).toBe(before);

    const events = db.all<{ wallet: string; kind: string; meta: string }>(`SELECT wallet, kind, meta FROM feature_events WHERE feature = 'wall' AND kind = 'board'`);
    expect(events).toHaveLength(5);
    const winners = new Set(first.items.map((i) => i.wallet));
    expect(events.every((e) => winners.has(e.wallet))).toBe(true);
    expect(JSON.parse(events[0]!.meta)).toMatchObject({ week: 5 });
  });

  it('жалоба, подтверждённая модератором, снимает тег с доски; неподтверждённая — нет', () => {
    const t = weekUnix(9);
    const weekStart = board.weekStartUnix(9);
    const good = tagOnWall(db, 0, 0, t, kp(), 'b'.repeat(32));
    const reported = tagOnWall(db, 1, 1, t, kp(), 'c'.repeat(32));
    const accused = tagOnWall(db, 2, 2, t, kp(), 'd'.repeat(32));

    // неподтверждённая: обвинение, а не вердикт
    db.run(`INSERT INTO wall_reports (tag_id, reporter, reason, created_at, resolved_at, resolution) VALUES (?, ?, 'other', ?, NULL, NULL)`,
      accused.id, kp(), weekStart + 10);
    // подтверждённая: тег уезжает
    db.run(`INSERT INTO wall_reports (tag_id, reporter, reason, created_at, resolved_at, resolution) VALUES (?, ?, 'hate', ?, ?, 'hidden')`,
      reported.id, kp(), weekStart + 20, weekStart + 30);

    const ids = board.boardCandidates(db, t).map((c) => c.tagId);
    expect(ids).toContain(good.id);
    expect(ids).toContain(accused.id);
    expect(ids).not.toContain(reported.id);

    // жалоба с прошлой недели не держит тег вечно
    db.run(`UPDATE wall_reports SET created_at = ? WHERE tag_id = ?`, weekStart - 86_400, reported.id);
    expect(board.boardCandidates(db, t).map((c) => c.tagId)).toContain(reported.id);
  });

  it('скрытый или снятый тег не участвует — доска показывает то, что висит', () => {
    const t = weekUnix(12);
    const a = tagOnWall(db, 0, 0, t, kp(), 'e'.repeat(32));
    const b = tagOnWall(db, 0, 1, t, kp(), 'f'.repeat(32));
    db.run(`UPDATE tag_registry SET status = 'hidden' WHERE id = ?`, b.id);
    db.run(`DELETE FROM wall_slots WHERE tag_id = ?`, a.id);
    expect(board.boardCandidates(db, t)).toHaveLength(0);
    const view = board.wallBoardView(db, undefined, t)!;
    expect(view.items).toHaveLength(0);
    expect(view.candidates).toBe(0);
  });

  it('ротация: отдохнувшие теги уступают место новым, когда новых хватает', () => {
    const w = 20;
    const t = weekUnix(w);
    for (let i = 0; i < 11; i++) tagOnWall(db, i % 8, i, t, kp(), `1${String(i).padStart(2, '0')}`.padEnd(32, '0'));
    const first = board.settleWallBoard(db, t, 7);
    expect(first.items).toHaveLength(5);

    const t2 = weekUnix(w + 1);
    const shown = new Set(first.items.map((i) => i.tagId));
    const next = board.boardCandidates(db, t2).map((c) => c.tagId);
    expect(next).toHaveLength(6);
    expect(next.some((id) => shown.has(id))).toBe(false);
    // и доска следующей недели берётся только из новых
    const drawn = board.settleWallBoard(db, t2, 7);
    expect(drawn.items.every((i) => !shown.has(i.tagId))).toBe(true);
  });

  it('ротация мягкая: если новых не хватает, витрина важнее чистоты правила', () => {
    const w = 24;
    const t = weekUnix(w);
    for (let i = 0; i < 6; i++) tagOnWall(db, i, i, t, kp(), `3${String(i).padStart(2, '0')}`.padEnd(32, '0'));
    expect(board.settleWallBoard(db, t, 7).items).toHaveLength(5);
    // на следующей неделе отдохнувших всего один — доска из пяти не набирается,
    // поэтому повторы допускаются, а не отдаётся пустая витрина
    const t2 = weekUnix(w + 1);
    expect(board.boardCandidates(db, t2)).toHaveLength(6);
    expect(board.settleWallBoard(db, t2, 7).items).toHaveLength(5);
  });

  it('прошлую неделю можно прочитать, а неразыгранную — нет', () => {
    const t = weekUnix(30);
    tagOnWall(db, 0, 0, t, kp(), '7'.repeat(32));
    board.settleWallBoard(db, t, 3);
    expect(board.wallBoardView(db, 30)?.items).toHaveLength(1);
    expect(board.wallBoardView(db, 29)).toBeNull();
    // без явной недели — текущая, и она же разыгрывается лениво
    expect(board.wallBoardView(db, undefined, t)!.week).toBe(30);
  });

  it('сид можно пересчитать из снимка: доску проверяет любой', () => {
    const t = weekUnix(40);
    for (let i = 0; i < 9; i++) tagOnWall(db, i, i, t, kp(), `2${String(i).padStart(2, '0')}`.padEnd(32, '0'));
    const view = board.wallBoardView(db, undefined, t)!;
    const row = db.get<{ tickets: string }>(`SELECT tickets FROM wall_board_draws WHERE week = ?`, view.week)!;
    const snap = JSON.parse(row.tickets) as board.BoardCandidate[];
    const seed = board.boardSeed({ week: view.week, slot: view.slot, tagsHash: board.tagsHash(snap), candidates: snap.length });
    expect(seed.toString('hex')).toBe(view.seedHex);
    expect(board.drawBoard(snap, seed).map((c) => c.tagId)).toEqual(view.items.map((c) => c.tagId));
  });
});

// Маршрут `/v1/wall/board` стоит рядом с `/v1/wall/{district}`, и это не косметика:
// если его поставить после, слово 'board' уедет в номер района и витрина молча
// вернёт стену ноль. Тест ниже — про то, что витрина отвечает витриной.
describe('GET /v1/wall/board', () => {
  let srv: Server;
  let http: Db;
  let base: string;
  // Здесь время настоящее: это живой сервер, а не вызов функции с подставленным t.
  const t = Math.floor(Date.now() / 1000);
  const week = weekIndex(t);

  beforeAll(async () => {
    http = new Db(':memory:');
    for (let i = 0; i < 6; i++) tagOnWall(http, i, i, t, kp(), `5${String(i).padStart(2, '0')}`.padEnd(32, '0'));
    const app = createApp(http, { arenaSweepMs: 0 });
    await new Promise<void>((f) => { srv = app.listen(0, '127.0.0.1', () => f()); });
    base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((f) => srv.close(() => f())));

  it('отдаёт доску текущей недели анониму и 404 на неразыгранную', async () => {
    const now = await fetch(`${base}/v1/wall/board`);
    expect(now.status).toBe(200);
    const j = (await now.json()) as { week: number; items: unknown[]; candidates: number; seedHex: string };
    expect(j.week).toBe(week);
    expect(j.items).toHaveLength(5);
    expect(j.candidates).toBe(6);
    expect(j.seedHex).toMatch(/^[0-9a-f]{64}$/);

    expect((await fetch(`${base}/v1/wall/board?week=${week - 1}`)).status).toBe(404);
    // мусор в week — 400, а не «тихо текущая неделя» (SEC-B2)
    expect((await fetch(`${base}/v1/wall/board?week=later`)).status).toBe(400);
  });

  it('board не уезжает в номер района', async () => {
    const wall = await fetch(`${base}/v1/wall/0`);
    expect(wall.status).toBe(200);
    const w = (await wall.json()) as { district: number; taken: number };
    expect(w.district).toBe(0);
  });
});
