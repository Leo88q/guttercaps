// =============================================================================
// GUTTERCAPS economy — «Линия»: заезды (docs/16 §5.1–5.3)
// -----------------------------------------------------------------------------
// Здесь лежит ровно то, что обязано совпадать у клиента и сервера: раскладка
// дня и пересчёт очков. Клиент проигрывает заезд по этой же функции тик за
// тиком; сервер прогоняет её целиком по присланному реплею и верит только
// своему результату (§5.2 — честность переигрыванием, как проверка решения
// в Решётке). Две реализации разошлись бы ровно один раз — и доска недели
// перестала бы быть доской.
//
// Чего здесь нет: денег. Награды за заезд — cosmetics-трек (pass XP) и
// существующие предметы Флудгрида (подсказки, клапаны); ни одной новой монеты
// $CG, квоты квестов 25/140 не двигаются (docs/02 §5, решение E владельца).
// =============================================================================

import { Rng, hashString } from './gridEngine.ts';

/** Милли-единицы не нужны: вся арифметика очков целочисленная (BPS-множители). */
export const LINE = {
  /** Тиков в секунду. Реплей — список (тик, действие), поэтому частота задаёт точность ввода. */
  tickHz: 50,
  /** 45 секунд линии (docs/16 §5.1). */
  runSeconds: 45,
  /** Единиц пути в секунду: 9000 / 200 = 45 с ровно. */
  speed: 200,
  /** Длина трассы в единицах пути. */
  trackLength: 9000,
  /** Прыжок: 1,1 с в воздухе → 220 единиц пути. */
  hopTicks: 55,
  /** Трамплин: 1,5 с в воздухе → 300 единиц пути. */
  kickTicks: 75,
  /** Сколько тиков райдер поднимается после падения (bail). */
  bailTicks: 25,
  /** Очков за тик в воздухе (55 тиков прыжка = 55 очков). */
  airPointsPerTick: 1,
  /** Грэб умножает воздушный трюк: 1600 BPS = ×1,6. */
  grabBps: 1600,
  /** Очков за тик гринда (75 тиков перил = 150 очков). */
  grindPointsPerTick: 2,
  /** Множитель комбо: старт ×1,0, +0,1 за звено, потолок ×5 (docs/16 §5.1). */
  comboStartBps: 1000,
  comboStepBps: 100,
  comboCapBps: 5000,
  /** Бесплатных заездов в день. */
  freeRunsPerDay: 3,
  /** Платных заездов в день сверх бесплатных: потолок стока, а не «сколько угодно». */
  maxPaidRunsPerDay: 5,
  /** Цена дополнительного заезда: 30 $CG, сжигаются — та же точка цены, что у Глубокого паводка. */
  extraRunCgMicro: 30_000_000,
  /** Потолок вводов в реплее: 45 с × 50 Гц = 2250 тиков, но 400 нажатий за заезд — за глаза. */
  maxInputs: 400,
  /** pass XP за заезд: очки/150 (золото ≈ как вскрытие пака), но не больше потолка. */
  passXpDivisor: 150,
  passXpCap: 60,
} as const;

export const LINE_TICKS = LINE.runSeconds * LINE.tickHz;
/** Единиц пути за тик: позиция считается умножением, без накопления ошибки. */
export const LINE_UNITS_PER_TICK = LINE.speed / LINE.tickHz;

// ---------------------------------------------------------------- раскладка

export type LineFeatureKind = 'gap' | 'rail' | 'kicker' | 'bump';

export interface LineFeature {
  kind: LineFeatureKind;
  /** Начало препятствия в единицах пути. */
  start: number;
  /** Длина вдоль трассы. */
  len: number;
}

export interface LineLayout {
  day: number;
  seed: number;
  ticks: number;
  length: number;
  features: LineFeature[];
}

/** Сид дня: один на всех, тот же приём, что у ежедневного сида Решётки. */
export const lineSeed = (day: number): number => hashString(`guttercaps:line:${day}`);

const LEN: Record<LineFeatureKind, [number, number]> = {
  // Пролёт: 120–200 при 220 единицах воздуха — окно нажатия ~0,2 с, по силам с телефона.
  gap: [120, 200],
  // Перила: чем длиннее, тем дороже грэб по времени.
  rail: [160, 420],
  // Трамплин всегда короткий: он не препятствие, а возможность.
  kicker: [80, 80],
  // Бордюр: мелкая помеха, которую просто перепрыгнуть.
  bump: [60, 100],
};

/**
 * Раскладка дня. Одна на всех игроков (docs/16 §5.1): «сегодня все катают одну
 * чашу». Между препятствиями — ровный участок, иначе линия превращается в
 * полосу препятствий, где всё решает удача, а не тайминг.
 */
export function lineLayout(day: number): LineLayout {
  const seed = lineSeed(day);
  const rng = new Rng(seed);
  const features: LineFeature[] = [];
  const kinds: LineFeatureKind[] = ['gap', 'rail', 'kicker', 'bump'];
  const weights = [3, 3, 2, 2]; // на 10 препятствий: 3 пролёта, 3 перила, 2 трамплина, 2 бордюра
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let pos = 700; // 3,5 с на разгон до первого препятствия
  const end = LINE.trackLength - 500;
  while (pos < end) {
    let r = rng.nextInt(totalWeight);
    let kind: LineFeatureKind = 'gap';
    for (let i = 0; i < kinds.length; i++) { if (r < weights[i]) { kind = kinds[i]; break; } r -= weights[i]; }
    const [min, max] = LEN[kind];
    const len = min + rng.nextInt(max - min + 1);
    features.push({ kind, start: pos, len });
    // после перил оставляем больше места: с них надо уйти, а не сразу прыгать
    const flat = 250 + rng.nextInt(200) + (kind === 'rail' ? 150 : 0);
    pos += len + flat;
  }
  return { day, seed, ticks: LINE_TICKS, length: LINE.trackLength, features };
}

/**
 * Высота над землёй для отрисовки: парабола через максимум, без интегрирования.
 * Максимумы взяты из физики прыжка (v²/2g): 79 и 146 единиц пути.
 */
export const airHeight = (total: number, left: number): number => {
  if (total <= 0 || left <= 0) return 0;
  const f = (total - left) / total;
  const hMax = total === LINE.kickTicks ? 146 : 79;
  return hMax * 4 * f * (1 - f);
};

/** Препятствие под точкой пути (или null, если это ровный асфальт). */
export const featureAt = (layout: LineLayout, pos: number): LineFeature | null => {
  for (const f of layout.features) if (pos >= f.start && pos < f.start + f.len) return f;
  return null;
};

// ------------------------------------------------------------------ реплей

/** 0 = прыжок (hop), 1 = грэб в воздухе. Реплей — это и есть весь ввод. */
export type LineAction = 0 | 1;
export const LINE_HOP: LineAction = 0;
export const LINE_GRAB: LineAction = 1;

export interface RunInput {
  tick: number;
  action: LineAction;
}

export interface RunTrick {
  kind: 'air' | 'grind';
  /** Тик, на котором трюк закрыт. */
  tick: number;
  /** Базовые очки до множителя. */
  base: number;
  /** Множитель комбо в BPS. */
  multBps: number;
  /** Что попало в копилку. */
  gained: number;
  grabbed: boolean;
}

export interface RunResult {
  score: number;
  /** Звеньев в лучшей связке. */
  bestCombo: number;
  /** Закрытых трюков за заезд. */
  tricks: number;
  bails: number;
  ticks: number;
  log: RunTrick[];
}

export interface RunState {
  tick: number;
  pos: number;
  /** Высота над землёй в единицах пути (для отрисовки). */
  y: number;
  air: boolean;
  grinding: boolean;
  stunned: number;
  grabbed: boolean;
  /** Накоплено в текущей связке, но ещё не заbankено. */
  unbanked: number;
  banked: number;
  links: number;
  bails: number;
  finished: boolean;
}

// ------------------------------------------------------------------ симуляция

/**
 * Шагатель заезда. Один и тот же объект крутит живой заезд на клиенте (тик за
 * кадром) и пересчитывает присланный реплей на сервере.
 */
export interface RunStepper {
  /** Продвинуть один тик, применив вводы, попадающие в этот тик. */
  step(inputs?: readonly RunInput[]): RunState;
  state(): RunState;
  result(): RunResult;
}

export function createRun(layout: LineLayout): RunStepper {
  let tick = 0;
  let airTotal = 0;
  let airLeft = 0;
  let grinding = false;
  let grindTicks = 0;
  let grindRail: LineFeature | null = null;
  let grabbed = false;
  let stunned = 0;
  let unbanked = 0;
  let banked = 0;
  let links = 0;
  let bails = 0;
  let bestCombo = 0;
  let trickCount = 0;
  let lastKicker: LineFeature | null = null;
  const log: RunTrick[] = [];

  const multBps = () => Math.min(LINE.comboCapBps, LINE.comboStartBps + LINE.comboStepBps * links);

  const link = (base: number, kind: RunTrick['kind'], grabbedFlag: boolean) => {
    const m = multBps();
    const gained = Math.floor((base * m) / 1000);
    unbanked += gained;
    links += 1;
    trickCount += 1;
    if (links > bestCombo) bestCombo = links;
    log.push({ kind, tick, base, multBps: m, gained, grabbed: grabbedFlag });
  };

  /** Приземление банкует связку: незаbankенное пропадает только при падении. */
  const bank = () => { banked += unbanked; unbanked = 0; };

  const bail = () => {
    bails += 1;
    unbanked = 0;
    links = 0;
    stunned = LINE.bailTicks;
    airLeft = 0;
    airTotal = 0;
    grinding = false;
    grindRail = null;
    grabbed = false;
  };

  const state = (): RunState => ({
    tick,
    pos: tick * LINE_UNITS_PER_TICK,
    y: airHeight(airTotal, airLeft),
    air: airLeft > 0,
    grinding,
    stunned,
    grabbed,
    unbanked,
    banked,
    links,
    bails,
    finished: tick >= LINE_TICKS,
  });

  const step = (inputs?: readonly RunInput[]): RunState => {
    if (tick >= LINE_TICKS) return state();
    const pos = tick * LINE_UNITS_PER_TICK;
    const at = featureAt(layout, pos);

    if (stunned > 0) {
      stunned -= 1;
      tick += 1;
      return state();
    }

    // 1. Ввод этого тика.
    for (const i of inputs ?? []) {
      if (i.action === LINE_HOP) {
        if (airLeft === 0 && !grinding) {
          airTotal = LINE.hopTicks; airLeft = LINE.hopTicks; grabbed = false;
        }
      } else if (airLeft > 0 && !grabbed) grabbed = true;
    }

    // 2. Трамплин подкидывает сам: это возможность, а не наказание.
    if (!grinding && airLeft === 0 && at && at.kind === 'kicker' && at !== lastKicker) {
      lastKicker = at;
      airTotal = LINE.kickTicks; airLeft = LINE.kickTicks; grabbed = false;
    }
    if (!at || at.kind !== 'kicker') lastKicker = null;

    // 3. Воздух.
    if (airLeft > 0) {
      airLeft -= 1;
      if (airLeft === 0) {
        const landing = featureAt(layout, tick * LINE_UNITS_PER_TICK);
        const base = Math.floor((airTotal * LINE.airPointsPerTick * (grabbed ? LINE.grabBps : 1000)) / 1000);
        if (landing && landing.kind === 'gap') {
          // приземлился в дыру
          bail();
        } else {
          link(base, 'air', grabbed);
          grabbed = false;
          if (landing && landing.kind === 'rail') {
            grinding = true; grindTicks = 0; grindRail = landing;
          } else {
            bank();
          }
        }
      }
    } else if (grinding) {
      // 4. Гринд: держимся, пока под нами перила.
      if (!grindRail || pos >= grindRail.start + grindRail.len) {
        link(grindTicks * LINE.grindPointsPerTick, 'grind', false);
        grinding = false; grindRail = null;
        bank();
      } else {
        grindTicks += 1;
      }
    }

    // 5. Помеха на земле: пролёт и бордюр ловят того, кто не в воздухе и не на перилах.
    if (!grinding && airLeft === 0 && stunned === 0 && at && (at.kind === 'gap' || at.kind === 'bump')) bail();

    tick += 1;
    // 6. Финиш: незакрытый воздух закрываем, связку банкуем — трасса кончилась, а не райдер упал.
    if (tick >= LINE_TICKS && airLeft > 0) {
      const base = Math.floor((airTotal * LINE.airPointsPerTick * (grabbed ? LINE.grabBps : 1000)) / 1000);
      link(base, 'air', grabbed);
      airLeft = 0;
      bank();
    }
    return state();
  };

  const result = (): RunResult => ({
    score: banked + unbanked, bestCombo, tricks: trickCount, bails, ticks: Math.min(tick, LINE_TICKS), log,
  });

  return { step, state, result };
}

/** Полный пересчёт реплея: ровно то, чем сервер проверяет присланные очки. */
export function simulateRun(layout: LineLayout, inputs: readonly RunInput[]): RunResult {
  const byTick = new Map<number, LineAction[]>();
  for (const i of inputs) {
    const t = i.tick | 0;
    if (t < 0 || t >= LINE_TICKS) continue; // ввод вне трассы — вне заезда
    const list = byTick.get(t);
    if (list) list.push(i.action);
    else byTick.set(t, [i.action]);
  }
  const run = createRun(layout);
  for (let t = 0; t < LINE_TICKS; t++) {
    const acts = byTick.get(t);
    run.step(acts ? acts.map((action) => ({ tick: t, action })) : undefined);
  }
  return run.result();
}

// ------------------------------------------------------------------- награды

export type LineTier = 'none' | 'bronze' | 'silver' | 'gold';

/**
 * Пороги очков. Числа не придуманы: их держит тест, который проезжает день
 * «ботом» (прыжок ровно за тик до препятствия) и сравнивает результат с
 * порогом — порог двигается вместе с раскладкой, а не наоборот.
 */
export const LINE_TIERS: ReadonlyArray<{ tier: LineTier; score: number }> = [
  { tier: 'gold', score: 3000 },
  { tier: 'silver', score: 2000 },
  { tier: 'bronze', score: 800 },
];

export function lineTier(score: number): LineTier {
  for (const t of LINE_TIERS) if (score >= t.score) return t.tier;
  return 'none';
}

export const TIER_ORDER: readonly LineTier[] = ['none', 'bronze', 'silver', 'gold'];

/** pass XP за заезд: cosmetics-трек, не монеты. */
export const runPassXp = (score: number): number =>
  Math.max(0, Math.min(LINE.passXpCap, Math.floor(score / LINE.passXpDivisor)));

/**
 * Предметы — только существующие и только один раз в день за лучший заезд:
 * подсказки и клапаны Флудгрида упираются в те же потолки стока, что у квестов
 * и сезонного пропуска. Платные заезды покупают попытку и очки на доске, а не
 * ещё одну горсть предметов.
 */
export const LINE_ITEM_REWARDS: Record<LineTier, { hints: number; valve: boolean }> = {
  none: { hints: 0, valve: false },
  bronze: { hints: 0, valve: false },
  silver: { hints: 1, valve: false },
  gold: { hints: 1, valve: true },
};
