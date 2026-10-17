// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TrickReel } from './TrickReel';
import { trickLine, type ReelRound } from './trickLine';
import { setLocale, LOCALES, t } from '@/shared/i18n';

afterEach(async () => { cleanup(); vi.useRealTimers(); await setLocale('en'); });

const ROUNDS: ReelRound[] = [
  { lane: 0, luckA: 1.4, luckB: 0.6, elementEdge: 0.15, winner: 'A' },
  { lane: 1, luckA: 1.1, luckB: 0.9, elementEdge: 0, winner: 'B' },
];
const line = (won: boolean) => trickLine(ROUNDS, 'seed', 'A', won);

describe('TrickReel (docs/16 §2.4)', () => {
  it('играет линию по кадрам, а «пропустить» показывает её целиком', () => {
    vi.useFakeTimers();
    const { container } = render(<MemoryRouter><TrickReel line={line(true)} /></MemoryRouter>);
    const beats = () => container.querySelectorAll('.trick-beat.is-played').length;
    expect(beats()).toBe(0);
    // Пропуск — единственный способ увидеть всю линию, не дожидаясь таймеров.
    fireEvent.click(screen.getByRole('button', { name: t('arena.skipFight') }));
    expect(beats()).toBe(line(true).beats.length);
  });

  it('показывает баланс и прямо говорит: за линию не платят', async () => {
    for (const locale of LOCALES) {
      await setLocale(locale);
      const { container, unmount } = render(<MemoryRouter><TrickReel line={line(false)} /></MemoryRouter>);
      expect(container.querySelector('.trick-balance-mark')).not.toBeNull();
      expect(container.textContent).toContain(t('arena.reel.noReward'));
      expect(container.querySelector('a[href="/arena"]')?.textContent).toBe(t('arena.reel.rematch'));
      unmount();
    }
  });

  it('победителю предлагает ещё бой, а не реванш', () => {
    const { container } = render(<MemoryRouter><TrickReel line={line(true)} /></MemoryRouter>);
    expect(container.querySelector('a[href="/arena"]')?.textContent).toBe(t('arena.reel.again'));
  });
});
