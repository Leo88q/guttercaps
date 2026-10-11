import { expect, it } from 'vitest';
import { MATCHMAKING } from '@guttercaps/economy';
import { huntRemaining } from './QueueHunt';

it('counts down to the bot-fill window and never goes negative', () => {
  expect(huntRemaining(1_000, 1_000)).toBe(MATCHMAKING.botFillAfterSec);
  expect(huntRemaining(1_000, 1_000 + 10_000)).toBe(MATCHMAKING.botFillAfterSec - 10);
  expect(huntRemaining(1_000, 1_000 + MATCHMAKING.botFillAfterSec * 1000)).toBe(0);
  expect(huntRemaining(1_000, 1_000 + 80_000)).toBe(0);
  expect(huntRemaining(Number.NaN, 1_000)).toBe(MATCHMAKING.botFillAfterSec);
});
