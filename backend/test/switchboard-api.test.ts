import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { Connection } from '@solana/web3.js';
import { createApp } from '../src/server.ts';
import { createSwitchboardService } from '../src/switchboard.ts';
import { createLimiter } from '../src/ratelimit.ts';
import { Db } from '../src/db.ts';
import { FakeConnection } from './chainFixtures.ts';
let server: Server, db: Db, base: string;
beforeAll(async () => {
  db = new Db(':memory:');
  const service = createSwitchboardService(() => new FakeConnection() as unknown as Connection, {
    load: async () => ({ genesis: 'test', candidates: [] }),
  });
  server = createApp(db, { switchboard: service, arenaSweepMs: 0, accessLog: false, limiter: createLimiter(undefined, true) }).listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/switchboard`;
});
afterAll(async () => { await new Promise<void>(r => server.close(() => r())); db.close(); });
it('is a public, uncached-by-browser read that returns 503 rather than false readiness', async () => {
  const res = await fetch(`${base}/health`);
  expect(res.status).toBe(503); expect(res.headers.get('cache-control')).toContain('no-store');
  expect(await res.json()).toMatchObject({ ready: false, oracle: null });
});
it('has no reveal relay route: a URL in the path is never forwarded to the gateway', async () => {
  const res = await fetch(`${base}/reveal/${encodeURIComponent('https://127.0.0.1?key=SECRET')}`);
  expect(res.status).toBe(404);
});
it('enforces the per-IP readiness budget even though health is single-flighted', async () => {
  for (let i = 0; i < 11; i++) expect((await fetch(`${base}/health`)).status).toBe(503);
  const res = await fetch(`${base}/health`);
  expect(res.status).toBe(429); expect(res.headers.get('retry-after')).toBeTruthy();
});
