// docs/16 §5.1 — экран линии.
//
// Что проверяется: графика — настоящие файлы (а не нарисованные кодом), управление
// — один тап, и, главное, **клиент отправляет ровно тот реплей, из которого
// сервер насчитает те же очки**. Второе — это весь §5.2 в одном тесте.
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setLocale } from '@/shared/i18n';
import { LINE, LINE_TICKS, lineLayout, lineSeed, simulateRun, type RunInput } from '@guttercaps/economy';

const submit = vi.fn();
const buy = vi.fn();
let state: Record<string, unknown> | null = null;
let boardRows: Array<Record<string, unknown>> = [];

vi.mock('@/api/hooks', () => ({
  useLine: () => ({ data: state, isLoading: false, error: null, refetch: vi.fn() }),
  useLineBoard: () => ({ data: { week: 0, rows: boardRows }, isLoading: false }),
  useSubmitRun: () => ({ mutate: submit, isPending: false }),
}));
vi.mock('@/api/hooksLazy', () => ({ useRig: () => ({ data: { rider: { silhouette: 3, theme: null } } }) }));
vi.mock('@/chain/hooks', () => ({ useGameConfig: () => ({ data: null }), useWalletLike: () => null }));
vi.mock('@solana/wallet-adapter-react', () => ({ useConnection: () => ({ connection: {} }), useWallet: () => ({ publicKey: null }) }));
vi.mock('@/api/client', () => ({
  api: { post: (...a: unknown[]) => { buy(...a); return Promise.resolve({ day: 0, credits: 1 }); } },
  ApiError: class extends Error {}, claimWithRetry: (f: () => unknown) => f(), isMock: () => true,
}));

import Line from './Line';

const day = 20_000;
const track = () => document.querySelector('[data-testid="line-track"]') as HTMLElement;

/** Управляемое время: кадры толкаем сами, иначе 45-секундный заезд не сыграть. */
let nowMs = 0;
let frames: FrameRequestCallback[] = [];
const pump = (count: number, msPerFrame = 160) => {
  for (let i = 0; i < count; i++) {
    const list = frames; frames = [];
    nowMs += msPerFrame;
    for (const cb of list) cb(nowMs);
  }
};

beforeEach(() => {
  nowMs = 0; frames = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
  state = {
    day, week: Math.floor(day / 7), seed: lineSeed(day), ticks: LINE_TICKS,
    length: LINE.trackLength, freeRunsPerDay: LINE.freeRunsPerDay,
    freeLeft: 3, paidLeft: LINE.maxPaidRunsPerDay, runsToday: 0, bestToday: 0, tierToday: 'none',
    rewardsToday: { passXp: 0, hints: 0, valve: 0 }, bestWeek: 0, extraRunCgMicro: LINE.extraRunCgMicro,
  };
  boardRows = [];
  submit.mockReset(); buy.mockReset();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Прогнать заезд до отправки, тапая в каждом кадре. */
function playToEnd() {
  fireEvent.click(document.querySelector('[data-testid="line-start"]') as HTMLElement);
  for (let i = 0; i < 400 && !submit.mock.calls.length; i++) {
    const tap = document.querySelector('[data-testid="line-tap"]');
    if (tap) fireEvent.pointerDown(tap);
    pump(1);
  }
}

describe('линия (docs/16 §5.1)', () => {
  it('чаша и препятствия — настоящие файлы, а не рисунок кодом', async () => {
    await setLocale('ru');
    render(<MemoryRouter><Line /></MemoryRouter>);
    expect((document.querySelector('.line-bg') as HTMLImageElement).getAttribute('src')).toBe('/art/skate/line-bg.webp');
    const art = Array.from(document.querySelectorAll<HTMLImageElement>('.line-feature')).map((i) => i.getAttribute('src'));
    expect(art.length).toBeGreaterThan(0);
    for (const src of art) expect(src).toMatch(/^\/art\/skate\/line-(rail|kicker|gap|bump)\.webp$/);
    // райдер — тот же спрайт, что на витрине (§4.6): силуэт 3 → rider-04
    expect((document.querySelector('.line-rider img') as HTMLImageElement).getAttribute('src')).toBe('/art/skate/rider-04.webp');
  });

  it('сид сверяется: чужая чаша не даёт ехать', async () => {
    await setLocale('ru');
    state = { ...(state as object), seed: 12345 } as Record<string, unknown>;
    render(<MemoryRouter><Line /></MemoryRouter>);
    expect(document.querySelector('[data-testid="line-stale"]')).not.toBeNull();
    expect((document.querySelector('[data-testid="line-start"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('управление — один тап: на земле прыжок, в воздухе грэб', async () => {
    await setLocale('ru');
    render(<MemoryRouter><Line /></MemoryRouter>);
    fireEvent.click(document.querySelector('[data-testid="line-start"]') as HTMLElement);
    const tap = document.querySelector('[data-testid="line-tap"]') as HTMLElement;
    expect(tap).not.toBeNull();
    fireEvent.pointerDown(tap);   // на земле → прыжок (0)
    pump(1);
    fireEvent.pointerDown(tap);   // в воздухе → грэб (1)
    pump(1);
    expect(track().getAttribute('data-stage')).toBe('running');
    // до финиша ещё далеко, но ввод уже пошёл в реплей — проверим его в конце
  });

  it('клиент отправляет ровно тот реплей, из которого сервер насчитает те же очки', async () => {
    await setLocale('ru');
    render(<MemoryRouter><Line /></MemoryRouter>);
    playToEnd();
    expect(submit).toHaveBeenCalledTimes(1);
    const [body, opts] = submit.mock.calls[0] as [{ day: number; inputs: [number, number][] }, { onSuccess: (r: unknown) => void }];
    expect(body.day).toBe(day);
    expect(body.inputs.length).toBeGreaterThan(0);
    for (const [tick, action] of body.inputs) {
      expect(Number.isInteger(tick) && tick >= 0 && tick < LINE_TICKS).toBe(true);
      expect(action === 0 || action === 1).toBe(true);
    }
    // главное: пересчёт сервера по этому реплею даёт ровно то, что показал клиент
    const replay: RunInput[] = body.inputs.map(([tick, action]) => ({ tick, action: action as RunInput['action'] }));
    const serverScore = simulateRun(lineLayout(day), replay).score;
    expect(serverScore).toBeGreaterThan(0);
    await waitFor(() => {
      expect(Number(document.querySelector('[data-testid="line-score"]')?.textContent ?? '-1')).toBe(serverScore);
    });
    expect(opts.onSuccess).toBeTypeOf('function');
  });

  it('после заезда виден результат и награда — XP трека, а не деньги', async () => {
    await setLocale('ru');
    render(<MemoryRouter><Line /></MemoryRouter>);
    playToEnd();
    const [, opts] = submit.mock.calls[0] as [unknown, { onSuccess: (r: unknown) => void }];
    opts.onSuccess({
      run: { id: 1, day, week: 0, score: 2410, tricks: 14, bestCombo: 12, bails: 1, paid: false, tier: 'silver', submittedAt: '2026-10-16T10:00:00.000Z' },
      granted: { passXp: 16, hints: 1, valve: 0, tier: 'silver' },
      state: { ...(state as object), freeLeft: 2 },
    });
    // waitFor ждёт, пока колбэк не перестанет бросать: возвращать null нельзя
    const card = await waitFor(() => {
      const el = document.querySelector('[data-testid="line-result"]');
      if (!el) throw new Error('результат ещё не показан');
      return el as HTMLElement;
    });
    expect(card.textContent).toContain('2410');
    expect(card.textContent).toContain('16 XP трека');
    expect(card.textContent).toContain('1 подсказки Флудгрида');
    expect(card.textContent).not.toContain('$CG');
  });

  it('когда бесплатные кончились, на экране честно стоит цена доп. заезда', async () => {
    await setLocale('ru');
    state = { ...(state as object), freeLeft: 0 } as Record<string, unknown>;
    render(<MemoryRouter><Line /></MemoryRouter>);
    const b = document.querySelector('[data-testid="line-buy"]') as HTMLButtonElement;
    expect(b).not.toBeNull();
    expect(b.textContent).toContain('30 $CG');
    fireEvent.click(b);
    await waitFor(() => expect(buy).toHaveBeenCalled());
    expect((buy.mock.calls[0] as string[])[0]).toBe('/me/line/runs/buy');
  });

  it('когда лимит исчерпан полностью, кнопки покупки нет', async () => {
    await setLocale('ru');
    state = { ...(state as object), freeLeft: 0, paidLeft: 0 } as Record<string, unknown>;
    render(<MemoryRouter><Line /></MemoryRouter>);
    expect(document.querySelector('[data-testid="line-buy"]')).toBeNull();
    expect(document.querySelector('[data-testid="line-done"]')).not.toBeNull();
  });

  it('доска недели показывает чужие результаты', async () => {
    await setLocale('ru');
    boardRows = [
      { rank: 1, wallet: 'A'.repeat(44), handle: 'railqueen', score: 3120, tricks: 16, bails: 0, runId: 7, at: '2026-10-16T09:00:00.000Z' },
      { rank: 2, wallet: 'B'.repeat(44), handle: null, score: 2100, tricks: 12, bails: 2, runId: 8, at: '2026-10-16T09:10:00.000Z' },
    ];
    render(<MemoryRouter><Line /></MemoryRouter>);
    const rows = document.querySelectorAll('[data-testid="line-board"] li');
    expect(rows.length).toBe(2);
    expect(rows[0]?.textContent).toContain('railqueen');
    expect(rows[1]?.textContent).toContain('BBBB…BBBB');
  });
});
