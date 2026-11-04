// Регрессия находки 27: восстановление Phase-V покупки, прерванной между эскроу и settle_pack.
//
// В Phase V оплата — две транзакции: `buy_pack` (эскроу на цепи) и `settle_pack` (минт, по авторизации
// `settle-auth`). Между ними есть окно: RPC может ещё не видеть эскроу, когда клиент просит авторизацию
// (`not_paid_onchain`), или игрок просто закрывает страницу. Подписи `settle_pack` в этот момент НЕТ,
// поэтому восстановление «по подписи оплаты» не срабатывало: заказ оставался `created` при уже
// оплаченном эскроу, а повторная покупка создавала новый заказ (и новую оплату).
//
// Теперь подпись эскроу запоминается до ожидания и позволяет дослать вторую половину без новой оплаты.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  forgetEscrow, forgetPayment, forgetPendingOrder, rememberedEscrow, rememberedPayment, rememberedPendingOrder,
  rememberEscrow, rememberPayment, rememberPendingOrder, shouldResumePending, type SignatureStore,
} from '../shop/phaseG';

const memStore = (): SignatureStore & { mem: Map<string, string> } => {
  const mem = new Map<string, string>();
  return {
    mem,
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => { mem.set(k, v); },
    removeItem: (k) => { mem.delete(k); },
  };
};

// Тесты идут из `client/`, файлы — от корня репозитория (как в src/chain/errors.test.ts).
const root = path.resolve(process.cwd(), process.cwd().endsWith('/client') ? '..' : '.');
const src = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

describe('находка 27: Phase-V покупка восстанавливается по подписи эскроу', () => {
  it('подпись эскроу живёт отдельно от подписи settle и переживает отказ', () => {
    const store = memStore();
    expect(rememberedEscrow(store, 5)).toBeNull();
    rememberEscrow(store, 5, 'ESCROW5');
    expect(rememberedEscrow(store, 5)).toBe('ESCROW5');
    // settle-подписи ещё нет: именно этот случай раньше не восстанавливался
    expect(rememberedPayment(store, 5)).toBeNull();
    rememberPayment(store, 5, 'SETTLE5');
    expect(rememberedEscrow(store, 5)).toBe('ESCROW5'); // ключи не перетирают друг друга
    forgetEscrow(store, 5);
    expect(rememberedEscrow(store, 5)).toBeNull();
    expect(rememberedPayment(store, 5)).toBe('SETTLE5');
    forgetPayment(store, 5);
    expect(rememberedPayment(store, 5)).toBeNull();
    // среда без хранилища не ломает покупку
    expect(() => rememberEscrow(null, 1, 'X')).not.toThrow();
    expect(rememberedEscrow(null, 1)).toBeNull();
    forgetEscrow(null, 1);
  });

  it('модалка подхватывает заказ, у которого есть только эскроу', () => {
    const store = memStore();
    rememberPendingOrder(store, { orderId: 9, sku: 2, phase: 'v' });
    rememberEscrow(store, 9, 'ESCROW9');
    const record = rememberedPendingOrder(store);
    const hasSignature = record ? rememberedPayment(store, record.orderId) !== null || rememberedEscrow(store, record.orderId) !== null : false;
    expect(hasSignature).toBe(true);
    expect(shouldResumePending(record, 2, 'idle', hasSignature)).toBe(true);
    forgetPendingOrder(store);
  });

  it('проводка на месте: эскроу запоминается до ожидания, а восстановление досылает вторую половину', () => {
    const flow = src('client/src/features/shop/usePhaseGOrder.ts');
    // запись ДО ожидания видимости: иначе отказ RPC оставляет заказ без единого следа об оплате
    const rememberAt = flow.indexOf('rememberEscrow(storage(), orderId, escrowSig)');
    const waitAt = flow.indexOf('await waitForSignature(connection, escrowSig)');
    expect(rememberAt).toBeGreaterThan(0);
    expect(waitAt).toBeGreaterThan(rememberAt);
    // успешный settle снимает запись: иначе модалка досылала бы завершённый заказ снова и снова
    expect(flow).toContain('forgetEscrow(storage(), orderId);');
    // ветка восстановления: без settle-подписи, но с эскроу — settle-auth → settle_pack → settle-confirm
    expect(flow).toMatch(/if \(!signature && escrow\)/);
    expect(flow).toContain(`api.post('/packs/order/{id}/settle-auth', undefined, { path: { id } })`);
    expect(flow).toContain('rememberPayment(storage(), id, settleSig);');
    expect(flow).toContain('forgetEscrow(storage(), id);');
    // и модалка считает эскроу достаточным поводом для автоподхвата
    const modal = src('client/src/features/shop/PhaseGBuyModal.tsx');
    expect(modal).toContain('rememberedEscrow(store, record.orderId) !== null');
  });
});
