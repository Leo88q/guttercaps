/**
 * Finality reconciler (SEC-M5, docs/06 §2.1).
 *
 * The indexer applies projections at `confirmed` so the UI is live within a slot or two. That is
 * the right latency for a collection grid, but a confirmed transaction can still be dropped by a
 * fork (rare — roughly one in 10⁴–10⁵ on mainnet, more on devnet). Anything that hands out value
 * off-chain (paid-service entitlements, handles, quest progress, referrals, leaderboards used for
 * season roots) must therefore only trust **finalized** events.
 *
 *   * `events_raw.finalized_at` (unix s, NULL = confirmed only) is stamped here.
 *   * Every FINALITY_EVERY_MS the reconciler takes the distinct unfinalized signatures older than
 *     FINALITY_MIN_SLOTS (150 ≈ 1 min — a finalized slot is ~32 confirmations behind the tip) and asks
 *     `getSignatureStatuses(..., { searchTransactionHistory: true })`:
 *       - `finalized`                 → stamp `finalized_at`;
 *       - `confirmed` / `processed`  → leave it, ask again next pass;
 *       - `null` (unknown to the cluster) or `err` → the transaction was dropped: delete its raw
 *         events and **rebuild the projections** from what is left (projections are a pure function of
 *         events_raw — T-B-15 — so the ghost chip / sale / stake simply disappears). Rows the API
 *         already consumed (payment_consumption, §1.5) are reported loudly: that is money that
 *         left the treasury for a phantom payment and needs a human.
 *   * `requireFinalized(db, signature)` is what the value-bearing endpoints call (services.ts
 *     `findPayment`) — a confirmed-but-not-yet-finalized payment answers 409 `payment_pending`
 *     with a retry hint instead of granting the entitlement.
 *
 * Dev / localnet: set FINALITY_MIN_SLOTS=0 and the reconciler stamps everything on its next pass; with
 * `FINALITY_ASSUME=1` (never in production — `assertProductionConfig`) `requireFinalized` is a no-op.
 */
import { Connection } from '@solana/web3.js';
import { db as sharedDb, now, PROJECTION_TABLES, type Db } from './db.ts';
import { getConnection, replayStored, sleep } from './ingest.ts';
import { consumedMarks } from './consumption.ts';

const env = process.env;
export const FINALITY_EVERY_MS = Number(env.FINALITY_EVERY_MS ?? 20_000);
/** Only ask about events at least this many slots behind the tip (finalization takes ≈ 32 slots; 150 leaves margin for RPC lag). */
export const FINALITY_MIN_SLOTS = Number(env.FINALITY_MIN_SLOTS ?? 150);
/** getSignatureStatuses accepts ≤ 256 signatures per call. */
export const FINALITY_BATCH = 256;
/** Give up waiting: an unfinalized signature older than this many slots that the cluster no longer knows is treated as dropped. */
export const FINALITY_DROP_AFTER_SLOTS = Number(env.FINALITY_DROP_AFTER_SLOTS ?? 1_000);
export const FINALITY_ASSUME = env.FINALITY_ASSUME === '1';

export class FinalityError extends Error {
  constructor(public code: 'payment_pending', message: string) { super(message); }
}

/** Idempotent schema add-on (dev SQLite files created by older builds). */
export function ensureFinalityColumn(db: Db) {
  const cols = new Set((db.raw.prepare(`PRAGMA table_info(events_raw)`).all() as { name: string }[]).map((c) => c.name));
  if (!cols.has('finalized_at')) db.raw.exec(`ALTER TABLE events_raw ADD COLUMN finalized_at INTEGER`);
  db.raw.exec(`CREATE INDEX IF NOT EXISTS idx_events_unfinalized ON events_raw(finalized_at, slot)`);
}

export function isFinalized(db: Db, signature: string): boolean {
  if (FINALITY_ASSUME) return true;
  const r = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM events_raw WHERE signature = ? AND finalized_at IS NOT NULL`, signature);
  return (r?.n ?? 0) > 0;
}

/** Throws 409 `payment_pending` while a signature is only confirmed. Unknown signatures are not this function's business (callers 402 first). */
export function requireFinalized(db: Db, signature: string) {
  if (isFinalized(db, signature)) return;
  throw new FinalityError('payment_pending', 'Transaction is confirmed but not yet finalized — retry in ~30 s');
}

/**
 * Finalized horizon (backlog #9): the highest slot at or below which EVERY indexed event is finalized —
 * the slot just before the oldest unfinalized event, or the newest finalized slot when nothing is
 * pending. Settlement code that turns projections into value (quest completions, season payouts —
 * backend/src/quests.ts, arena.ts, reward-oracle.ts) only counts rows with `slot <= horizon`; anything
 * newer simply waits for the next reconciler pass. A stuck RPC freezes the horizon, which is the
 * fail-safe direction (nothing is paid for events we cannot prove final; /health.finality turns
 * unhealthy). FINALITY_ASSUME=1 (dev) → MAX_SAFE_INTEGER; an empty log → 0 (nothing counts).
 */
export function finalizedHorizon(db: Db): number {
  if (FINALITY_ASSUME) return Number.MAX_SAFE_INTEGER;
  const pending = db.get<{ s: number | null }>(`SELECT MIN(slot) s FROM events_raw WHERE finalized_at IS NULL`)?.s;
  if (pending !== null && pending !== undefined) return pending - 1;
  return db.get<{ s: number | null }>(`SELECT MAX(slot) s FROM events_raw WHERE finalized_at IS NOT NULL`)?.s ?? 0;
}

/** Stamp signatures as finalized (used by the reconciler and by tests / localnet where everything is final at once). */
export function markFinalized(db: Db, signatures: readonly string[], at = now()): number {
  let n = 0;
  db.tx(() => { for (const s of signatures) n += Number(db.run(`UPDATE events_raw SET finalized_at = ? WHERE signature = ? AND finalized_at IS NULL`, at, s).changes); });
  return n;
}

export interface DroppedReport { signature: string; events: number; consumedPayments: string[] }

/** Remove a dropped transaction's raw events and rebuild every projection from the remaining log. */
export function dropSignatures(db: Db, signatures: readonly string[]): DroppedReport[] {
  if (signatures.length === 0) return [];
  const reports: DroppedReport[] = [];
  db.tx(() => {
    for (const s of signatures) {
      // §1.5: метки расхода читаются из ledger'а, а не из проекции — иначе дроп уже потраченного
      // платежа выглядел бы как «ничего не потеряли» и никто бы не узнал про ушедшие из казны деньги.
      const consumed = consumedMarks(db, s).map((m) => m.consumed_by);
      const events = Number(db.run(`DELETE FROM events_raw WHERE signature = ?`, s).changes);
      reports.push({ signature: s, events, consumedPayments: consumed });
    }
    for (const t of PROJECTION_TABLES) db.run(`DELETE FROM ${t}`);
  });
  replayStored(db);
  return reports;
}

export interface ReconcileResult { checked: number; finalized: number; pending: number; dropped: DroppedReport[] }

type StatusLike = { confirmationStatus?: string; err: unknown } | null;
export interface StatusSource { getSlot(commitment?: 'confirmed'): Promise<number>; getSignatureStatuses(sigs: string[], cfg: { searchTransactionHistory: boolean }): Promise<{ value: StatusLike[] }> }

/** One reconciliation pass. Pure w.r.t. the connection: tests pass a fake status source. */
export async function reconcileOnce(connection: StatusSource | Connection, db: Db = sharedDb(), log: (s: string) => void = () => {}, opts: { minSlots?: number; dropAfterSlots?: number } = {}): Promise<ReconcileResult> {
  ensureFinalityColumn(db);
  const minSlots = opts.minSlots ?? FINALITY_MIN_SLOTS;
  const dropAfter = opts.dropAfterSlots ?? FINALITY_DROP_AFTER_SLOTS;
  const tip = await connection.getSlot('confirmed');
  const rows = db.all<{ signature: string; slot: number }>(
    `SELECT signature, MIN(slot) AS slot FROM events_raw WHERE finalized_at IS NULL AND slot <= ? GROUP BY signature ORDER BY slot ASC LIMIT ?`,
    tip - minSlots, FINALITY_BATCH,
  );
  const out: ReconcileResult = { checked: rows.length, finalized: 0, pending: 0, dropped: [] };
  if (rows.length === 0) return out;
  const { value } = await (connection as StatusSource).getSignatureStatuses(rows.map((r) => r.signature), { searchTransactionHistory: true });
  const done: string[] = [], gone: string[] = [];
  rows.forEach((r, i) => {
    const st = value[i];
    if (st && !st.err && st.confirmationStatus === 'finalized') done.push(r.signature);
    else if ((st === null || st === undefined || st.err) && tip - r.slot >= dropAfter) gone.push(r.signature);
    else if (st && st.err) gone.push(r.signature); // a failed tx can never have emitted events we trust
    else out.pending++;
  });
  out.finalized = markFinalized(db, done);
  if (gone.length) {
    out.dropped = dropSignatures(db, gone);
    for (const d of out.dropped) {
      log(`[finality] ${d.consumedPayments.length ? 'ALERT ' : ''}dropped tx ${d.signature} (${d.events} events removed, projections rebuilt)${d.consumedPayments.length ? ` — payments already consumed: ${d.consumedPayments.join(', ')} — manual review` : ''}`);
    }
  }
  return out;
}

/** /health.finality — how far behind finalization the log is. */
export function finalityStatus(db: Db, nowS = now()) {
  ensureFinalityColumn(db);
  const pending = db.get<{ n: number; oldest: number | null }>(`SELECT COUNT(DISTINCT signature) AS n, MIN(block_time) AS oldest FROM events_raw WHERE finalized_at IS NULL`)!;
  const last = db.get<{ t: number | null }>(`SELECT MAX(finalized_at) AS t FROM events_raw`)?.t ?? null;
  const oldestAgeS = pending.oldest === null ? null : nowS - pending.oldest;
  return {
    assume: FINALITY_ASSUME,
    pendingSignatures: pending.n,
    oldestPendingAgeS: oldestAgeS,
    lastFinalizedAt: last === null ? null : new Date(last * 1000).toISOString(),
    // healthy: nothing has been waiting longer than ~10 minutes (finalization itself takes ~1 min)
    healthy: FINALITY_ASSUME || oldestAgeS === null || oldestAgeS < 600,
  };
}

export async function finality(log: (s: string) => void = console.log) {
  const connection = getConnection();
  const db = sharedDb();
  log(`[finality] every ${FINALITY_EVERY_MS / 1000} s · min age ${FINALITY_MIN_SLOTS} slots · drop after ${FINALITY_DROP_AFTER_SLOTS} slots${FINALITY_ASSUME ? ' · FINALITY_ASSUME=1 (dev only)' : ''}`);
  while (true) {
    try {
      const r = await reconcileOnce(connection, db, log);
      if (r.checked) log(`[finality] checked ${r.checked}: finalized ${r.finalized}, pending ${r.pending}, dropped ${r.dropped.length}`);
    } catch (e) {
      log(`[finality] pass failed: ${(e as Error).message}`);
    }
    await sleep(FINALITY_EVERY_MS);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  finality().catch((err) => {
    console.error('finality crashed:', err);
    process.exit(1);
  });
}
