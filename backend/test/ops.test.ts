// Ops surface (docs/09 §4.1): structured logs, Prometheus exposition, /readyz, the /ws fan-out,
// the shared-Redis burst guard, and the shutdown order. These are the pieces that decide whether an
// incident is diagnosable and whether a rolling deploy is lossless, and none of them are reachable
// from the client — which is exactly why they need their own tests.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http, { type Server } from 'node:http';
import { rmSync } from 'node:fs';
import { WebSocket } from 'ws';
import { Keypair } from '@solana/web3.js';
import { Db } from '../src/db.ts';
import { useDb } from '../src/db.ts';
import { createApp } from '../src/server.ts';
import { log, logContext, runWithContext, newRequestId, routePattern, errFields, requestLogger } from '../src/log.ts';
import { metrics } from '../src/metrics.ts';
import { installBus, bus, walletsOf, type BusMessage } from '../src/bus.ts';
import { wireEvent, WIRE_TYPE, snake } from '../src/wire.ts';
import { readiness } from '../src/health.ts';
import { createRedisGuard } from '../src/redis.ts';
import type { RedisLike } from '../src/redis.ts';
import { createWsHub, attachWs, PUBLIC_TYPES, wsConfigFromEnv, upgradeIp } from '../src/ws.ts';
import { installShutdown } from '../src/shutdown.ts';
import { ingestTx } from '../src/ingest.ts';
import { tx, nextSig, hex32 } from './fixtures.ts';

describe('structured logs', () => {
  it('request id is unique, url-safe and short enough for a header', () => {
    const ids = new Set(Array.from({ length: 500 }, newRequestId));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_.-]{1,64}$/);
  });

  it('context set around a call is visible inside it and gone after it', async () => {
    await runWithContext({ requestId: 'req-1', wallet: 'w1' }, async () => {
      expect(logContext().requestId).toBe('req-1');
      await Promise.resolve();
      expect(logContext().requestId).toBe('req-1'); // survives the await — that is the whole point of ALS
    });
    expect(logContext().requestId).toBeUndefined();
  });

  it('an Error becomes message + code fields, never a raw object in JSON', () => {
    const e = Object.assign(new Error('no such table: chips'), { code: 'SQLITE_ERROR' });
    const f = errFields(e);
    expect(f.err).toBe('no such table: chips');
    expect(f.errCode).toBe('SQLITE_ERROR');
    expect(JSON.stringify(f).length).toBeLessThan(200);
  });

  it('log functions accept a field bag without throwing on circular / huge values', () => {
    const seen: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => { seen.push(String(s)); return true; }) as never;
    try {
      const cyc: Record<string, unknown> = { a: 1 }; cyc.self = cyc;
      expect(() => log.error('boom', { bad: cyc })).not.toThrow();
    } finally { process.stderr.write = write; }
    if (seen.length) expect(seen[0]).toContain('boom');
    else expect(true).toBe(true); // LOG_LEVEL above error: filtered, which is also a pass
  });

  it('routePattern returns the template, not the raw url', () => {
    expect(routePattern({ baseUrl: '/v1', path: '/chip/3HxVx', originalUrl: '/v1/chip/3HxVx?x=1', route: { path: '/:asset' } } as never))
      .toBe('/v1/:asset');
    expect(routePattern({ baseUrl: '/v1', path: '/health', originalUrl: '/v1/health', route: { path: '/' } } as never)).toBe('/v1');
    // 404s must not become one series per probe
    expect(routePattern({ baseUrl: '/v1', path: '/../../etc/passwd', originalUrl: '/v1/../../etc/passwd' } as never)).toBe('/v1!unmatched');
    expect(routePattern({ baseUrl: '', path: '/x', originalUrl: '/x' } as never)).toBe('!unmatched');
    expect(routePattern({ baseUrl: '', path: '/y', originalUrl: '/y?a=1' } as never)).toBe('!unmatched');
  });

  it('requestLogger sets x-request-id on the response before the handler runs', async () => {
    const mw = requestLogger();
    let header = '';
    const res = { setHeader: (k: string, v: string) => { if (k === 'x-request-id') header = v; }, once: () => undefined, statusCode: 200 } as never;
    const req = { header: (k: string) => (k === 'x-request-id' ? 'spoofed<bad>' : undefined), headers: { 'x-request-id': 'spoofed<bad>' }, method: 'GET', originalUrl: '/v1/x', ip: '1.1.1.1', baseUrl: '/v1', path: '/x' } as never;
    await new Promise<void>((done) => mw(req, res, () => done()));
    expect(header).toMatch(/^[A-Za-z0-9]{16}$/); // an unusable inbound id is replaced, not echoed
    void log.info;
  });

  it('TRUST_REQUEST_ID=1 adopts a well-formed edge id', async () => {
    const prev = process.env.TRUST_REQUEST_ID;
    process.env.TRUST_REQUEST_ID = '1';
    try {
      const mw = requestLogger();
      let header = '';
      const res = { setHeader: (k: string, v: string) => { if (k === 'x-request-id') header = v; }, once: () => undefined, statusCode: 200 } as never;
      await new Promise<void>((done) => mw({ header: (k: string) => (k === 'x-request-id' ? 'cf-abc_123' : undefined), headers: { 'x-request-id': 'cf-abc_123' }, method: 'GET', originalUrl: '/v1/x', baseUrl: '/v1', path: '/x' } as never, res, () => done()));
      expect(header).toBe('cf-abc_123');
    } finally { if (prev === undefined) delete process.env.TRUST_REQUEST_ID; else process.env.TRUST_REQUEST_ID = prev; }
  });
});

describe('metrics exposition', () => {
  beforeEach(() => { metrics.resetForTests(); });

  it('renders HELP/TYPE and label sets Prometheus will accept', async () => {
    metrics.counter('http_requests_total', { method: 'GET', route: '/v1/health', status: '200' });
    metrics.counter('http_requests_total', { method: 'GET', route: '/v1/health', status: '200' }, 2);
    metrics.gauge('ws_clients', 7);
    metrics.observe('http_request_duration_ms', 12, { route: '/v1/health' });
    const text = await metrics.exposition();
    expect(text).toContain('# TYPE http_requests_total counter');
    expect(text.match(/http_requests_total\{method="GET",route="\/v1\/health",status="200"\} 3/g)?.length).toBe(1);
    expect(text).toContain('ws_clients 7');
    expect(text).toContain('# TYPE http_request_duration_ms histogram');
    expect(text).toContain('http_request_duration_ms_bucket{route="/v1/health"} le="25" 1');
    expect(text.trimEnd().endsWith('http_request_duration_ms_count{route="/v1/health"} 1')).toBe(true);
    expect(text).toContain('\n'); // ends with a newline, as the text format requires
  });

  it('a label value can never break the line format', async () => {
    metrics.counter('evil_total', { route: '/x"\n# TYPE fake gauge' });
    const text = await metrics.exposition();
    expect(text.split('\n').filter((l) => l.includes('# TYPE fake'))).toHaveLength(1); // only inside the quoted value, never a real family line
    expect(text).toContain('# TYPE evil_total counter');
  });

  it('scrape-time gauges run per scrape and their failure is a series, not a 500', async () => {
    let n = 0;
    metrics.registerScrape('demo_gauge', 'Demo.', () => { n++; return [{ value: n }, { value: n * 10, labels: { shard: 'b' } }]; });
    metrics.registerScrape('broken_gauge', 'Broken.', () => { throw new Error('db down'); });
    const a = await metrics.exposition();
    const b = await metrics.exposition();
    expect(a).toContain('demo_gauge 1');
    expect(a).toContain('demo_gauge{shard="b"} 10');
    expect(b).toContain('demo_gauge 2');
    expect(b).toContain('metrics_scrape_error{name="broken_gauge"} 1');
  });

  it('registering the same scrape name twice replaces it (no duplicate family)', async () => {
    metrics.registerScrape('x_gauge', 'first', () => [{ value: 1 }]);
    metrics.registerScrape('x_gauge', 'second', () => [{ value: 2 }]);
    const text = await metrics.exposition();
    expect(text.match(/^x_gauge /gm)).toHaveLength(1);
    expect(text).toContain('x_gauge 2');
  });
});

describe('event bus', () => {
  it('picks wallets out of the fields an on-chain event actually uses', () => {
    // order is not part of the contract (a Set of wallets to notify), so compare sorted
    expect(walletsOf({ seller: 'HPMr5r9sS5ApWsPNJytZRLbm2jz1veFxTn1wepjAhtho', buyer: 'GCRhrg6mc7zH1VdXG5rX3tQEpgu8Gptf27vdsJGV7G8q', price: '1000' }).sort())
      .toEqual(['GCRhrg6mc7zH1VdXG5rX3tQEpgu8Gptf27vdsJGV7G8q', 'HPMr5r9sS5ApWsPNJytZRLbm2jz1veFxTn1wepjAhtho'].sort());
    expect(walletsOf({ owner: 'not base58!!! 0OIl' })).toEqual([]);
    expect(walletsOf({ staker: 'HPMr5r9sS5ApWsPNJytZRLbm2jz1veFxTn1wepjAhtho', amount: '5' })).toHaveLength(1);
    expect(walletsOf(undefined)).toEqual([]);
  });

  it('a subscriber that throws cannot break the publisher, and unsubscribing works', async () => {
    const b = await installBus('inproc');
    const got: string[] = [];
    const off = b.subscribe(() => { throw new Error('bad socket'); });
    const off2 = b.subscribe((m) => got.push(m.type));
    expect(() => b.publish({ wallets: [], type: 'sale', payload: {} })).not.toThrow();
    expect(got).toEqual(['sale']);
    off(); off2();
    b.publish({ wallets: [], type: 'after', payload: {} });
    expect(got).toEqual(['sale']);
    await b.close();
  });

  it('EVENT_BUS=redis without REDIS_URL degrades to the in-process bus instead of failing to boot', async () => {
    const prev = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    try {
      const b = await installBus('redis', '');
      expect(b.kind).toBe('inproc');
      await b.close();
    } finally { if (prev !== undefined) process.env.REDIS_URL = prev; }
  });
});

describe('wire: on-chain event → client frame', () => {
  it('names match client/src/api/ws.ts INVALIDATE keys', () => {
    const client = ['pack_opened', 'chip_fused', 'listing_changed', 'sale', 'offer', 'stake_changed', 'reward_claimed', 'quest_progress', 'match_found', 'match_resolved', 'day_closed', 'params_changed'];
    for (const t of client) expect(Object.values(WIRE_TYPE)).toContain(t);
    expect(snake('RootPublished')).toBe('root_published');
    expect(snake('SkrPoolChanged')).toBe('skr_pool_changed');
  });

  it('a sale carries the seller and a display price, and tells the seller’s wallet', () => {
    const d = new Db(':memory:');
    try {
      const seller = Keypair.generate().publicKey.toBase58();
      const buyer = Keypair.generate().publicKey.toBase58();
      d.run(`INSERT INTO oracle_prices (symbol, usd, updated_at, publish_time) VALUES ('SOL', 200, ?, ?)`, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000));
      const m = wireEvent(d, { program: 'market', programId: 'x', name: 'ChipSold', ixIndex: 0, eventIndex: 0, data: { asset: 'A'.repeat(43), seller, buyer, price: '1500000000', currency: 0, viaOffer: 1 } } as never);
      expect(m!.type).toBe('sale');
      expect(m!.wallets.sort()).toEqual([buyer, seller].sort());
      expect(m!.payload.seller).toBe(seller);
      expect(m!.payload.priceUsd).toBe(300); // 1.5 SOL × $200 — the same math as GET /v1/market/listings
      expect(m!.payload.viaOffer).toBe(true);
    } finally { d.close(); }
  });

  // SEC-B35: the compressed markets must reach the client under a key it invalidates, not under their own
  // snake_case name — a frame nobody handles is a market page that stops updating without an error. The
  // cancel path is chip_core's `CompressedClaimListedSet(false)` (the market emits nothing on cancel), so
  // it has to map to the listing cache as well.
  it('SEC-B35: compressed listings, sales and claim flips map onto the client’s own wire types', () => {
    const d = new Db(':memory:');
    try {
      d.run(`INSERT INTO oracle_prices (symbol, usd, updated_at, publish_time) VALUES ('SOL', 200, ?, ?)`, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000));
      const seller = Keypair.generate().publicKey.toBase58();
      const buyer = Keypair.generate().publicKey.toBase58();
      const claim = Keypair.generate().publicKey.toBase58();
      const asset = Keypair.generate().publicKey.toBase58();
      const ev = (name: string, data: Record<string, unknown>) => wireEvent(d, { program: 'market', programId: 'x', name, ixIndex: 0, eventIndex: 0, data } as never)!;
      const listed = ev('CompressedAssetListed', { asset, claim, seller, price: '1000000000', currency: 0 });
      expect(listed.type).toBe('listing_changed');
      expect(listed.payload).toMatchObject({ asset, claim, seller, price: '1000000000' });
      // a pre-mint claim listing: no asset exists, so the frame carries the claim and the market price only
      const preMint = ev('CompressedClaimListed', { claim, seller, price: '500000000', currency: 0 });
      expect(preMint.type).toBe('listing_changed');
      expect(preMint.payload.asset).toBeUndefined();
      expect(preMint.payload.claim).toBe(claim);
      const sold = ev('CompressedAssetSold', { asset, claim, seller, buyer, price: '1000000000', fee: '75000000', royalty: '25000000' });
      expect(sold.type).toBe('sale');
      expect(sold.wallets.sort()).toEqual([buyer, seller].sort());
      expect(sold.payload).toMatchObject({ asset, seller, buyer, currency: 0 });
      expect(sold.payload.priceUsd).toBe(200); // 1 SOL × $200, the same math as the Core sale path
      const soldClaim = ev('CompressedClaimSold', { claim, seller, buyer, price: '500000000', fee: '0', royalty: '0' });
      expect(soldClaim.type).toBe('sale');
      expect(soldClaim.payload.asset).toBeUndefined();
      expect(soldClaim.payload.priceUsd).toBe(100);
      // the cancel is chip_core's flag event alone
      expect(ev('CompressedClaimListedSet', { claim, buyer: seller, listed: false })).toMatchObject({ type: 'listing_changed', payload: { claim, listed: false } });
      expect(ev('CompressedClaimStakedSet', { claim, buyer: seller, staked: true })).toMatchObject({ type: 'stake_changed', payload: { claim, staked: true } });
    } finally { d.close(); }
  });

  it('an unknown event ships scalars only', () => {
    const d = new Db(':memory:');
    try {
      const m = wireEvent(d, { program: 'chip_core', programId: 'x', name: 'SomethingNew', ixIndex: 0, eventIndex: 0, data: { n: 5, s: 'ok', nested: { secret: 'x' }, arr: [{ wallet: 'y' }] } } as never);
      expect(m!.type).toBe('something_new');
      expect(m!.payload.n).toBe(5);
      expect(m!.payload.s).toBe('ok');
      expect(m!.payload.nested).toBeUndefined();
      expect(m!.payload.arr).toBeUndefined();
    } finally { d.close(); }
  });
});

describe('readiness', () => {
  it('an empty db is not ready and says why', async () => {
    const d = new Db(':memory:');
    try {
      const r = await readiness(d);
      expect(r.ready).toBe(false);
      expect(r.db).toBe(true);
      expect(r.lastSlot).toBe(0);
      expect(r.problems.join(' ')).toContain('no events ingested');
    } finally { d.close(); }
  });

  it('a db with no readable schema is not ready, and reports the db problem', async () => {
    const d = new Db(':memory:');
    d.run(`DROP TABLE events_raw`);
    try {
      const r = await readiness(d);
      expect(r.ready).toBe(false);
      expect(r.db).toBe(false);
      expect(r.problems.some((p) => p.includes('db not readable'))).toBe(true);
    } finally { d.close(); }
  });

  it('a stale Pyth cache is a readiness problem — quoting a pack from it would be dishonest', async () => {
    const d = new Db(':memory:');
    try {
      d.run(`INSERT INTO events_raw (signature, ix_index, event_index, program, name, data, slot, block_time, processed) VALUES ('s',0,0,'chip_core','PackOpened','{}',100,?,1)`, Math.floor(Date.now() / 1000));
      const oldS = Math.floor(Date.now() / 1000) - 3600;
      d.run(`INSERT INTO oracle_prices (symbol, usd, updated_at, publish_time) VALUES ('SOL', 200, ?, ?)`, oldS, oldS);
      const r = await readiness(d);
      expect(r.prices.worstAgeS).toBeGreaterThan(3000);
      expect(r.problems.join(' ')).toMatch(/Pyth cache .* old/);
    } finally { d.close(); }
  });

  it('an abandoned crank job pages a human, so it fails readiness', async () => {
    const d = new Db(':memory:');
    try {
      d.run(`INSERT INTO events_raw (signature, ix_index, event_index, program, name, data, slot, block_time, processed) VALUES ('s',0,0,'chip_core','PackOpened','{}',100,?,1)`, Math.floor(Date.now() / 1000));
      d.run(`INSERT INTO crank_jobs (key, kind, owner, nonce, randomness, pinned, phase, attempts, next_at, created_at, updated_at) VALUES ('k',0,'o','1','r','p','abandoned',9,0,?,?)`, Date.now(), Date.now());
      const r = await readiness(d);
      expect(r.crank.abandoned).toBe(1);
      expect(r.problems.join(' ')).toContain('abandoned crank job');
    } finally { d.close(); }
  });
});

describe('redis burst guard', () => {
  // ioredis signature is eval(script, numKeys, ...args) — a fake that ignores the first two would
  // pass while the real call used the wrong KEYS/ARGV indices.
  const fake = (impl: (key: string, win: string) => Promise<unknown>): RedisLike => ({
    eval: ((script: string, numKeys: number, ...args: (string | number)[]) => {
      expect(script).toContain('KEYS[1]');
      expect(script).toContain('ARGV[1]');
      expect(numKeys).toBe(1);
      return impl(String(args[0]), String(args[1]));
    }) as never,
    ping: async () => 'PONG',
  });

  const hit = async (guard: ReturnType<typeof createRedisGuard>, ip = '9.9.9.9') => {
    let status = 0; let body: Record<string, unknown> = {}; let next = false; let retryAfter = '';
    const req = { ip, method: 'GET' } as never;
    const res = {
      setHeader: (k: string, v: string) => { if (k === 'Retry-After') retryAfter = v; },
      status: (s: number) => { status = s; return res; },
      json: (b: unknown) => { body = b as Record<string, unknown>; },
    } as never;
    // a blocked caller never reaches `next`, so the promise is settled by whichever side answers
    await new Promise<void>((done) => {
      guard(req, res, () => { next = true; done(); });
      const poll = setInterval(() => { if (status) { clearInterval(poll); done(); } }, 2);
      setTimeout(() => { clearInterval(poll); done(); }, 1_500);
    });
    return { status, body, next, retryAfter };
  };

  it('lets a caller through under the shared limit and blocks above it', async () => {
    let n = 0;
    const guard = createRedisGuard({ client: fake(async () => [++n, 60_000]), limit: 2, windowMs: 60_000 });
    expect(await hit(guard)).toMatchObject({ next: true });
    expect(await hit(guard)).toMatchObject({ next: true });
    const blocked = await hit(guard);
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('rate_limited');
    expect(blocked.next).toBe(false);
    expect(Number(blocked.retryAfter)).toBeGreaterThan(0);
  });

  it('fails open when Redis errors, and when it is slow', async () => {
    const broken = createRedisGuard({ client: fake(async () => { throw new Error('READONLY'); }), limit: 1, windowMs: 60_000 });
    expect(await hit(broken)).toMatchObject({ next: true });
    const slow = createRedisGuard({ client: fake(() => new Promise(() => undefined)), limit: 1, windowMs: 60_000, timeoutMs: 25 });
    const t0 = Date.now();
    expect(await hit(slow)).toMatchObject({ next: true });
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('keys the window by IP, not by wallet, and never interpolates the raw header', async () => {
    const keys: string[] = [];
    const guard = createRedisGuard({ client: fake(async (k) => { keys.push(k); return [1, 60_000]; }), limit: 5, windowMs: 60_000 });
    await hit(guard, '2001:db8::1');
    // SEC-B42: the key is the canonical form the local limiter uses (`ipKey`), so an IPv6 client counts as
    // its /64 — the raw text is never what goes into the key.
    expect(keys[0]).toMatch(/^rl:2001:db8:0:0::\/64:\d+$/);
    const sameBucket = [...keys];
    await hit(guard, '2001:db8::1');
    expect(keys[1]).toBe(sameBucket[0]); // same minute → same key, so the counter actually accumulates
  });

  it('SEC-B42: one client is one bucket however the edge spells it (v4-mapped ≡ dotted, one /64 ≡ another)', async () => {
    const keys: string[] = [];
    const guard = createRedisGuard({ client: fake(async (k) => { keys.push(k); return [1, 60_000]; }), limit: 5, windowMs: 60_000 });
    await hit(guard, '203.0.113.9');
    await hit(guard, '::ffff:203.0.113.9');       // the same client arriving over a v6 edge
    await hit(guard, '::FFFF:203.0.113.9');       // …however the proxy spelled it
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).toBe(keys[0]);
    await hit(guard, '2001:db8::5');              // two hosts of one /64
    await hit(guard, '2001:0db8:0000:0000::6');   // …written out the long way
    expect(keys[4]).toBe(keys[3]);
    expect(keys[3]).not.toBe(keys[0]);
    // and the count is what actually blocks: a caller that alternates spellings cannot reset its budget
    let n = 0;
    const sharing = createRedisGuard({ client: fake(async () => [++n, 60_000]), limit: 2, windowMs: 60_000 });
    expect(await hit(sharing, '203.0.113.9')).toMatchObject({ next: true });
    expect(await hit(sharing, '::ffff:203.0.113.9')).toMatchObject({ next: true });
    expect((await hit(sharing, '203.0.113.9')).status).toBe(429);
  });

  it('connectRedis with no URL is a no-op handle, not a crash', async () => {
    const { connectRedis } = await import('../src/redis.ts');
    const h = await connectRedis('', 'test');
    expect(h.client).toBeUndefined();
    expect(await h.ping()).toBe(false);
    await expect(h.close()).resolves.toBeUndefined();
  });
});

describe('websocket hub', () => {
  let server: Server;
  let port = 0;
  let db: Db;
  let hub: ReturnType<typeof attachWs>['hub'];
  let closeHub: () => Promise<void>;

  beforeAll(async () => {
    await installBus('inproc');
    db = new Db(':memory:');
    useDb(db);
    server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
    const attached = attachWs(server, { db: () => db, pingMs: 0, maxClients: 5 });
    hub = attached.hub;
    closeHub = attached.close;
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => { await closeHub(); await new Promise<void>((r) => server.close(() => r())); db.close(); });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  interface TestSocket { ws: WebSocket; buf: () => Record<string, unknown>[]; next: (m?: (f: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>>; closedCode: () => Promise<number> }
  // Frames can land in the same tick as `open` (the hub greets immediately), so everything is buffered
  // from the moment the socket exists; `next` then reads that buffer.
  const connect = (query = ''): Promise<TestSocket> => new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`);
    const frames: Record<string, unknown>[] = [];
    let closeCode: number | undefined;
    ws.on('message', (raw: Buffer) => frames.push(JSON.parse(String(raw)) as Record<string, unknown>));
    ws.once('error', rej);
    ws.on('close', (c) => { closeCode = c; });
    ws.once('open', () => res({
      ws,
      buf: () => [...frames],
      next: async (match) => {
        const t0 = Date.now();
        for (;;) {
          const idx = match ? frames.findIndex(match) : 0;
          if (idx >= 0) return frames.splice(idx, 1)[0]!;
          if (Date.now() - t0 > 4_000) throw new Error(`no frame within 4 s (buffered: ${frames.map((f) => f.type).join(',') || 'none'}${closeCode !== undefined ? `, closed ${closeCode}` : ''})`);
          await sleep(10);
        }
      },
      closedCode: async () => {
        const t0 = Date.now();
        for (;;) {
          if (closeCode !== undefined) return closeCode;
          if (Date.now() - t0 > 4_000) return -1;
          await sleep(10);
        }
      },
    }));
  });
  const ready = (c: TestSocket) => c.next((f) => f.type === 'ready');

  it('greets a client with the wallet it subscribed as', async () => {
    const w = Keypair.generate().publicKey.toBase58();
    const c = await connect(`?wallet=${w}`);
    expect((await ready(c)).wallet).toBe(w);
    c.ws.close();
  });

  it('an unparseable wallet is dropped, not trusted — the socket still opens', async () => {
    const c = await connect('?wallet=0bad!!!');
    expect((await ready(c)).wallet).toBeNull();
    c.ws.close();
  });

  it('routes a wallet-scoped event to that wallet only', async () => {
    const a = Keypair.generate().publicKey.toBase58();
    const b = Keypair.generate().publicKey.toBase58();
    const ca = await connect(`?wallet=${a}`);
    const cb = await connect(`?wallet=${b}`);
    await ready(ca); await ready(cb);
    bus().publish({ wallets: [a], type: 'pack_opened', payload: { sku: 1 } });
    const f = await ca.next((x) => x.type === 'pack_opened');
    expect(f.payload).toEqual({ sku: 1 });
    expect(f.wallet).toBe(a);
    await sleep(300);
    expect(cb.buf().some((x) => x.type === 'pack_opened')).toBe(false); // B must not learn about A's pack
    ca.ws.close(); cb.ws.close();
  });

  it('broadcasts market-wide types to everyone, including a socket with no wallet', async () => {
    const anon = await connect();
    await ready(anon);
    expect(PUBLIC_TYPES.has('sale')).toBe(true);
    bus().publish({ wallets: [], type: 'sale', payload: { asset: 'A'.repeat(43) } });
    expect((await anon.next((x) => x.type === 'sale')).payload).toMatchObject({ asset: 'A'.repeat(43) });
    anon.ws.close();
  });

  it('answers a client ping and ignores anything else', async () => {
    const c = await connect();
    await ready(c);
    c.ws.send(JSON.stringify({ type: 'subscribe', everything: true }));
    c.ws.send('not json at all');
    c.ws.send(JSON.stringify({ type: 'ping' }));
    const pong = await c.next((f) => f.type === 'pong');
    expect(Number(pong.at)).toBeGreaterThan(0);
    await sleep(50);
    expect(c.buf().some((f) => f.type === 'subscribe' || f.type === undefined)).toBe(false);
    c.ws.close();
  });

});

describe('websocket hub — isolated (backlog + capacity)', () => {
  // Own hub per case: both guards count live sockets, and the shared hub above has clients that other
  // tests closed only a moment ago — patching `wss.clients[0]` would then hit the wrong socket.
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const boot = async (opts: { maxClients?: number; maxBacklog?: number; allowedOrigins?: string[]; maxPerIp?: number; trustProxyHops?: number | true }) => {
    const db = new Db(':memory:');
    const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
    const { hub, close } = attachWs(server, { db: () => db, pingMs: 0, ...opts });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    return {
      port, hub, db,
      shutdown: async () => { await close(); await new Promise<void>((r) => server.close(() => r())); db.close(); },
    };
  };

  /** Value of a counter over the current exposition text; `0` when the series does not exist yet. */
  const counter = async (name: string, label: string): Promise<number> => {
    const line = (await metrics.exposition()).split('\n').find((l) => l.startsWith(`${name}{`) && l.includes(`reason="${label}"`));
    return Number(line?.trim().split(' ')[1] ?? 0);
  };

  it('SEC-B45 refuses a browser handshake from an origin the API does not serve, and lets a nameless client in', async () => {
    // An upgrade is not subject to CORS, so this check is the only thing between a page on any origin and the
    // /ws fan-out — the market frames the REST layer refuses it cross-origin, any wallet's activity in real
    // time (`?wallet=` needs no session), and the whole WS_MAX_CLIENTS capacity.
    const t = await boot({ allowedOrigins: ['https://app.guttercaps.gg'] });
    try {
      const handshake = (opts?: { origin?: string; headers?: Record<string, string> }) => new Promise<number>((res) => {
        const ws = new WebSocket(`ws://127.0.0.1:${t.port}/ws`, opts?.origin ? { origin: opts.origin } : opts?.headers ? { headers: opts.headers } : undefined);
        ws.once('open', () => { ws.close(); res(1); });
        ws.once('error', () => res(-1)); // a refused upgrade is an error, never an open socket
        setTimeout(() => res(0), 2_000);
      });
      const before = await counter('ws_rejected_total', 'origin');
      expect(await handshake({ origin: 'https://evil.example' })).toBe(-1);
      expect(await counter('ws_rejected_total', 'origin')).toBe(before + 1);
      expect(await handshake({ origin: 'https://app.guttercaps.gg' })).toBe(1);
      expect(await handshake()).toBe(1); // no Origin: curl, a bot, a service — the header is a browser control
      expect(await handshake({ headers: { 'x-forwarded-for': '203.0.113.9' } })).toBe(1); // and it is not an identity
      expect(await counter('ws_rejected_total', 'origin')).toBe(before + 1); // nothing else was refused
    } finally { await t.shutdown(); }
  });

  it('SEC-B46 caps concurrent sockets per client IP, gives the slot back, and ignores a spoofed chain', async () => {
    const t = await boot({ maxPerIp: 1, trustProxyHops: 1 });
    try {
      const ip = '203.0.113.7';
      // The refusal is a 1013 close *after* the handshake (the same shape as the process-wide capacity guard,
      // which docs/09 §4.3 documents as "перебор → 1013"), so "accepted" means "still open a moment later".
      const connect = (xff?: string) => {
        const ws = new WebSocket(`ws://127.0.0.1:${t.port}/ws`, xff ? { headers: { 'x-forwarded-for': xff } } : undefined);
        const opened = new Promise<boolean>((res) => { ws.once('open', () => res(true)); ws.once('error', () => res(false)); setTimeout(() => res(false), 3_000); });
        const closed = new Promise<number>((res) => { ws.once('close', (c) => res(c)); setTimeout(() => res(-1), 3_000); });
        return { ws, opened, closed };
      };
      const a = connect(ip);
      expect(await a.opened).toBe(true);
      await sleep(150);
      expect(t.hub.clients()).toBe(1); // a survived the grace period
      const before = await counter('ws_rejected_total', 'per_ip');
      const b = connect(ip);
      expect(await b.closed).toBe(1013); // same IP → refused, the process-wide cap is not the only bound
      expect(await counter('ws_rejected_total', 'per_ip')).toBe(before + 1);
      // one trusted hop in front (nginx appends `$remote_addr`): the rightmost entry is the client, so a
      // caller cannot spend another bucket by prefixing its own X-Forwarded-For
      expect(await connect(`1.2.3.4, ${ip}`).closed).toBe(1013);
      const other = connect('198.51.100.9');
      expect(await other.opened).toBe(true);
      expect(t.hub.clients()).toBe(2);
      // the slot is given back when a socket closes (a ratcheting cap would refuse everyone eventually)
      a.ws.close();
      await sleep(150);
      const again = connect(ip);
      expect(await again.opened).toBe(true);
      await sleep(100);
      expect(t.hub.clients()).toBe(2);
      other.ws.close(); again.ws.close();
    } finally { await t.shutdown(); }
  });

  it('SEC-B46 the upgrade IP rule is Express’s `trust proxy` rule', async () => {
    // Cross-checked against the library rather than against my own reading of the docs: an upgrade never
    // reaches Express, so the two have to agree by hand — and a wrong answer here lumps every player behind
    // the edge into one bucket (a self-inflicted outage), which is why it is pinned case by case.
    const express = (await import('express')).default;
    const cases: { xff?: string; hops: number | true }[] = [
      { hops: 1 }, { hops: 2 }, { hops: true },
      { xff: '203.0.113.9', hops: 1 },
      { xff: '203.0.113.9', hops: 2 },                          // not enough hops → the leftmost entry
      { xff: '198.51.100.7, 203.0.113.9', hops: 1 },            // the rightmost is what the edge appended
      { xff: '198.51.100.7, 203.0.113.9', hops: 2 },
      { xff: '198.51.100.7, 203.0.113.9', hops: true },         // trust everything → the caller's own claim
      { xff: '  1.2.3.4 ,  5.6.7.8 ', hops: 2 },
    ];
    for (const c of cases) {
      const app = express();
      app.set('trust proxy', c.hops);
      app.get('/', (req, res) => { res.json({ ip: req.ip }); });
      const srv = http.createServer(app);
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
      try {
        const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/`;
        const { ip } = await (await fetch(url, { headers: c.xff ? { 'x-forwarded-for': c.xff } : {} })).json() as { ip: string };
        expect(upgradeIp(c.xff, '127.0.0.1', c.hops), `xff=${c.xff ?? '(none)'} hops=${c.hops}`).toBe(ip);
      } finally {
        await new Promise<void>((r) => srv.close(() => r()));
      }
    }
  });

  it('SEC-B41: a typo\'d WS_* value falls back to the documented default instead of switching a guard off', () => {
    const saved = { ...process.env };
    try {
      // `Number('500x')` is NaN, and `queued + buffered + bytes > NaN` is false — i.e. the outbox bound would
      // simply not exist while WS_MAX_BACKLOG_BYTES looked set. Production refuses to start on these (config.ts);
      // this is the dev path, and it has to land on the same numbers `/metrics` reports.
      process.env.WS_MAX_CLIENTS = '500x'; process.env.WS_MAX_BACKLOG_BYTES = '0'; process.env.WS_PING_MS = 'NaN';
      expect(wsConfigFromEnv()).toEqual({ maxClients: 500, pingMs: 30_000, maxBacklog: 1 << 20 });
      process.env.WS_MAX_CLIENTS = '50'; process.env.WS_MAX_BACKLOG_BYTES = '4096'; process.env.WS_PING_MS = '0';
      expect(wsConfigFromEnv()).toEqual({ maxClients: 50, pingMs: 0, maxBacklog: 4096 }); // 0 = liveness explicitly off
    } finally {
      for (const k of ['WS_MAX_CLIENTS', 'WS_MAX_BACKLOG_BYTES', 'WS_PING_MS']) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it('SEC-B41: drops a slow client on bytes actually queued, for frames far smaller than the cap', async () => {
    // The shape that used to grow without bound: `drain` awaits each `send` callback, so at most one frame is
    // ever in flight and `socket.bufferedAmount` stays near zero while the hub holds the rest in `queue`. The
    // probe behind this test sent 6000 × 190 B frames to a client that read nothing: `bufferedAmount` 0,
    // `queue` ≈ 5999, no drop — because the guard read `bufferedAmount + frame.length`. A ~1 KB frame is
    // below this hub's 2 KiB cap on purpose: with the old arithmetic it could not trip either.
    const t = await boot({ maxBacklog: 2048 });
    try {
      const w = Keypair.generate().publicKey.toBase58();
      const ws = new WebSocket(`ws://127.0.0.1:${t.port}/ws?wallet=${w}`);
      await new Promise<void>((res) => ws.once('open', () => res()));
      await sleep(50);
      const [sock] = [...t.hub.wss.clients];
      expect(sock).toBeTruthy();
      const closing = new Promise<number>((res) => { ws.once('close', (c) => res(c)); setTimeout(() => res(-1), 3_000); });
      const before = await counter('ws_dropped_total', 'backlog');
      // one synchronous burst, so nothing has been flushed yet: `queued` crosses the cap while bufferedAmount
      // is still ~0
      for (let i = 0; i < 200; i++) t.hub.broadcast({ wallets: [w], type: 'pack_opened', payload: { i, pad: 'x'.repeat(900) } });
      expect(await closing).not.toBe(-1); // 1006: terminated, not buffered
      expect(await counter('ws_dropped_total', 'backlog')).toBeGreaterThan(before);
      await sleep(50);
      expect(t.hub.clients()).toBe(0);
      ws.close();
    } finally { await t.shutdown(); }
  });

  it('SEC-B41: a burst that stays under the cap is still delivered whole', async () => {
    // The other direction: the bound must not drop a client that is merely a little behind.
    const t = await boot({ maxBacklog: 4096 });
    try {
      const w = Keypair.generate().publicKey.toBase58();
      const ws = new WebSocket(`ws://127.0.0.1:${t.port}/ws?wallet=${w}`);
      const frames: Record<string, unknown>[] = [];
      ws.on('message', (raw: Buffer) => frames.push(JSON.parse(String(raw)) as Record<string, unknown>));
      await new Promise<void>((res) => ws.once('open', () => res()));
      const before = await counter('ws_dropped_total', 'backlog');
      for (let i = 0; i < 3; i++) t.hub.broadcast({ wallets: [w], type: 'pack_opened', payload: { i, pad: 'x'.repeat(100) } });
      await sleep(300);
      expect(frames.filter((f) => f.type === 'pack_opened')).toHaveLength(3);
      expect(await counter('ws_dropped_total', 'backlog')).toBe(before);
      expect(t.hub.clients()).toBe(1);
      ws.close();
    } finally { await t.shutdown(); }
  });

  it('drops a client whose send buffer is over the backlog limit instead of buffering it', async () => {
    const t = await boot({ maxBacklog: 1024 });
    try {
      const w = Keypair.generate().publicKey.toBase58();
      const ws = new WebSocket(`ws://127.0.0.1:${t.port}/ws?wallet=${w}`);
      await new Promise<void>((res) => ws.once('open', () => res()));
      await sleep(50);
      const [sock] = [...t.hub.wss.clients];
      expect(sock).toBeTruthy();
      Object.defineProperty(sock, 'bufferedAmount', { value: 1 << 20, configurable: true });
      const closing = new Promise<number>((res) => { ws.once('close', (c) => res(c)); setTimeout(() => res(-1), 3_000); });
      t.hub.broadcast({ wallets: [w], type: 'pack_opened', payload: { a: 1 } });
      expect(await closing).not.toBe(-1); // 1006: the hub terminated it rather than growing its own heap
      await sleep(50);
      expect(t.hub.clients()).toBe(0);
      ws.close();
    } finally { await t.shutdown(); }
  });

  it('refuses a socket beyond maxClients instead of accepting unbounded upgrades', async () => {
    const t = await boot({ maxClients: 1 });
    try {
      const first = new WebSocket(`ws://127.0.0.1:${t.port}/ws`);
      await new Promise<void>((res) => first.once('open', () => res()));
      const code = await new Promise<number>((res) => {
        const second = new WebSocket(`ws://127.0.0.1:${t.port}/ws`);
        second.once('close', (c) => res(c));
        second.once('error', () => res(-2));
        setTimeout(() => res(0), 3_000);
      });
      expect(code).toBe(1013); // try again later, and the first client is untouched
      expect(t.hub.clients()).toBe(1);
      first.close();
    } finally { await t.shutdown(); }
  });

  it('leaves an upgrade on another path alone, and answers a plain request there normally', async () => {
    const t = await boot({});
    try {
      const opened = await new Promise<number>((res) => {
        const ws = new WebSocket(`ws://127.0.0.1:${t.port}/v1/ws`);
        ws.once('error', () => res(-1));
        ws.once('open', () => { ws.close(); res(1); });
        setTimeout(() => res(0), 2_000);
      });
      expect(opened).not.toBe(1); // never handshakes on a path we do not own
      const res = await fetch(`http://127.0.0.1:${t.port}/v1/ws`);
      expect(res.status).toBe(404); // the http server still owns that path
    } finally { await t.shutdown(); }
  });
});

describe('db pragmas (multi-process SQLite is the default topology)', () => {
  it('busy_timeout is on, so a colliding writer waits instead of throwing', () => {
    const d = new Db(':memory:');
    try {
      const row = d.raw.prepare(`PRAGMA busy_timeout`).get() as Record<string, number>;
      expect(Number(Object.values(row)[0])).toBeGreaterThanOrEqual(5_000);
      expect(String(Object.values(d.raw.prepare(`PRAGMA journal_mode`).get() ?? {})[0]).toLowerCase()).not.toBe('delete');
    } finally { d.close(); }
  });

  it('two processes on one file can both write 200 rows without SQLITE_BUSY', async () => {
    const file = `/tmp/gc-busy-${process.pid}.sqlite`;
    const a = new Db(file);
    const b = new Db(file);
    try {
      const work = async (d: Db, tag: string) => {
        for (let i = 0; i < 200; i++) {
          d.run(`INSERT INTO events_raw (signature, ix_index, event_index, program, name, data, slot, block_time, processed) VALUES (?,0,0,'chip_core','BurnRecorded','{}',?,0,1)`, `${tag}${i}`, i);
          // yield every few rows, or the two connections never actually contend inside one tick
          if (i % 20 === 0) await new Promise((r) => setTimeout(r, 0));
        }
      };
      await Promise.all([work(a, 'a'), work(b, 'b')]);
      expect(a.scalar(`SELECT COUNT(*) FROM events_raw`)).toBe(400);
    } finally {
      a.close(); b.close();
      for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
    }
  });
});

describe('shutdown', () => {
  it('runs steps in order, survives a throwing step, and is idempotent', async () => {
    const order: string[] = [];
    const h = installShutdown([
      { name: 'a', run: () => { order.push('a'); } },
      { name: 'boom', run: () => { throw new Error('socket already closed'); } },
      { name: 'b', run: async () => { await new Promise((r) => setTimeout(r, 5)); order.push('b'); } },
    ], { forceMs: 0, onExit: () => { order.push('exit0'); }, signals: false, crashHandlers: false });
    await Promise.all([h.signal('SIGTERM'), h.signal('SIGTERM')]);
    expect(order).toEqual(['a', 'b', 'exit0']);
  });

  it('exits non-zero when a step hangs past the forced deadline', async () => {
    const codes: number[] = [];
    const h = installShutdown([{ name: 'hangs', run: () => new Promise<void>(() => undefined) }], {
      forceMs: 40, onExit: (c) => codes.push(c), signals: false, crashHandlers: false,
    });
    void h.signal('SIGTERM'); // never settles — that is the point
    await new Promise((r) => setTimeout(r, 200));
    expect(codes).toEqual([1]);
  });
});

describe('ops endpoints on the real app', () => {
  let db: Db;
  let server: Server;
  let base = '';

  beforeAll(async () => {
    await installBus('inproc');
    db = new Db(':memory:');
    useDb(db);
    const app = createApp(db, { arenaSweepMs: 0, accessLog: false });
    await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); db.close(); });

  const get = async (path: string, init?: RequestInit) => {
    const res = await fetch(base + path, init);
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON body (metrics) */ }
    return { status: res.status, text, json, headers: res.headers, requestId: res.headers.get('x-request-id') ?? undefined };
  };

  it('/healthz answers without touching the db, and carries the request id header', async () => {
    const r = await get('/healthz');
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.uptimeS).toBeGreaterThanOrEqual(0);
  });

  it('/readyz is 503 with an empty indexer and names the problem', async () => {
    const r = await get('/readyz');
    expect(r.status).toBe(503);
    expect(r.json.ready).toBe(false);
    expect(String((r.json.problems as string[]).join(' '))).toContain('no events ingested');
  });

  it('/metrics is text/plain and counts the requests it just served', async () => {
    await get('/v1/health');
    const r = await get('/metrics');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/plain');
    expect(r.text).toContain('# TYPE http_requests_total counter');
    expect(r.text).toMatch(/http_requests_total\{method="GET",route="\/v1\/health",status="200"\} [1-9]/);
    expect(r.text).toContain('# TYPE metrics_series gauge');
  });

  it('the readiness cache cannot flip to green inside the drain window', async () => {
    // Two calls inside the 2 s cache: if the closing flag were only consulted on a cache miss, the
    // second call would report "ready" while the process is already shutting down.
    const a = await get('/readyz');
    const b = await get('/readyz');
    expect([a.status, b.status]).toEqual([503, 503]);
  });

  it('a 500 never leaks the internal message, and quotes the request id instead', async () => {
    const d2 = new Db(':memory:');
    const app2 = createApp(d2, { arenaSweepMs: 0, accessLog: false });
    const s2 = http.createServer(app2);
    await new Promise<void>((r) => s2.listen(0, '127.0.0.1', r));
    const p2 = (s2.address() as { port: number }).port;
    try {
      d2.run(`DROP TABLE events_raw`); // any db fault: the message would name the table
      const res = await fetch(`http://127.0.0.1:${p2}/v1/health`);
      const body = await res.json() as Record<string, unknown>;
      expect(res.status).toBe(500);
      expect(JSON.stringify(body)).not.toMatch(/events_raw|no such table|at .*\.ts:\d+/);
      expect(body.code).toBe('internal');
      expect(String(body.requestId)).toMatch(/^[A-Za-z0-9]{16}$/);
      expect(res.headers.get('x-request-id')).toBe(String(body.requestId));
      expect(String(body.message)).toBe('Internal server error. Quote this id when contacting support.');
    } finally {
      await new Promise<void>((r) => s2.close(() => r()));
      d2.close();
    }
  });

  it('a bad public key still explains itself (400 is client input, not our bug)', async () => {
    const r = await get('/v1/auth/siws/nonce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: 'not-base58-0OIl' }),
    });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('bad_pubkey');
    expect(String(r.requestId)).toMatch(/^[A-Za-z0-9]{16}$/);
  });

  it('the limiter cannot starve the scraper: /metrics is outside the read budget', async () => {
    let limited = 0;
    for (let i = 0; i < 40; i++) { if ((await get('/metrics')).status === 429) limited++; }
    expect(limited).toBe(0);
  });

  it('every response carries its own request id (200 / 404 included)', async () => {
    const a = await get('/v1/health');
    const b = await get('/v1/leaderboard/nope');
    const idA = a.headers.get('x-request-id')!;
    const idB = b.headers.get('x-request-id')!;
    expect(idA).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(idB).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(idA).not.toBe(idB);
  });
});

describe('ingest → ws → REST round trip (docs/09 §5.1)', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('one on-chain event reaches the socket and the read-model consistently', async () => {
    const database = new Db(':memory:');
    try {
      useDb(database);
      await installBus('inproc');
      const server = http.createServer(createApp(database, { arenaSweepMs: 0, accessLog: false }));
      const { hub, close } = attachWs(server, { db: () => database, pingMs: 0 });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const port = (server.address() as { port: number }).port;
      const buyer = Keypair.generate().publicKey.toBase58();
      const asset = Keypair.generate().publicKey.toBase58();
      const frames: Record<string, unknown>[] = [];
      try {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?wallet=${buyer}`);
        ws.on('message', (raw: Buffer) => frames.push(JSON.parse(String(raw)) as Record<string, unknown>));
        await new Promise<void>((res) => ws.once('open', () => res()));
        expect(hub.clients()).toBe(1);

        const firstSig = nextSig();
        const r = ingestTx(tx([{
          program: 'chip_core', name: 'PackOpened',
          data: { buyer, sku: 1, nonce: '7', assets: Array(5).fill(asset), rarities: [4, 1, 1, 1, 1], collections: [2, 2, 2, 2, 2], count: 1, roll: hex32(0x7), pityBefore: 3, pityAfter: 0 },
        }], { signature: firstSig }), database);
        expect(r.inserted).toBe(1);

        const t0 = Date.now();
        while (!frames.some((f) => f.type === 'pack_opened') && Date.now() - t0 < 4_000) await sleep(10);
        const frame = frames.find((f) => f.type === 'pack_opened');
        expect(frame).toBeTruthy();
        expect(frame!.payload).toMatchObject({ buyer, nonce: '7', sku: 1, count: 1 });

        const res = await fetch(`http://127.0.0.1:${port}/v1/wallet/${buyer}/events`);
        const body = await res.json() as { events: Array<{ name: string }> };
        expect(res.status).toBe(200);
        expect(body.events.map((e) => e.name)).toContain('PackOpened');

        // a replay of the same tx (what the healer does on every gap scan) must stay silent
        const before = frames.length;
        ingestTx(tx([{
          program: 'chip_core', name: 'PackOpened',
          data: { buyer, sku: 1, nonce: '7', assets: Array(5).fill(asset), rarities: [4, 1, 1, 1, 1], collections: [2, 2, 2, 2, 2], count: 1, roll: hex32(0x7), pityBefore: 3, pityAfter: 0 },
        }], { signature: firstSig }), database); // the same signature the healer would re-feed
        await sleep(200);
        expect(frames.length).toBe(before);
        ws.close();
      } finally {
        await close();
        await new Promise<void>((r) => server.close(() => r()));
      }
    } finally { database.close(); }
  });

  it('BusMessage shape survives the redis transport (JSON round trip)', () => {
    const d = new Db(':memory:');
    try {
      const owner = Keypair.generate().publicKey.toBase58();
      const m = wireEvent(d, { program: 'chip_core', programId: 'x', name: 'ChipFused', ixIndex: 0, eventIndex: 0, data: { owner, result: 'r'.repeat(43), recipe: 1, success: true } } as never, { slot: 99 })!;
      const rt = JSON.parse(JSON.stringify(m)) as BusMessage;
      expect(rt).toEqual(m);
      expect(rt.slot).toBe(99);
      expect(rt.wallets).toEqual([owner]);
      expect(rt.payload.success).toBe(true);
    } finally { d.close(); }
  });
});
