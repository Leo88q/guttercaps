// @vitest-environment happy-dom
// Тесты VFX-слоя (docs/14b §3): детерминированность кадра, гейт reduced-motion
// и адреса закоммиченных webp-слотов. Движения здесь не проверяется — оно живёт
// в CSS; проверяется то, что может сломаться в JS: «рандом» конфетти и залпа,
// нерендер при reduced-motion и соответствие слотам карты kenney-vfx-build.py.
import { beforeEach, describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { useUiStore } from '@/app/store/ui';
import { BeamPillar, ConfettiFall, SplatBackdrop, SplatBurst, raritySplat } from './vfx';

beforeEach(() => {
  useUiStore.setState({ reducedMotion: false });
});

describe('vfx: детерминированность и гейты', () => {
  it('конфетти детерминированы: один seed — один кадр (SSR и гидратация обязаны совпасть)', () => {
    const a = render(<ConfettiFall pieces={12} seed={11} />);
    const b = render(<ConfettiFall pieces={12} seed={11} />);
    expect(a.container.querySelectorAll('i').length).toBe(12);
    expect(a.container.innerHTML).toBe(b.container.innerHTML);
  });

  it('разный seed — разный кадр, иначе залп выглядел бы копией', () => {
    const a = render(<ConfettiFall pieces={8} seed={1} />);
    const b = render(<ConfettiFall pieces={8} seed={2} />);
    expect(a.container.innerHTML).not.toBe(b.container.innerHTML);
  });

  it('залп брызг детерминирован и ссылается только на слоты палитры', () => {
    const a = render(<SplatBurst pieces={6} seed={5} />);
    const b = render(<SplatBurst pieces={6} seed={5} />);
    expect(a.container.innerHTML).toBe(b.container.innerHTML);
    for (const img of Array.from(a.container.querySelectorAll('img'))) {
      expect(img.getAttribute('src')).toMatch(/^\/art\/vfx\/splats\/(acid|magenta|cyan|orange)-[abc]\.webp$/);
    }
  });

  it('reduced-motion: конфетти и залп не рендерятся вовсе', () => {
    useUiStore.setState({ reducedMotion: true });
    expect(render(<ConfettiFall />).container.firstChild).toBeNull();
    expect(render(<SplatBurst />).container.firstChild).toBeNull();
  });

  it('брызг и лучи указывают на закоммиченные webp-слоты', () => {
    expect(render(<SplatBackdrop color="magenta" variant="b" />).container.querySelector('img')!.getAttribute('src'))
      .toBe('/art/vfx/splats/magenta-b.webp');
    expect(render(<BeamPillar color="gold" />).container.querySelector('img')!.getAttribute('src'))
      .toBe('/art/vfx/beams/broad.webp');
    expect(render(<BeamPillar color="cyan" />).container.querySelector('img')!.getAttribute('src'))
      .toBe('/art/vfx/beams/narrow.webp');
  });

  it('редкость мапится в палитру и форму без новых цветов', () => {
    expect(raritySplat(8)).toEqual({ color: 'acid', variant: 'c' });
    expect(raritySplat(6)).toEqual({ color: 'orange', variant: 'a' });
    expect(raritySplat(4)).toEqual({ color: 'magenta', variant: 'b' });
    expect(raritySplat(2)).toEqual({ color: 'cyan', variant: 'c' });
  });
});
