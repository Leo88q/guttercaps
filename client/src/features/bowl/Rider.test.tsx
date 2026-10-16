// @vitest-environment happy-dom
// docs/16 §4.6 — Райдер: образ, а не характеристики.
//
// Три вещи, которые здесь нельзя сломать:
//   1. силуэт берётся из настоящего файла района, а не рисуется кодом;
//   2. надеть можно только ту косметику, которая оплачена (проверка на сервере,
//      а интерфейс просто не делает некупленную тему кнопкой);
//   3. на чужой витрине райдер виден, но не настраивается.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setLocale } from '@/shared/i18n';
import { collectionColor } from '@/shared/lib/rarity';
import { PROFILE_THEMES } from '@/shared/lib/cosmetics';

const setRider = vi.fn();
let entitlements: { id: string; kind: number; payload: Record<string, unknown> }[] = [];

vi.mock('@/api/hooks', () => ({
  useMyServices: () => ({ data: { entitlements }, isLoading: false }),
}));
vi.mock('@/api/hooksLazy', () => ({
  useSetRider: () => ({ mutate: setRider, isPending: false }),
}));

import { RiderCard, RIDER_COUNT } from './Rider';
import type { RigView } from '@/api/hooksLazy';

const view = (rider: { silhouette: number; theme: string | null }): RigView =>
  ({ wallet: 'W', rider, public: true, caps: [], slots: [], next: null }) as unknown as RigView;

const draw = (v: RigView | null, mine = true) =>
  render(<MemoryRouter><RiderCard view={v} mine={mine} /></MemoryRouter>);

afterEach(() => { cleanup(); setRider.mockClear(); entitlements = []; });

describe('райдер (docs/16 §4.6)', () => {
  it('рисует настоящий файл района и подсвечивает его цветом района', async () => {
    await setLocale('ru');
    draw(view({ silhouette: 3, theme: null }));
    const figure = document.querySelector('.rider-figure img') as HTMLImageElement;
    expect(figure.getAttribute('src')).toBe('/art/skate/rider-04.webp');
    const root = document.querySelector('[data-testid="rider"]') as HTMLElement;
    expect(root.getAttribute('data-silhouette')).toBe('3');
    expect(root.getAttribute('data-lamp')).toBe(collectionColor(3));
  });

  it('полоса выбора — восемь силуэтов на тайлах, тап надевает фигуру', async () => {
    await setLocale('ru');
    draw(view({ silhouette: 0, theme: null }));
    const picks = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="rider-pick"]'));
    expect(picks.length).toBe(RIDER_COUNT);
    // Тайлы, а не полные кадры: полоса из восьми фигур не тянет 500 КБ.
    const thumbs = picks.map((p) => p.querySelector('img')?.getAttribute('src'));
    expect(thumbs[0]).toBe('/art/skate/rider-01-thumb.webp');
    expect(new Set(thumbs).size).toBe(RIDER_COUNT);
    fireEvent.click(picks[5]!);
    expect(setRider).toHaveBeenCalledWith({ silhouette: 5 }, expect.anything());
  });

  it('некупленная тема не надевается: она не кнопка', async () => {
    await setLocale('ru');
    entitlements = [{ id: 'e2', kind: 3, payload: { theme: 'magenta' } }];
    draw(view({ silhouette: 0, theme: null }));
    // Первая пилюля — «подсветка районом», дальше темы в порядке PROFILE_THEMES.
    const pills = Array.from(document.querySelectorAll<HTMLElement>('.pill'));
    expect(pills.length).toBe(PROFILE_THEMES.length + 1);
    const magenta = pills[PROFILE_THEMES.findIndex((th) => th.id === 'magenta') + 1];
    const cyan = pills[PROFILE_THEMES.findIndex((th) => th.id === 'cyan') + 1];
    expect(magenta, 'купленная тема в списке').toBeTruthy();
    expect(cyan, 'чужая тема в списке').toBeTruthy();
    expect(magenta!.tagName).toBe('BUTTON');
    // Некупленная — подпись, а не элемент управления: Tab-остановка, которая
    // ничего не делает, интерфейсу не нужна.
    expect(cyan!.tagName).not.toBe('BUTTON');
    fireEvent.click(magenta!);
    expect(setRider).toHaveBeenCalledWith({ theme: 'magenta' }, expect.anything());
  });

  it('чужая витрина показывает райдера, но без переключателей', async () => {
    await setLocale('ru');
    draw(view({ silhouette: 6, theme: null }), false);
    expect((document.querySelector('.rider-figure img') as HTMLImageElement).getAttribute('src')).toBe('/art/skate/rider-07.webp');
    expect(document.querySelectorAll('[data-testid="rider-pick"]').length).toBe(0);
    expect(document.querySelectorAll('.pill').length).toBe(0);
  });

  it('без доски райдер не падает: по умолчанию первый район', async () => {
    await setLocale('ru');
    draw(null);
    expect((document.querySelector('[data-testid="rider"]') as HTMLElement).getAttribute('data-silhouette')).toBe('0');
  });
});
