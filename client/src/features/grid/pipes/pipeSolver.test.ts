// Селфтест гидравлического решателя (входящий модуль, 2026-10-18):
// оригинальный pipeSolver.selftest.ts гоняет независимые проверки Darcy–Weisbach
// и законы сохранения и БРОСАЕТ исключение при первом провале — импорт в этом
// файле и есть тест. Своих ассертов здесь нет намеренно.
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import './pipeSolver.selftest';

describe('pipeSolver — входящий гидравлический решатель', () => {
  it('селфтест выполнен без провалов (иначе импорт выше упал бы)', () => {
    expect(true).toBe(true);
  });
});
