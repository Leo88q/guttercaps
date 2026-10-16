// =============================================================================
// GUTTERCAPS — достижения скейт-мира (docs/16 §4.7)
// -----------------------------------------------------------------------------
// Правило §4.7: достижение награждается **косметикой или существующим
// предметом** и никогда — $CG сверх квот (docs/02-economy.md). В этом файле нет
// ни одной суммы: баннер, эмоции, трафареты, тема поля, скамейка, пропуск
// анимации, подсказки Флудгрида. Всё это уже существует и уже продаётся;
// достижение даёт повод дойти, а не новый черпак под эмиссию.
//
// Прогресс не хранится: он считается из таблиц, которые и так ведутся
// (коллекция, стена, теги, бои, фьюжн, Флудгрид, рефералы). Хранится ровно факт
// выдачи — иначе повторный тап выдал бы награду дважды, а этого достаточно,
// чтобы косметика перестала быть редкой.
// =============================================================================

import type { Db } from './db.ts';
import { now } from './db.ts';
import { ServiceError, rowToEntitlement, type Entitlement } from './services.ts';
import { recordEvent } from './worldMetrics.ts';
import { ACHIEVEMENTS, ACHIEVEMENT_BY_ID, GRID, type AchievementDef, type AchievementMetric, type AchievementReward } from '@guttercaps/economy';

const DAY = 86_400;
const iso = (s: number) => new Date(s * 1000).toISOString();

/**
 * Прогресс по каждой метрике. Все восемь — существующие данные; ни одна не
 * требует отдельного счётчика, который пришлось бы вести самому достижению.
 */
const PROGRESS: Record<AchievementMetric, (db: Db, wallet: string, t: number) => number> = {
  /** Закрытые районы: все девять редкостей одного района. */
  sets: (db, wallet) => db.scalar(
    `SELECT COUNT(*) FROM (
       SELECT collection_idx FROM chips
        WHERE owner = ? AND COALESCE(burned_at, 0) = 0
        GROUP BY collection_idx HAVING COUNT(DISTINCT rarity) >= 9
     )`, wallet),
  /** Разные крышки коллекции — ровно то, что открывает слоты экспозиции (§4.3). */
  caps: (db, wallet) => db.scalar(
    `SELECT COUNT(*) FROM (
       SELECT DISTINCT collection_idx, rarity FROM chips WHERE owner = ? AND COALESCE(burned_at, 0) = 0
     )`, wallet),
  /**
   * Дней на стене: максимум по слотам, а не сумма — «удержать слой 90 дней»
   * (§4.7) про один слой, а не про десять по девять дней. История учитывается
   * наравне с текущими слотами: снятый слой свой срок уже отслужил.
   */
  wallDays: (db, wallet, t) => {
    const held = db.scalar(`SELECT COALESCE(MAX(? - applied_at), 0) FROM wall_slots WHERE wallet = ?`, t, wallet);
    const past = db.scalar(`SELECT COALESCE(MAX(released_at - applied_at), 0) FROM wall_slot_history WHERE wallet = ?`, wallet);
    return Math.floor(Math.max(held, past) / DAY);
  },
  /** Свои теги: снятые модерацией не считаются — достижение про город, а не про мусор. */
  tags: (db, wallet) => db.scalar(
    `SELECT COUNT(*) FROM tag_registry WHERE wallet = ? AND status IN ('live', 'pending')`, wallet),
  arenaWins: (db, wallet) => db.scalar(
    `SELECT COUNT(*) FROM matches WHERE winner = ? AND status = 'resolved'`, wallet),
  /** Глубина Флудгрида — из максимального пройденного уровня (GRID.levelsPerDepth уровней на глубину). */
  gridDepth: (db, wallet) => {
    const level = db.scalar(`SELECT COALESCE(MAX(level), 0) FROM grid_attempts WHERE wallet = ?`, wallet);
    return level <= 0 ? 0 : Math.min(GRID.depths, Math.ceil(level / GRID.levelsPerDepth));
  },
  fusions: (db, wallet) => db.scalar(
    `SELECT COUNT(*) FROM fusions WHERE owner = ? AND success = 1`, wallet),
  /** Приведённые кошельки, которые дошли до покупки пака: не регистрации, а игроки. */
  referrals: (db, wallet) => db.scalar(
    `SELECT COUNT(*) FROM wallets w
      WHERE w.referrer = ? AND EXISTS (SELECT 1 FROM pack_purchases p WHERE p.buyer = w.address)`, wallet),
};

export interface AchievementView {
  id: string;
  metric: AchievementMetric;
  target: number;
  have: number;
  done: boolean;
  claimed: boolean;
  claimedAt: string | null;
  /** Значок — файл из client/public/icons/gen (настоящий ассет). */
  icon: string;
  reward: AchievementReward;
  /**
   * Район баннера, когда награда — баннер: он не задан в конфигурации, а
   * берётся из прогресса (первый закрытый район). null у остальных наград.
   */
  bannerCollection: number | null;
}

const firstCompleted = (db: Db, wallet: string): number | null => {
  const row = db.get<{ collection_idx: number }>(
    `SELECT collection_idx FROM chips
      WHERE owner = ? AND COALESCE(burned_at, 0) = 0
      GROUP BY collection_idx HAVING COUNT(DISTINCT rarity) >= 9
      ORDER BY collection_idx LIMIT 1`, wallet);
  return row ? Number(row.collection_idx) : null;
};

export function achievementsOf(db: Db, wallet: string, t = now()): { items: AchievementView[] } {
  const claimed = new Map(
    db.all<{ id: string; claimed_at: number }>(`SELECT id, claimed_at FROM achievement_claims WHERE wallet = ?`, wallet)
      .map((r) => [r.id, r.claimed_at] as const),
  );
  const items = ACHIEVEMENTS.map((def: AchievementDef) => {
    const have = PROGRESS[def.metric](db, wallet, t);
    const at = claimed.get(def.id) ?? null;
    return {
      id: def.id,
      metric: def.metric,
      target: def.target,
      // Прогресс показываем по порогу: «127 из 36» читается как сломанный счётчик.
      have: Math.min(have, def.target),
      done: have >= def.target,
      claimed: at !== null,
      claimedAt: at === null ? null : iso(at),
      icon: def.icon,
      reward: def.reward,
      bannerCollection: def.reward.kind === 'banner' ? firstCompleted(db, wallet) : null,
    };
  });
  return { items };
}

/**
 * Выдать награду. Идемпотентно: повторный вызов того же достижения отвечает
 * 409 `already_claimed`, а не второй баннер.
 *
 * Награда — существующий entitlement с подписью `ach:<id>`, поэтому проверки
 * владения в остальном клиенте (темы, эмоции, скамейка, трафареты) работают без
 * правок. Подсказки Флудгрида — не entitlement, а предмет: они ложатся в тот же
 * stock, что выдают квесты и сезонный пропуск, и упираются в тот же потолок.
 */
export function claimAchievement(db: Db, wallet: string, id: string, t = now()): AchievementView & { granted: { entitlement?: Entitlement; hints?: number } } {
  const def = ACHIEVEMENT_BY_ID[id];
  if (!def) throw new ServiceError(400, 'unknown_achievement', `Unknown achievement ${id}`);
  const have = PROGRESS[def.metric](db, wallet, t);
  if (have < def.target) throw new ServiceError(409, 'not_earned', `Achievement needs ${def.target}, you have ${have}`);
  if (db.get(`SELECT 1 FROM achievement_claims WHERE wallet = ? AND id = ?`, wallet, id)) {
    throw new ServiceError(409, 'already_claimed', `Achievement ${id} already claimed`);
  }

  return db.tx(() => {
    const signature = `ach:${id}`;
    let kind = 0;
    let payload: Record<string, unknown> = {};
    const r = def.reward;
    if (r.kind === 'banner') {
      const collection = firstCompleted(db, wallet);
      if (collection === null) throw new ServiceError(409, 'set_not_completed', 'Finish a district set first');
      kind = 9; payload = { collection, source: 'achievement' };
    } else if (r.kind === 'emotes') { kind = 4; payload = { pack: r.pack, source: 'achievement' }; }
    else if (r.kind === 'stencils') { kind = 12; payload = { pack: r.pack, source: 'achievement' }; }
    else if (r.kind === 'fieldTheme') { kind = 11; payload = { theme: r.theme, source: 'achievement' }; }
    else if (r.kind === 'bench') { kind = 5; payload = { source: 'achievement' }; }
    else if (r.kind === 'skip') { kind = 8; payload = { source: 'achievement' }; }

    let entitlement: Entitlement | undefined;
    let hints: number | undefined;
    if (kind > 0) {
      const res = db.run(
        `INSERT INTO entitlements (wallet, kind, payload, signature, currency, amount, granted_at, expires_at) VALUES (?, ?, ?, ?, 2, '0', ?, NULL)`,
        wallet, kind, JSON.stringify(payload), signature, t,
      );
      entitlement = rowToEntitlement({
        id: Number(res.lastInsertRowid), kind, payload: JSON.stringify(payload), signature,
        currency: 2, amount: '0', granted_at: t, expires_at: null,
      });
    } else if (r.kind === 'hints') {
      db.run(`INSERT INTO grid_wallet_state (wallet, hints, valves, starter_granted, total_best_stars, updated_at) VALUES (?, ?, 0, 1, 0, ?) ON CONFLICT(wallet) DO NOTHING`,
        wallet, GRID.hintStartStock, t);
      const before = db.get<{ hints: number }>(`SELECT hints FROM grid_wallet_state WHERE wallet = ?`, wallet)?.hints ?? GRID.hintStartStock;
      hints = Math.max(0, Math.min(r.n, GRID.hintStockCap - before));
      if (hints > 0) db.run(`UPDATE grid_wallet_state SET hints = hints + ?, updated_at = ? WHERE wallet = ?`, hints, t, wallet);
    }

    db.run(`INSERT INTO achievement_claims (wallet, id, claimed_at) VALUES (?, ?, ?)`, wallet, id, t);
    recordEvent(db, wallet, 'achievement', 'claim', { id }, t);

    const view = achievementsOf(db, wallet, t).items.find((x) => x.id === id)!;
    return { ...view, granted: { ...(entitlement ? { entitlement } : {}), ...(hints !== undefined ? { hints } : {}) } };
  });
}
