// @vitest-environment happy-dom
// Бассейн: раскладка сгенерированного арта и переключение состояния.
// Бэкенда у страницы пока нет, поэтому тест чисто интерфейсный: слои превью,
// aria-pressed на переключателях, пустое состояние экспозиции и доступность
// декоративных картинок (у них alt="" — за них говорит подпись секции).
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Bowl from './Bowl';

function mount() {
  return render(
    <MemoryRouter>
      <Bowl />
    </MemoryRouter>,
  );
}

describe('Bowl — хаб скейт-мира', () => {
  afterEach(cleanup);

  it('райдера больше нет: ни выбора силуэта, ни силуэта поверх панорамы', () => {
    mount();
    expect(screen.queryAllByRole('button', { name: /^Rider \d\d$/ }).length).toBe(0);
    expect(document.querySelector('.bowl-hero-near')).toBeNull();
    expect(document.querySelector('.bowl-hero-far')).toBeTruthy();
  });

  it('показывает целую доску района и переключает районы', () => {
    mount();
    const board = screen.getByTestId('bowl-fullboard') as HTMLImageElement;
    expect(board.getAttribute('src')).toContain('/art/skate/board-d1.webp');
    const districtBtn = screen.getByRole('button', { name: /Rail Kings|Короли/i });
    fireEvent.click(districtBtn);
    expect((screen.getByTestId('bowl-fullboard') as HTMLImageElement).getAttribute('src')).toContain('/art/skate/board-d2.webp');
    expect(districtBtn.getAttribute('aria-pressed')).toBe('true');
    // Плоской «сборки» слоями больше нет.
    expect(document.querySelector('.bowl-board-part')).toBeNull();
  });

  it('герой описан для скринридера, а декоративные картинки — нет', () => {
    const { container } = mount();
    expect(screen.getByRole('img', { name: /concrete skate bowl/i })).toBeTruthy();
    for (const img of container.querySelectorAll('.bowl-niche-bg, .bowl-slot')) {
      expect(img.getAttribute('alt')).toBe('');
    }
  });

  it('хаб показывает старт, доступность и прямые входы в Линию/турнир/стену/конструктор/команды', () => {
    mount();
    expect(screen.getByTestId('bowl-start')).toBeTruthy();
    expect(screen.getByText(/Open to browse/)).toBeTruthy();
    expect(screen.getByText(/Wallet needed/)).toBeTruthy();
    const hrefs = [...document.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    for (const to of ['/grid', '/bowl/tag', '/bowl/wall/0', '/bowl/builder', '/bowl/crew', '/bowl/board']) {
      expect(hrefs, `missing link to ${to}`).toContain(to);
    }
    expect(screen.getByTestId('bowl-open-grid')).toBeTruthy();
  });

  it('экспозиции-пустышки больше нет: витрина досок без второй подложки', () => {
    const { container } = mount();
    // Три вечно пустые рамки убраны с хаба (2026-10-18); фон у доски — в
    // самом её арте, второй сцены-подложки (двойной фон) больше нет.
    expect(container.querySelectorAll('.bowl-slot').length).toBe(0);
    expect(container.querySelector('.board-stage')).toBeNull();
    expect(screen.getByTestId('bowl-fullboard')).toBeTruthy();
  });
});
