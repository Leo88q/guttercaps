// Шер крышки из инспектора (docs/16 §2.2).
//
// Вызов существует ради метрики: «доля шеринга и регистрации из переходов».
// Проверяем три вещи — событие пишется, ссылка несёт тот же ref-параметр, что
// и реферальная программа, и чужой/несуществующий ассет не проходит.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import type { Server } from 'node:http';
import { Db } from '../src/db.ts';
import { createApp } from '../src/server.ts';
import { base58Encode } from '../src/base58.ts';

let db: Db;
let server: Server;
let base: string;

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

const ASSET = Keypair.generate().publicKey.toBase58();

beforeAll(async () => {
  db = new Db(':memory:');
  db.run(`INSERT INTO chips (asset, owner, collection_idx, rarity, level, flags, lock_until, origin, updated_slot) VALUES (?, ?, 0, 3, 1, 0, 0, 'pack', 1)`,
    ASSET, Keypair.generate().publicKey.toBase58());
  const app = createApp(db, { arenaSweepMs: 0 });
  await new Promise<void>((f) => { server = app.listen(0, '127.0.0.1', () => f()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((f) => server.close(() => f())));

describe('POST /v1/chips/{asset}/share', () => {
  it('пишет событие шера и отдаёт ссылку с реф-параметром', async () => {
    const c = new Client(base);
    const me = Keypair.generate();
    await signIn(c, me);
    const r = await c.post(`/v1/chips/${ASSET}/share`);
    expect(r.status).toBe(200);
    expect(r.json.path).toBe(`/chip/${ASSET}?ref=${me.publicKey.toBase58()}`);
    const rows = db.all<{ feature: string; kind: string; wallet: string; meta: string }>(`SELECT feature, kind, wallet, meta FROM feature_events`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ feature: 'inspect', kind: 'share', wallet: me.publicKey.toBase58() });
    expect(JSON.parse(rows[0].meta)).toEqual({ asset: ASSET });
  });

  it('не существует без сессии и не светит чужой ассет', async () => {
    const anon = new Client(base);
    expect((await anon.post(`/v1/chips/${ASSET}/share`)).status).toBe(401);
    const c = new Client(base);
    await signIn(c, Keypair.generate());
    expect((await c.post('/v1/chips/NotAnAssetAtAll/share')).status).toBe(404);
  });
});
