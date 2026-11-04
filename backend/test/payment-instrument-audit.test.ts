// Регрессии находок 17 и 18 (reports/INDEPENDENT-CODE-REVIEW-PROGRESS.md §17, §18).
//
// 17. Платёж в SOL принимался как платёж в SPL-токене. `parseRpcPayment` собирал system- и SPL-переводы
//     в один список без типа инструмента, а `checkPayment` проверял `!t.mint || t.mint === a.mint` —
//     отсутствие mint'а считалось доказательством совпадения. Синтетический перевод 1 000 000 lamports
//     на адрес USDC-ATA с нужным memo закрывал заказ на 1 000 000 micro-USDC.
// 18. Один перевод оплачивал разные заказы. Уникальность сигнатуры проверялась отдельно в `preorders`,
//     `pack_orders` и `phaseg_fusions`, поэтому транзакция с двумя memo и одним подходящим переводом
//     помечала `paid` сразу оба заказа.
//
// После исправления: инструмент платежа — часть разобранной транзакции (`instrument`), mint для SPL
// берётся из данных цепи (инструкция или postTokenBalances), а конкретный перевод расходуется в общем
// журнале `payment_transfer` по ключу (signature, transfer_index).
import { describe, expect, it, vi, afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import * as preorders from '../src/preorders.ts';
import * as orders from '../src/pack-orders.ts';
import { Db } from '../src/db.ts';
import { transferConsumer } from '../src/consumption.ts';

const TREASURY = Keypair.generate().publicKey.toBase58();

afterEach(() => { vi.unstubAllEnvs(); });

function freshDb(): Db {
  vi.stubEnv('PREORDER_TREASURY', TREASURY);
  vi.stubEnv('PACK_TREASURY', TREASURY);
  vi.stubEnv('PREORDER_INTENT_TTL_S', '3600');
  vi.stubEnv('PACK_ORDER_TTL_S', '900');
  return new Db(':memory:');
}

describe('находка 17: SOL-перевод не оплачивает заказ в SPL-токене', () => {
  it('a lamport transfer to the token ATA is not a token payment', () => {
    const dest = preorders.preorderPayTo(TREASURY, 'USDC');
    const wallet = Keypair.generate().publicKey.toBase58();
    // ровно то, что раньше проходило: system transfer на адрес ATA с memo и «правильной» суммой
    const spoof = {
      ok: true,
      transfers: [{ index: 0, instrument: 'sol' as const, source: wallet, destination: dest.payTo, lamports: 1_000_000n }],
      memos: ['GC-PRE|7'],
    };
    const r = preorders.checkPayment(spoof, { treasury: dest.payTo, lamports: '1000000', wallet, memo: 'GC-PRE|7', mint: dest.mint });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ finding: 17, instrument: 'sol', expectedMint: dest.mint, result: r }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe('wrong_instrument');
  });

  it('a token transfer of another mint is not a payment either', () => {
    const dest = preorders.preorderPayTo(TREASURY, 'USDC');
    const wallet = Keypair.generate().publicKey.toBase58();
    const otherMint = Keypair.generate().publicKey.toBase58();
    const r = preorders.checkPayment({
      ok: true,
      transfers: [{ index: 0, instrument: 'spl', source: wallet, destination: dest.payTo, lamports: 1_000_000n, mint: otherMint }],
      memos: ['GC-PRE|7'],
    }, { treasury: dest.payTo, lamports: '1000000', wallet, memo: 'GC-PRE|7', mint: dest.mint });
    expect(r).toMatchObject({ ok: false, code: 'wrong_instrument' });
  });

  it('a token transfer without a provable mint does not confirm an SPL order (fail closed)', () => {
    const dest = preorders.preorderPayTo(TREASURY, 'USDC');
    const wallet = Keypair.generate().publicKey.toBase58();
    const r = preorders.checkPayment({
      ok: true,
      transfers: [{ index: 0, instrument: 'spl', source: wallet, destination: dest.payTo, lamports: 1_000_000n }],
      memos: ['GC-PRE|7'],
    }, { treasury: dest.payTo, lamports: '1000000', wallet, memo: 'GC-PRE|7', mint: dest.mint });
    expect(r.ok).toBe(false);
    // при этом сам SPL-перевод в нужном токене по-прежнему проходит
    expect(preorders.checkPayment({
      ok: true,
      transfers: [{ index: 0, instrument: 'spl', source: wallet, destination: dest.payTo, lamports: 1_000_000n, mint: dest.mint }],
      memos: ['GC-PRE|7'],
    }, { treasury: dest.payTo, lamports: '1000000', wallet, memo: 'GC-PRE|7', mint: dest.mint })).toEqual({ ok: true, code: 'ok', transferIndexes: [0] });
  });

  it('the mint of a legacy spl-token transfer is read from the transaction balances', () => {
    const dest = preorders.preorderPayTo(TREASURY, 'USDC');
    const wallet = Keypair.generate().publicKey.toBase58();
    // `spl-token: transfer` (без transferChecked) не несёт mint в parsed-инструкции — берём из цепи
    const rpc = {
      meta: {
        err: null,
        postTokenBalances: [{ accountIndex: 1, mint: dest.mint, owner: TREASURY }],
      },
      transaction: { message: {
        accountKeys: [{ pubkey: wallet, signer: true }, { pubkey: dest.payTo }],
        instructions: [
          { program: 'spl-token', parsed: { type: 'transfer', info: { source: 'SRC_ATA', destination: dest.payTo, amount: '1000000' } } },
          { program: 'spl-memo', parsed: 'GC-PRE|7' },
        ],
      } },
    };
    const tx = preorders.parseRpcPayment(rpc)!;
    expect(tx.transfers[0]).toMatchObject({ instrument: 'spl', mint: dest.mint });
    expect(preorders.checkPayment(tx, { treasury: dest.payTo, lamports: '1000000', wallet, memo: 'GC-PRE|7', mint: dest.mint }).ok).toBe(true);
  });

  it('a SOL order is not closed by a token transfer of the same number', () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const r = preorders.checkPayment({
      ok: true,
      transfers: [{ index: 0, instrument: 'spl', source: wallet, destination: TREASURY, lamports: 2_000_000_000n, mint: Keypair.generate().publicKey.toBase58() }],
      memos: ['GC-PRE|7'],
    }, { treasury: TREASURY, lamports: '2000000000', wallet, memo: 'GC-PRE|7' });
    expect(r).toMatchObject({ ok: false, code: 'wrong_instrument' });
  });
});

describe('находка 18: один перевод не оплачивает два заказа', () => {
  it('the same transfer cannot credit a preorder and a pack order', async () => {
    const db = freshDb();
    const wallet = Keypair.generate().publicKey.toBase58();
    const sig = 'S'.repeat(44);

    const pre = preorders.createIntent(db, wallet, 1, 1_800_000_000);
    const ord = orders.createOrder(db, wallet, { sku: 1, qty: 1, currency: 'SOL' }, 1_800_000_000, { treasury: TREASURY, seedHex: 'aa'.repeat(32) });
    // Одна транзакция: один перевод в казну на сумму, покрывающую оба заказа, и оба memo.
    const amount = BigInt(pre.lamports) > BigInt(ord.amount) ? BigInt(pre.lamports) : BigInt(ord.amount);
    const tx = {
      ok: true,
      transfers: [{ index: 0, instrument: 'sol' as const, source: wallet, destination: TREASURY, lamports: amount }],
      memos: [pre.memo, ord.memo],
    };
    const fetchPayment = async () => tx;

    const first = await preorders.confirmPayment(db, wallet, pre.refId, sig, fetchPayment, 1_800_000_100);
    expect(first.status).toBe('paid');
    await expect(orders.confirmOrder(db, wallet, ord.orderId, sig, fetchPayment, 1_800_000_100))
      .rejects.toThrow(/already credited/);

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      finding: 18,
      preorderStatus: db.get<{ status: string }>(`SELECT status FROM preorders WHERE ref_id = ?`, pre.refId)?.status,
      packOrderStatus: db.get<{ status: string }>(`SELECT status FROM pack_orders WHERE id = ?`, ord.orderId)?.status,
      transferConsumedBy: transferConsumer(db, sig, 0),
    }));
    expect(db.get<{ status: string }>(`SELECT status FROM pack_orders WHERE id = ?`, ord.orderId)?.status).toBe('created');
    expect(transferConsumer(db, sig, 0)).toBe(`preorder:${pre.refId}`);
  });

  it('two different transfers of one transaction may pay two orders', async () => {
    const db = freshDb();
    const wallet = Keypair.generate().publicKey.toBase58();
    const sig = 'T'.repeat(44);
    const pre = preorders.createIntent(db, wallet, 1, 1_800_000_000);
    const ord = orders.createOrder(db, wallet, { sku: 1, qty: 1, currency: 'SOL' }, 1_800_000_000, { treasury: TREASURY, seedHex: 'bb'.repeat(32) });
    const tx = {
      ok: true,
      transfers: [
        { index: 0, instrument: 'sol' as const, source: wallet, destination: TREASURY, lamports: BigInt(pre.lamports) },
        { index: 1, instrument: 'sol' as const, source: wallet, destination: TREASURY, lamports: BigInt(ord.amount) },
      ],
      memos: [pre.memo, ord.memo],
    };
    const fetchPayment = async () => tx;
    await preorders.confirmPayment(db, wallet, pre.refId, sig, fetchPayment, 1_800_000_100);
    const v = await orders.confirmOrder(db, wallet, ord.orderId, sig, fetchPayment, 1_800_000_100);
    expect(v.status).toBe('paid');
    expect(transferConsumer(db, sig, 0)).toBe(`preorder:${pre.refId}`);
    expect(transferConsumer(db, sig, 1)).toBe(`pack_order:${ord.orderId}`);
  });
});
