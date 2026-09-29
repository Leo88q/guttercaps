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
