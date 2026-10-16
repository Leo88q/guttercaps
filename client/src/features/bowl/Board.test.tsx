// @vitest-environment happy-dom
// Доска недели (docs/16 §3.5).
//
// Проверяем то, что видит игрок: доска показывает теги со стен, тег на карточке
// рисуется, а правило «жеребьёвка, а не рейтинг» написано на самой витрине, а не
// спрятано в документации. Пустая стена — отдельная честная история, а не пустой
// экран: сказать «пока нечего показывать» лучше, чем молчать.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Keypair } from '@solana/web3.js';
import { api, setMockMode } from '@/api/client';
import { resetMockWorld } from '@/api/mock';
import { useSessionStore } from '@/app/store/session';
import Board from './Board';

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

const SVG = (d: string, color = '#FF2E8A') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 512"><path d="${d}" stroke="${color}" stroke-width="8" fill="none"/></svg>`;

/** Нарисовать тег и повесить его на стену района: доска считается из настоящих слотов. */
async function hang(district: number, svg: string) {
  const tag = (await api.post('/tags', { svg })) as { id?: string };
  // Номер района едет в ПУТИ (тип тела его не содержит): иначе мок получит
  // буквальный `{district}` и запишет слот в район NaN — витрина сошлётся в никуда.
  const slot = (await api.post('/wall/{district}/claim', { tagId: String(tag.id ?? '') }, { path: { district } })) as { slot?: number };
  return { tagId: String(tag.id ?? ''), slot: Number(slot.slot ?? 0) };
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/bowl/board']}>
        <Routes>
          <Route path="/bowl/board" element={<Board />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeAll(() => {
  setMockMode(true);
  useSessionStore.setState({ status: 'authenticated', wallet: { address: fakeKey.toBase58() }, address: fakeKey.toBase58(), csrf: 'test' });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); resetMockWorld(); });

describe('Board — доска недели', () => {
  it('показывает повешенные теги и говорит, что это жеребьёвка, а не рейтинг', async () => {
    const a = await hang(0, SVG('M10 10L200 120'));
    await hang(3, SVG('M20 20L300 300', '#16E5D9'));
    mount();
    await waitFor(() => expect(screen.getByText(/Board of the week/)).toBeTruthy());

    // правило видно сразу: доска не ранжирует, а жалоба — фильтр, а не минус
    expect(screen.getByText(/Drawn, not ranked/)).toBeTruthy();
    expect(screen.getByText(/An accusation is not a verdict/)).toBeTruthy();

    // обе карточки на месте и ведут на свои стены (слот у обоих первый — поэтому
    // проверяем район по ссылке, а не по номеру слота)
    await waitFor(() => expect(screen.getAllByText(new RegExp(`slot #${a.slot}`))).toHaveLength(2));
    const links = screen.getAllByRole('link', { name: /Go to the wall/ });
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/bowl/wall/0', '/bowl/wall/3']);
    // сид розыгрыша показан — доску можно пересчитать
    expect(screen.getByText(/sha256\(wall-board:v1/)).toBeTruthy();
    expect(screen.getByText(/tags took part/)).toBeTruthy();
  });

  it('тег на карточке рисуется инлайном, а не просто лежит картинкой', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 512" width="1024" height="512">'
        + '<path d="M10 10L200 120" stroke="#FF2E8A" stroke-width="8" fill="none"/></svg>',
    })));
    await hang(1, SVG('M30 30L400 400', '#B6FF3C'));
    mount();
    await waitFor(() => expect(screen.getByText(/Board of the week/)).toBeTruthy());
    await waitFor(() => expect(document.querySelector('.board-card span.tag-timelapse svg path')).not.toBeNull());
  });

  it('пустая стена даёт честную пустую доску, а не молчание', async () => {
    setMockMode(true);
    mount();
    await waitFor(() => expect(screen.getByText(/No board this week/)).toBeTruthy());
    expect(screen.getByRole('link', { name: /Go to the wall/ })).toBeTruthy();
  });
});
