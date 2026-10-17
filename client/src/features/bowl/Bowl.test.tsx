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

  it('показывает восемь райдеров и переключает выбранного', () => {
    mount();
    const riders = screen.getAllByRole('button', { name: /^Rider \d\d$/ });
    expect(riders.length).toBe(8);
    expect(riders[0].getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(riders[2]);
    expect(riders[2].getAttribute('aria-pressed')).toBe('true');
    expect(riders[0].getAttribute('aria-pressed')).toBe('false');
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
    for (const to of ['/bowl/line', '/bowl/tag', '/bowl/wall/0', '/bowl/builder', '/bowl/crew', '/bowl/board', '/bowl/rig']) {
      expect(hrefs, `missing link to ${to}`).toContain(to);
    }
    expect(screen.getByTestId('bowl-open-tournament')).toBeTruthy();
  });

  it('экспозиция показывает пустое состояние и три слота под крышки', () => {
    const { container } = mount();
    expect(container.querySelectorAll('.bowl-slot').length).toBe(3);
    expect(screen.getByText(/No caps on display yet/)).toBeTruthy();
  });
});
