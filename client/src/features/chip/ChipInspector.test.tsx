// @vitest-environment happy-dom
// Инспектор крышки (docs/16 §2.2): орбита, два лица, шер с реф-кодом.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LOCALES, setLocale, t } from '@/shared/i18n';

const mocks = vi.hoisted(() => ({
  detail: undefined as unknown,
  post: vi.fn(),
  clipboard: vi.fn(),
}));
vi.mock('@/api/hooks', () => ({ useChipDetail: () => ({ data: mocks.detail, isLoading: false }) }));

const ASSET = '7xKQpumpkinF4keY4VhKk9P8nQzLm3uWc2RtGvHsJdEbN';
const DETAIL = { asset: ASSET, owner: '9yWmOwnerAddressForTheInspectorTest1111111111', collection: 0, rarity: 5, level: 3, power: 900, flags: {} };

function mount() {
  return render(
    <MemoryRouter initialEntries={[`/chip/${ASSET}`]}>
      <Routes><Route path="/chip/:asset" element={<ChipInspector />} /></Routes>
    </MemoryRouter>,
  );
}

// api.post и буфер обмена подменяем до импорта компонента
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return { ...actual, api: { ...actual.api, post: mocks.post } };
});

import ChipInspector from './ChipInspector';

beforeEach(() => {
  mocks.detail = DETAIL;
  mocks.post.mockResolvedValue({ path: `/chip/${ASSET}?ref=Me` });
  mocks.clipboard.mockResolvedValue(undefined);
  // happy-dom отдаёт clipboard геттером — переопределяем через defineProperty.
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: mocks.clipboard }, configurable: true });
});
afterEach(async () => { cleanup(); vi.clearAllMocks(); await setLocale('en'); });

describe('chip inspector (docs/16 §2.2)', () => {
  it('крутится с клавиатуры и сбрасывается по двойному тапу', () => {
    const { container } = mount();
    const coin = () => container.querySelector<HTMLElement>('.inspector-coin')!.style.transform;
    const stage = screen.getByRole('img');
    expect(coin()).toBe('rotateY(0deg)');
    fireEvent.keyDown(stage, { key: 'ArrowRight' });
    expect(coin()).toBe('rotateY(30deg)');
    fireEvent.keyDown(stage, { key: 'ArrowLeft' });
    expect(coin()).toBe('rotateY(0deg)');
    fireEvent.keyDown(stage, { key: 'ArrowRight' });
    fireEvent.doubleClick(stage);
    expect(coin()).toBe('rotateY(0deg)');
  });

  it('оборот показывает паспорт, а лицо — арт', () => {
    const { container } = mount();
    // На лице настоящий файл арта, на обороте — гравировка района и паспорт.
    expect(container.querySelector('.inspector-front img')?.getAttribute('src')).toContain('/art/');
    // гравировка района: имя района и его символ, а не номер коллекции
    expect(container.querySelector('.inspector-engraving')?.textContent).toMatch(/.+ · .+/);
    expect(container.textContent).toContain(t('market.filters.rarity'));
  });

  it('шер пишет событие на бэкенде и кладёт в буфер ссылку с реф-кодом', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: t('inspect.share') }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledOnce());
    expect(mocks.post.mock.calls[0][0]).toBe('/chips/{asset}/share');
    expect(mocks.post.mock.calls[0][2]).toEqual({ path: { asset: ASSET } });
    await waitFor(() => expect(mocks.clipboard).toHaveBeenCalledWith(`${window.location.origin}/chip/${ASSET}?ref=Me`));
    expect(screen.getByText(t('inspect.link'))).toBeTruthy();
  });

  it('без крышки показывает пустой экран, а не падает', () => {
    mocks.detail = undefined;
    mount();
    expect(screen.getByText(t('ui.capNotFound'))).toBeTruthy();
  });

  it('во всех локалях есть и подсказка, и кнопка шера', async () => {
    for (const locale of LOCALES) {
      await setLocale(locale);
      mount();
      expect(screen.getByRole('button', { name: t('inspect.share') })).toBeTruthy();
      expect(document.body.textContent).toContain(t('inspect.hint'));
      cleanup();
    }
  });
});
