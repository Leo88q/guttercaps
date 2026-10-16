// Достижения скейт-мира (docs/16 §4.7).
//
// Правило, из которого всё остальное: достижение награждается **косметикой или
// существующим предметом** и никогда — $CG сверх квот (docs/02-economy.md).
// Здесь поэтому нет ни одной суммы: награды — это баннер, эмоции, трафареты,
// тема поля, скамейка, пропуск анимации и подсказки Флудгрида. Всё это уже
// существует и уже продаётся; достижение даёт повод дойти, а не новый черпак
// под эмиссию.
//
// Метрики не новые: каждая считается из таблиц, которые и так ведутся
// (коллекция, стена, теги, бои, фьюжн, Флудгрид, рефералы). Нового трекера под
// достижения нет и не нужно.

/** Как считать прогресс. Значения — ровно то, что уже лежит в базе. */
export type AchievementMetric =
  | 'sets'       // закрытых районов (9 из 9)
  | 'caps'       // разных крышек в коллекции
  | 'wallDays'   // дней, которые игрок держит слой стены (максимум по слотам)
  | 'tags'       // сохранённых тегов
  | 'arenaWins'  // выигранных боёв
  | 'gridDepth'  // самая глубокая достигнутая глубина Флудгрида
  | 'fusions'    // удачных фьюжнов
  | 'referrals'; // приведённых кошельков с оплаченной покупкой

/**
 * Награда. Каждый вид — существующий entitlement (или подсказки Флудгрида),
 * ничего не выдумано под достижения: проверки владения в остальном клиенте
 * продолжают работать без правок.
 */
export type AchievementReward =
  /** Баннер района, который игрок закрыл (kind 9). Район берётся из прогресса, а не из конфигурации. */
  | { kind: 'banner'; collection: 'firstCompleted' }
  /** Пак эмоций для реплеев Cap Slam (kind 4). */
  | { kind: 'emotes'; pack: string }
  /** Пять трафаретов района для редактора тегов (kind 12, §3.5). */
  | { kind: 'stencils'; pack: string }
  /** Тема поля Флудгрида (kind 11). */
  | { kind: 'fieldTheme'; theme: string }
  /** Ещё два пресета скамейки фьюжна (kind 5). */
  | { kind: 'bench' }
  /** Мгновенное вскрытие пака (kind 8). */
  | { kind: 'skip' }
  /** Подсказки Флудгрида — существующий предмет, не деньги. */
  | { kind: 'hints'; n: number };

export interface AchievementDef {
  /** Стабильный id: он же ключ перевода и строка в таблице выдач. */
  id: string;
  metric: AchievementMetric;
  /** Порог: столько нужно набрать по метрике. */
  target: number;
  reward: AchievementReward;
  /** Файл значка в client/public/icons/gen — настоящий ассет, не рисунок кодом. */
  icon: string;
}

/**
 * Список достижений. Порог каждого выбран так, чтобы он был виден за сезон
 * обычной игры, а не «когда-нибудь»: закрыть район, дойти до четвёртой глубины,
 * продержать слой стены три месяца.
 */
export const ACHIEVEMENTS: readonly AchievementDef[] = [
  { id: 'set.first', metric: 'sets', target: 1, reward: { kind: 'banner', collection: 'firstCompleted' }, icon: 'nav-collect' },
  { id: 'caps.half', metric: 'caps', target: 36, reward: { kind: 'stencils', pack: 'district' }, icon: 'stash' },
  { id: 'wall.hold90', metric: 'wallDays', target: 90, reward: { kind: 'emotes', pack: 'tags-v1' }, icon: 'streak' },
  { id: 'tags.ten', metric: 'tags', target: 10, reward: { kind: 'skip' }, icon: 'paint' },
  { id: 'arena.wins25', metric: 'arenaWins', target: 25, reward: { kind: 'fieldTheme', theme: 'field-magma' }, icon: 'mech-slam' },
  { id: 'grid.depth4', metric: 'gridDepth', target: 4, reward: { kind: 'hints', n: 2 }, icon: 'mech-grid' },
  { id: 'fusion.ten', metric: 'fusions', target: 10, reward: { kind: 'bench' }, icon: 'mech-fusion' },
  { id: 'referrals.three', metric: 'referrals', target: 3, reward: { kind: 'fieldTheme', theme: 'field-frost' }, icon: 'item-heart' },
] as const;

export const ACHIEVEMENT_BY_ID: Record<string, AchievementDef> = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a]));

/** Значки лежат в клиентской статике — вне бандла и вне графа входа. */
export const achievementIcon = (id: string): string => ACHIEVEMENT_BY_ID[id]?.icon ?? 'item-mark';
