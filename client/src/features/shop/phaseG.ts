// Phase-G pack purchase (docs/MINIMAL-LAUNCH-CHECKLIST.md §6.1): instead of a
// program transaction the player sends a plain payment (transfer + memo) to the
// treasury; the backend verifies it, rolls the pack from the seed committed at
// order creation and mints the chips. This module holds the pure pieces
// (payment instruction builder, mint polling) — the hook wires wallet + API.
import { PublicKey, SystemProgram, TransactionInstruction, type Connection } from '@solana/web3.js';
import type { ResponseOf } from '@/api/client';

// SPL Token / ATA instructions are hand-built here on purpose: importing
// @solana/spl-token would pull it into the preloaded solana chunk and over
// the critical-path bundle budget. The layouts are tiny and frozen.
export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

export function associatedTokenAddress(mint: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM,
  )[0];
}

/** ATA create (idempotent variant = instruction 1): no-ops if the account exists. */
export function createAtaIdempotentIx(payer: PublicKey, ata: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.of(1),
  });
}

/** SPL Token transfer (instruction 3 + u64 amount). */
export function tokenTransferIx(source: PublicKey, dest: PublicKey, authority: PublicKey, amount: bigint): TransactionInstruction {
  const data = Buffer.alloc(9);
  data.writeUInt8(3, 0);
  data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

export type PackOrderCreated = ResponseOf<'/packs/order', 'post'>;
export type PackOrder = ResponseOf<'/packs/order/{id}', 'get'>;
export type PhaseGCurrency = 'SOL' | 'USDC' | 'CG';

export const SPL_MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcQb');

export function memoInstruction(memo: string): TransactionInstruction {
  return new TransactionInstruction({ programId: SPL_MEMO_PROGRAM, keys: [], data: Buffer.from(memo, 'utf8') });
}

/** The exact payment the backend will verify: amount → payTo, memo attached. */
export function buildPaymentInstructions(order: PackOrderCreated, buyer: PublicKey): TransactionInstruction[] {
  const amount = BigInt(order.amount ?? '0');
  const payTo = new PublicKey(order.payTo ?? '');
  const ixs: TransactionInstruction[] = [];
  if (order.currency === 'SOL' || !order.mint) {
    ixs.push(SystemProgram.transfer({ fromPubkey: buyer, toPubkey: payTo, lamports: amount }));
  } else {
    const mint = new PublicKey(order.mint ?? '');
    const source = associatedTokenAddress(mint, buyer);
    ixs.push(createAtaIdempotentIx(buyer, payTo, new PublicKey(order.payToOwner ?? ''), mint));
    ixs.push(tokenTransferIx(source, payTo, buyer, amount));
  }
  ixs.push(memoInstruction(order.memo ?? ''));
  return ixs;
}

/**
 * Poll the order until the mint crank lands it. Bounded: the backend expires
 * unpaid orders and the crank ticks every few seconds; ~2 minutes is generous.
 */
export async function waitForOrderMinted(
  fetchOrder: () => Promise<PackOrder>,
  opts: { tries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<PackOrder> {
  const tries = opts.tries ?? 48;
  const delayMs = opts.delayMs ?? 2500;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: PackOrder | undefined;
  for (let i = 0; i < tries; i++) {
    last = await fetchOrder();
    if (last.status === 'minted' || last.status === 'expired' || last.status === 'failed') return last;
    await sleep(delayMs);
  }
  return last as PackOrder;
}


// ---------------------------------------------------------------- ожидание подтверждения (находка 11)
//
// Раньше после `wallet.sendTransaction` клиент сразу звал backend, который читает транзакцию на
// `confirmed`/`finalized`. Если RPC ещё не видел подпись, вызов падал ПОСЛЕ фактической отправки: деньги
// уходили, заказ оставался `created`, а повтор требовал новой подписи. Теперь: дождаться подтверждения,
// затем подтверждать на backend ТОЙ ЖЕ подписью с повтором (idempotent-путь), и помнить подпись, чтобы
// её можно было дослать после перезагрузки страницы.

/** Как backend отвечает на «транзакцию пока не видно» — это повод повторить, а не новая оплата. */
const TRANSIENT_CODES = new Set(['tx_not_found', 'tx_not_found_yet', 'http_502', 'http_503', 'http_504', 'network']);

/** Ошибка «повтори позже»: тот же signature, никакой новой транзакции. */
export function isTransientConfirmError(e: unknown): boolean {
  const err = e as { code?: string; status?: number } | null;
  if (!err) return false;
  if (err.code && TRANSIENT_CODES.has(err.code)) return true;
  return typeof err.status === 'number' && err.status >= 500;
}

export type SignatureWait = 'confirmed' | 'failed' | 'unknown';

/**
 * Дождаться, пока подпись станет видимой цепи. Не отправляет ничего повторно: только читает статус.
 * `timeout` — не ошибка: транзакция могла попасть в блок, backend всё равно проверит её сам.
 */
export async function waitForSignature(
  connection: Pick<Connection, 'getSignatureStatuses'>,
  signature: string,
  opts: { tries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<SignatureWait> {
  const tries = opts.tries ?? 30;
  const delayMs = opts.delayMs ?? 1_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < tries; i++) {
    const st = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })
      .then((r) => r?.value?.[0] ?? null)
      .catch(() => null);
    if (st) {
      if (st.err) return 'failed';
      if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return 'confirmed';
    }
    await sleep(delayMs);
  }
  return 'unknown';
}

/**
 * Подтвердить уже отправленную оплату на backend, повторяя ТРАНЗИЕНТНЫЕ отказы с той же подписью.
 * Новая транзакция здесь не создаётся никогда: повтор идёт ровно по сохранённой подписи.
 */
export async function confirmWithRetry<T>(
  confirm: (signature: string) => Promise<T>,
  signature: string,
  opts: { tries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const tries = opts.tries ?? 8;
  const delayMs = opts.delayMs ?? 1_500;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await confirm(signature);
    } catch (e) {
      lastError = e;
      if (!isTransientConfirmError(e) || i === tries - 1) throw e;
      await sleep(delayMs);
    }
  }
  throw lastError;
}

/** Куда клиент кладёт подпись отправленной, но ещё не подтверждённой оплаты (переживает перезагрузку). */
export interface SignatureStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
const paymentKey = (orderId: number) => `gc:pendingPayment:${orderId}`;

export function rememberPayment(store: SignatureStore | null, orderId: number, signature: string): void {
  try { store?.setItem(paymentKey(orderId), signature); } catch { /* приватный режим: переживём */ }
}
export function rememberedPayment(store: SignatureStore | null, orderId: number): string | null {
  try { return store?.getItem(paymentKey(orderId)) ?? null; } catch { return null; }
}
export function forgetPayment(store: SignatureStore | null, orderId: number): void {
  try { store?.removeItem(paymentKey(orderId)); } catch { /* ignore */ }
}
