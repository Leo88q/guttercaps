// The API process: REST + `/ws` + `/metrics` + graceful drain (docs/09 §4.1).
//
// This file is the only place that owns long-lived handles, and the shutdown order it installs is the
// one the runbook and the container rely on. Everything below it (`createApp`, `attachWs`,
// `connectRedis`, `installBus`) is constructed here and closed here, so there is exactly one list of
// resources to release — a leak shows up as a missing entry in `steps`, not as an orphaned handle.
import http from 'node:http';
import type { Connection } from '@solana/web3.js';
import {
  API_HOST, API_PORT, DB_PATH, EVENT_BUS, RPC_URL, REDIS_URL, SHUTDOWN_TIMEOUT_MS,
  WS_MAX_CLIENTS, WS_MAX_PER_IP, WS_PATH, TRUST_PROXY_HOPS, RATE_LIMIT_REDIS_MAX, RATE_LIMIT_REDIS_WINDOW_MS, API_INGEST, assertProductionConfig,
} from './config.ts';
import { db, type Db } from './db.ts';
import { createApp } from './server.ts';
import { bus, installBus } from './bus.ts';
import { connectRedis, createRedisGuard } from './redis.ts';
import { attachWs, type WsHub } from './ws.ts';
import { installShutdown, type ShutdownStep } from './shutdown.ts';
import { log, hijackConsole } from './log.ts';
import { metrics } from './metrics.ts';
import { getConnection } from './ingest.ts';

export interface ServeOptions {
  port?: number;
  host?: string;
  db?: Db;
  connection?: () => Connection;
  /** Install SIGTERM/SIGINT handling — off in tests, which close the handle explicitly. */
  signals?: boolean;
  /** Index in this process (the `API_INGEST` default) — set false for a dedicated indexer container. */
  listenInproc?: boolean;
}

export interface ServeHandle {
  server: http.Server;
  hub: WsHub;
  port: number;
  url: string;
  /** readiness-aware shutdown in the documented order; safe to call twice. */
  close: () => Promise<void>;
}

export async function startServe(opts: ServeOptions = {}): Promise<ServeHandle> {
  hijackConsole();
  assertProductionConfig();
  const database = opts.db ?? db();
  const connection = opts.connection ?? (() => getConnection());
  const busKind = EVENT_BUS === 'redis' && !REDIS_URL ? 'inproc' : EVENT_BUS;
  // SEC-B40: this await is bounded (bus.ts) — a Redis that is down must degrade the fan-out, not stop the
  // API from ever reaching `server.listen`. `bus().kind` is what got installed, which is what the boot
  // line has to report: an operator reading `bus: redis` on a process that fell back would be misled
  // exactly as the alert `event_bus_redis == 0` exists to prevent.
  await installBus(busKind, REDIS_URL);

  let closing = false;
  const redis = await connectRedis(REDIS_URL, 'rate limit');
  const app = createApp(database, {
    connection,
    redisGuard: redis.client ? createRedisGuard({ client: redis.client, limit: RATE_LIMIT_REDIS_MAX, windowMs: RATE_LIMIT_REDIS_WINDOW_MS }) : undefined,
    wsClients: () => hub.clients(),
    isClosing: () => closing,
  });
  const server = http.createServer(app);
  const { hub, close: closeWs } = attachWs(server, { db: () => database, path: WS_PATH, maxClients: WS_MAX_CLIENTS, maxPerIp: WS_MAX_PER_IP, trustProxyHops: TRUST_PROXY_HOPS });
  let listenerInproc: { stop: () => Promise<void> } | undefined;
  if (opts.listenInproc ?? API_INGEST) {
    const { listen } = await import('./listen.ts');
    listenerInproc = await listen((m) => log.info(m), { signals: false });
    log.info('indexer running in the api process (API_INGEST=1) — set API_INGEST=0 when a dedicated `npm run listen` process indexes');
  }

  const port = opts.port ?? API_PORT;
  const host = opts.host ?? API_HOST;
  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(port, host, () => { server.off('error', rej); res(); });
  });
  const actual = (server.address() as { port: number }).port;
  metrics.gauge('process_started_at', Date.now()); // `ws_max_clients` is registered with the app (server.ts)
  log.info('api listening', { url: `http://${host}:${actual}/v1`, db: DB_PATH, rpc: RPC_URL, ws: WS_PATH, bus: bus().kind, busConfigured: busKind, redis: redis.client ? 'on' : 'off', shutdownMs: SHUTDOWN_TIMEOUT_MS });

  // 5. flush + close (1..3 happen inside closeWs / server.close below, in that order)
  const steps: ShutdownStep[] = [
    { name: 'mark unready (drain delay so the LB stops first)', run: async () => { closing = true; await sleep(Math.min(2_000, Math.max(0, SHUTDOWN_TIMEOUT_MS / 10))); } },
    { name: 'stop the in-proc indexer listener', run: async () => { await listenerInproc?.stop(); } },
    { name: 'close websockets', run: async () => { await closeWs(); } },
    { name: 'stop accepting http', run: () => new Promise<void>((res) => { server.close(() => res()); server.closeIdleConnections?.(); }) },
    { name: 'flush redis + close it', run: async () => { await redis.close(); } },
    { name: 'close the event bus', run: async () => { await (await import('./bus.ts')).bus().close(); } },
    { name: 'close db', run: () => { database.close(); } },
  ];
  const shutdown = installShutdown(steps, {
    forceMs: SHUTDOWN_TIMEOUT_MS,
    onExit: opts.signals ? undefined : () => undefined,
    signals: opts.signals !== false,
    // An embedder (tests) must not inherit the crash handlers: vitest reports its own rejections, and
    // exiting the runner from a helper is how a red test turns into a mysterious green nothing.
    crashHandlers: opts.signals !== false,
  });

  return {
    server,
    hub,
    port: actual,
    url: `http://${host}:${actual}`,
    close: () => shutdown.signal('SIGTERM'),
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

if (import.meta.url === `file://${process.argv[1]}`) {
  startServe({ signals: true }).catch((err) => {
    log.error('ALERT api failed to start', { err: (err as Error)?.message });
    process.exit(1);
  });
}
