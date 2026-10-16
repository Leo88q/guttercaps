// @vitest-environment happy-dom
// Модерация тегов в админке (docs/16 §3.3).
//
// Проверяем то, без чего экран бесполезен: просроченная жалоба видна как
// просроченная, причина жалобы названа человеческими словами, а решение
// модератора убирает тег из очереди. Порядок «сначала просроченные» — не
// украшение: при сортировке по числу жалоб тег с пятью свежими уезжал бы выше
// одного, который ждёт третьи суток.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Keypair } from '@solana/web3.js';
import { api, setMockMode } from '@/api/client';
import { resetMockWorld } from '@/api/mock';
import { useSessionStore } from '@/app/store/session';
import Admin from './Admin';

const fakeKey = Keypair.generate().publicKey;
const me = fakeKey.toBase58();
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

// Теги должны различаться по-настоящему: мок (как и бэкенд) не сохраняет один и
// тот же SVG от одного кошелька дважды, и второй вызов вернул бы первый тег.
const COLORS = ['#FF2E8A', '#16E5D9', '#B6FF3C'];
const svg = (n: number) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 512"><path d="M10 10L200 120" stroke="${COLORS[n % COLORS.length]}" stroke-width="8" fill="none"/></svg>`;

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/admin?tab=mod']}>
        <Routes>
          <Route path="/admin" element={<Admin />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeAll(() => {
  setMockMode(true);
  // Экран админки целиком спрятан за правами оператора: без сессии он покажет
  // только заголовок, и тест молча проверит пустоту.
  useSessionStore.setState({ status: 'authenticated', wallet: { address: me }, address: me, csrf: 'test' });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); resetMockWorld(); });

/** Тег с жалобой: мок считает SLA от времени подачи, поэтому двигаем часы. */
async function reportedTag(hoursAgo: number, reason: 'hate' | 'ads' | 'other' = 'hate', n = 0) {
  // теги обязаны быть разными: мок (как и бэкенд) не сохраняет один и тот же
  // SVG от одного кошелька дважды
  const tag = (await api.post('/tags', { svg: svg(n) })) as { id?: string };
  const id = String(tag.id ?? '');
  const realNow = Date.now;
  try {
    Date.now = () => realNow() - hoursAgo * 3600_000;
    await api.post('/tags/{id}/report', { reason }, { path: { id } });
  } finally { Date.now = realNow; }
  return id;
}

describe('Admin — модерация тегов', () => {
  it('показывает очередь: просроченную жалобу, срок и причину словами', async () => {
    await reportedTag(30, 'hate', 1);
    await reportedTag(2, 'ads', 2);
    mount();

    await waitFor(() => expect(screen.getByText(/Waiting: 2/)).toBeTruthy());
    expect(screen.getByText(/Overdue: 1/)).toBeTruthy();
    // просроченный тег идёт первым: 30 часов ждёт против 2 часов
    const rows = screen.getAllByTestId('mod-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toMatch(/overdue by 6 h/);
    expect(rows[1]!.textContent).toMatch(/22 h left/);
    // причины названы так же, как их видел жаловавшийся игрок
    expect(rows[0]!.textContent).toMatch(/Hate/);
    expect(rows[1]!.textContent).toMatch(/Ads or spam/);
  });

  it('решение модератора закрывает жалобу и убирает тег из очереди', async () => {
    const id = await reportedTag(5, 'other');
    mount();
    await waitFor(() => expect(screen.getAllByTestId('mod-row')).toHaveLength(1));

    fireEvent.click(screen.getByText('Hide'));
    await waitFor(() => expect(screen.queryAllByTestId('mod-row')).toHaveLength(0));
    expect(screen.getByText(/Nothing to moderate/)).toBeTruthy();
    // и статистика показывает, что решение принято: одна жалоба, закрытая снятием
    await waitFor(() => expect(screen.getByText(/Ends in a takedown: 100%/)).toBeTruthy());
    expect(id.length).toBeGreaterThan(0);
  });

  it('пустая очередь — не пустой экран', async () => {
    mount();
    await waitFor(() => expect(screen.getByText(/Nothing to moderate/)).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/Waiting: 0/)).toBeTruthy());
    expect(screen.getByText(/Median reaction: —/)).toBeTruthy();
  });
});
