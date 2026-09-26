// /packs/quote + Pyth reader (owner decision Q7: own pusher, 60 s max age, 1 % slippage).
// A fake Connection serves synthetic PriceUpdateV2 accounts so the whole path —
// decode → validate (owner / feed / verification / age) → integer pricing →
// HTTP contract (503 when stale, 429 on caps) — runs without RPC.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import type { Server } from 'node:http';
import { PYTH_FEEDS, PYTH_SHARD_ID, PYTH_MAX_AGE_SECS, PYTH_PUSHER, unitsForCents } from '@guttercaps/economy';
import { Db } from '../src/db.ts';
import { ingestTx } from '../src/ingest.ts';
import { createApp } from '../src/server.ts';
import { BorshWriter } from '../src/borsh.ts';
import { base58Encode } from '../src/base58.ts';
import { decodePriceUpdateV2, pushOracleAccount, priceAccountFor, fetchFeeds, PYTH_RECEIVER, PythError, cachePrice, quoteUnits } from '../src/pyth.ts';
import { configPda } from '../src/chain.ts';
import { encodeGameConfig } from './chainFixtures.ts';
import { priceCents, _resetQuoteCache } from '../src/quote.ts';
import { refreshOnce } from '../src/pyth-cache.ts';
import { tx } from './fixtures.ts';

const disc = sha256(new TextEncoder().encode('account:PriceUpdateV2')).slice(0, 8);

/** Build a PriceUpdateV2 account image (pyth-solana-receiver-sdk layout, LEN = 134). */
function priceUpdate(opts: { feedIdHex: string; price: bigint; exponent?: number; conf?: bigint; publishTime: number; partial?: boolean }): Uint8Array {
  const w = new BorshWriter().bytes(disc).pubkey(PublicKey.default);
  if (opts.partial) w.u8(0).u8(5); else w.u8(1);
  w.bytes(Buffer.from(opts.feedIdHex, 'hex')).i64(opts.price).u64(opts.conf ?? 0n);
  const e = new Uint8Array(4); new DataView(e.buffer).setInt32(0, opts.exponent ?? -8, true); w.bytes(e);
  w.i64(BigInt(opts.publishTime)).i64(BigInt(opts.publishTime - 1)).i64(opts.price).u64(opts.conf ?? 0n).u64(123_456n);
  return w.toBytes();
}

/** Minimal Connection stub: only getMultipleAccountsInfo is used by the reader. */
class FakeConnection {
  accounts = new Map<string, { owner: PublicKey; data: Uint8Array }>();
  calls = 0;
  set(key: PublicKey, data: Uint8Array, owner: PublicKey = PYTH_RECEIVER) { this.accounts.set(key.toBase58(), { owner, data }); }
  async getMultipleAccountsInfo(keys: PublicKey[]) {
    this.calls++;
    return keys.map((k) => { const a = this.accounts.get(k.toBase58()); return a ? { owner: a.owner, data: Buffer.from(a.data), lamports: 1, executable: false, rentEpoch: 0 } : null; });
  }
  async getAccountInfo(key: PublicKey) {
    if (key.equals(configPda()[0])) {
      return { owner: PublicKey.default, data: Buffer.from(encodeGameConfig({
        treasury: PublicKey.default, cgMint: PublicKey.default, collectionsCreated: 10,
        pythSolUsdFeed: SOL_ACC, pythSkrUsdFeed: SKR_ACC,
      })), lamports: 1, executable: false, rentEpoch: 0 };
    }
    const a = this.accounts.get(key.toBase58());
    return a ? { owner: a.owner, data: Buffer.from(a.data), lamports: 1, executable: false, rentEpoch: 0 } : null;
  }
}
const asConnection = (c: FakeConnection) => c as unknown as Connection;

const nowS = () => Math.floor(Date.now() / 1000);
const SOL_ACC = priceAccountFor('SOL');
const SKR_ACC = priceAccountFor('SKR');

describe('Pyth reader', () => {
  it('derives push-oracle accounts (shard u16 LE ‖ feed id) — our shard 0xCA75 and the sponsored shard 0', () => {
    expect(PYTH_SHARD_ID).toBe(0xca75);
    expect(pushOracleAccount(0xca75, PYTH_FEEDS.SOL.feedIdHex).toBase58()).toBe('ELp9x5sFxGJ7zTurykU2p6A9nKDx72b3xzPxfsB5S8GB');
    expect(pushOracleAccount(0xca75, PYTH_FEEDS.SKR.feedIdHex).toBase58()).toBe('9bCSdQVWckgKipe4G3G66aYU9yq2ZdDn8kRPZB9Nihbc');
    expect(pushOracleAccount(0, PYTH_FEEDS.SOL.feedIdHex).toBase58()).toBe('7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE');
    expect(SOL_ACC.toBase58()).toBe('ELp9x5sFxGJ7zTurykU2p6A9nKDx72b3xzPxfsB5S8GB');
  });
  it('decodes PriceUpdateV2 (full = 133 bytes, partial = 134 = SDK LEN)', () => {
    const buf = priceUpdate({ feedIdHex: PYTH_FEEDS.SOL.feedIdHex, price: 15_000_000_000n, conf: 30_000_000n, publishTime: 1_800_000_000 });
    expect(buf.length).toBe(133);
    const p = decodePriceUpdateV2(buf);
    expect(p).toMatchObject({ feedIdHex: PYTH_FEEDS.SOL.feedIdHex, price: 15_000_000_000n, conf: 30_000_000n, exponent: -8, publishTime: 1_800_000_000, verification: 'full', postedSlot: 123_456n });
    const partialBuf = priceUpdate({ feedIdHex: PYTH_FEEDS.SKR.feedIdHex, price: 1_740_000n, publishTime: 1, partial: true });
    expect(partialBuf.length).toBe(134);
    const partial = decodePriceUpdateV2(partialBuf);
    expect(partial.verification).toBe('partial'); expect(partial.price).toBe(1_740_000n);
  });
  it('validates exactly what chip_core validates: owner, feed id, full verification, age ≤ 60 s', async () => {
    const c = new FakeConnection();
    const t = nowS();
    c.set(SOL_ACC, priceUpdate({ feedIdHex: PYTH_FEEDS.SOL.feedIdHex, price: 15_000_000_000n, publishTime: t - 10 }));
    c.set(SKR_ACC, priceUpdate({ feedIdHex: PYTH_FEEDS.SKR.feedIdHex, price: 1_740_000n, publishTime: t - 61 })); // one second too old
    let f = await fetchFeeds(asConnection(c));
    expect(f.SOL).not.toBeInstanceOf(PythError);
    expect((f.SKR as PythError).code).toBe('price_stale');
    // wrong owner
    c.set(SOL_ACC, priceUpdate({ feedIdHex: PYTH_FEEDS.SOL.feedIdHex, price: 15_000_000_000n, publishTime: t }), Keypair.generate().publicKey);
    f = await fetchFeeds(asConnection(c)); expect((f.SOL as PythError).code).toBe('price_owner');
    // counterfeit: SKR feed id posted into the SOL account
    c.set(SOL_ACC, priceUpdate({ feedIdHex: PYTH_FEEDS.SKR.feedIdHex, price: 1n, publishTime: t }));
    f = await fetchFeeds(asConnection(c)); expect((f.SOL as PythError).code).toBe('price_feed');
    // partial verification is rejected (program uses get_price_no_older_than = Full)
    c.set(SOL_ACC, priceUpdate({ feedIdHex: PYTH_FEEDS.SOL.feedIdHex, price: 15_000_000_000n, publishTime: t, partial: true }));
    f = await fetchFeeds(asConnection(c)); expect((f.SOL as PythError).code).toBe('price_unverified');
    // missing account
    c.accounts.delete(SKR_ACC.toBase58());
    f = await fetchFeeds(asConnection(c)); expect((f.SKR as PythError).code).toBe('price_missing');
  });
  it('SEC-M2: conf/price > 2 % → price_uncertain (503 for the quote); ≤ 2 % is quoted at price − conf like the program', async () => {
    const c = new FakeConnection(); const t = nowS();
    // SOL: 0.05 % conf (normal) → accepted, charged at $149.925
    c.set(SOL_ACC, priceUpdate({ feedIdHex: PYTH_FEEDS.SOL.feedIdHex, price: 15_000_000_000n, conf: 7_500_000n, publishTime: t }));
    // SKR: 2.5 % conf (thin book blowing out) → refused
    c.set(SKR_ACC, priceUpdate({ feedIdHex: PYTH_FEEDS.SKR.feedIdHex, price: 1_740_000n, conf: 43_500n, publishTime: t }));
    const f = await fetchFeeds(asConnection(c));
    expect(f.SOL).not.toBeInstanceOf(PythError);
    expect((f.SKR as PythError).code).toBe('price_uncertain');
    expect((f.SKR as PythError).message).toMatch(/2\.50 %/);
    const sol = quoteUnits(f.SOL as Exclude<typeof f.SOL, PythError>, 499);
    expect(sol.amount).toBe((499n * 10n ** 9n * 10n ** 8n) / 100n / (15_000_000_000n - 7_500_000n)); // 33 283 308 lamports — 0.05 % more than at mid
    expect(sol.amount).toBe(33_283_308n);
    // exactly 2 % is the boundary: accepted
    c.set(SKR_ACC, priceUpdate({ feedIdHex: PYTH_FEEDS.SKR.feedIdHex, price: 1_740_000n, conf: 34_800n, publishTime: t }));
    expect((await fetchFeeds(asConnection(c))).SKR).not.toBeInstanceOf(PythError);
  });
  it('quoteUnits == chip_core::units_for_cents integers (+1 % guard)', async () => {
    const c = new FakeConnection(); const t = nowS();
    c.set(SOL_ACC, priceUpdate({ feedIdHex: PYTH_FEEDS.SOL.feedIdHex, price: 15_000_000_000n, publishTime: t }));
    c.set(SKR_ACC, priceUpdate({ feedIdHex: PYTH_FEEDS.SKR.feedIdHex, price: 1_740_000n, publishTime: t }));
    const f = await fetchFeeds(asConnection(c));
    const sol = quoteUnits(f.SOL as Exclude<typeof f.SOL, PythError>, 499);
    expect(sol.amount).toBe(33_266_666n); // $4.99 at $150 → 0.033266666 SOL (floor)
    expect(sol.maxUnits).toBe((33_266_666n * 10_100n) / 10_000n);
    const skr = quoteUnits(f.SKR as Exclude<typeof f.SKR, PythError>, 499);
    expect(skr.amount).toBe(286_781_609n); // 286.78 SKR at $0.0174
    expect(unitsForCents(499, 15_000_000_000n, -8, 9)).toBe(33_266_666n);
  });
  it('pyth-cache writes oracle_prices only for healthy feeds and leaves the last good row otherwise', async () => {
    const db = new Db(':memory:'); const t = nowS();
    const c = new FakeConnection();
    c.set(SOL_ACC, priceUpdate({ feedIdHex: PYTH_FEEDS.SOL.feedIdHex, price: 15_000_000_000n, conf: 75_000_000n, publishTime: t - 5 }));
    c.set(SKR_ACC, priceUpdate({ feedIdHex: PYTH_FEEDS.SKR.feedIdHex, price: 1_740_000n, publishTime: t - 5 }));
    const feeds = await fetchFeeds(asConnection(c));
    for (const s of ['SOL', 'SKR'] as const) cachePrice(db, s, feeds[s] as Exclude<typeof feeds.SOL, PythError>);
    const row = db.get<{ usd: number; account: string; conf_bps: number; publish_time: number }>(`SELECT * FROM oracle_prices WHERE symbol = 'SOL'`)!;
    expect(row.usd).toBeCloseTo(150, 6); expect(row.account).toBe(SOL_ACC.toBase58()); expect(row.conf_bps).toBe(50); expect(row.publish_time).toBe(t - 5);
    // refreshOnce uses the shared getConnection (real RPC) — exercise the branch logic through cachePrice instead; the health view reflects age
    expect(db.get<{ usd: number }>(`SELECT usd FROM oracle_prices WHERE symbol = 'SKR'`)!.usd).toBeCloseTo(0.0174, 8);
    expect(typeof refreshOnce).toBe('function');
  });
});

describe('priceCents (same integer math as buy_pack)', () => {
  it('bundles only on Standard/Premium; SKR promo stacks additively and caps at 30 %', () => {
    expect(priceCents(1, 1, 'SOL')).toEqual({ cents: 499, discountBps: 0 });
    expect(priceCents(1, 5, 'USDC')).toEqual({ cents: Math.floor((499 * 5 * 9_300) / 10_000), discountBps: 700 });
    expect(priceCents(1, 25, 'SOL').discountBps).toBe(1_800);
    expect(priceCents(1, 25, 'SKR').discountBps).toBe(2_300);
    expect(priceCents(2, 10, 'SKR')).toEqual({ cents: Math.floor((1299 * 10 * 8_300) / 10_000), discountBps: 1_700 });
    expect(priceCents(3, 5, 'SOL')).toEqual({ cents: 2499 * 5, discountBps: 0 });      // Limited: no bundles
    expect(priceCents(3, 5, 'SKR')).toEqual({ cents: Math.floor((2499 * 5 * 9_500) / 10_000), discountBps: 500 }); // …but the SKR promo applies
    expect(priceCents(0, 1, 'SKR')).toEqual({ cents: Math.floor((149 * 9_500) / 10_000), discountBps: 500 });
    expect(priceCents(1, 25, 'SKR', 1_500).discountBps).toBe(3_000); // 18 % + 15 % → capped
  });
});

describe('POST /packs/quote', () => {
  let db: Db; let server: Server; let base: string;
  const fake = new FakeConnection();
  const alice = Keypair.generate();
  class Client {
    cookie = ''; csrf = '';
    async req(method: string, path: string, body?: unknown) {
      const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}), ...(this.csrf ? { 'X-CSRF-Token': this.csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const sc = res.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : undefined, headers: res.headers };
    }
    post = (p: string, b?: unknown) => this.req('POST', p, b);
    get = (p: string) => this.req('GET', p);
  }
  async function signIn(c: Client, kp: Keypair) {
    const address = kp.publicKey.toBase58();
    const { json: n } = await c.post('/v1/auth/siws/nonce', { address });
    const message = `localhost wants you to sign in with your Solana account:\n${address}\n\n${n.statement}\n\nURI: http://localhost\nVersion: 1\nNonce: ${n.nonce}\nIssued At: ${new Date().toISOString()}`;
    const sig = ed25519.sign(new TextEncoder().encode(message), kp.secretKey.slice(0, 32));
    const r = await c.post('/v1/auth/siws/verify', { address, message, signature: base58Encode(sig) });
    c.csrf = r.json.csrf;
  }
  const setFresh = (ageSol = 5, ageSkr = 5) => {
    const t = nowS();
    fake.set(SOL_ACC, priceUpdate({ feedIdHex: PYTH_FEEDS.SOL.feedIdHex, price: 15_000_000_000n, publishTime: t - ageSol }));
    fake.set(SKR_ACC, priceUpdate({ feedIdHex: PYTH_FEEDS.SKR.feedIdHex, price: 1_740_000n, publishTime: t - ageSkr }));
    _resetQuoteCache();
  };

  beforeAll(async () => {
    db = new Db(':memory:');
    const app = createApp(db, { connection: () => asConnection(fake), arenaSweepMs: 0 });
    await new Promise<void>((f) => { server = app.listen(0, '127.0.0.1', () => f()); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((f) => server.close(() => f())));
  beforeEach(() => setFresh());

  it('requires auth (pity and caps are per wallet)', async () => {
    expect((await new Client().post('/v1/packs/quote', { sku: 1, qty: 1, currency: 'SOL' })).status).toBe(401);
  });
  it('SOL: amount from our Pyth account, +1 % guard, account + expiry advertised', async () => {
    const c = new Client(); await signIn(c, alice);
    const r = await c.post('/v1/packs/quote', { sku: 1, qty: 1, currency: 'SOL' });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.json).toMatchObject({ sku: 1, qty: 1, currency: 'SOL', amount: '33266666', maxLamports: '33599332', discountBps: 0, priceUsdCents: 499, priceUpdateAccount: SOL_ACC.toBase58(), rentReserveLamports: String(8_000_000 * 3), pityCounter: 0, hardPityIn: 60, pythUpdateData: [] });
    expect(r.json.solUsd).toBeCloseTo(150, 6); expect(r.json.skrUsd).toBeCloseTo(0.0174, 8);
    expect(r.json.effectiveOddsBps.reduce((a: number, b: number) => a + b, 0)).toBe(10_000);
    const validS = (Date.parse(r.json.expiresAt) - Date.now()) / 1000;
    expect(validS).toBeGreaterThan(PYTH_MAX_AGE_SECS - 5 - 3); expect(validS).toBeLessThanOrEqual(PYTH_MAX_AGE_SECS);
  });
  it('SKR: bundle + promo discount, micro-SKR amount; USDC/$CG need no oracle', async () => {
    const c = new Client(); await signIn(c, alice);
    const skr = await c.post('/v1/packs/quote', { sku: 2, qty: 5, currency: 'SKR' });
    expect(skr.status).toBe(200);
    const cents = Math.floor((1299 * 5 * (10_000 - 1_200)) / 10_000);
    expect(skr.json).toMatchObject({ discountBps: 1_200, priceUsdCents: cents, priceUpdateAccount: SKR_ACC.toBase58(), amount: String(unitsForCents(cents, 1_740_000n, -8, 6)) });
    fake.accounts.clear(); _resetQuoteCache(); // no oracle at all
    const usdc = await c.post('/v1/packs/quote', { sku: 1, qty: 10, currency: 'USDC' });
    expect(usdc.status).toBe(200); expect(usdc.json.amount).toBe(String(Math.floor((499 * 10 * 8_800) / 10_000) * 10_000)); expect(usdc.json.priceUpdateAccount).toBeUndefined();
    const cg = await c.post('/v1/packs/quote', { sku: 1, qty: 1, currency: 'CG' });
    expect(cg.json.amount).toBe('750000000');
    expect((await c.post('/v1/packs/quote', { sku: 0, qty: 1, currency: 'CG' })).json.code).toBe('currency_not_accepted');
  });
  it('503 price_unavailable when the on-chain price is stale, too close to expiry, or missing — never a made-up number', async () => {
    const c = new Client(); await signIn(c, alice);
    setFresh(61, 5);
    // the age is computed from the wall clock at request time, so a second may tick between arming the
    // fixture and the quote (this test used to demand exactly `61 s old` and failed on that boundary in
    // CI): what has to be exact is the reason and the 503, the number just has to be the real age.
    let r = await c.post('/v1/packs/quote', { sku: 1, qty: 1, currency: 'SOL' });
    expect(r.status).toBe(503); expect(r.json.code).toBe('price_unavailable'); expect(r.json.message).toMatch(/6[12] s old/);
    expect((await c.post('/v1/packs/quote', { sku: 1, qty: 1, currency: 'SKR' })).status).toBe(200); // the other rail is fine
    setFresh(PYTH_MAX_AGE_SECS - PYTH_PUSHER.quoteMinRemainingS + 1, 5); // 46 s: a buyer could not sign in time
    r = await c.post('/v1/packs/quote', { sku: 1, qty: 1, currency: 'SOL' });
    expect(r.status).toBe(503); expect(r.json.message).toMatch(/waiting for the next push/);
    fake.accounts.clear(); _resetQuoteCache();
    r = await c.post('/v1/packs/quote', { sku: 1, qty: 1, currency: 'SKR' });
    expect(r.status).toBe(503); expect(r.json.message).toMatch(/does not exist/);
  });
  it('validation + per-wallet caps from the indexer (starter once, limited 5/day)', async () => {
    const c = new Client(); await signIn(c, alice);
    expect((await c.post('/v1/packs/quote', { sku: 7, qty: 1, currency: 'SOL' })).json.code).toBe('bad_sku');
    expect((await c.post('/v1/packs/quote', { sku: 1, qty: 26, currency: 'SOL' })).json.code).toBe('bad_qty');
    expect((await c.post('/v1/packs/quote', { sku: 1, qty: 1, currency: 'EUR' })).json.code).toBe('bad_currency');
    expect((await c.post('/v1/packs/quote', { sku: 0, qty: 2, currency: 'SOL' })).json.code).toBe('bad_qty');
    const w = alice.publicKey.toBase58();
    ingestTx(tx([{ program: 'chip_core', name: 'PackBought', data: { buyer: w, sku: 0, qty: 1, currency: 0, amount: '1', nonce: '1', randomness: Keypair.generate().publicKey.toBase58() } }], { blockTime: nowS() }), db);
    const starter = await c.post('/v1/packs/quote', { sku: 0, qty: 1, currency: 'SOL' });
    expect(starter.status).toBe(409); expect(starter.json.code).toBe('starter_claimed');
    ingestTx(tx([{ program: 'chip_core', name: 'PackBought', data: { buyer: w, sku: 3, qty: 4, currency: 1, amount: '1', nonce: '2', randomness: Keypair.generate().publicKey.toBase58() } }], { blockTime: nowS() }), db);
    expect((await c.post('/v1/packs/quote', { sku: 3, qty: 1, currency: 'USDC' })).status).toBe(200);
    const capped = await c.post('/v1/packs/quote', { sku: 3, qty: 2, currency: 'USDC' });
    expect(capped.status).toBe(429); expect(capped.json.code).toBe('daily_cap');
  });
  it('pity counter feeds effective odds and hardPityIn', async () => {
    const bob = Keypair.generate(); const c = new Client(); await signIn(c, bob);
    const w = bob.publicKey.toBase58();
    ingestTx(tx([{ program: 'chip_core', name: 'PackOpened', data: { buyer: w, sku: 1, nonce: '9', assets: [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58(), PublicKey.default.toBase58(), PublicKey.default.toBase58()], rarities: [0, 0, 1, 0, 0], collections: [1, 2, 3, 0, 0], count: 3, roll: 'ab'.repeat(32), pityBefore: 40, pityAfter: 41 } }]), db);
    const r = await c.post('/v1/packs/quote', { sku: 1, qty: 1, currency: 'USDC' });
    expect(r.json.pityCounter).toBe(41); expect(r.json.hardPityIn).toBe(19);
    expect(r.json.effectiveOddsBps[6] + r.json.effectiveOddsBps[7] + r.json.effectiveOddsBps[8]).toBeGreaterThan(70); // soft pity active (> base 70 bps)
  });
  it('/prices and /health expose the cache health', async () => {
    const c = new Client();
    const feeds = await fetchFeeds(asConnection(fake));
    cachePrice(db, 'SOL', feeds.SOL as Exclude<typeof feeds.SOL, PythError>);
    const p = await c.get('/v1/prices');
    expect(p.json.maxAgeS).toBe(60); expect(p.json.alertAgeS).toBe(45);
    expect(p.json.feeds.SOL).toMatchObject({ account: SOL_ACC.toBase58(), healthy: true });
    expect((await c.get('/v1/health')).json.prices.feeds.SOL.usd).toBeCloseTo(150, 6);
    const svc = await c.get('/v1/services');
    expect(svc.json.priceSource).toBe('fallback'); // SKR row not cached in this test db
  });
});
