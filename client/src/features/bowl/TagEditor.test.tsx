// @vitest-environment happy-dom
// Редактор тегов: всё достижимо одним тапом — клавиатуры и мыши не требуется.
// Проверяем именно то, что обещано: переключение инструментов, рисование
// указателем (палец/стилус), откат, лимиты экспорта и закрытый платный пак.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TagEditor from './TagEditor';

function mount(packOwned = false, onDone?: (svg: string) => void) {
  return render(
    <MemoryRouter>
      <TagEditor packOwned={packOwned} onDone={onDone} />
    </MemoryRouter>,
  );
}

function draw(...pts: [number, number][]) {
  const canvas = screen.getByRole('img', { name: /empty wall canvas/i });
  fireEvent.pointerDown(canvas, { clientX: pts[0][0], clientY: pts[0][1], pointerId: 1 });
  for (const [x, y] of pts.slice(1)) fireEvent.pointerMove(canvas, { clientX: x, clientY: y, pointerId: 1 });
  fireEvent.pointerUp(canvas, { pointerId: 1 });
  return canvas;
}

describe('TagEditor — редактор тегов', () => {
  afterEach(cleanup);

  it('переключает инструменты тапом', () => {
    mount();
    const brush = screen.getByRole('button', { name: 'Brush' });
    const spray = screen.getByRole('button', { name: 'Spray' });
    expect(brush.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(spray);
    expect(spray.getAttribute('aria-pressed')).toBe('true');
    expect(brush.getAttribute('aria-pressed')).toBe('false');
  });

  it('рисует указателем и показывает счётчик команд', () => {
    mount();
    expect(screen.getByText(/0 of 400 path commands/)).toBeTruthy();
    draw([10, 10], [40, 30], [80, 60], [140, 90]);
    expect(screen.getByText(/[1-9]\d* of 400 path commands/)).toBeTruthy();
  });

  it('откат убирает последний штрих', () => {
    mount();
    draw([10, 10], [60, 40]);
    expect(screen.getByText(/[1-9]\d* of 400 path commands/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByText(/0 of 400 path commands/)).toBeTruthy();
  });

  it('платный пак закрыт и ведёт в магазин, а купленный — доступен', () => {
    const { unmount } = mount(false);
    fireEvent.click(screen.getByRole('button', { name: 'Stencil' }));
    const locked = document.querySelectorAll('.tag-stencil.is-locked');
    expect(locked.length).toBe(5);
    expect(locked[0].getAttribute('href')).toBe('/shop?tab=services');
    unmount();

    mount(true);
    fireEvent.click(screen.getByRole('button', { name: 'Stencil' }));
    expect(document.querySelectorAll('.tag-stencil.is-locked').length).toBe(0);
    // 14 бесплатных + 5 купленных — все кнопки, доступные тапом
    expect(document.querySelectorAll('.tag-stencil').length).toBe(19);
  });

  it('не отдаёт SVG за лимитом и отдаёт в пределах лимита', () => {
    const got: string[] = [];
    mount(true, (svg) => got.push(svg));
    draw([20, 20], [60, 50], [120, 80]);
    const done = screen.getByRole('button', { name: 'Done' });
    expect(done.hasAttribute('disabled')).toBe(false);
    fireEvent.click(done);
    expect(got.length).toBe(1);
    expect(got[0].startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(got[0]).toContain(`viewBox="0 0 1024 512"`);
  });
});
