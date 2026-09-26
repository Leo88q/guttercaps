// Shared ingestion path: transaction logs → events_raw → projections.
// backfill.ts, listen.ts and rebuild.ts all funnel through `ingestTx`, so
// there is exactly one place that decides what "indexed" means.
import { Connection, type ConfirmedSignatureInfo, type VersionedTransactionResponse } from '@solana/web3.js';
import { COMMITMENT, LISTEN_HEAL_TIMES_MAX_ATTEMPTS, PROGRAMS, RPC_URL, RPC_WS_URL, type ProgramName } from './config.ts';
import { db as sharedDb, type Db, now } from './db.ts';
import { decodeLogs, type RawEvent } from './events.ts';
import { wireEvent } from './wire.ts';
import { publish, type BusMessage } from './bus.ts';
import { log } from './log.ts';
import { insertIfAbsent } from './sql.ts';
import { applyEvent, patchLateTimes } from './projections.ts';

export interface TxLike {
  signature: string;
  slot: number;
  blockTime: number | null;
  logs: readonly string[];
  /** failed transactions emit nothing we trust */
  err: unknown;
}

export interface IngestResult { events: number; inserted: number; }

const t2ctx = (t: TxLike) => ({ signature: t.signature, slot: t.slot, blockTime: t.blockTime });

let connection: Connection | undefined;
export function getConnection(): Connection {
  if (!connection) connection = new Connection(RPC_URL, { commitment: COMMITMENT, wsEndpoint: RPC_WS_URL });
  return connection;
}

export function txFromResponse(signature: string, tx: VersionedTransactionResponse | null): TxLike | undefined {
  if (!tx?.meta?.logMessages) return undefined;
  return { signature, slot: tx.slot, blockTime: tx.blockTime ?? null, logs: tx.meta.logMessages, err: tx.meta.err };
}

/**
 * Decode + persist one transaction. Returns how many of its events were new.
 * Runs in a single SQLite transaction so events_raw and projections can never
 * disagree about whether an event was applied.
 */
export function ingestTx(t: TxLike, db: Db = sharedDb()): IngestResult {
  if (t.err) return { events: 0, inserted: 0 };
  const events = decodeLogs(t.logs);
  if (events.length === 0) return { events: 0, inserted: 0 };
  const out: BusMessage[] = [];
  const result = db.tx(() => {
    let inserted = 0;
    for (const e of events) {
      // The dedup key is the whole point of this insert: an event is identified by (signature, ix_index,
      // event_index), so a live frame and a backfill page can race without either double-applying.
      const res = db.run(
        insertIfAbsent('events_raw', ['signature', 'ix_index', 'event_index', 'program', 'name', 'data', 'slot', 'block_time', 'processed'], ['signature', 'ix_index', 'event_index']),
        t.signature, e.ixIndex, e.eventIndex, e.program, e.name, JSON.stringify(e.data), t.slot, t.blockTime, 1,
      );
      if (res.changes === 0) {
        // Seen before (e.g. via websocket without blockTime) — backfill may now know the block time.
        if (t.blockTime !== null) {
          const healed = db.run(`UPDATE events_raw SET block_time = ? WHERE signature = ? AND ix_index = ? AND event_index = ? AND block_time IS NULL`, t.blockTime, t.signature, e.ixIndex, e.eventIndex);
          // The projection rows written from that earlier, untimed application are still NULL (or 0 for
          // `chips.burned_at`, which must stay "dead but undated"). Without this they would be permanently
          // missing from every day-bucketed read while a rebuild would show them — two answers, one chain.
          if (healed.changes > 0) patchLateTimes(db, e, t2ctx(t));
        }
        continue;
      }
      inserted++;
      applyEvent(db, e, { signature: t.signature, slot: t.slot, blockTime: t.blockTime });
      // Only *newly inserted* events are queued for fan-out: a replayed or healed transaction must not
      // re-notify anyone, and a rebuild (which replays everything) must stay silent.
      try {
        const m = wireEvent(db, e, { slot: t.slot });
        if (m) out.push(m);
      } catch (wireErr) {
        log.warn('event fan-out encoding failed', { event: e.name, err: (wireErr as Error)?.message });
      }
    }
    return { events: events.length, inserted };
  });
  // Published after the transaction commits. A frame sent before commit would tell the client to
  // refetch a projection it cannot read yet — the socket is an invalidation hint, so the hint has to
  // arrive when the hint is true (docs/09 §4.1).
  for (const m of out) publish(m);
  return result;
}

/** Replay already-stored raw events into the projection tables (used by rebuild). */
export function replayStored(db: Db = sharedDb(), onProgress?: (n: number) => void): number {
  const rows = db.all<{ signature: string; ix_index: number; event_index: number; program: ProgramName; name: string; data: string; slot: number; block_time: number | null }>(
    `SELECT signature, ix_index, event_index, program, name, data, slot, block_time FROM events_raw ORDER BY slot ASC, id ASC`,
  );
  let n = 0;
  db.tx(() => {
    for (const r of rows) {
      const e: RawEvent = { program: r.program, programId: PROGRAMS[r.program].toBase58(), name: r.name, data: JSON.parse(r.data), ixIndex: r.ix_index, eventIndex: r.event_index };
      applyEvent(db, e, { signature: r.signature, slot: r.slot, blockTime: r.block_time });
      if (++n % 1000 === 0) onProgress?.(n);
    }
    db.run(`UPDATE events_raw SET processed = 1`);
  });
  return n;
}

// ---------------------------------------------------------------- cursors
export interface Cursor { newest_signature: string | null; newest_slot: number | null; history_complete: number }
export function getCursor(program: ProgramName, db: Db = sharedDb()): Cursor | undefined {
  return db.get<Cursor>(`SELECT newest_signature, newest_slot, history_complete FROM indexer_cursor WHERE program = ?`, program);
}
export function setCursor(program: ProgramName, c: Partial<Cursor>, db: Db = sharedDb()) {
  const cur = getCursor(program, db);
  db.run(
    `INSERT INTO indexer_cursor (program, newest_signature, newest_slot, history_complete, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(program) DO UPDATE SET newest_signature = excluded.newest_signature, newest_slot = excluded.newest_slot, history_complete = excluded.history_complete, updated_at = excluded.updated_at`,
    program, c.newest_signature ?? cur?.newest_signature ?? null, c.newest_slot ?? cur?.newest_slot ?? null, c.history_complete ?? cur?.history_complete ?? 0, now(),
  );
}

// ---------------------------------------------------------------- fetching with bounded concurrency
export async function fetchTx(connection: Connection, signature: string, retries = 5): Promise<TxLike | undefined> {
  let delay = 400;
  for (let i = 0; ; i++) {
    try {
      const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: COMMITMENT });
      return txFromResponse(signature, tx);
    } catch (e) {
      if (i >= retries) throw e;
      await sleep(delay + Math.random() * delay);
      delay = Math.min(delay * 2, 8_000);
    }
  }
}

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Fetch + ingest a page of signatures (oldest first so projections see events in order). */
export async function ingestSignatures(connection: Connection, sigs: readonly ConfirmedSignatureInfo[], concurrency: number, db: Db = sharedDb()): Promise<IngestResult> {
  const ok = sigs.filter((s) => !s.err);
  const txs = await mapLimit(ok, concurrency, (s) => fetchTx(connection, s.signature));
  let events = 0, inserted = 0;
  for (let i = txs.length - 1; i >= 0; i--) {
    const t = txs[i];
    if (!t) continue;
    const r = ingestTx(t, db);
    events += r.events; inserted += r.inserted;
  }
  return { events, inserted };
}

/**
 * Heal `block_time` of stored events that never got one (SEC-B13).
 *
 * The websocket subscription yields transaction logs without a block time, so a row first seen live sits
 * with `block_time IS NULL` until something re-reads its signature; the live healer does that only for
 * the last `LISTEN_HEAL_DEPTH` signatures, so a listener that was down for longer leaves NULLs behind
 * for good. Every day-bucketed read then silently disagrees with a rebuild: spend/revenue metrics drop
 * the row, a daily quest window misses it, `accrualFrom` starts an accrual too early and the season
 * slice can be sized below its own days.
 *
 * This pass closes that hole for every consumer at once: oldest NULL signature first, bounded batch,
 * `getTransaction` → `ingestTx`, which fills `events_raw` and re-runs `patchLateTimes` for the projection
 * rows written from the untimed application. When the RPC no longer serves the transaction, the stored
 * `slot` is tried (`getBlockTime`) — the slot is all a `patchLateTimes` needs. Each attempt is counted, so
 * a row that can never be healed is parked at `LISTEN_HEAL_TIMES_MAX_ATTEMPTS` instead of occupying every
 * batch for ever (see `untimedStatus` for the operator-visible count). Idempotent by construction: only
 * missing events are inserted, only gaps are filled.
 */
export async function healEventTimes(connection: Connection, db: Db = sharedDb(), limit = 25, maxAttempts = LISTEN_HEAL_TIMES_MAX_ATTEMPTS): Promise<number> {
  const rows = db.all<{ signature: string; slot: number }>(
    `SELECT DISTINCT signature, MIN(slot) slot FROM events_raw WHERE block_time IS NULL AND time_heal_attempts < ? GROUP BY signature ORDER BY slot ASC LIMIT ?`,
    maxAttempts, limit,
  );
  if (rows.length === 0) return 0;
  const before = db.scalar(`SELECT COUNT(*) FROM events_raw WHERE block_time IS NULL`);
  const healed = await mapLimit(rows, 4, async (r) => {
    // Counted whether or not it succeeds: the counter is "we tried", which is what parks a dead signature.
    db.run(`UPDATE events_raw SET time_heal_attempts = time_heal_attempts + 1 WHERE signature = ? AND block_time IS NULL`, r.signature);
    try {
      const t = await fetchTx(connection, r.signature);
      if (t && t.blockTime !== null) { ingestTx(t, db); return true; }
      // The transaction is gone from the RPC's retention window, but the slot's time may still be known —
      // and the slot alone is enough for `patchLateTimes` (it fans out per stored event of the signature).
      const bt = await connection.getBlockTime(r.slot);
      if (bt === null || bt === undefined) return false;
      return applyStoredTime(db, r.signature, bt);
    } catch {
      return false;
    }
  });
  if (healed.some(Boolean)) log.info(`[heal:times] ${healed.filter(Boolean).length}/${rows.length} signature(s) healed`);
  return Math.max(0, before - db.scalar(`SELECT COUNT(*) FROM events_raw WHERE block_time IS NULL`));
}

/**
 * Date every stored event of one signature and re-run the timed projection patch for each of them. Shared
 * by the slot-time fallback of `healEventTimes` (the transaction itself is no longer retrievable).
 */
function applyStoredTime(db: Db, signature: string, blockTime: number): boolean {
  const rows = db.all<{ ix_index: number; event_index: number; program: ProgramName; name: string; data: string; slot: number }>(
    `SELECT ix_index, event_index, program, name, data, slot FROM events_raw WHERE signature = ? AND block_time IS NULL`,
    signature,
  );
  if (rows.length === 0) return false;
  for (const r of rows) {
    db.run(`UPDATE events_raw SET block_time = ? WHERE signature = ? AND ix_index = ? AND event_index = ? AND block_time IS NULL`, blockTime, signature, r.ix_index, r.event_index);
    const e: RawEvent = { program: r.program, programId: PROGRAMS[r.program].toBase58(), name: r.name, data: JSON.parse(r.data), ixIndex: r.ix_index, eventIndex: r.event_index };
    patchLateTimes(db, e, { signature, slot: r.slot, blockTime });
  }
  return true;
}

/**
 * Operator-visible state of the time-healing (SEC-B13), reported in `/health.untimedEvents`: `pending` are
 * rows still waiting for a time (any pass will pick them up), `stuck` are rows parked at the attempt cap —
 * the RPC cannot serve their transaction *or* their slot, so those events stay out of every day-bucketed
 * read until an operator repairs them (e.g. by re-running with a provider that still has them).
 */
export function untimedStatus(db: Db = sharedDb(), maxAttempts = LISTEN_HEAL_TIMES_MAX_ATTEMPTS): { pending: number; stuck: number; oldestSlot: number | null } {
  return {
    pending: db.scalar(`SELECT COUNT(*) FROM events_raw WHERE block_time IS NULL AND time_heal_attempts < ?`, maxAttempts),
    stuck: db.scalar(`SELECT COUNT(*) FROM events_raw WHERE block_time IS NULL AND time_heal_attempts >= ?`, maxAttempts),
    oldestSlot: db.get<{ s: number | null }>(`SELECT MIN(slot) s FROM events_raw WHERE block_time IS NULL`)?.s ?? null,
  };
}

export const sleep = (ms: number) => new Promise((f) => setTimeout(f, ms));
