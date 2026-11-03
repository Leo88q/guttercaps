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
  confirmWithRetry, forgetPayment, isTransientConfirmError, rememberedPayment, rememberPayment,
  waitForSignature, type SignatureStore,
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
});
