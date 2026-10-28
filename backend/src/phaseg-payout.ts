// Phase-G reward payouts (docs/MINIMAL-LAUNCH-CHECKLIST.md §5.2): plain $CG
// SPL transfers from the mint-authority wallet (which holds the reward float
// in phase G) to the player's ATA. One transfer per payout row; the caller
// (phaseg-staking.processPayouts) owns idempotency.
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { CG_MINT } from './config.ts';
import type { PayoutSender } from './phaseg-staking.ts';

export function makeCgPayoutSender(connection: Connection, authority: Keypair): PayoutSender {
  return async (wallet, amountMicro) => {
    const mint = new PublicKey(process.env.CG_MINT ?? CG_MINT);
    const owner = new PublicKey(wallet);
    const from = getAssociatedTokenAddressSync(mint, authority.publicKey);
    const to = getAssociatedTokenAddressSync(mint, owner);
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, to, owner, mint),
      createTransferInstruction(from, to, authority.publicKey, amountMicro),
    );
    return sendAndConfirmTransaction(connection, tx, [authority], { commitment: 'confirmed' });
  };
}
