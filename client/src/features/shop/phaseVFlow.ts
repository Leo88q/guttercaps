// Small adapters between API payloads and the phase-V instruction builders.
import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { LOOKUP_TABLE } from '@/app/config';
import { appLookupTables, fitsInTx, sendTx, type WalletLike } from '@/chain/tx';
import { oracleAuthIx, settlePackIx, grantMintIx, type SettlePayloadLike } from './phaseV';

export { buyPackIx } from './phaseV';

/** [Ed25519 oracle ix, settle_pack ix] — the ed25519 ix must come first. */
export function grantOrSettleIx(
  payload: SettlePayloadLike,
  args: { relayer: PublicKey; treasury: PublicKey; mint?: PublicKey | null },
): TransactionInstruction[] {
  return [oracleAuthIx(payload), settlePackIx(payload, args)];
}

/** [Ed25519 oracle ix, grant_mint ix] for fusion results. */
export function grantIx(
  payload: SettlePayloadLike,
  args: { relayer: PublicKey },
): TransactionInstruction[] {
  return [oracleAuthIx(payload), grantMintIx(payload, args)];
}

/**
 * Находка 24: `settle_pack` несёт метаданные каждого листа, поэтому даже 5 листьев не влезают в
 * legacy-транзакцию (замер: 2533 B против предела 1232 B). С v0-транзакцией и статической lookup
 * таблицей тот же заказ — 1162 B, без таблицы не помещается ни один лист. Поэтому отправка идёт одним
 * путём: взять таблицу, убедиться, что пакет влезает, и только потом просить подпись. Отказ до отправки
 * лучше отказа после эскроу — оплаченный, но неисполнимый заказ возвращать нечем, кроме ручного refund.
 */
export async function sendPhaseVSettle(
  connection: Connection,
  wallet: WalletLike,
  ixs: TransactionInstruction[],
): Promise<{ signature: string }> {
  const lookupTables = await appLookupTables(connection, LOOKUP_TABLE);
  if (lookupTables.length === 0) {
    throw new Error('Phase V requires VITE_LOOKUP_TABLE: without a lookup table settle_pack does not fit into 1232 bytes');
  }
  if (!fitsInTx(wallet.publicKey, ixs, lookupTables)) {
    throw new Error('settle_pack does not fit into one transaction even with the lookup table — fewer leaves per order are required');
  }
  return sendTx(connection, wallet, ixs, { lookupTables, cuLimit: 800_000 });
}
