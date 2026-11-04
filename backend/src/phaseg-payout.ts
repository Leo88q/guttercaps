// Phase-G reward payouts (docs/MINIMAL-LAUNCH-CHECKLIST.md §5.2): plain $CG
// SPL transfers from the mint-authority wallet (which holds the reward float
// in phase G) to the player's ATA. One transfer per payout row.
//
// Идемпотентность больше не держится на «успели записать tx_sig после отправки» (находки 7/71):
// подпись фиксируется в `chain_ops` ДО провода по бизнес-ключу `payout:<id>`. Падение процесса между
// send и UPDATE `phaseg_payouts` больше не даёт второй платёж: следующий тик находит операцию и либо
// ждёт reconcile (`ChainOpInFlight`), либо переиспользует её подпись, не отправляя ничего.
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { CG_MINT } from './config.ts';
import type { PayoutTask, PayoutSender } from './phaseg-staking.ts';
import type { Db } from './db.ts';
import { submitChainOp } from './chain-ops.ts';
import { sendAndConfirm } from './tx.ts';

/** ATA create + SPL transfer — с запасом на idempotent-ветку spl-token. */
export const CU_TRANSFER = 60_000;

export function makeCgPayoutSender(connection: Connection, authority: Keypair, ops?: Db): PayoutSender {
  return async (wallet: string, amountMicro: bigint, task?: PayoutTask): Promise<string> => {
    const mint = new PublicKey(process.env.CG_MINT ?? CG_MINT);
    const owner = new PublicKey(wallet);
    const from = getAssociatedTokenAddressSync(mint, authority.publicKey);
    const to = getAssociatedTokenAddressSync(mint, owner);
    const ixs = [
      createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, to, owner, mint),
      createTransferInstruction(from, to, authority.publicKey, amountMicro),
    ];
    // Без ledger'а (разовые скрипты, тесты) поведение прежнее.
    if (!ops || !task) return (await sendAndConfirm(connection, authority, ixs, { cuLimit: CU_TRANSFER })).signature;
    const r = await submitChainOp(
      ops,
      { kind: task.kind, bizKey: task.bizKey, payload: task.payload },
      async (hooks) => {
        const res = await sendAndConfirm(connection, authority, ixs, {
          cuLimit: CU_TRANSFER,
          onSigned: (signature, extra) => hooks.beforeSend(signature, {
            rawTx: extra.rawTx,
            lastValidBlockHeight: extra.lastValidBlockHeight,
            cuPrice: extra.cuPrice,
          }),
        });
        return { signature: res.signature };
      },
    );
    return r.signature;
  };
}
