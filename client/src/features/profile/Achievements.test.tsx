// @vitest-environment happy-dom
// docs/16 §4.7 — экран достижений.
//
// Что здесь проверяется: значок берётся из настоящего файла (а не рисуется
// кодом), прогресс не читается как сломанный счётчик, награда подписана
// косметикой (а не суммой), забрать можно только заслуженное и только один раз.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setLocale } from '@/shared/i18n';
import { ACHIEVEMENTS } from '@guttercaps/economy';

const claim = vi.fn();
let items: Array<Record<string, unknown>> = [];

vi.mock('@/api/hooks', () => ({
  useAchievements: () => ({ data: { items }, isLoading: false, error: null }),
  useClaimAchievement: () => ({ mutate: claim, isPending: false }),
}));
import Achievements from './Achievements';

const item = (id: string, have: number, done: boolean, claimed = false) => {
  const def = ACHIEVEMENTS.find((a) => a.id === id)!;
  return {
    id, metric: def.metric, target: def.target, have,
    done, claimed, claimedAt: claimed ? '2026-10-16T09:00:00.000Z' : null,
    icon: def.icon, reward: def.reward, bannerCollection: def.reward.kind === 'banner' ? 0 : null,
  };
};

const draw = () => render(<MemoryRouter><Achievements /></MemoryRouter>);
const card = (id: string) => document.querySelector(`[data-id="${id}"]`) as HTMLElement;

afterEach(() => { cleanup(); claim.mockClear(); items = []; });

describe('достижения (docs/16 §4.7)', () => {
  it('рисует все достижения со значками из настоящих файлов', async () => {
    await setLocale('ru');
    items = ACHIEVEMENTS.map((a) => item(a.id, 0, false));
    draw();
    const cards = document.querySelectorAll('[data-testid="achievement"]');
    expect(cards.length).toBe(ACHIEVEMENTS.length);
    // Значок — файл, а не глиф: /icons/gen/<name>.webp
    const icons = Array.from(document.querySelectorAll<HTMLImageElement>('.ach-badge img')).map((i) => i.getAttribute('src'));
    expect(icons[0]).toBe(`/icons/gen/${ACHIEVEMENTS[0].icon}.webp`);
    expect(new Set(icons).size).toBeGreaterThan(1);
  });

  it('прогресс показывает «сколько из скольких», а не сырые числа', async () => {
    await setLocale('ru');
    items = [item('caps.half', 12, false), item('set.first', 1, true)];
    draw();
    const progress = document.querySelectorAll('[data-testid="ach-progress"]');
    expect(progress[0]?.textContent).toBe('12/36');
    expect(progress[1]?.textContent).toBe('1/1');
  });

  it('незаслуженное не забрать: кнопки у него нет', async () => {
    await setLocale('ru');
    items = [item('set.first', 0, false)];
    draw();
    expect(card('set.first').querySelector('button')).toBeNull();
    expect(card('set.first').getAttribute('data-done')).toBe('0');
  });

  it('заслуженное забирается одним тапом', async () => {
    await setLocale('ru');
    items = [item('set.first', 1, true)];
    draw();
    const btn = card('set.first').querySelector('button') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    fireEvent.click(btn);
    expect(claim).toHaveBeenCalledWith('set.first', expect.anything());
  });

  it('забранное Shows датой и больше не даёт кнопку', async () => {
    await setLocale('ru');
    items = [item('set.first', 1, true, true)];
    draw();
    expect(card('set.first').querySelector('button')).toBeNull();
    expect(card('set.first').getAttribute('data-claimed')).toBe('1');
    expect(card('set.first').textContent).toContain('2026');
  });

  it('награда подписана косметикой, а не суммой денег', async () => {
    await setLocale('ru');
    items = ACHIEVEMENTS.map((a) => item(a.id, 0, false));
    draw();
    // На самой карточке нет ни $CG, ни суммы: §4.7 запрещает платить
    // достижениями деньги. (В подзаголовке экрана про деньги сказано — это
    // правило, а не награда.)
    const cards = Array.from(document.querySelectorAll('[data-testid="achievement"]')).map((c) => c.textContent ?? '').join(' ');
    expect(cards).not.toContain('$CG');
    expect(cards).toContain('Баннер района');
    expect(cards).toContain('подсказки Флудгрида');
  });
});
