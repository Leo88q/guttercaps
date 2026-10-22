// =============================================================================
// Дневной турнир линии (docs/16 §5.4)
// -----------------------------------------------------------------------------
// Взнос 30 $CG за ПОПЫТКУ: платёж покупает вход (кредит), вход тратится
// заездом с `tournament: true`. Доска ранжирует кошельки по лучшему
// турнирному заезду дня; приз — чисто косметика (части доски), $CG из
// пула никому не платится: расщепление взноса 75/10/15 (сжигание /
// казна / пул) — оффчейн-учёт, ончейн $CG-услуга сжигается на 100 %.
//
// Что здесь держится:
//  1. **Один платёж — один вход, один вход — одна попытка.** Кредит
//     живёт в `line_tournament_entries` и тратится ровно один раз
//     (`used_by`), как `line_credits`.
//  2. **Общий потолок paid-попыток.** Вход продаётся только пока
//     paidUsed + неиспользованные кредиты (линия + турнир) <
//     `LINE.maxPaidRunsPerDay` — ферма попыток держится тем же
//     ограничением, что и доп. заезды (§5.1).
//  3. **Сет идемпотентен.** `line_tournament_days` — PK дня; повторный
//     вызов для ужеsettled дня возвращает результат, не выдавая дважды.
//  4. **Приз закрывает дыру.** Трофеи — фиксированы полосой; остальные
//     слоты — недостающие части района недели (тот же приём, что у
//     заезда недели, §4.2): приз не плодит копии собранного сета.
// =============================================================================

import type { Db } from './db.ts';
import { now } from './db.ts';
import { DAY, dayIndex, weekIndex } from './quests.ts';
import { ServiceError, consume, findPayment, serviceRefHash, toHex } from './services.ts';
import { grantPart, missingOfDistrict } from './board.ts';
import { recordEvent } from './worldMetrics.ts';
import {
  LINE, SERVICE_BY_ID, TOURNAMENT, boardDistrictOfWeek, tournamentBandOfRank, tournamentPrizeParts, tournamentPrizeSchedule,
} from '@guttercaps/economy';

const iso = (s: number) => new Date(s * 1000).toISOString();

// ------------------------------------------------------------------- вход

/**
 * Купить вход в турнир дня: платёж услуги `lineTournamentEntry`
 * (kind 16, ровно 30M µ$CG, CG-рельс) → один неиспользованный кредит.
 *
 * ref-хеш считается от `{ id, day }` — платёж за вчера не зайдёт
 * в турнир сегодня. Кроме одного случая: платёж, подписанный на
 * дне X и принятый сервером уже на дне X+1 (переход UTC-полуночи
 * между оплатой и запросом). День — свойство раскладки, а не
 * покупателя, поэтому такой платёж честно продаёт вход СЕГОДНЯ:
 * сжигание то же, вход тот же, consume() держит платёж одноразовым.
 */
export function enterTournament(db: Db, wallet: string, body: Record<string, unknown> | undefined, t = now()): { day: number; entries: number } {
  const day = Number(body?.day);
  const today = dayIndex(t);
  if (!Number.isInteger(day) || Math.abs(day - today) > 1) {
    throw new ServiceError(400, 'bad_day', `day must be today (${today})`);
  }
  const signature = String(body?.signature ?? '').trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,128}$/.test(signature)) throw new ServiceError(400, 'bad_signature', 'signature must be a transaction id');
  // Турниры линии убраны из продукта (2026-10-19): услуга снята с продажи.
  const svc = SERVICE_BY_ID.lineTournamentEntry as typeof SERVICE_BY_ID.lineTournamentEntry | undefined;
  if (!svc) throw new ServiceError(410, 'line_retired', 'The Line is retired');
  const kind = svc.kind;
  return db.tx(() => {
    // Общий дневной потолок paid-попыток (линия + турнир): потраченные
    // платежом заезды видны в `paid`, купленные, но ещё не потраченные
    // кредиты — отдельным счётом. Иначе вход продавался бы в обход
    // лимита, который держит ёмкость фермы.
    const paid = db.scalar(`SELECT COALESCE(SUM(paid), 0) FROM line_runs WHERE wallet = ? AND day = ?`, wallet, today);
    const unusedLine = db.scalar(`SELECT COUNT(*) FROM line_credits WHERE wallet = ? AND day = ? AND used_by IS NULL`, wallet, today);
    const unusedT = db.scalar(`SELECT COUNT(*) FROM line_tournament_entries WHERE wallet = ? AND day = ? AND used_by IS NULL`, wallet, today);
    if (paid + unusedLine + unusedT >= LINE.maxPaidRunsPerDay) {
      throw new ServiceError(409, 'run_credit_cap', `At most ${LINE.maxPaidRunsPerDay} paid runs per day`);
    }
    // Платёж привязан к дню, на который он был подписан. Ожидаем
    // сегодня; принимаем ещё вчера — полночь застала между оплатой
    // и запросом. Любой другой день — чужой платёж.
    const refFor = (d: number) => toHex(serviceRefHash(kind, wallet, { id: 'lineTournamentEntry', day: d }));
    const p = findPayment(db, signature, wallet, [kind], refFor(today));
    if (p.ref_hash !== refFor(today)) {
      if (p.ref_hash !== refFor(today - 1)) throw new ServiceError(402, 'ref_hash_mismatch', 'Payment was committed for a different day');
      recordEvent(db, wallet, 'tournament', 'enter_rollover', { paidFor: today - 1, granted: today }, t);
    }
    if (p.currency !== 2 || BigInt(p.amount) !== BigInt(TOURNAMENT.entryCgMicro)) {
      throw new ServiceError(402, 'cg_burn_required', `Tournament entries are bought with exactly ${TOURNAMENT.entryCgMicro / 1_000_000} $CG (burned)`);
    }
    db.run(`INSERT INTO line_tournament_entries (wallet, day, signature, granted_at) VALUES (?, ?, ?, ?)`, wallet, today, p.signature, t);
    consume(db, p, `tournament:${today}`);
    recordEvent(db, wallet, 'tournament', 'enter', { day: today }, t);
    return { day: today, entries: unusedT + 1 };
  });
}

// ------------------------------------------------------------------- состояние

export interface TournamentPrizeView {
  band: number;
  topPct: number;
  trophies: string[];
  districtSlots: number;
}

export interface TournamentState {
  day: number;
  week: number;
  /** Сколько входов куплено сегодня и сколько ещё можно купить. */
  entries: { bought: number; unused: number; left: number };
  /** Мой лучший турнирный заезд сегодня (null — ещё не ехал). */
  best: { score: number; runId: number; at: string } | null;
  /** Моё место в сегодняшней доске (null — вне доски / пуста). */
  rank: number | null;
  entrants: number;
  /** Пул дня в µ$CG — учётная модельная сумма, $CG из неё не платится. */
  poolCgMicro: string;
  settled: boolean;
  schedule: TournamentPrizeView[];
  /** Призы вчерашнего дня (сет уже закрыт), свои. */
  prizesYesterday: { rank: number; band: number; part: string }[];
}

export function tournamentState(db: Db, wallet: string, t = now()): TournamentState {
  const day = dayIndex(t);
  const week = weekIndex(t);
  const mine = db.get<{ bought: number; unused: number }>(
    `SELECT COUNT(*) bought, COALESCE(SUM(CASE WHEN used_by IS NULL THEN 1 ELSE 0 END), 0) unused
       FROM line_tournament_entries WHERE wallet = ? AND day = ?`, wallet, day);
  const best = db.get<{ score: number; run_id: number; at: number }>(
    `SELECT r.score, r.run_id, r.submitted_at at FROM line_tournament_runs r
      WHERE r.day = ? AND r.wallet = ? ORDER BY r.score DESC, r.run_id ASC LIMIT 1`, day, wallet);
  const board = tournamentBoard(db, day);
  const rank = board.rows.findIndex((r) => r.wallet === wallet);
  const dayRow = db.get<{ entrants: number; pool_cg_micro: string; settled_at: number | null }>(
    `SELECT entrants, pool_cg_micro, settled_at FROM line_tournament_days WHERE day = ?`, day);
  const yesterday = day - 1;
  const prizes = db.all<{ rank: number; band: number; part: string }>(
    `SELECT rank, band, part FROM line_tournament_prizes WHERE day = ? AND wallet = ? ORDER BY rank ASC`, yesterday, wallet);
  // Тот же счёт общего потолка, что при покупке входа: потраченные
  // paid-заезды + неиспользованные кредиты обоих видов.
  const paidUsed = Number(db.scalar(`SELECT COALESCE(SUM(paid), 0) FROM line_runs WHERE wallet = ? AND day = ?`, wallet, day));
  const unusedLine = db.scalar(`SELECT COUNT(*) FROM line_credits WHERE wallet = ? AND day = ? AND used_by IS NULL`, wallet, day);
  const left = Math.max(0, LINE.maxPaidRunsPerDay - paidUsed - unusedLine - (mine?.unused ?? 0));
  return {
    day, week,
    entries: { bought: mine?.bought ?? 0, unused: mine?.unused ?? 0, left },
    best: best ? { score: best.score, runId: best.run_id, at: iso(best.at) } : null,
    rank: rank >= 0 ? rank + 1 : null,
    entrants: board.entrants,
    poolCgMicro: dayRow?.pool_cg_micro ?? '0',
    settled: board.settled,
    schedule: tournamentPrizeSchedule().map((b, i) => ({ band: i, topPct: b.topPct, trophies: [...b.trophies], districtSlots: b.districtSlots })),
    prizesYesterday: prizes.map((p) => ({ rank: p.rank, band: p.band, part: p.part })),
  };
}

// ------------------------------------------------------------------- доска

export interface TournamentBoardRow {
  rank: number;
  wallet: string;
  handle: string | null;
  score: number;
  runId: number;
  at: string;
  hasReplay: boolean;
  /** Полоса приза (-1 — вне призовых). */
  band: number;
}

export interface TournamentBoard {
  day: number;
  entrants: number;
  poolCgMicro: string;
  settled: boolean;
  rows: TournamentBoardRow[];
}

/**
 * Доска дня: лучший турнирный заезд кошелька (score DESC, run_id ASC —
 * тот же tie-break, что у доски недели). Открыта всем: строка и так
 * публична на доске недели, а в турнирном заезде нет ничего своего.
 */
export function tournamentBoard(db: Db, day: number, limit = 50): TournamentBoard {
  const rows = db.all<{ wallet: string; handle: string | null; score: number; run_id: number; at: number; inputs: string }>(
    `SELECT r.wallet, w.handle, r.score, r.run_id, r.submitted_at at, lr.inputs
       FROM line_tournament_runs r
       LEFT JOIN wallets w ON w.address = r.wallet
       LEFT JOIN line_runs lr ON lr.id = r.run_id
      WHERE r.day = ? AND r.run_id = (SELECT run_id FROM line_tournament_runs b WHERE b.day = r.day AND b.wallet = r.wallet ORDER BY b.score DESC, b.run_id ASC LIMIT 1)
      ORDER BY r.score DESC, r.run_id ASC
      LIMIT ?`, day, limit);
  const entrants = db.scalar(`SELECT COUNT(DISTINCT wallet) FROM line_tournament_runs WHERE day = ?`, day);
  const dayRow = db.get<{ pool_cg_micro: string; settled_at: number | null }>(
    `SELECT pool_cg_micro, settled_at FROM line_tournament_days WHERE day = ?`, day);
  return {
    day,
    entrants: Number(entrants),
    poolCgMicro: dayRow?.pool_cg_micro ?? '0',
    settled: dayRow?.settled_at != null,
    rows: rows.map((r, i) => ({
      rank: i + 1, wallet: r.wallet, handle: r.handle, score: r.score, runId: r.run_id, at: iso(r.at),
      hasReplay: r.inputs !== '[]',
      band: tournamentBandOfRank(i + 1, Number(entrants)),
    })),
  };
}

// ------------------------------------------------------------------- сет

export interface TournamentSettleResult {
  day: number;
  entrants: number;
  poolCgMicro: string;
  /** Уже закрыт ранее — ничего не выдано повторно. */
  alreadySettled: boolean;
  prizes: { wallet: string; rank: number; band: number; part: string }[];
}

/**
 * Закрыть день турнира и выдать призы. Идемпотентен: PK дня в
 * `line_tournament_days` — отметка сета, весь сет — одна транзакция,
 * повторный вызов возвращает прежний результат.
 *
 * Ранжирование — лучший турнирный заезд дня; полосы — те же срезы,
 * что у сезонной лестницы (верхняя полоса — 0.1 % поля). Частей в
 * выдаче может оказаться меньше запланированных: сет района собран.
 */
export function settleLineTournament(db: Db, day: number, t = now()): TournamentSettleResult {
  const existing = db.get<{ entrants: number; pool_cg_micro: string; settled_at: number | null }>(
    `SELECT entrants, pool_cg_micro, settled_at FROM line_tournament_days WHERE day = ?`, day);
  if (existing?.settled_at != null) {
    const prizes = db.all<{ wallet: string; rank: number; band: number; part: string }>(
      `SELECT wallet, rank, band, part FROM line_tournament_prizes WHERE day = ? ORDER BY rank ASC`, day);
    return { day, entrants: existing.entrants, poolCgMicro: existing.pool_cg_micro, alreadySettled: true, prizes };
  }
  return db.tx(() => {
    const ranked = db.all<{ wallet: string; score: number; run_id: number }>(
      `SELECT wallet, score, run_id FROM line_tournament_runs r
        WHERE r.day = ? AND r.run_id = (SELECT run_id FROM line_tournament_runs b WHERE b.day = r.day AND b.wallet = r.wallet ORDER BY b.score DESC, b.run_id ASC LIMIT 1)
        ORDER BY r.score DESC, r.run_id ASC`, day);
    const entrants = ranked.length;
    if (entrants === 0) return { day, entrants: 0, poolCgMicro: '0', alreadySettled: false, prizes: [] };
    // Учётная сумма пула: доля взносов (15 %). Дотация eventsReserve —
    // модельный бюджет ЦЕННОСТИ косметики, $CG из пула не платится.
    const poolCgMicro = (BigInt(entrants) * BigInt(TOURNAMENT.entryCgMicro) * BigInt(TOURNAMENT.poolBps)) / 10_000n;
    const week = weekIndex(day * DAY);
    const prizes: TournamentSettleResult['prizes'] = [];
    ranked.forEach((r, i) => {
      const rank = i + 1;
      const band = tournamentBandOfRank(rank, entrants);
      if (band < 0) return;
      // Районные слоты приза — недостающие части района недели:
      // приз закрывает дыру в сетке, а не плодит копии (§4.2).
      const missing = missingOfDistrict(db, r.wallet, boardDistrictOfWeek(week));
      for (const part of tournamentPrizeParts(band, week, missing)) {
        // PK (day, wallet, part) держит выдачу ровно в одном экземпляре:
        // повторный сет (край crash-а вне транзакции) не дублирует.
        const got = db.scalar(`SELECT 1 FROM line_tournament_prizes WHERE day = ? AND wallet = ? AND part = ?`, day, r.wallet, part);
        if (got) continue;
        grantPart(db, r.wallet, part, 'tournament', t);
        db.run(
          `INSERT INTO line_tournament_prizes (day, wallet, rank, band, part, granted_at) VALUES (?, ?, ?, ?, ?, ?)`,
          day, r.wallet, rank, band, part, t);
        prizes.push({ wallet: r.wallet, rank, band, part });
        recordEvent(db, r.wallet, 'tournament', 'prize', { day, rank, band, part }, t);
      }
    });
    db.run(
      `INSERT INTO line_tournament_days (day, entrants, pool_cg_micro, settled_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET entrants = excluded.entrants, pool_cg_micro = excluded.pool_cg_micro, settled_at = excluded.settled_at`,
      day, entrants, poolCgMicro.toString(), t);
    return { day, entrants, poolCgMicro: poolCgMicro.toString(), alreadySettled: false, prizes };
  });
}
