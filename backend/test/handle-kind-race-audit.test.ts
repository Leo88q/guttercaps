// Reproducer: a "first handle" payment cannot be used once the wallet already has a handle, because
// `claimHandle` recomputes the service KIND at claim time instead of at payment time.
//
//   client/src/features/profile/HandleModal.tsx:45,88  kind = me.data?.handle ? 1 : 0 — fixed when the
//                                                      modal opens, and the ref hash is derived from it;
//   backend/src/services.ts:155-165                     claimHandle re-derives the kind from the CURRENT
//                                                      `wallets.handle` after the payment was made
//   backend/src/services.ts:39,88-99                    ref_hash includes the kind, and findPayment is
//                                                      filtered by the expected kind only
//
// Two open modals (or a stale tab) both quote kind 0 at $1.99. The first claim sets the handle; the
// second claim now expects kind 1 ($0.99) with a different ref hash, so the already-paid kind-0
// payment matches neither the kind filter nor the ref hash: the user is left with a payment that can
// never be spent by any route (its ref hash commits to kind 0 + that handle). No refund path exists.
import { describe, expect, it } from 'vitest';
import { Db, now } from '../src/db.ts';
import { kp } from './fixtures.ts';
import { claimHandle, findPayment, handleRefHash, toHex } from '../src/services.ts';

function pay(db: Db, sig: string, buyer: string, kind: number, handle: string) {
  const t = now();
  db.run(
    `INSERT INTO service_payments (signature, event_index, buyer, kind, currency, amount, burned, ref_hash, slot, block_time)
     VALUES (?, 0, ?, ?, 2, '100', '0', ?, 1, ?)`,
    sig, buyer, kind, toHex(handleRefHash(kind as 0 | 1, buyer, handle)), t,
  );
  db.run(
    `INSERT INTO events_raw (signature, ix_index, event_index, program, name, data, slot, finalized_at)
     VALUES (?, 0, 0, 'services', 'ServicePaid', '{}', 1, ?)`,
    sig, t,
  );
}

describe('handle purchase × stale kind', () => {
  it('a kind-0 payment bought before the handle existed becomes unspendable after it is set', () => {
    const db = new Db(':memory:');
    const wallet = kp();
    // both modals were opened while the wallet had no handle → both paid the kind-0 price
    pay(db, 'sigA', wallet, 0, 'rail_queen');
    pay(db, 'sigB', wallet, 0, 'other_cap');

    // tab A wins the race and gets its handle
    claimHandle(db, wallet, 'rail_queen', 'sigA');

    // tab B now claims: claimHandle recomputes kind = 1 for a wallet that has a handle.
    // Right away it is the change cooldown that answers; a month later the same request is refused
    // because the paid kind (0) is not the expected kind (1) — either way nothing is granted.
    let errNow: unknown = null;
    try { claimHandle(db, wallet, 'other_cap', 'sigB'); } catch (e) { errNow = e; }
    db.run(`UPDATE wallets SET handle_set_at = ? WHERE address = ?`, now() - 40 * 86_400, wallet);
    let err: unknown = null;
    try { claimHandle(db, wallet, 'other_cap', 'sigB'); } catch (e) { err = e; }
    const row = db.get<{ consumed_by: string | null }>(`SELECT consumed_by FROM service_payments WHERE signature = 'sigB'`)!;
    // and there is no way to spend it later either: the ref hash is bound to kind 0 + that handle
    let laterErr: unknown = null;
    try { findPayment(db, 'sigB', wallet, [1], toHex(handleRefHash(1, wallet, 'other_cap'))); } catch (e) { laterErr = e; }
    console.log(JSON.stringify({
      claimErrorNow: (errNow as { code?: string })?.code ?? String(errNow),
      claimErrorAfterCooldown: (err as { code?: string })?.code ?? String(err),
      paymentConsumed: row.consumed_by !== null,
      retryError: (laterErr as { code?: string })?.code ?? String(laterErr),
      paidUsdCents: 199,
    }));
    expect((err as { code?: string })?.code).toBe('payment_kind_mismatch');
    expect(row.consumed_by).toBeNull();          // the money was taken and nothing was granted
    expect(laterErr).not.toBeNull();
  });
});
