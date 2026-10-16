// Демо-режим достижений (docs/16 §4.7).
//
// Мок — это не «заглушка на потом»: на нём показывают игру. Поэтому он
// обязан отвечать теми же кодами ошибок, что продакшен, и выдавать ту же
// косметику, а не что-нибудь «примерно похожее».
import { describe, expect, it } from 'vitest';
import { mockRequest, resetMockWorld } from './index';
import { ACHIEVEMENTS } from '@guttercaps/economy';

const list = () => mockRequest('get', '/me/achievements', {}) as Promise<{ items: Array<Record<string, unknown>> }>;
const claim = (id: string) => mockRequest('post', '/me/achievements/{id}/claim', { path: { id } }) as Promise<Record<string, unknown>>;
const codes = (p: Promise<unknown>) => p.then(() => null, (e: { status: number; code: string }) => `${e.status} ${e.code}`);

describe('mock achievements', () => {
  it('прогресс собран так, что на экране видно и заслуженное, и цель', async () => {
    resetMockWorld();
    const { items } = await list();
    expect(items.map((i) => i.id)).toEqual(ACHIEVEMENTS.map((a) => a.id));
    const set = items.find((i) => i.id === 'set.first')!;
    expect(set.done).toBe(true);
    const caps = items.find((i) => i.id === 'caps.half')!;
    expect(Number(caps.have)).toBeLessThanOrEqual(Number(caps.target));
    expect(items.find((i) => i.id === 'grid.depth4')!.done).toBe(false);
  });

  it('заслуженное выдаёт entitlement, повторный тап — 409', async () => {
    resetMockWorld();
    const got = await claim('set.first');
    expect(got.claimed).toBe(true);
    expect(String(got.claimedAt)).toMatch(/^20\d\d-/);       // не 1970: демо не должно выглядеть сломанным
    expect(await codes(claim('set.first'))).toBe('409 already_claimed');
  });

  it('незаслуженное и неизвестное отвечают теми же кодами, что продакшен', async () => {
    resetMockWorld();
    expect(await codes(claim('grid.depth4'))).toBe('409 not_earned');
    expect(await codes(claim('no.such'))).toBe('400 unknown_achievement');
    const { items } = await list();
    expect(items.every((i) => i.claimed === false)).toBe(true);
  });
});
