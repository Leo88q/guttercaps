// =============================================================================
// GUTTERCAPS — конструктор доски: части (docs/16 §4.2)
// -----------------------------------------------------------------------------
// Часть доски — это косметика, которую добывают игрой. Три правила, из которых
// здесь всё вытекает:
//
// 1. **Часть не даёт силы.** Ни веса, ни шанса, ни дохода, ни очков в заезде
//    (решение 1 из §0.3). Единственный эффект — визуальный: районная краска,
//    трафарет района на деке, «собранный сет» светится.
// 2. **Часть добывается, а не покупается.** Источники — Floodgrid
//    (часть недели за 2★+ и районные части за 3★ фишкой района), Deep Flood
//    (трофеи), командные конкурсы (§5.6). Заездов больше нет (2026-10-19).
//    Магазин продаёт косметику поверх этого, но не закрывает дырку в доске:
//    стартовый комплект есть у каждого с первого входа.
// 3. **Собранный сет района — не бонус, а почёт.** Четыре основные части одного
//    района дают свечение района и строчку в профиле. Ничего сверх этого.
//
// Почему каталог считается, а не пишется руками: районных частей 8 × 4, и ручной
// список разошёлся бы с коллекциями при первом же добавлении района. Имена
// районов берутся из `COLLECTIONS`, поэтому часть и крышка одного района
// называют район одинаково.
// =============================================================================

import { COLLECTIONS } from './lore.ts';

/** Слоты доски. Первые четыре — «сет района», последние два — чистая косметика. */
export const BOARD_SLOTS = ['deck', 'trucks', 'wheels', 'grip', 'bolts', 'sticker'] as const;
export type BoardSlot = (typeof BOARD_SLOTS)[number];

/** Слоты, из которых собирается сет района: навесные болты и наклейка в сет не идут. */
export const BOARD_SET_SLOTS = ['deck', 'trucks', 'wheels', 'grip'] as const;
export type BoardSetSlot = (typeof BOARD_SET_SLOTS)[number];

/**
 * Происхождение части.
 *
 * `stock` есть у каждого с первого входа — доска не бывает пустой, и новый
 * игрок не видит дыр вместо деки. Остальное добывается.
 */
export const BOARD_SOURCES = ['stock', 'run', 'grid', 'deep', 'achievement', 'crew', 'tournament', 'shop'] as const;
export type BoardSource = (typeof BOARD_SOURCES)[number];

/**
 * Уровень части. Влияет ровно на одно — на то, как часть выглядит и как
 * подписана в профиле. Ни одна строка здесь не должна попасть в расчёт веса,
 * шанса или дохода.
 */
export const BOARD_TIERS = ['stock', 'district', 'crew', 'trophy'] as const;
export type BoardTier = (typeof BOARD_TIERS)[number];

export interface BoardPart {
  id: string;
  slot: BoardSlot;
  /** Район части; `null` у навесной косметики и у стартового комплекта. */
  district: number | null;
  tier: BoardTier;
  /** Откуда часть достаётся игроку — подсказка на экране, а не право на выдачу. */
  source: BoardSource;
}

/** Навесная косметика: одни и те же варианты во всех районах. */
const BOLTS = ['stock', 'chrome', 'acid', 'gold'] as const;
const STICKERS = ['none', 'moth', 'railking', 'crown'] as const;

function districtParts(): BoardPart[] {
  const out: BoardPart[] = [];
  for (let d = 0; d < COLLECTIONS.length; d++) {
    for (const slot of BOARD_SET_SLOTS) {
      out.push({ id: `${slot}_d${d}`, slot, district: d, tier: 'district', source: 'grid' });
    }
  }
  return out;
}

/**
 * Каталог частей. Порядок стабильный: сначала стартовый комплект, потом
 * районные по районам, потом командные, трофейные и навесная косметика.
 * От порядка зависит только то, в каком порядке экран показывает витрину.
 */
export const BOARD_PARTS: readonly BoardPart[] = [
  // Стартовый комплект: доска есть у каждого, и «собери доску» не превращается
  // в «купи доску» на первом экране.
  ...BOARD_SET_SLOTS.map((slot) => ({ id: `${slot}_stock`, slot, district: null, tier: 'stock' as BoardTier, source: 'stock' as BoardSource })),
  ...districtParts(),
  // Командная часть: приз ежемесячного конкурса команд (§5.6) — косметика,
  // никогда не $CG. Одна на район, но достаётся только призёрам.
  // Командная часть: приз ежемесячного конкурса команд (§5.6) — косметика,
  // никогда не $CG. Одна на район, и визуально это дека своего района: отличие
  // не в картинке, а в происхождении (подпись «Команда» на детали).
  ...COLLECTIONS.map((_, d) => ({ id: `deck_crew_d${d}`, slot: 'deck' as BoardSlot, district: d, tier: 'crew' as BoardTier, source: 'crew' as BoardSource })),
  // Трофейные части: приз Deep Flood (с 2026-10-19; раньше — турнира Линии,
  // который убран из продукта). Дека и грип, района нет — трофей принадлежит
  // городу, а не району. source = 'deep': подсказка на экране ведёт в
  // Deep Flood, а не в обычный сектор.
  ...(['deck', 'grip'] as const).map((slot) => ({ id: `${slot}_trophy`, slot, district: null, tier: 'trophy' as BoardTier, source: 'deep' as BoardSource })),
  ...BOLTS.map((b) => ({ id: `bolts_${b}`, slot: 'bolts' as BoardSlot, district: null, tier: (b === 'stock' ? 'stock' : 'district') as BoardTier, source: (b === 'stock' ? 'stock' : 'shop') as BoardSource })),
  ...STICKERS.map((s) => ({ id: `sticker_${s}`, slot: 'sticker' as BoardSlot, district: null, tier: (s === 'none' ? 'stock' : 'district') as BoardTier, source: (s === 'none' ? 'stock' : 'shop') as BoardSource })),
];

const BY_ID = new Map(BOARD_PARTS.map((p) => [p.id, p]));
export const partById = (id: string): BoardPart | undefined => BY_ID.get(id);
export const partsOfSlot = (slot: BoardSlot): BoardPart[] => BOARD_PARTS.filter((p) => p.slot === slot);
export const partsOfDistrict = (d: number): BoardPart[] => BOARD_PARTS.filter((p) => p.district === d);

/** Стартовый комплект: по одной части на слот, район не выбран. */
export const STOCK_PARTS: readonly BoardPart[] = BOARD_SET_SLOTS
  .map((slot) => BY_ID.get(`${slot}_stock`)!)
  .concat([BY_ID.get('bolts_stock')!, BY_ID.get('sticker_none')!])
  .filter(Boolean);

/** Загрузка доски: ровно одна часть на слот, пустых слотов не бывает. */
export type BoardLoadout = Record<BoardSlot, string>;

export function stockLoadout(): BoardLoadout {
  const out = {} as BoardLoadout;
  for (const slot of BOARD_SLOTS) {
    const stock = STOCK_PARTS.find((p) => p.slot === slot);
    out[slot] = stock?.id ?? BOARD_PARTS.find((p) => p.slot === slot)!.id;
  }
  return out;
}

/**
 * Сет района: все четыре основные части одного района. Эффект ровно один —
 * визуальный (свечение и подпись в профиле); это решение 1 из §0.3, и его тут
 * нельзя обойти «бонусом за комплект».
 */
export function boardSetDistrict(loadout: BoardLoadout): number | null {
  let district: number | null = null;
  for (const slot of BOARD_SET_SLOTS) {
    const part = BY_ID.get(loadout[slot]);
    if (!part || part.district === null) return null;
    if (district === null) district = part.district;
    else if (district !== part.district) return null;
  }
  return district;
}

/** Часть можно надеть, только если она подходит к слоту. Всё остальное — нет. */
export function canEquip(partId: string, slot: BoardSlot): boolean {
  const part = BY_ID.get(partId);
  return !!part && part.slot === slot;
}

/**
 * Какую часть района выдать за заезд: район недели один на весь город.
 *
 * Общий район вместо случайного — не экономия на случайности, а честность:
 * игрок видит, что золотой заезд на этой неделе даёт деку «Фрахтового двора»,
 * и может решить, ехать ли за ней. Случайный район награды превратил бы выдачу
 * в лотерею, а лотерею на выдаче предметов мы не обещали.
 */
export const BOARD = {
  /** Сколько частей одного вида можно держать: дубль из двух источников не
   *  должен падать с ошибкой, но и копиться бесконечно незачем. */
  maxQtyPerPart: 9,
  /** Порог заезда, за который дают районную часть: `silver` = 2000 очков (LINE_TIERS). */
  grantTier: 'silver' as BoardTierName,
  /** Сколько призовых частей получает команда-призёр месяца (§5.6). */
  crewPrizeParts: 3,
} as const;

/** Имена порогов заезда — строка, чтобы этот модуль не тащил за собой всю линию. */
export type BoardTierName = 'none' | 'bronze' | 'silver' | 'gold';

/** Район недели: один на всех, считается от номера недели. */
export function boardDistrictOfWeek(week: number): number {
  const n = COLLECTIONS.length;
  return ((week % n) + n) % n;
}

/** Часть района недели для слота — ровно то, что выдаст награда Floodgrid. */
export function weeklyBoardPart(week: number, slot: BoardSetSlot = 'deck'): string {
  return `${slot}_d${boardDistrictOfWeek(week)}`;
}
