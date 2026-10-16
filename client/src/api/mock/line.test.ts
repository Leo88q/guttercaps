// Демо-режим линии (docs/16 §5.1).
//
// Мок — это витрина игры: на нём показывают заезд. Поэтому он обязан считать
// очки той же функцией, что продакшен, и отвечать теми же кодами. Демо,
// которое считает очки «примерно», учит игрока не тому таймингу.
import { describe, expect, it } from 'vitest';
import { mockRequest, resetMockWorld } from './index';
import { LINE, LINE_TICKS, LINE_UNITS_PER_TICK, LINE_HOP, LINE_GRAB, lineLayout, lineSeed, simulateRun, type RunInput } from '@guttercaps/economy';

const U = LINE_UNITS_PER_TICK;
const day = () => Math.floor(Date.now() / 86_400_000);
const state = () => mockRequest('get', '/me/line', {}) as Promise<Record<string, any>>;
const post = (inputs: [number, number][], d = day()) => mockRequest('post', '/me/line/runs', { body: { day: d, inputs } }) as Promise<any>;
const buy = (signature: string, d = day()) => mockRequest('post', '/me/line/runs/buy', { body: { day: d, signature } }) as Promise<any>;
const board = () => mockRequest('get', '/line/leaderboard', {}) as Promise<Record<string, any>>;
const code = (p: Promise<unknown>) => p.then(() => null, (e: { status: number; code: string }) => `${e.status} ${e.code}`);

/** Бот «в окно»: прыжок перед препятствием и грэб сразу после толчка. */
function plan(): [number, number][] {
  const inputs: RunInput[] = [];
  let busy = -1;
  for (const f of lineLayout(day()).features) {
    if (f.kind === 'kicker') { inputs.push({ tick: Math.floor(f.start / U) + 1, action: LINE_GRAB }); busy = Math.floor(f.start / U) + LINE.kickTicks; continue; }
    const t = f.kind === 'rail' ? Math.floor((f.start + 20 - 220) / U) : Math.floor(f.start / U) - 1;
    if (t < 0 || t <= busy) continue;
    inputs.push({ tick: t, action: LINE_HOP });
    inputs.push({ tick: t + 1, action: LINE_GRAB });
    busy = t + LINE.hopTicks;
  }
  // Ввод в реплее — дискретные действия: тест знает, что шлёт, но тип реплея
  // требует ровно LineAction, а не любой number.
  return inputs.map((i) => [i.tick, i.action] as [number, number]);
}

describe('mock line', () => {
  it('состояние дня считается из того же сида, что у сервера', async () => {
    resetMockWorld();
    const s = await state();
    expect(s.day).toBe(day());
    expect(s.seed).toBe(lineSeed(day()));
    expect(s.freeLeft).toBe(LINE.freeRunsPerDay);
    expect(s.extraRunCgMicro).toBe(LINE.extraRunCgMicro);
  });

  it('очки мока — это пересчёт реплея, а не придуманное число', async () => {
    resetMockWorld();
    const inputs = plan();
    const r = await post(inputs);
    expect(r.run.score).toBe(simulateRun(lineLayout(day()), inputs.map(([tick, action]) => ({ tick, action: action as RunInput['action'] }))).score);
    expect(r.run.score).toBeGreaterThan(0);
    expect(r.state.freeLeft).toBe(LINE.freeRunsPerDay - 1);
    expect(r.state.bestToday).toBe(r.run.score);
  });

  it('три бесплатных, дальше — 402, и платёж открывает заезд', async () => {
    resetMockWorld();
    for (let i = 0; i < LINE.freeRunsPerDay; i++) await post([]);
    expect(await code(post([]))).toBe('402 runs_exhausted');
    expect(await code(buy('short'))).toBe('402 payment_not_found');
    expect((await buy('x'.repeat(64))).credits).toBe(1);
    const paid = await post([]);
    expect(paid.run.paid).toBe(true);
    expect(await code(post([]))).toBe('402 runs_exhausted');
  });

  it('реплей разбирается так же строго, как на сервере', async () => {
    resetMockWorld();
    expect(await code(post([[0, 7]]))).toBe('400 bad_replay');
    expect(await code(post([[LINE_TICKS + 1, 0]]))).toBe('400 bad_replay');
    expect(await code(post([[-1, 0]]))).toBe('400 bad_replay');
    expect(await code(post(new Array(LINE.maxInputs + 1).fill([0, 0])))).toBe('400 bad_replay');
    expect(await code(post([], day() + 3))).toBe('400 bad_day');
    expect((await state()).runsToday).toBe(0);
  });

  it('заезд попадает на доску недели', async () => {
    resetMockWorld();
    const r = await post(plan());
    const b = await board();
    expect(b.rows.length).toBeGreaterThan(1);
    const mine = b.rows.find((x: Record<string, unknown>) => x.runId === r.run.id);
    expect(mine).toBeTruthy();
    expect(mine.score).toBe(r.run.score);
  });

  it('свой заезд можно посмотреть, чужой — нет', async () => {
    resetMockWorld();
    const r = await post(plan());
    const replay = await mockRequest('get', '/me/line/runs/{id}/replay', { path: { id: String(r.run.id) } }) as Record<string, unknown>;
    expect(replay.score).toBe(r.run.score);
    expect(replay.seed).toBe(lineSeed(day()));
    expect(await code(mockRequest('get', '/me/line/runs/{id}/replay', { path: { id: '9999' } }))).toBe('404 not_found');
  });
});
