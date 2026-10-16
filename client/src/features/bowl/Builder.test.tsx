// @vitest-environment happy-dom
// Конструктор доски (docs/16 §4.2): что здесь держится.
//
//   1. доска открывается собранной — сток есть у каждого, дыр не бывает;
//   2. надеть можно только добытое: мок отвечает тем же 403, что и прод;
//   3. снятая часть возвращает слот к стоку, а не оставляет дыру;
//   4. экран честно говорит, чего не хватает в районе недели.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Keypair } from '@solana/web3.js';
import { boardDistrictOfWeek } from '@guttercaps/economy';
import { mockRequest, resetMockWorld } from '@/api/mock';
import { setMockMode } from '@/api/client';
import { useSessionStore } from '@/app/store/session';
import { COLLECTIONS } from '@/shared/lib/lore';
import Builder from './Builder';

const fakeKey = Keypair.generate().publicKey;
vi.mock('@solana/wallet-adapter-react', async () => {
  const actual = await vi.importActual<typeof import('@solana/wallet-adapter-react')>('@solana/wallet-adapter-react');
  return {
    ...actual,
    useWallet: () => ({ publicKey: fakeKey, connected: true, connecting: false, wallet: null, disconnect: async () => {} }),
    useConnection: () => ({ connection: {} }),
  };
});

interface BoardShape {
  deck: string; trucks: string; wheels: string; grip: string; bolts: string; sticker: string; set: number | null;
  owned: Array<{ part: string; qty: number; source: string }>;
  week: { district: number; part: string; claimed: boolean; missing: string[] };
  weekProgress: { have: number; total: number };
}
/** Мок-город: тот же договор, что у продакшена (GET/PUT /me/board). */
const boardGet = () => mockRequest('get', '/me/board', {}) as Promise<BoardShape>;
const boardPut = (slots: Array<{ slot: string; part: string | null }>) =>
  mockRequest('put', '/me/board', { body: { slots } }) as Promise<BoardShape>;

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/bowl/builder']}>
        <Routes>
          <Route path="/bowl/builder" element={<Builder />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeAll(() => {
  setMockMode(true);
  useSessionStore.setState({ status: 'authenticated', wallet: { address: fakeKey.toBase58() }, address: fakeKey.toBase58(), csrf: 'test' });
});
// Инвентарь частей — общее состояние мока, как состав команды: без сброса
// следующий тест начнёт с доски, которую собрал предыдущий.
afterEach(() => { cleanup(); resetMockWorld(); });

describe('Builder — конструктор доски (docs/16 §4.2)', () => {
  it('доска открывается собранной: шесть слотов и ни одной дыры', async () => {
    mount();
    await waitFor(() => expect(screen.getAllByText('Deck').length).toBeGreaterThan(0));
    for (const slot of ['Trucks', 'Wheels', 'Grip', 'Bolts', 'Sticker']) {
      expect(screen.getAllByText(slot).length).toBeGreaterThan(0);
    }
    // Собранного сета района на старте нет — его собирают игрой, а не покупкой.
    expect(screen.queryByText(/Set complete/)).toBeNull();
  });

  it('недобытую часть надеть нельзя: мок отвечает тем же 403, что и прод', async () => {
    await expect(boardPut([{ slot: 'deck', part: 'deck_d7' }]))
      .rejects.toMatchObject({ status: 403, code: 'part_not_owned' });
  });

  it('снятая часть возвращает сток, а не дыру', async () => {
    const before = await boardGet();
    expect(String(before.deck)).toMatch(/^deck_d\d+$/);         // мок надевает деку прошлой недели
    const after = await boardPut([{ slot: 'deck', part: null }]);
    expect(after.deck).toBe('deck_stock');
    // Добытое остаётся в инвентаре: косметика не сгорает от того, что её сняли.
    expect(after.owned.map((p) => p.part)).toContain(before.deck);
  });

  it('район недели считает, чего не хватает', async () => {
    const view = await boardGet();
    const total = Number(view.weekProgress.total);
    expect(total).toBe(4);
    expect(Number(view.weekProgress.have)).toBeLessThan(total);
    expect(view.week.missing.length).toBe(total - Number(view.weekProgress.have));
    // Район недели один на весь город и ходит по кругу.
    expect(view.week.district).toBe(boardDistrictOfWeek(Math.floor(Date.now() / 1000 / (7 * 86_400))));
  });

  it('собранную доску видно: деку прошлой недели экран показывает надетой', async () => {
    const prev = boardDistrictOfWeek(Math.floor(Date.now() / 1000 / (7 * 86_400)) - 1);
    mount();
    await waitFor(() => expect(screen.getAllByText('Deck').length).toBeGreaterThan(0));
    // Дека прошлой недели надета в моке, поэтому её район назван на экране.
    // Строка, а не точное совпадение: рядом с названием района в той же строке
    // стоит происхождение части («Rail Kings · Run»).
    expect(screen.getAllByText(new RegExp(COLLECTIONS[prev].name)).length).toBeGreaterThan(0);
  });

  it('выбор детали: тап по слоту открывает витрину, тап по добытой детали надевает её', async () => {
    const prev = boardDistrictOfWeek(Math.floor(Date.now() / 1000 / (7 * 86_400)) - 1);
    mount();
    await waitFor(() => expect(screen.getAllByText('Deck').length).toBeGreaterThan(0));

    // Витрина слота открывается по кнопке «Bolt on» у строки деки.
    const rowButtons = screen.getAllByRole('button', { name: 'Bolt on' });
    fireEvent.click(rowButtons[0]);
    await waitFor(() => expect(screen.getByText(/What goes on/)).toBeTruthy());

    // В витрине есть и добытая дека (район прошлой недели), и закрытые части.
    const owned = screen.getAllByText(COLLECTIONS[prev].name);
    const worn = owned.find((el) => el.closest('button')?.className.includes('is-worn'));
    expect(worn).toBeTruthy();

    // Тап по добытой детали закрывает витрину: доска пересобрана.
    fireEvent.click(worn!.closest('button')!);
    await waitFor(() => expect(screen.queryByText(/What goes on/)).toBeNull());
  });
});
