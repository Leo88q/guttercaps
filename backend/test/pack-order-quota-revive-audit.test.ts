// Reproducer (находка 32): позднее подтверждение `expired` заказа обходило лимит Starter.
//
// `createOrder` считает лимиты по живым заказам (`created|paid|minted`), а `expireOrders` снимает
// заказ с учёта. Связка «создать Starter → дать истечь → создать второй Starter → оплатить ОБА»
// проходила: `confirmOrder` принимал `expired` заказ (это правильно — иначе деньги покупателя
// застревают), но лимит уже не перепроверял, поэтому у кошелька оказывалось два Starter.
//
// Политика после правки: платёж не отклоняется никогда (деньги реальные), но если к моменту
// подтверждения лимит занят другим заказом, заказ встаёт в очередь возврата (`refund_due`) с
// причиной, а возврат делает оператор и подтверждает подписью перевода из казны.
import { beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { Db } from '../src/db.ts';
import * as orders from '../src/pack-orders.ts';
import type { ParsedPaymentTx } from '../src/preorders.ts';
import { PACK_ORDER_TTL_S } from '../src/config.ts';

const TREASURY = Keypair.generate().publicKey.toBase58();
const WALLET = Keypair.generate().publicKey.toBase58();
const T0 = 1_800_000_000;

let db: Db;
beforeEach(() => { db = new Db(':memory:'); });

const mk = (sku: number, qty = 1, t = T0) =>
  orders.createOrder(db, WALLET, { sku, qty, currency: 'SOL' }, t, { treasury: TREASURY, seedHex: 'ab'.repeat(32) });

const payTx = (o: { payTo: string; amount: string; orderId: number }): ParsedPaymentTx => ({
  ok: true,
  transfers: [{ index: 0, instrument: 'sol', source: WALLET, destination: o.payTo, lamports: BigInt(o.amount) }],
  memos: [`GC-ORD|${o.orderId}`],
});

const sig = (tag: string) => `${tag}`.padEnd(40, 'x');

describe('находка 32: лимит кошелька не обходится поздней оплатой', () => {
  it('два Starter одного кошелька: второй оплаченный заказ уходит в возврат, а не в минт', async () => {
    const first = mk(0);
    // TTL истёк: заказ #1 больше не держит слот, поэтому создание второго Starter разрешено
    const afterTtl = T0 + PACK_ORDER_TTL_S + 1;
    const second = mk(0, 1, afterTtl);
    expect(second.orderId).toBeGreaterThan(first.orderId);

    // оба платежа настоящие и приходят после истечения
    const late = afterTtl + 3600;
    const v2 = await orders.confirmOrder(db, WALLET, second.orderId, sig('pay2'), async () => payTx(second), late);
    expect(v2.status).toBe('paid');

    const v1 = await orders.confirmOrder(db, WALLET, first.orderId, sig('pay1'), async () => payTx(first), late);
    console.log(JSON.stringify({ finding: 32, first: v1.status, second: v2.status, reason: v1.refundReason }));
    expect(v1.status).toBe('refund_due');
    expect(v1.refundReason).toBe('starter_claimed');

    // ровно один Starter доставляется
    const deliverable = db.scalar(`SELECT COUNT(*) FROM pack_orders WHERE wallet = ? AND sku = 0 AND status = 'paid'`, WALLET);
    expect(deliverable).toBe(1);
    // деньги не потеряны: платёж записан на заказе возврата
    expect(db.get<{ tx_sig: string }>(`SELECT tx_sig FROM pack_orders WHERE id = ?`, first.orderId)?.tx_sig).toBe(sig('pay1'));
  });

  it('дневной cap тоже перепроверяется на позднем подтверждении', async () => {
    const a = mk(3, 5); // limited pack: dailyCap = 5
    const afterTtl = T0 + PACK_ORDER_TTL_S + 1;
    const b = mk(3, 5, afterTtl);
    const late = afterTtl + 60;
    const vb = await orders.confirmOrder(db, WALLET, b.orderId, sig('cap-b'), async () => payTx(b), late);
    expect(vb.status).toBe('paid');
    const va = await orders.confirmOrder(db, WALLET, a.orderId, sig('cap-a'), async () => payTx(a), late);
    expect(va.status).toBe('refund_due');
    expect(va.refundReason).toBe('daily_cap');
  });

  it('очередь возврата видна оператору, а отметка требует подписи перевода', async () => {
    const a = mk(0);
    const afterTtl = T0 + PACK_ORDER_TTL_S + 1;
    const b = mk(0, 1, afterTtl);
    const late = afterTtl + 60;
    await orders.confirmOrder(db, WALLET, b.orderId, sig('q-b'), async () => payTx(b), late);
    await orders.confirmOrder(db, WALLET, a.orderId, sig('q-a'), async () => payTx(a), late);

    const queue = orders.refundQueue(db);
    expect(queue.map((o) => o.orderId)).toEqual([a.orderId]);
    expect(queue[0]!.amount).toBe(a.amount);

    // без подписи возврат не отмечается: доказательства перевода нет
    expect(() => orders.markRefunded(db, a.orderId, 'short')).toThrow(/signature is required/);
    const done = orders.markRefunded(db, a.orderId, sig('refund-signature'), late + 10);
    expect(done.status).toBe('refunded');
    expect(done.refundSig).toBe(sig('refund-signature'));
    expect(done.refundedAt).toBe(late + 10);
    expect(orders.refundQueue(db)).toEqual([]);
    // повторная отметка идемпотентна, а «нечего возвращать» — явная ошибка
    expect(orders.markRefunded(db, a.orderId, sig('refund-signature'), late + 20).status).toBe('refunded');
    expect(() => orders.markRefunded(db, b.orderId, sig('refund-signature'))).toThrow(/not awaiting a refund/);
  });

  it('обычный один заказ по-прежнему возрождается без всякой очереди возврата', async () => {
    const only = mk(1);
    const v = await orders.confirmOrder(db, WALLET, only.orderId, sig('solo'), async () => payTx(only), T0 + PACK_ORDER_TTL_S + 5);
    expect(v.status).toBe('paid');
    expect(v.refundReason).toBeNull();
    expect(orders.refundQueue(db)).toEqual([]);
  });
});
