// Verify-by-execution (reports/REMEDIATION-DESIGN.md §1.4, находка 2).
//
// Phase-V подтверждение оплаченного заказа принимало любую транзакцию, в чьих ключах встречается id
// программы `settle`: `verifySettleTx` смотрел только на `staticAccountKeys`. Транзакция, которая
// merely упоминает программу (инструкция другой программы с этим адресом в аккаунтах, неудачная
// попытка, чужой вызов `grant_mint` вместо `settle_pack`), проходила проверку — и заказ закрывался
// как «сминтился», хотя минта не было.
//
// Здесь проверяется ИСПОЛНЕНИЕ, а не упоминание:
//   * транзакция существует, `meta.err == null` (значит, не упала и её внутренние инструкции тоже);
//   * среди исполненных инструкций (верхний уровень + inner) есть инструкция НУЖНОЙ программы;
//   * её первые 8 байт — anchor-дискриминатор нужного обработчика (`settle_pack` / `grant_mint`);
//   * среди её аккаунтов есть ожидаемый PDA (order PDA / grant receipt) — то есть это наш заказ,
//     а не чужой, подписанный тем же оракулом.
// Чужое доказательство (другая программа, другой обработчик, другой заказ) — отказ, а не «наверное, прошло».
import { createHash } from 'node:crypto';
import { PublicKey, type Connection } from '@solana/web3.js';

/** Инструкция в том виде, в котором она исполнялась цепью. */
export interface ExecutedInstruction {
  programId: string;
  /** Все аккаунты инструкции по порядку (ключи сообщения + загруженные из lookup-таблиц). */
  accounts: string[];
  data: Uint8Array;
  /** true для инструкций внутри CPI. */
  inner: boolean;
}

/** Anchor-дискриминатор инструкции: `sha256("global:<name>")[0..8]`. */
export function anchorDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

/** Все исполненные инструкции транзакции; null — транзакции нет или она не прочитана. */
export async function readExecutedInstructions(
  connection: Connection,
  signature: string,
): Promise<{ ok: boolean; instructions: ExecutedInstruction[] } | null> {
  const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }).catch(() => null);
  if (!tx) return null;
  const msg = tx.transaction.message;
  const keys = msg.getAccountKeys();
  const keyAt = (i: number): string => keys.get(i)?.toBase58() ?? '';
  const instructions: ExecutedInstruction[] = [];
  // Верхний уровень: compiledInstructions есть у VersionedMessage; legacy Message даёт instructions.
  const compiled = (msg as unknown as { compiledInstructions?: { programIdIndex: number; accountKeyIndexes: number[]; data: Uint8Array }[] }).compiledInstructions;
  if (compiled) {
    for (const ix of compiled) {
      instructions.push({
        programId: keyAt(ix.programIdIndex),
        accounts: ix.accountKeyIndexes.map(keyAt),
        data: Uint8Array.from(ix.data ?? []),
        inner: false,
      });
    }
  }
  for (const group of tx.meta?.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      instructions.push({
        programId: keyAt(ix.programIdIndex),
        accounts: ix.accounts.map(keyAt),
        data: Uint8Array.from(ix.data ? Buffer.from(ix.data, 'base64') : []),
        inner: true,
      });
    }
  }
  return { ok: tx.meta?.err == null, instructions };
}

export interface ExecutedSpec {
  /** Программа, которая обязана была исполниться. */
  program: PublicKey;
  /** Имя anchor-инструкции (`settle_pack`, `grant_mint`, …). */
  ix: string;
  /** PDA, который обязан быть среди аккаунтов этой инструкции. */
  account?: PublicKey;
}

export type ExecutedCheck =
  | { ok: true; inner: boolean }
  | { ok: false; reason: 'tx_not_found' | 'tx_failed' | 'instruction_missing' | 'wrong_account' };

/**
 * Доказать, что транзакция ИСПОЛНИЛА нужную инструкцию нужной программы над нужным аккаунтом.
 * Возвращает причину отказа вместо boolean: вызывающему нужно отличать «ещё не видно» от «не то».
 */
export async function assertExecuted(connection: Connection, signature: string, spec: ExecutedSpec): Promise<ExecutedCheck> {
  const tx = await readExecutedInstructions(connection, signature);
  if (!tx) return { ok: false, reason: 'tx_not_found' };
  if (!tx.ok) return { ok: false, reason: 'tx_failed' };
  const want = anchorDiscriminator(spec.ix);
  const program = spec.program.toBase58();
  const candidates = tx.instructions.filter((ix) =>
    ix.programId === program && ix.data.length >= 8 && Buffer.from(ix.data.subarray(0, 8)).equals(want));
  if (candidates.length === 0) return { ok: false, reason: 'instruction_missing' };
  if (!spec.account) return { ok: true, inner: candidates.some((c) => c.inner) };
  const account = spec.account.toBase58();
  const hit = candidates.find((c) => c.accounts.includes(account));
  if (!hit) return { ok: false, reason: 'wrong_account' };
  return { ok: true, inner: hit.inner };
}
