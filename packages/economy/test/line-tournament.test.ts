// docs/16 §5.4 — платный вход в Линию: якоря, которые держит прогон.
//
// Здесь проверяется не сам симулятор, а вердикт: платный вход с призом в $CG
// ни при какой расстановке не стоит взноса, а конфигурация с косметическим
// призом проходит все четыре якоря экономики. Прогон, который умеет только
// говорить «да», не проверяет ничего, поэтому крайности обязаны падать.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PACK_VALUE_PER_CG, SCENARIOS, WAGER_EDGE_PER_CG, buildScoreTable, simulate,
  type Scenario,
} from '../scripts/line-tournament-sim.ts';

const table = buildScoreTable();
/** Короткий прогон: тест держит вердикт, а не пересчитывает отчёт. */
const quick = (s: Scenario) => simulate({ ...s, days: 30, field: 60, cluster: 4 }, table);
const byName = (needle: string) => {
  const s = SCENARIOS.find((x) => x.name.includes(needle));
  if (!s) throw new Error(`нет сценария «${needle}»`);
  return s;
};

describe('платный вход в Линию (docs/16 §5.4)', () => {
  it('якоря считаются из живых таблиц, а не вписаны руками', () => {
    // Пак возвращает 0.65 цены ценностью крышек, минус 10 % издержек маркета.
    assert.ok(PACK_VALUE_PER_CG > 0.5 && PACK_VALUE_PER_CG < 0.62, `${PACK_VALUE_PER_CG}`);
    // Край сильного игрока арены на ставке при pWin 0.8 и рейке 5 %.
    assert.ok(WAGER_EDGE_PER_CG > 0.4 && WAGER_EDGE_PER_CG < 0.6, `${WAGER_EDGE_PER_CG}`);
  });

  it('приз в $CG не окупает взнос ни в одной конфигурации — платить не за что', () => {
    for (const name of ['как в черновике', 'как Cap Slam', 'пак + рейк', 'взнос сжигается как пак', 'гибрид']) {
      const m = quick(byName(name));
      assert.equal(m.appeal.ok, false, `${name}: ценность ${m.totalValuePerCg.toFixed(3)} >= ${(PACK_VALUE_PER_CG * 0.9).toFixed(3)}`);
      assert.ok(m.totalValuePerCg < PACK_VALUE_PER_CG, `${name}: ${m.totalValuePerCg} < ${PACK_VALUE_PER_CG}`);
    }
  });

  it('ареновская конфигурация платит профи, но превращает линию из стока в денежный цикл', () => {
    const m = quick(byName('как Cap Slam'));
    const pro = m.cohorts[0];
    assert.ok(pro.returnPerCg > 1, `про в плюсе: ${pro.returnPerCg.toFixed(3)}`);
    // и именно поэтому она неприемлема: сжигание падает с 75 % до уровня ставки
    assert.ok(m.burnPerCg <= 0.05, `сжигание ${m.burnPerCg}`);
  });

  it('рекомендованная конфигурация: все четыре якоря пройдены и приз стоит взноса', () => {
    const m = quick(byName('РЕКОМЕНДАЦИЯ'));
    for (const a of m.anchors) assert.equal(a.ok, true, `${a.id}: ${a.detail}`);
    assert.equal(m.appeal.ok, true, m.appeal.detail);
    // $CG почти не возвращается в оборот — денежного цикла нет
    assert.ok(m.medianReturnPerCg < 0.15, `${m.medianReturnPerCg}`);
    // зато взнос — настоящий сток: 75 % сжигается
    assert.ok(m.burnPerCg >= 0.75, `${m.burnPerCg}`);
    // эмиссия не двигается: гвард упёрт в расписание, лишнее сжигание гасит чистую инфляцию
    assert.equal(m.emissionDeltaCg, 0);
    assert.ok(m.netInflationDeltaCg < 0, `${m.netInflationDeltaCg}`);
  });

  it('ферма не окупается: платные попытки разбавляют возврат', () => {
    const m = quick(byName('РЕКОМЕНДАЦИЯ'));
    const pro = m.cohorts[0];
    assert.ok(m.clusterReturnPerCg < pro.returnPerCg, `ферма ${m.clusterReturnPerCg} < про ${pro.returnPerCg}`);
  });

  it('модель умеет сказать «нет»: крайности валят якоря', () => {
    const faucet = quick(byName('резерв 300 %'));
    assert.ok(faucet.anchors.some((a) => !a.ok), 'дотация сверх бюджета событий обязана падать');
    const noBurn = quick(byName('сжигания нет'));
    assert.ok(noBurn.anchors.some((a) => !a.ok), 'пул без сжигания обязан падать');
  });

  it('в рекомендованной конфигурации ни одна когорта не выходит в плюс по $CG', () => {
    const m = quick(byName('РЕКОМЕНДАЦИЯ'));
    const best = Math.max(...m.cohorts.map((c) => c.returnPerCg), m.clusterReturnPerCg);
    assert.ok(best < 1, `лучший возврат ${best.toFixed(3)} — приза в $CG не хватает даже профи`);
    assert.equal(m.bestCohortExtractCgPerDay, 0); // и добывать в день нечего
  });
});
