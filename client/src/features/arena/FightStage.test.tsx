// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { FightStage } from './FightStage';

afterEach(() => cleanup());

it('renders three slots per side even when a squad is empty', () => {
  const { container } = render(
    <FightStage
      left={[{ collection: 0, rarity: 2, level: 1 }]}
      right={[]}
      looping
    />,
  );
  expect(container.querySelectorAll('.fight-cap-a')).toHaveLength(3);
  expect(container.querySelectorAll('.fight-cap-b')).toHaveLength(3);
  expect(container.querySelectorAll('.fight-cap-b.live-slot')).toHaveLength(3);
  expect(container.querySelector('.fight-vs')?.textContent).toBe('VS');
});
