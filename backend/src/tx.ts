// Transaction pipeline for backend signers (crank): compute budget → v0
// message (+ our static Address Lookup Table) → keypair signature → send →
// confirm → decoded program error. Same shape as client/src/chain/tx.ts,
// minus wallet adapters and simulation sizing: the crank uses fixed CU limits
// per instruction mix so that a Switchboard reveal — whose preflight can
// disagree with the landing slot — never blocks a send.
import {
  AddressLookupTableAccount, ComputeBudgetProgram, Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction,
} from '@solana/web3.js';
import { CRANK_CU_PRICE_CAP, CRANK_CU_PRICE_FLOOR, CRANK_MAX_FEE_LAMPORTS } from './config.ts';
import { base58Encode } from './base58.ts';
import { customErrorCode } from './chain.ts';

/** Serialized transaction limit (one MTU). */
export const MAX_TX_BYTES = 1_232;

export class TxError extends Error {
  constructor(message: string, public readonly logs?: string[], public readonly code?: number, public readonly signature?: string) {
    super(message);
  }
}
/** The instruction set does not fit in one transaction (docs/06 §4.2 вывод 3 — configure LOOKUP_TABLE). */
export class TxTooLarge extends TxError {
  constructor(public readonly bytes: number, public readonly keys: number) {
    super(`transaction too large: ${keys} account keys${bytes ? `, ${bytes} bytes` : ''} > ${MAX_TX_BYTES} — configure LOOKUP_TABLE (scripts/create-lut.ts)`);
  }
}

export interface SendOpts {
  cuLimit: number;
  /** µlamports per CU; default = recent median for the writable accounts, clamped by `clampCuPrice` */
  cuPrice?: number;
  /** skip the RPC preflight (Switchboard reveal) — errors are then decoded from the confirmed tx logs */
  skipPreflight?: boolean;
  lookupTables?: AddressLookupTableAccount[];
  /**
   * §1.1: вызывается синхронно после подписи и ДО `sendRawTransaction`. Ledger операций пишет здесь
   * подпись, поэтому падение процесса сразу после отправки оставляет след, а не «ничего не было».
   * Исключение из хука означает «не отправлять» (fail closed).
   */
  onSigned?: (signature: string, extra: { rawTx: string; lastValidBlockHeight: number; cuPrice: number }) => void;
}

/**
 * Priority fee policy (docs/06 §4.2 вывод 4): median of the recent fees on our writable accounts,
 * floored at CRANK_CU_PRICE_FLOOR, capped at CRANK_CU_PRICE_CAP *and* at whatever keeps
 * `cuLimit × price` under CRANK_MAX_FEE_LAMPORTS (≤ 0.001 SOL per tx by default).
 */
export function clampCuPrice(medianMicroLamports: number, cuLimit: number, o = { floor: CRANK_CU_PRICE_FLOOR, cap: CRANK_CU_PRICE_CAP, maxFeeLamports: CRANK_MAX_FEE_LAMPORTS }): number {
  const budgetCap = Math.max(1, Math.floor((o.maxFeeLamports * 1_000_000) / Math.max(1, cuLimit)));
  const capped = Math.min(o.cap, budgetCap, Math.max(0, Math.floor(medianMicroLamports)));
  return Math.max(o.floor, capped);
}

export async function recentPriorityFee(connection: Connection, writable: PublicKey[]): Promise<number> {
  try {
    const fees = await connection.getRecentPrioritizationFees({ lockedWritableAccounts: writable.slice(0, 32) });
    const vals = fees.map((f) => f.prioritizationFee).filter((v) => v > 0).sort((a, b) => a - b);
    if (!vals.length) return 5_000;
    return vals[Math.floor(vals.length / 2)];
  } catch {
    return 5_000;
  }
}

function compile(payer: PublicKey, blockhash: string, ixs: TransactionInstruction[], cuLimit: number, cuPrice: number, luts?: AddressLookupTableAccount[]): VersionedTransaction {
  const msg = new TransactionMessage({
    payerKey: payer, recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }), ...ixs],
  }).compileToV0Message(luts);
  return new VersionedTransaction(msg);
}

/** Serialized size of the (unsigned) transaction, or -1 when the message itself cannot be encoded (too many keys). */
export function txSize(payer: PublicKey, ixs: TransactionInstruction[], luts?: AddressLookupTableAccount[]): number {
  try {
    return compile(payer, PublicKey.default.toBase58(), ixs, 1_400_000, 1, luts).serialize().length;
  } catch {
    return -1;
  }
}
export const fitsInTx = (payer: PublicKey, ixs: TransactionInstruction[], luts?: AddressLookupTableAccount[]): boolean => {
  const n = txSize(payer, ixs, luts);
  return n >= 0 && n <= MAX_TX_BYTES;
};

/** Load our static lookup table(s); missing / not-yet-created tables are skipped with a warning (the caller falls back to splitting). */
export async function loadLookupTables(connection: Connection, addresses: PublicKey[], log: (s: string) => void = () => {}): Promise<AddressLookupTableAccount[]> {
  const out: AddressLookupTableAccount[] = [];
  for (const a of addresses) {
    try {
      const r = await connection.getAddressLookupTable(a, { commitment: 'confirmed' });
      if (r.value) out.push(r.value); else log(`[tx] lookup table ${a.toBase58()} not found — transactions will be split`);
    } catch (e) {
      log(`[tx] lookup table ${a.toBase58()} unreadable: ${(e as Error).message}`);
    }
  }
  return out;
}

export async function sendAndConfirm(connection: Connection, payer: Keypair, ixs: TransactionInstruction[], opts: SendOpts): Promise<{ signature: string; logs: string[]; slot: number }> {
  const writable = ixs.flatMap((ix) => ix.keys.filter((k) => k.isWritable).map((k) => k.pubkey));
  const cuPrice = opts.cuPrice ?? clampCuPrice(await recentPriorityFee(connection, writable), opts.cuLimit);
  const size = txSize(payer.publicKey, ixs, opts.lookupTables);
  if (size < 0 || size > MAX_TX_BYTES) {
    const keys = new Set(ixs.flatMap((ix) => [ix.programId.toBase58(), ...ix.keys.map((k) => k.pubkey.toBase58())])).size;
    throw new TxTooLarge(size < 0 ? 0 : size, keys);
  }
  let attempt = 0;
  for (;;) {
    attempt++;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const tx = compile(payer.publicKey, blockhash, ixs, opts.cuLimit, cuPrice, opts.lookupTables);
    tx.sign([payer]);
    const signature = base58Encode(tx.signatures[0]);
    opts.onSigned?.(signature, { rawTx: Buffer.from(tx.serialize()).toString('base64'), lastValidBlockHeight, cuPrice });
    try {
      await connection.sendRawTransaction(tx.serialize(), { skipPreflight: opts.skipPreflight ?? false, maxRetries: 3, preflightCommitment: 'confirmed' });
      const conf = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
      const info = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      const logs = info?.meta?.logMessages ?? [];
      if (conf.value.err) {
        const code = customErrorCode({ message: JSON.stringify(conf.value.err), logs });
        throw new TxError(`tx ${signature} failed: ${JSON.stringify(conf.value.err)}${code !== undefined ? ` (custom ${code})` : ''}`, logs, code, signature);
      }
      return { signature, logs, slot: info?.slot ?? 0 };
    } catch (e) {
      if (e instanceof TxError) throw e;
      const m = String((e as Error)?.message ?? e);
      if (attempt === 1 && /block height exceeded|Blockhash not found|expired/i.test(m)) continue;
      const logs: string[] | undefined = (e as { logs?: string[] })?.logs;
      const code = customErrorCode(e);
      throw new TxError(code !== undefined && !m.includes(`custom ${code}`) ? `${m} (custom ${code})` : m, logs, code, signature);
    }
  }
}
