// SEC-B27: a transaction the RPC will not serve must be *recorded*, not skipped.
//
// `getSignaturesForAddress` answers with signatures; fetching the transaction is a second call and
// `getTransaction` legitimately returns `null` (outside the provider's retention window, or a transient
// answer). That null used to be a `continue`: no event counted, the walk finished, and the cursor was
// stamped `history_complete = 1` — the read model then lacked whatever that transaction emitted (a
// ServicePaid → a player who paid and cannot claim, a chip mint → an inventory the chain disagrees with)
// with nothing anywhere saying a page had been short. These tests drive the real walk and the real repair
// pass through a fake RPC that withholds a signature, which is the condition, and check the record, the
// completeness flag and the retry/parking behaviour.
import { describe, it, expect, beforeEach } from 'vitest';
import type { VersionedTransactionResponse } from '@solana/web3.js';
import { Db } from '../src/db.ts';
import { backfillAll, backfillProgram, repairGaps } from '../src/backfill.ts';
import { gapStatus, getCursor, recordGaps, repairIndexerGaps, setCursor, type MissingSignature, type SignatureSource, type TxLike } from '../src/ingest.ts';
import { hex32, kp, tx } from './fixtures.ts';

const CHIP = 'chip_core' as const;

/** The three transactions the fixture walk sees, oldest last (the RPC lists newest first). */
function chain() {
  const alice = kp();
  const paid = tx([{ program: CHIP, name: 'ServicePaid', data: { buyer: alice, kind: 0, currency: 2, amount: '199000000', burned: '199000000', refHash: hex32(0x11) } }], { signature: 'sig-service-paid', blockTime: 1_700_000_100 });
  const opened = tx([{ program: CHIP, name: 'PackOpened', data: {
    buyer: alice, sku: 1, nonce: '1', assets: [kp(), kp(), kp(), '11111111111111111111111111111111', '11111111111111111111111111111111'],
    rarities: [0, 0, 2, 0, 0], collections: [3, 3, 7, 0, 0], count: 3, roll: hex32(0x9f), pityBefore: 0, pityAfter: 1,
  } }], { signature: 'sig-pack-opened', blockTime: 1_700_000_200 });
  const bought = tx([{ program: CHIP, name: 'PackBought', data: { buyer: alice, sku: 1, qty: 1, currency: 0, amount: '33000000', nonce: '1', randomness: kp() } }], { signature: 'sig-pack-bought', blockTime: 1_700_000_300 });
  // the walk visits (newest → oldest) bought → opened → paid
  return { txs: [paid, opened, bought], paidSig: paid.signature, openedSig: opened.signature, boughtSig: bought.signature };
}

/**
 * A read-only fake of the two RPC calls the indexer makes. `withhold` is the whole point: the signature is
 * *listed* (the provider knows about it) but `getTransaction` answers `null`, exactly as it does for a
 * transaction older than the plan's retention.
 */
function rpc(txs: readonly TxLike[], withhold: string[] = []) {
  const ordered = [...txs].sort((a, b) => b.slot - a.slot);
  const bySig = new Map(ordered.map((t) => [t.signature, t]));
  const src = {
    asked: [] as string[],
    withheld: withhold,
    async getSignaturesForAddress(_address: unknown, cfg: { before?: string; limit: number }) {
      let list = ordered;
      if (cfg.before) {
        const at = list.findIndex((t) => t.signature === cfg.before);
        list = at < 0 ? [] : list.slice(at + 1);
      }
      return list.slice(0, cfg.limit).map((t) => ({ signature: t.signature, slot: t.slot, blockTime: t.blockTime, err: t.err, memo: null }));
    },
    async getTransaction(signature: string) {
      src.asked.push(signature);
      if (src.withheld.includes(signature)) return null;
      const t = bySig.get(signature);
      if (!t) return null;
      return { slot: t.slot, blockTime: t.blockTime, meta: { logMessages: [...t.logs], err: t.err } } as unknown as VersionedTransactionResponse;
    },
    async getBlockTime(slot: number) { return 1_700_000_000 + slot; },
  };
  return src as SignatureSource & typeof src;
}

const lines = () => { const out: string[] = []; return { out, log: (s: string) => out.push(s) }; };

describe('SEC-B27 backfill: a signature the RPC will not serve is recorded, not skipped', () => {
  let db: Db;
  beforeEach(() => { db = new Db(':memory:'); });

  it('files the gap, keeps history_complete = 0, and still indexes every page it could fetch', async () => {
    const { txs, openedSig, boughtSig } = chain();
    const source = rpc(txs, [openedSig]);
    const { out, log } = lines();
    const r = await backfillProgram(CHIP, log, source, db);

    // the two transactions that *were* served landed (events_raw + projections, through ingestTx)
    expect(db.scalar(`SELECT COUNT(*) FROM events_raw WHERE signature = ?`, boughtSig)).toBe(1);
    expect(db.scalar(`SELECT COUNT(*) FROM events_raw WHERE signature = ?`, openedSig)).toBe(0);
    expect(db.scalar(`SELECT COUNT(*) FROM service_payments`)).toBe(1); // ServicePaid from the newest tx
    expect(r.missing).toBe(1);

    // ... and the one that was not is written down with its slot
    const gap = db.get<{ program: string; slot: number; attempts: number }>(`SELECT program, slot, attempts FROM indexer_gaps WHERE signature = ?`, openedSig);
    expect(gap?.program).toBe(CHIP);
    expect(gap?.slot).toBe(txs.find((t) => t.signature === openedSig)!.slot);
    expect(gap?.attempts).toBe(0);

    // the cursor advances (live traffic must not stop) but it does not lie about completeness
    const cursor = getCursor(CHIP, db)!;
    expect(cursor.newest_signature).toBe(boughtSig);
    expect(cursor.history_complete).toBe(0);
    expect(r.historyComplete).toBe(false);
    expect(out.join('\n')).toMatch(/INCOMPLETE: 1 transaction/);
    expect(out.join('\n')).toMatch(/history_complete=0/);
  });

  it('stamps history_complete = 1 only when the whole walk was served', async () => {
    const { txs, boughtSig } = chain();
    const { log } = lines();
    const r = await backfillProgram(CHIP, log, rpc(txs), db);
    expect(r).toMatchObject({ missing: 0, historyComplete: true });
    const cursor = getCursor(CHIP, db)!;
    expect(cursor.newest_signature).toBe(boughtSig);
    expect(cursor.history_complete).toBe(1);
    expect(gapStatus(db)).toEqual({ pending: 0, parked: 0, oldestSlot: null });
  });

  it('does not treat a failed transaction as a gap (it was dropped before the fetch, and emits nothing)', async () => {
    const { txs } = chain();
    const failed: TxLike = { ...txs[1]!, signature: 'sig-failed', err: { InstructionError: [0, 'Custom'] } };
    const { log } = lines();
    const r = await backfillProgram(CHIP, log, rpc([...txs, failed], ['sig-failed']), db);
    expect(r.missing).toBe(0);
    expect(r.historyComplete).toBe(true);
    expect(db.scalar(`SELECT COUNT(*) FROM indexer_gaps`)).toBe(0);
  });

  it('a re-scan of the same page keeps the original first_seen and does not re-count the gap', async () => {
    const { openedSig } = chain();
    const missing: MissingSignature[] = [{ signature: openedSig, slot: 5 }];
    expect(recordGaps(db, CHIP, missing, 1_000)).toBe(1);
    const first = db.get<{ first_seen: number }>(`SELECT first_seen FROM indexer_gaps WHERE signature = ?`, openedSig)!;
    expect(recordGaps(db, CHIP, missing, 2_000)).toBe(0);
    expect(db.get<{ first_seen: number }>(`SELECT first_seen FROM indexer_gaps WHERE signature = ?`, openedSig)!.first_seen).toBe(first.first_seen);
    expect(db.scalar(`SELECT COUNT(*) FROM indexer_gaps`)).toBe(1);
  });

  it('resumes at the cursor: a caught-up walk visits nothing and leaves completeness alone', async () => {
    const { txs, boughtSig } = chain();
    setCursor(CHIP, { newest_signature: boughtSig, newest_slot: txs[2]!.slot, history_complete: 1 }, db);
    const source = rpc(txs, txs.map((t) => t.signature)); // every fetch withheld: nothing is even asked for
    const { log } = lines();
    const r = await backfillProgram(CHIP, log, source, db);
    expect(source.asked).toEqual([]);
    expect(r.scanned).toBe(0);
    expect(r.historyComplete).toBe(true);
  });
});

describe('SEC-B27 repair: the retry half, and what it does when the provider still refuses', () => {
  let db: Db;
  beforeEach(() => { db = new Db(':memory:'); });

  it('fetches a recorded gap later, applies it through ingestTx, and deletes the row', async () => {
    const { txs, openedSig } = chain();
    const { log } = lines();
    await backfillProgram(CHIP, log, rpc(txs, [openedSig]), db);
    expect(gapStatus(db).pending).toBe(1);
    expect(db.scalar(`SELECT COUNT(*) FROM chips`)).toBe(0); // the withheld PackOpened never projected

    const r = await repairIndexerGaps(rpc(txs), db);
    expect(r).toMatchObject({ tried: 1, healed: 1, stillMissing: 0, parked: 0 });
    expect(db.scalar(`SELECT COUNT(*) FROM indexer_gaps`)).toBe(0);
    expect(gapStatus(db)).toEqual({ pending: 0, parked: 0, oldestSlot: null });
    expect(db.scalar(`SELECT COUNT(*) FROM events_raw WHERE signature = ?`, openedSig)).toBe(1);
    expect(db.scalar(`SELECT COUNT(*) FROM chips`)).toBe(3); // projections caught up too, not just the raw log
    expect(db.scalar(`SELECT COUNT(*) FROM pack_opens`)).toBe(1);

    // nothing left to try
    expect((await repairIndexerGaps(rpc(txs), db)).tried).toBe(0);
    // ... and the walk can now honestly claim the history
    const again = await backfillProgram(CHIP, lines().log, rpc(txs), db);
    expect(again.historyComplete).toBe(true);
    expect(getCursor(CHIP, db)!.history_complete).toBe(1);
  });

  it('counts attempts, parks a signature the provider never serves, and stops paying for it', async () => {
    const { txs, openedSig } = chain();
    await backfillProgram(CHIP, lines().log, rpc(txs, [openedSig]), db);
    const dead = rpc(txs, [openedSig]);
    expect(await repairIndexerGaps(dead, db, 25, 2)).toMatchObject({ tried: 1, healed: 0, stillMissing: 1, parked: 0 });
    expect(await repairIndexerGaps(dead, db, 25, 2)).toMatchObject({ tried: 1, healed: 0, stillMissing: 1, parked: 1 });
    expect(gapStatus(db, 2)).toEqual({ pending: 0, parked: 1, oldestSlot: txs.find((t) => t.signature === openedSig)!.slot });
    // the ticks are done with it — a permanently pruned signature must not occupy every pass
    expect(await repairIndexerGaps(dead, db, 25, 2)).toMatchObject({ tried: 0 });
    // the operator's explicit run retries parked rows (this is what pointing at an archival RPC changes)
    const healed = await repairIndexerGaps(rpc(txs), db, 25, 2, true);
    expect(healed).toMatchObject({ tried: 1, healed: 1, stillMissing: 0, parked: 0 });
    expect(db.scalar(`SELECT COUNT(*) FROM indexer_gaps`)).toBe(0);
  });

  it('`--repair-gaps` drains what it can, then reports what is left', async () => {
    const { txs, openedSig } = chain();
    await backfillProgram(CHIP, lines().log, rpc(txs, [openedSig]), db);
    const { out, log } = lines();
    const nothing = await repairGaps([CHIP], log, { connection: rpc(txs, [openedSig]), db });
    expect(nothing.healed).toBe(0);
    // one attempt is spent (a CLI run retries parked rows on purpose, so a single refusal is not "parked")
    expect(nothing).toMatchObject({ pending: 1, parked: 0 });
    expect(out.join('\n')).toMatch(/still unavailable/);
    expect(out.join('\n')).toMatch(/remaining 1 \(pending 1, parked 0/);

    const good = await repairGaps([CHIP], lines().log, { connection: rpc(txs), db });
    expect(good.healed).toBe(1);
    expect(good).toMatchObject({ pending: 0, parked: 0 });
    expect(db.scalar(`SELECT COUNT(*) FROM events_raw`)).toBe(3);
  });

  it('a repaired gap lands in the same projections a rebuild would produce', async () => {
    const { txs, openedSig } = chain();
    await backfillProgram(CHIP, lines().log, rpc(txs, [openedSig]), db);
    await repairIndexerGaps(rpc(txs), db);
    const live = db.all<Record<string, unknown>>(`SELECT * FROM chips ORDER BY asset`).map((r) => JSON.stringify(r));

    const rebuilt = new Db(':memory:');
    await backfillAll([CHIP], { connection: rpc(txs), db: rebuilt });
    expect(rebuilt.all<Record<string, unknown>>(`SELECT * FROM chips ORDER BY asset`).map((r) => JSON.stringify(r))).toEqual(live);
    expect(rebuilt.scalar(`SELECT COUNT(*) FROM indexer_gaps`)).toBe(0);
    expect(getCursor(CHIP, rebuilt)!.history_complete).toBe(1);
    rebuilt.close();
  });
});
