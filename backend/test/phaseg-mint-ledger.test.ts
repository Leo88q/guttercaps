// Регрессия §1.1 пп. 8, 72: минт Phase-G больше не повторяется после неопределённого исхода и не
// сбивает нумерацию листьев.
//
// До правки `processPaidOrders` считал заказ опубликованным ровно настолько, насколько «не бросил»
// отправитель: подпись записывалась только в `pack_orders.assets` ПОСЛЕ минта. Падение процесса или
// таймаут подтверждения после того, как транзакция уже попала в блок, оставлял заказ 'paid' и лист
// занятым — следующий тик минтил тот же чип ещё раз по следующему листу (`chips` при этом доставался
// чужому листу). Здесь проверяется, что при включённом ledger'е (`deps.ledger`):
//   1. подпись известна ДО отправки и остаётся в `chain_ops` после падения процесса;
//   2. следующий тик не отправляет второй минт, а ждёт сверки (`ChainOpInFlight`);
//   3. после `reconcileChainOps` чип проецируется из payload'а операции без новой транзакции;
//   4. «подпись не найдена и блок прошёл» (`orphaned`) освобождает заказ для нового минта.
import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { Db } from '../src/db.ts';
import * as mint from '../src/bubblegum-mint.ts';
import * as orders from '../src/pack-orders.ts';
import { reconcileChainOps, submitChainOp } from '../src/chain-ops.ts';

const TREE = PublicKey.default;

function statuses(landed: boolean) {
  return {
    async getSignatureStatuses(sigs: string[]) {
      return { value: sigs.map(() => (landed ? { confirmationStatus: 'finalized', err: null } : null)) };
    },
    async getBlockHeight() { return 900; },
  };
}

/**
 * Отправитель, который пишет подпись в ledger ДО «отправки» и падает сразу после неё.
 * `leaf` — счётчик минтов в цепи (то, что отдаёт TreeConfig): он растёт, только если транзакция
 * действительно попала в блок, поэтому `landOnFail` различает «исполнилась, но ответ потерялся»
 * (п. 8) и «подпись не дошла» (orphaned).
 */
function flakySender(db: Db, state: { sends: string[]; fail: boolean; landOnFail: boolean; leaf: number }): mint.MintSender {
  return async (_order, chip, op) => {
    if (!op) throw new Error('ledger expected in this test');
    await submitChainOp(db, { kind: op.kind, bizKey: op.bizKey, payload: op.payload }, async (hooks) => {
      state.sends.push(chip.assetId);
      const signature = `SIG_${state.sends.length}`;
      hooks.beforeSend(signature, { rawTx: 'raw-tx', lastValidBlockHeight: 999 });
      if (!state.fail || state.landOnFail) state.leaf++;
      if (state.fail) throw new Error('confirm timed out — the transaction confirmed anyway');
      return { signature };
    });
  };
}

function paidOrder(db: Db) {
  const treasury = PublicKey.unique().toBase58();
  const wallet = PublicKey.unique().toBase58();
  const o = orders.createOrder(db, wallet, { sku: 0, qty: 1, currency: 'SOL' }, 1_800_000_000, { treasury, seedHex: 'cc'.repeat(32) });
  db.run(`UPDATE pack_orders SET status = 'paid', tx_sig = 'pay1' WHERE id = ?`, o.orderId);
  return { orderId: o.orderId, wallet };
}

const deps = (sendMint: mint.MintSender, state: { leaf: number }) => ({ sendMint, firstLeafIndex: async () => state.leaf, tree: TREE, ledger: true });

describe('ledger минтов Phase-G (§1.1 пп. 8, 72)', () => {
  it('a mint whose confirmation is lost is never sent twice and is re-projected after reconciliation', async () => {
    const db = new Db(':memory:');
    const { orderId } = paidOrder(db);
    const state = { sends: [] as string[], fail: true, landOnFail: true, leaf: 100 };

    const first = await mint.processPaidOrders(db, deps(flakySender(db, state), state));
    expect(first.mintedOrders).toBe(0);
    // Один и только один минт ушёл в сеть; подпись уже в ledger'е — значит лист занят навсегда.
    expect(state.sends).toHaveLength(1);
    const op = db.get<{ status: string; signature: string }>(`SELECT status, signature FROM chain_ops`);
    expect(op?.signature).toBe('SIG_1');
    expect(op?.status).toBe('sent');
    // Заказ по-прежнему 'paid': проекции нет, но и второй транзакции не будет.
    expect(db.get<{ status: string }>(`SELECT status FROM pack_orders WHERE id = ?`, orderId)?.status).toBe('paid');

    // Второй тик: судьба подписи неизвестна — отправлять нельзя.
    const second = await mint.processPaidOrders(db, deps(flakySender(db, { ...state, fail: false }), state));
    expect(second.mintedOrders).toBe(0);
    expect(state.sends).toHaveLength(1);

    // Сверка по цепи: подпись исполнена → операция подтверждена.
    const rec = await reconcileChainOps(db, statuses(true), { tip: 900 });
    expect(rec.confirmed).toBe(1);

    // Третий тик: первый чип проецируется из payload'а операции, остальные минтятся как обычно.
    const third = await mint.processPaidOrders(db, deps(flakySender(db, { ...state, fail: false }), state));
    expect(third.mintedOrders).toBe(1);
    const chips = db.all<{ asset: string }>(`SELECT asset FROM chips`);
    expect(chips.length).toBeGreaterThan(1);
    // Ни один лист не минтился дважды: отправок ровно столько же, сколько чипов.
    expect(state.sends).toHaveLength(chips.length);
    expect(new Set(state.sends).size).toBe(chips.length);
    const assets = JSON.parse(db.get<{ assets: string }>(`SELECT assets FROM pack_orders WHERE id = ?`, orderId)!.assets) as { assetId: string }[];
    expect(assets).toHaveLength(chips.length);
    for (const a of assets) expect(db.get(`SELECT 1 FROM chips WHERE asset = ?`, a.assetId)).toBeTruthy();
  });

  it('an expired signature releases the order for a fresh mint without losing the pack', async () => {
    const db = new Db(':memory:');
    const { orderId, wallet } = paidOrder(db);
    // лист тот же: транзакция в цепь не попала, TreeConfig не вырос
    const state = { sends: [] as string[], fail: true, landOnFail: false, leaf: 100 };
    await mint.processPaidOrders(db, deps(flakySender(db, state), state));
    expect(state.sends).toHaveLength(1);

    // Цепь не знает подписи, а блок уже прошёл last_valid_block_height → операция `orphaned`.
    const rec = await reconcileChainOps(db, statuses(false), { tip: 5_000 });
    expect(rec.orphaned).toBe(1);

    const again = await mint.processPaidOrders(db, deps(flakySender(db, { ...state, fail: false }), state));
    expect(again.mintedOrders).toBe(1);
    // Осиротевший чип минтится заново (лист тот же — цепь его не занимала), остальные — по разу.
    expect(state.sends.length).toBeGreaterThan(1);
    const chips = db.all<{ asset: string; owner: string }>(`SELECT asset, owner FROM chips`);
    expect(chips.every((c) => c.owner === wallet)).toBe(true);
    expect(chips).toHaveLength(state.sends.length - 1); // первый минт в цепь не попал
    expect(db.get<{ status: string }>(`SELECT status FROM pack_orders WHERE id = ?`, orderId)?.status).toBe('minted');
  });
});
