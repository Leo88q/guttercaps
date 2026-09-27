// Historical half of the indexer. For each program: walk
// getSignaturesForAddress backwards from the tip until we reach the signature
// recorded in indexer_cursor (or the start of history). Pages are ingested
// oldest-first inside each page; the cursor is only advanced once the whole
// walk finished, so a crash mid-way simply re-scans (inserts are idempotent).
//
//   npm run backfill                  # all four programs
//   npm run backfill -- market        # one program
//   npm run backfill -- --repair-gaps # re-fetch the signatures a walk could not serve (SEC-B27)
//
// SEC-B27: a walk no longer claims a complete history it does not have. Every signature the provider
// listed but refused to serve is filed in `indexer_gaps` and keeps `history_complete` at 0 — the run
// reports exactly how many transactions were never indexed, instead of stamping the cursor and letting
// the projections be missing a payment/mint/battle with nothing anywhere saying so.
import { BACKFILL_CONCURRENCY, BACKFILL_PAGE, INDEXER_GAP_MAX_ATTEMPTS, INDEXER_GAP_REPAIR_BATCH, PROGRAMS, PROGRAM_NAMES, RPC_URL, type ProgramName } from './config.ts';
import { db as sharedDb, type Db } from './db.ts';
import { gapStatus, getConnection, getCursor, ingestSignatures, recordGaps, repairIndexerGaps, setCursor, type SignatureSource } from './ingest.ts';

export async function backfillProgram(
  program: ProgramName,
  log: (s: string) => void = console.log,
  connection: SignatureSource = getConnection(),
  db: Db = sharedDb(),
) {
  const address = PROGRAMS[program];
  const cursor = getCursor(program, db);
  const stopAt = cursor?.newest_signature ?? null;

  let before: string | undefined;
  let newest: { signature: string; slot: number } | null = null;
  let scanned = 0, events = 0, inserted = 0, reachedCursor = false;
  /** signatures this walk saw and the provider would not serve — keyed so a re-scan cannot double-count */
  const unserved = new Map<string, number>();
  const noteUnserved = (m: { signature: string; slot: number }) => {
    const prev = unserved.get(m.signature);
    unserved.set(m.signature, prev === undefined || m.slot < prev ? m.slot : prev);
  };

  log(`[backfill:${program}] ${address.toBase58()} on ${RPC_URL} ${stopAt ? `→ back to ${stopAt.slice(0, 8)}…` : '(full history)'}`);

  while (true) {
    const page = await connection.getSignaturesForAddress(address, { before, limit: BACKFILL_PAGE }, 'confirmed');
    if (page.length === 0) break;
    if (!newest) newest = { signature: page[0].signature, slot: page[0].slot };

    const stopIdx = stopAt ? page.findIndex((s) => s.signature === stopAt) : -1;
    const slice = stopIdx >= 0 ? page.slice(0, stopIdx) : page;
    const r = await ingestSignatures(connection, slice, BACKFILL_CONCURRENCY, db);
    scanned += slice.length; events += r.events; inserted += r.inserted;
    for (const m of r.missing) noteUnserved(m);
    if (r.missing.length) {
      const fresh = recordGaps(db, program, r.missing);
      log(`[backfill:${program}] ${r.missing.length} signature(s) the RPC did not serve — ${fresh} new indexer gap(s) recorded`);
    }
    log(`[backfill:${program}] page … ${slice.length} tx, ${r.inserted} new events (total ${inserted})`);

    if (stopIdx >= 0) { reachedCursor = true; break; }
    before = page[page.length - 1].signature;
    if (page.length < BACKFILL_PAGE) break;
  }

  // `history_complete` is a statement about the whole walk: "every transaction this program ever emitted
  // is in events_raw". A page the provider refused to serve makes that false, and the flag must say so —
  // it is what an operator reads before trusting a metric against a rebuild.
  const complete = unserved.size === 0 ? 1 : 0;
  if (newest) setCursor(program, { newest_signature: newest.signature, newest_slot: newest.slot, history_complete: complete }, db);
  else if (!cursor) setCursor(program, { history_complete: complete }, db);
  if (complete === 0) {
    log(`[backfill:${program}] INCOMPLETE: ${unserved.size} transaction(s) were never indexed (oldest slot ${unserved.size === 0 ? '—' : Math.min.apply(null, [...unserved.values()])}) — repair with \`npm run backend:backfill -- --repair-gaps\`, then re-run the walk to prove completeness`);
  }
  log(`[backfill:${program}] done: ${scanned} tx scanned, ${events} events seen, ${inserted} new${reachedCursor ? ' (caught up to cursor)' : ''}${complete ? '' : ' · history_complete=0'}`);
  return { scanned, events, inserted, missing: unserved.size, historyComplete: complete === 1 };
}

export async function backfillAll(only?: ProgramName[], deps: { connection?: SignatureSource; db?: Db } = {}) {
  const connection = deps.connection ?? getConnection();
  const db = deps.db ?? sharedDb();
  for (const p of only ?? PROGRAM_NAMES) await backfillProgram(p, undefined, connection, db);
}

/**
 * `npm run backend:backfill -- --repair-gaps [program …]` — drain the recorded `indexer_gaps` through the
 * same ingest path, parked rows included. Normally run against an archival RPC (the reason a row is parked
 * is that the configured provider no longer serves it). Prints what is left so the operator knows whether
 * a follow-up walk can prove completeness.
 */
export async function repairGaps(only?: ProgramName[], log: (s: string) => void = console.log, deps: { connection?: SignatureSource; db?: Db } = {}) {
  const connection = deps.connection ?? getConnection();
  const db = deps.db ?? sharedDb();
  let healed = 0;
  for (const program of only ?? PROGRAM_NAMES) {
    for (;;) {
      const r = await repairIndexerGaps(connection, db, INDEXER_GAP_REPAIR_BATCH, INDEXER_GAP_MAX_ATTEMPTS, true);
      healed += r.healed;
      if (r.tried === 0) break;
      if (r.healed === 0) {
        log(`[gaps:${program}] ${r.stillMissing} signature(s) still unavailable — a provider with a longer retention window is needed (an archival RPC serves the slot range), or the transactions were dropped by a fork (verify in an explorer, then delete the row)`);
        break;
      }
      log(`[gaps:${program}] recovered ${r.healed} transaction(s)`);
    }
  }
  const s = gapStatus(db);
  log(`[gaps] ${healed} transaction(s) recovered · remaining ${s.pending + s.parked} (pending ${s.pending}, parked ${s.parked}, oldest slot ${s.oldestSlot ?? '—'})`);
  if (s.pending + s.parked === 0) log('[gaps] nothing left — re-run the full walk (`npm run backend:backfill`) to stamp history_complete=1');
  return { healed, ...s };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const only = args.filter((a): a is ProgramName => (PROGRAM_NAMES as string[]).includes(a));
  const run = args.includes('--repair-gaps')
    ? repairGaps(only.length ? only : undefined)
    : backfillAll(only.length ? only : undefined);
  run.catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  });
}
