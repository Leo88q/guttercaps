// Redis: two uses, both optional and both designed to degrade to "no Redis" without changing
// behaviour the client can see (docs/09 §4.2).
//
//  1. rate limiting — the per-process token bucket in `ratelimit.ts` is exact inside one process and
//     blind across replicas: N API pods give a caller N× the budget. `redisGuard()` adds a shared
//     fixed-window counter in front of it (atomic INCR + PEXPIRE in one Lua script, so no
//     read-modify-write race), and the local limiter stays as the fast path and as the fallback when
//     Redis is down. A burst that a single instance would have caught is therefore caught twice, and
//     a distributed one is caught once instead of never.
//  2. the event bus — see `bus.ts`; the socket fan-out rides the same server.
//
// Why the guard is middleware and not the limiter's store: `RateLimitStore.hit()` is synchronous
// (node:sqlite-style sync code path, and the limiter is called from sync helpers too), so a store
// that has to await a network round-trip would either block the loop or need a write-behind mirror
// that lies during a restart. A middleware may await, and when Redis is slow the middleware can give
// up in milliseconds and hand the decision to the local bucket.
import type { NextFunction, Request, Response } from 'express';
import { log, errFields } from './log.ts';
import { clientIp } from './ratelimit.ts';
import { metrics } from './metrics.ts';

export interface RedisLike {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  ping(): Promise<string>;
  publish?(channel: string, message: string): Promise<number>;
  quit?(): Promise<unknown>;
  disconnect?(): void;
  on?(event: string, fn: (e: unknown) => void): void;
}

/** `INCR` + first-write `PEXPIRE`, one script, one round trip. Returns `[count, ttlMs]`. */
const GUARD_LUA = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return { n, redis.call('PTTL', KEYS[1]) }
`;

export interface RedisGuardOptions {
  client: RedisLike;
  /** requests allowed per `windowMs` per IP — the cross-instance ceiling, not a replacement for POLICIES. */
  limit: number;
  windowMs: number;
  /** how long to wait for Redis before deferring to the local limiter. */
  timeoutMs?: number;
  keyPrefix?: string;
}

export function createRedisGuard(opts: RedisGuardOptions) {
  const { client, limit, windowMs } = opts;
  const prefix = opts.keyPrefix ?? 'rl';
  const timeoutMs = opts.timeoutMs ?? 250;
  return function redisGuard(req: Request, res: Response, next: NextFunction) {
    const bucket = Math.floor(Date.now() / windowMs);
    // SEC-B42: `clientIp` — the same key function the local limiter uses (SEC-B38), not the raw address text
    // run through a character filter. The old key kept one caller's spellings apart: a v4-mapped
    // `::ffff:203.0.113.9` and a plain `203.0.113.9` were two shared-budget buckets (and `2001:db8::5` vs
    // `2001:db8::6` were two more for one /64), so an attacker who can arrive over both edges — or who holds
    // a /64 — got a fresh cross-instance budget per spelling, which is the aggregation this guard exists for.
    // Both layers now count one client in one bucket: IPv4 as dotted text, a v4-mapped address as its dotted
    // IPv4, IPv6 as its /64 prefix.
    const ip = clientIp(req);
    const key = `${prefix}:${ip}:${bucket}`;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      metrics.counter('redis_guard_total', { outcome: 'timeout' });
      next(); // slow Redis must not become a 500: the local bucket still applies
    }, timeoutMs);
    client.eval(GUARD_LUA, 1, key, String(windowMs)).then((r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const [n, ttl] = Array.isArray(r) ? [Number(r[0]), Number(r[1])] : [Number((r as { 0?: number })?.[0] ?? 0), windowMs];
      metrics.counter('redis_guard_total', { outcome: n > limit ? 'blocked' : 'allowed' });
      if (n > limit) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((ttl > 0 ? ttl : windowMs) / 1000))));
        res.status(429).json({ code: 'rate_limited', message: 'Too many requests across this edge — retry shortly', scope: 'global' });
        return;
      }
      next();
    }).catch((e: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      metrics.counter('redis_guard_total', { outcome: 'error' });
      log.warn('redis guard failed open', errFields(e));
      next();
    });
  };
}

export interface RedisHandle { client: RedisLike | undefined; ping(): Promise<boolean>; close(): Promise<void> }

/**
 * Connect when `REDIS_URL` is set. Never fatal: an unreachable Redis costs the distributed burst
 * budget and the cross-process bus, and the API keeps serving with its local limiter.
 */
export async function connectRedis(url = process.env.REDIS_URL, purpose = 'rate limit'): Promise<RedisHandle> {
  if (!url) return { client: undefined, async ping() { return false; }, async close() { /* nothing */ } };
  try {
    const { Redis } = await import('ioredis');
    const client = new Redis(url, { maxRetriesPerRequest: 2, enableOfflineQueue: false, connectTimeout: 2_000, lazyConnect: true });
    client.on?.('error', (e: unknown) => { metrics.counter('redis_error_total'); log.warn(`redis ${purpose} error`, errFields(e)); });
    await client.ping();
    log.info(`redis ${purpose} connected`);
    return {
      client,
      async ping() { try { return (await client.ping()) === 'PONG'; } catch { return false; } },
      async close() { try { await client.quit?.(); } catch { client.disconnect?.(); } },
    };
  } catch (e) {
    log.warn(`redis ${purpose} unavailable — continuing without it`, errFields(e));
    return { client: undefined, async ping() { return false; }, async close() { /* nothing */ } };
  }
}
