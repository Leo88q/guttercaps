import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import type { Server } from 'node:http';
import { Db } from '../src/db.ts';
import { ingestTx } from '../src/ingest.ts';
import { markFinalized } from '../src/finality.ts';
import { createApp } from '../src/server.ts';
import { handleRefHash, serviceRefHash, toHex, canonicalJson } from '../src/services.ts';
import { base58Encode } from '../src/base58.ts';
import { HANDLE_MAX_RESERVATIONS } from '../src/config.ts';
import { world, tx, kp, DEFAULT, hex32 } from './fixtures.ts';

let db: Db;
let server: Server;
let base: string;
const alice = Keypair.generate();
const HANDLE = 'Rail_Queen';

class Client {
  cookie = '';
  csrf = '';
  constructor(private base: string) {}
  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(this.base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}), ...(this.csrf ? { 'X-CSRF-Token': this.csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b?: unknown) => this.req('POST', p, b);
  put = (p: string, b?: unknown) => this.req('PUT', p, b);
}

async function signIn(c: Client, kp: Keypair) {
  const address = kp.publicKey.toBase58();
  const { json: n } = await c.post('/v1/auth/siws/nonce', { address });
  const message = `localhost wants you to sign in with your Solana account:\n${address}\n\n${n.statement}\n\nURI: http://localhost\nVersion: 1\nNonce: ${n.nonce}\nIssued At: ${new Date().toISOString()}`;
  const sig = ed25519.sign(new TextEncoder().encode(message), kp.secretKey.slice(0, 32));
  const r = await c.post('/v1/auth/siws/verify', { address, message, signature: base58Encode(sig) });
  if (r.status === 200) c.csrf = r.json.csrf;
  return r;
}

let w: ReturnType<typeof world>;

beforeAll(async () => {
  db = new Db(':memory:');
  // the paid handle is bound to alice's real keypair so ref_hash verification is meaningful
  w = world(toHex(handleRefHash(0, alice.publicKey.toBase58(), HANDLE)));
  // re-point the ServicePaid buyer to alice's keypair (world() generated a random buyer)
  for (const t of w.txs) ingestTx(t, db);
  const paySig = 'sigALICEPAY' + 'x'.repeat(40);
  ingestTx(tx([{ program: 'chip_core', name: 'ServicePaid', data: { buyer: alice.publicKey.toBase58(), kind: 0, currency: 3, amount: '120000000', burned: '0', refHash: w.refHash } }], { signature: paySig, blockTime: Math.floor(Date.now() / 1000) - 30 }), db);
  (w as unknown as { alicePaySig: string }).alicePaySig = paySig;
  const app = createApp(db, { arenaSweepMs: 0 });
  await new Promise<void>((f) => { server = app.listen(0, '127.0.0.1', () => f()); });
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => new Promise<void>((f) => server.close(() => f())));

describe('public API', () => {
  it('health + legacy stats/leaderboard paths', async () => {
    const c = new Client(base);
    expect((await c.get('/v1/health')).json.ok).toBe(true);
    expect((await c.get('/stats')).json.packsOpened).toBe(2);
    const lb = await c.get('/leaderboard/wins');
    expect(lb.json.items[0].wallet).toBe(w.alice);
    expect((await c.get('/v1/leaderboard/rating')).json.items).toEqual([]);
    expect((await c.get('/v1/leaderboard/rating?season=-1')).status).toBe(400);
    expect((await c.get('/v1/leaderboard/nope')).status).toBe(404);
  });
  it('services catalogue quotes every currency', async () => {
    const c = new Client(base);
    const { json } = await c.get('/v1/services');
    expect(json.services).toHaveLength(10);
    const handle = json.services.find((s: { kind: number }) => s.kind === 0);
    expect(handle.quotes.CG).toBe('199000000');
    expect(handle.quotes.USDC).toBe('1990000');
    expect(Number(handle.quotes.SKR)).toBeGreaterThan(100_000_000); // ≈ $1.99 / $0.0174 ≈ 114 SKR
  });
  it('market + collections + chip detail', async () => {
    const c = new Client(base);
    expect((await c.get('/v1/market/floor')).json.floors).toHaveLength(8); // 8 collections since the 2026-09-19 universe cut
    const h = await c.get('/v1/market/history');
    expect(h.json.items[0].buyer).toBe(w.bob);
    const d = await c.get(`/v1/chips/${w.chips[4]}`);
    expect(d.json.provenance.origin).toBe('fusion');
    expect(d.json.provenance.recipe).toBe(0);
    expect((await c.get(`/v1/chips/${kp()}`)).status).toBe(404);
    const cols = (await c.get('/v1/collections')).json;
    expect(cols[3].mintedByRarity).toEqual([0, 1, 0, 0, 0, 0, 0, 0, 0]); // 3 commons burned in the fusion, 1 Common+ result alive
    expect(cols[7].mintedByRarity[2]).toBe(1);
    // lore now ships with the collection list (the spec summary promised it since v0.2)
    expect(cols[0].symbol).toBe('NIGHTMOTH');
    expect(cols[0].name).toBe('Night Moth');
  });
  it('chip archetype page is served from the shared lore (docs/09 §4.7 — was 404 while documented)', async () => {
    const c = new Client(base);
    const { json: a, status } = await c.get('/v1/collections/3/chips/2');
    expect(status).toBe(200);
    expect(a.collection).toBe(3);
    expect(a.rarity).toBe(2);
    expect(a.symbol).toBe('GUTTERSOLE');
    expect(a.name.length).toBeGreaterThan(2);
    expect(a.lore.length).toBeGreaterThan(10);                     // per-cap lore text, not a stub
    expect(a.basePower).toBeGreaterThan(0);
    expect(a.maxLevel).toBeGreaterThan(1);                          // pinned by RARITY_PROFILES
    expect(typeof a.supply).toBe('number');
    expect(Array.isArray(a.sales)).toBe(true);
    // the archetype embedded in a chip detail is the same object (one source, no second query path)
    const d = await c.get(`/v1/chips/${w.chips[4]}`);
    expect(d.json.archetype.name).toBe((await c.get(`/v1/collections/${d.json.archetype.collection}/chips/${d.json.archetype.rarity}`)).json.name);
    expect(d.json.archetype.lore.length).toBeGreaterThan(0);
    expect((await c.get('/v1/collections/10/chips/0')).status).toBe(404);
    expect((await c.get('/v1/collections/0/chips/9')).status).toBe(404);
    expect((await c.get('/v1/collections/x/chips/0')).status).toBe(404);
  });
  it('game endpoints are live (fusion / staking / arena / quests); /admin/* needs an allowlisted session', async () => {
    const c = new Client(base);
    expect((await c.get('/v1/fusion/recipes')).json).toHaveLength(8);
    expect((await c.post('/v1/fusion/plan', {})).status).toBe(401);         // auth first
    expect((await c.get('/v1/arena/me')).status).toBe(401);
    expect((await c.get('/v1/quests')).status).toBe(401);
    const season = await c.get('/v1/arena/seasons/current');
    expect(season.status).toBe(200);
    expect(season.json.serverSecret).toBeNull();
    expect(season.json.serverSecretHash).toMatch(/^[0-9a-f]{64}$/);
    const ov = await c.get('/v1/staking/overview');
    expect(ov.status).toBe(200);
    expect(ov.json.tokenPool.apyByTier).toHaveLength(4);
    expect((await c.post('/v1/staking/estimate', { amountCgMicro: '1000000000', tier: 1 })).json.earlyExitPenaltyBps).toBe(500);
    expect((await c.post('/v1/staking/estimate', { amountCgMicro: '1', tier: 9 })).status).toBe(400);
    const sim = await c.post('/v1/arena/simulate', { squadA: [{ collection: 0, rarity: 2, level: 1 }, { collection: 1, rarity: 2, level: 1 }, { collection: 2, rarity: 2, level: 1 }], squadB: [{ collection: 3, rarity: 1, level: 1 }, { collection: 4, rarity: 1, level: 1 }, { collection: 5, rarity: 1, level: 1 }] });
    expect(sim.status).toBe(200);
    expect(sim.json.pWinA).toBeGreaterThan(0.5);
    expect((await c.get('/v1/arena/matches/nope')).status).toBe(404);
    expect((await c.get('/v1/admin/kpi')).status).toBe(401); // gate: session + ADMIN_WALLETS (backend/test/admin.test.ts)
  });
  it('authenticated game flow: plan a fusion, queue for a match, read quests + claims + streak', async () => {
    const c = new Client(base);
    await signIn(c, alice);
    const me = alice.publicKey.toBase58();
    // alice owns nothing yet → plan fails with the chain's reason, suggest is empty
    expect((await c.post('/v1/fusion/plan', { materials: [w.chips[0], w.chips[1], w.chips[3]] })).status).toBe(422);
    expect((await c.get('/v1/fusion/suggest')).json).toEqual([]);
    // mint 3 chips for alice's real key and plan
    const assets = [kp(), kp(), kp()];
    ingestTx(tx([{ program: 'chip_core', name: 'PackBought', data: { buyer: me, sku: 1, qty: 1, currency: 0, amount: '33000000', nonce: '77', randomness: kp() } }]), db);
    ingestTx(tx([{ program: 'chip_core', name: 'PackOpened', data: { buyer: me, sku: 1, nonce: '77', assets: [...assets, DEFAULT, DEFAULT], rarities: [2, 2, 2, 0, 0], collections: [1, 2, 1, 0, 0], count: 3, roll: hex32(0x9f), pityBefore: 0, pityAfter: 1 } }]), db);
    const plan = await c.post('/v1/fusion/plan', { materials: assets, resultCollection: 2 });
    expect(plan.status).toBe(200);
    expect(plan.json).toMatchObject({ resultRarity: 'Rare+', resultCollection: 2, needsRandomness: false, feeCgMicro: '15000000' });
    expect((await c.get('/v1/fusion/suggest')).json).toHaveLength(1);
    // arena: bad commit → 422; good commit → ticket; leave → 204
    expect((await c.post('/v1/arena/queue', { squad: assets, commit: 'nope' })).status).toBe(422);
    const q = await c.post('/v1/arena/queue', { squad: assets, commit: 'ab'.repeat(32) });
    expect(q.status).toBe(200);
    expect(q.json).toMatchObject({ league: 0, squadPower: 630, estimatedWaitSec: 45 });
    const am = await c.get('/v1/arena/me');
    expect(am.json.queue.ticket).toBe(q.json.ticket);
    expect(am.json.rewardedMatchesLeft).toBe(8);
    expect((await c.req('DELETE', '/v1/arena/queue')).status).toBe(204);
    expect((await c.get('/v1/arena/me')).json.queue).toBeNull();
    // quests: reading the list records today's login
    const quests = await c.get('/v1/quests');
    expect(quests.status).toBe(200);
    expect(quests.json.find((x: { id: string }) => x.id === 'd_login')).toMatchObject({ value: 1, claimable: true, ineligibleReason: null });
    expect((await c.get('/v1/quests/claims')).json).toEqual([]);
    expect((await c.get('/v1/quests/streak')).json).toMatchObject({ days: 0, nextChipAt: 7 });
    expect((await c.get('/v1/health')).json.arena).toEqual({ queued: 0, revealing: 0, unattributedResolves: { count: 0, sample: [] } });
  });
  it('requires auth for /me', async () => {
    expect((await new Client(base).get('/v1/me')).status).toBe(401);
  });
});

describe('SIWS + session', () => {
  it('rejects a bad signature and a reused nonce', async () => {
    const c = new Client(base);
    const address = alice.publicKey.toBase58();
    const { json: n } = await c.post('/v1/auth/siws/nonce', { address });
    const message = `localhost wants you to sign in with your Solana account:\n${address}\n\nSign in\n\nNonce: ${n.nonce}\nIssued At: ${new Date().toISOString()}`;
    const bad = await c.post('/v1/auth/siws/verify', { address, message, signature: base58Encode(new Uint8Array(64)) });
    expect(bad.status).toBe(401);
    expect(bad.json.code).toBe('siws_signature');
    const good = base58Encode(ed25519.sign(new TextEncoder().encode(message), alice.secretKey.slice(0, 32)));
    expect((await c.post('/v1/auth/siws/verify', { address, message, signature: good })).status).toBe(200);
    expect((await new Client(base).post('/v1/auth/siws/verify', { address, message, signature: good })).json.code).toBe('siws_nonce'); // single use
  });
  it('signs in, reads /me, enforces CSRF, logs out', async () => {
    const c = new Client(base);
    const r = await signIn(c, alice);
    expect(r.status).toBe(200);
    expect(r.json.wallet.address).toBe(alice.publicKey.toBase58());
    const me = await c.get('/v1/me');
    expect(me.status).toBe(200);
    expect(me.json.pity.counters).toHaveLength(4);
    const noCsrf = new Client(base); noCsrf.cookie = c.cookie;
    expect((await noCsrf.put('/v1/me/handle', { handle: 'x', signature: 'y' })).status).toBe(403);
    expect((await c.post('/v1/auth/logout')).status).toBe(204);
    expect((await c.get('/v1/me')).status).toBe(401);
  });
});

describe('paid services', () => {
  it('handle: check → claim with the on-chain ServicePaid → visible on leaderboard; payment consumed once', async () => {
    const c = new Client(base);
    await signIn(c, alice);
    const paySig = (w as unknown as { alicePaySig: string }).alicePaySig;

    const chk = await c.get(`/v1/me/handle/check?handle=${HANDLE}`);
    expect(chk.json).toMatchObject({ available: true, kind: 0, priceUsdCents: 199, refHash: w.refHash });
    expect((await c.get('/v1/me/handle/check?handle=admin')).json.reason).toBe('blocked');
    expect((await c.get('/v1/me/handle/check?handle=ab')).json.reason).toBe('invalid');

    // another wallet sees the reservation
    const other = new Client(base); await signIn(other, Keypair.generate());
    expect((await other.get(`/v1/me/handle/check?handle=${HANDLE.toLowerCase()}`)).json.reason).toBe('reserved');

    // SEC-M5: a confirmed-but-not-finalized payment cannot buy anything yet → 409 payment_pending
    const early = await c.put('/v1/me/handle', { handle: HANDLE, signature: paySig });
    expect(early.status).toBe(409);
    expect(early.json.code).toBe('payment_pending');
    expect(markFinalized(db, [paySig])).toBeGreaterThan(0);

    // wrong handle for that payment → ref_hash mismatch
    const wrong = await c.put('/v1/me/handle', { handle: 'someone_else', signature: paySig });
    expect(wrong.status).toBe(402);
    expect(wrong.json.code).toBe('ref_hash_mismatch');
    // unknown signature
    expect((await c.put('/v1/me/handle', { handle: HANDLE, signature: 'nope' })).json.code).toBe('payment_not_found');

    const ok = await c.put('/v1/me/handle', { handle: HANDLE, signature: paySig });
    expect(ok.status).toBe(200);
    expect(ok.json.handle).toBe(HANDLE);
    expect((await c.get('/v1/me')).json.handle).toBe(HANDLE);
    // taken for everyone else (case-insensitive)
    expect((await other.get('/v1/me/handle/check?handle=rail_queen')).json.reason).toBe('taken');

    // second use of the same payment: a change is now required (kind 1) and it is inside the 30-day cooldown
    const again = await c.put('/v1/me/handle', { handle: 'other_name', signature: paySig });
    expect(again.status).toBe(409);
    expect(again.json.code).toBe('handle_cooldown');
    expect((await c.get('/v1/me/handle/check?handle=other_name')).json).toMatchObject({ available: false, reason: 'cooldown', kind: 1, priceUsdCents: 99 });
    // a consumed payment can never be replayed, even after the cooldown (simulate by rewinding handle_set_at)
    db.run(`UPDATE wallets SET handle_set_at = handle_set_at - 31 * 86400 WHERE address = ?`, alice.publicKey.toBase58());
    const replay = await c.put('/v1/me/handle', { handle: 'other_name', signature: paySig });
    expect(replay.status).toBe(402);
    expect(replay.json.code).toBe('payment_kind_mismatch'); // kind 0 receipt cannot pay for a kind 1 change
    const changeRef = toHex(handleRefHash(1, alice.publicKey.toBase58(), 'other_name'));
    const changeSig = 'sigCHANGE' + 'q'.repeat(44);
    ingestTx(tx([{ program: 'chip_core', name: 'ServicePaid', data: { buyer: alice.publicKey.toBase58(), kind: 1, currency: 2, amount: '99000000', burned: '99000000', refHash: changeRef } }], { signature: changeSig }), db);
    markFinalized(db, [changeSig]);
    expect((await c.put('/v1/me/handle', { handle: 'other_name', signature: changeSig })).status).toBe(200);
    expect((await c.put('/v1/me/handle', { handle: 'third_name', signature: changeSig })).json.code).toBe('handle_cooldown');
    db.run(`UPDATE wallets SET handle_set_at = handle_set_at - 31 * 86400 WHERE address = ?`, alice.publicKey.toBase58());
    expect((await c.put('/v1/me/handle', { handle: 'third_name', signature: changeSig })).json.code).toBe('payment_consumed');
    // the released handle is quarantined for 90 days for everyone else
    expect((await other.get(`/v1/me/handle/check?handle=${HANDLE}`)).json.reason).toBe('taken');
    const mine = await c.get('/v1/me/services');
    expect(mine.json.entitlements.map((e: { kind: number }) => e.kind)).toEqual([1, 0]);
    expect(mine.json.entitlements[1]).toMatchObject({ kind: 0, payload: { handle: HANDLE } });
    expect(mine.json.dailyLeft['0']).toBe(0); // paid within the last 24 h → cap (1/day) exhausted
    expect(mine.json.dailyLeft['1']).toBe(1); // the change receipt in this test carries an old block time
  });

  // SEC-B18: the check endpoint is a write-on-read — it takes a 120 s hold that reads as `reserved`
  // for everyone else — and nothing bounded how many holds one wallet could pile up. A bot that never
  // pays could hold the whole namespace it could ask about (the IP-scoped read budget was the only
  // ceiling) and grow `handle_reservations` for free.
  it('SEC-B18: one wallet holds at most HANDLE_MAX_RESERVATIONS live reservations, and still gets an honest answer', async () => {
    const c = new Client(base);
    await signIn(c, Keypair.generate());
    const other = new Client(base);
    await signIn(other, Keypair.generate());
    const names = Array.from({ length: HANDLE_MAX_RESERVATIONS }, (_, i) => `hold_${i + 1}`);
    for (const h of names) expect((await c.get(`/v1/me/handle/check?handle=${h}`)).json.available).toBe(true);
    for (const h of names) expect((await other.get(`/v1/me/handle/check?handle=${h}`)).json.reason).toBe('reserved');
    // the cap is reached: the next check still answers honestly, it just takes no hold…
    const last = await c.get('/v1/me/handle/check?handle=hold_overflow');
    expect(last.json.available).toBe(true);
    expect(last.json).not.toHaveProperty('reservedUntil');
    // …so the handle stays free for everyone else instead of being squatted
    const seen = await other.get('/v1/me/handle/check?handle=hold_overflow');
    expect(seen.json.available).toBe(true);
    expect(seen.json.reason).toBeUndefined();
    // and re-checking a handle the wallet already holds is not a new hold (it must stay available)
    expect((await c.get('/v1/me/handle/check?handle=hold_1')).json.available).toBe(true);
  });

  it('generic claim: ref_hash over canonical JSON, ownership check for cap skins', async () => {
    const owner = Keypair.generate();
    const c = new Client(base);
    await signIn(c, owner);
    const asset = kp();
    ingestTx(tx([{ program: 'chip_core', name: 'PackOpened', data: { buyer: owner.publicKey.toBase58(), sku: 1, nonce: '1', assets: [asset, kp(), kp(), DEFAULT, DEFAULT], rarities: [0, 0, 1, 0, 0], collections: [0, 1, 2, 0, 0], count: 3, roll: hex32(1), pityBefore: 0, pityAfter: 0 } }]), db);
    const payload = { skin: 'gold-rim', asset };
    const ref = toHex(serviceRefHash(2, owner.publicKey.toBase58(), payload));
    expect(canonicalJson(payload)).toBe(`{"asset":"${asset}","skin":"gold-rim"}`);
    const sig = 'sigSKIN' + 'y'.repeat(44);
    ingestTx(tx([{ program: 'chip_core', name: 'ServicePaid', data: { buyer: owner.publicKey.toBase58(), kind: 2, currency: 1, amount: '1490000', burned: '0', refHash: ref } }], { signature: sig }), db);
    expect((await c.post('/v1/services/claim', { signature: sig, kind: 2, payload })).json.code).toBe('payment_pending'); // SEC-M5
    markFinalized(db, [sig]);

    expect((await c.post('/v1/services/claim', { signature: sig, kind: 2, payload: { asset, skin: 'hologlow' } })).json.code).toBe('ref_hash_mismatch');
    expect((await c.post('/v1/services/claim', { signature: sig, kind: 0, payload })).json.code).toBe('use_handle_endpoint');
    expect((await c.post('/v1/services/claim', { signature: sig, kind: 3, payload: { theme: 'magenta' } })).json.code).toBe('payment_kind_mismatch');
    const ok = await c.post('/v1/services/claim', { signature: sig, kind: 2, payload });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ kind: 2, currency: 'USDC', amount: '1490000', payload });
    expect((await c.post('/v1/services/claim', { signature: sig, kind: 2, payload })).json.code).toBe('payment_consumed');

    // someone else cannot claim a skin on a cap they don't own even with a valid payment
    const thief = Keypair.generate(); const t = new Client(base); await signIn(t, thief);
    const ref2 = toHex(serviceRefHash(2, thief.publicKey.toBase58(), payload));
    const sig2 = 'sigTHIEF' + 'z'.repeat(44);
    ingestTx(tx([{ program: 'chip_core', name: 'ServicePaid', data: { buyer: thief.publicKey.toBase58(), kind: 2, currency: 1, amount: '1490000', burned: '0', refHash: ref2 } }], { signature: sig2 }), db);
    markFinalized(db, [sig2]);
    expect((await t.post('/v1/services/claim', { signature: sig2, kind: 2, payload })).json.code).toBe('not_owner');
  });
});
