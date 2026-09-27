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
  return ipKey(req.ip ?? req.socket.remoteAddress ?? 'unknown');
}

/**
 * SEC-B38: the per-client key — IPv4 exact, IPv6 by /64 (SEC-H3: "a home /64 counts as one client").
 *
 * It used to slice the *text* of the address (`ip.split(':').slice(0, 4)`), which is only a /64 when the text
 * happens to be the fully expanded form. `2001:db8::5` and `2001:db8::6` are one /64, but as text they are
 * different keys (`2001:db8::5::/64` — not even a well-formed prefix), so an attacker holding a /64 whose
 * first four groups contain the `::` collapse got a fresh 600-request budget per source address and the
 * aggregation the limit exists for did nothing. A v4-mapped address (`::ffff:203.0.113.9`) was a third key
 * for a client that also arrives as `203.0.113.9`. Parsing to bytes first makes equal networks equal keys,
 * in one canonical spelling, whatever the edge wrote.
 */
export function ipKey(ip: string): string {
  const bytes = parseIpv6(ip);
  if (!bytes) return ip;                                        // IPv4 (or 'unknown'): already exact
  if (isV4Mapped(bytes)) return v4FromMapped(bytes);
  return `${v6Groups(bytes).slice(0, 4).join(':')}::/64`;
}

/** Network key for the /24-style limits and for `human_checks.ip_net`: IPv4 /24, IPv6 /48 (one ISP customer). */
export function ipNet(req: Request): string {
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  const bytes = parseIpv6(ip);
  if (bytes) {
    const v4 = isV4Mapped(bytes) ? v4FromMapped(bytes) : null;
    return v4 ? `${v4.split('.').slice(0, 3).join('.')}.0/24` : `${v6Groups(bytes).slice(0, 3).join(':')}::/48`;
  }
  const parts = ip.split('.');
  return parts.length === 4 ? `${parts.slice(0, 3).join('.')}.0/24` : ip;
}

/**
 * IPv6 text → 16 bytes, or `null` when this is not one (IPv4 and anything unparseable). Handles the `::`
 * collapse, upper case, leading zeros, one embedded dotted-quad tail (`::ffff:1.2.3.4`, the form an edge
 * usually writes for an IPv4 client) and rejects everything else — `::1::2`, `1:2:3:4:5:6:7:8:9`, `12345::`.
 */
function parseIpv6(ip: string): Uint8Array | null {
  const raw = ip.trim().toLowerCase();
  if (!raw.includes(':')) return null;
  const zone = raw.indexOf('%');                                // `fe80::1%eth0` — scope is not part of the key
  const text = zone === -1 ? raw : raw.slice(0, zone);
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    const items = part.split(':');
    for (const [i, item] of items.entries()) {
      if (i === items.length - 1 && item.includes('.')) {        // dotted-quad tail: only as the last group
        const quad = item.split('.').map(Number);
        if (quad.length !== 4 || quad.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        out.push(quad[0] * 256 + quad[1], quad[2] * 256 + quad[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(item)) return null;
      out.push(parseInt(item, 16));
    }
    return out;
  };
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  if (!head || !tail) return null;
  // No `::`: exactly 8 groups. With it: the collapse stands for at least one — `1:2:3:4:5:6:7:8` has none and
  // `1:2:3:4:5:6:7::` is the same address as `1:2:3:4:5:6:7:0`, so a full-length left side is not a collapse.
  const filled = halves.length === 1 ? head : [...head, ...Array(8 - head.length - tail.length).fill(0), ...tail];
  if (filled.length !== 8 || (halves.length === 2 && head.length + tail.length > 7)) return null;
  const bytes = new Uint8Array(16);
  filled.forEach((g, i) => { bytes[i * 2] = g >> 8; bytes[i * 2 + 1] = g & 0xff; });
  return bytes;
}

function v6Groups(bytes: Uint8Array): string[] {
  return Array.from({ length: 8 }, (_, i) => ((bytes[i * 2] << 8) | bytes[i * 2 + 1]).toString(16));
}

/** `::ffff:a.b.c.d` — the IPv4-mapped range (both bytes of group 6 are the last two of the prefix). */
function isV4Mapped(bytes: Uint8Array): boolean {
  return bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
}

function v4FromMapped(bytes: Uint8Array): string {
  return `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
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
