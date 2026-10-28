// Small adapters between API payloads and the phase-V instruction builders.
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
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
