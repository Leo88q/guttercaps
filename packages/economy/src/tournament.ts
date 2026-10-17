// =============================================================================
// GUTTERCAPS economy — платный вход в Линию: дневной турнир (docs/16 §5.4)
// -----------------------------------------------------------------------------
// Взнос 30 $CG за попытку, доска ранжирует кошельки по лучшему заезду
// дня, приз — косметика (части доски), никогда не $CG. Все числа
// зафиксированы прогоном `scripts/line-tournament-sim.ts` и прибиты
// тестом `test/line-tournament.test.ts`; сюда они попадают как есть:
//
//   • взнос 30 $CG: 75 % сжигается (путь пака), 10 % в казну,
//     15 % в пул; пул дотируется из eventsReserve (12,6 % её дневного
//     бюджета, ≈ 6,9 тыс. $CG/день) — уже зарезервированной доли,
//     поэтому эмиссия не двигается (якорь A4);
//   • форма payouts — те же процентили, что у сезонной лестницы арены
//     (`SEASON.payoutBrackets`): пять полос, пустая полоса скатывается
//     вверх;
//   • потолок попыток — общий с доп. заездами (`LINE.maxPaidRunsPerDay`),
//     он же держит ёмкость фермы: доска ранжирует по ЛУЧШЕМУ заезду,
//     а каждая попытка стоит денег.
//
// Что изменилось относительно черновика симуляции по решению владельца
// (2026-10-17): призовой фонд — **только косметика**. В симе
// рекомендованная конфигурация отдавала 25 % пула в $CG; здесь $CG из
// пула не уходит вовсе — строго безопаснее для всех четырёх якорей
// (медианный возврат падает до нуля, сжигание не двигается), а
// привлекательность держится на ценности частей.
//
// Модельная «ценность» приза — это число для гейта A5, а не цена:
// часть не продаётся и не покупается, поэтому в этом модуле нет ни
// одной суммы, которую можно было бы назвать ценой части.
// =============================================================================

import { LINE } from './runs.ts';
import { SEASON } from './pvp.ts';
import { boardDistrictOfWeek, type BoardSlot } from './board.ts';

/** Взнос и его судьба (bps от взноса). Сумма = 10 000: остаток — пул. */
export const TOURNAMENT = {
  /** Взнос: 30 $CG — та же точка цены, что доп. заезд (§5.1). */
  entryCgMicro: 30_000_000,
  /** 75 % сжигается — путь пака за $CG (сток, а не выручка). */
  burnBps: 7500,
  /** 10 % в казну. */
  treasuryBps: 1000,
  /** 15 % в призовой фонд. */
  poolBps: 10_000 - 7500 - 1000,
  /** Дотация пула из eventsReserve: 12,6 % её дневного бюджета (сим). */
  reserveBps: 1263,
  /** Сколько попыток в день даёт один взнос: доска — по лучшему заезду. */
  maxEntriesPerDay: LINE.maxPaidRunsPerDay,
} as const;

/**
 * Призовая полоса. `topPct`/`sharePct` повторяют `SEASON.payoutBrackets`
 * (форма выплат зафиксирована симуляцией), содержимое — части доски.
 *
 * `trophies` — фиксированные id трофейных частей (верхние полосы).
 * `districtSlots` — сколько недостающих слотов района недели даёт
 * полоса: приз закрывает дыру в сетке, а не плодит копии (тот же
 * приём, что у выдачи за заезд, §4.2).
 */
export interface TournamentBandPrize {
  topPct: number;
  sharePct: number;
  trophies: readonly string[];
  districtSlots: number;
}

/**
 * Расписание призов дня. Три верхние полосы — трофеи (они редки
 * сами по себе: их два в каталоге), остальные — части района недели.
 * Порядок — порядок `SEASON.payoutBrackets`: полоса 0 — самая верхняя.
 */
export function tournamentPrizeSchedule(): TournamentBandPrize[] {
  return [
    { topPct: 0.1, sharePct: 15, trophies: ['deck_trophy', 'grip_trophy'], districtSlots: 0 },
    { topPct: 1, sharePct: 20, trophies: ['grip_trophy'], districtSlots: 0 },
    { topPct: 5, sharePct: 25, trophies: [], districtSlots: 2 },
    { topPct: 20, sharePct: 25, trophies: [], districtSlots: 1 },
    { topPct: 50, sharePct: 15, trophies: [], districtSlots: 1 },
  ];
}

/**
 * Полоса по месту (1-based), ровно та же арифметика срезов, что в
 * `seasonPayoutByRank`: верхняя граница полосы = ceil(n × topPct / 100).
 * -1 — место вне призовых (ниже половины поля).
 */
export function tournamentBandOfRank(rank: number, entrants: number): number {
  if (rank < 1 || entrants <= 0) return -1;
  let prev = 0;
  for (let i = 0; i < SEASON.payoutBrackets.length; i++) {
    const cut = Math.min(entrants, Math.ceil((entrants * SEASON.payoutBrackets[i].topPct) / 100));
    if (rank > prev && rank <= cut) return i;
    prev = cut;
  }
  return -1;
}

/**
 * Места, которые попадают в каждую полосу (для доски и тестов):
 * `[from, to]` включительно, 1-based.
 */
export function tournamentBandCuts(entrants: number): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let prev = 0;
  for (const b of SEASON.payoutBrackets) {
    const cut = Math.min(entrants, Math.ceil((entrants * b.topPct) / 100));
    if (cut > prev) out.push({ from: prev + 1, to: cut });
    prev = cut;
  }
  return out;
}

/**
 * Приз одного участника: фиксированные трофеи полосы плюс
 * `districtSlots` недостающих частей района недели. Возвращает ровно
 * те id, которые отдаст `grantPart`; частей может оказаться меньше
 * запланированных — сет района собран, и награда исчерпала себя (§4.2).
 *
 * `missing` — слоты района недели, которых у победителя ещё нет,
 * в порядке слотов сета; выдача идёт по порядку, как у заезда недели.
 */
export function tournamentPrizeParts(
  band: number,
  week: number,
  missing: readonly BoardSlot[],
): string[] {
  const prize = tournamentPrizeSchedule()[band];
  if (!prize) return [];
  const district = boardDistrictOfWeek(week);
  const out = [...prize.trophies];
  for (const slot of missing) {
    if (out.length - prize.trophies.length >= prize.districtSlots) break;
    out.push(`${slot}_d${district}`);
  }
  return out;
}

/**
 * Модельная ценность приза на 1 $CG взноса — та же мера, что в симе
 * (`appeal`), для экрана и отчёта: пул дня (взносы × доля пула +
 * дотация резерва) делим на взносы дня. Число модельное: оно
 * отвечает на вопрос «стоит ли взнос», а не называет цену части.
 */
export function tournamentPrizeValuePerCg(opts: {
  entries: number;
  /** $CG-эквивалент дотации eventsReserve на день. */
  reserveCg: number;
}): number {
  const entryTotal = opts.entries * (TOURNAMENT.entryCgMicro / 1_000_000);
  if (entryTotal <= 0) return 0;
  const pool = entryTotal * (TOURNAMENT.poolBps / 10_000) + opts.reserveCg;
  // Приз — целиком косметика: вся сумма пула — её модельная ценность.
  return pool / entryTotal;
}
