// =============================================================================
// GUTTERCAPS — конструктор доски (docs/16 §4.2)
// -----------------------------------------------------------------------------
// Части доски — косметика, которую добывают игрой, а не покупают. Три вещи,
// которые здесь решены и которые нельзя обойти, не сломав договор с игроком:
//
// 1. **Часть не даёт силы.** Ни веса, ни шанса, ни дохода, ни очков в заезде
//    (решение 1 из §0.3). Единственный эффект собранного сета района —
//    визуальный: доска светится цветом района. Отсюда следует, что в этом
//    файле нет ни одной строки про множители.
// 2. **Доска не бывает пустой.** У каждого есть стартовый комплект, поэтому
//    «собери доску» не превращается в «купи доску» на первом экране.
// 3. **Часть добывается, а не выдаётся по заявке.** Источники — заезды (§5.1),
//    достижения (§4.7), командные конкурсы (§5.6), квесты и трек. Здесь только
//    факт владения и то, что надето; кто и за что выдал — в вызывающем коде.
//
// Почему владение частью лежит в своей таблице, а не в `wallets.flags`: части
// накапливаются (8 районов × 4 слота плюс командные и трофейные), и JSON-поле
// в строке кошелька стало бы тем же списком, только без индекса и без
// возможности посчитать метрику §12 запросом.
//
// Почему выдача за заезд проверяет «неделю», а не «день»: часть стоит дороже
// подсказки, и один и тот же район недели один на весь город — игрок видит, что
// именно он собирает, и решает, ехать ли за этим. Лотерея из случайного района
// превратила бы добычу в слот-машину.
// =============================================================================

import type { Db } from './db.ts';
import { now } from './db.ts';
import { ServiceError } from './services.ts';
import { recordEvent } from './worldMetrics.ts';
import { weekIndex } from './quests.ts';
import { insertIgnore, upsert } from './sql.ts';
import {
  BOARD, BOARD_PARTS, BOARD_SET_SLOTS, BOARD_SLOTS, boardDistrictOfWeek, boardSetDistrict,
  canEquip, partById, stockLoadout, type BoardSlot, type BoardSource,
} from '@guttercaps/economy';

/** Что надето на доске — публичная часть: её видит любой на витрине (§4.5). */
export interface BoardLoadout {
  deck: string; trucks: string; wheels: string; grip: string; bolts: string; sticker: string;
  /** Район собранного сета: все четыре основные части одного района. null — сета нет. */
  set: number | null;
}

/** Часть в инвентаре владельца. Инвентарь приватный: чужая витрина его не показывает. */
export interface BoardPartRow {
  part: string;
  qty: number;
  source: string;
  createdAt: string;
}

/** Моя доска: что надето, что есть в инвентаре и что можно добыть на этой неделе. */
export interface BoardView extends BoardLoadout {
  wallet: string;
  owned: BoardPartRow[];
  /** Район недели: из него на этой неделе выдаются части за заезды. */
  week: { district: number; part: string; claimed: boolean; missing: BoardSlot[] };
  /** Сколько сетовых частей района недели уже есть — прогресс «собери район». */
  weekProgress: { have: number; total: number };
}

const iso = (s: number) => new Date(s * 1000).toISOString();
const STOCK = stockLoadout();

/** Стартовая доска: райдеру не выдают пустые дыры вместо деки (решение 2 выше). */
export function stockBoard(): BoardLoadout {
  return { ...STOCK, set: null };
}

export function ownedParts(db: Db, wallet: string): BoardPartRow[] {
  return db.all<{ part: string; qty: number; source: string; created_at: number }>(
    `SELECT part, qty, source, created_at FROM board_parts WHERE wallet = ? AND qty > 0 ORDER BY created_at, part`, wallet,
  ).map((r) => ({ part: r.part, qty: r.qty, source: r.source, createdAt: iso(r.created_at) }));
}

/**
 * Что надето. Пропущенный слот читается как стоковый, поэтому доска всегда
 * собрана: `board_loadout` хранит только то, что игрок реально менял.
 */
export function boardLoadout(db: Db, wallet: string): BoardLoadout {
  const rows = db.all<{ slot: string; part: string }>(
    `SELECT slot, part FROM board_loadout WHERE wallet = ?`, wallet,
  );
  const out = stockBoard();
  const owned = new Set(ownedParts(db, wallet).map((p) => p.part));
  for (const r of rows) {
    if (!(BOARD_SLOTS as readonly string[]).includes(r.slot)) continue;
    // Надеть можно только то, что есть: снятая или ещё не выданная часть не
    // должна «носиться» из старой записи.
    if (!owned.has(r.part) && r.part !== STOCK[r.slot as BoardSlot]) continue;
    (out as unknown as Record<string, string>)[r.slot] = r.part;
  }
  out.set = boardSetDistrict(out as unknown as Record<BoardSlot, string>);
  return out;
}

/** Части района, которых у игрока ещё нет, — в порядке слотов сета. */
export function missingOfDistrict(db: Db, wallet: string, district: number): BoardSlot[] {
  const owned = new Set(ownedParts(db, wallet).map((p) => p.part));
  return BOARD_SET_SLOTS.filter((slot) => !owned.has(`${slot}_d${district}`));
}

/**
 * Выдать часть. Идемпотентно в пределах источника: повторный вызов с той же
 * парой (часть, источник) не создаёт вторую запись, поэтому повторная выдача из
 * квеста или повторная отправка заезда безопасны.
 *
 * `qty` растёт до `BOARD.maxQtyPerPart` — дубль из двух источников не должен
 * падать с ошибкой, но и копиться бесконечно незачем.
 *
 * §5.4: выдача — две плоскости. `board_parts` — оффчейн-реестр,
 * немедленно видимый игре и витрине; `board_part_leaves` — очередь
 * ончейн-выдачи (корни kind 10, клейм `claim_item_root` →
 * `grant_board_part`). Лист кладётся только когда количество
 * реально растёт: насыщенная часть не рождает лист, которого
 * ончейн-регистр всё равно не примет (MAX_PART_QTY там же).
 */
export function grantPart(db: Db, wallet: string, partId: string, source: BoardSource, t = now()): BoardPartRow {
  const part = partById(partId);
  if (!part) throw new ServiceError(400, 'bad_part', `Unknown board part: ${partId}`);
  const existing = db.get<{ qty: number; source: string; created_at: number }>(
    `SELECT qty, source, created_at FROM board_parts WHERE wallet = ? AND part = ?`, wallet, partId);
  if (existing && existing.qty >= BOARD.maxQtyPerPart) {
    return { part: partId, qty: existing.qty, source: existing.source as BoardSource, createdAt: iso(existing.created_at) };
  }
  const qty = Math.min(BOARD.maxQtyPerPart, (existing?.qty ?? 0) + 1);
  db.run(
    // `source` и `created_at` не перезаписываются: часть остаётся «добытой
    // заездом», даже если позже такая же пришла из квеста. Первый источник —
    // тот, за который её получили, и витрина про это не должна врать.
    upsert('board_parts', ['wallet', 'part', 'qty', 'source', 'created_at', 'updated_at'], ['wallet', 'part'],
      ['qty = excluded.qty', 'updated_at = excluded.updated_at']),
    wallet, partId, qty, source, t, t,
  );
  // Индекс части в каталоге — это и есть leaf amount ончейн-корня
  // (формат листа тот же, что у бустеров; amount = индекс).
  db.run(`INSERT INTO board_part_leaves (wallet, part_idx, granted_at) VALUES (?, ?, ?)`,
    wallet, BOARD_PARTS.findIndex((p) => p.id === partId), t);
  recordEvent(db, wallet, 'builder', 'grant', { part: partId, district: part.district, source }, t);
  return { part: partId, qty, source, createdAt: iso(t) };
}

/**
 * Надеть или снять часть. `part: null` возвращает слот к стоковому — «снять»
 * здесь означает «надеть своё первое», а не «ехать на пустом».
 */
export interface BoardUpdate { slot: string; part: string | null }

export function setBoard(db: Db, wallet: string, updates: BoardUpdate[], t = now()): BoardView {
  const owned = new Set(ownedParts(db, wallet).map((p) => p.part));
  return db.tx(() => {
    for (const u of updates) {
      const slot = String(u?.slot ?? '');
      if (!(BOARD_SLOTS as readonly string[]).includes(slot)) {
        throw new ServiceError(400, 'bad_slot', `slot must be one of ${BOARD_SLOTS.join(', ')}`);
      }
      const part = u.part === '' ? null : u.part;
      if (part === null) {
        db.run(`DELETE FROM board_loadout WHERE wallet = ? AND slot = ?`, wallet, slot);
        recordEvent(db, wallet, 'builder', 'clear', { slot }, t);
        continue;
      }
      const stock = STOCK[slot as BoardSlot];
      // Сток надеть можно всегда: это то, с чего игрок начинал, и «вернуть как
      // было» не должно требовать инвентаря.
      if (part !== stock && !owned.has(part)) throw new ServiceError(403, 'part_not_owned', 'Earn this part before wearing it');
      if (part !== stock && !canEquip(part, slot as BoardSlot)) throw new ServiceError(400, 'bad_part', `Part ${part} does not fit ${slot}`);
      db.run(
        upsert('board_loadout', ['wallet', 'slot', 'part', 'updated_at'], ['wallet', 'slot'],
          ['part = excluded.part', 'updated_at = excluded.updated_at']),
        wallet, slot, part, t,
      );
      recordEvent(db, wallet, 'builder', 'equip', { slot, part }, t);
    }
    return boardView(db, wallet, t);
  });
}

/** Моя доска целиком: надетое, инвентарь и что можно добыть на этой неделе. */
export function boardView(db: Db, wallet: string, t = now()): BoardView {
  const loadout = boardLoadout(db, wallet);
  const owned = ownedParts(db, wallet);
  const district = boardDistrictOfWeek(weekIndex(t));
  const claimed = !!db.get(`SELECT 1 FROM board_run_grants WHERE wallet = ? AND week = ?`, wallet, weekIndex(t));
  const missing = missingOfDistrict(db, wallet, district);
  return {
    ...loadout,
    wallet,
    owned,
    week: {
      district,
      // Показываем слот, который игроку реально не хватает, а не всегда деку:
      // выдача закрывает дыру, а не плодит копии.
      part: `${missing[0] ?? 'deck'}_d${district}`,
      claimed,
      missing,
    },
    weekProgress: { have: BOARD_SET_SLOTS.length - missing.length, total: BOARD_SET_SLOTS.length },
  };
}

// --------------------------------------------------------------- заезд недели
/**
 * Награда заезда (§5.1): районная часть района недели, один раз в неделю.
 *
 * Выдаётся **недостающий** слот, а не всегда дека: игроку, у которого уже есть
 * дека района, полезнее траки, и наоборот. Если сет района уже собран, часть не
 * выдаётся вовсе — награда исчерпала себя, и это честнее, чем выдавать дубль.
 *
 * Порог — `silver` (2000 очков, LINE_TIERS). Ниже порога часть не выдаётся,
 * потому что «просто доехал» и «проехал линию» — разная игра.
 */
export function grantWeeklyRunPart(db: Db, wallet: string, tier: string, t = now()): { part: string; district: number } | null {
  if (tier === 'none' || tier === 'bronze') return null;
  const week = weekIndex(t);
  const district = boardDistrictOfWeek(week);
  const missing = missingOfDistrict(db, wallet, district);
  if (missing.length === 0) return null;
  const part = `${missing[0]}_d${district}`;
  // Вставка по PK (wallet, week) — и есть проверка «ещё не выдавали»: второй
  // заезд за ту же неделю просто не проходит вставку, без отдельного SELECT.
  // Транзакцию здесь не открываем: выдача вызывается из `submitRun`, который
  // уже внутри своей — иначе доска и заезд окажутся в разных транзакциях.
  const info = db.run(insertIgnore('board_run_grants', ['wallet', 'week', 'part', 'granted_at']), wallet, week, part, t);
  if (!Number(info.changes)) return null;
  grantPart(db, wallet, part, 'run', t);
  return { part, district };
}

/**
 * Награда Floodgrid (с 2026-10-19 заезды убраны из продукта, доски остались
 * коллекцией): сектор, завершённый на 2+ звезды, раз в неделю даёт
 * недостающую часть района недели. Порог по звёздам — аналог бывшего
 * silver-порога заезда: «просто доехал» частью не платится. Таблица
 * board_run_grants переиспользована как реестр недельных выдач (PK
 * wallet+week), чтобы старые заездные выдачи и новые не задвоились.
 */
export function grantWeeklyGridPart(db: Db, wallet: string, stars: number, t = now()): { part: string; district: number } | null {
  if (stars < 2) return null;
  const week = weekIndex(t);
  const district = boardDistrictOfWeek(week);
  const missing = missingOfDistrict(db, wallet, district);
  if (missing.length === 0) return null;
  const part = `${missing[0]}_d${district}`;
  const info = db.run(insertIgnore('board_run_grants', ['wallet', 'week', 'part', 'granted_at']), wallet, week, part, t);
  if (!Number(info.changes)) return null;
  grantPart(db, wallet, part, 'grid', t);
  return { part, district };
}

/** Все части каталога — витрина конструктора; клиент показывает, какие есть. */
export const BOARD_CATALOGUE = BOARD_PARTS;
