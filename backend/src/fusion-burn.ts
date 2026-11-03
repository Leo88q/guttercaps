// Доказательство сжигания материалов fusion (reports/INDEPENDENT-CODE-REVIEW-PROGRESS.md §12).
//
// Раньше проверка жила замыканием в server.ts и считала доказательством сжигания ЛЮБОЕ исключение DAS:
// таймаут, HTTP 5xx, битый JSON, несовпадение id. При недоступном DAS все три материала «сгорали», и
// оплаченный fusion переходил в `paid` без реального burn — то есть мог выпустить чип из непотраченных
// материалов (критическая находка 12).
//
// Здесь доказательство строгое, а сбой — это сбой:
//   * индексер уже видел burn (`chips.burned_at` заполнен) — доказано цепью;
//   * DAS отдаёт ассет с `burnt: true` — доказано индексером;
//   * DAS прямо ответил «ассета нет» (`DasError.code === 'not_found'`) — лист удалён из дерева;
//   * живой ассет без флага — НЕ сожжён;
//   * всё остальное (транспорт, таймаут, 5xx, битый ответ, чужой id) — `BurnCheckUnavailable`, а не «сгорел».
// Вызывающий обязан трактовать `BurnCheckUnavailable` как «не проверено» (503), а не как отказ в сжигании:
// intent остаётся оплачиваемым, материалы остаются занятыми, клиент повторяет.
import { DasError } from './das.ts';
import type { Db } from './db.ts';

/** Минимальный контракт DAS, который нужен проверке (тесты подставляют фейк). */
export interface BurnAssetSource {
  getAsset(assetId: string): Promise<{ burnt: boolean }>;
}

/** Сжигание проверить не удалось. Это НЕ «не сожжено» и НЕ «сожжено». */
export class BurnCheckUnavailable extends Error {
  constructor(public readonly assetId: string, public readonly reason: string) {
    super(`burn of ${assetId} cannot be verified right now: ${reason}`);
    this.name = 'BurnCheckUnavailable';
  }
}

/**
 * Все ли материалы сожжены. `true` — доказано, `false` — доказано, что нет, исключение
 * `BurnCheckUnavailable` — доказательства нет ни в одну сторону.
 */
export async function verifyBurns(db: Db, assetIds: readonly string[], das: BurnAssetSource): Promise<boolean> {
  for (const a of assetIds) {
    const local = db.get<{ burned_at: number | null }>(`SELECT burned_at FROM chips WHERE asset = ?`, a);
    if (local?.burned_at !== null && local?.burned_at !== undefined) continue; // indexer already saw the burn
    let asset: { burnt: boolean };
    try {
      asset = await das.getAsset(a);
    } catch (e) {
      if (e instanceof DasError && e.code === 'not_found') continue; // лист удалён из дерева — сожжён
      throw new BurnCheckUnavailable(a, (e as Error)?.message ?? String(e));
    }
    // DAS keeps burnt assets queryable with `burnt: true` instead of erroring (live finding 2026-10-26).
    // Only a live, unflagged asset means "not burned (yet)".
    if (!asset.burnt) return false;
  }
  return true;
}
