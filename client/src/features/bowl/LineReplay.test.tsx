// docs/16 §5.5 — просмотр чужого реплея.
//
// Главное, что держит этот тест: **просмотр показывает ровно тот заезд, очки
// которого стоят в строке доски**. Обе цифры считает одна функция
// (`simulateRun`), поэтому расхождение здесь означало бы, что доска врёт.
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setLocale, fmtLocale } from '@/shared/i18n';
import { LINE, LINE_TICKS, botReplay, lineLayout, lineSeed, simulateRun } from '@guttercaps/economy';

let replay: Record<string, unknown> | null = null;

vi.mock('@/api/hooks', () => ({
  useRunReplay: () => ({ data: replay, isLoading: false, error: null }),
  useLineBoard: () => ({ data: { week: 0, rows: [] } }),
}));
vi.mock('@/api/hooksLazy', () => ({ useRigOf: () => ({ data: { rider: { silhouette: 5, theme: null } } }) }));

import LineReplay from './LineReplay';

const DAY = 20_000;
/** Реплей чужого заезда: тот же бот, которым мерились пороги наград. */
const inputs = botReplay(lineLayout(DAY), 2, 3).map((i) => [i.tick, i.action] as [number, number]);
const truth = simulateRun(lineLayout(DAY), inputs.map(([tick, action]) => ({ tick, action: action === 1 ? 1 : 0 })));

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

beforeEach(() => {
  nowMs = 0;
  // Отмена должна真的 отменять: иначе старый цикл (старая скорость, старый заезд)
  // продолжает писать кадры поверх нового, и тест видит чужое состояние.
  queue.clear();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { const id = ++rafId; queue.set(id, cb); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { queue.delete(id); });
  vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
  replay = {
    runId: 7, day: DAY, seed: lineSeed(DAY), score: truth.score, tricks: truth.tricks, bails: truth.bails,
    wallet: 'F'.repeat(44), handle: 'railqueen', at: '2026-10-16T09:00:00.000Z', inputs,
  };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Прогнать просмотр до конца заезда. */
function playToEnd() {
  for (let i = 0; i < 400; i++) pump(1);
}

describe('просмотр реплея (docs/16 §5.5)', () => {
  it('в просмотре те же очки, что в строке доски', async () => {
    await setLocale('ru');
    render(<MemoryRouter><LineReplay runId={7} who="railqueen" onClose={() => {}} /></MemoryRouter>);
    expect(truth.score).toBeGreaterThan(0);
    // строка доски показывает итог (число с разделителем разрядов — как везде в интерфейсе)
    expect(document.querySelector('[data-testid="line-replay"]')?.textContent).toContain(fmtLocale.int(truth.score));
    playToEnd();
    // …и проигрывание доезжает ровно до него: обе цифры считает simulateRun
    await waitFor(() => {
      const shown = Number(document.querySelector('[data-testid="line-replay-score"]')?.textContent ?? '-1');
      expect(shown).toBe(truth.score);
    });
  });

  it('райдер и чаша — настоящие файлы; райдер того, кто ехал', async () => {
    await setLocale('ru');
    render(<MemoryRouter><LineReplay runId={7} who="railqueen" onClose={() => {}} /></MemoryRouter>);
    expect((document.querySelector('.line-bg') as HTMLElement).style.backgroundImage).toContain('/art/skate/line-bg.webp');
    // силуэт 5 → rider-06: в просмотре едет райдер владельца заезда, а не мой
    expect((document.querySelector('.line-rider img') as HTMLImageElement).getAttribute('src')).toBe('/art/skate/rider-06.webp');
    const art = Array.from(document.querySelectorAll<HTMLImageElement>('.line-feature')).map((i) => i.getAttribute('src'));
    for (const src of art) expect(src).toMatch(/^\/art\/skate\/line-(rail|kicker|gap|bump)\.webp$/);
    expect(document.querySelector('[data-testid="line-replay"]')?.textContent).toContain('railqueen');
  });

  it('чужая чаша не проигрывается: сид сверяется так же, как в живом заезде', async () => {
    await setLocale('ru');
    replay = { ...(replay as object), seed: 999 } as Record<string, unknown>;
    render(<MemoryRouter><LineReplay runId={7} onClose={() => {}} /></MemoryRouter>);
    expect(document.querySelector('[data-testid="line-replay-stale"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="line-replay-track"]')).toBeNull();
  });

  it('стёртый ввод — честная плашка, а не пустая езда', async () => {
    await setLocale('ru');
    replay = { ...(replay as object), inputs: [] } as Record<string, unknown>;
    render(<MemoryRouter><LineReplay runId={7} onClose={() => {}} /></MemoryRouter>);
    expect(document.querySelector('[data-testid="line-replay-gone"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="line-replay-track"]')).toBeNull();
  });

  it('заезд можно пересмотреть в два раза быстрее', async () => {
    await setLocale('ru');
    render(<MemoryRouter><LineReplay runId={7} onClose={() => {}} /></MemoryRouter>);
    const speed = document.querySelector('[data-testid="line-replay-speed"]') as HTMLButtonElement;
    expect(speed.textContent).toContain('×2');
    fireEvent.click(speed);
    expect((document.querySelector('[data-testid="line-replay-speed"]') as HTMLButtonElement).textContent).toContain('×1');
    // на 2× заезд заканчивается вдвое быстрее по кадрам
    pump(Math.ceil(LINE_TICKS / LINE.tickHz / 0.32) + 5, 160);
    await waitFor(() => {
      expect(Number(document.querySelector('[data-testid="line-replay-score"]')?.textContent)).toBe(truth.score);
    });
  });

  it('закрытие убирает просмотр', async () => {
    await setLocale('ru');
    const closed = vi.fn();
    render(<MemoryRouter><LineReplay runId={7} onClose={closed} /></MemoryRouter>);
    fireEvent.click(document.querySelector('[data-testid="line-replay-close"]') as HTMLElement);
    expect(closed).toHaveBeenCalledTimes(1);
  });
});
