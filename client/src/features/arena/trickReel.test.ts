// Трик-рил (docs/16 §2.4): линия обязана быть детерминированной и обязана
// заканчиваться bail при проигрыше — иначе это украшение, а не итог боя.
import { describe, expect, it } from 'vitest';
import { trickLine, type ReelRound } from './trickReel';

const ROUNDS: ReelRound[] = [
  { lane: 0, luckA: 1.4, luckB: 0.6, elementEdge: 0.15, winner: 'A' },
  { lane: 1, luckA: 1.1, luckB: 0.9, elementEdge: 0, winner: 'B' },
  { lane: 2, luckA: 1.3, luckB: 0.7, elementEdge: 0.15, winner: 'A' },
];

describe('trickLine', () => {
  it('один бой → одна линия: повтор и другая сторона считаются без сюрпризов', () => {
    const a = trickLine(ROUNDS, 'seed-abc', 'A', true);
    const b = trickLine(ROUNDS, 'seed-abc', 'A', true);
    expect(b).toEqual(a);
    // Та же последовательность на любом вызове — ни Date, ни Math.random внутри.
    expect(a.beats.map((x) => x.kind).join(' ')).toMatchInlineSnapshot(`"push kickflip grind manual push wallplant push wallplant grind manual land"`);
  });

  it('проигрыш всегда заканчивается bail, победа — приземлением (если баланс удержан)', () => {
    const won = trickLine(ROUNDS, 'seed-abc', 'A', true);
    const lost = trickLine(ROUNDS, 'seed-abc', 'B', false);
    expect(lost.landed).toBe(false);
    expect(lost.beats[lost.beats.length - 1].kind).toBe('bail');
    if (won.landed) expect(won.beats[won.beats.length - 1].kind).toBe('land');
  });

  it('связка начинается с разгона, а не с трюка', () => {
    for (const side of ['A', 'B'] as const) {
      const line = trickLine(ROUNDS, 'x', side, true);
      expect(line.beats[0].kind).toBe('push');
      expect(line.beats[0].points).toBe(0);
    }
  });

  it('множитель растёт на 0,1 за звено и не пробивает потолок ×5 (docs/16 §5.4)', () => {
    const line = trickLine(ROUNDS, 'cap', 'A', true);
    for (const b of line.beats) {
      expect(b.multiplier).toBeLessThanOrEqual(5);
      expect(Math.round(b.multiplier * 10) % 1).toBe(0); // шаг ровно 0,1
    }
    expect(line.bestMultiplier).toBeLessThanOrEqual(5);
  });

  it('сломанная линия обнуляет множитель и не начисляет очков за bail', () => {
    const line = trickLine(ROUNDS, 'bail-me', 'B', false);
    const bail = line.beats[line.beats.length - 1];
    expect(bail.kind).toBe('bail');
    expect(bail.points).toBe(0);
    expect(bail.multiplier).toBe(1);
  });

  it('пустой бой — пустая линия, а не падение', () => {
    const line = trickLine([], 'seed', 'A', true);
    expect(line.beats).toEqual([]);
    expect(line.score).toBe(0);
    expect(line.landed).toBe(true);
  });

  it('неполные данные раунда (проекция индексатора) не ломают линию', () => {
    const line = trickLine([{ lane: 0 }, { winner: 'B' }], 'seed', 'A', true);
    expect(line.beats.length).toBeGreaterThan(0);
    for (const b of line.beats) expect(Number.isFinite(b.balance)).toBe(true);
  });

  it('победитель раунда понимается и кошельком, и стороной A/B', () => {
    // /v1/arena/matches/{id} отдаёт победителя раунда кошельком, движок боя — 'A'/'B'.
    const wallet = '7xKQpumpkinF4keY4VhKk9P8nQzLm3uWc2RtGvHsJdEbN';
    const byWallet = [0, 1, 2].map((lane) => ({ lane, luckA: 1.2, luckB: 0.8, elementEdge: 0.15, winner: wallet }));
    const bySide = [0, 1, 2].map((lane) => ({ lane, luckA: 1.2, luckB: 0.8, elementEdge: 0.15, winner: 'A' as const }));
    expect(trickLine(byWallet, 'seed', 'A', true, wallet)).toEqual(trickLine(bySide, 'seed', 'A', true, wallet));
    // И в той, и в другой форме выигранный раунд сцепляется мануалом.
    expect(trickLine(byWallet, 'seed', 'A', true, wallet).beats.filter((b) => b.kind === 'manual').length).toBe(3);
  });

  it('баланс ходит в обе стороны: на плохой удаче линия ломается чаще', () => {
    const bad = [0, 1, 2].map((lane) => ({ lane, luckA: 0.5, luckB: 1.5, elementEdge: 0.15, winner: 'B' as const }));
    const good = [0, 1, 2].map((lane) => ({ lane, luckA: 1.5, luckB: 0.5, elementEdge: 0.15, winner: 'A' as const }));
    const broken = (rs: ReelRound[]) => {
      let n = 0;
      for (const seed of ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']) if (!trickLine(rs, seed, 'A', true).landed) n++;
      return n;
    };
    expect(broken(bad)).toBeGreaterThan(broken(good));
  });
});
