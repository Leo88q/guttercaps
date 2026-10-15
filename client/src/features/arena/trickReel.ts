// Трик-рил арены (docs/16 §2.4).
//
// Итог боя показывается как линия трюков: разгон → грайнд → олли → приземление
// (или bail, если проиграл). Последовательность разворачивается **детерминированно
// из данных боя** — из `seed` матча и списка раундов, которыми бой уже посчитан.
// Правила боя это не трогает: победитель известен из матча, а не из рила.
//
// Словарь трюков и механика баланса — по THPS-образным референсам (олли, грайнд,
// флип-трюки, мануалы, wallplant, vert): у связки есть множитель за каждое
// звено, а баланс уезжает и линия ломается, если его упустить. У нас это не
// симуляция физики, а разыгрывание уже известного результата: удача раунда
// решает, насколько чисто трюк приземлился.
//
// Функция чистая: ни Date, ни Math.random, ни обращений к сети. Один и тот же
// бой → одна и та же линия на любом устройстве, и это проверяется тестом.

export type TrickKind = 'push' | 'ollie' | 'kickflip' | 'grind' | 'manual' | 'wallplant' | 'vert' | 'land' | 'bail';

/** Раунд боя в том виде, в каком его отдаёт API (подмножество `FightRound`). */
export interface ReelRound {
  lane?: number;
  luckA?: number;
  luckB?: number;
  elementEdge?: number;
  winner?: string; // 'A' | 'B' — строка из API, внутри сводится к двухзначной
}

export interface TrickBeat {
  kind: TrickKind;
  /** индекс крышки в отряде — чья это связка (полоса раунда) */
  lane: number;
  /** баланс после трюка, −1..1; за границей — bail */
  balance: number;
  /** очки за трюк уже с множителем (у push / manual / bail — 0) */
  points: number;
  /** множитель после трюка: +0,1 за звено, потолок ×5 (docs/16 §5.4) */
  multiplier: number;
}

export interface TrickLine {
  beats: TrickBeat[];
  /** линия доведена до приземления, а не сломана */
  landed: boolean;
  /** косметический счёт связки — ни "$CG", ни XP за него не начисляются */
  score: number;
  bestMultiplier: number;
}

/** База трюка и его сложность: чем выше, тем сильнее качает баланс и тем дороже приземление. */
const TRICKS: { kind: TrickKind; base: number; difficulty: number }[] = [
  { kind: 'ollie', base: 100, difficulty: 0.35 },
  { kind: 'kickflip', base: 180, difficulty: 0.55 },
  { kind: 'grind', base: 240, difficulty: 0.7 },
  { kind: 'wallplant', base: 260, difficulty: 0.8 },
  { kind: 'vert', base: 320, difficulty: 0.95 },
];

const MULTIPLIER_STEP = 0.1; // docs/16 §5.4: +0,1 за звено
const MULTIPLIER_CAP = 5;
const BALANCE_LIMIT = 1;

/** FNV-1a → xorshift32: детерминированный поток из строки сида. */
function stream(seed: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let s = h || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 2 ** 32;
  };
}

/**
 * Линия трюков для одной стороны боя.
 *
 * @param rounds  раунды боя (2–3, best of 3)
 * @param seed    сид матча (`matches.seed`) — то же значение, из которого считан бой
 * @param side    за кого играем: 'A' или 'B'
 * @param won     победила ли эта сторона бой (результат приходит из матча, не из рила)
 */
export function trickLine(rounds: readonly ReelRound[], seed: string, side: 'A' | 'B', won: boolean): TrickLine {
  const next = stream(`${seed}|${side}|reel`);
  const beats: TrickBeat[] = [];
  let balance = 0;
  let multiplier = 1;
  let score = 0;
  let best = 1;
  let landed = true;

  // Удача раунда ∈ [0.5, 1.5]: 1.5 — трюк приземлился как по рельсам, 0.5 — на грани.
  // Поля раунда приходят из проекции индексатора и формально необязательны:
  // отсутствующая удача трактуется как ровная (1.0), отсутствующий край — как его отсутствие.
  const luckOf = (r: ReelRound) => Math.min(1, Math.max(0, ((side === 'A' ? r.luckA : r.luckB) ?? 1) - 0.5));

  const push = (kind: TrickKind, lane: number, swing: number, points: number): boolean => {
    balance += swing;
    multiplier = kind === 'manual' || kind === 'push' ? multiplier : Math.min(MULTIPLIER_CAP, Math.round((multiplier + MULTIPLIER_STEP) * 10) / 10);
    best = Math.max(best, multiplier);
    score += Math.round(points * multiplier);
    beats.push({ kind, lane, balance: Math.round(balance * 100) / 100, points: Math.round(points * multiplier), multiplier });
    if (Math.abs(balance) > BALANCE_LIMIT) {
      landed = false;
      beats.push({ kind: 'bail', lane, balance: Math.round(balance * 100) / 100, points: 0, multiplier: 1 });
      return false;
    }
    return true;
  };

  for (const r of rounds) {
    const luck = luckOf(r);
    // Разгон: связка начинается с толчка, он не приносит очков и не качает баланс.
    const lane = r.lane ?? 0;
    if (!push('push', lane, 0, 0)) break;

    // Основной трюк: чем выше сложность и ниже удача, тем сильнее уезжает баланс.
    const trick = TRICKS[Math.floor(next() * TRICKS.length) % TRICKS.length];
    const sway = (1 - luck) * trick.difficulty * 1.6;
    const swing = (next() < 0.5 ? -1 : 1) * sway;
    if (!push(trick.kind, lane, swing, trick.base)) break;

    // Элементное преимущество в раунде — рельс: есть за что зацепиться, значит грайнд.
    const edge = (r.elementEdge ?? 0) * (side === 'A' ? 1 : -1);
    if (edge > 0) {
      const grind = TRICKS[2];
      if (!push('grind', lane, (1 - luck) * grind.difficulty * 1.2 * (next() < 0.5 ? -1 : 1), grind.base)) break;
    }

    // Выигранный раунд связывается мануалом: звено цепляется к звену, множитель растёт.
    if (r.winner === side && !push('manual', lane, (1 - luck) * 0.25 * (next() < 0.5 ? -1 : 1), 60)) break;
  }

  // Финал: приземление, если баланс удержан и бой выигран. Проигрыш — всегда bail,
  // но только в том месте, где линия и правда сломалась (docs/16 §2.4).
  if (landed && !won) {
    landed = false;
    const lane = beats.length ? beats[beats.length - 1].lane : 0;
    balance += (next() < 0.5 ? -1 : 1) * BALANCE_LIMIT;
    beats.push({ kind: 'bail', lane, balance: Math.round(balance * 100) / 100, points: 0, multiplier: 1 });
  } else if (landed && beats.length > 0) {
    beats.push({ kind: 'land', lane: beats.length ? beats[beats.length - 1].lane : 0, balance: Math.round(balance * 100) / 100, points: 0, multiplier });
  }

  return { beats, landed, score, bestMultiplier: best };
}
