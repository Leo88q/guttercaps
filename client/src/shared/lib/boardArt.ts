// Картинки частей доски (docs/16 §4.2).
//
// Части не рисуются кодом: каждая деталь — сгенерированный файл из /art/skate.
// Здесь только раскладка: какой id части какой кадр показывает. Совпадение
// имён не случайно — `deck_d3` → `deck-d3.webp`, и файлы выпускает
// scripts/skate-art-build.py из красок районов (paint-dN) и пластин.
//
// Уровни, у которых своего кадра нет, не притворяются чужими: командная дека
// района — это дека района (отличие в происхождении, а не в картинке), а
// стоковая деталь — просто сама пластина.
import { BOARD_SLOTS, partById, type BoardSlot } from '@guttercaps/economy';

export const BOARD_ART = '/art/skate';

/**
 * Целый арт доски района: собранный скейт с иллюстрацией района, одним
 * файлом (board-d0…d7.webp). Это витринный показ доски с 2026-10-17: плоская
 * «сборка» слоями (дека/траки/колёса отдельными картинками друг на друге)
 * выглядела разобранным скейтом, а материал на неё не ложился — теперь
 * игрок видит готовую доску, а части остаются прогрессом её разблокировки.
 */
export const boardFullArt = (district: number): string => `${BOARD_ART}/board-d${district}.webp`;

/** Арт деки района для галереи дек (та же пластина, что и часть deck_dN). */
export const deckArt = (district: number): string => `${BOARD_ART}/deck-d${district}.webp`;

/**
 * Как показывать деталь в конструкторе. Плоские пластины частей районов
 * выглядели «разобранным скейтом»: вместо них — целая доска этого района
 * (та же картинка, что и в превью), а какая деталь имеется в виду, говорит
 * подпись. Трофей и сток остаются своими артами.
 */
export function partVisual(partId: string | null | undefined): string | null {
  const part = partId ? partById(partId) : undefined;
  if (!part) return null;
  if (part.district !== null && BOARD_STACK.includes(part.slot)) return boardFullArt(part.district);
  if (part.tier === 'trophy') return `${BOARD_ART}/${part.slot}-trophy.webp`;
  return partArt(partId);
}

/** Кадр части. `null` — у части нет картинки (нет наклейки). */
export function partArt(partId: string | null | undefined): string | null {
  if (!partId) return null;
  const part = partById(partId);
  if (!part) return null;

  if (part.slot === 'sticker') {
    // Наклейки — уже существующие трафареты города: новая графика ради
    // наклейки на грип не нужна, а трафарет района на доске читается как
    // принадлежность к району.
    if (partId === 'sticker_moth') return `${BOARD_ART}/stencil-d0-moth.webp`;
    if (partId === 'sticker_railking') return `${BOARD_ART}/stencil-d2-freight.webp`;
    if (partId === 'sticker_crown') return `${BOARD_ART}/stencil-crown.webp`;
    return null;
  }
  if (part.slot === 'bolts') {
    if (partId === 'bolts_acid') return `${BOARD_ART}/bolts-acid.webp`;
    if (partId === 'bolts_gold') return `${BOARD_ART}/bolts-gold.webp`;
    return `${BOARD_ART}/bolts.webp`;              // stock и chrome — сама пластина
  }
  const district = part.district;
  return `${BOARD_ART}/${part.slot}${district === null ? '' : `-d${district}`}.webp`;
}

/**
 * Порядок сборки: снизу вверх. На экране детали лежат именно так, как на
 * настоящей доске, — грип сверху, траки и колёса под декой.
 */
export const BOARD_STACK: readonly BoardSlot[] = ['deck', 'grip', 'trucks', 'wheels', 'bolts', 'sticker'];

/** Все слоты в порядке каталога (сетовые первыми) — витрина конструктора. */
export const BOARD_SLOTS_ORDER = BOARD_SLOTS;
