// Регрессия находки 46 (backend-половина): аварийный возврат залипшей покупки не был виден игроку.
//
// `GET /me/pending` отдавал заглушки: `currentSlot: 0` и `staleAt: null` для КАЖДОЙ покупки. Из-за этого
// клиент физически не мог понять, что `cancel_stale_pack` уже разрешён цепью (контракт требует
// `clock.slot > commit_slot + STALE_PACK_SLOTS`, chip_core::randomness::assert_refundable), и кнопки
// возврата не было ни в одном экране: деньги оставались в эскроу навсегда, если оракул не раскрыл
// случайность. Второй половины не хватало и оператору: /health не показывал, сколько покупок залипло.
//
// Здесь проверяется честный контракт: `currentSlot` — голова индексатора, `status: 'stale'` и
// `refundSlot` появляются ровно на границе контракта, `currency` едет вместе с покупкой (для токенной
// оплаты клиенту нужен минт), а /health считает залипшие покупки.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import type { Server } from 'node:http';
import { STALE_PACK_SLOTS } from '@guttercaps/economy';
import { Db } from '../src/db.ts';
import { createApp, pendingHeadSlot, stalePendingPacks } from '../src/server.ts';
import { base58Encode } from '../src/base58.ts';

const alice = Keypair.generate();
const A = alice.publicKey.toBase58();
const HEAD = 5_000_000;
let db: Db;
let server: Server;
let base = '';

class Client {
  cookie = ''; csrf = '';
  constructor(private readonly url: string) {}
  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(this.url + path, {
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

beforeAll(async () => {
  db = new Db(':memory:');
  db.run(`INSERT INTO wallets (address, first_seen) VALUES (?, ?)`, A, 1000);
  // голова индексатора: именно она (а не часы процесса) решает, разрешён ли возврат
  db.run(`INSERT INTO indexer_cursor (program, newest_signature, newest_slot, history_complete, updated_at) VALUES ('chip_core', 'sig', ?, 1, 1000)`, HEAD);
  const insert = (nonce: string, slot: number, currency: number) => db.run(
    `INSERT INTO pack_purchases (buyer, nonce, sku, qty, currency, amount, randomness, signature, slot, block_time, opened, status)
     VALUES (?, ?, 1, 3, ?, '1990000', 'Rnd1111111111111111111111111111111111111111', 'sig', ?, ?, 0, 'pending')`,
    A, nonce, currency, slot, 1_799_000_000,
  );
  insert('11', HEAD - 10, 0);                       // свежая: возврат ещё запрещён
  insert('12', HEAD - STALE_PACK_SLOTS - 1, 1);     // залипла: граница пройдена (USDC)
  insert('13', HEAD - STALE_PACK_SLOTS, 2);         // ровно на границе: `>` в контракте строгий — пока нельзя
  const app = createApp(db, { arenaSweepMs: 0 });
  await new Promise<void>((f) => { server = app.listen(0, '127.0.0.1', () => f()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((f) => { server.close(() => f()); }));

describe('находка 46: /me/pending отдаёт настоящую границу возврата', () => {
  it('залипшая покупка помечена stale и несёт всё, что нужно для cancel_stale_pack', async () => {
    const c = new Client(base);
    expect((await signIn(c, alice)).status).toBe(200);
    const r = await c.get('/v1/me/pending');
    expect(r.status).toBe(200);
    const packs = r.json.packs as { nonce: string; status: string; currentSlot: number; refundSlot: number; staleAt: string; currency: string }[];
    const byNonce = new Map(packs.map((p) => [p.nonce, p]));
    // голова индексатора — не 0 (раньше здесь всегда был 0)
    expect(packs.every((p) => p.currentSlot === HEAD)).toBe(true);
    const stale = byNonce.get('12')!;
    expect(stale.status).toBe('stale');
    expect(stale.refundSlot).toBe(HEAD - STALE_PACK_SLOTS - 1 + STALE_PACK_SLOTS);
    expect(stale.currency).toBe('USDC');  // минт нужен клиенту, чтобы собрать возврат SPL-оплаты
    expect(Date.parse(stale.staleAt)).toBeGreaterThan(0);
    // свежая и ровно-на-границе покупки возвращать ещё нельзя
    expect(byNonce.get('11')!.status).toBe('awaiting_reveal');
    expect(byNonce.get('13')!.status).toBe('awaiting_reveal');
  });

  it('/health считает залипшие покупки, а SQL-хелперы согласованы с контрактом', async () => {
    expect(pendingHeadSlot(db)).toBe(HEAD);
    expect(stalePendingPacks(db)).toBe(1);
    // граница строгая: ровно на `commit + STALE_PACK_SLOTS` контракт ещё откажет
    expect(stalePendingPacks(db, HEAD - 1)).toBe(0);
    const c = new Client(base);
    const h = await c.get('/v1/health');
    expect(h.json.stalePacks).toBe(1);
  });
});
