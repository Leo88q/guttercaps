// Reproducer (находка 30): два параллельных `POST /packs/order/:id/settle-auth` подписывали РАЗНЫЕ
// наборы спецификаций одного заказа. Каждый запрос читал строку без `settle_specs`, ждал RPC, затем
// независимо выделял game indices и безусловно записывал свой набор. Исполнить на цепи можно любую из
// двух подписей, а регистрация ищет в DAS имена из последнего набора — заказ оплачен, выдача не сходится.
//
// Исправлено: право выдать specs забирает один писатель (CAS по пустой колонке `settle_specs`),
// проигравший получает 409 `settle_auth_busy` и повторяет запрос уже с сохранённым набором. Ниже —
// синхронизированный mock RPC, который держит оба запроса на ожидании эскроу, чтобы гонка была
// воспроизводимой.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { Db } from '../src/db.ts';
import * as orders from '../src/pack-orders.ts';

let pv: typeof import('../src/phasev.ts');
beforeAll(async () => {
  vi.resetModules();
  process.env.SHARED_MERKLE_TREE = Keypair.generate().publicKey.toBase58();
  pv = await import('../src/phasev.ts');
});

const T0 = 1_800_000_000;
const TREASURY = Keypair.generate().publicKey.toBase58();
const BUYER = Keypair.generate();

/** Эскроу-аккаунт формы `PackOrder`, который «находит» RPC; оба вызова ждут барьер. */
function barrierConn(orderId: number, amount: string, expectCalls = 2) {
  const acct = Buffer.alloc(8 + 59);
  BUYER.publicKey.toBuffer().copy(acct, 8);
  acct.writeBigUInt64LE(BigInt(orderId), 40);
  acct[48] = 0;
  acct.writeBigUInt64LE(BigInt(amount), 49);
  acct[57] = 0;
  let arrived = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  return {
    getAccountInfo: async () => {
      arrived++;
      if (arrived >= expectCalls) release();
      await gate; // оба запроса прошли проверку эскроу до того, как кто-то записал specs
      return { owner: pv.SETTLE_PROGRAM, data: acct };
    },
    getSlot: async () => 2000,
  } as never;
}

describe('settle-auth × concurrent requests', () => {
  it('one order gets exactly one spec set, however many requests race for it', async () => {
    const db = new Db(':memory:');
    const oracle = Keypair.generate();
    const o = orders.createOrder(db, BUYER.publicKey.toBase58(), { sku: 1, qty: 1, currency: 'SOL' }, T0, { treasury: TREASURY, seedHex: 'ef'.repeat(32) });
    const conn = barrierConn(o.orderId, o.amount);

    const results = await Promise.allSettled([
      pv.settleAuthForOrder(db, BUYER.publicKey.toBase58(), o.orderId, { connection: conn, oracle }),
      pv.settleAuthForOrder(db, BUYER.publicKey.toBase58(), o.orderId, { connection: conn, oracle }),
    ]);

    // Оба запроса могут завершиться успехом — и это правильно: победитель выдал набор, проигравший
    // подписал ТОТ ЖЕ набор из БД. Недопустимо ровно одно: две разные подписи на один заказ.
    const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof pv.settleAuthForOrder>>> => r.status === 'fulfilled');
    expect(ok.length).toBeGreaterThan(0);
    const hashes = new Set(ok.map((r) => r.value.auth.specsHash));
    expect(hashes.size).toBe(1);

    const stored = JSON.parse(db.get<{ settle_specs: string }>(`SELECT settle_specs FROM pack_orders WHERE id = ?`, o.orderId)!.settle_specs) as { name: string }[];
    expect(stored).toHaveLength(5);
    // подписанный набор — это ровно сохранённый набор (имена = ключ регистрации в DAS)
    for (const r of ok) expect(r.value.specs.map((s) => s.name)).toEqual(stored.map((s) => s.name));

    // пока набор выдаёт другой писатель, третий запрос не подписывает ничего своего
    db.run(`UPDATE pack_orders SET settle_specs = ? WHERE id = ?`, '\u0000reserved', o.orderId);
    await expect(pv.settleAuthForOrder(db, BUYER.publicKey.toBase58(), o.orderId, { connection: conn, oracle }))
      .rejects.toThrow(/being issued right now/);
  });
});
