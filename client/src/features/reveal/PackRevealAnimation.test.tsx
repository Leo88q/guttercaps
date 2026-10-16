// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { PackRevealAnimation } from './PackRevealAnimation';
import { LOCALES, setLocale, t } from '@/shared/i18n';

afterEach(async () => { cleanup(); vi.useRealTimers(); await setLocale('en'); });
describe('localized reveal keeps protocol effects', () => {
  for (const locale of LOCALES) {
    it(`${locale}: Diamond uses the Diamond effect, not Common fallback`, async () => {
      await setLocale(locale);
      vi.useFakeTimers();
      const { container } = render(<PackRevealAnimation rarity={8} chipName={t('catalog.c0r8.name')} onDone={() => {}} />);
      act(() => { vi.advanceTimersByTime(2800); });
      expect(container.querySelectorAll('.reveal-particle')).toHaveLength(72);
      expect(container.querySelector('.reveal-fx-diamond-flash')).not.toBeNull();
      act(() => { vi.advanceTimersByTime(550); });
      expect(screen.getByText(t('ui.rarity8'))).toBeTruthy();
      expect(screen.getByRole('button', { name: t('ui.continue') })).toBeTruthy();
    });
  }
});

// Флип на вскрытии (docs/16 §2.1): детерминирован редкостью, поэтому проверяется
// не «анимация вообще есть», а границы — до Epic тихо, Epic+ один флип, Legend
// во фьюжне два, тот же Legend из пака один.
const card = (container: HTMLElement) => container.querySelector('.reveal-chip-card');
// Diamond держит паузу 2800 мс + 550 мс на всплеск, поэтому запас один на всех.
const reveal = (ui: React.ReactElement, holdMs = 4000) => {
  vi.useFakeTimers();
  const out = render(ui);
  act(() => { vi.advanceTimersByTime(holdMs); });
  return out;
};

describe('trick flip on reveal (docs/16 §2.1)', () => {
  it('Common…Epic приходят без флипа — только всплеск', () => {
    for (const rarity of [0, 1, 2, 3, 4]) {
      const { container, unmount } = reveal(<PackRevealAnimation rarity={rarity} chipName="cap" onDone={() => {}} />);
      expect(card(container)?.className).not.toMatch(/reveal-card-flip/);
      unmount();
    }
  });

  it('Epic+ делает один кикфлип', () => {
    const { container } = reveal(<PackRevealAnimation rarity={5} chipName="cap" onDone={() => {}} />);
    expect(card(container)?.classList.contains('reveal-card-flip1')).toBe(true);
    expect(card(container)?.classList.contains('reveal-card-flip2')).toBe(false);
  });

  it('Legend из пака — один флип, из фьюжна — двойной', () => {
    const pack = reveal(<PackRevealAnimation rarity={6} chipName="cap" onDone={() => {}} />);
    expect(card(pack.container)?.classList.contains('reveal-card-flip1')).toBe(true);
    pack.unmount();

    const fusion = reveal(<PackRevealAnimation rarity={6} chipName="cap" fused onDone={() => {}} />);
    expect(card(fusion.container)?.classList.contains('reveal-card-flip2')).toBe(true);
    expect(card(fusion.container)?.classList.contains('reveal-card-flip1')).toBe(false);
  });

  it('Diamond во фьюжне — верхняя граница: тоже двойной', () => {
    const { container } = reveal(<PackRevealAnimation rarity={8} chipName="cap" fused onDone={() => {}} />);
    expect(card(container)?.classList.contains('reveal-card-flip2')).toBe(true);
  });
});
