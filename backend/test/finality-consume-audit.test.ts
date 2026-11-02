// Reproducer: the finality reconciler's fork recovery wipes the "this payment was already spent" mark.
//
//   backend/src/finality.ts:139   dropSignatures(): DELETE FROM every PROJECTION_TABLE, then replayStored()
//   backend/src/db.ts:1516        'service_payments' IS one of PROJECTION_TABLES
//   backend/src/db.ts:808-822     consumed_by / consumed_at live ON that table (written by services.consume)
//   backend/src/projections.ts:188-195  the ServicePaid handler re-inserts a row WITHOUT consumed_by
//   backend/src/services.ts:96-110      the double-spend guard is exactly `consumed_by IS NULL`
//
// So any single dropped transaction (a confirmed tx dropped by a fork, or an RPC that answers `null` once
// the tx is FINALITY_DROP_AFTER_SLOTS old) rebuilds all projections from events_raw, and every payment
// consumed so far becomes fresh again — while the thing it bought (`entitlements`, `grid_deep_credits`,
// `board_parts`) lives OUTSIDE the projection set and is not rewound. A season pass claimed from one
// payment can then be claimed again from the same signature and extends another 42 days.
import { describe, expect, it } from 'vitest';
import { Db, now } from '../src/db.ts';
import { replayStored } from '../src/ingest.ts';
import { dropSignatures } from '../src/finality.ts';
import { claimService, consume, findPayment, ServiceError, serviceRefHash, toHex } from '../src/services.ts';
import { SERVICE_BY_ID } from '@guttercaps/economy';

const W = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const S1 = '5' + 'x'.repeat(86);   // the season-pass payment — stays valid, never dropped
const S2 = '4' + 'y'.repeat(86);   // an unrelated tx that a fork drops
const DAY = 86_400;

function seeded() {
  const db = new Db(':memory:');
  db.run(`INSERT INTO wallets (address, first_seen) VALUES (?, ?)`, W, now());
  const ref = toHex(serviceRefHash(6, W, { id: 'seasonPass' }));
  const paid = (sig: string, slot: number) => db.run(
    `INSERT INTO events_raw (signature, ix_index, event_index, program, name, data, slot, block_time, finalized_at)
     VALUES (?, 0, 0, 'chip_core', 'ServicePaid', ?, ?, ?, ?)`,
    sig, JSON.stringify({ buyer: W, kind: 6, currency: 0, amount: '999000000', burned: '0', refHash: ref }), slot, now(), now(),
  );
  paid(S1, 100);
  // an unrelated pack purchase from another wallet, on a fork that gets dropped
  db.run(
    `INSERT INTO events_raw (signature, ix_index, event_index, program, name, data, slot, block_time, finalized_at)
     VALUES (?, 0, 0, 'chip_core', 'PackBought', ?, 200, ?, NULL)`,
    S2, JSON.stringify({ buyer: W, sku: 1, qty: 1, currency: 0, amount: '1', nonce: 7, randomness: W }), now(),
  );
  replayStored(db);
  return db;
}

describe('finality drop vs. consumed payments', () => {
  it('a dropped transaction must not resurrect a payment that already bought something', () => {
    const db = seeded();
    const first = claimService(db, W, S1, 6, { id: 'seasonPass' });
    const expires = () => db.get<{ e: number | null }>(`SELECT MAX(expires_at) e FROM entitlements WHERE wallet = ? AND kind = 6`, W)?.e ?? null;
    const passBefore = expires();
    expect(passBefore).not.toBeNull();

    // control: the same signature cannot be spent twice while the mark survives
    let blocked = false;
    try { claimService(db, W, S1, 6, { id: 'seasonPass' }); } catch (e) { blocked = (e as ServiceError).code === 'payment_consumed'; }
    expect(blocked).toBe(true);

    // a fork drops the unrelated tx; the reconciler rebuilds the projections
    dropSignatures(db, [S2]);

    // После исправления (reports/REMEDIATION-DESIGN.md §1.5) `findPayment` обязан ОТКАЗАТЬ: метка
    // расхода живёт в `payment_consumption`, вне PROJECTION_TABLES, поэтому пересборка проекций её не
    // теряет, а `consume()` упирается в первичный ключ (signature, event_index).
    let secondClaim: { signature: string } | null = null;
    let refusal: string | null = null;
    let markAfterDrop: string | null = null;
    try {
      const after = findPayment(db, S1, W, [6]);
      markAfterDrop = after.consumed_by;
    } catch (e) { refusal = (e as ServiceError).code; }
    try { secondClaim = claimService(db, W, S1, 6, { id: 'seasonPass' }); } catch { /* expected once fixed */ }
    const passes = db.scalar(`SELECT COUNT(*) FROM entitlements WHERE signature = ?`, S1);
    // зеркало в проекции восстанавливается из ledger'а при каждом replay
    expect(db.get<{ consumed_by: string | null }>(`SELECT consumed_by FROM service_payments WHERE signature = ?`, S1)?.consumed_by).toBe(first.id ? 'entitlement:1' : null);
    expect(db.scalar(`SELECT COUNT(*) FROM payment_consumption WHERE signature = ?`, S1)).toBe(1);
    console.log(JSON.stringify({ first: first.id, consumedAfterDrop: markAfterDrop, refusal, secondClaim: secondClaim?.signature ?? null, entitlementRows: passes, passBefore, passAfter: expires(), daysExtended: passBefore && expires() ? (expires()! - passBefore) / DAY : 0 }));
    expect(refusal).toBe('payment_consumed');           // the mark survives a projection rebuild
    expect(secondClaim).toBeNull();                    // and one payment must stay one pass
    expect(passes).toBe(1);
  });

  it('a shop board part bought once can be bought twice from the same payment', () => {
    const db = seeded();
    const kind = SERVICE_BY_ID.boardMount.kind;
    const ref = toHex(serviceRefHash(kind, W, { part: 'bolts_chrome' }));
    db.run(
      `INSERT INTO events_raw (signature, ix_index, event_index, program, name, data, slot, block_time, finalized_at)
       VALUES (?, 0, 0, 'chip_core', 'ServicePaid', ?, 150, ?, ?)`,
      '3' + 'z'.repeat(86), JSON.stringify({ buyer: W, kind, currency: 0, amount: '299000000', burned: '0', refHash: ref }), now(), now(),
    );
    replayStored(db);
    const sig = '3' + 'z'.repeat(86);
    claimService(db, W, sig, kind, { part: 'bolts_chrome' });
    const qty = () => db.scalar(`SELECT qty FROM board_parts WHERE wallet = ? AND part = 'bolts_chrome'`, W);
    expect(qty()).toBe(1);
    dropSignatures(db, [S2]);
    let doubled = false;
    try { claimService(db, W, sig, kind, { part: 'bolts_chrome' }); doubled = qty() === 2; } catch { /* expected once fixed */ }
    const leaves = db.scalar(`SELECT COUNT(*) FROM board_part_leaves WHERE wallet = ?`, W);
    console.log(JSON.stringify({ qty: qty(), doubled, unrootedLeaves: leaves }));
    expect(doubled).toBe(false);
    expect(qty()).toBe(1);
  });

  it('consume() is the only guard, so losing the row loses the guard', () => {
    const db = seeded();
    const p = findPayment(db, S1, W, [6]);
    consume(db, p, 'entitlement:1');
    dropSignatures(db, [S2]);
    expect(db.get(`SELECT consumed_by FROM service_payments WHERE signature = ?`, S1)?.consumed_by).toBe('entitlement:1');
  });
});
