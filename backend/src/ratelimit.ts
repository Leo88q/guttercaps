// Rate limiting (SEC-H3, docs/06 §2.2). Sliding-window counters keyed by IP / wallet / session
// with the policy table below; `429` + `Retry-After` + `RateLimit-*` headers (IETF draft-7 style).
//
// The store is an interface so production can swap the in-process map for Redis (`INCR` +
// `PEXPIRE` on the same window keys) without touching the policies; one API replica with the
// memory store is already enough for the abuse profile in docs/06 §5 (LT-1).
import type { NextFunction, Request, Response } from 'express';
import { RATE_LIMIT_ENABLED } from './config.ts';

export interface RateLimitStore {
  /** Increment `key` inside the window that started at `windowStart` (ms); returns the new count. */
  hit(key: string, windowStart: number, windowMs: number): number;
  /** Test hook. */
  reset(): void;
}

/** Fixed windows with lazy expiry; memory bounded by `sweep()` every ~1 000 hits. */
export class MemoryStore implements RateLimitStore {
  private buckets = new Map<string, { windowStart: number; count: number; expiresAt: number }>();
  private hits = 0;
  hit(key: string, windowStart: number, windowMs: number): number {
    if (++this.hits % 1000 === 0) this.sweep();
    const b = this.buckets.get(key);
    if (b && b.windowStart === windowStart) { b.count += 1; return b.count; }
    this.buckets.set(key, { windowStart, count: 1, expiresAt: windowStart + 2 * windowMs });
    return 1;
  }
  reset() { this.buckets.clear(); }
  private sweep() {
    const t = Date.now();
    for (const [k, b] of this.buckets) if (b.expiresAt < t) this.buckets.delete(k);
  }
}

export interface Policy {
  /** Policy name → part of the store key and the `RateLimit-Policy` header. */
  name: string;
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
  /** Which identity the counter is bound to. `session` falls back to IP when unauthenticated; `ipnet` = IPv4 /24, IPv6 /48 (docs/02: "rate-limit по IP /24"). */
  by: 'ip' | 'ipnet' | 'wallet' | 'session';
}

/**
 * Policy table (docs/06 SEC-H3): nonce 10/min/IP + 30/h/wallet; reads 600/min/IP; mutations
 * 60/min/session; quotes 30/min/session (each one may hit the RPC); claims 10/min/session.
 */
export const POLICIES = {
  nonceIp: { name: 'nonce-ip', limit: 10, windowMs: 60_000, by: 'ip' },
  nonceWallet: { name: 'nonce-wallet', limit: 30, windowMs: 3_600_000, by: 'wallet' },
  verifyIp: { name: 'verify-ip', limit: 20, windowMs: 60_000, by: 'ip' },
  read: { name: 'read', limit: 600, windowMs: 60_000, by: 'ip' },
  mutate: { name: 'mutate', limit: 60, windowMs: 60_000, by: 'session' },
  quote: { name: 'quote', limit: 30, windowMs: 60_000, by: 'session' },
  claim: { name: 'claim', limit: 10, windowMs: 60_000, by: 'session' },
  /** Reward-ish mutations per network (T-B-49): 10 sessions × 10/min from one /24 is a farm, not a household. */
  claimNet: { name: 'claim-net', limit: 40, windowMs: 60_000, by: 'ipnet' },
  /** SEC-B18: the handle check takes a 120 s hold, so it is a mutation wearing a GET — per session, not per IP. */
  handleCheck: { name: 'handle-check', limit: 30, windowMs: 60_000, by: 'session' },
  arena: { name: 'arena', limit: 20, windowMs: 60_000, by: 'session' },
  /** Turnstile verification: each call may hit siteverify. */
  human: { name: 'human', limit: 6, windowMs: 60_000, by: 'session' },
  humanNet: { name: 'human-net', limit: 30, windowMs: 3_600_000, by: 'ipnet' },
} as const satisfies Record<string, Policy>;

export function clientIp(req: Request): string {
  // `trust proxy` is on, so express already resolved X-Forwarded-For left-most; fall back to socket.
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  // IPv6 /64 and IPv4 exact: a home /64 counts as one client, a single IPv4 as one client.
  if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':') + '::/64';
  return ip;
}

/** Network key for the /24-style limits and for `human_checks.ip_net`: IPv4 /24, IPv6 /48 (one ISP customer). */
export function ipNet(req: Request): string {
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  if (ip.includes(':')) {
    const v4 = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip)?.[1];
    if (v4) return v4.split('.').slice(0, 3).join('.') + '.0/24';
    return ip.split(':').slice(0, 3).join(':') + '::/48';
  }
  const parts = ip.split('.');
  return parts.length === 4 ? parts.slice(0, 3).join('.') + '.0/24' : ip;
}

export function identityFor(req: Request, by: Policy['by'], walletFromBody?: (req: Request) => string | undefined): string {
  if (by === 'session' && req.session) return `s:${req.session.id}`;
  if (by === 'wallet') {
    const w = req.session?.wallet ?? walletFromBody?.(req);
    if (w) return `w:${w}`;
  }
  if (by === 'ipnet') return `net:${ipNet(req)}`;
  return `ip:${clientIp(req)}`;
}

export interface Limiter {
  /** Express middleware enforcing `policy` (several may be stacked on one route). */
  use(policy: Policy, opts?: { wallet?: (req: Request) => string | undefined }): (req: Request, res: Response, next: NextFunction) => void;
  store: RateLimitStore;
}

export function createLimiter(store: RateLimitStore = new MemoryStore(), enabled = RATE_LIMIT_ENABLED, now: () => number = Date.now): Limiter {
  return {
    store,
    use(policy, opts = {}) {
      return (req, res, next) => {
        if (!enabled) { next(); return; }
        const t = now();
        const windowStart = t - (t % policy.windowMs);
        const id = identityFor(req, policy.by, opts.wallet);
        const count = store.hit(`${policy.name}|${id}`, windowStart, policy.windowMs);
        const remaining = Math.max(0, policy.limit - count);
        const resetS = Math.ceil((windowStart + policy.windowMs - t) / 1000);
        // Several policies may guard one route: the headers describe the tightest one (least remaining).
        const prev = res.get('RateLimit-Remaining');
        if (prev === undefined || remaining < Number(prev)) {
          res.set('RateLimit-Policy', `${policy.limit};w=${policy.windowMs / 1000}`);
          res.set('RateLimit-Limit', String(policy.limit));
          res.set('RateLimit-Remaining', String(remaining));
          res.set('RateLimit-Reset', String(resetS));
        }
        if (count > policy.limit) {
          res.set('Retry-After', String(resetS));
          res.status(429).json({ code: 'rate_limited', message: `Too many requests (${policy.name}: ${policy.limit} per ${policy.windowMs / 1000} s)`, details: { policy: policy.name, retryAfterS: resetS } });
          return;
        }
        next();
      };
    },
  };
}
