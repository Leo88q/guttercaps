// =============================================================================
// GUTTERCAPS — доска недели (docs/16 §3.7)
// -----------------------------------------------------------------------------
// Пять тегов города на неделю. Выбираются **жеребьёвкой, а не рейтингом** — и
// это принципиально, а не от лени:
//
//   Рейтинг на пользовательском контенте — это соревнование за оценку. Оценку
//   здесь ставит не жюри, а улица: у тега есть кнопка «пожаловаться» (§3.6), и
//   любой рейтинг, в который жалобы входят со знаком минус, превращает её в
//   оружие — достаточно скооперироваться и чужая доска уезжает вниз. То же
//   самое с «аккуратностью»: приз за аккуратность — это приз за безопасный
//   рисунок, то есть давление на стиль. Нам такое не нужно.
//
// Поэтому: **жалобы — фильтр допуска, а не счёт**. Подтверждённая модератором
// жалоба (resolution hidden/removed) снимает тег с доски на эту неделю;
// неподтверждённая не делает ничего — обвинение ещё не вердикт, и именно поэтому
// нажатия на «пожаловаться» не двигают ничьё место.
//
// Розыгрыш: сид = sha256(wall-board:v1:week:slot:tagsHash:candidates), где slot —
// finalizedHorizon на момент розыгрыша (как в Gutter Pot: сид нельзя вычислить
// заранее из одного списка тегов), tagsHash — sha256 отсортированного списка
// кандидатов. Выборка без возвращения, без весов: тег, а не кошелёк. Доска
// замораживается на неделю — прошлая не переписывается от того, что автор потом
// снял тег.
// =============================================================================

import { createHash } from 'node:crypto';
import type { Db } from './db.ts';
import { now } from './db.ts';
import { finalizedHorizon } from './finality.ts';
import { DAY, WEEK, WEEK_EPOCH_OFFSET, weekIndex } from './quests.ts';
import { recordEvent } from './worldMetrics.ts';

export const WALL_BOARD_SIZE = 5;
/** Сколько недель тег отдыхает после попадания на доску: витрина должна крутиться. */
export const WALL_BOARD_COOLDOWN_WEEKS = 4;
export const WALL_BOARD_SEED_PREFIX = 'wall-board:v1';

const DAY_S = DAY;
const iso = (s: number) => new Date(s * 1000).toISOString();

export interface BoardCandidate {
  tagId: string;
  wallet: string;
  district: number;
  slot: number;
}

interface BoardRow {
  week: number; drawn_at: number; slot: number; seed_hex: string; tags_hash: string;
  candidates: number; winners: string; tickets: string;
}

export interface WallBoardView {
  week: number;
  weekStart: string;
  weekEnd: string;
  drawnAt: string;
  slot: number;
  seedHex: string;
  tagsHash: string;
  candidates: number;
  items: BoardCandidate[];
}

export const weekStartUnix = (week: number) => week * WEEK + WEEK_EPOCH_OFFSET;
export const weekEndUnix = (week: number) => weekStartUnix(week) + WEEK;

/** Теги, уже светившиеся на доске за последние `weeks` недель. */
export function recentBoardTagIds(db: Db, week: number, weeks = WALL_BOARD_COOLDOWN_WEEKS): Set<string> {
  const rows = db.all<{ winners: string }>(`SELECT winners FROM wall_board_draws WHERE week < ? AND week >= ?`, week, week - weeks);
  const out = new Set<string>();
  for (const r of rows) for (const w of parseCandidates(r.winners)) out.add(w.tagId);
  return out;
}

/**
 * Кандидаты на доску: теги, висящие на стенах прямо сейчас, живые, без жалобы,
 * которую модератор подтвердил на этой неделе.
 *
 * «Висящие сейчас» — осознанно: доска — снимок стены в момент розыгрыша, а не
 * подсчёт «кто провисел всю неделю». Второй вариант к моменту первого открытия
 * доски (середина недели) просто нечем считать.
 */
export function boardCandidates(db: Db, t = now()): BoardCandidate[] {
  const weekStart = weekStartUnix(weekIndex(t));
  const rows = db
    .all<{ tag_id: string; wallet: string; district: number; slot: number }>(
      `SELECT s.tag_id, s.wallet, s.district, s.slot
         FROM wall_slots s
         JOIN tag_registry g ON g.id = s.tag_id AND g.status = 'live'
        WHERE NOT EXISTS (
                SELECT 1 FROM wall_reports r
                 WHERE r.tag_id = s.tag_id AND r.created_at >= ? AND r.resolution IN ('hidden', 'removed')
              )
        ORDER BY s.district, s.slot`,
      weekStart,
    )
    .map((r) => ({ tagId: r.tag_id, wallet: r.wallet, district: r.district, slot: r.slot }));

  // Ротация мягкая: если без повторов доска не набирается, повторы допускаются.
  // Пустая витрина хуже, чем знакомый тег второй раз.
  const seen = recentBoardTagIds(db, weekIndex(t));
  const fresh = rows.filter((r) => !seen.has(r.tagId));
  return fresh.length >= WALL_BOARD_SIZE ? fresh : rows;
}

/** sha256 строк `district:slot:tagId` — содержимое снимка, а не порядок выдачи. */
export function tagsHash(candidates: readonly BoardCandidate[]): string {
  const lines = [...candidates]
    .sort((a, b) => (a.district - b.district) || (a.slot - b.slot) || (a.tagId < b.tagId ? -1 : 1))
    .map((c) => `${c.district}:${c.slot}:${c.tagId}`)
    .join('\n');
  return createHash('sha256').update(lines).digest('hex');
}

export function boardSeed(input: { week: number; slot: number; tagsHash: string; candidates: number }): Buffer {
  return createHash('sha256')
    .update(`${WALL_BOARD_SEED_PREFIX}:${input.week}:${input.slot}:${input.tagsHash}:${input.candidates}`)
    .digest();
}

/** Выборка без возвращения и без весов: у тега нет «веса», вес есть у стейка, а он тут не при делах. */
export function drawBoard(candidates: readonly BoardCandidate[], seed: Buffer, k: number = WALL_BOARD_SIZE): BoardCandidate[] {
  const remaining = [...candidates];
  const out: BoardCandidate[] = [];
  const take = Math.min(k, remaining.length);
  for (let round = 0; round < take; round++) {
    const h = createHash('sha256').update(seed).update(Buffer.from([round])).digest();
    const picked = Number(BigInt('0x' + h.toString('hex')) % BigInt(remaining.length));
    out.push(remaining.splice(picked, 1)[0]!);
  }
  return out;
}

function parseCandidates(raw: string): BoardCandidate[] {
  try {
    const list = JSON.parse(raw) as BoardCandidate[];
    return Array.isArray(list) ? list.filter((c) => c && typeof c.tagId === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Розыгрыш текущей недели. Идемпотентен: доска на неделю замораживается, второй
 * вызов ничего не переписывает. Вызывается лениво на чтении — отдельного
 * таймера у витрины нет, как и у выцветания слотов (§3.4).
 */
export function settleWallBoard(db: Db, t = now(), horizon = finalizedHorizon(db)): { week: number; items: BoardCandidate[]; drawn: boolean } {
  const week = weekIndex(t);
  const existing = db.get<{ winners: string }>(`SELECT winners FROM wall_board_draws WHERE week = ?`, week);
  if (existing) return { week, items: parseCandidates(existing.winners), drawn: false };

  const candidates = boardCandidates(db, t);
  const hash = tagsHash(candidates);
  const seed = boardSeed({ week, slot: horizon, tagsHash: hash, candidates: candidates.length });
  const picks = drawBoard(candidates, seed);
  const walletOf = new Map(candidates.map((c) => [c.tagId, c.wallet] as const));

  db.tx(() => {
    db.run(
      `INSERT INTO wall_board_draws (week, drawn_at, slot, seed_hex, tags_hash, candidates, winners, tickets)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      week, t, horizon, seed.toString('hex'), hash, candidates.length, JSON.stringify(picks), JSON.stringify(candidates),
    );
    // Событие — в той же транзакции: иначе метрика §12 («вернулся ли автор») разойдётся с доской.
    for (const p of picks) {
      recordEvent(db, walletOf.get(p.tagId) ?? p.wallet, 'wall', 'board', { week, tagId: p.tagId, district: p.district, slot: p.slot });
    }
  });
  return { week, items: picks, drawn: true };
}

/**
 * Доска недели. Без `week` — текущая (с ленивым розыгрышем); с `week` —
 * замороженная доска прошлых недель. `null` — неделю никто не разыгрывал.
 */
export function wallBoardView(db: Db, week?: number, t = now()): WallBoardView | null {
  let w = week;
  if (w === undefined) {
    const settled = settleWallBoard(db, t);
    w = settled.week;
  }
  const row = db.get<BoardRow>(`SELECT * FROM wall_board_draws WHERE week = ?`, w);
  if (!row) return null;
  return {
    week: row.week,
    weekStart: iso(weekStartUnix(row.week)),
    weekEnd: iso(weekEndUnix(row.week)),
    drawnAt: iso(row.drawn_at),
    slot: row.slot,
    seedHex: row.seed_hex,
    tagsHash: row.tags_hash,
    candidates: row.candidates,
    items: parseCandidates(row.winners),
  };
}

/** Сколько дней осталось до конца недели доски (для надписи «обновится в понедельник»). */
export function boardDaysLeft(t = now()): number {
  return Math.max(0, Math.ceil((weekEndUnix(weekIndex(t)) - t) / DAY_S));
}
