// Phase-G purchase state machine: create order (seed already committed) →
// wallet pays treasury+memo → backend confirms → poll until the mint crank
// lands the chips. In mock mode the wallet step is skipped: the mock API
// simulates confirm + mint so the UX is reviewable offline.
import { useCallback, useRef, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey, Transaction } from '@solana/web3.js';
import { useQueryClient } from '@tanstack/react-query';
import { api, isMock } from '@/api/client';
import {
  browserStore, buildPaymentInstructions, confirmWithRetry, forgetPayment, forgetPendingOrder,
  rememberedPayment, rememberedPendingOrder, rememberPayment, rememberPendingOrder,
  waitForOrderMinted, waitForSignature, type PackOrder, type PhaseGCurrency, type PendingPhase,
} from './phaseG';
import { FLAGS } from '@/app/config';

export type PhaseGStage = 'idle' | 'creating' | 'paying' | 'confirming' | 'minting' | 'done' | 'error';

const storage = browserStore;


export function usePhaseGOrder() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const qc = useQueryClient();
  const [stage, setStage] = useState<PhaseGStage>('idle');
  const [order, setOrder] = useState<PackOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const buy = useCallback(async (sku: number, qty: number, currency: PhaseGCurrency): Promise<PackOrder | null> => {
    if (busy.current) return null;
    busy.current = true;
    setError(null);
    try {
      setStage('creating');
      const created = await api.post('/packs/order', { sku, qty, currency });
      const orderId = created.orderId ?? 0;
      // Находка 11: запись о заказе кладётся ДО отправки транзакции — иначе после перезагрузки страница
      // не знает, к какому заказу относится сохранённая подпись, и восстановить оплату нечем.
      const pendingPhase: PendingPhase = FLAGS.launchPhase === 'v' ? 'v' : 'g';
      if (!isMock()) rememberPendingOrder(storage(), { orderId, sku, phase: pendingPhase });
      if (!isMock() && FLAGS.launchPhase === 'v') {
        // Phase V: escrow on-chain, oracle authorizes, the player's own
        // settle transaction mints. No backend mint queue.
        if (!wallet.publicKey || !wallet.sendTransaction) throw new Error('Wallet is not connected');
        const me = wallet.publicKey;
        setStage('paying');
        // Phase V is opt-in at launch; keep its builders out of the critical bundle.
        const { buyPackIx, grantOrSettleIx } = await import('./phaseVFlow');
        const escrowTx = new Transaction().add(buyPackIx({
          buyer: me, orderId: BigInt(orderId), currency,
          amount: BigInt(created.amount ?? '0'),
          mint: created.mint ? new PublicKey(created.mint) : null,
        }));
        const escrowSig = await wallet.sendTransaction(escrowTx, connection);
        setStage('confirming');
        // §11: backend читает эскроу на `confirmed` — без ожидания первый же запрос уходил раньше, чем
        // RPC видел транзакцию, и поток рвался уже ПОСЛЕ оплаты.
        await waitForSignature(connection, escrowSig);
        const payload = await api.post('/packs/order/{id}/settle-auth', undefined, { path: { id: orderId } });
        const settleTx = new Transaction().add(...grantOrSettleIx(payload as unknown as import('./phaseV').SettlePayloadLike, {
          relayer: me,
          treasury: new PublicKey(created.payToOwner ?? ''),
          mint: created.mint ? new PublicKey(created.mint) : null,
        }));
        const settleSig = await wallet.sendTransaction(settleTx, connection);
        rememberPayment(storage(), orderId, settleSig);
        await waitForSignature(connection, settleSig);
        await confirmWithRetry(
          (signature) => api.post('/packs/order/{id}/settle-confirm', { signature }, { path: { id: orderId } }),
          settleSig,
        );
        forgetPayment(storage(), orderId);
        forgetPendingOrder(storage());
      } else if (!isMock()) {
        if (!wallet.publicKey || !wallet.sendTransaction) throw new Error('Wallet is not connected');
        setStage('paying');
        const tx = new Transaction().add(...buildPaymentInstructions(created, wallet.publicKey));
        // Подпись запоминается ДО ожидания: если страница закроется, оплату можно дослать тем же
        // signature (`resumePayment`), а не платить второй раз (находка 11).
        const signature = await wallet.sendTransaction(tx, connection);
        rememberPayment(storage(), orderId, signature);
        setStage('confirming');
        await waitForSignature(connection, signature);
        await confirmWithRetry(
          (sig) => api.post('/packs/order/{id}/confirm', { signature: sig }, { path: { id: orderId } }),
          signature,
        );
        forgetPayment(storage(), orderId);
        forgetPendingOrder(storage());
      } else {
        // mock backend simulates the payment + confirm in one step
        await api.post('/packs/order/{id}/confirm', { signature: 'mock-payment' }, { path: { id: orderId } });
      }
      setStage('minting');
      const final = await waitForOrderMinted(
        () => api.get('/packs/order/{id}', { path: { id: orderId } }),
      );
      setOrder(final);
      setStage(final.status === 'minted' ? 'done' : 'error');
      if (final.status !== 'minted') setError(`Order ${final.status}`);
      if (final.status === 'minted') {
        void qc.invalidateQueries({ queryKey: ['chips'] });
        void qc.invalidateQueries({ queryKey: ['collection'] });
        void qc.invalidateQueries({ queryKey: ['me'] });
      }
      return final;
    } catch (e) {
      setStage('error');
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      busy.current = false;
    }
  }, [connection, wallet, qc]);

  /**
   * Дослать оплату, отправленную в прошлой сессии: подпись сохранена локально, новая транзакция не
   * создаётся. Заказ берётся из сохранённой записи (id + фаза), поэтому Phase V подтверждается своим
   * эндпоинтом. Возвращает true, если заказ догнан (paid/minted).
   */
  const resumePayment = useCallback(async (orderId?: number): Promise<boolean> => {
    if (busy.current) return false;
    const record = rememberedPendingOrder(storage());
    const id = orderId ?? record?.orderId ?? null;
    const signature = id === null ? null : rememberedPayment(storage(), id);
    if (id === null || !signature) return false;
    const phase: PendingPhase = FLAGS.launchPhase === 'v' ? 'v' : 'g';
    busy.current = true;
    setError(null);
    try {
      setStage('confirming');
      // Запись помнит, как оформлялся заказ; без неё считаем по текущей фазе запуска.
      const effective = record && record.orderId === id ? record.phase : phase;
      await confirmWithRetry(
        (sig) => (effective === 'v'
          ? api.post('/packs/order/{id}/settle-confirm', { signature: sig }, { path: { id } })
          : api.post('/packs/order/{id}/confirm', { signature: sig }, { path: { id } })),
        signature,
      );
      forgetPayment(storage(), id);
      forgetPendingOrder(storage());
      setStage('minting');
      const final = await waitForOrderMinted(() => api.get('/packs/order/{id}', { path: { id } }));
      setOrder(final);
      setStage(final.status === 'minted' ? 'done' : 'error');
      if (final.status !== 'minted') setError(`Order ${final.status}`);
      return final.status === 'paid' || final.status === 'minted';
    } catch (e) {
      setStage('error');
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      busy.current = false;
    }
  }, []);

  const reset = useCallback(() => { setStage('idle'); setOrder(null); setError(null); }, []);
  return { stage, order, error, buy, reset, resumePayment };
}
