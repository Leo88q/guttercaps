// @vitest-environment happy-dom
// Экспозиция крышек (docs/16 §4.3): крышку ставят тапом, и она остаётся твоей.
// Тест держит ровно это: тап по слоту → тап по крышке → крышка на доске; второй
// тап снимает её, а коллекция от этого не уменьшается.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Keypair } from '@solana/web3.js';
import { setMockMode } from '@/api/client';
import { useSessionStore } from '@/app/store/session';
import Rig, { PublicRig } from './Rig';

const fakeKey = Keypair.generate().publicKey;
vi.mock('@solana/wallet-adapter-react', async () => {
  const actual = await vi.importActual<typeof import('@solana/wallet-adapter-react')>('@solana/wallet-adapter-react');
  return {
    ...actual,
    useWallet: () => ({ publicKey: fakeKey, connected: true, connecting: false, wallet: null, disconnect: async () => {} }),
    useConnection: () => ({ connection: {} }),
  };
});

function mount(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/bowl/rig" element={<Rig />} />
          <Route path="/rig/:wallet" element={<PublicRig />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeAll(() => {
  setMockMode(true);
  useSessionStore.setState({ status: 'authenticated', wallet: { address: fakeKey.toBase58() }, address: fakeKey.toBase58(), csrf: 'test' });
});
afterEach(cleanup);

describe('Rig — экспозиция крышек', () => {
  it('показывает доску и ставит крышку тапом', async () => {
    mount('/bowl/rig');
    // Слоты появляются только после ответа /rig: «33 of 72» не совпадёт с
    // состоянием до загрузки (там было бы «0 of 72»).
    const deck = await waitFor(() => screen.getByRole('button', { name: 'Slot 1' }));
    expect(screen.getByText(/[1-9]\d* of 72 caps collected/)).toBeTruthy();
    fireEvent.click(deck);
    const dialog = await waitFor(() => screen.getByRole('dialog'));
    const pick = within(dialog).getAllByRole('button')[0]!;
    fireEvent.click(pick);

    // Крышка в слоте: подпись редкости лежит рядом с артом.
    await waitFor(() => expect(within(screen.getByRole('button', { name: 'Slot 1' })).getByText(/Common|Uncommon|Rare|Epic|Legend|Diamond/)).toBeTruthy());
  });

  it('снимает крышку тапом, и коллекция от этого не уменьшается', async () => {
    mount('/bowl/rig');
    const grip = await waitFor(() => screen.getByRole('button', { name: 'Slot 2' }));
    const collected = screen.getByText(/caps collected/).textContent;
    expect(grip).toBeTruthy();

    fireEvent.click(grip);
    const dialog = await waitFor(() => screen.getByRole('dialog'));
    fireEvent.click(within(dialog).getAllByRole('button')[0]!);
    await waitFor(() => expect(within(screen.getByRole('button', { name: 'Slot 2' })).getByText(/Common|Uncommon|Rare|Epic|Legend|Diamond/)).toBeTruthy());

    // Снимаем: крышка уходит со слота, но остаётся в коллекции.
    fireEvent.click(screen.getByRole('button', { name: 'Slot 2' }));
    const dlg = await waitFor(() => screen.getByRole('dialog'));
    fireEvent.click(within(dlg).getByRole('button', { name: 'Take the cap off' }));
    await waitFor(() => expect(within(screen.getByRole('button', { name: 'Slot 2' })).getByText('Empty')).toBeTruthy());
    expect(screen.getByText(/caps collected/).textContent).toBe(collected);
  });

  it('чужая витрина открывается без кошелька', async () => {
    mount('/rig/9xQeWvG816bUx9EPuMEcuBHKcYtBzUwXcWmXfRPHmLLc');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Slot 1' })).toBeTruthy());
    // Чужая доска только на просмотр: тап по слоту ничего не открывает.
    fireEvent.click(screen.getByRole('button', { name: 'Slot 1' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
