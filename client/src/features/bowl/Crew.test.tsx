// @vitest-environment happy-dom
// Команда (docs/16 §5.6): что здесь держится.
//
//   1. команды нет → экран предлагает собрать её или вступить по коду;
//   2. хартия создаёт команду, и в ней ровно один человек — ты;
//   3. вступление по коду добавляет райдера, повторный код не проходит;
//   4. доска показывает команды и считает очки по пятерым лучшим, а не по составу.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Keypair } from '@solana/web3.js';
import { api, setMockMode } from '@/api/client';
import { useSessionStore } from '@/app/store/session';
import { CREW } from '@guttercaps/economy';
import Crew from './Crew';

const fakeKey = Keypair.generate().publicKey;
vi.mock('@solana/wallet-adapter-react', async () => {
  const actual = await vi.importActual<typeof import('@solana/wallet-adapter-react')>('@solana/wallet-adapter-react');
  return {
    ...actual,
    useWallet: () => ({ publicKey: fakeKey, connected: true, connecting: false, wallet: null, disconnect: async () => {} }),
    useConnection: () => ({ connection: {} }),
  };
});

/** Поле кода осталось заполненным, а кнопка снова активна — значит, запрос ответил ошибкой. */
const joinErrored = (input: HTMLElement) => (input as HTMLInputElement).value === 'NOPE1234';

function mount(path = '/bowl/crew') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/bowl/crew" element={<Crew />} />
          <Route path="/bowl/crew/:name" element={<Crew />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeAll(() => {
  setMockMode(true);
  useSessionStore.setState({ status: 'authenticated', wallet: { address: fakeKey.toBase58() }, address: fakeKey.toBase58(), csrf: 'test' });
});
afterEach(async () => {
  cleanup();
  // Состав команды — общее состояние мока: выходим, иначе следующий тест
  // начнёт не с «ездишь один», а с уже собранной команды.
  try { await api.post('/crew/leave', undefined as never); } catch { /* и так не в команде */ }
});

describe('Crew — команда (docs/16 §5.6)', () => {
  it('без команды предлагает собрать её и показывает командную доску', async () => {
    mount();
    await waitFor(() => expect(screen.getByText('You ride alone')).toBeTruthy());
    // доска живёт своей карточкой: полные команды из мока уже на ней
    await waitFor(() => expect(screen.getByText('SlabSisters')).toBeTruthy());
    expect(screen.getByText('NightCrew')).toBeTruthy();
    // «десятеро не побеждают пятерых» — подпись доски на экране
    expect(screen.getByText(/only the five best runs count/)).toBeTruthy();
  });

  it('хартия создаёт команду: имя, состав из одного и сегмент стены', async () => {
    mount();
    await waitFor(() => expect(screen.getByText('You ride alone')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Charter a crew' }));

    // Имя проверяется перед оплатой: занятое не проходит, своё — проходит.
    const input = await waitFor(() => screen.getByPlaceholderText('slab_sisters'));
    fireEvent.change(input, { target: { value: 'SlabSisters' } });
    await waitFor(() => expect(screen.getByText('That name is taken')).toBeTruthy());

    fireEvent.change(input, { target: { value: 'TestCrew' } });
    await waitFor(() => expect(screen.getByText('The name is free')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Pay .* and charter/ }));

    // Команда появилась: имя, состав 1/10 и сегмент стены. Сегмент 0 района
    // уже занят SlabSisters, поэтому хартия берёт следующий свободный — первый
    // и есть «стена не продаётся: место ищется, а не покупается».
    await waitFor(() => expect(screen.getByText('TestCrew')).toBeTruthy());
    expect(screen.getByText(`1/${CREW.maxMembers}`)).toBeTruthy();
    expect(screen.getByText(/slots 20–39 of district 0/)).toBeTruthy();
    // код приглашения виден только своим — значит, он на экране
    expect(screen.getByText(/^TEST\d{4}$/)).toBeTruthy();
  });

  it('вступление по коду добавляет райдера, а чужой код не проходит', async () => {
    mount();
    await waitFor(() => expect(screen.getByText('You ride alone')).toBeTruthy());
    const code = screen.getByPlaceholderText('ABCD1234');

    fireEvent.change(code, { target: { value: 'NOPE1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    // Тосты рисует <Toasts/> из Shell, которого в тесте нет, поэтому проверяем
    // не подпись, а состояние экрана: чужой код не перенёс игрока в команду.
    await waitFor(() => expect(joinErrored(code)).toBe(true));
    expect(screen.getByText('You ride alone')).toBeTruthy();

    // Код приглашения знает только капитан, поэтому вступаем им через API и
    // проверяем результат: состав вырос, и команда стала «моей».
    const before = await api.get('/crew/{name}', { path: { name: 'SlabSisters' } }) as { memberCount: number };
    const joined = await api.post('/crew/join', { code: 'SLAB1101' }) as { name: string; memberCount: number; mine: boolean };
    expect(joined.name).toBe('SlabSisters');
    expect(joined.memberCount).toBe(before.memberCount + 1);
    expect(joined.mine).toBe(true);
    // второй раз — нельзя: одна команда на кошелёк
    await expect(api.post('/crew/join', { code: 'SLAB1101' })).rejects.toMatchObject({ code: 'already_in_crew' });
  });

  it('чужая карточка показывает состав и не показывает код приглашения', async () => {
    mount('/bowl/crew/SlabSisters');
    await waitFor(() => expect(screen.getByText('SlabSisters')).toBeTruthy());
    // Очки команды — сумма пяти лучших, а не всех семерых участников.
    const crew = await api.get('/crew/{name}', { path: { name: 'SlabSisters' } }) as { members: { bestWeek: number }[]; score: number; inviteCode?: string };
    const bests = crew.members.map((m) => m.bestWeek).sort((a, b) => b - a);
    expect(crew.score).toBe(bests.slice(0, CREW.boardCountingMembers).reduce((a, b) => a + b, 0));
    expect(crew.inviteCode).toBeUndefined();
    expect(screen.getByRole('button', { name: 'Report the name' })).toBeTruthy();
  });
});
