// @vitest-environment happy-dom
// Стена района: слот занимается игрой, а не деньгами. Тест проверяет то, что
// видит игрок на телефоне: свободная стена → «занять слот» → слот занят и
// помечен своим. Всё — тапами, ни одного нажатия клавиши.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Keypair } from '@solana/web3.js';
import { api, setMockMode } from '@/api/client';
import { useSessionStore } from '@/app/store/session';
import Wall from './Wall';

const fakeKey = Keypair.generate().publicKey;
vi.mock('@solana/wallet-adapter-react', async () => {
  const actual = await vi.importActual<typeof import('@solana/wallet-adapter-react')>('@solana/wallet-adapter-react');
  return {
    ...actual,
    useWallet: () => ({ publicKey: fakeKey, connected: true, connecting: false, wallet: null, disconnect: async () => {} }),
    useConnection: () => ({ connection: {} }),
    ConnectionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    WalletProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

function mount(path = '/bowl/wall/0') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/bowl/wall/:district" element={<Wall />} />
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

describe('Wall — стена района', () => {
  it('показывает пустую стену, занимает слот и помечает его своим', async () => {
    await api.post('/tags', { svg: '<svg><path d="M10 10L40 40" stroke="#FF2E8A" stroke-width="8" fill="none"/></svg>' });
    mount();
    // «0 of 200» совпадает и с состоянием до загрузки, поэтому ждём правдоподобной
    // метрики — она появляется только когда ответ уже пришёл.
    // Ждём выбора тега: он появляется только когда answer /me/tags уже пришёл.
    await waitFor(() => expect(screen.getByText(/Choose your tag/)).toBeTruthy());
    expect(screen.getByText(/0 of 200 slots taken/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Claim a slot' }));
    await waitFor(() => expect(screen.getByText(/1 of 200 slots taken/)).toBeTruthy());
    expect(screen.getByText(/Your slot: #0/)).toBeTruthy();
  });

  it('открывает слот тапом и даёт снять свой тег', async () => {
    await api.post('/tags', { svg: '<svg><path d="M20 20L60 60" stroke="#FF2E8A" stroke-width="8" fill="none"/></svg>' });
    mount('/bowl/wall/1');
    await waitFor(() => expect(screen.getByText(/Choose your tag/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Claim a slot' }));
    await waitFor(() => expect(screen.getByText(/1 of 200 slots taken/)).toBeTruthy());

    // тап по занятому слоту: карточка слота с действиями
    fireEvent.click(screen.getByRole('button', { name: /Slot 0, taken/ }));
    await waitFor(() => expect(screen.getByText(/Slot #0/)).toBeTruthy());
    // «Снять» есть и в шапке, и в карточке слота — берём то, что внутри диалога
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Take down' }));
    await waitFor(() => expect(screen.getByText(/0 of 200 slots taken/)).toBeTruthy());
  });

  it('в открытом слоте тег показывается инлайном и чистится перед вставкой', async () => {
    // SVG тега приходит через API-слой (GET /tags/{id}), а не fetch на
    // /v1/.../svg: в демо-режиме тот fetch уходил мимо мока в выключенный
    // бэкенд и стена показывала битую картинку. Санитизация при инлайне
    // покрыта TagTimeLapse.test.ts, здесь — что рисунок реально доезжает
    // до слота и открывается инлайном.
    await api.post('/tags', { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 512" width="1024" height="512"><path d="M10 10L200 120" stroke="#FF2E8A" stroke-width="8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>' });
    mount('/bowl/wall/2');
    await waitFor(() => expect(screen.getByText(/Choose your tag/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Claim a slot' }));
    await waitFor(() => expect(screen.getByText(/1 of 200 slots taken/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Slot 0, taken/ }));
    await waitFor(() => expect(screen.getByText(/Slot #0/)).toBeTruthy());

    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect(dialog.querySelector('span.tag-timelapse svg path')).not.toBeNull());
    const path = dialog.querySelector('span.tag-timelapse svg path') as SVGPathElement;
    expect(path.getAttribute('d')).toBe('M10 10L200 120');
    expect(path.getAttribute('stroke')).toBe('#FF2E8A');
    expect(dialog.innerHTML).not.toContain('script');
    // битой картинки-запасника больше нет: ни в просмотре, ни в самом слоте
    expect(dialog.querySelector('img.wall-preview')).toBeNull();
    expect(document.querySelector('img.wall-tag')).toBeNull();
    await waitFor(() => expect(document.querySelector('span.tag-thumb svg path')).not.toBeNull());
  });
});
