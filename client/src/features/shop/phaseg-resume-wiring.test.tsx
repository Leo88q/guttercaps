// @vitest-environment happy-dom
// Регрессия находки 11 (проводка): прерванная оплата Phase-G/V должна досылаться САМА при открытии
// модалки покупки того же пака. До этого `rememberPayment` писал подпись в localStorage, но записи о
// заказе не было и `resumePayment` не вызывал никто — после перезагрузки страницы оплаченный заказ
// оставался `created`, а деньги уже лежали в treasury.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Keypair } from '@solana/web3.js';

const calls: { method: 'get' | 'post'; path: string; id?: number; signature?: string }[] = [];

// Mock API: подтверждение сразу отвечает `paid`, опрос заказа — `minted`.
vi.mock('@/api/client', () => ({
  isMock: () => false,
  api: {
    post: async (path: string, body: { signature?: string } | undefined, opts: { path?: { id?: number } } = {}) => {
      calls.push({ method: 'post', path, id: opts.path?.id, signature: body?.signature });
      return { status: 'paid' };
    },
    get: async (path: string, opts: { path?: { id?: number } } = {}) => {
      calls.push({ method: 'get', path, id: opts.path?.id });
      return { status: 'minted', assets: [] };
    },
  },
}));

// Кошелёк не нужен: восстановление идёт по сохранённой подписи, транзакция не создаётся.
vi.mock('@solana/wallet-adapter-react', () => ({
  useConnection: () => ({ connection: { getSignatureStatuses: async () => ({ value: [null] }) } }),
  useWallet: () => ({ publicKey: Keypair.generate().publicKey, connected: true, sendTransaction: undefined }),
}));

import { PhaseGBuyModal } from './PhaseGBuyModal';
import { rememberPayment, rememberPendingOrder } from './phaseG';

const mount = (sku: number) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <PhaseGBuyModal sku={sku} packId="standard" onClose={() => {}} />
  </QueryClientProvider>,
);

beforeEach(() => {
  calls.length = 0;
  window.localStorage.clear();
});

describe('находка 11: модалка досылает прерванную оплату', () => {
  it('confirms the saved signature of the same pack with the settle endpoint for phase V', async () => {
    rememberPendingOrder(window.localStorage, { orderId: 41, sku: 2, phase: 'v' });
    rememberPayment(window.localStorage, 41, 'SIG41');
    mount(2);
    await waitFor(() => expect(calls.some((c) => c.method === 'post')).toBe(true));
    const post = calls.find((c) => c.method === 'post')!;
    expect(post.path).toBe('/packs/order/{id}/settle-confirm');
    expect(post.id).toBe(41);
    expect(post.signature).toBe('SIG41'); // та же подпись, никакой новой транзакции
    // после подтверждения заказ опрашивается до `minted`
    await waitFor(() => expect(calls.some((c) => c.method === 'get' && c.id === 41)).toBe(true));
    // и запись снимается, чтобы не всплывать снова
    await waitFor(() => expect(window.localStorage.getItem('gc:pendingOrder')).toBeNull());
    cleanup();
  });

  it('uses the direct-transfer endpoint for a phase-G order', async () => {
    rememberPendingOrder(window.localStorage, { orderId: 42, sku: 2, phase: 'g' });
    rememberPayment(window.localStorage, 42, 'SIG42');
    mount(2);
    await waitFor(() => expect(calls.some((c) => c.method === 'post')).toBe(true));
    expect(calls.find((c) => c.method === 'post')!.path).toBe('/packs/order/{id}/confirm');
    cleanup();
  });

  it('does not resume another pack\'s order, and does nothing without a saved signature', async () => {
    rememberPendingOrder(window.localStorage, { orderId: 43, sku: 3, phase: 'g' });
    rememberPayment(window.localStorage, 43, 'SIG43');
    mount(2); // открыт другой пак
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([]);
    cleanup();

    // запись есть, подписи нет — восстановление невозможно, и выдумывать транзакцию нельзя
    rememberPendingOrder(window.localStorage, { orderId: 44, sku: 2, phase: 'g' });
    mount(2);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([]);
    cleanup();
  });
});
