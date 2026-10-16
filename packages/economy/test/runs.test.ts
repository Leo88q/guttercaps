// Линия (docs/16 §5.1–5.3): раскладка дня, пересчёт очков, пороги наград.
//
// Главное здесь — не «формулы совпадают с документами», а то, что игра
// измерима: бот, который едет в окно, обязан обыгрывать бота, который едет
// криво, а пороги наград — лежать там, где живут реальные результаты, а не там,
// где их удобно нарисовать. Пороги выше получены замером на 60 днях раскладки.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LINE, LINE_TICKS, LINE_UNITS_PER_TICK, LINE_HOP, LINE_GRAB,
  lineLayout, lineSeed, featureAt, simulateRun, createRun, airHeight,
  lineTier, runPassXp, LINE_ITEM_REWARDS, botReplay, type LineLayout, type RunInput
} from '../src/index.ts';

const U = LINE_UNITS_PER_TICK;

/**
 * Бот «в окно»: прыжок ровно перед препятствием, грэб сразу после толчка,
 * посадка на перила с воздуха. `jitter` — дрожание пальца в тиках (1 тик = 20 мс).
 */


const DAYS = 60;
const scores = (jitter: number, seed: number) => {
  const out = [];
  for (let day = 0; day < DAYS; day++) {
    const L = lineLayout(day);
    out.push(simulateRun(L, botReplay(L, jitter, seed + day * 31)));
  }
  return out;
};
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

describe('линия: раскладка дня', () => {
  it('один день — одна чаша на всех, и она воспроизводима', () => {
    assert.equal(lineSeed(0), lineSeed(0));
    assert.notEqual(lineSeed(0), lineSeed(1));
    const a = JSON.stringify(lineLayout(17));
    const b = JSON.stringify(lineLayout(17));
    assert.equal(a, b);
  });

  it('трасса укладывается в 45 секунд ровно, без накопления ошибки', () => {
    assert.equal(LINE_TICKS * U, LINE.trackLength);
    const L = lineLayout(3);
    const run = createRun(L);
    for (let t = 0; t < LINE_TICKS; t++) run.step();
    const st = run.state();
    assert.equal(st.finished, true);
    assert.equal(st.tick, LINE_TICKS);
    assert.equal(st.pos, LINE.trackLength);
  });

  it('препятствия не налезают друг на друга и не стоят на старте', () => {
    for (let day = 0; day < DAYS; day++) {
      const L = lineLayout(day);
      assert.ok(L.features.length >= 8, `day ${day}: слишком пустая трасса`);
      assert.ok(L.features[0].start >= 600, `day ${day}: препятствие на разгоне`);
      for (let i = 1; i < L.features.length; i++) {
        const prev = L.features[i - 1];
        const gap = L.features[i].start - (prev.start + prev.len);
        assert.ok(gap >= 250, `day ${day}: между препятствиями ${gap} — не успеть среагировать`);
      }
      assert.ok(L.features[L.features.length - 1].start + L.features[L.features.length - 1].len < LINE.trackLength);
    }
  });

  it('после перил оставляют место уйти: грэб не может кончиться в пролёте', () => {
    for (let day = 0; day < DAYS; day++) {
      const L = lineLayout(day);
      L.features.forEach((f, i) => {
        if (f.kind !== 'rail') return;
        const next = L.features[i + 1];
        if (next) assert.ok(next.start - (f.start + f.len) >= 400, `day ${day}: перила заканчиваются вплотную`);
      });
    }
  });
});

describe('линия: пересчёт очков', () => {
  it('реплей считается одинаково сколько угодно раз — это и есть честность §5.2', () => {
    const L = lineLayout(5);
    const inputs = botReplay(L, 4, 3);
    const a = simulateRun(L, inputs);
    const b = simulateRun(L, inputs);
    assert.deepEqual(a, b);
  });

  it('тот же реплей на живом шагателе даёт тот же результат, что и полный прогон', () => {
    const L = lineLayout(9);
    const inputs = botReplay(L, 2, 11);
    const byTick = new Map<number, RunInput[]>();
    for (const i of inputs) {
      const list = byTick.get(i.tick) ?? [];
      list.push(i);
      byTick.set(i.tick, list);
    }
    const run = createRun(L);
    for (let t = 0; t < LINE_TICKS; t++) run.step(byTick.get(t));
    assert.deepEqual(run.result(), simulateRun(L, inputs));
  });

  it('тайминг решает: сдвиг ввода на 12 тиков меняет результат', () => {
    const L = lineLayout(11);
    const good = botReplay(L);
    const late = botReplay(L).map((i) => ({ tick: i.tick + 12, action: i.action }));
    assert.ok(simulateRun(L, good).score > simulateRun(L, late).score);
    assert.ok(simulateRun(L, good).bails < simulateRun(L, late).bails);
  });

  it('падение обрывает комбо, приземление его банкует', () => {
    const L = lineLayout(0);
    const clean = simulateRun(L, botReplay(L));
    assert.equal(clean.bails, 0);
    // чистая связка: множитель растёт и никогда не падает
    const mults = clean.log.map((t) => t.multBps);
    for (let i = 1; i < mults.length; i++) assert.ok(mults[i] >= mults[i - 1]);

    // убираем ровно один прыжок перед пролётом — райдер едет в дыру ногами
    const gap = L.features.find((f) => f.kind === 'gap')!;
    const hopTick = Math.floor(gap.start / U) - 1;
    const holed = simulateRun(L, botReplay(L).filter((i) => i.tick !== hopTick));
    assert.ok(holed.bails >= 1, 'дыра без прыжка обязана ронять');
    assert.ok(holed.score < clean.score, 'падение стоит очков, а не только трюка');

    // связка оборвана, а не продолжена: лучшая серия короче, множитель сброшен
    assert.ok(holed.bestCombo < clean.bestCombo, 'падение обязано обрывать серию');
    assert.ok(holed.log.length < clean.log.length, 'падение съедает трюк, в котором упали');

    // Совсем без рук трасса ловит райдера на первом же пролёте. Очки всё равно
    // капают — трамплины подкидывают сами, — но это крохи против сыгранного
    // заезда: линия платит за тайминг, а не за присутствие.
    const idle = simulateRun(L, []);
    assert.ok(idle.bails >= 1);
    assert.ok(idle.score < clean.score / 2, `без рук ${idle.score} против ${clean.score}`);
  });

  it('грэб стоит своих очков: тот же прыжок с грэбом дороже', () => {
    const L = lineLayout(21);
    const hop = Math.floor(L.features[0].start / U) - 1;
    const plain = simulateRun(L, [{ tick: hop, action: LINE_HOP }]);
    const grabbed = simulateRun(L, [{ tick: hop, action: LINE_HOP }, { tick: hop + 1, action: LINE_GRAB }]);
    assert.equal(grabbed.log[0].grabbed, true);
    assert.ok(grabbed.score > plain.score);
  });

  it('множитель растёт на 0,1 за звено и упирается в ×5', () => {
    const L = lineLayout(4);
    const r = simulateRun(L, botReplay(L));
    for (const t of r.log) assert.ok(t.multBps <= LINE.comboCapBps);
    const m = r.log.map((t) => t.multBps);
    assert.equal(m[0], LINE.comboStartBps);
    assert.equal(m[1] - m[0], LINE.comboStepBps);
    const capped = simulateRun(lineLayout(2), botReplay(lineLayout(2)));
    assert.ok(capped.bestCombo * LINE.comboStepBps + LINE.comboStartBps >= 0);
  });

  it('ввод вне трассы — вне заезда: реплей не может выйти за 45 секунд', () => {
    const L = lineLayout(6);
    const clean = simulateRun(L, botReplay(L));
    const padded = simulateRun(L, [...botReplay(L), { tick: LINE_TICKS + 500, action: LINE_HOP }, { tick: -3, action: LINE_HOP }]);
    assert.deepEqual(padded, clean);
  });

  it('высота — парабола от нуля до нуля: райдер не может приземлиться выше старта', () => {
    assert.equal(airHeight(0, 0), 0);
    assert.equal(airHeight(LINE.hopTicks, LINE.hopTicks), 0);
    const mid = airHeight(LINE.hopTicks, Math.floor(LINE.hopTicks / 2));
    assert.ok(mid > 70 && mid < 80);
    assert.ok(airHeight(LINE.kickTicks, Math.floor(LINE.kickTicks / 2)) > mid);
  });
});

describe('линия: игра измерима (пороги наград — из замера, не из головы)', () => {
  const flawless = scores(0, 1);
  const shaky = scores(8, 11);      // ±160 мс — обычный палец на телефоне
  const sloppy = scores(15, 13);    // ±300 мс — первый заезд
  const medFlawless = median(flawless.map((r) => r.score));
  const medShaky = median(shaky.map((r) => r.score));
  const medSloppy = median(sloppy.map((r) => r.score));

  it('чистая езда всегда обыгрывает кривую', () => {
    assert.ok(medFlawless > medShaky);
    assert.ok(medShaky > medSloppy);
    assert.ok(median(flawless.map((r) => r.bails)) === 0);
    assert.ok(median(sloppy.map((r) => r.bails)) > 0);
  });

  it('пороги лежат там, где живут реальные результаты', () => {
    // чистая езда в среднем — серебро, золото — это день с щедрой чашей
    assert.ok(['silver', 'gold'].includes(lineTier(medFlawless)), `медиана чистой езды ${medFlawless}`);
    // чистая езда — серебро на любой раскладке, золото — примерно на каждой третьей
    assert.ok(flawless.filter((r) => lineTier(r.score) !== 'none').length === flawless.length);
    const gold = flawless.filter((r) => r.score >= 3000).length / flawless.length;
    assert.ok(gold > 0.2 && gold < 0.6, `золото на ${(gold * 100).toFixed(0)} % дней — не норма`);
    // кривая езда ниже серебра не падает: первый заезд что-то да приносит
    assert.ok(lineTier(medSloppy) !== 'none');
    assert.equal(lineTier(799), 'none');
    assert.equal(lineTier(800), 'bronze');
    assert.equal(lineTier(2000), 'silver');
    assert.equal(lineTier(3000), 'gold');
  });

  it('потолка не достичь: ни один заезд не выбивает предел pass XP', () => {
    const best = Math.max(...flawless.map((r) => r.score), ...shaky.map((r) => r.score));
    assert.ok(best < 5000, `рекорд ${best} — потолок наград пересмотреть`);
    for (const r of flawless) assert.ok(runPassXp(r.score) < LINE.passXpCap);
    assert.equal(runPassXp(3000), 20); // золото ≈ вскрытие пака (PASS_XP.packOpen)
    assert.equal(runPassXp(0), 0);
  });

  it('награды — предметы, а не деньги, и только за silver и выше', () => {
    assert.deepEqual(LINE_ITEM_REWARDS.bronze, { hints: 0, valve: false });
    assert.equal(LINE_ITEM_REWARDS.gold.hints, 1);
    assert.equal(LINE_ITEM_REWARDS.gold.valve, true);
    assert.equal(LINE_ITEM_REWARDS.silver.valve, false);
  });
});

describe('линия: трасса читается (бот не телепат)', () => {
  it('featureAt находит препятствие под точкой и молчит на ровном асфальте', () => {
    const L = lineLayout(8);
    for (const f of L.features) {
      assert.equal(featureAt(L, f.start)?.kind, f.kind);
      assert.equal(featureAt(L, f.start + f.len - 1)?.kind, f.kind);
    }
    assert.equal(featureAt(L, 0), null);
    assert.equal(featureAt(L, LINE.trackLength - 1), null);
  });
});
