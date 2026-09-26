// T-B-49 — proof of human (Turnstile) + device-fingerprint dedupe + IP /24 limits (docs/02 "Жёсткие
// ограничители", docs/03 §3.4, docs/06 §3.10). `backend/src/human.ts`.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import type { Server } from 'node:http';
import { Db } from '../src/db.ts';
import { createApp } from '../src/server.ts';
import { MemoryStore, POLICIES, createLimiter, ipNet } from '../src/ratelimit.ts';
import { base58Encode } from '../src/base58.ts';
import { ingestTx } from '../src/ingest.ts';
import * as human from '../src/human.ts';
import * as quests from '../src/quests.ts';
import * as arena from '../src/arena.ts';
import * as antifraud from '../src/antifraud.ts';
import { finalizeAll, kp, tx } from './fixtures.ts';

const T = 1_800_000_000 + 12 * 3600;
/** A finalized paid pack (sku 1) → the wallet passes the age / paid-pack rule and only the new gates remain. */
function paidPack(db: Db, wallet: string, blockTime = T - 3 * 86_400) {
  ingestTx(tx([{ program: 'chip_core', name: 'PackBought', data: { buyer: wallet, sku: 1, qty: 1, currency: 0, amount: '33000000', nonce: String(Math.floor(Math.random() * 1e9)), randomness: kp() } }], { blockTime }), db);
  db.run(`INSERT INTO wallets (address, first_seen) VALUES (?, ?) ON CONFLICT(address) DO NOTHING`, wallet, blockTime);
  finalizeAll(db);
}

describe('T-B-49 device dedupe (unit)', () => {
  let db: Db;
  beforeEach(() => { db = new Db(':memory:'); human.configureHuman({ enabled: false, maxWalletsPerDevice: 3, salt: 'test-salt' }); });

  it('hashes are salted and stable; absurd fingerprints are ignored', () => {
    const a = human.deviceHash('seeker:1440x3120:Asia/Singapore:en-US:8:arm');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(human.deviceHash('seeker:1440x3120:Asia/Singapore:en-US:8:arm')).toBe(a);
    human.configureHuman({ salt: 'other' });
    expect(human.deviceHash('seeker:1440x3120:Asia/Singapore:en-US:8:arm')).not.toBe(a);
    expect(human.deviceHash('short')).toBeUndefined();
    expect(human.deviceHash('x'.repeat(300))).toBeUndefined();
    expect(human.deviceHash(42)).toBeUndefined();
    expect(human.recordDevice(db, kp(), undefined)).toBeUndefined();
  });

  it('the first 3 wallets on a device earn; the 4th and later are device_limited (deterministic by first_seen)', () => {
    const fp = 'phone-A-fingerprint';
    const wallets = Array.from({ length: 5 }, () => kp());
    wallets.forEach((w, i) => { paidPack(db, w); human.recordDevice(db, w, fp, T - 1000 + i); });
    expect(wallets.map((w) => human.deviceStatus(db, w).limited)).toEqual([false, false, false, true, true]);
    expect(human.deviceStatus(db, wallets[4])).toMatchObject({ devices: 1, maxWalletsOnDevice: 5 });
    // a second, private device does not un-limit a wallet that is late on a crowded one…
    human.recordDevice(db, wallets[4], 'private-laptop-fp', T);
    expect(human.deviceStatus(db, wallets[4]).limited).toBe(true);
    // …and the early wallets stay eligible even after the device gets crowded
    expect(quests.eligibility(db, wallets[0], T)).toMatchObject({ eligible: true, reason: null });
    expect(quests.eligibility(db, wallets[3], T)).toMatchObject({ eligible: false, reason: 'device_limit' });
    expect(quests.skrEligibility(db, wallets[3], T + 10 * 86_400)).toMatchObject({ eligible: false, reason: 'device_limit' });
    // repeated sign-ins from the same wallet/device only bump counters
    human.recordDevice(db, wallets[0], fp, T + 5);
    expect(db.scalar(`SELECT seen FROM wallet_devices WHERE wallet = ?`, wallets[0])).toBe(2);
    expect(db.scalar(`SELECT COUNT(*) FROM wallet_devices WHERE device_hash = ?`, human.deviceHash(fp)!)).toBe(5);
  });

  it('device_limit is enforced on quest settlement (amount 0, not postponed), match rewards and season ranking; `trust` lifts it', () => {
    const fp = 'shared-tablet';
    const early = [kp(), kp(), kp()];
    const late = kp();
    for (const w of [...early, late]) paidPack(db, w);
    early.forEach((w, i) => human.recordDevice(db, w, fp, T - 100 + i));
    human.recordDevice(db, late, fp, T);
    quests.recordLogin(db, late, T);
    expect(quests.settleWallet(db, late, T + 60)).toBeGreaterThan(0);
    expect(db.get<{ amount: string }>(`SELECT amount FROM quest_completions WHERE wallet = ? AND quest_id = 'd_login'`, late)!.amount).toBe('0');
    // arena: match reward 0 for the late wallet, season ranking skips it
    const s = arena.currentSeason(db, T);
    const m = { id: 'm1', season: s.id, a: late, b: early[0], squad_a: '[]', squad_b: '[]', power_a: 900, power_b: 900, league: 0, commit_a: '', commit_b: '', nonce_a: null, nonce_b: null, seed: null, rounds: null, winner: late, forfeit: 0, rewarded: 0, reward_a: '0', reward_b: '0', wager: '0', battle_pda: null, resolve_sig: null, status: 'resolved', started_at: T * 1000, ended_at: T * 1000 + 30_000 } as arena.MatchRow;
    expect(arena.matchReward(db, m, late, true, T)).toBe(0n);
    expect(arena.matchReward(db, m, early[0], false, T)).toBeGreaterThan(0n);
    db.run(`INSERT INTO ratings (wallet, season, rating, games) VALUES (?, ?, 1200, 12), (?, ?, 1100, 12)`, late, s.id, early[0], s.id);
    // qualification games (2 days old so they do not trip the 24 h win-trading brake used below)
    for (let i = 0; i < 10; i++) db.run(`INSERT INTO matches (id, season, a, b, squad_a, squad_b, power_a, power_b, league, commit_a, commit_b, winner, status, forfeit, rewarded, reward_a, reward_b, started_at, ended_at) VALUES (?, ?, ?, ?, '[]', '[]', 900, 900, 0, '', '', ?, 'resolved', 0, 0, '0', '0', ?, ?)`, `sm${i}`, s.id, late, early[0], i % 2 ? late : early[0], (T - 2 * 86_400) * 1000, (T - 2 * 86_400) * 1000 + 1);
    expect(arena.rankedSeasonWallets(db, s).map((r) => r.wallet)).toEqual([early[0]]); // late has the higher rating but is not paid
    // ops: `trust` (support decision) bypasses the device gate; `unflag` removes it again
    antifraud.resolveWallet(db, late, 'trust', 'ops', 'family tablet');
    expect(antifraud.walletFlags(db, late)).toMatchObject({ trusted: true, note: 'family tablet' });
    expect(quests.eligibility(db, late, T).eligible).toBe(true);
    expect(arena.matchReward(db, { ...m, id: 'm2' }, late, true, T)).toBeGreaterThan(0n);
    antifraud.resolveWallet(db, late, 'unflag', 'ops');
    expect(antifraud.walletFlags(db, late).trusted).toBeUndefined();
    expect(quests.eligibility(db, late, T)).toMatchObject({ eligible: false, reason: 'device_limit' });
  });

  it('device_ring signal: a device with more wallets than the limit is raised once, attached to the earliest wallet', () => {
    const fp = 'farm-emulator-7';
    const ws = Array.from({ length: 6 }, () => kp());
    ws.forEach((w, i) => human.recordDevice(db, w, fp, T + i));
    human.recordDevice(db, kp(), 'lonely-phone', T);
    const signals = antifraud.detectDeviceRings(db);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ wallet: ws[0], kind: 'device_ring', score: 65, evidence: { walletsOnDevice: 6, limit: 3 } });
    expect(antifraud.recordSignals(db, signals, T)).toBe(1);
    expect(antifraud.recordSignals(db, antifraud.runDetectors(db, T), T)).toBe(0); // idempotent re-run
    expect(antifraud.antifraudStatus(db)).toMatchObject({ openSignals: { device_ring: 1 }, human: { enabled: false, devices: 2, crowdedDevices: 1 } });
  });
});

describe('T-B-49 proof of human (unit)', () => {
  let db: Db;
  const calls: { token: string; ip?: string }[] = [];
  beforeEach(() => {
    db = new Db(':memory:');
    calls.length = 0;
    human.configureHuman({ enabled: true, ttlS: 7 * 86_400, maxWalletsPerDevice: 3, salt: 'test-salt', siteKey: '1x00000000000000000000AA',
      hostnames: ['app.guttercaps.gg', '.guttercaps.gg'], action: 'claim', maxAgeS: 600,
      verifier: async (token, ip) => { calls.push({ token, ip }); return token.startsWith('ok-') ? { success: true, hostname: 'app.guttercaps.gg', action: 'claim', errorCodes: [] } : { success: false, errorCodes: ['invalid-input-response'] }; } });
  });
  afterEach(() => human.configureHuman({ enabled: false, verifier: undefined }));

  it('without a fresh pass the wallet is `human_check_required` and settlement is POSTPONED (paid after the pass, within the window)', async () => {
    const w = kp();
    paidPack(db, w);
    expect(human.humanStatus(db, w, T)).toMatchObject({ required: true, verified: false, siteKey: '1x00000000000000000000AA' });
    expect(quests.eligibility(db, w, T)).toMatchObject({ eligible: false, reason: 'human_check_required' });
    expect(quests.skrEligibility(db, w, T + 10 * 86_400).reason).toBe('human_check_required');
    quests.recordLogin(db, w, T);
    expect(quests.settleWallet(db, w, T + 60)).toBe(0);
    expect(db.scalar(`SELECT COUNT(*) FROM quest_completions WHERE wallet = ?`, w)).toBe(0); // nothing recorded at 0
    // bad token → 400, nothing stored
    await expect(human.verifyHuman(db, w, { token: 'nope' }, { ip: '203.0.113.9', net: '203.0.113.0/24' }, T + 100)).rejects.toMatchObject({ status: 400, code: 'turnstile_failed' });
    expect(human.humanStatus(db, w, T + 100).verified).toBe(false);
    // good token → pass for 7 d, remoteip forwarded to siteverify, fingerprint recorded on the way
    const st = await human.verifyHuman(db, w, { token: 'ok-abc', fingerprint: 'phone-Z-fingerprint' }, { ip: '203.0.113.9', net: '203.0.113.0/24' }, T + 120);
    expect(st).toMatchObject({ required: true, verified: true, verifiedAt: new Date((T + 120) * 1000).toISOString(), expiresAt: new Date((T + 120 + 7 * 86_400) * 1000).toISOString() });
    expect(calls.at(-1)).toEqual({ token: 'ok-abc', ip: '203.0.113.9' });
    expect(db.get(`SELECT ip_net, hostname, action FROM human_checks WHERE wallet = ?`, w)).toEqual({ ip_net: '203.0.113.0/24', hostname: 'app.guttercaps.gg', action: 'claim' });
    expect(human.deviceStatus(db, w).devices).toBe(1);
    expect(quests.eligibility(db, w, T + 130)).toMatchObject({ eligible: true, reason: null });
    // the postponed login quest is now paid
    expect(quests.settleWallet(db, w, T + 140)).toBeGreaterThan(0);
    expect(db.get<{ amount: string }>(`SELECT amount FROM quest_completions WHERE wallet = ? AND quest_id = 'd_login'`, w)!.amount).toBe('2000000');
    // the pass expires after the TTL
    expect(human.humanStatus(db, w, T + 120 + 7 * 86_400 + 1)).toMatchObject({ verified: false, expiresAt: null });
    expect(quests.eligibility(db, w, T + 120 + 7 * 86_400 + 1).reason).toBe('human_check_required');
    // `trusted` bypasses the requirement entirely
    antifraud.resolveWallet(db, w, 'trust', 'ops');
    expect(human.humanStatus(db, w, T + 30 * 86_400).required).toBe(false);
    expect(quests.eligibility(db, w, T + 30 * 86_400).eligible).toBe(true);
  });

  it('the cheapest fix is shown first: age/pack before human check; disabled gate never asks', () => {
    const fresh = kp();
    db.run(`INSERT INTO wallets (address, first_seen) VALUES (?, ?)`, fresh, T - 60);
    expect(quests.eligibility(db, fresh, T).reason).toBe('account_too_new');
    human.configureHuman({ enabled: false });
    const w = kp(); paidPack(db, w);
    expect(human.humanStatus(db, w, T)).toMatchObject({ required: false, verified: false });
    expect(quests.eligibility(db, w, T).eligible).toBe(true);
  });

  it('SEC-B5 a pass is only ours: foreign hostname / wrong action / stale token are refused', async () => {
    const w = kp();
    const attempt = (o: Partial<human.TurnstileOutcome>, at = T + 100) =>
      human.verifyHuman(db, w, { token: 'tok' }, {}, at);
    // a sitekey is public: a farm that solves the challenge on its own page must not get a pass here
    human.configureHuman({ verifier: async () => ({ success: true, hostname: 'farm.example', action: 'claim', errorCodes: [] }) });
    await expect(attempt({})).rejects.toMatchObject({ status: 400, code: 'turnstile_failed', details: { hostname: 'farm.example' } });
    expect(human.humanStatus(db, w, T + 100).verified).toBe(false);
    // ...and neither must a token minted for a different action of the same widget
    human.configureHuman({ verifier: async () => ({ success: true, hostname: 'app.guttercaps.gg', action: 'login', errorCodes: [] }) });
    await expect(attempt({})).rejects.toMatchObject({ status: 400, code: 'turnstile_failed', details: { action: 'login' } });
    // subdomain of an allowlisted apex ('.guttercaps.gg') and the exact host pass
    const at = (sec: number) => new Date(sec * 1000).toISOString();
    human.configureHuman({ verifier: async (tok) => ({ success: true, hostname: tok === 'sub' ? 'dev.guttercaps.gg' : 'app.guttercaps.gg', action: 'claim', challengeTs: at(T + 150), errorCodes: [] }) });
    await expect(human.verifyHuman(db, w, { token: 'sub' }, {}, T + 200)).resolves.toMatchObject({ verified: true });
    await expect(human.verifyHuman(db, w, { token: 'exact' }, {}, T + 200)).resolves.toMatchObject({ verified: true });
    // an old token is refused even though siteverify said success (single-use only helps if it was not cached)
    const w2 = kp();
    human.configureHuman({ verifier: async () => ({ success: true, hostname: 'app.guttercaps.gg', action: 'claim', challengeTs: at(T - 3600), errorCodes: [] }) });
    await expect(human.verifyHuman(db, w2, { token: 'tok' }, {}, T)).rejects.toMatchObject({ status: 400, code: 'turnstile_failed' });
    // an unparseable timestamp — or one from the future beyond clock skew — fails closed, not open
    human.configureHuman({ verifier: async () => ({ success: true, hostname: 'app.guttercaps.gg', action: 'claim', challengeTs: 'not-a-date', errorCodes: [] }) });
    await expect(human.verifyHuman(db, w2, { token: 'tok' }, {}, T)).rejects.toMatchObject({ status: 400, code: 'turnstile_failed' });
    human.configureHuman({ verifier: async () => ({ success: true, hostname: 'app.guttercaps.gg', action: 'claim', challengeTs: at(T + 86_400), errorCodes: [] }) });
    await expect(human.verifyHuman(db, w2, { token: 'tok' }, {}, T)).rejects.toMatchObject({ status: 400, code: 'turnstile_failed' });
    // with the configured hostname/action checks emptied the gate degrades to the previous behaviour
    human.configureHuman({ hostnames: [], action: '', verifier: async () => ({ success: true, hostname: 'farm.example', action: 'nope', challengeTs: at(T + 300), errorCodes: [] }) });
    await expect(human.verifyHuman(db, w2, { token: 'tok' }, {}, T + 300)).resolves.toMatchObject({ verified: true });
  });

  it('siteverify adapter: form-encoded POST, maps success / error-codes, 503 on HTTP failure', async () => {
    const seen: { url: string; body: string; ip: string | null }[] = [];
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = init!.body as URLSearchParams;
      seen.push({ url: String(url), body: body.toString(), ip: body.get('remoteip') });
      if (body.get('response') === 'boom') return new Response('', { status: 502 });
      return Response.json(body.get('response') === 'good' ? { success: true, hostname: 'h', action: 'a', challenge_ts: 'ts' } : { success: false, 'error-codes': ['timeout-or-duplicate'] });
    }) as typeof fetch;
    const verify = human.createTurnstileVerifier('secret-1', 'https://verify.test/siteverify', fake);
    expect(await verify('good', '198.51.100.1')).toEqual({ success: true, hostname: 'h', action: 'a', challengeTs: 'ts', errorCodes: [] });
    expect(seen[0]).toEqual({ url: 'https://verify.test/siteverify', body: 'secret=secret-1&response=good&remoteip=198.51.100.1', ip: '198.51.100.1' });
    expect(await verify('dup')).toMatchObject({ success: false, errorCodes: ['timeout-or-duplicate'] });
    await expect(verify('boom')).rejects.toMatchObject({ status: 503, code: 'human_check_unavailable' });
  });
});

describe('T-B-49 HTTP: /me/human, fingerprint at sign-in, IP /24 budgets', () => {
  let db: Db; let server: Server; let base: string;
  let clock = 1_800_000_000_000;
  const store = new MemoryStore();
  class Client {
    cookie = ''; csrf = '';
    constructor(private ip: string) {}
    async req(method: string, path: string, body?: unknown) {
      const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': this.ip, ...(this.cookie ? { Cookie: this.cookie } : {}), ...(this.csrf ? { 'X-CSRF-Token': this.csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const sc = res.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : undefined };
    }
    get = (p: string) => this.req('GET', p);
    post = (p: string, b?: unknown) => this.req('POST', p, b);
  }
  async function signIn(c: Client, k: Keypair, extra: Record<string, unknown> = {}) {
    const address = k.publicKey.toBase58();
    const { json: n } = await c.post('/v1/auth/siws/nonce', { address });
    const message = `localhost wants you to sign in with your Solana account:\n${address}\n\n${n.statement}\n\nURI: http://localhost\nVersion: 1\nNonce: ${n.nonce}\nIssued At: ${new Date().toISOString()}`;
    const sig = ed25519.sign(new TextEncoder().encode(message), k.secretKey.slice(0, 32));
    const r = await c.post('/v1/auth/siws/verify', { address, message, signature: base58Encode(sig), ...extra });
    if (r.status === 200) c.csrf = r.json.csrf;
    return r;
  }
  beforeAll(async () => {
    db = new Db(':memory:');
    human.configureHuman({ enabled: true, salt: 'http-salt', siteKey: 'site-key-1', hostnames: ['localhost'], action: 'claim',
      verifier: async (token) => (token === 'ok' ? { success: true, hostname: 'localhost', action: 'claim', errorCodes: [] } : { success: false, errorCodes: ['invalid-input-response'] }) });
    const app = createApp(db, { limiter: createLimiter(store, true, () => clock), arenaSweepMs: 0 });
    await new Promise<void>((f) => { server = app.listen(0, '127.0.0.1', () => f()); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => { human.configureHuman({ enabled: false, verifier: undefined }); await new Promise<void>((f) => server.close(() => f())); });

  it('ipNet: IPv4 /24, IPv4-mapped IPv6 /24, IPv6 /48', () => {
    const rq = (ip: string) => ({ ip, socket: {} }) as never;
    expect(ipNet(rq('203.0.113.77'))).toBe('203.0.113.0/24');
    expect(ipNet(rq('::ffff:203.0.113.77'))).toBe('203.0.113.0/24');
    expect(ipNet(rq('2001:db8:abcd:1234::1'))).toBe('2001:db8:abcd::/48');
  });

  it('sign-in records the salted device hash; /me exposes human + deviceLimited; POST /me/human verifies and unlocks', async () => {
    store.reset();
    const c = new Client('203.0.113.10');
    const k = Keypair.generate();
    expect((await signIn(c, k, { fingerprint: 'browser-fp-0001' })).status).toBe(200);
    const w = k.publicKey.toBase58();
    expect(db.get(`SELECT device_hash FROM wallet_devices WHERE wallet = ?`, w)).toEqual({ device_hash: human.deviceHash('browser-fp-0001') });
    expect(db.scalar(`SELECT COUNT(*) FROM wallet_devices WHERE device_hash LIKE '%browser%'`)).toBe(0); // never the raw value
    const me = await c.get('/v1/me');
    expect(me.json.human).toMatchObject({ required: true, verified: false, siteKey: 'site-key-1' });
    expect(me.json.flags.deviceLimited).toBe(false);
    expect((await c.get('/v1/me/human')).json.verified).toBe(false);
    const bad = await c.post('/v1/me/human', { token: 'bad' });
    expect(bad.status).toBe(400); expect(bad.json.code).toBe('turnstile_failed');
    expect((await c.post('/v1/me/human', {})).status).toBe(400);
    const ok = await c.post('/v1/me/human', { token: 'ok', fingerprint: 'browser-fp-0001' });
    expect(ok.status).toBe(200); expect(ok.json.verified).toBe(true);
    expect((await c.get('/v1/me')).json.human.verified).toBe(true);
    expect(db.get(`SELECT ip_net FROM human_checks WHERE wallet = ?`, w)).toEqual({ ip_net: '203.0.113.0/24' });
    // unauthenticated → 401
    expect((await new Client('203.0.113.11').post('/v1/me/human', { token: 'ok' })).status).toBe(401);
  });

  it('exactly one of 4 wallets signed in from one device is deviceLimited in /me (ties inside one second break by address)', async () => {
    store.reset();
    const clients = Array.from({ length: 4 }, () => new Client('203.0.113.20'));
    for (const c of clients) expect((await signIn(c, Keypair.generate(), { fingerprint: 'crowded-device-fp' })).status).toBe(200);
    const limited = await Promise.all(clients.map(async (c) => (await c.get('/v1/me')).json.flags.deviceLimited as boolean));
    expect(limited.filter(Boolean)).toHaveLength(1);
    expect(db.scalar(`SELECT COUNT(*) FROM wallet_devices WHERE device_hash = ?`, human.deviceHash('crowded-device-fp')!)).toBe(4);
  });

  it('IP /24 budgets: /me/human 6/min per session and 30/h per network; claim-net 40/min shared by every session in the /24', async () => {
    store.reset();
    const c = new Client('198.51.100.5');
    expect((await signIn(c, Keypair.generate())).status).toBe(200);
    for (let i = 0; i < POLICIES.human.limit; i++) expect((await c.post('/v1/me/human', { token: 'ok' })).status).toBe(200);
    const blocked = await c.post('/v1/me/human', { token: 'ok' });
    expect(blocked.status).toBe(429); expect(blocked.json.details.policy).toBe('human');
    // network budget: other sessions in the same /24 share the 30/h counter (6 already used; the 429 above never reached the net policy)
    const others = await Promise.all(Array.from({ length: 5 }, async (_, i) => { const o = new Client(`198.51.100.${50 + i}`); await signIn(o, Keypair.generate()); return o; }));
    let used = POLICIES.human.limit, netBlocked = 0;
    for (const o of others) for (let i = 0; i < POLICIES.human.limit; i++) { const r = await o.post('/v1/me/human', { token: 'ok' }); if (r.status === 429) { expect(r.json.details.policy).toBe('human-net'); netBlocked++; } else used++; }
    expect(used).toBe(POLICIES.humanNet.limit);
    expect(netBlocked).toBe(POLICIES.human.limit * 6 - POLICIES.humanNet.limit); // 36 attempts − 30 allowed
    // a different /24 has its own budget
    const far = new Client('198.51.101.5'); await signIn(far, Keypair.generate());
    expect((await far.post('/v1/me/human', { token: 'ok' })).status).toBe(200);
    // claim-net: 40/min across sessions of the /24 on /services/claim (each session alone allows 10/min)
    store.reset();
    const claimers = await Promise.all(Array.from({ length: 5 }, async (_, i) => { const o = new Client(`192.0.2.${10 + i}`); await signIn(o, Keypair.generate()); return o; }));
    const statuses: number[] = [];
    for (const o of claimers) for (let i = 0; i < 9; i++) statuses.push((await o.post('/v1/services/claim', { signature: 'x'.repeat(88), kind: 0, payload: {} })).status);
    expect(statuses.filter((s) => s === 429)).toHaveLength(45 - POLICIES.claimNet.limit);
    expect(statuses.slice(0, POLICIES.claimNet.limit).every((s) => s !== 429)).toBe(true);
  });
});
