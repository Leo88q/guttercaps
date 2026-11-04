// Reproducer (находка 23): предзаказ не принимал окончательную оплату после истечения резерва.
//
// `confirmPayment` сначала переводил устаревший intent в `expired` (`expireIntents`), а затем принимал
// только `intent`. Транзакция, отправленная до истечения, но финализированная позже, отклонялась —
// деньги оставались в мультисиге казны без обязательства перед покупателем, и восстановить связь
// «этот перевод — этот резерв» постфактум нечем.
//
// Политика после правки (как у pack-заказов): платёж не отклоняется никогда, но и выдать лишнее
// нельзя. Истёкший резерв не держит квоту, поэтому перед возрождением проверяется остаток: если паки
// уже разобрали, строка встаёт в очередь возврата (`refund_due`), а возврат отмечает оператор
// подписью перевода из мультисига (`refunded`).
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Db } from '../src/db.ts';
import * as p from '../src/preorders.ts';
import { kp } from './fixtures.ts';

const TREASURY = kp();
const T = 1_750_000_000;
const TTL = 3600;

let db: Db;
beforeEach(() => {
  vi.stubEnv('PREORDER_ACTIVE', 'true');
  vi.stubEnv('PREORDER_TREASURY', TREASURY);
  vi.stubEnv('PREORDER_PRICE_LAMPORTS', '1000000000');
  vi.stubEnv('PREORDER_TOTAL', '2');
  vi.stubEnv('PREORDER_MAX_PER_WALLET', '2');
  vi.stubEnv('PREORDER_MAX_QTY', '2');
  vi.stubEnv('PREORDER_INTENT_TTL_S', String(TTL));
  db = new Db(':memory:');
});
afterEach(() => { vi.unstubAllEnvs(); });

const transfer = (source: string, destination: string, lamports: bigint, index = 0) =>
  ({ index, instrument: 'sol' as const, source, destination, lamports });
const paidTx = (wallet: string, lamports: bigint): p.ParsedPaymentTx => ({
  ok: true, transfers: [transfer(wallet, TREASURY, lamports)], memos: [],
});

describe('находка 23: поздняя оплата предзаказа', () => {
  it('платёж, финализированный после истечения резерва, принимается и выдаётся', async () => {
    const wallet = kp();
    const intent = p.createIntent(db, wallet, 1, T);
    const late = T + TTL + 600;
    const row = await p.confirmPayment(db, wallet, intent.refId, 'SIG-LATE', async () => paidTx(wallet, 1_000_000_000n), late);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ finding: 23, status: row.status, reason: row.refund_reason ?? null }));
    expect(row.status).toBe('paid');
    expect(row.tx_sig).toBe('SIG-LATE');
    // резерв снова держит квоту: остаток уменьшился, а не остался прежним
    expect(p.remainingPacks(db, late)).toBe(1);
    expect(p.campaign(db, late).sold).toBe(1);
  });

  it('если квоту уже разобрали — оплата встаёт в очередь возврата, а не теряется', async () => {
    const wallet = kp();
    const other = kp();
    const stale = p.createIntent(db, wallet, 1, T);
    // пока резерв истекал, последний пакет забрал другой покупатель
    const afterTtl = T + TTL + 1;
    expect(p.remainingPacks(db, afterTtl)).toBe(2);
    const b = p.createIntent(db, other, 2, afterTtl);
    await p.confirmPayment(db, other, b.refId, 'SIG-B', async () => paidTx(other, 2_000_000_000n), afterTtl);
    expect(p.remainingPacks(db, afterTtl)).toBe(0);

    const row = await p.confirmPayment(db, wallet, stale.refId, 'SIG-A', async () => paidTx(wallet, 1_000_000_000n), afterTtl + 60);
    expect(row.status).toBe('refund_due');
    expect(row.refund_reason).toBe('sold_out');

    // очередь видна оператору; отметка требует подписи перевода и идемпотентна
    const queue = p.refundQueue(db);
    expect(queue.map((r) => r.ref_id)).toEqual([stale.refId]);
    expect(() => p.markRefunded(db, stale.refId, 'short')).toThrow(/signature is required/);
    const done = p.markRefunded(db, stale.refId, 'SIG'.padEnd(64, 'r'), afterTtl + 120);
    expect(done.status).toBe('refunded');
    expect(done.refund_sig).toBe('SIG'.padEnd(64, 'r'));
    expect(p.refundQueue(db)).toEqual([]);
    expect(() => p.markRefunded(db, b.refId, 'SIG'.padEnd(64, 'r'))).toThrow(/not awaiting a refund/);
    // деньги покупателя не потеряны: подпись платежа записана на строке возврата
    expect(db.get<{ tx_sig: string }>(`SELECT tx_sig FROM preorders WHERE ref_id = ?`, stale.refId)!.tx_sig).toBe('SIG-A');
  });

  it('просроченный резерв без платежа по-прежнему не становится оплаченным', async () => {
    const wallet = kp();
    const intent = p.createIntent(db, wallet, 1, T);
    expect(p.mine(db, wallet, T + TTL + 1)[0]!.status).toBe('expired');
    const err = await p.confirmPayment(db, wallet, intent.refId, 'SIG-NONE', async () => null, T + TTL + 10)
      .catch((e: { code?: string }) => e);
    expect((err as { code?: string }).code).toBe('tx_not_found');
    expect(db.get<{ status: string }>(`SELECT status FROM preorders WHERE ref_id = ?`, intent.refId)!.status).toBe('expired');
  });
});
