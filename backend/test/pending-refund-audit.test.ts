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
import { battleRefundState, createApp, pendingBattles, pendingHeadSlot, stalePendingBattles, stalePendingPacks } from '../src/server.ts';
import { base58Encode } from '../src/base58.ts';

const alice = Keypair.generate();
const A = alice.publicKey.toBase58();
const HEAD = 5_000_000;
const NOW = Math.floor(Date.now() / 1000);
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
  // Бои (находка 46, четвёртая половина): вернуть ставку может только подпись стороны, поэтому граница
  // возврата обязана быть видна в API — и считаться по тем же правилам, что в programs/arena/src/lib.rs.
  const bob = Keypair.generate().publicKey.toBase58();
  const battle = (key: string, status: string, over: { challenger?: string; opponent?: string | null; accepted?: number | null } = {}) => db.run(
    `INSERT INTO battles (battle, challenger, opponent, wager, power_a, power_b, randomness, status, created_sig, created_at, accepted_at, accepted_sig, slot)
     VALUES (?, ?, ?, '1000000', 10, 12, 'Rnd1111111111111111111111111111111111111111', ?, 'sig', ?, ?, 'acceptsig', 1)`,
    key, over.challenger ?? A, over.opponent === undefined ? bob : over.opponent, status, NOW - 3_600, over.accepted === undefined ? NOW - 3_600 : over.accepted,
  );
  battle('OpenBattle', 'open', { opponent: null });          // создатель может снять сразу
  battle('StuckBattle', 'accepted', { accepted: NOW - 31 * 60 });   // 30 мин прошли — возврат открыт обеим сторонам
  battle('FreshBattle', 'accepted', { accepted: NOW - 60 });        // принят минуту назад — цепь ответит NotStale
  battle('NoTimeBattle', 'accepted', { accepted: null });           // время принятия неизвестно — утверждать нельзя
  battle('DoneBattle', 'resolved', { accepted: NOW - 7_200 });      // закрыт: возвращать нечего
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

  it('бои: возврат ставки виден по границам cancel_stale_battle, а не по «прошло время»', async () => {
    const c = new Client(base);
    expect((await signIn(c, alice)).status).toBe(200);
    const r = await c.get('/v1/me/pending');
    const battles = r.json.battles as { battle: string; status: string; refundable: boolean; reason: string; refundAt: string | null; opponent: string | null }[];
    const byKey = new Map(battles.map((b) => [b.battle, b]));
    // закрытый бой в списке не появляется вовсе
    expect(byKey.has('DoneBattle')).toBe(false);
    // создатель открытого боя снимает его сразу — цепь разрешает `caller == challenger` вне таймаута
    expect(byKey.get('OpenBattle')).toMatchObject({ refundable: true, reason: 'creator' });
    // принятый бой: обе стороны после accepted_at + 30 мин (+ запас на расхождение часов)
    expect(byKey.get('StuckBattle')).toMatchObject({ refundable: true, reason: 'timeout' });
    // свежий принятый бой: окно ещё закрыто, но время открытия названо — по нему UI ждёт
    const fresh = byKey.get('FreshBattle')!;
    expect(fresh.refundable).toBe(false);
    expect(Date.parse(fresh.refundAt!)).toBeGreaterThan(Date.now() + 20 * 60_000);
    // время принятия неизвестно: кнопку не показываем, heal доберёт метку из events_raw
    expect(byKey.get('NoTimeBattle')).toMatchObject({ refundable: false, reason: 'unknown_time' });
    // чужие бои в список не попадают
    const outsider = pendingBattles(db, Keypair.generate().publicKey.toBase58(), NOW);
    expect(outsider).toHaveLength(0);
    // граница строгая и с запасом: за секунду до неё цепь ещё откажет
    const stuck = { battle: 'x', challenger: A, opponent: 'y', wager: '1', status: 'accepted', power_a: 1, power_b: 1, created_at: 0, accepted_at: NOW };
    expect(battleRefundState(stuck, A, NOW + 1_800).refundable).toBe(false);
    expect(battleRefundState(stuck, A, NOW + 1_861).refundable).toBe(true);
  });

  it('/health считает залипшие покупки, а SQL-хелперы согласованы с контрактом', async () => {
    expect(pendingHeadSlot(db)).toBe(HEAD);
    expect(stalePendingPacks(db)).toBe(1);
    // граница строгая: ровно на `commit + STALE_PACK_SLOTS` контракт ещё откажет
    expect(stalePendingPacks(db, HEAD - 1)).toBe(0);
    const c = new Client(base);
    const h = await c.get('/v1/health');
    expect(h.json.stalePacks).toBe(1);
    // залипшие бои: открытый (создатель) + принятый за таймаутом; свежий и без времени не считаются
    expect(h.json.arena.staleBattles).toBe(2);
    expect(stalePendingBattles(db)).toBe(2);
    expect(stalePendingBattles(db, NOW - 600)).toBe(1);
  });
});
