// Reproducer: with LAUNCH_PHASE=v the phase-G pack-order routes are NOT closed.
// server.ts:625 defines `phaseG = () => { if (LAUNCH_PHASE === 'full') throw 410 }` — so only the
// default phase is refused, although the comment (server.ts:622) and docs/MINIMAL-LAUNCH-CHECKLIST
// say these routes live *only* when LAUNCH_PHASE=g. Under 'v' the same closure guards
// POST /packs/order/:id/confirm (a plain treasury payment → status 'paid'), while the phase-V mint
// path can only settle an order that has an on-chain buy_pack escrow (phasev.ts:206-211), and the
// phase-G mint crank is inert unless LAUNCH_PHASE=g (crank.ts:997-998).
// /packs/mint-journal is the cheapest unauthenticated probe of that same closure.
import { describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { Keypair } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import { base58Encode } from '../src/base58.ts';

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
    if (setCookie) this.cookie = setCookie.split(';')[0]!;
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) as { code?: string; csrf?: string } : undefined };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b?: unknown) => this.req('POST', p, b);
}

async function signIn(c: Client, kp: Keypair) {
  const address = kp.publicKey.toBase58();
  const { json: n } = await c.post('/v1/auth/siws/nonce', { address });
  const nonce = (n as unknown as { nonce: string; statement: string }).nonce;
  const statement = (n as unknown as { nonce: string; statement: string }).statement;
  const message = `localhost wants you to sign in with your Solana account:\n${address}\n\n${statement}\n\nURI: http://localhost\nVersion: 1\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
  const sig = ed25519.sign(new TextEncoder().encode(message), kp.secretKey.slice(0, 32));
  const r = await c.post('/v1/auth/siws/verify', { address, message, signature: base58Encode(sig) });
  if (r.status === 200) c.csrf = r.json!.csrf!;
  return r;
}

// Treasury нужен, чтобы POST /packs/order дошёл до создания заказа, а не упал на «некуда платить».
// Переменная читается при импорте `config.ts`, поэтому её надо задать до первого `appWith`.
process.env.TREASURY_WALLET = Keypair.generate().publicKey.toBase58();

async function appWith(phase: 'full' | 'g' | 'v') {
  process.env.LAUNCH_PHASE = phase;
  const { Db } = await import('../src/db.ts');
  const { createApp } = await import('../src/server.ts');
  const db = new Db(':memory:');
  const app = createApp(db, { arenaSweepMs: 0 });
  const server: Server = await new Promise((f) => { const s = app.listen(0, '127.0.0.1', () => f(s)); });
  const { port } = server.address() as { port: number };
  return { server, base: `http://127.0.0.1:${port}` };
}

describe('phase gate of the phase-G order routes', () => {
  it('under LAUNCH_PHASE=v the phase-G routes still answer (they should be 410, like under full)', async () => {
    const { server, base } = await appWith('v');
    try {
      const journal = await fetch(base + '/v1/packs/mint-journal');
      const body = await journal.json() as { code?: string };
      console.log(JSON.stringify({ phaseAtBoot: 'v', mintJournalStatus: journal.status, code: body.code }));
      // documented behaviour: "Nothing here runs while LAUNCH_PHASE=full (routes answer 410)" + "only live when g"
      expect(journal.status).toBe(410);
      expect(body.code).toBe('phase_g_off');
    } finally {
      await new Promise<void>((f) => server.close(() => f()));
    }
  });

  it('the phase-G payment confirm is live under v too (its only phase guard is the same closure)', async () => {
    const { server, base } = await appWith('v');
    try {
      const c = new Client(base);
      const signed = await signIn(c, Keypair.generate());
      expect(signed.status).toBe(200);
      // phaseG() would answer 410 phase_g_off if it only allowed LAUNCH_PHASE=g; instead the handler
      // reaches its own validation, i.e. the old "pay the treasury with a memo, we mark it paid" path
      // is open while the phase-V mint needs an on-chain buy_pack escrow (phasev.ts:206-211).
      const confirm = await c.post('/v1/packs/order/1/confirm', { signature: 'short' });
      console.log(JSON.stringify({ phaseAtBoot: 'v', confirmStatus: confirm.status, code: confirm.json?.code }));
      expect(confirm.status).toBe(410);
      expect(confirm.json?.code).toBe('phase_g_off');
    } finally {
      await new Promise<void>((f) => server.close(() => f()));
    }
  });

  it('under v an order can still be created and read — the phase-V buy starts here', async () => {
    // Первая версия гейта (п. 52) закрывала под 'v' весь блок pack-orders, включая создание заказа.
    // Phase-V покупка начинается с `POST /packs/order` (id, коммит seed, specs) и опрашивает
    // `GET /packs/order/:id`, поэтому такой гейт делал фазу V неиграбельной: клиент получал 410 ещё
    // до `buy_pack`. Проверяем, что creation/read открыты, а off-chain подтверждение — нет.
    const { server, base } = await appWith('v');
    try {
      const c = new Client(base);
      expect((await signIn(c, Keypair.generate())).status).toBe(200);
      const created = await c.post('/v1/packs/order', { sku: 1, qty: 1, currency: 'SOL' });
      console.log(JSON.stringify({ phaseAtBoot: 'v', createStatus: created.status, code: created.json?.code }));
      expect(created.status).toBe(200);
      const orderId = (created.json as unknown as { orderId: number }).orderId;
      expect(orderId).toBeGreaterThan(0);
      const read = await c.get(`/v1/packs/order/${orderId}`);
      expect(read.status).toBe(200);
      expect((read.json as unknown as { status: string }).status).toBe('created');
    } finally {
      await new Promise<void>((f) => server.close(() => f()));
    }
  });
});
