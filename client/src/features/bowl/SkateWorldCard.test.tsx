// @vitest-environment happy-dom
// Точка входа в скейт-мир с главного экрана (PR #66/#67): новый игрок без
// прямых URL должен увидеть бассейн, Линию+турнир, стену, конструктор и
// команды — и понять доступность до клика.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SkateWorldCard from './SkateWorldCard';

describe('SkateWorldCard — точка входа в скейт-мир', () => {
  afterEach(cleanup);

  it('ведёт на все ключевые маршруты скейт-мира', () => {
    render(<MemoryRouter><SkateWorldCard /></MemoryRouter>);
    const hrefs = [...document.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    for (const to of ['/bowl', '/grid', '/bowl/wall/0', '/bowl/builder', '/bowl/crew', '/bowl/board']) {
      expect(hrefs, `missing link to ${to}`).toContain(to);
    }
    expect(screen.getByTestId('skate-enter-bowl')).toBeTruthy();
    expect(screen.getByTestId('skate-entry-grid')).toBeTruthy();
  });

  it('показывает доступность: просмотр без кошелька, действия — с кошельком', () => {
    render(<MemoryRouter><SkateWorldCard /></MemoryRouter>);
    expect(screen.getByText(/Open to browse/)).toBeTruthy();
    expect(screen.getByText(/Wallet needed/)).toBeTruthy();
    // Герой-арт бассейна реально в разметке карточки, а не только в public/.
    const img = document.querySelector('img[src="/art/skate/bowl-hero.webp"]');
    expect(img).toBeTruthy();
  });
});
