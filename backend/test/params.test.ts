// SEC-B2 (SECURITY-AUDIT-2026-09-26.md) — hostile query parameters on the public API.
//
// What went wrong before this file existed, and why it is a test and not just a patch:
//
//   `GET /v1/wallet/<addr>/events?limit=-1`  → 200 with the **whole** matching event feed
//       (`Math.min(-1, 200)` passed the negative straight into SQL, and SQLite reads a negative
//       LIMIT as "no limit" — the documented 200-row cap was decorative);
//   the same endpoint with `?limit=abc` or `?limit=1.5` → **500** `datatype mismatch`
//       (node:sqlite binds NaN as NULL and `LIMIT NULL` is an error, so a client typo produced an
//       unhandled request error instead of a 4xx);
//   `?collection=abc` on the market → 200 with an empty page, i.e. "nothing matches" instead of
//       "your filter is invalid"; `?sort=bogus` and `?indexMin=` were silently ignored.
//
// The rule now: a numeric parameter is a single decimal integer inside its declared range or the
// request is a 400; `limit` above its maximum is clamped (never negative); unknown enum values are
// rejected. These tests are the executable form of that rule for every public route that takes one.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { Db } from '../src/db.ts';
import { ingestTx } from '../src/ingest.ts';
import { createApp } from '../src/server.ts';
import { MemoryStore, createLimiter } from '../src/ratelimit.ts';
import { clampInt, cursorQuery, intQuery, limitQuery } from '../src/params.ts';
import { ServiceError } from '../src/services.ts';
import { world } from './fixtures.ts';

let db: Db;
let server: Server;
let base: string;
let w: ReturnType<typeof world>;

beforeAll(async () => {
  db = new Db(':memory:');
  w = world();
  for (const t of w.txs) ingestTx(t, db);
  // Rate limiting is deliberately off *for this file*: the hostile-parameter sweep below issues a few
  // thousand requests, and the limiter would answer 429 after the first 600 — i.e. the fuzz would stop
  // reaching the handlers it is supposed to test. The limiter itself is covered by security.test.ts.
  const app = createApp(db, { arenaSweepMs: 0, limiter: createLimiter(new MemoryStore(), false) });
  await new Promise<void>((f) => { server = app.listen(0, '127.0.0.1', () => f()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((f) => server.close(() => f())));

const get = (path: string) => fetch(base + path);

describe('params.ts — the parser contract', () => {
  it('accepts only single decimal integers in range', () => {
    expect(intQuery('7', { name: 'n' })).toBe(7);
    expect(intQuery('+7', { name: 'n' })).toBe(7);
    expect(intQuery('', { name: 'n', def: 3 })).toBe(3);
    expect(intQuery(undefined, { name: 'n', def: 3 })).toBe(3);
    expect(intQuery(undefined, { name: 'n' })).toBeUndefined();
    for (const bad of ['abc', '1.5', '1e3', 'NaN', 'Infinity', '-1', ' 1', '0x10', '1,000', '9'.repeat(30)]) {
      expect(() => intQuery(bad, { name: 'n', min: 0 }), `intQuery(${JSON.stringify(bad)})`).toThrow(ServiceError);
    }
    // `null` is what Express hands us for `?limit` with no value — that is "absent", not "invalid".
    expect(intQuery(null, { name: 'n', def: 9 })).toBe(9);
    // Express' extended parser produces arrays/objects for repeated and nested keys.
    for (const bad of [['1', '2'], { a: '1' }, 5, true]) {
      expect(() => intQuery(bad as never, { name: 'n' })).toThrow(ServiceError);
    }
    expect(() => intQuery('500', { name: 'n', max: 200 })).toThrow(ServiceError);
  });
  it('limitQuery clamps above the maximum but never below the minimum', () => {
    expect(limitQuery('10', { max: 200, def: 50 })).toBe(10);
    expect(limitQuery('100000', { max: 200, def: 50 })).toBe(200);
    expect(limitQuery(undefined, { max: 200, def: 50 })).toBe(50);
    for (const bad of ['-1', 'abc', '1.5']) expect(() => limitQuery(bad, { max: 200, def: 50 })).toThrow(ServiceError);
  });
  it('cursorQuery is a non-negative integer string or a 400', () => {
    expect(cursorQuery('250')).toBe('250');
    expect(cursorQuery(undefined)).toBeUndefined();
    for (const bad of ['-1', 'abc', '1.5', '1e9']) expect(() => cursorQuery(bad)).toThrow(ServiceError);
  });
  it('clampInt is total (the query layer must never emit NaN or a negative LIMIT)', () => {
    expect(clampInt(NaN, 0, 200)).toBe(0);
    expect(clampInt(Infinity, 0, 200)).toBe(200);
    expect(clampInt(-5, 0, 200)).toBe(0);
    expect(clampInt(1.9, 0, 200)).toBe(1);
    expect(clampInt(50, 0, 200)).toBe(50);
  });
});

describe('/v1/wallet/:address/events — the endpoint that produced both failures', () => {
  it('answers 200 for a valid limit and honours it', async () => {
    const res = await get(`/v1/wallet/${w.alice}/events?limit=1`);
    expect(res.status).toBe(200);
    expect((await res.json() as { events: unknown[] }).events).toHaveLength(1);
  });
  it('rejects non-integers with 400 instead of 500', async () => {
    for (const q of ['abc', '1.5', 'NaN', 'Infinity', '1e3', '0x1', '1,2']) {
      const res = await get(`/v1/wallet/${w.alice}/events?limit=${q}`);
      expect(res.status, `limit=${q}`).toBe(400);
      expect((await res.json() as { code: string }).code).toBe('bad_request');
    }
  });
  it('rejects a negative limit (SQLite reads LIMIT -1 as "no limit")', async () => {
    const res = await get(`/v1/wallet/${w.alice}/events?limit=-1`);
    expect(res.status).toBe(400);
    expect((await res.json() as { code: string }).code).toBe('bad_request');
  });
  it('rejects a repeated parameter rather than picking one', async () => {
    const res = await get(`/v1/wallet/${w.alice}/events?limit=1&limit=2`);
    expect(res.status).toBe(400);
  });
  it('clamps an oversized limit to the documented maximum', async () => {
    const res = await get(`/v1/wallet/${w.alice}/events?limit=1000000`);
    expect(res.status).toBe(200);
    const body = await res.json() as { events: unknown[] };
    expect(body.events.length).toBeLessThanOrEqual(200);
  });
  it('accepts limit=0 (an empty page is a legitimate answer)', async () => {
    const res = await get(`/v1/wallet/${w.alice}/events?limit=0`);
    expect(res.status).toBe(200);
    expect((await res.json() as { events: unknown[] }).events).toHaveLength(0);
  });
});

describe('/v1/market/* — filters that used to be silently ignored', () => {
  it('rejects non-integer filters instead of returning an empty page', async () => {
    for (const q of ['collection=abc', 'rarity=1.5', 'rarityMin=-1', 'rarity=99', 'collection=999']) {
      const res = await get(`/v1/market/listings?${q}`);
      expect(res.status, q).toBe(400);
    }
    for (const q of ['collection=abc', 'rarity=abc', 'cursor=-1']) {
      const res = await get(`/v1/market/history?${q}`);
      expect(res.status, q).toBe(400);
    }
  });
  it('rejects an invalid sort / currency / limit / price filter', async () => {
    for (const q of ['sort=bogus', 'currency=DOGE', 'limit=abc', 'limit=-1', 'cursor=-1', 'priceMaxUsd=abc', 'priceMaxUsd=-2']) {
      const res = await get(`/v1/market/listings?${q}`);
      expect(res.status, q).toBe(400);
    }
  });
  it('accepts the index filters/sort that shape #27 restored, validating them like every other number', async () => {
    // SEC-B3 made these three a 400 while the projection had no game index. The column exists now
    // (backend/test/chip-index.test.ts covers the semantics), so here we only pin the boundary:
    // valid → 200, malformed → 400, and never `not_supported` for a parameter the contract documents.
    for (const q of ['sort=index_asc', 'indexMin=0', 'indexMax=5', 'indexMin=1&indexMax=9']) {
      const res = await get(`/v1/market/listings?${q}`);
      expect(res.status, q).toBe(200);
    }
    for (const q of ['indexMin=abc', 'indexMin=-1', 'indexMin=1.5', 'indexMax=4294967296']) {
      const res = await get(`/v1/market/listings?${q}`);
      expect(res.status, q).toBe(400);
      expect((await res.json() as { code: string }).code, q).toBe('bad_request');
    }
  });
  it('still serves the valid path', async () => {
    const res = await get('/v1/market/listings?collection=3&rarityMin=0&sort=price_asc&limit=10');
    expect(res.status).toBe(200);
  });
});

describe('/v1/leaderboard — season + cursor', () => {
  it('rejects a fractional / non-numeric / repeated season', async () => {
    for (const q of ['1.5', 'abc', '1&season=2', '1e3', '-1']) {
      const res = await get(`/v1/leaderboard/rating?season=${q}`);
      expect(res.status, q).toBe(400);
      expect((await res.json() as { code: string }).code).toBe('bad_season');
    }
  });
  it('accepts a valid season and cursor', async () => {
    expect((await get('/v1/leaderboard/rating?season=1&cursor=0')).status).toBe(200);
    expect((await get('/v1/leaderboard/wins?limit=1000')).status).toBe(200);
    expect((await get('/v1/leaderboard/wins?cursor=-1')).status).toBe(400);
  });
});

describe('a 4xx is the whole contract — no route may answer 5xx on a hostile query string', () => {
  // Built inside the test: `w` only exists after beforeAll (module-level evaluation would be a
  // "Cannot read properties of undefined" instead of a failing request).
  const paths = () => [
    `/v1/wallet/${w.alice}/events`,
    '/v1/market/listings', '/v1/market/history', '/v1/market/floor', '/v1/market/offers',
    '/v1/leaderboard/rating', '/v1/leaderboard/wins', '/v1/leaderboard/collection', '/v1/leaderboard/staking', '/v1/leaderboard/fusion',
    `/v1/chips/${w.chips[0]}`, '/v1/collections', '/v1/collections/0/chips/0', '/v1/packs', '/v1/packs/opens/x', '/v1/services', '/v1/stats', '/v1/prices', '/v1/health',
  ];
  const KEYS = ['limit', 'cursor', 'offset', 'season', 'collection', 'rarity', 'rarityMin', 'levelMin', 'indexMin', 'priceMaxUsd', 'qty', 'page', 'sort', 'currency', 'status'];
  const VALUES = ['abc', '1.5', '-1', '1e999', '9'.repeat(40), '', '1'];

  // The shape of this sweep is quoted in docs/06 §2.2 and SECURITY-AUDIT-2026-09-26.md. Those numbers
  // were wrong once (docs said 18×16×7 while the file swept 19×15×7 with an extra repeated-parameter
  // request per key), which is exactly the kind of drift a reader cannot check by eye — so the shape is
  // asserted here: change the sweep, and this test tells you which documents to update.
  it('the sweep shape is the one the audit report quotes', () => {
    expect([paths().length, KEYS.length, VALUES.length]).toEqual([19, 15, 7]);
  });

  it('responses for a hostile limit stay bounded (no unbounded LIMIT path)', async () => {
    const res = await get(`/v1/wallet/${w.alice}/events?limit=999999`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.length).toBeLessThan(200_000);
  });

  it('every GET path × every hostile parameter answers < 500', async () => {
    const bad: string[] = [];
    for (const path of paths()) {
      for (const k of KEYS) {
        for (const v of VALUES) {
          const res = await get(`${path}?${k}=${encodeURIComponent(v)}`);
          const text = await res.text();
          if (res.status >= 500) bad.push(`${path}?${k}=${v} → ${res.status}`);
          // A hostile parameter must not be able to make us build an unbounded response either:
          // `LIMIT -1` is "no limit" to SQLite, and the fixture world is small, so 300 KB means the
          // endpoint ignored its cap rather than "the data is big".
          else if (text.length > 300_000) bad.push(`${path}?${k}=${v} → ${text.length} bytes`);
        }
        const repeated = await get(`${path}?${k}=1&${k}=2`);
        if (repeated.status >= 500) bad.push(`${path}?${k}=1&${k}=2 → ${repeated.status}`);
        await repeated.arrayBuffer();
      }
    }
    expect(bad).toEqual([]);
  }, 60_000);

});
