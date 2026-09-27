// Real-time half of the indexer: one `onLogs` websocket subscription per
// program. Because a websocket only shows what happens while it is up, the
// listener also (a) runs a backfill on start and (b) every LISTEN_HEAL_EVERY_MS
// re-scans the newest LISTEN_HEAL_DEPTH signatures per program, which closes
// any gap from a dropped connection without operator intervention.
//
// Production note (docs/03-architecture.md §3.1): the same `ingestTx` is the
// handler for Helius enhanced webhooks — WS is the fallback path there.
import { COMMITMENT, INDEXER_GAP_REPAIR_BATCH, LISTEN_HEAL_DEPTH, LISTEN_HEAL_EVERY_MS, LISTEN_HEAL_TIMES_BATCH, LISTEN_RECONNECT_MS, PROGRAMS, PROGRAM_NAMES, RPC_URL, type ProgramName } from './config.ts';
import { backfillProgram } from './backfill.ts';
import { db as sharedDb } from './db.ts';
import { getConnection, healEventTimes, ingestSignatures, ingestTx, recordGaps, repairIndexerGaps, sleep } from './ingest.ts';
// sleep is re-used by the keep-alive loop at the bottom
import { FINALITY_EVERY_MS, reconcileOnce } from './finality.ts';
import { installShutdown } from './shutdown.ts';
import { SHUTDOWN_TIMEOUT_MS } from './config.ts';

/**
 * @param log sink; defaults to console.log
 * @param opts.signals  install SIGTERM/SIGINT handling (off when the API process embeds the listener,
 *                      which owns the drain order). Returns a handle whose `stop()` is the same code the
 *                      signal handler runs — so an embedder can shut the listener down without exiting.
 */
export interface ListenHandle { stop(): Promise<void>; subscribed(): ProgramName[] }

export async function listen(log: (s: string) => void = console.log, opts: { signals?: boolean } = {}): Promise<ListenHandle> {
  const connection = getConnection();
  log(`[listen] ${RPC_URL} — subscribing to ${PROGRAM_NAMES.join(', ')}`);

  // 1. catch up first, so projections are consistent before live events arrive
  for (const p of PROGRAM_NAMES) {
    try { await backfillProgram(p, log); } catch (e) { log(`[listen] initial backfill for ${p} failed: ${(e as Error).message}`); }
  }

  // 2. live subscriptions
  const subs = new Map<ProgramName, number>();
  const subscribe = (p: ProgramName) => {
    const id = connection.onLogs(
      PROGRAMS[p],
      (info, ctx) => {
        if (info.err) return;
        try {
          const r = ingestTx({ signature: info.signature, slot: ctx.slot, blockTime: null, logs: info.logs, err: null });
          if (r.inserted > 0) log(`[live:${p}] ${info.signature.slice(0, 8)}… +${r.inserted} events`);
        } catch (e) {
          log(`[live:${p}] ingest error ${info.signature}: ${(e as Error).message}`);
        }
      },
      COMMITMENT,
    );
    subs.set(p, id);
  };
  for (const p of PROGRAM_NAMES) subscribe(p);

  // 3. gap healer — cheap, idempotent, also fills block_time for rows first seen over WS
  const heal = async () => {
    const db = sharedDb();
    for (const p of PROGRAM_NAMES) {
      try {
        const page = await connection.getSignaturesForAddress(PROGRAMS[p], { limit: LISTEN_HEAL_DEPTH }, 'confirmed');
        const r = await ingestSignatures(connection, page, 2);
        if (r.inserted > 0) log(`[heal:${p}] recovered ${r.inserted} missed events`);
        // SEC-B27: a signature this pass was told about but could not fetch is written down, not skipped —
        // it is the recent-transaction half of the same record `backfillProgram` keeps for the walk.
        if (r.missing.length) {
          const fresh = recordGaps(db, p, r.missing);
          if (fresh > 0) log(`[heal:${p}] ${fresh} signature(s) the RPC did not serve — recorded as indexer gap(s)`);
        }
      } catch (e) {
        log(`[heal:${p}] ${(e as Error).message}`);
      }
    }
    // SEC-B27: and the retry half — a gap recorded a minute ago is usually a transient RPC answer, so the
    // next tick fetches it without an operator. Rows at the attempt cap are left to
    // `npm run backend:backfill -- --repair-gaps` (an archival provider), so a permanently pruned
    // signature cannot make every tick pay for it.
    try {
      const g = await repairIndexerGaps(connection, db, INDEXER_GAP_REPAIR_BATCH);
      if (g.healed > 0) log(`[heal:gaps] recovered ${g.healed} previously unserved transaction(s)${g.parked ? ` · ${g.parked} parked` : ''}`);
    } catch (e) {
      log(`[heal:gaps] ${(e as Error).message}`);
    }
    // SEC-B13: the loop above only reaches back LISTEN_HEAL_DEPTH signatures, so anything a longer outage
    // left undated stays undated — and every day-bucketed query (metrics, quests, accrual, the season
    // slice) then disagrees with a rebuild. This drains that backlog, bounded per pass.
    try {
      const n = await healEventTimes(connection, undefined, LISTEN_HEAL_TIMES_BATCH);
      if (n > 0) log(`[heal:times] filled block_time for ${n} stored event(s)`);
    } catch (e) {
      log(`[heal:times] ${(e as Error).message}`);
    }
  };
  const timer = setInterval(() => void heal(), LISTEN_HEAL_EVERY_MS);
  // kick once, not only after LISTEN_HEAL_EVERY_MS: a restart is exactly when a listener outage's undated
  // backlog should drain (the first timer tick would otherwise leave the day-bucketed reads wrong for a
  // whole interval). `heal` is idempotent, so the later tick re-runs it for free.
  void heal();

  // 4. finality reconciler (SEC-M5): stamps finalized_at, evicts dropped transactions + rebuilds projections
  const finalize = async () => {
    try {
      const r = await reconcileOnce(connection, undefined, log);
      if (r.dropped.length) log(`[finality] ${r.dropped.length} dropped transaction(s) evicted — see ALERT lines above if any payment was already consumed`);
    } catch (e) { log(`[finality] ${(e as Error).message}`); }
  };
  const finTimer = setInterval(() => void finalize(), FINALITY_EVERY_MS);

  const stop = async () => {
    clearInterval(timer);
    clearInterval(finTimer);
    for (const [, id] of subs) { try { await connection.removeOnLogsListener(id); } catch { /* closing */ } }
    subs.clear();
  };
  if (opts.signals !== false) {
    installShutdown(
      [{ name: 'unsubscribe onLogs + stop heal/finality timers', run: stop }],
      { forceMs: SHUTDOWN_TIMEOUT_MS },
    );
  }
  return { stop, subscribed: () => [...subs.keys()] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // The subscription itself is kept alive by web3.js's socket; this loop only exists so the process
  // stays in the foreground and the shutdown handler above is the single thing that ends it.
  listen().then(async () => {
    for (;;) await sleep(LISTEN_RECONNECT_MS);
  }).catch((err) => {
    console.error('Listener crashed:', err);
    process.exit(1);
  });
}
