// =============================================================================
// GUTTERCAPS — экспозиция крышек (docs/16 §4.3) и витрина (§4.5)
// -----------------------------------------------------------------------------
// Экспозиция — то место, где коллекция наконец становится статусом, который
// видят другие. Три слота на доске: один на деку, два на грип. Эффект ровно
// один — визуальный (решение 3 из §0.3): редкая крышка на доске не даёт ни
// веса, ни шанса, ни дохода.
//
// Главное, что здесь НЕ написано: крышка не сжигается, не передаётся и не
// блокируется. Слот хранит ссылку на неё, а владение проверяется джойном при
// каждом чтении — поэтому проданная или сожжённая фьюжном крышка просто
// оставляет слот пустым, без чистки и без обработчика события продажи.
//
// Слоты открываются коллекцией (12 и 36 крышек из 72). Это и есть «мир кормит
// основную петлю» в интерфейсе: закрытый слот не продаётся, он говорит, сколько
// собрать, и ведёт в паки, фьюжн и маркет — существующие контуры.
// =============================================================================

import type { Db } from './db.ts';
import { now } from './db.ts';
import { ServiceError } from './services.ts';
import { recordEvent } from './worldMetrics.ts';

export const RIG_SLOTS = 3;
/** Сколько собранных крышек открывает слот: первый сразу, второй с 12, третий с 36 (половина коллекции). */
export const RIG_UNLOCK = [0, 12, 36] as const;
/** Куда физически крепится крышка: слот 0 — дека, 1 и 2 — грип. */
export const RIG_PLACE = ['deck', 'grip', 'grip'] as const;
/** Размер коллекции (8 районов × 9 редкостей) — только для честного текста «собери N из 72». */
export const CAPS_IN_COLLECTION = 72;

const iso = (s: number) => new Date(s * 1000).toISOString();

interface ExhibitRow { slot: number; asset: string; updated_at: number }
interface ChipRow { asset: string; collection_idx: number; rarity: number; level: number; skin: string | null; flags: number }

export interface RigCap {
  asset: string; collection: number; rarity: number; level: number;
  /** Сколько таких крышек у кошелька: выставляется одна, остальные лежат в коллекции. */
  copies: number;
}
export interface RigChip {
  asset: string; collection: number; rarity: number; level: number;
  skin: string | null; founder: boolean;
}
export interface RigSlotView {
  slot: number;
  place: 'deck' | 'grip';
  unlocked: boolean;
  /** Сколько крышек нужно собрать, чтобы слот открылся (0 — открыт сразу). */
  unlockAt: number;
  chip: RigChip | null;
  updatedAt: string | null;
}
export interface RigView {
  wallet: string;
  /** Витрина включена владельцем (§4.5): публичная страница /rig/:wallet живёт только с этим флагом. */
  public: boolean;
  /**
   * Собранные крышки — ровно те, которые можно выставить, и ровно та величина,
   * которая открывает слоты. Список выдаётся только владельцу: чужая витрина
   * показывает три крышки на доске, а не всю коллекцию.
   */
  caps: RigCap[];
  slots: RigSlotView[];
  /** Следующий закрытый слот: чтобы интерфейс говорил «собери ещё N», а не «скоро». */
  next: { slot: number; need: number } | null;
}

/**
 * Собранные крышки: по одной строке на (район, редкость) — коллекция считает
 * разные крышки, а не число фишек. Выбирается лучший экземпляр (максимальный
 * уровень); `MIN(asset)` среди равных делает выбор детерминированным, а не
 * «какой первый попался» — арт у крышки один на весь (район, редкость), но
 * нестабильный asset означал бы вечно меняющийся ответ.
 */
export function ownedCaps(db: Db, wallet: string): RigCap[] {
  return db.all<RigCap>(
    `SELECT MIN(c.asset) AS asset, c.collection_idx AS collection, c.rarity AS rarity,
            MAX(c.level) AS level,
            (SELECT COUNT(*) FROM chips d
              WHERE d.owner = c.owner AND d.collection_idx = c.collection_idx
                AND d.rarity = c.rarity AND d.burned_at IS NULL) AS copies
       FROM chips c
       JOIN (SELECT collection_idx, rarity, MAX(level) AS best
               FROM chips WHERE owner = ? AND burned_at IS NULL
              GROUP BY collection_idx, rarity) b
         ON b.collection_idx = c.collection_idx AND b.rarity = c.rarity AND b.best = c.level
      WHERE c.owner = ? AND c.burned_at IS NULL
      GROUP BY c.collection_idx, c.rarity
      ORDER BY c.rarity DESC, c.collection_idx`,
    wallet, wallet,
  );
}

/** Крышка, выставленная в слоте, — только если она всё ещё у владельца. */
function exhibited(db: Db, wallet: string): Map<number, { row: ExhibitRow; chip: ChipRow }> {
  const rows = db.all<ExhibitRow & ChipRow>(
    `SELECT r.slot, r.asset, r.updated_at, c.collection_idx, c.rarity, c.level, c.skin, c.flags
       FROM rig_exhibit r
       JOIN chips c ON c.asset = r.asset AND c.owner = r.wallet AND c.burned_at IS NULL
      WHERE r.wallet = ?
      ORDER BY r.slot`, wallet,
  );
  const map = new Map<number, { row: ExhibitRow; chip: ChipRow }>();
  for (const r of rows) map.set(r.slot, { row: { slot: r.slot, asset: r.asset, updated_at: r.updated_at }, chip: r });
  return map;
}

/** `withCaps` — false для чужой витрины: коллекция целиком остаётся приватной. */
export function rigView(db: Db, wallet: string, withCaps = true): RigView {
  const caps = ownedCaps(db, wallet);
  const count = caps.length;
  const held = exhibited(db, wallet);
  const slots: RigSlotView[] = [];
  let next: { slot: number; need: number } | null = null;
  for (let i = 0; i < RIG_SLOTS; i++) {
    const unlockAt = RIG_UNLOCK[i] ?? 0;
    const unlocked = count >= unlockAt;
    const held_ = held.get(i);
    slots.push({
      slot: i,
      place: RIG_PLACE[i] ?? 'grip',
      unlocked,
      unlockAt,
      chip: held_ ? {
        asset: held_.chip.asset,
        collection: held_.chip.collection_idx,
        rarity: held_.chip.rarity,
        level: held_.chip.level,
        skin: held_.chip.skin ?? null,
        founder: (held_.chip.flags & 16) !== 0,
      } : null,
      updatedAt: held_ ? iso(held_.row.updated_at) : null,
    });
    if (!unlocked && next === null) next = { slot: i, need: unlockAt - count };
  }
  return { wallet, public: rigPublic(db, wallet), caps: withCaps ? caps : [], slots, next };
}

// ------------------------------------------------------------------ витрина
// Публичность лежит в wallets.flags: один булев переключатель не стоит новой
// таблицы, а читается он через sql.ts (jsonFlagEq), чтобы SQLite и Postgres
// отвечали одинаково — ровно то, о чём предупреждает комментарий к jsonFlagEq.
interface RigFlags { rigPublic?: boolean }

function readFlags(db: Db, wallet: string): RigFlags {
  const raw = db.get<{ flags: string }>(`SELECT flags FROM wallets WHERE address = ?`, wallet)?.flags;
  try { return (JSON.parse(raw ?? '{}') as RigFlags) ?? {}; } catch { return {}; }
}

export function rigPublic(db: Db, wallet: string): boolean {
  return readFlags(db, wallet).rigPublic === true;
}

export function setRigPublic(db: Db, wallet: string, on: boolean): boolean {
  const flags = { ...readFlags(db, wallet), rigPublic: on };
  db.run(`INSERT INTO wallets (address, flags) VALUES (?, ?) ON CONFLICT(address) DO UPDATE SET flags = excluded.flags`, wallet, JSON.stringify(flags));
  return on;
}

/** Публичная витрина (§4.5). Чужая доска видна только если владелец включил показ. */
export function publicRig(db: Db, wallet: string): RigView {
  if (!rigPublic(db, wallet)) throw new ServiceError(404, 'rig_private', 'This board is not public');
  // Ограничение обработки профиля (GDPR) сильнее переключателя витрины.
  if (db.get(`SELECT wallet FROM privacy_restrictions WHERE wallet = ? AND resumed_at IS NULL`, wallet)) {
    throw new ServiceError(404, 'rig_private', 'This board is not public');
  }
  return rigView(db, wallet, false);
}

// ------------------------------------------------------------------- запись
export interface RigUpdate { slot: number; asset: string | null }

/**
 * PUT /v1/rig — поставить или снять крышки. Запрос идемпотентен: повторная
 * отправка того же состояния ничего не меняет, поэтому «не сохранилось — нажми
 * ещё раз» безопасно.
 */
export function setRig(db: Db, wallet: string, updates: RigUpdate[], publicOn?: boolean): RigView {
  const caps = ownedCaps(db, wallet);
  const owned = new Set(caps.map((c) => c.asset));
  // Владение проверяем по списку лучших экземпляров: выставить «вторую такую же
  // крышку» нельзя не потому, что жалко, а потому что копия неотличима в
  // интерфейсе и разница была бы видна только в базе.
  const claimed = new Set<string>();
  return db.tx(() => {
    for (const u of updates) {
      const slot = Number(u.slot);
      if (!Number.isInteger(slot) || slot < 0 || slot >= RIG_SLOTS) throw new ServiceError(400, 'bad_slot', `slot must be 0..${RIG_SLOTS - 1}`);
      if (u.asset === null || u.asset === undefined || u.asset === '') {
        db.run(`DELETE FROM rig_exhibit WHERE wallet = ? AND slot = ?`, wallet, slot);
        recordEvent(db, wallet, 'exhibit', 'unset', { slot });
        continue;
      }
      const unlockAt = RIG_UNLOCK[slot] ?? 0;
      if (caps.length < unlockAt) throw new ServiceError(409, 'slot_locked', `Slot ${slot + 1} opens at ${unlockAt} caps (you have ${caps.length})`);
      if (!owned.has(u.asset)) throw new ServiceError(403, 'not_your_chip', 'You can only exhibit a cap you own');
      if (claimed.has(u.asset)) throw new ServiceError(409, 'chip_in_use', 'The same cap cannot fill two slots');
      claimed.add(u.asset);
      db.run(
        `INSERT INTO rig_exhibit (wallet, slot, asset, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(wallet, slot) DO UPDATE SET asset = excluded.asset, updated_at = excluded.updated_at`,
        wallet, slot, u.asset, now(),
      );
      // Событие пишется в той же транзакции, что и слот: метрика §12 не должна
      // расходиться с состоянием доски.
      recordEvent(db, wallet, 'exhibit', 'set', { slot });
    }
    // Крышка не может занимать два слота — снимаем её со всех остальных.
    for (const asset of claimed) {
      const rows = db.all<{ slot: number }>(`SELECT slot FROM rig_exhibit WHERE wallet = ? AND asset = ?`, wallet, asset);
      const keep = updates.find((u) => u.asset === asset)?.slot;
      for (const r of rows) if (r.slot !== keep) db.run(`DELETE FROM rig_exhibit WHERE wallet = ? AND slot = ?`, wallet, r.slot);
    }
    if (publicOn !== undefined) {
      setRigPublic(db, wallet, publicOn);
      recordEvent(db, wallet, 'exhibit', publicOn ? 'public_on' : 'public_off');
    }
    return rigView(db, wallet);
  });
}
