// @vitest-environment happy-dom
// Сквозной тест Линии БЕЗ моков хуков: настоящий Line + настоящие
// react-query хуки + настоящий mock-API (тот же, что в демо-сборке).
// Line.test.tsx мокает хуки и проверяет механику; этот тест проверяет,
// что вся цепочка «кнопка → заезд → POST /me/line/runs → засчитано»
// реально соединена — именно это ломалось у игроков как «игра не работает».
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Keypair } from '@solana/web3.js';
import { mockRequest, resetMockWorld } from '@/api/mock';
import { setMockMode } from '@/api/client';
import { useSessionStore } from '@/app/store/session';
import Line from './Line';

const fakeKey = Keypair.generate().publicKey;
vi.mock('@solana/wallet-adapter-react', async () => {
  const actual = await vi.importActual<typeof import('@solana/wallet-adapter-react')>('@solana/wallet-adapter-react');
  return {
    ...actual,
    useWallet: () => ({ publicKey: fakeKey, connected: true, connecting: false, wallet: null, disconnect: async () => {} }),
    useConnection: () => ({ connection: {} }),
  };
});

let nowMs = 0;
let rafId = 0;
const queue = new Map<number, FrameRequestCallback>();
const pump = (count: number, msPerFrame = 160) => {
  for (let i = 0; i < count; i++) {
    const list = [...queue.values()]; queue.clear();
    nowMs += msPerFrame;
    for (const cb of list) cb(nowMs);
  }
};

beforeAll(() => {
  setMockMode(true);
  useSessionStore.setState({ status: 'authenticated', wallet: { address: fakeKey.toBase58() }, address: fakeKey.toBase58(), csrf: 'test' });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { const id = ++rafId; queue.set(id, cb); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { queue.delete(id); });
  vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
});
afterEach(() => { cleanup(); resetMockWorld(); queue.clear(); nowMs = 0; });

describe('Line — сквозной заезд через настоящий mock-API', () => {
  it('Вкатиться → тапы → финиш: заезд засчитан сервером (runsToday = 1)', async () => {
    // Заезд — 4500 тиков симуляции + сетевые круги мока: дефолтных 5с мало.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/line']}>
          <Routes><Route path="/line" element={<Line />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const start = await waitFor(() => {
      const el = document.querySelector('[data-testid="line-start"]') as HTMLElement;
      expect(el).toBeTruthy();
      return el;
    });
    fireEvent.click(start);
    // Едем: тапаем и качаем кадры, пока сервер не примет заезд.
    for (let i = 0; i < 500; i++) {
      const tap = document.querySelector('[data-testid="line-tap"]');
      if (tap) fireEvent.pointerDown(tap);
      pump(3);
      const line = await mockRequest('get', '/me/line', {}) as { runsToday: number };
      if (line.runsToday > 0) break;
    }
    const after = await mockRequest('get', '/me/line', {}) as { runsToday: number; bestToday: number };
    expect(after.runsToday).toBe(1);
    // И экран результата показан, а не молчаливый отказ.
    await waitFor(() => expect(document.querySelector('[data-testid="line-submit-error"]')).toBeNull());
    expect(screen.getByTestId('line-track')).toBeTruthy();
  }, 30_000);
});
