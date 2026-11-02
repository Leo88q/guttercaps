// Consumption ledger (reports/REMEDIATION-DESIGN.md §1.5, находка 67).
//
// «Этот платёж уже потрачен» — факт оффчейн-выдачи, а не проекция блокчейна. Раньше он жил
// единственным полем `service_payments.consumed_by`, а `service_payments` входит в PROJECTION_TABLES:
// `dropSignatures()` (форк/дроп любой транзакции) стирал таблицу и переигрывал события из
// `events_raw`, которые про `consumed_by` ничего не знают. Всё, что уже было куплено
// (`entitlements`, `grid_deep_credits`, `board_parts`), при этом НЕ откатывалось — платёж снова
// становился «свежим», и тот же signature покупал второй сезонный пропуск.
//
// Поэтому «потраченность» вынесена в `payment_consumption`, которая НЕ является проекцией:
//   * первичный ключ (signature, event_index) — один платёж тратится ровно один раз, навсегда;
//   * строка пишется в той же транзакции, что и выдача (вызывающий уже внутри db.tx);
//   * таблица не чистится ни `dropSignatures`, ни `rebuild`;
//   * `service_payments.consumed_by` остаётся денормализованным зеркалом для старых запросов и
//     пересобирается из ledger'а (`healPaymentConsumption`) после каждого replay.
import type { Db } from './db.ts';
import { insertIgnore } from './sql.ts';

/** `scope:subject` — как исторически писали вызывающие (`entitlement:12`, `handle:alice`, `grid-deep:7`). */
export interface ConsumptionMark {
  signature: string;
  event_index: number;
  scope: string;
  subject: string;
  consumed_by: string;
  consumed_at: number;
}

/** Единственный «платёж уже использован» — превращается в 409 на границе API. */
export class PaymentSpentError extends Error {
  constructor(signature: string, eventIndex: number) {
    super(`payment ${signature}:${eventIndex} was already consumed`);
    this.name = 'PaymentSpentError';
  }
}

export function splitConsumedBy(by: string): { scope: string; subject: string } {
  const i = by.indexOf(':');
  return i < 0 ? { scope: by, subject: '' } : { scope: by.slice(0, i), subject: by.slice(i + 1) };
}

/**
 * Пометить платёж потраченным. Возвращает false, если он уже был потрачен (гонка двух реплик или
 * повтор запроса) — решение принимает INSERT по первичному ключу, а не предшествующий SELECT.
 */
export function markConsumed(db: Db, p: { signature: string; event_index: number }, by: string, at: number): boolean {
  const { scope, subject } = splitConsumedBy(by);
  const r = db.run(
    insertIgnore('payment_consumption', ['signature', 'event_index', 'scope', 'subject', 'consumed_by', 'consumed_at']),
    p.signature, p.event_index, scope, subject, by, at,
  );
  if (Number(r.changes) !== 1) return false;
  // Зеркало для читателей, которые ещё смотрят на service_payments. Ноль изменённых строк здесь не
  // ошибка: строки проекции может не быть (только что пересобрана), её дольёт heal/replay.
  db.run(`UPDATE service_payments SET consumed_by = ?, consumed_at = ? WHERE signature = ? AND event_index = ?`, by, at, p.signature, p.event_index);
  return true;
}

/** Метка расхода, если платёж уже потрачен (иначе null). Читает только ledger. */
export function consumedMark(db: Db, signature: string, eventIndex: number): string | null {
  return db.get<{ consumed_by: string }>(`SELECT consumed_by FROM payment_consumption WHERE signature = ? AND event_index = ?`, signature, eventIndex)?.consumed_by ?? null;
}

/** Все метки расхода по транзакции — для отчёта финальности о дропнутой, но уже потраченной оплате. */
export function consumedMarks(db: Db, signature: string): ConsumptionMark[] {
  return db.all<ConsumptionMark>(
    `SELECT signature, event_index, scope, subject, consumed_by, consumed_at FROM payment_consumption WHERE signature = ? ORDER BY event_index ASC`,
    signature,
  );
}

/**
 * Пересобрать зеркало `service_payments.consumed_by` из ledger'а. Идемпотентно; вызывается при
 * старте процесса и после каждого replay проекций. Возвращает число восстановленных строк.
 */
export function healPaymentConsumption(db: Db): number {
  return Number(db.run(
    `UPDATE service_payments
        SET consumed_by = (SELECT pc.consumed_by FROM payment_consumption pc
                            WHERE pc.signature = service_payments.signature AND pc.event_index = service_payments.event_index),
            consumed_at = (SELECT pc.consumed_at FROM payment_consumption pc
                            WHERE pc.signature = service_payments.signature AND pc.event_index = service_payments.event_index)
      WHERE consumed_by IS NULL
        AND EXISTS (SELECT 1 FROM payment_consumption pc
                     WHERE pc.signature = service_payments.signature AND pc.event_index = service_payments.event_index)`,
  ).changes);
}
