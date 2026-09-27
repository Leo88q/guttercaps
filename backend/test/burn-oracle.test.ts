// SEC-M1 burn oracle: aggregates indexed burns → staking.report_burn, durable cursor, sanity caps.
import { describe, it, expect, beforeEach } from 'vitest';
import { Connection, Keypair } from '@solana/web3.js';
import { FEES } from '@guttercaps/economy';
import { Db } from '../src/db.ts';
import { ingestTx } from '../src/ingest.ts';
import { PROGRAMS } from '../src/config.ts';
import { ixDiscriminator } from '../src/chain.ts';
import { BURN_ORACLE_MAX_REPORT_MICRO, BURN_ORACLE_MIN_REPORT_MICRO, burnOracleStatus, cursor, emissionPda, pendingBurn, reportBurnIx, reportOnce } from '../src/burn-oracle.ts';
import { FakeConnection, ProgramError } from './chainFixtures.ts';
import { finalizeAll, hex32, kp, tx, world } from './fixtures.ts';
import { dropSignatures, markFinalized } from '../src/finality.ts';

const asConn = (c: FakeConnection) => c as unknown as Connection;
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const REPORT = hex(ixDiscriminator('report_burn'));

/** Decoded `report_burn` calls seen by the fake chain: [amount] in order. */
function reportsSeen(conn: FakeConnection): bigint[] {
  return conn.sent.flatMap((t) => t.ixs.filter((ix) => ix.programId.equals(PROGRAMS.staking) && hex(ix.data.subarray(0, 8)) === REPORT).map((ix) => ix.data.readBigUInt64LE(8)));
}

describe('burn oracle (SEC-M1)', () => {
  let db: Db;
  let conn: FakeConnection;
  const payer = Keypair.generate();
  beforeEach(() => { db = new Db(':memory:'); conn = new FakeConnection(); });

  it('reportBurnIx: staking program, [reporter signer, emission rw], u64 amount', () => {
    const ix = reportBurnIx(payer.publicKey, 123n);
    expect(ix.programId.equals(PROGRAMS.staking)).toBe(true);
    expect(ix.keys[0]).toMatchObject({ isSigner: true, isWritable: false });
    expect(ix.keys[0].pubkey.equals(payer.publicKey)).toBe(true);
    expect(ix.keys[1].pubkey.equals(emissionPda()[0]) && ix.keys[1].isWritable).toBe(true);
    expect(hex(ix.data.subarray(0, 8))).toBe(REPORT);
    expect(ix.data.readBigUInt64LE(8)).toBe(123n);
  });

  it('pendingBurn sums chip_core BurnReported + market listing fee + arena rake burn, never staking rows', () => {
    for (const t of world().txs) ingestTx(t, db);
    finalizeAll(db); // SEC-B29: the oracle only reports burns at or below the finalized horizon
    // world(): fusion fee 2.5 $CG + service 199 $CG (chip_core), one listing (market 0.5 $CG), one battle (rake_burn 2 $CG)
    const p = pendingBurn(db, 0);
    expect(p.amount).toBe(2_500_000n + 199_000_000n + BigInt(FEES.listingFeeCgMicro) + 2_000_000n);
    expect(p.rows).toBe(4);
    // staking's own early-exit burn is already on-chain (record_internal_burn) → excluded
    ingestTx(tx([{ program: 'staking', name: 'Unstaked', data: { owner: kp(), kind: 0, key: kp(), amount: '1000000', penaltyBurned: '50000' } }]), db);
    ingestTx(tx([{ program: 'staking', name: 'BurnRecorded', data: { source: kp(), amount: '777', burnToday: '777' } }]), db);
    expect(pendingBurn(db, 0).amount).toBe(p.amount);
    expect(pendingBurn(db, 0).rows).toBe(4);
    // cursor semantics: everything at/below the rowid is done
    expect(pendingBurn(db, p.maxRowid).rows).toBe(0);
  });

  it('reportOnce sends the delta once, advances the cursor, and re-reports only new burns afterwards', async () => {
    for (const t of world().txs) ingestTx(t, db);
    finalizeAll(db);
    const before = pendingBurn(db, 0).amount;
    const r1 = await reportOnce({ connection: asConn(conn), payer, db });
    expect(r1.kind).toBe('reported');
    expect(reportsSeen(conn)).toEqual([before]);
    const c1 = cursor(db);
    expect(c1.reported_total).toBe(before.toString());
    expect(c1.last_signature).toBe(r1.kind === 'reported' ? r1.signature : '');

    // nothing new → no transaction
    const r2 = await reportOnce({ connection: asConn(conn), payer, db });
    expect(r2).toMatchObject({ kind: 'skipped', reason: 'nothing' });
    expect(reportsSeen(conn)).toHaveLength(1);

    // a new pack-in-$CG burn arrives → only that delta is reported
    ingestTx(tx([{ program: 'chip_core', name: 'BurnReported', data: { source: 0, amount: '5000000' } }]), db);
    finalizeAll(db);
    const r3 = await reportOnce({ connection: asConn(conn), payer, db });
    expect(r3).toMatchObject({ kind: 'reported', amount: 5_000_000n, rows: 1 });
    expect(reportsSeen(conn)).toEqual([before, 5_000_000n]);
    expect(cursor(db).reported_total).toBe((before + 5_000_000n).toString());
  });

  it('a failed transaction leaves the cursor untouched so the next pass retries the same delta', async () => {
    ingestTx(tx([{ program: 'chip_core', name: 'BurnReported', data: { source: 1, amount: '2500000' } }]), db);
    finalizeAll(db);
    conn.onTx = () => { throw new ProgramError(6016, 0); }; // NotBurnReporter — key not designated yet
    await expect(reportOnce({ connection: asConn(conn), payer, db })).rejects.toThrow(/custom 6016/);
    expect(cursor(db)).toMatchObject({ last_rowid: 0, reported_total: '0', last_signature: null });
    conn.onTx = () => {};
    const r = await reportOnce({ connection: asConn(conn), payer, db });
    expect(r).toMatchObject({ kind: 'reported', amount: 2_500_000n });
  });

  it('dust below the minimum is carried over, absurd totals are refused without a transaction', async () => {
    ingestTx(tx([{ program: 'chip_core', name: 'BurnReported', data: { source: 1, amount: String(BURN_ORACLE_MIN_REPORT_MICRO - 1n) } }]), db);
    finalizeAll(db);
    expect(await reportOnce({ connection: asConn(conn), payer, db })).toMatchObject({ kind: 'skipped', reason: 'below_min' });
    expect(reportsSeen(conn)).toHaveLength(0);
    // the dust is still pending (not lost)
    expect(pendingBurn(db, cursor(db).last_rowid).amount).toBe(BURN_ORACLE_MIN_REPORT_MICRO - 1n);

    ingestTx(tx([{ program: 'chip_core', name: 'BurnReported', data: { source: 3, amount: (BURN_ORACLE_MAX_REPORT_MICRO + 1n).toString() } }]), db);
    finalizeAll(db);
    const log: string[] = [];
    expect(await reportOnce({ connection: asConn(conn), payer, db, log: (s) => log.push(s) })).toMatchObject({ kind: 'refused', reason: 'above_max' });
    expect(reportsSeen(conn)).toHaveLength(0);
    expect(log.some((l) => l.includes('ALERT'))).toBe(true);
  });

  it('burnOracleStatus: healthy while nothing material waits, unhealthy once a report is overdue', async () => {
    const s0 = burnOracleStatus(db);
    expect(s0).toMatchObject({ healthy: true, pendingMicro: '0', lastSignature: null, reportedTotalMicro: '0' });
    ingestTx(tx([{ program: 'arena', name: 'BattleResolved', data: { battle: kp(), winner: kp(), pot: '100000000', rakeBurn: '2000000', rakePool: '1000000', rakeTreasury: '2000000', resultHash: hex32(0x22), roll: hex32(0x33) } }]), db);
    finalizeAll(db);
    expect(burnOracleStatus(db)).toMatchObject({ healthy: false, pendingMicro: '2000000', pendingRows: 1, deferredMicro: '0' });
    const t0 = 1_800_000_000_000;
    await reportOnce({ connection: asConn(conn), payer, db, now: () => t0 });
    expect(burnOracleStatus(db, t0 + 60_000)).toMatchObject({ healthy: true, pendingMicro: '0', lastAmountMicro: '2000000', lastReportAgeS: 60 });
  });

  // SEC-B29 -----------------------------------------------------------------
  // The report is irreversible on chain (`report_burn` adds to the 7-day ring the emission guard reads),
  // while a confirmed transaction can still be dropped by a fork and have its events deleted. So only
  // burns at or below `finalizedHorizon` may be aggregated, and the cursor may not step over the rest.
  it('SEC-B29: a confirmed burn is not reported until it is final, and a dropped one is never reported', async () => {
    const confirmed = tx([{ program: 'chip_core', name: 'BurnReported', data: { source: 1, amount: '2500000' } }]);
    ingestTx(confirmed, db);
    const p = pendingBurn(db, 0);
    expect(p).toMatchObject({ amount: 0n, rows: 0, deferredMicro: 2_500_000n, deferredRows: 1, maxRowid: 0 });
    // material burns stuck behind finality with nothing reported recently is a stall signal (the reconciler
    // is what stamps them), so the flag is 0 even though the keeper itself has nothing it *may* send
    expect(burnOracleStatus(db)).toMatchObject({ pendingMicro: '0', pendingRows: 0, deferredMicro: '2500000', deferredRows: 1, healthy: false });
    expect(await reportOnce({ connection: asConn(conn), payer, db })).toMatchObject({ kind: 'skipped', reason: 'nothing' });
    expect(reportsSeen(conn)).toHaveLength(0);

    // the reconciler finalizes it → it is reportable, exactly once
    markFinalized(db, [confirmed.signature]);
    expect(await reportOnce({ connection: asConn(conn), payer, db })).toMatchObject({ kind: 'reported', amount: 2_500_000n });
    expect(reportsSeen(conn)).toEqual([2_500_000n]);
    expect(cursor(db).reported_total).toBe('2500000');
    expect(burnOracleStatus(db)).toMatchObject({ deferredMicro: '0', deferredRows: 0 });

    // a burn in a transaction the cluster drops: deleting its events removes the `burns` row too (the
    // projections are rebuilt from events_raw), so the report that was never sent cannot be invented —
    // and what was already sent is not rewound either
    const dropped = tx([{ program: 'chip_core', name: 'BurnReported', data: { source: 1, amount: '9000000' } }]);
    ingestTx(dropped, db);
    expect(pendingBurn(db, cursor(db).last_rowid)).toMatchObject({ deferredMicro: 9_000_000n, deferredRows: 1 });
    expect(dropSignatures(db, [dropped.signature]).map((r) => r.events)).toEqual([1]);
    expect(pendingBurn(db, cursor(db).last_rowid)).toMatchObject({ amount: 0n, rows: 0, deferredMicro: 0n, deferredRows: 0 });
    expect(await reportOnce({ connection: asConn(conn), payer, db })).toMatchObject({ kind: 'skipped', reason: 'nothing' });
    expect(reportsSeen(conn)).toEqual([2_500_000n]);
    expect(cursor(db).reported_total).toBe('2500000');
  });

  it('SEC-B29: the cursor does not step over a burn that was indexed out of slot order', async () => {
    // Two programs index independently, so a lagging one can land an *older* burn after a newer one: ids
    // follow insertion order, slots do not. Reporting the older row must not move the cursor past the
    // newer one — an unreported burn behind the cursor is lost forever (emission stays at the 30 % floor).
    const high = { ...tx([{ program: 'chip_core', name: 'BurnReported', data: { source: 0, amount: '3000000' } }]), slot: 5_000 };
    const low = { ...tx([{ program: 'chip_core', name: 'BurnReported', data: { source: 0, amount: '1000000' } }]), slot: 4_000 };
    ingestTx(high, db);
    ingestTx(low, db);
    markFinalized(db, [low.signature]); // the older burn is final; the newer one is not yet
    const p = pendingBurn(db, 0);
    expect(high.slot).toBe(5_000);
    expect(pendingBurn(db, 0, 9_999).amount).toBe(4_000_000n); // both countable with a horizon past them
    expect(p).toMatchObject({ amount: 0n, rows: 0, maxRowid: 0, deferredMicro: 4_000_000n, deferredRows: 2 });
    expect(await reportOnce({ connection: asConn(conn), payer, db })).toMatchObject({ kind: 'skipped', reason: 'nothing' });

    // once the newer transaction finalizes, nothing was skipped: both burns are reported together
    markFinalized(db, [high.signature]);
    const q = pendingBurn(db, p.maxRowid);
    expect(q).toMatchObject({ amount: 4_000_000n, rows: 2, maxRowid: 2, deferredMicro: 0n });
    expect(await reportOnce({ connection: asConn(conn), payer, db })).toMatchObject({ kind: 'reported', amount: 4_000_000n, rows: 2 });
    expect(reportsSeen(conn)).toEqual([4_000_000n]);
    expect(cursor(db).last_rowid).toBe(2); // high = id 1, low = id 2 — both reported, none behind the cursor
  });
});
