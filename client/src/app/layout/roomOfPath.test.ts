import { describe, expect, it } from 'vitest';
import { roomOfPath } from './Shell';

// Комнаты навигации (2026-10-20): мобильный нижний бар и десктопные группы
// должны одинаково понимать, где игрок находится.
describe('roomOfPath', () => {
  it('главные разделы по комнатам', () => {
    expect(roomOfPath('/arena')).toBe('play');
    expect(roomOfPath('/grid')).toBe('play');
    expect(roomOfPath('/fusion')).toBe('play');
    expect(roomOfPath('/collection')).toBe('collection');
    expect(roomOfPath('/market')).toBe('collection');
    expect(roomOfPath('/bowl')).toBe('city');
    expect(roomOfPath('/pot')).toBe('city');
    expect(roomOfPath('/quests')).toBe('city');
    expect(roomOfPath('/')).toBe('menu');
    expect(roomOfPath('/guide')).toBe('menu');
    expect(roomOfPath('/profile')).toBe('menu');
  });

  it('подмаршруты принадлежат разделу: самое длинное совпадение побеждает', () => {
    expect(roomOfPath('/bowl/builder')).toBe('city');
    expect(roomOfPath('/bowl/wall/3')).toBe('city');
    expect(roomOfPath('/collection/chip/abc')).toBe('collection');
  });

  it('неизвестные маршруты не красят чужую комнату', () => {
    expect(roomOfPath('/legal/terms')).toBe('menu');
    expect(roomOfPath('/leaderboard/rating')).toBe('menu');
  });
});
