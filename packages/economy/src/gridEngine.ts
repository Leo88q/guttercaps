// =============================================================================
// GUTTERCAPS — Floodgrid («Решётка») deterministic board engine.
// Canonical Floodgrid engine — same generator, seeds, par/hint rules,
// in Gutter City vocabulary (sector / sluice / charge socket).
// Pure and deterministic: client, backend PlayProof replay and tests all run
// this exact code, so a solution verified anywhere verifies everywhere.
// =============================================================================
/**
 * Детерминированный генератор псевдослучайных чисел (mulberry32).
 *
 * Требование проекта: одна и та же последовательность обязана получаться
 * в TS (клиент веб-прототипа, сервер) и в Kotlin (Android-приложение).
 * Поэтому здесь используется только 32-битная целочисленная арифметика,
 * которая переносится в Kotlin один-в-один (Int/UInt + ushr).
 */
export class Rng {
  private a: number;

  constructor(seed: number) {
    // Приводим seed к uint32, как это делает Kotlin (seed.toUInt().toInt())
    this.a = seed >>> 0;
  }

  /** Следующее 32-битное беззнаковое число. */
  nextU32(): number {
    let t = (this.a = (this.a + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Целое в диапазоне [0, n). */
  nextInt(n: number): number {
    if (n <= 0) throw new Error('nextInt: n must be > 0');
    return this.nextU32() % n;
  }

  /** Перемешивание на месте (Fisher–Yates). */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.nextInt(i + 1);
      const tmp = items[i];
      items[i] = items[j];
      items[j] = tmp;
    }
    return items;
  }
}

/** Стабильный хэш строки в uint32 (для seed из названия режима). */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Фрагменты магистрали («тайлы») и операции над ними.
 *
 * Порты кодируются битовой маской: N=1, E=2, S=4, W=8 (по часовой стрелке от севера).
 * Форма фрагмента однозначно определяется маской с точностью до поворота.
 */

export const N = 1;
export const E = 2;
export const S = 4;
export const W = 8;

/** Смещения соседей по битам портов. */
const DELTA: ReadonlyArray<readonly [number, number]> = [
  [0, -1], // N
  [1, 0], // E
  [0, 1], // S
  [-1, 0], // W
];

export function deltaForBit(bit: number): readonly [number, number] {
  const idx = Math.log2(bit) | 0;
  return DELTA[idx];
}

export function bitForIndex(idx: number): number {
  return 1 << idx;
}

/** Поворот маски на 90° по часовой стрелке. */
export function rotateCW(mask: number): number {
  return ((mask << 1) | (mask >>> 3)) & 0xf;
}

/** Поворот маски на r шагов по часовой стрелке (r = 0..3). */
export function rotateMask(mask: number, r: number): number {
  let m = mask;
  for (let i = 0; i < ((r % 4) + 4) % 4; i++) m = rotateCW(m);
  return m;
}

export function popcount(mask: number): number {
  let m = mask & 0xf;
  let c = 0;
  while (m) {
    c += m & 1;
    m >>>= 1;
  }
  return c;
}

export type TileKind = 'cap' | 'straight' | 'elbow' | 'tee' | 'cross';

/** Форма фрагмента по маске. */
export function kindOf(mask: number): TileKind {
  const pc = popcount(mask);
  if (pc === 1) return 'cap';
  if (pc === 2) return mask === (N | S) || mask === (E | W) ? 'straight' : 'elbow';
  if (pc === 3) return 'tee';
  if (pc === 4) return 'cross';
  throw new Error(`Недопустимая маска фрагмента: ${mask}`);
}

/** Каноническое представление орбиты поворотов (минимальная маска). */
export function orbitCanonical(mask: number): number {
  let best = mask;
  for (let r = 1; r < 4; r++) {
    const m = rotateMask(mask, r);
    if (m < best) best = m;
  }
  return best;
}

/** Число различных поворотов (4 — несимметричный, 2 — прямой, 1 — крест). */
export function orbitSize(mask: number): number {
  const set = new Set<number>();
  for (let r = 0; r < 4; r++) set.add(rotateMask(mask, r));
  return set.size;
}

/** Минимальный поворот r, при котором база совпадает с целевой маской. */
export function rotationToReach(base: number, target: number): number {
  for (let r = 0; r < 4; r++) {
    if (rotateMask(base, r) === target) return r;
  }
  throw new Error(`Маски ${base} и ${target} не совместимы`);
}

/** Кратчайшее расстояние между двумя поворотами по циклу периода period. */
export function circularDistance(a: number, b: number, period = 4): number {
  const d = (((b - a) % period) + period) % period;
  return Math.min(d, period - d);
}

/** Текстовый вид маски — для тестов и логов. */
export function maskToString(mask: number): string {
  return (
    (mask & N ? 'N' : '-') + (mask & E ? 'E' : '-') + (mask & S ? 'S' : '-') + (mask & W ? 'W' : '-')
  );
}

/**
 * Ядро головоломки: генерация квартала, проверка пломбы, подсказки.
 *
 * Правило победы: все ячейки квартала должны быть подключены к шине.
 * Генератор гарантирует, что решение существует: сначала строится связная
 * структура магистралей (остов + дополнительные рёбра), затем фрагменты
 * случайно разворачиваются.
 */

export interface Tile {
  /** Форма фрагмента. */
  kind: TileKind;
  /** Базовая (каноническая) маска фрагмента. */
  base: number;
  /** Текущий поворот: 0..3. */
  rot: number;
  /** Кресты не вращаются: у них все повороты эквивалентны. */
  fixed: boolean;
  /** Роль ячейки в квартале. */
  role: 'bus' | 'receiver' | 'line';
}

export interface Level {
  /** Номер уровня (для daily — 0). */
  level: number;
  /** Seed, из которого вырос квартал. */
  seed: number;
  /** Сторона сетки. */
  size: number;
  /** Ячейки: индекс = y * size + x. */
  tiles: Tile[];
  /** Индекс шины (источника тока). */
  bus: number;
  /** Индексы приёмников (визуальные цели квартала). */
  receivers: number[];
  /** Повороты, соответствующие сгенерированному решению. */
  solutionRot: number[];
  /** Оценка минимального числа ходов (по сгенерированному решению). */
  parMoves: number;
}

export interface LevelConfig {
  size: number;
  /** Доля ячеек, получающих дополнительный порт (тройники/кресты). */
  extraDensity: number;
  /** Сколько приёмников в квартале. */
  receivers: number;
}

/** Настройки сложности: 5 ярусов по 15 уровней (см. docs/05). */
export function levelConfig(level: number): LevelConfig {
  const tiers: Array<{ size: number; extraDensity: number }> = [
    { size: 4, extraDensity: 0.0 }, // Плато Первого Контакта — туториал
    { size: 5, extraDensity: 0.08 }, // Ртутный ярус
    { size: 6, extraDensity: 0.14 }, // Терминальный ярус
    { size: 7, extraDensity: 0.18 }, // Старый Диод
    { size: 8, extraDensity: 0.22 }, // Плавильня
  ];
  const tier = Math.max(0, Math.min(tiers.length - 1, Math.floor((level - 1) / 15)));
  const inTier = (level - 1) % 15;
  const base = tiers[tier];
  const size = Math.min(8, base.size + (inTier >= 10 ? 1 : 0));
  return { size, extraDensity: base.extraDensity, receivers: 1 + Math.floor(size / 3) };
}

/** Конфигурация уровня для челленджа дня (6×6) — общая для клиента, веба и сервера. */
export const DAILY_CONFIG_LEVEL = 33;

/** Линейная интерполяция номера уровня (для сезонных лидербордов и событий). */
export function lerpLevel(from: number, to: number, t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return Math.round(from + (to - from) * clamped);
}

/** Seed уровня: одинаков на клиенте и на сервере. */
export function levelSeed(level: number): number {
  return hashString(`floodgrid:level:${level}`);
}

/** Seed ежедневного челленджа: одинаков для всех игроков в этот день. */
export function dailySeed(unixDay: number): number {
  return hashString(`floodgrid:daily:${unixDay}`);
}

/** Генерация квартала. seed задаётся явно для воспроизводимости и тестов. */
export function generateLevel(level: number, seed = levelSeed(level)): Level {
  const cfg = levelConfig(level);
  const rng = new Rng(seed);
  const size = cfg.size;
  const cells = size * size;

  // 1. Остов магистралей: обход «змейкой с возвратом» (randomized DFS).
  const ports = new Uint8Array(cells);
  const visited = new Uint8Array(cells);
  const stack: number[] = [];
  const startCell = rng.nextInt(cells);
  stack.push(startCell);
  visited[startCell] = 1;
  while (stack.length > 0) {
    const cur = stack[stack.length - 1];
    const cx = cur % size;
    const cy = (cur / size) | 0;
    const options: number[] = [];
    for (let d = 0; d < 4; d++) {
      const [dx, dy] = deltaForBit(bitForIndex(d));
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const ni = ny * size + nx;
      if (visited[ni]) continue;
      options.push(d);
    }
    if (options.length === 0) {
      stack.pop();
      continue;
    }
    const d = options[rng.nextInt(options.length)];
    const [dx, dy] = deltaForBit(bitForIndex(d));
    const ni = (cy + dy) * size + (cx + dx);
    ports[cur] |= bitForIndex(d);
    ports[ni] |= bitForIndex((d + 2) % 4);
    visited[ni] = 1;
    stack.push(ni);
  }

  // 2. Дополнительные рёбра: тройники и кресты, плюс «ложные» развилки.
  const extraEdges = Math.round(cells * cfg.extraDensity);
  for (let k = 0; k < extraEdges; k++) {
    const cur = rng.nextInt(cells);
    const cx = cur % size;
    const cy = (cur / size) | 0;
    const options: number[] = [];
    for (let d = 0; d < 4; d++) {
      const bit = bitForIndex(d);
      if (ports[cur] & bit) continue;
      const [dx, dy] = deltaForBit(bit);
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const ni = ny * size + nx;
      if (ports[ni] & bitForIndex((d + 2) % 4)) continue;
      options.push(d);
    }
    if (options.length === 0) continue;
    const d = options[rng.nextInt(options.length)];
    const [dx, dy] = deltaForBit(bitForIndex(d));
    const ni = (cy + dy) * size + (cx + dx);
    ports[cur] |= bitForIndex(d);
    ports[ni] |= bitForIndex((d + 2) % 4);
  }

  // 3. Шина и приёмники.
  const busCandidates: number[] = [];
  for (let i = 0; i < cells; i++) {
    const pc = [1, 2, 4, 8].filter((b) => ports[i] & b).length;
    if (pc <= 2) busCandidates.push(i);
  }
  const bus = busCandidates.length > 0 ? busCandidates[rng.nextInt(busCandidates.length)] : rng.nextInt(cells);
  const receiverPool: number[] = [];
  for (let i = 0; i < cells; i++) if (i !== bus) receiverPool.push(i);
  rng.shuffle(receiverPool);
  const receivers = receiverPool.slice(0, Math.max(1, Math.min(cfg.receivers, receiverPool.length)));

  // 4. Фрагменты: базовая маска + случайный стартовый поворот.
  const tiles: Tile[] = [];
  const solutionRot: number[] = [];
  for (let i = 0; i < cells; i++) {
    const solutionMask = ports[i];
    const base = orbitCanonical(solutionMask);
    const solRot = rotationToReach(base, solutionMask);
    const fixed = orbitSize(base) === 1; // крест
    let rot = rng.nextInt(4);
    if (fixed) rot = 0;
    else if (rot === solRot) rot = (rot + 1 + rng.nextInt(3)) % 4;
    const role: Tile['role'] = i === bus ? 'bus' : receivers.includes(i) ? 'receiver' : 'line';
    tiles.push({ kind: kindOf(base), base, rot, fixed, role });
    solutionRot.push(fixed ? 0 : solRot);
  }

  const level0: Level = { level, seed, size, tiles, bus, receivers, solutionRot, parMoves: 0 };

  // Гарантия: стартовое состояние не является решённым.
  if (isSolved(level0)) {
    const movable = tiles.map((t, i) => (t.fixed ? -1 : i)).filter((i) => i >= 0);
    const pick = movable[rng.nextInt(movable.length)];
    tiles[pick].rot = (tiles[pick].rot + 1) % 4;
  }

  level0.parMoves = parMoves(level0);
  return level0;
}

/** Минимальное число ходов относительно сгенерированного решения. */
export function parMoves(level: Level): number {
  let total = 0;
  for (let i = 0; i < level.tiles.length; i++) {
    const t = level.tiles[i];
    if (t.fixed) continue;
    const period = orbitSize(t.base);
    total += circularDistance(t.rot % period, level.solutionRot[i] % period, period);
  }
  return total;
}

/** Поворот фрагмента. dir: +1 по часовой, -1 против. */
export function applyRotate(level: Level, index: number, dir = 1): boolean {
  const t = level.tiles[index];
  if (!t || t.fixed) return false;
  t.rot = (((t.rot + dir) % 4) + 4) % 4;
  return true;
}

/** Текущая маска фрагмента с учётом поворота. */
export function tileMask(level: Level, index: number): number {
  return rotateMask(level.tiles[index].base, level.tiles[index].rot);
}

function unionFind(level: Level): { find: (i: number) => number; roots: Set<number> } {
  const size = level.size;
  const parent = new Int32Array(level.tiles.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    while (parent[i] !== r) {
      const next = parent[i];
      parent[i] = r;
      i = next;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const mask = rotateMask(level.tiles[i].base, level.tiles[i].rot);
      // Проверяем только E и S, чтобы не дублировать рёбра.
      if (mask & E && x + 1 < size) {
        const j = i + 1;
        const nm = rotateMask(level.tiles[j].base, level.tiles[j].rot);
        if (nm & W) union(i, j);
      }
      if (mask & S && y + 1 < size) {
        const j = i + size;
        const nm = rotateMask(level.tiles[j].base, level.tiles[j].rot);
        if (nm & N) union(i, j);
      }
    }
  }

  const roots = new Set<number>();
  for (let i = 0; i < parent.length; i++) roots.add(find(i));
  return { find, roots };
}

/** Число несвязанных групп в квартале. */
export function componentCount(level: Level): number {
  return unionFind(level).roots.size;
}

/** Ячейки, подключённые к шине. */
export function poweredCells(level: Level): boolean[] {
  const { find } = unionFind(level);
  const busRoot = find(level.bus);
  return level.tiles.map((_, i) => find(i) === busRoot);
}

/** Пломба: все ячейки квартала подключены к шине. */
export function isSolved(level: Level): boolean {
  const { find } = unionFind(level);
  const busRoot = find(level.bus);
  for (let i = 0; i < level.tiles.length; i++) {
    if (find(i) !== busRoot) return false;
  }
  return true;
}

/**
 * Подсказка: сначала ищем поворот, который сразу уменьшает число несвязанных
 * групп. Если такого нет (квартал надо «разобрать» промежуточным ходом),
 * возвращаем ход, приближающий фрагмент к сгенерированному решению —
 * так подсказка всегда ведёт к пломбе и не зацикливается.
 */
export function hint(level: Level): { index: number; rot: number; gain: number } | null {
  if (isSolved(level)) return null;
  const current = componentCount(level);
  let immediate: { index: number; rot: number; gain: number } | null = null;
  let towardSolution: { index: number; rot: number; gain: number } | null = null;

  for (let i = 0; i < level.tiles.length; i++) {
    const t = level.tiles[i];
    if (t.fixed) continue;
    const period = orbitSize(t.base);
    const original = t.rot;
    for (let r = 0; r < 4; r++) {
      if (r === original) continue;
      t.rot = r;
      const gain = current - componentCount(level);
      if (!immediate || gain > immediate.gain) immediate = { index: i, rot: r, gain };
      if (original % period !== level.solutionRot[i] % period && r % period === level.solutionRot[i] % period) {
        if (!towardSolution || gain > towardSolution.gain) towardSolution = { index: i, rot: r, gain };
      }
      t.rot = original;
    }
  }

  if (immediate && immediate.gain > 0) return immediate;
  return towardSolution ?? immediate;
}

/** Приведение квартала к сгенерированному решению (для тестов и отладки). */
export function applySolution(level: Level): void {
  for (let i = 0; i < level.tiles.length; i++) {
    if (!level.tiles[i].fixed) level.tiles[i].rot = level.solutionRot[i];
  }
}

/** Маска решения для ячейки (порты, которые должны сойтись). */
export function solutionMask(level: Level, index: number): number {
  return rotateMask(level.tiles[index].base, level.solutionRot[index]);
}

/** Сериализация: используется для генерации тест-векторов для Kotlin-порта. */
export interface LevelVector {
  level: number;
  seed: number;
  size: number;
  bus: number;
  receivers: number[];
  base: number[];
  startRot: number[];
  solutionRot: number[];
  fixed: number[];
  parMoves: number;
}

export function toVector(level: Level): LevelVector {
  return {
    level: level.level,
    seed: level.seed,
    size: level.size,
    bus: level.bus,
    receivers: [...level.receivers],
    base: level.tiles.map((t) => t.base),
    startRot: level.tiles.map((t) => t.rot),
    solutionRot: [...level.solutionRot],
    fixed: level.tiles.map((t) => (t.fixed ? 1 : 0)),
    parMoves: level.parMoves,
  };
}

/** Восстановление квартала из вектора (в т.ч. в тестах Kotlin-порта). */
export function fromVector(v: LevelVector): Level {
  const tiles: Tile[] = v.base.map((base, i) => ({
    kind: kindOf(base),
    base,
    rot: v.startRot[i],
    fixed: v.fixed[i] === 1,
    role: i === v.bus ? 'bus' : v.receivers.includes(i) ? 'receiver' : 'line',
  }));
  return {
    level: v.level,
    seed: v.seed,
    size: v.size,
    tiles,
    bus: v.bus,
    receivers: [...v.receivers],
    solutionRot: [...v.solutionRot],
    parMoves: v.parMoves,
  };
}

