// The real-time surface the client already codes against (`client/src/api/ws.ts`): one socket per
// wallet, `{ type, wallet, payload }` frames, and the browser's own backoff on close. This replaces
// the "fall back to polling" comment in that file with a server that exists (docs/09 §4.1).
//
// Trust model, stated plainly because it is the part reviewers ask about:
//   * the socket is NOT authenticated. Every payload it carries is data the same client can already
//     read over plain REST (`GET /v1/wallet/:address/events` is public), so a `?wallet=` query is not
//     a privilege boundary — it is a subscription filter.
//   * consequently nothing here may ever become a write path, a quote, or an authorisation decision;
//     it is invalidation hints only, and the client still refetches over REST after each frame.
//   * `?wallet=` is optional. Without it the socket gets market-wide broadcasts only.
//
// Abuse controls: connection cap, a bounded per-socket outbox that drops a slow client instead of
// growing the heap, ping/pong liveness, and a strict direction (server→client frames only; the one
// accepted client message is `{"type":"ping"}`).
// SEC-B41: the bound is `ClientState.queued`, the bytes this process is holding for that socket. The
// `socket.bufferedAmount` it used to rely on only ever held the single frame in flight — `drain` awaits each
// `send` callback — so the cap could not trip for any frame smaller than itself and a client that stopped
// reading grew `queue` without limit.
import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { PublicKey } from '@solana/web3.js';
import { bus, type BusMessage } from './bus.ts';
import { sessionFromRequest } from './auth.ts';
import type { Db } from './db.ts';
import { CORS_ORIGINS } from './config.ts';
import { log } from './log.ts';
import { metrics } from './metrics.ts';

/**
 * Broadcast to every socket, wallet filter off: these are global read-models.
 *
 * SEC-B43: a member is a *promise on two sides* — the wire map must be able to produce it, and the client's
 * invalidation table must know it (otherwise the frame is delivered, welcomed and dropped on the floor).
 * `price_update` was neither: no publisher in the backend and no `INVALIDATE` key in `client/src/api/ws.ts`.
 * Both halves are enforced by `tests/security/events-coverage.test.ts`, so the set cannot drift back into
 * "looks configured, does nothing".
 */
export const PUBLIC_TYPES = new Set(['listing_changed', 'sale', 'offer', 'params_changed', 'day_closed']);

export interface WsOptions {
  db: () => Db;
  path?: string;
  maxClients?: number;
  /** ms between server pings; a socket that misses a pong is terminated. */
  pingMs?: number;
  /** bytes of unsent data after which a client is dropped as too slow. */
  maxBacklog?: number;
  /**
   * SEC-B45: the origins allowed to open a socket, checked against the same allowlist as HTTP CORS.
   * `['*']` (the dev default) disables the check; a request with *no* `Origin` header — curl, a bot, a native
   * app — is always allowed, because the header is a browser control, not an authentication.
   */
  allowedOrigins?: string[];
  /** SEC-B46: how many concurrent sockets one client IP may hold (0 = no per-IP cap). */
  maxPerIp?: number;
  /** SEC-B46: trusted proxy hops for `x-forwarded-for`, mirroring Express's `trust proxy`. */
  trustProxyHops?: number | true;
}

interface ClientState { wallet?: string; ip?: string; alive: boolean; queue: string[]; queued: number; draining: boolean }

/**
 * SEC-B46: the client IP of an *upgrade* request, resolved by the rule Express applies to HTTP (`trust
 * proxy` = `TRUST_PROXY_HOPS`): start at the socket peer and walk `x-forwarded-for` from right to left,
 * skipping the trusted hops — with one trusted hop that is the rightmost entry, which nginx *appends*
 * (`$proxy_add_x_forwarded_for`), so the caller's own claim cannot move it. `true` trusts every hop (the dev
 * default) and yields the leftmost entry, exactly like `trust proxy: true`. An upgrade never reaches Express
 * (the http server's `upgrade` event is ours), so this is the only place the rule can be applied to a socket.
 */
export function upgradeIp(xff: string | string[] | undefined, remote: string | undefined, hops: number | true): string {
  const chain = String(Array.isArray(xff) ? xff.join(',') : xff ?? '').split(',').map((s) => s.trim()).filter(Boolean).reverse();
  if (!chain.length) return remote ?? 'unknown';
  if (hops === true) return chain[chain.length - 1] ?? remote ?? 'unknown';
  const n = Number.isFinite(hops) && (hops as number) > 0 ? (hops as number) : 0;
  return chain[n - 1] ?? chain[chain.length - 1] ?? remote ?? 'unknown';
}

/**
 * Env numbers, clamped: `Number('1M')` is NaN, and every comparison against NaN is false — i.e. a typo in
 * `WS_MAX_CLIENTS` / `WS_MAX_BACKLOG_BYTES` used to mean *no cap at all* while the value looked configured.
 * A value below the floor is replaced by the documented default (and in production `assertProductionConfig`
 * refuses to start on it, so the substitution can only ever happen in dev).
 */
const num = (raw: string | undefined, fallback: number, min: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
};

/**
 * The three limits as this module reads them, for `/metrics` (`ws_max_clients`, the denominator of the
 * saturation alert). Exported so the gauge reports the *effective* cap: reporting `WS_MAX_CLIENTS` raw would
 * print `NaN` for `WS_MAX_CLIENTS=500x`, and an alert dividing by that never fires.
 */
export const wsConfigFromEnv = (): { maxClients: number; pingMs: number; maxBacklog: number } => ({
  maxClients: num(process.env.WS_MAX_CLIENTS, 500, 1),
  pingMs: num(process.env.WS_PING_MS, 30_000, 0),
  maxBacklog: num(process.env.WS_MAX_BACKLOG_BYTES, 1 << 20, 1024),
});

export interface WsHub {
  wss: WebSocketServer;
  clients(): number;
  broadcast(m: { wallets?: string[]; type: string; payload: Record<string, unknown> }): void;
  close(): Promise<void>;
}

const validWallet = (s: string | null | undefined): string | undefined => {
  if (!s || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return undefined;
  try { return new PublicKey(s).toBase58(); } catch { return undefined; }
};

export function createWsHub(opts: WsOptions): WsHub {
  const path = opts.path ?? '/ws';
  const maxClients = opts.maxClients ?? num(process.env.WS_MAX_CLIENTS, 500, 1);
  const maxBacklog = opts.maxBacklog ?? num(process.env.WS_MAX_BACKLOG_BYTES, 1 << 20, 1024);
  // SEC-B46: `maxClients` bounds the process, not a caller — one host with a loop can take all 500 sockets
  // and leave the players who are actually playing with 1013. A cap per client IP keeps that a single
  // client's problem; it is generous (32 sockets is far more than one browser tab) because the honest failure
  // mode of a too-tight cap is refusing a real player. Rejections are visible as `ws_rejected_total{reason="per_ip"}`.
  const maxPerIp = opts.maxPerIp ?? num(process.env.WS_MAX_PER_IP, 32, 0);
  const trustHops = opts.trustProxyHops ?? (process.env.NODE_ENV === 'production' ? 1 : true);
  const perIp = new Map<string, number>();
  const ipCount = (ip: string) => perIp.get(ip) ?? 0;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  const state = new WeakMap<WebSocket, ClientState>();
  let open = 0;
  let unsub: (() => void) | undefined;

  const drain = (socket: WebSocket) => {
    const s = state.get(socket);
    if (!s || s.draining) return;
    s.draining = true;
    const clear = () => { s.queue.length = 0; s.queued = 0; };
    const next = () => {
      const frame = s.queue.shift();
      if (frame === undefined) { s.draining = false; return; }
      s.queued = Math.max(0, s.queued - Buffer.byteLength(frame)); // handed to the socket below
      if (socket.readyState !== WebSocket.OPEN) { clear(); s.draining = false; return; }
      socket.send(frame, (err) => {
        if (err) { metrics.counter('ws_send_error_total'); clear(); }
        next();
      });
    };
    next();
  };

  /**
   * SEC-B41: the single write path for application frames, bounded by bytes still queued *plus* whatever the
   * socket itself already holds. Returns false when the frame was refused — only ever after terminating the
   * socket, so a caller can still count the frame as delivered-to-nobody.
   */
  const enqueue = (socket: WebSocket, frame: string, bytes: number): boolean => {
    const s = state.get(socket);
    if (!s) return false;
    if (s.queued + socket.bufferedAmount + bytes > maxBacklog) {
      // A client that cannot drain a megabyte of invalidation hints will not catch up; drop it and let its
      // own backoff reconnect rather than letting the API process OOM on its behalf.
      metrics.counter('ws_dropped_total', { reason: 'backlog' });
      socket.terminate();
      return false;
    }
    s.queue.push(frame);
    s.queued += bytes;
    drain(socket);
    return true;
  };

  wss.on('connection', (socket, req) => {
    if (open >= maxClients) {
      metrics.counter('ws_rejected_total', { reason: 'capacity' });
      socket.close(1013, 'at capacity');
      return;
    }
    const ip = maxPerIp > 0 ? upgradeIp(req.headers['x-forwarded-for'], req.socket.remoteAddress, trustHops) : undefined;
    if (ip && ipCount(ip) >= maxPerIp) {
      metrics.counter('ws_rejected_total', { reason: 'per_ip' });
      socket.close(1013, 'at capacity');
      return;
    }
    if (ip) perIp.set(ip, ipCount(ip) + 1);
    open++;
    metrics.counter('ws_connections_total');
    metrics.gauge('ws_clients', open);

    const url = new URL(req.url ?? path, 'http://internal');
    const want = validWallet(url.searchParams.get('wallet'));
    // The session cookie, when present, only labels the log line: it tells an operator "this socket
    // belongs to a signed-in wallet" — it is not a check the REST layer does not already do itself.
    let sessionWallet: string | undefined;
    try { sessionWallet = validWallet(sessionFromRequest(opts.db(), { headers: req.headers } as never)?.wallet); } catch { /* no db in a unit test */ }
    if (want && sessionWallet && want !== sessionWallet) {
      // Not an attack (the data is public), but worth one WARN: "someone watched another wallet's feed"
      // is the first question asked in any incident review.
      log.warn('ws wallet mismatch', { want, sessionWallet });
      metrics.counter('ws_wallet_mismatch_total');
    }
    state.set(socket, { wallet: want ?? sessionWallet, ip, alive: true, queue: [], queued: 0, draining: false });

    socket.on('pong', () => { const s = state.get(socket); if (s) s.alive = true; });
    socket.on('message', (data: RawData) => {
      let m: { type?: string } | undefined;
      try { m = JSON.parse(String(data)) as { type?: string }; } catch { metrics.counter('ws_bad_message_total'); return; }
      if (m?.type === 'ping') {
        // Through the same outbox: a client that floods `ping` must not be able to make the server hold
        // replies for it (this `send` was the one write path the backlog guard did not cover at all).
        const pong = JSON.stringify({ type: 'pong', at: Date.now() });
        enqueue(socket, pong, Buffer.byteLength(pong));
      }
      else metrics.counter('ws_ignored_message_total');
    });
    socket.on('error', () => { /* a torn socket is normal; the client reconnects */ });
    socket.on('close', () => {
      open = Math.max(0, open - 1);
      const s = state.get(socket);
      // The per-IP count is decremented here and nowhere else: `terminate()` also lands here, and a slot that
      // is not given back is a cap that ratchets down until nobody can connect.
      if (s?.ip) { const left = ipCount(s.ip) - 1; if (left > 0) perIp.set(s.ip, left); else perIp.delete(s.ip); }
      state.delete(socket);
      metrics.gauge('ws_clients', open);
    });

    const hello = JSON.stringify({ type: 'ready', wallet: state.get(socket)!.wallet ?? null, serverTime: Date.now() });
    enqueue(socket, hello, Buffer.byteLength(hello));
  });

  const hub: WsHub = {
    wss,
    clients: () => open,
    broadcast(m) {
      const frame = JSON.stringify({ type: m.type, wallet: m.wallets?.[0] ?? null, payload: m.payload });
      const bytes = Buffer.byteLength(frame);
      const pub = PUBLIC_TYPES.has(m.type);
      const want = new Set(m.wallets ?? []);
      let hits = 0;
      for (const socket of wss.clients) {
        const s = state.get(socket);
        if (!s) continue;
        if (!pub && !(s.wallet && want.has(s.wallet))) continue;
        if (enqueue(socket, frame, bytes)) hits++;
      }
      metrics.counter('ws_events_total', { type: m.type });
      if (hits) metrics.counter('ws_frames_sent_total', { type: m.type }, hits);
    },
    async close() {
      unsub?.();
      for (const c of wss.clients) { try { c.close(1001, 'server restart'); } catch { /* ignore */ } }
      await new Promise<void>((res) => wss.close(() => res()));
    },
  };

  // Liveness: a socket that missed the pong since the previous ping is gone (half-open TCP after a
  // laptop sleep is the common case), and an unreadable socket must not keep its outbox memory alive.
  const pingMs = opts.pingMs ?? num(process.env.WS_PING_MS, 30_000, 0);
  const pinger = pingMs > 0 ? setInterval(() => {
    for (const socket of wss.clients) {
      const s = state.get(socket);
      if (!s) continue;
      if (!s.alive) { metrics.counter('ws_dropped_total', { reason: 'stalled' }); socket.terminate(); continue; }
      s.alive = false;
      try { socket.ping(); } catch { /* closing */ }
    }
  }, pingMs) : undefined;
  pinger?.unref();

  // Fan-out source. Installed after the hub exists, and removed on close, so a restart of the API
  // process cannot leave a stale subscriber holding a DB handle through the bus.
  unsub = bus().subscribe((m: BusMessage) => hub.broadcast({ wallets: m.wallets, type: m.type, payload: m.payload }));
  const closeAll = hub.close;
  hub.close = async () => { if (pinger) clearInterval(pinger); await closeAll(); };
  return hub;
}

/** Wire the hub onto an http server at `path` (liveness lives in the hub). Returns hub + close(). */
/** One log line per 30 s with a suppressed (but counted) tail — see `bus.ts` for the same pattern. */
let warnAt = 0;
let warnSuppressed = 0;
function warnThrottled(msg: string, fields: Record<string, unknown>, everyMs = 30_000): void {
  const now = Date.now();
  if (now - warnAt < everyMs) { warnSuppressed += 1; return; }
  warnAt = now;
  const suppressed = warnSuppressed;
  warnSuppressed = 0;
  log.warn(msg, { ...fields, ...(suppressed ? { suppressed } : {}) });
}

export function attachWs(server: Server, opts: WsOptions): { hub: WsHub; close: () => Promise<void> } {
  const hub = createWsHub(opts);
  const path = opts.path ?? '/ws';
  const allowed = opts.allowedOrigins ?? CORS_ORIGINS;
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => { /* a torn socket during upgrade is normal */ });
    let pathname = '/';
    try { pathname = new URL(req.url ?? '/', 'http://internal').pathname; } catch { socket.destroy(); return; }
    if (pathname !== path) { socket.destroy(); return; } // not ours: another upgrade handler owns it
    if ((req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
      metrics.counter('ws_rejected_total', { reason: 'not_upgrade' });
      socket.write('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // SEC-B45: an upgrade is *not* subject to CORS — the browser hands the page whatever the server sends —
    // so the CORS allowlist has to be enforced by hand here or not at all. Without this, any origin can open
    // a socket to /ws: read the market frames the REST layer would refuse it cross-origin, subscribe to any
    // wallet's activity in real time (`?wallet=` needs no session), and hold the whole `WS_MAX_CLIENTS`
    // capacity from one page. A missing `Origin` (curl, a bot, a service) is allowed: the header is a control
    // on browsers, not an identity — and a non-browser client can lie about it either way.
    const origin = req.headers.origin;
    if (origin && !allowed.includes('*') && !allowed.includes(origin)) {
      // The metric counts every attempt; the log line is throttled, because a page in a loop must not be able
      // to turn a refusal into a log flood (a WARN per attempt is a cheap way to fill a disk).
      metrics.counter('ws_rejected_total', { reason: 'origin' });
      warnThrottled('ws upgrade refused: origin not allowed', { origin });
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    hub.wss.handleUpgrade(req, socket, head, (ws) => hub.wss.emit('connection', ws, req));
  };
  server.on('upgrade', onUpgrade);
  return { hub, close: async () => { await hub.close(); server.off('upgrade', onUpgrade); } };
}
