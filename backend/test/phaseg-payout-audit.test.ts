// Reproducer: Phase-G staking payouts are at-least-once, and the "sent" mark is written *after* the
// transfer (backend/src/phaseg-staking.ts:120-134, backend/src/phaseg-payout.ts:14-26).
//
// `processPayouts` sends the tokens first and only then flips `phaseg_payouts.status` to 'sent'. Every
// way that second step can be lost — process killed mid-deploy, an RPC error returned after the
// transaction landed, a crash between the two `db.run` calls — leaves the row 'pending', and the next
// crank tick sends the same amount again. There is no idempotency key on chain: the transfer
// instruction carries no memo and nothing on the payout row is committed before the send.
//
// The same shape exists on the claim side: `claimRewards` (phaseg-staking.ts:104-115) checks for a
// pending payout and inserts one in two separate statements with no transaction and no UNIQUE index on
// `phaseg_payouts(wallet) WHERE status = 'pending'` (db.ts:481-490), so two writers (HTTP API + the
// crank process, both against the same SQLite file) can each create a payout for the same balance.
import { describe, expect, it } from 'vitest';
import { Db } from '../src/db.ts';
import { claimRewards, processPayouts } from '../src/phaseg-staking.ts';

describe('phaseg payout durability', () => {
  it('a transfer whose status update is lost is sent twice for one payout row', async () => {
    const db = new Db(':memory:');
    db.run(`INSERT INTO phaseg_rewards (wallet, pending_micro, claimed_micro, updated_at) VALUES ('W', '5000000', '0', 0)`);

    const claim = claimRewards(db, 'W', 1_000);
    expect(claim.amountMicro).toBe('5000000');

    // First tick: the tokens leave the treasury, then the process dies before the row is marked sent.
    let transfers = 0;
    const dyingSender = async () => {
      transfers++;
      throw new Error('process killed on the way back from sendAndConfirmTransaction');
    };
    await processPayouts(db, dyingSender, 1_001);
    const rowAfterCrash = db.get<{ status: string; tx_sig: string | null }>(`SELECT status, tx_sig FROM phaseg_payouts`);
    const rewardsAfterCrash = db.get<{ claimed_micro: string }>(`SELECT claimed_micro FROM phaseg_rewards WHERE wallet = 'W'`);

    // Second tick (restart): the row is still 'pending', so the same amount is paid again.
    const paidAgain = await processPayouts(db, async () => { transfers++; return 'sig2'; }, 1_100);
    const rowAfterRetry = db.get<{ status: string; tx_sig: string | null }>(`SELECT status, tx_sig FROM phaseg_payouts`);

    // One claim of 5 $CG, two transfers out of the treasury, and the books only ever record one.
    expect(transfers).toBe(2);
    expect(rowAfterCrash?.status).toBe('pending');
    expect(rewardsAfterCrash?.claimed_micro).toBe('0');
    expect(paidAgain.paid).toBe(1);
    expect(rowAfterRetry?.status).toBe('sent');

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      transfers,
      claimedMicroBooked: db.get<{ claimed_micro: string }>(`SELECT claimed_micro FROM phaseg_rewards WHERE wallet = 'W'`)?.claimed_micro,
      payoutRowAmountMicro: db.get<{ amount_micro: string }>(`SELECT amount_micro FROM phaseg_payouts`)?.amount_micro,
    }));

    // No structural guard against a second pending payout for the same wallet.
    const indexes = db.all<{ name: string; sql: string | null }>(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'phaseg_payouts'`);
    const uniquePending = indexes.some((i) => /unique/i.test(i.sql ?? '') && /pending/i.test(i.sql ?? ''));
    expect(uniquePending).toBe(false);

    // Two writers can therefore each open a payout for the same balance.
    db.run(`INSERT INTO phaseg_rewards (wallet, pending_micro, claimed_micro, updated_at)
            VALUES ('W', '0', '0', 0) ON CONFLICT(wallet) DO UPDATE SET pending_micro = '7000000'`);
    const a = claimRewards(db, 'W', 2_000);
    // simulate the interleaving: the second writer read "no pending row" before the first insert committed
    db.run(`INSERT INTO phaseg_payouts (wallet, amount_micro, status, created_at) VALUES ('W', '7000000', 'pending', ?)`, 2_000);
    const pendingRows = db.all<{ id: number }>(`SELECT id FROM phaseg_payouts WHERE wallet = 'W' AND status = 'pending'`);
    expect(a.status).toBe('pending');
    expect(pendingRows.length).toBe(2);
    db.raw.close();
  });
});
