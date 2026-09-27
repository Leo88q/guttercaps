// Event fan-out: indexer ingest → WebSocket clients (docs/09 §4.1).
//
// Why this exists at all: `listen.ts` (writes the projections) and `serve.ts` (owns the sockets) are
// separate processes, so an in-process emitter would look correct in `npm run dev`'s single-process
// tests and silently deliver nothing in production. Hence two transports:
//   inproc — the default. Publisher and subscriber share the module singleton; used by tests and by
//            any deployment where one process both indexes and serves (`API_INGEST=1`, docker-compose
//            `api` with LISTEN_INPROC).
//   redis  — `EVENT_BUS=redis` + REDIS_URL: PUBLISH on a channel, SUBSCRIBE in the API process. One
//            hop through Redis, ~sub-millisecond, and it survives multiple API replicas.
// A no-transport (`off`) sink is what every call site sees before `installBus` runs, so ingest never
// depends on the socket layer and a bus failure can never fail an ingest.
import { metrics } from './metrics.ts';

export interface BusMessage {
  /** Wallets that should refetch. Empty = broadcast to every socket (market-wide events). */
  wallets: string[];
  type: string;
  payload: Record<string, unknown>;
  slot?: number;
}
export interface EventBus {
  readonly kind: 'off' | 'inproc' | 'redis';
  publish(m: BusMessage): void;
  subscribe(onMessage: (m: BusMessage) => void): () => void;
  close(): Promise<void>;
}

export interface BusInstallOptions {
  /** SEC-B40: how long the initial Redis `SUBSCRIBE` may take before the in-process bus takes over. */
  connectTimeoutMs?: number;
  /** Where a fallback / connection warning goes. Defaults to stderr (silent under `NODE_ENV=test`). */
  warn?: (msg: string) => void;
}

const CHANNEL = process.env.EVENT_BUS_CHANNEL || 'chip:events';

/** Wallet-ish fields an on-chain event may name. Over-notifying is harmless (a socket only ever
 *  receives frames for the wallet it subscribed with); under-notifying would mean a stale UI. */
const WALLET_KEYS = ['owner', 'buyer', 'seller', 'bidder', 'opponent', 'challenger', 'winner', 'claimer', 'staker', 'wallet', 'funder', 'by', 'to', 'admin'] as const;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Which wallets care about this event, derived from its decoded payload. */
export function walletsOf(data: Record<string, unknown> | undefined): string[] {
  if (!data) return [];
  const out = new Set<string>();
  for (const k of WALLET_KEYS) {
    const v = data[k];
    if (typeof v === 'string' && B58.test(v)) out.add(v); // a program-authority field is not a wallet, and `admin` is: the pauser wants to see its own change
  }
  // arrays of {wallet|owner} (e.g. rewards settled for many stakers in one tx)
  for (const v of Object.values(data)) {
    if (!Array.isArray(v)) continue;
    for (const item of v.slice(0, 64)) {
      const w = (item as Record<string, unknown> | undefined)?.wallet ?? (item as Record<string, unknown> | undefined)?.owner;
      if (typeof w === 'string' && B58.test(w)) out.add(w);
    }
  }
  return [...out];
}

function createInproc(): EventBus {
  const subs = new Set<(m: BusMessage) => void>();
  return {
    kind: 'inproc',
    publish(m) { for (const fn of subs) { try { fn(m); } catch { /* a bad socket must not break ingest */ } } },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    async close() { subs.clear(); },
  };
}

/** SEC-B40: after this many ms the initial `SUBSCRIBE` is abandoned and the in-process bus takes over. */
const connectTimeoutMsOf = (o: BusInstallOptions): number =>
  o.connectTimeoutMs ?? Number(process.env.EVENT_BUS_CONNECT_TIMEOUT_MS ?? 3_000);
/** One warning per 30 s, not one per reconnect attempt (ioredis retries every couple of seconds). */
const WARN_EVERY_MS = 30_000;

async function createRedis(url: string, opts: BusInstallOptions, warn: (msg: string) => void): Promise<EventBus> {
  const { Redis } = await import('ioredis');
  // `disconnectTimeout` bounds how long a socket we abandoned may linger before it is destroyed (ioredis
  // default 2 s): on the timeout path below `quit()` cannot be delivered, so `disconnect()` half-closes and
  // this timer is what actually releases the fd.
  const pub = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: false, disconnectTimeout: 250 });
  const sub = new Redis(url, { maxRetriesPerRequest: null, disconnectTimeout: 250 });
  let lastWarn = 0;
  let suppressed = 0;
  // SEC-B40: both clients must *listen* for `error`. Without a listener ioredis writes
  // `[ioredis] Unhandled error event: …` straight to stderr (`silentEmit`), i.e. outside the structured,
  // redacted logger — and with a listener that swallowed the argument (the old `pub.on('error', () => {})`)
  // a Redis outage was invisible in the logs *and* in /metrics. The rate-limit connection next door has
  // logged + counted for as long as it has existed; this is the same treatment for the same dependency.
  const onError = (who: 'pub' | 'sub') => (e: unknown) => {
    metrics.counter('redis_error_total', { purpose: 'bus' });
    const now = Date.now();
    if (now - lastWarn < WARN_EVERY_MS) { suppressed += 1; return; }
    const extra = suppressed ? ` (+${suppressed} more in the last ${WARN_EVERY_MS / 1000} s)` : '';
    suppressed = 0; lastWarn = now;
    warn(`redis bus ${who} error: ${(e as Error)?.message ?? String(e)}${extra}`);
  };
  pub.on('error', onError('pub'));
  sub.on('error', onError('sub'));
  // A `quit()` on a client that never reached `ready` queues the command and waits for a connection that
  // will not come — i.e. the graceful path can hang exactly where this fix exists to stop hanging. Race it
  // against a short grace period and then disconnect, which is immediate and idempotent.
  const stop = async (c: { quit(): Promise<unknown>; disconnect(): void }) => {
    await Promise.race([
      new Promise<void>((r) => { try { void Promise.resolve(c.quit()).then(() => r(), () => r()); } catch { r(); } }),
      new Promise<void>((r) => setTimeout(r, 250)),
    ]);
    try { c.disconnect(); } catch { /* already closed */ }
  };
  const closeQuietly = async () => { await stop(sub); await stop(pub); };
  const subs = new Set<(m: BusMessage) => void>();
  try {
    await withTimeout(sub.subscribe(CHANNEL), connectTimeoutMsOf(opts), () => {
      // Neither `ECONNREFUSED` nor a wedged peer makes the constructor throw: `subscribe` is queued and
      // ioredis retries for ever, so an unbounded `await` here is what used to stop `startServe` from ever
      // reaching `server.listen` (SEC-B40).
      throw new Error(`no answer to SUBSCRIBE within ${connectTimeoutMsOf(opts)} ms — Redis reachable but not serving`);
    });
  } catch (e) {
    await closeQuietly();
    throw e;
  }
  sub.on('message', (_ch: string, raw: string) => {
    let m: BusMessage;
    try { m = JSON.parse(raw) as BusMessage; } catch { return; }
    for (const fn of subs) { try { fn(m); } catch { /* ignore */ } }
  });
  return {
    kind: 'redis',
    publish(m) { try { void pub.publish(CHANNEL, JSON.stringify(m)).catch(() => undefined); } catch { /* ignore */ } },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    async close() { subs.clear(); await closeQuietly(); },
  };
}

/** `p` or a rejection after `ms` — the abandonment path has to *reject*, so the caller can clean up. */
function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => never): Promise<T> {
  if (!ms || ms <= 0) return p;
  return new Promise<T>((res, rej) => {
    const t = setTimeout(() => { try { onTimeout(); } catch (e) { rej(e as Error); } }, ms);
    p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e as Error); });
  });
}

const NOOP: EventBus = { kind: 'off', publish() { /* no bus installed yet */ }, subscribe: () => () => undefined, async close() { /* nothing */ } };

let installed: EventBus = NOOP;

/**
 * Install the process-wide bus. Idempotent; a second call replaces the first (tests).
 *
 * SEC-B40: this function is on the boot path (`serve.ts` awaits it before `server.listen`), so it must
 * *always* return. A Redis that is down, renamed or serving something else used to make ioredis retry the
 * queued `SUBSCRIBE` for ever — `new Redis(url)` does not throw for `ECONNREFUSED` — which meant the API
 * never started listening at all: no REST, no `/readyz`, no `/metrics`, a container in a restart loop,
 * and a blocked rollback for as long as Redis was unwell. That is the *opposite* of this file's contract
 * ("both uses are optional and degrade to no Redis"). A bounded connect attempt now falls back to the
 * in-process bus with a warning, exactly like the missing-`REDIS_URL` case always did. The trade is
 * deliberate and visible: a replica on the in-process bus does not receive another replica's frames, and
 * the client polls (a frame is an invalidation *hint*), so the degraded state is announced — boot line,
 * warning, `event_bus_redis == 0` — rather than hidden.
 */
export async function installBus(
  kind: 'off' | 'inproc' | 'redis' = (process.env.EVENT_BUS as 'off' | 'inproc' | 'redis') ?? 'inproc',
  url = process.env.REDIS_URL,
  opts: BusInstallOptions = {},
): Promise<EventBus> {
  const warn = opts.warn ?? logBusWarn;
  if (installed !== NOOP) await installed.close().catch(() => undefined);
  if (kind === 'redis') {
    if (!url) { warn('EVENT_BUS=redis without REDIS_URL — falling back to the in-process bus'); installed = createInproc(); return installed; }
    try { installed = await createRedis(url, opts, warn); return installed; } catch (e) {
      // The fallback *is* the in-process bus, not the no-op sink: `kind` is 'redis' here, so the generic
      // line below would install NOOP and the warning would be a lie — the process would serve REST with
      // no fan-out at all and nothing but the log said so.
      warn(`redis bus unavailable (${(e as Error).message}) — falling back to the in-process bus`);
      installed = createInproc();
      return installed;
    }
  }
  installed = kind === 'inproc' ? createInproc() : NOOP;
  return installed;
}
const logBusWarn = (msg: string) => { if (process.env.NODE_ENV !== 'test') process.stderr.write(`[bus] ${msg}\n`); };

export function bus(): EventBus { return installed; }
export function publish(m: BusMessage): void { installed.publish(m); }
export const BUS_CHANNEL = CHANNEL;
