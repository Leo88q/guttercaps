import { checkTransactionAccess } from './access';
import { errorSnapshot } from './errorSnapshot';
// One pipeline for every transaction: compute budget → v0 message → wallet
// signature (+ local partial signers) → send → confirm → decoded error.
import {
  ComputeBudgetProgram, Connection, PublicKey, TransactionMessage, VersionedTransaction,
  type AddressLookupTableAccount, type Keypair, type TransactionInstruction, type TransactionSignature,
} from '@solana/web3.js';
import { humanizeTxError, isBlockhashExpired } from './errors';
import { base58Encode } from '@/shared/lib/base58';

export interface WalletLike {
  publicKey: PublicKey;
  signTransaction<T extends VersionedTransaction>(tx: T): Promise<T>;
}

export interface SendOptions {
  /** compute unit limit; defaults to a simulation-derived value ×1.2 */
  cuLimit?: number;
  /** microLamports per CU; default = recent median clamped to [1_000, 200_000] */
  cuPrice?: number;
  signers?: Keypair[];
  lookupTables?: AddressLookupTableAccount[];
  /** skip simulation (e.g. Switchboard reveal, whose sim needs an oracle signature) */
  skipPreflight?: boolean;
  onSigned?: (signature: string) => void;
  onSent?: (signature: string) => void;
}

export class TxError extends Error {
  constructor(public readonly cause: unknown, public readonly logs?: string[]) {
    super(errorSnapshot(cause).message);
  }
}

export async function recentPriorityFee(connection: Connection, accounts: PublicKey[]): Promise<number> {
  try {
    const fees = await connection.getRecentPrioritizationFees({ lockedWritableAccounts: accounts.slice(0, 32) });
    const vals = fees.map((f) => f.prioritizationFee).filter((v) => v > 0).sort((a, b) => a - b);
    if (!vals.length) return 5_000;
    const median = vals[Math.floor(vals.length / 2)];
    return Math.min(200_000, Math.max(1_000, median));
  } catch {
    return 5_000;
  }
}

/** Serialized transaction limit (one MTU). */
export const MAX_TX_BYTES = 1_232;

/**
 * Does `[cu limit, cu price, ...ixs]` fit in one transaction (with the given lookup tables)?
 * `reveal_randomness + open_pack` carries 33–44 account keys and only fits with our static LUT
 * (docs/06 §4.2 вывод 3); callers split into two transactions when this says no.
 */
export function fitsInTx(payer: PublicKey, ixs: TransactionInstruction[], lookupTables?: AddressLookupTableAccount[]): boolean {
  try {
    const msg = new TransactionMessage({
      payerKey: payer, recentBlockhash: PublicKey.default.toBase58(),
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }), ...ixs],
    }).compileToV0Message(lookupTables);
    return new VersionedTransaction(msg).serialize().length <= MAX_TX_BYTES;
  } catch {
    return false; // too many keys to even encode the message
  }
}

let lutCache: { key: string; value: AddressLookupTableAccount[] } | undefined;
/** Our static lookup table (VITE_LOOKUP_TABLE), fetched once per session; missing/unset → []. */
export async function appLookupTables(connection: Connection, address: PublicKey | undefined): Promise<AddressLookupTableAccount[]> {
  if (!address) return [];
  const key = address.toBase58();
  if (lutCache?.key === key) return lutCache.value;
  try {
    const r = await connection.getAddressLookupTable(address, { commitment: 'confirmed' });
    lutCache = { key, value: r.value ? [r.value] : [] };
  } catch {
    lutCache = { key, value: [] };
  }
  return lutCache.value;
}

export async function buildV0Tx(
  connection: Connection,
  payer: PublicKey,
  ixs: TransactionInstruction[],
  opts: SendOptions = {},
): Promise<{ tx: VersionedTransaction; blockhash: string; lastValidBlockHeight: number }> {
  const writable = ixs.flatMap((ix) => ix.keys.filter((k) => k.isWritable).map((k) => k.pubkey));
  const cuPrice = opts.cuPrice ?? (await recentPriorityFee(connection, writable));
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

  let cuLimit = opts.cuLimit;
  if (!cuLimit) {
    // simulate once without a limit to size it
    const simMsg = new TransactionMessage({
      payerKey: payer, recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...ixs],
    }).compileToV0Message(opts.lookupTables);
    const simTx = new VersionedTransaction(simMsg);
    const sim = await connection.simulateTransaction(simTx, { sigVerify: false, replaceRecentBlockhash: true });
    if (sim.value.err && !opts.skipPreflight) {
      throw new TxError({ message: JSON.stringify(sim.value.err), logs: sim.value.logs ?? undefined }, sim.value.logs ?? undefined);
    }
    cuLimit = Math.min(1_400_000, Math.ceil((sim.value.unitsConsumed ?? 200_000) * 1.2) + 20_000);
  }

  const msg = new TransactionMessage({
    payerKey: payer, recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }),
      ...ixs,
    ],
  }).compileToV0Message(opts.lookupTables);
  return { tx: new VersionedTransaction(msg), blockhash, lastValidBlockHeight };
}

export async function sendTx(
  connection: Connection,
  wallet: WalletLike,
  ixs: TransactionInstruction[],
  opts: SendOptions = {},
): Promise<{ signature: TransactionSignature; logs: string[] }> {
  await checkTransactionAccess(wallet.publicKey.toBase58(), ixs);
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      const { tx, blockhash, lastValidBlockHeight } = await buildV0Tx(connection, wallet.publicKey, ixs, opts);
      if (opts.signers?.length) tx.sign(opts.signers);
      await checkTransactionAccess(wallet.publicKey.toBase58(), ixs);
      const signed = await wallet.signTransaction(tx);
      const sigBytes = signed.signatures[0];
      const signature = base58Encode(sigBytes);
      opts.onSigned?.(signature);
      await connection.sendRawTransaction(signed.serialize(), { skipPreflight: opts.skipPreflight ?? false, maxRetries: 3, preflightCommitment: 'confirmed' });
      opts.onSent?.(signature);
      const conf = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
      if (conf.value.err) {
        const txInfo = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
        throw new TxError({ message: `custom program error: ${JSON.stringify(conf.value.err)}`, logs: txInfo?.meta?.logMessages ?? undefined }, txInfo?.meta?.logMessages ?? undefined);
      }
      const txInfo = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      return { signature, logs: txInfo?.meta?.logMessages ?? [] };
    } catch (e) {
      // one automatic rebuild on expired blockhash, never on user rejection / program error
      if (attempt === 1 && isBlockhashExpired(e)) continue;
      throw e instanceof TxError ? e : new TxError(e);
    }
  }
}

/** Dry-run helper for the confirmation modal: SOL / token deltas for the signer. */
export async function previewBalanceDelta(
  connection: Connection,
  payer: PublicKey,
  ixs: TransactionInstruction[],
  watchTokenAccounts: PublicKey[] = [],
): Promise<{ lamports: bigint; tokens: Record<string, bigint>; unitsConsumed: number; err?: string }> {
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  const before = await connection.getMultipleAccountsInfo([payer, ...watchTokenAccounts]);
  const sim = await connection.simulateTransaction(tx, {
    sigVerify: false, replaceRecentBlockhash: true,
    accounts: { encoding: 'base64', addresses: [payer, ...watchTokenAccounts].map((k) => k.toBase58()) },
  });
  const out: { lamports: bigint; tokens: Record<string, bigint>; unitsConsumed: number; err?: string } = { lamports: 0n, tokens: {}, unitsConsumed: sim.value.unitsConsumed ?? 0 };
  if (sim.value.err) out.err = humanizeTxError({ message: JSON.stringify(sim.value.err), logs: sim.value.logs });
  const after = sim.value.accounts ?? [];
  const lamBefore = BigInt(before[0]?.lamports ?? 0);
  const lamAfter = BigInt(after[0]?.lamports ?? Number(lamBefore));
  out.lamports = lamAfter - lamBefore;
  watchTokenAccounts.forEach((k, i) => {
    const b = before[i + 1]?.data;
    const a = after[i + 1]?.data?.[0];
    const amt = (buf: Uint8Array | undefined) => (buf && buf.length >= 72 ? new DataView(buf.buffer, buf.byteOffset).getBigUint64(64, true) : 0n);
    const aBuf = a ? Uint8Array.from(atob(a), (c) => c.charCodeAt(0)) : undefined;
    out.tokens[k.toBase58()] = amt(aBuf) - amt(b ? new Uint8Array(b) : undefined);
  });
  return out;
}
