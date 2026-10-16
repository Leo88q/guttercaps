// @vitest-environment happy-dom
// Таймлапс тега (docs/16 §3.1).
//
// Главное здесь — не анимация, а замок: инлайновый SVG получает исполняемый
// контекст, которого нет у <img src="…/svg">. Белый список обязан выкидывать
// всё, кроме наших path и трафаретов, даже если строка пришла не с сервера.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { sanitizeInlineSvg, TagTimeLapse } from './TagTimeLapse';

afterEach(() => cleanup());

const CANVAS = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 512">';
const STROKE = '<path d="M10 10L200 120" stroke="#FF2E8A" stroke-width="8" fill="none"/>';
const STAMP = '<image href="/art/skate/stencil-01.svg" x="10" y="20" width="120" height="60" preserveAspectRatio="none"/>';

describe('sanitizeInlineSvg', () => {
  it('оставляет наши path и трафареты', () => {
    const out = sanitizeInlineSvg(`${CANVAS}${STROKE}${STAMP}</svg>`);
    // атрибуты пересобираются в каноническом порядке, поэтому проверяем их по отдельности
    expect(out).toContain('d="M10 10L200 120"');
    expect(out).toContain('stroke="#FF2E8A"');
    expect(out).toContain('stroke-width="8"');
    expect(out).toContain('fill="none"');
    expect(out).toContain('/art/skate/stencil-01.svg');
    expect(out.startsWith('<svg xmlns=')).toBe(true);
  });

  it('скрипт, foreignObject и обработчики не проходят', () => {
    for (const evil of [
      `${CANVAS}<script>alert(1)</script>${STROKE}</svg>`,
      `${CANVAS}<foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><img src=x onerror=alert(1)></body></foreignObject></svg>`,
      `${CANVAS}<path d="M1 1L2 2" onclick="alert(1)"/></svg>`,
      `${CANVAS}<use href="#x"/>${STROKE}</svg>`,
    ]) expect(sanitizeInlineSvg(evil)).not.toContain('<script'), expect(sanitizeInlineSvg(evil)).not.toContain('foreignObject');
    expect(sanitizeInlineSvg(`${CANVAS}<path d="M1 1L2 2" onclick="alert(1)"/></svg>`)).not.toContain('onclick');
    expect(sanitizeInlineSvg(`${CANVAS}<use href="#x"/>${STROKE}</svg>`)).not.toContain('<use');
  });

  it('внешние ссылки и чужие протоколы не проходят', () => {
    const out = sanitizeInlineSvg(`${CANVAS}<image href="https://evil.example/x.png" x="0" y="0" width="10" height="10"/>${STROKE}</svg>`);
    expect(out).not.toContain('evil.example');
    expect(out).toContain('<path');
    expect(sanitizeInlineSvg(`${CANVAS}<image href="javascript:alert(1)" x="0" y="0" width="10" height="10"/></svg>`)).toBe('');
    expect(sanitizeInlineSvg(`${CANVAS}<image href="/art/other/stencil.svg" x="0" y="0" width="10" height="10"/></svg>`)).toBe('');
  });

  it('заливка не проходит: тег — это штрихи', () => {
    expect(sanitizeInlineSvg(`${CANVAS}<path d="M1 1L2 2" fill="#FF0000"/></svg>`)).toBe('');
  });

  it('мусор на входе даёт пустую строку, а не исключение', () => {
    for (const bad of ['', 'not svg at all', '<svg>', CANVAS, `${CANVAS}${'</svg>'}`]) expect(sanitizeInlineSvg(bad)).toBe('');
    expect(sanitizeInlineSvg('<svg><parsererror-x/></svg>')).toBe('');
  });
});

describe('TagTimeLapse', () => {
  it('рисует очищенный SVG и не падает без getTotalLength', () => {
    const { container } = render(<TagTimeLapse svg={`${CANVAS}${STROKE}<script>alert(1)</script></svg>`} />);
    expect(container.querySelector('span svg path')).not.toBeNull();
    expect(container.innerHTML).not.toContain('<script');
  });

  it('несуществующий после очистки SVG не рендерит вообще ничего', () => {
    const { container } = render(<TagTimeLapse svg="<svg><script>alert(1)</script></svg>" />);
    expect(container.innerHTML).toBe('');
  });

  it('play=false не запускает анимацию', () => {
    const { container } = render(<TagTimeLapse svg={`${CANVAS}${STROKE}</svg>`} play={false} />);
    const p = container.querySelector('path') as SVGPathElement;
    expect(p.style.strokeDasharray).toBe('');
  });
});
