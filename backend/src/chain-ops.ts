// Ledger исходящих транзакций (reports/REMEDIATION-DESIGN.md §1.1, §1.2).
//
// Сегодня каждая подсистема отправляет транзакцию по-своему и узнаёт результат по исключению:
// `sendAndConfirm()` вернулся — считаем, что «прошло»; бросил — считаем, что «не прошло». Между этими
// двумя утверждениями лежит весь класс находок 7, 8, 26, 31, 37, 61, 71, 72:
//
//   * подпись становится известна только ПОСЛЕ отправки, поэтому падение процесса между send и
//     UPDATE `tx_sig` не оставляет следа — следующий тик отправляет второй платёж по той же строке;
//   * «нет ответа» (таймаут RPC, рестарт) неотличимо от провала, а значит повтор разрешён там, где
//     транзакция могла уже исполниться;
//   * проверить постфактум нечего: в базе нет ни подписи, ни raw tx, ни последнего валидного блока.
//
// `chain_ops` — одна строка на бизнес-действие. Инварианты:
//   * `id = sha256(kind ‖ biz_key)` и `UNIQUE(kind, biz_key)` — повторный вызов находит ту же строку,
//     а не создаёт вторую операцию;
//   * `signature` пишется ДО `sendRawTransaction` (hook `beforeSend`), `status='sent'` — до отправки;
//   * `sent → confirmed` переводится только по `getSignatureStatuses`, никогда по «функция не бросила»;
//   * `failed` — только доказанный провал (подпись найдена в цепи и исполнена с `err`);
//   * `orphaned` — подпись старше `last_valid_block_height` и в цепи не найдена; только тогда разрешён
//     повтор (attempts+1, новая подпись).
// Таблица не входит в PROJECTION_TABLES: это факт о наших действиях, а не о цепи.
import { createHash } from 'node:crypto';
import type { Db } from './db.ts';
import { insertIgnore } from './sql.ts';

export type ChainOpStatus = 'intent' | 'signed' | 'sent' | 'landed' | 'confirmed' | 'failed' | 'orphaned';

export interface ChainOp {
  id: string;
  kind: string;
  biz_key: string;
  payload_hash: string;
  status: ChainOpStatus;
  signature: string | null;
  raw_tx: string | null;
  last_valid_block_height: number | null;
  cu_price: number | null;
  attempts: number;
  error: string | null;
  created_at: number;
  updated_at: number;
}

/** Провал бизнес-ключа: тот же (kind, biz_key) пришёл с другим payload — это не повтор, это ошибка. */
export class ChainOpConflict extends Error {
  constructor(kind: string, bizKey: string) {
    super(`chain op ${kind}:${bizKey} already exists with a different payload`);
    this.name = 'ChainOpConflict';
  }
}

/** Операция уже отправлена и её судьба ещё неизвестна — повторять нельзя, надо дождаться reconcile. */
export class ChainOpInFlight extends Error {
  constructor(public readonly op: ChainOp) {
    super(`chain op ${op.kind}:${op.biz_key} is ${op.status} (signature ${op.signature ?? '—'}); waiting for reconciliation`);
    this.name = 'ChainOpInFlight';
  }
}

export const chainOpId = (kind: string, bizKey: string): string =>
  createHash('sha256').update(`${kind}\u0000${bizKey}`, 'utf8').digest('hex');

/** Стабильный JSON (сортировка ключей) — иначе один и тот же интент давал бы разные хеши. */
export function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
}

export const payloadHash = (intent: unknown): string =>
  createHash('sha256').update(stableJson(intent), 'utf8').digest('hex');

export function findChainOp(db: Db, kind: string, bizKey: string): ChainOp | undefined {
  return db.get<ChainOp>(`SELECT * FROM chain_ops WHERE kind = ? AND biz_key = ?`, kind, bizKey);
}

const nowS = () => Math.floor(Date.now() / 1000);

/**
 * Начать операцию: вставить интент или вернуть уже существующий.
 * Вставка идёт через `UNIQUE(kind, biz_key)`, поэтому гонка двух воркеров оставляет ровно одну строку.
 */
export function beginChainOp(
  db: Db,
  spec: { kind: string; bizKey: string; payload: unknown; cuPrice?: number },
  t = nowS(),
): ChainOp {
  const id = chainOpId(spec.kind, spec.bizKey);
  const hash = payloadHash(spec.payload);
  db.run(
    insertIgnore('chain_ops', ['id', 'kind', 'biz_key', 'payload_hash', 'status', 'cu_price', 'attempts', 'created_at', 'updated_at']),
    id, spec.kind, spec.bizKey, hash, 'intent', spec.cuPrice ?? null, 0, t, t,
  );
  const op = db.get<ChainOp>(`SELECT * FROM chain_ops WHERE id = ?`, id);
  if (!op) throw new Error(`chain op ${id} vanished`);
  if (op.payload_hash !== hash && op.status !== 'orphaned') throw new ChainOpConflict(spec.kind, spec.bizKey);
  return op;
}

/** Записать изменения операции. Никаких переходов «по факту отсутствия исключения» здесь нет — только явные. */
export function updateChainOp(db: Db, id: string, patch: Partial<Pick<ChainOp, 'status' | 'signature' | 'raw_tx' | 'last_valid_block_height' | 'cu_price' | 'attempts' | 'error'>>, t = nowS()): void {
  const cols = Object.keys(patch) as (keyof typeof patch)[];
  if (cols.length === 0) return;
  const set = cols.map((c) => `${c} = ?`).join(', ');
  db.run(`UPDATE chain_ops SET ${set}, updated_at = ? WHERE id = ?`, ...cols.map((c) => patch[c] as string | number | null), t, id);
}

/** Подпись записывается ДО отправки: строка «signed» — это обещание, что такая транзакция существует. */
export function recordSigned(db: Db, id: string, s: { signature: string; rawTx?: string | null; lastValidBlockHeight?: number | null; cuPrice?: number | null }, t = nowS()): void {
  const cur = db.get<{ attempts: number }>(`SELECT attempts FROM chain_ops WHERE id = ?`, id);
  updateChainOp(db, id, {
    status: 'signed',
    signature: s.signature,
    raw_tx: s.rawTx ?? null,
    last_valid_block_height: s.lastValidBlockHeight ?? null,
    cu_price: s.cuPrice ?? null,
    attempts: (cur?.attempts ?? 0) + 1,
    error: null,
  }, t);
}

/** Отправлено, но подтверждения ещё нет. Ставится ДО сетевого вызова. */
export function recordSent(db: Db, id: string, t = nowS()): void {
  updateChainOp(db, id, { status: 'sent' }, t);
}

export function recordLanded(db: Db, id: string, t = nowS()): void {
  updateChainOp(db, id, { status: 'landed' }, t);
}

export function recordConfirmed(db: Db, id: string, signature: string, t = nowS()): void {
  updateChainOp(db, id, { status: 'confirmed', signature, error: null }, t);
}

export function recordFailed(db: Db, id: string, error: string, t = nowS()): void {
  updateChainOp(db, id, { status: 'failed', error }, t);
}

export interface StatusSource {
  getSignatureStatuses(sigs: string[], cfg: { searchTransactionHistory: boolean }): Promise<{ value: ({ confirmationStatus?: string; err: unknown } | null)[] }>;
  getBlockHeight?(commitment?: 'confirmed' | 'finalized'): Promise<number>;
}

export interface ReconcileOpsResult { checked: number; confirmed: number; failed: number; orphaned: number; pending: number }

/**
 * Досверить отправленные операции по подписи (§1.2).
 *
 * `tip` передаётся явно (или берётся из `getBlockHeight`), чтобы тест мог зафиксировать момент:
 * операция считается `orphaned` только когда блок новее её `last_valid_block_height`, т.е. транзакция
 * уже не может попасть в цепь. Всё, что «нет ответа», остаётся `sent` и ждёт следующего прохода.
 */
export async function reconcileChainOps(
  db: Db,
  connection: StatusSource,
  opts: { limit?: number; tip?: number; olderThanS?: number; t?: number } = {},
): Promise<ReconcileOpsResult> {
  const limit = opts.limit ?? 100;
  const t = opts.t ?? nowS();
  const olderThanS = opts.olderThanS ?? 0;
  const rows = db.all<ChainOp>(
    `SELECT * FROM chain_ops WHERE status IN ('signed', 'sent', 'landed') AND updated_at <= ? ORDER BY updated_at ASC LIMIT ?`,
    t - olderThanS, limit,
  );
  const out: ReconcileOpsResult = { checked: rows.length, confirmed: 0, failed: 0, orphaned: 0, pending: 0 };
  if (rows.length === 0) return out;
  const tip = opts.tip ?? (connection.getBlockHeight ? await connection.getBlockHeight('confirmed') : 0);
  const sigs = rows.map((r) => r.signature!).filter(Boolean);
  const value = sigs.length ? (await connection.getSignatureStatuses(sigs, { searchTransactionHistory: true })).value : [];
  const bySig = new Map<string, { confirmationStatus?: string; err: unknown } | null>();
  sigs.forEach((s, i) => bySig.set(s, value[i] ?? null));
  for (const op of rows) {
    const st = op.signature ? bySig.get(op.signature) ?? null : null;
    if (st && st.err) { recordFailed(db, op.id, JSON.stringify(st.err), t); out.failed++; continue; }
    if (st && (st.confirmationStatus === 'finalized' || st.confirmationStatus === 'confirmed')) {
      recordConfirmed(db, op.id, op.signature!, t);
      out.confirmed++;
      continue;
    }
    // Неизвестна цепи и блок уже прошёл last_valid_block_height → транзакция не может попасть в цепь.
    const expired = op.last_valid_block_height !== null && tip > op.last_valid_block_height;
    if (!st && expired) {
      updateChainOp(db, op.id, { status: 'orphaned', error: 'expired: not found on chain past last_valid_block_height' }, t);
      out.orphaned++;
      continue;
    }
    out.pending++;
  }
  return out;
}

/** Публичный вид операции для API/оператора (без raw_tx). */
export function chainOpView(op: ChainOp) {
  return {
    id: op.id, kind: op.kind, bizKey: op.biz_key, status: op.status, signature: op.signature,
    attempts: op.attempts, error: op.error, updatedAt: new Date(op.updated_at * 1000).toISOString(),
  };
}

/** Что отправитель сообщает ledger'у ПЕРЕД сетевым вызовом. */
export interface OpSendHooks {
  /** Вызывается синхронно после подписи и ДО `sendRawTransaction`. */
  beforeSend(signature: string, extra: { rawTx?: string | null; lastValidBlockHeight?: number | null; cuPrice?: number | null }): void;
}

/**
 * Единственный путь «отправить операцию» для подсистем (§1.1).
 *
 *   * операция уже `confirmed` → ничего не отправляем, возвращаем ту же подпись (`reused: true`);
 *   * операция `signed|sent|landed` → `ChainOpInFlight`: судьба неизвестна, повтор запрещён до reconcile;
 *   * `failed`/`orphaned`/`intent` → отправляем; подпись фиксируется в ledger'е до провода.
 *
 * Провал фиксируется как `failed` только когда отправитель доказал, что транзакция исполнена с ошибкой
 * (`proven: true`). Всё остальное — «отправлено, неизвестно» и ждёт `reconcileChainOps`.
 */
export async function submitChainOp(
  db: Db,
  spec: { kind: string; bizKey: string; payload: unknown; cuPrice?: number },
  send: (hooks: OpSendHooks) => Promise<{ signature: string; proven?: boolean; error?: string }>,
  t: number = nowS(),
): Promise<{ signature: string; reused: boolean; status: ChainOpStatus }> {
  const op = beginChainOp(db, spec, t);
  if (op.status === 'confirmed' && op.signature) return { signature: op.signature, reused: true, status: op.status };
  if (op.status === 'signed' || op.status === 'sent' || op.status === 'landed') throw new ChainOpInFlight(op);
  let sent: string | null = null;
  try {
    const r = await send({
      beforeSend(signature, extra) {
        sent = signature;
        recordSigned(db, op.id, { signature, ...extra }, t);
        recordSent(db, op.id, t);
      },
    });
    if (!sent) {
      // Отправитель не вызвал beforeSend — подпись неизвестна, ledger не может отвечать за операцию.
      throw new Error(`chain op ${spec.kind}:${spec.bizKey} was sent without recording its signature`);
    }
    recordLanded(db, op.id, t);
    return { signature: r.signature, reused: false, status: 'landed' };
  } catch (e) {
    const known = db.get<ChainOp>(`SELECT * FROM chain_ops WHERE id = ?`, op.id)!;
    const proven = (e as { provenFailure?: boolean }).provenFailure === true && known.signature !== null;
    if (proven) recordFailed(db, op.id, String((e as Error)?.message ?? e), t);
    // Иначе статус уже `signed`/`sent` (если подпись успели записать) — повтор упрётся в in-flight.
    throw e;
  }
}
