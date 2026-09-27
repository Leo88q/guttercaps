// SEC-B40 — the boot path must not be able to hang on an optional dependency.
//
// `serve.ts` awaits `installBus()` *before* `server.listen`, and `bus.ts` has always documented both Redis
// uses as optional ("a missing Redis costs the cross-process fan-out, and the client polls"). It was not
// optional in practice: `new Redis(url)` does not throw for `ECONNREFUSED` (ioredis retries), so the queued
// `SUBSCRIBE` never settled and `installBus` never returned — with `EVENT_BUS=redis` the API never listened
// at all. The first test is that incident against a port nobody serves; the second is the wedgier variant
// (a peer that accepts the connection, so a connect-only check would pass, and never answers SUBSCRIBE);
// the third boots the real `startServe` under `EVENT_BUS=redis` + a dead Redis and requires `/healthz`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import { bus, installBus } from '../src/bus.ts';
import { metrics } from '../src/metrics.ts';

const busErrorCount = async (): Promise<number> => {
  const line = (await metrics.exposition()).split('\n').find((l) => l.startsWith('redis_error_total{') && l.includes('purpose="bus"'));
  return Number(line?.trim().split(' ')[1] ?? 0);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A TCP port that accepts connections and never speaks Redis, tracking sockets so the test can clean up. */
async function silentPeer(): Promise<{ port: number; sockets: Set<net.Socket>; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  // `s.resume()` matters: a Node socket that never reads does not observe the peer's FIN, so without it the
  // set would keep counting a connection the client has already destroyed and the assertion below would
  // measure the harness instead of the code.
  const server = net.createServer((s) => { sockets.add(s); s.resume(); s.on('close', () => sockets.delete(s)); s.on('error', () => undefined); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    port: (server.address() as net.AddressInfo).port,
    sockets,
    close: async () => { for (const s of sockets) s.destroy(); await new Promise<void>((r) => server.close(() => r())); },
  };
}

afterEach(async () => {
  await installBus('off', undefined, { warn: () => undefined }).catch(() => undefined);
});

describe('SEC-B40 installBus never hangs and never rejects (the API boots on a dead Redis)', () => {
  it('falls back to the in-process bus when nothing is listening, within the timeout', async () => {
    const warnings: string[] = [];
    const t0 = Date.now();
    const b = await installBus('redis', 'redis://127.0.0.1:6399', { connectTimeoutMs: 400, warn: (m) => warnings.push(m) });
    expect(b.kind).toBe('inproc');
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(warnings.join('\n')).toMatch(/redis bus unavailable[\s\S]*falling back to the in-process bus/);
    // and the fallback bus works: a subscriber still receives a publish
    const seen: string[] = [];
    const unsub = b.subscribe((m) => seen.push(m.type));
    b.publish({ wallets: [], type: 'price_update', payload: {} });
    unsub();
    expect(seen).toEqual(['price_update']);
  });

  it('falls back when the peer accepts the connection but never answers SUBSCRIBE, and releases its sockets', async () => {
    const peer = await silentPeer();
    try {
      const warnings: string[] = [];
      const b = await installBus('redis', `redis://127.0.0.1:${peer.port}`, { connectTimeoutMs: 400, warn: (m) => warnings.push(m) });
      expect(b.kind).toBe('inproc');
      expect(warnings.join('\n')).toMatch(/no answer to SUBSCRIBE within 400 ms/);
      // The abandonment path must not leave the two clients reconnecting for ever behind it: ioredis
      // half-closes and destroys them (`disconnectTimeout`, 250 ms here), so both ends are gone inside a
      // second. Regression guard against a future edit that drops the cleanup and quietly reopens the hole.
      await sleep(1_000);
      expect(peer.sockets.size).toBe(0);
    } finally {
      await peer.close();
    }
  });

  it('counts and reports connection errors instead of letting ioredis write to stderr', async () => {
    // `silentEmit` in ioredis writes `[ioredis] Unhandled error event: …` to stderr when *no* listener is
    // attached — outside the structured, redacted logger; a listener that swallowed the argument (the old
    // `pub.on('error', () => {})`) made the same outage invisible in the logs and in /metrics.
    const before = await busErrorCount();
    const warnings: string[] = [];
    await installBus('off', undefined, { warn: () => undefined });
    const b = await installBus('redis', 'redis://127.0.0.1:6398', { connectTimeoutMs: 700, warn: (m) => warnings.push(m) });
    expect(b.kind).toBe('inproc');
    expect(await busErrorCount()).toBeGreaterThan(before);
    expect(warnings.some((w) => /redis bus (pub|sub) error/.test(w))).toBe(true);
  });

  it('keeps the missing-REDIS_URL shortcut it always had', async () => {
    const warnings: string[] = [];
    const b = await installBus('redis', undefined, { warn: (m) => warnings.push(m) });
    expect(b.kind).toBe('inproc');
    expect(warnings.join('\n')).toMatch(/without REDIS_URL/);
  });
});

describe('SEC-B40 startServe boots and serves while Redis is unreachable', () => {
  it('answers /healthz instead of never listening', async () => {
    vi.resetModules();
    process.env.EVENT_BUS = 'redis';
    process.env.REDIS_URL = 'redis://127.0.0.1:6397';
    process.env.EVENT_BUS_CONNECT_TIMEOUT_MS = '300';
    try {
      const [{ startServe }, { Db }] = await Promise.all([import('../src/serve.ts'), import('../src/db.ts')]);
      const database = new Db(':memory:');
      const started = await startServe({ db: database, port: 0, host: '127.0.0.1', signals: false, listenInproc: false });
      try {
        expect(started.port).toBeGreaterThan(0);
        const res = await fetch(`${started.url}/healthz`);
        expect(res.status).toBe(200);
        // the fan-out degraded, and /metrics says so (the series exists because Redis was configured)
        const text = await (await fetch(`${started.url}/metrics`)).text();
        expect(text).toMatch(/event_bus_redis 0/);
        expect(started.hub.clients()).toBe(0);
      } finally {
        // `startServe`'s own shutdown closes the database — closing it here as well is a second close
        await started.close();
      }
    } finally {
      delete process.env.EVENT_BUS; delete process.env.REDIS_URL; delete process.env.EVENT_BUS_CONNECT_TIMEOUT_MS;
      vi.resetModules();
    }
  }, 30_000);
});

describe('SEC-B40 the degraded state is what the alert reads', () => {
  it('the alert rule exists, warns, and queries the series the API exports', async () => {
    const { readFileSync } = await import('node:fs');
    const yml = readFileSync(new URL('../../ops/monitoring/alerts.yml', import.meta.url), 'utf8');
    const rule = /- alert: EventBusDegraded[\s\S]*?expr: event_bus_redis == 0[\s\S]*?severity: warn/.exec(yml);
    expect(rule, 'EventBusDegraded must query event_bus_redis and be a warning').toBeTruthy();
  });
});
