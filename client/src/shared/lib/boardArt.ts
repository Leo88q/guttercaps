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
