// Регрессия находки 11: запрос к backend после отправки, но до подтверждения.
//
// Клиент после `wallet.sendTransaction` сразу звал backend, который читает транзакцию на
// `confirmed`/`finalized`. Если RPC ещё не видел подпись, вызов возвращал ошибку уже ПОСЛЕ фактической
// отправки: деньги ушли, заказ остался `created`, а поток не умел ни дождаться подтверждения, ни
// повторить с той же подписью.
//
// Теперь: `waitForSignature` дожидается видимости (ничего не отправляя), `confirmWithRetry` повторяет
// только транзиентные отказы с ТОЙ ЖЕ подписью, а сама подпись запоминается в localStorage, чтобы её
// можно было дослать после перезагрузки (`rememberedPayment`/`forgetPayment`).
import { describe, expect, it } from 'vitest';
import {
  confirmWithRetry, forgetPayment, forgetPendingOrder, isTransientConfirmError, rememberedPayment,
  rememberedPendingOrder, rememberPayment, rememberPendingOrder, shouldResumePending,
  waitForSignature, type PendingOrder, type SignatureStore,
} from './phaseG';

const noSleep = async () => {};

function statusConn(seq: ({ confirmationStatus?: string; err: unknown } | null)[], onAsk?: () => void) {
  let i = 0;
  return {
    async getSignatureStatuses() {
      onAsk?.();
      return { value: [seq[Math.min(i++, seq.length - 1)]] };
    },
  } as unknown as Parameters<typeof waitForSignature>[0];
}

describe('находка 11: ожидание и идемпотентное подтверждение', () => {
  it('waits until the chain sees the signature, without sending anything', async () => {
    let asked = 0;
    const conn = statusConn([null, null, { confirmationStatus: 'confirmed', err: null }], () => { asked++; });
    expect(await waitForSignature(conn, 'SIG', { sleep: noSleep })).toBe('confirmed');
    expect(asked).toBe(3);
  });

  it('reports a failed transaction instead of confirming it', async () => {
    const conn = statusConn([{ confirmationStatus: 'confirmed', err: { InstructionError: [0, 'Custom'] } }]);
    expect(await waitForSignature(conn, 'SIG', { sleep: noSleep })).toBe('failed');
  });

  it('a timeout is "unknown", not an error: the backend still verifies the payment itself', async () => {
    const conn = statusConn([null]);
    expect(await waitForSignature(conn, 'SIG', { tries: 3, sleep: noSleep })).toBe('unknown');
  });

  it('retries the confirm with the SAME signature on tx_not_found / 5xx, never with a new one', async () => {
    const calls: string[] = [];
    const confirm = async (sig: string) => {
      calls.push(sig);
      if (calls.length < 3) throw Object.assign(new Error('tx_not_found'), { status: 404, code: 'tx_not_found' });
      return { status: 'paid' };
    };
    const r = await confirmWithRetry(confirm, 'SIG_SENT', { sleep: noSleep });
    expect(r).toEqual({ status: 'paid' });
    expect(calls).toEqual(['SIG_SENT', 'SIG_SENT', 'SIG_SENT']);
  });

  it('retries a 503 as well', async () => {
    const calls: string[] = [];
    const confirm = async (sig: string) => {
      calls.push(sig);
      if (calls.length === 1) throw Object.assign(new Error('burn check unavailable'), { status: 503, code: 'burn_check_unavailable' });
      return 'ok';
    };
    expect(await confirmWithRetry(confirm, 'S', { sleep: noSleep })).toBe('ok');
    expect(calls).toHaveLength(2);
  });

  it('a real payment rejection stops immediately (no retry loop over a wrong amount)', async () => {
    let calls = 0;
    const confirm = async () => {
      calls++;
      throw Object.assign(new Error('Payment check failed: amount_low'), { status: 422, code: 'payment_amount_low' });
    };
    await expect(confirmWithRetry(confirm, 'SIG', { sleep: noSleep })).rejects.toThrow(/amount_low/);
    expect(calls).toBe(1);
    expect(isTransientConfirmError({ status: 422, code: 'payment_amount_low' })).toBe(false);
    expect(isTransientConfirmError({ code: 'tx_not_found' })).toBe(true);
  });

  it('remembers the sent signature so an interrupted purchase can be finished later', () => {
    const mem = new Map<string, string>();
    const store: SignatureStore = {
      getItem: (k) => mem.get(k) ?? null,
      setItem: (k, v) => { mem.set(k, v); },
      removeItem: (k) => { mem.delete(k); },
    };
    expect(rememberedPayment(store, 7)).toBeNull();
    rememberPayment(store, 7, 'SIG7');
    expect(rememberedPayment(store, 7)).toBe('SIG7');
    forgetPayment(store, 7);
    expect(rememberedPayment(store, 7)).toBeNull();
    // среда без хранилища (SSR, приватный режим) не ломает покупку
    expect(() => rememberPayment(null, 1, 'X')).not.toThrow();
    expect(rememberedPayment(null, 1)).toBeNull();
  });

  // Без записи о заказе подпись бесполезна: после перезагрузки неизвестно, к какому заказу она относится
  // и каким эндпоинтом подтверждать (у Phase V — settle-confirm). Раньше `resumePayment` не вызывал никто.
  const memStore = (): SignatureStore & { mem: Map<string, string> } => {
    const mem = new Map<string, string>();
    return {
      mem,
      getItem: (k) => mem.get(k) ?? null,
      setItem: (k, v) => { mem.set(k, v); },
      removeItem: (k) => { mem.delete(k); },
    };
  };

  it('remembers which order the saved signature belongs to, and that it came from phase V', () => {
    const store = memStore();
    expect(rememberedPendingOrder(store)).toBeNull();
    rememberPendingOrder(store, { orderId: 42, sku: 3, phase: 'v' });
    rememberPayment(store, 42, 'SIG42');
    expect(rememberedPendingOrder(store)).toEqual({ orderId: 42, sku: 3, phase: 'v' });
    // обе половины восстановления согласованы: id из записи находит свою подпись
    expect(rememberedPayment(store, rememberedPendingOrder(store)!.orderId)).toBe('SIG42');
    forgetPendingOrder(store);
    expect(rememberedPendingOrder(store)).toBeNull();
    expect(rememberedPayment(store, 42)).toBe('SIG42'); // подпись живёт своей парой ключей
  });

  it('ignores a corrupted or foreign record instead of resuming a random order', () => {
    for (const raw of ['not json', '{}', '{"orderId":0,"sku":1,"phase":"g"}', '{"orderId":7,"sku":-1,"phase":"g"}',
      '{"orderId":7,"sku":1,"phase":"x"}', '{"orderId":"7","sku":1,"phase":"g"}', 'null', '[]']) {
      const store = memStore();
      store.setItem('gc:pendingOrder', raw);
      expect(rememberedPendingOrder(store), raw).toBeNull();
    }
  });

  it('resumes only the same SKU and only from a calm stage (no fight with a live purchase)', () => {
    const rec: PendingOrder = { orderId: 9, sku: 2, phase: 'g' };
    expect(shouldResumePending(rec, 2, 'idle', true)).toBe(true);
    expect(shouldResumePending(rec, 2, 'error', true)).toBe(true);
    expect(shouldResumePending(rec, 1, 'idle', true)).toBe(false);   // чужая модалка
    expect(shouldResumePending(rec, 2, 'paying', true)).toBe(false); // идёт новая покупка
    expect(shouldResumePending(rec, 2, 'done', true)).toBe(false);
    expect(shouldResumePending(rec, 2, 'idle', false)).toBe(false);  // подписи нет — восстанавливать нечего
    expect(shouldResumePending(null, 2, 'idle', true)).toBe(false);
  });
});
