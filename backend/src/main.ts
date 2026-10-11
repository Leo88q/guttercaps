// One process, one writer, one box (docs/09 §4.1). Compose topology question that has a real answer:
// the read-model is SQLite (WAL), the repo runs 5–7 long-lived loops, and "one container per worker"
// with a shared file volume means several writers contending on `events_raw` — which works until it
// doesn't (a `SQLITE_BUSY` in the middle of a crank reveal is a player's pack stuck in `pending`).
//
// So this file is the single-process supervisor: the API (with the indexer in it), the crank and the
// price cache run together, and each extra worker is opt-in through `WORKERS`. Splitting them into
// containers is the Postgres step (schema already in backend/prisma, driver port is not) — until then,
// one container per host is the topology that cannot corrupt anything.
//
// Supervision is deliberately boring: a worker that throws is logged as ALERT and restarted with
// backoff, because a dead price cache is survivable and a dead API is not; only a failing `api` task
// takes the process down (that is what makes the container healthcheck and the orchestrator's restart
// policy the right escalation, instead of a zombie container serving nothing).
import { startServe, type ServeHandle } from './serve.ts';
import { crank } from './crank.ts';
import { pythCache } from './pyth-cache.ts';
import { burnOracle } from './burn-oracle.ts';
import { playOracle } from './play-oracle.ts';
import { rewardOracle } from './reward-oracle.ts';
import { battleResolver } from './battle-resolver.ts';
import { installShutdown } from './shutdown.ts';
import { log, errFields } from './log.ts';
import { metrics } from './metrics.ts';

type Task = (log: (s: string) => void) => Promise<void>;

/** `WORKERS=api,ingest,crank,pyth` — the default set is what a single box needs; the rest are opt-in
 *  because each of them signs transactions and so needs a keypair mounted on purpose. */
export const WORKER_TASKS: Record<string, Task> = {
  crank: (l) => crank(l),
  pyth: (l) => pythCache(l),
  burn: (l) => burnOracle(l),
  reward: (l) => rewardOracle(l),
  battle: (l) => battleResolver(l),
  play: (l) => playOracle(l),
};

export interface MainHandle { serve: ServeHandle; stop: () => Promise<void> }

export async function main(opts: { workers?: string[]; signals?: boolean } = {}): Promise<MainHandle> {
  const names = opts.workers ?? (process.env.WORKERS ?? 'crank,pyth').split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = names.filter((n) => !WORKER_TASKS[n]);
  if (unknown.length) throw new Error(`WORKERS contains unknown task(s): ${unknown.join(', ')} (available: ${Object.keys(WORKER_TASKS).join(', ')})`);

  // `signals: false` — the supervisor below owns SIGTERM, so the http layer must not install a second
  // handler for the same signal (two owners of one drain is how a shutdown runs twice).
  const serve = await startServe({ signals: false });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let stopping = false;

  const supervise = async (name: string, task: Task) => {
    let backoff = 1_000;
    while (!stopping) {
      const t0 = Date.now();
      try {
        await task((m) => log.info(`[${name}] ${m}`));
        log.warn(`worker ${name} returned (its loop ended) — restarting`, { afterMs: Date.now() - t0 });
      } catch (e) {
        log.alert(`worker ${name} crashed — restarting`, { ...errFields(e), afterMs: Date.now() - t0 });
        metrics.counter('worker_crashes_total', { worker: name });
      }
      metrics.counter('worker_restarts_total', { worker: name });
      // A worker that dies instantly (bad keypair path, RPC down) must not spin: back off to 60 s.
      await sleep(Math.min(backoff, 60_000));
      backoff = Math.min(backoff * 2, 60_000);
      if (Date.now() - t0 > 5 * 60_000) backoff = 1_000; // it ran for a while ⇒ the fault was transient
    }
  };

  const tasks = names.map((n) => supervise(n, WORKER_TASKS[n]));
  log.info('main: started', { workers: names.join(','), api: serve.url });

  const stop = async () => {
    stopping = true;
    await serve.close();
    await Promise.race([Promise.allSettled(tasks), sleep(2_000)]);
  };
  if (opts.signals !== false) {
    installShutdown([{ name: 'stop workers + api', run: stop }], { forceMs: Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 25_000) });
  }
  return { serve, stop };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    log.error('ALERT main failed to start', errFields(err));
    process.exit(1);
  });
}
