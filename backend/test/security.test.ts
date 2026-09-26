// SEC-H3 / SEC-M4 (docs/06 §2.2): rate limiting (T-B-40), SIWS domain allowlist (T-B-41),
// issuedAt drift (T-B-42), production fail-fast config + nonce cap per wallet (T-B-43).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import type { Server } from 'node:http';
import { Db } from '../src/db.ts';
import { createApp } from '../src/server.ts';
import { AuthError, NONCES_PER_WALLET, issueNonce, verifySiws } from '../src/auth.ts';
import { MemoryStore, POLICIES, createLimiter } from '../src/ratelimit.ts';
import { base58Encode } from '../src/base58.ts';

let db: Db;
let server: Server;
let base: string;
let clock = 1_800_000_000_000; // ms, controllable for window rollover
const store = new MemoryStore();

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : undefined };
}

function siwsMessage(address: string, nonce: string, o: { domain?: string; issuedAt?: string } = {}) {
  return `${o.domain ?? 'localhost'} wants you to sign in with your Solana account:\n${address}\n\nSign in\n\nURI: http://localhost\nVersion: 1\nNonce: ${nonce}\nIssued At: ${o.issuedAt ?? new Date().toISOString()}`;
}
const sign = (kp: Keypair, message: string) => base58Encode(ed25519.sign(new TextEncoder().encode(message), kp.secretKey.slice(0, 32)));

beforeAll(async () => {
  db = new Db(':memory:');
  const app = createApp(db, { limiter: createLimiter(store, true, () => clock), arenaSweepMs: 0 });
  await new Promise<void>((f) => { server = app.listen(0, '127.0.0.1', () => f()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((f) => server.close(() => f())));

describe('T-B-40 rate limiting', () => {
  it('nonce: 10/min per IP → 429 with Retry-After + RateLimit-* headers, window rollover resets', async () => {
    store.reset();
    const address = Keypair.generate().publicKey.toBase58();
    let last;
    for (let i = 0; i < POLICIES.nonceIp.limit; i++) {
      last = await post('/v1/auth/siws/nonce', { address: Keypair.generate().publicKey.toBase58() });
      expect(last.status).toBe(200);
    }
    expect(last!.headers.get('ratelimit-remaining')).toBe('0');
    const blocked = await post('/v1/auth/siws/nonce', { address });
    expect(blocked.status).toBe(429);
    expect(blocked.json.code).toBe('rate_limited');
    expect(blocked.json.details.policy).toBe('nonce-ip');
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(blocked.headers.get('ratelimit-policy')).toBe('10;w=60');
    // X-Forwarded-For is honoured (trust proxy) — a different client IP has its own budget
    expect((await post('/v1/auth/siws/nonce', { address }, { 'X-Forwarded-For': '203.0.113.7' })).status).toBe(200);
    clock += POLICIES.nonceIp.windowMs; // next window
    expect((await post('/v1/auth/siws/nonce', { address })).status).toBe(200);
  });
  it('nonce: 30/h per wallet even from many IPs', async () => {
    store.reset();
    const address = Keypair.generate().publicKey.toBase58();
    for (let i = 0; i < POLICIES.nonceWallet.limit; i++) {
      const r = await post('/v1/auth/siws/nonce', { address }, { 'X-Forwarded-For': `198.51.100.${i % 250}` });
      expect(r.status).toBe(200);
    }
    const r = await post('/v1/auth/siws/nonce', { address }, { 'X-Forwarded-For': '198.51.100.251' });
    expect(r.status).toBe(429);
    expect(r.json.details.policy).toBe('nonce-wallet');
  });
  it('mutations without a session share the IP budget; reads have a separate, larger one', async () => {
    store.reset();
    for (let i = 0; i < POLICIES.mutate.limit; i++) expect((await post('/v1/auth/logout', {})).status).toBe(204);
    expect((await post('/v1/auth/logout', {})).status).toBe(429);
    const read = await fetch(`${base}/v1/health`);
    expect(read.status).toBe(200);
    expect(read.headers.get('ratelimit-limit')).toBe(String(POLICIES.read.limit));
  });
  it('bodies over 16 KB → 413, malformed JSON → 400', async () => {
    store.reset();
    const big = await fetch(`${base}/v1/auth/siws/nonce`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: 'x'.repeat(20_000) }) });
    expect(big.status).toBe(413);
    const bad = await fetch(`${base}/v1/auth/siws/nonce`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe('bad_json');
  });
  it('RATE_LIMIT=0 (disabled limiter) never blocks', async () => {
    const off = createLimiter(new MemoryStore(), false);
    const mw = off.use(POLICIES.nonceIp);
    let passed = 0;
    for (let i = 0; i < 50; i++) mw({ ip: '1.1.1.1', socket: {}, method: 'POST' } as never, { set() {}, status() { return this; }, json() {} } as never, () => { passed++; });
    expect(passed).toBe(50);
  });
});

describe('T-B-41..42 SIWS domain + issuedAt', () => {
  const kp = Keypair.generate();
  const address = kp.publicKey.toBase58();
  const attempt = (o: { domain?: string; issuedAt?: string }, allowed: string[]) => {
    const { nonce } = issueNonce(db, address);
    const message = siwsMessage(address, nonce, o);
    try { return verifySiws(db, { address, message, signature: sign(kp, message) }, allowed); } catch (e) { return e as AuthError; }
  };
  it('domain must be in the configured allowlist (never a request header)', () => {
    expect(attempt({ domain: 'app.guttercaps.gg' }, ['app.guttercaps.gg', 'localhost:5173'])).toBe(address);
    const bad = attempt({ domain: 'evil.example' }, ['app.guttercaps.gg']) as AuthError;
    expect(bad).toBeInstanceOf(AuthError);
    expect(bad.code).toBe('siws_domain');
    // dev: empty allowlist → any domain
    expect(attempt({ domain: 'whatever.local' }, [])).toBe(address);
  });
  it('issuedAt outside ±5 min is rejected; missing is rejected', () => {
    expect(attempt({ issuedAt: new Date(Date.now() - 4 * 60_000).toISOString() }, [])).toBe(address);
    expect((attempt({ issuedAt: new Date(Date.now() - 6 * 60_000).toISOString() }, []) as AuthError).code).toBe('siws_issued_at');
    expect((attempt({ issuedAt: new Date(Date.now() + 6 * 60_000).toISOString() }, []) as AuthError).code).toBe('siws_issued_at');
    expect((attempt({ issuedAt: 'yesterday' }, []) as AuthError).code).toBe('siws_issued_at');
    const { nonce } = issueNonce(db, address);
    const noIssued = `localhost wants you to sign in with your Solana account:\n${address}\n\nSign in\n\nNonce: ${nonce}`;
    expect(() => verifySiws(db, { address, message: noIssued, signature: sign(kp, noIssued) }, [])).toThrow(/Issued At missing/);
  });
  it('a valid SIWS nonce is single-use even when the same signed message is replayed', () => {
    const { nonce } = issueNonce(db, address);
    const message = siwsMessage(address, nonce);
    const signed = { address, message, signature: sign(kp, message) };
    expect(verifySiws(db, signed, [])).toBe(address);
    // The consumed nonce is deleted, so replay is intentionally indistinguishable from an unknown nonce.
    expect(() => verifySiws(db, signed, [])).toThrow(/Unknown nonce|Nonce already used/);
  });
  it('the verify endpoint uses the config allowlist, not X-Forwarded-Host', async () => {
    store.reset();
    const { json: n } = await post('/v1/auth/siws/nonce', { address });
    const message = siwsMessage(address, n.nonce, { domain: 'localhost' });
    // default test config: CORS `*` → no domain restriction; a spoofed forwarded host must not matter either way
    const r = await post('/v1/auth/siws/verify', { address, message, signature: sign(kp, message) }, { 'X-Forwarded-Host': 'evil.example' });
    expect(r.status).toBe(200);
    expect(r.json.wallet.address).toBe(address);
  });
});

describe('T-B-43 hardening', () => {
  it(`a wallet holds at most ${NONCES_PER_WALLET} live nonces (flood protection)`, () => {
    const address = Keypair.generate().publicKey.toBase58();
    const nonces = Array.from({ length: 5 }, () => issueNonce(db, address).nonce);
    const live = db.all<{ nonce: string }>(`SELECT nonce FROM siws_nonces WHERE wallet = ?`, address).map((r) => r.nonce);
    expect(live).toHaveLength(NONCES_PER_WALLET);
    expect(live).toEqual(expect.arrayContaining(nonces.slice(-NONCES_PER_WALLET)));
    expect(live).not.toContain(nonces[0]);
  });
  it('production refuses wildcard CORS / insecure cookie / short secret; passes with a hardened env', async () => {
    const saved = { ...process.env };
    try {
      vi.resetModules();
      process.env.NODE_ENV = 'production';
      delete process.env.CORS_ORIGINS; delete process.env.COOKIE_SECURE; delete process.env.SESSION_SECRET; delete process.env.SIWS_DOMAINS;
      delete process.env.TURNSTILE_SECRET; delete process.env.HUMAN_CHECK; delete process.env.TURNSTILE_HOSTNAMES; delete process.env.DB_PATH; delete process.env.PRODUCTION_DB_MODE;
      const weak = await import('../src/config.ts');
      expect(() => weak.assertProductionConfig()).toThrow(/CORS_ORIGINS[\s\S]*COOKIE_SECURE[\s\S]*SESSION_SECRET[\s\S]*SIWS_DOMAINS[\s\S]*TURNSTILE_SECRET/);
      vi.resetModules();
      process.env.CORS_ORIGINS = 'https://app.guttercaps.gg';
      process.env.COOKIE_SECURE = '1';
      process.env.SESSION_SECRET = 'x'.repeat(48);
      process.env.DB_PATH = '/tmp/guttercaps-test.sqlite';
      process.env.PRODUCTION_DB_MODE = 'sqlite-single-instance';
      // Bubblegum V2 is an explicit production release gate; this test is about the remaining config checks.
      process.env.BUBBLEGUM_V2_ENABLED = '1';
      // T-B-49: proof of human is mandatory in production unless opted out explicitly
      const noHuman = await import('../src/config.ts');
      expect(() => noHuman.assertProductionConfig()).toThrow(/TURNSTILE_SECRET/);
      vi.resetModules();
      process.env.HUMAN_CHECK = '0';
      const optedOut = await import('../src/config.ts');
      expect(() => optedOut.assertProductionConfig()).not.toThrow();
      expect(optedOut.HUMAN_CHECK_ENABLED).toBe(false);
      vi.resetModules();
      delete process.env.HUMAN_CHECK;
      process.env.TURNSTILE_SECRET = '0x' + 'a'.repeat(30);
      const noHosts = await import('../src/config.ts');
      // SEC-B5: a sitekey is public — without the hostname allowlist any site could mint passes for our faucets
      expect(() => noHosts.assertProductionConfig()).toThrow(/TURNSTILE_HOSTNAMES/);
      vi.resetModules();
      process.env.TURNSTILE_HOSTNAMES = 'app.guttercaps.gg,.guttercaps.gg';
      const strong = await import('../src/config.ts');
      expect(() => strong.assertProductionConfig()).not.toThrow();
      expect(strong.HUMAN_CHECK_ENABLED).toBe(true);
      expect(strong.TURNSTILE_HOSTNAMES).toEqual(['app.guttercaps.gg', '.guttercaps.gg']);
      expect(strong.SIWS_DOMAINS).toEqual(['app.guttercaps.gg']); // derived from CORS origins
      vi.resetModules();
      process.env.SIWS_DOMAINS = 'app.guttercaps.gg, staging.guttercaps.gg';
      const explicit = await import('../src/config.ts');
      expect(explicit.SIWS_DOMAINS).toEqual(['app.guttercaps.gg', 'staging.guttercaps.gg']);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      vi.resetModules();
    }
  });
});
