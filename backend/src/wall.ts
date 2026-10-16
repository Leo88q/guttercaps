// =============================================================================
// GUTTERCAPS — стена района (docs/16 §3.4)
// -----------------------------------------------------------------------------
// Слот на стене — единственное место в городе, которое нельзя купить. Занять
// его можно активностью (7 дней подряд) плюс хотя бы одной крышкой в стейкинге,
// а держать — всё тем же: слот выцветает за 30 дней, и обновить его можно
// только продолжая играть. Решение 6 в docs/16 §0.3 прямо запрещает продавать
// охват: богатый кошелёк не забирает стену целиком.
//
// Что здесь НЕ написано, и это осознанно: ни одна проверка не смотрит на вес
// стейка, размер кошелька и покупки. Активность — единственный ключ.
// =============================================================================

import type { Db } from './db.ts';
import { now } from './db.ts';
import { ServiceError } from './services.ts';
import { dayIndex } from './quests.ts';
import { publish } from './bus.ts';
import { recordEvent } from './worldMetrics.ts';

export const WALL_SLOTS = 200;              // на район: 1600 живых тегов на город
export const WALL_ACTIVE_DAYS = 7;          // подряд, а не суммарно
export const WALL_FADE_DAYS = 30;           // выцветание
/** Сколько прошлых тегов видно под свежим: слои краски, а не кладбище. */
export const WALL_LAYERS = 3;

const DAY = 86_400;
const iso = (s: number) => new Date(s * 1000).toISOString();

interface SlotRow {
  district: number; slot: number; wallet: string; tag_id: string;
  applied_at: number; expires_at: number; renewed_at: number | null;
}

/**
 * Серия активных дней подряд. Считаем по quest_logins — это уже существующий
 * и честный сигнал «игрок заходил» (он же кормит DAU и ежедневный квест).
 * Серия может заканчиваться сегодня или вчера: иначе игрок в UTC+12 терял бы
 * слот каждый раз, когда полночь по UTC проходит раньше его вечера.
 */
export function activeDayStreak(db: Db, wallet: string, today = dayIndex(now())): number {
  const rows = db.all<{ day: number }>(`SELECT day FROM quest_logins WHERE wallet = ? AND day > ? AND day <= ?`, wallet, today - 400, today);
  const days = new Set(rows.map((r) => r.day));
  const end = days.has(today) ? today : days.has(today - 1) ? today - 1 : null;
  if (end === null) return 0;
  let n = 0;
  for (let d = end; days.has(d); d--) n++;
  return n;
}

/** Право занять слот: заявка, которую видит игрок до нажатия кнопки. */
export function wallEligibility(db: Db, wallet: string) {
  const activeDays = activeDayStreak(db, wallet);
  const stakedCaps = db.scalar(`SELECT COUNT(*) FROM stakes WHERE owner = ? AND kind = 1 AND active = 1`, wallet);
  const okDays = activeDays >= WALL_ACTIVE_DAYS;
  const okStake = stakedCaps >= 1;
  return {
    activeDays, activeDaysNeeded: WALL_ACTIVE_DAYS, stakedCaps, stakedCapsNeeded: 1,
    eligible: okDays && okStake,
    reason: okDays && okStake ? null : okDays ? 'need_staked_cap' : 'need_active_days',
  };
}

export interface WallSlotView {
  slot: number; wallet: string; tagId: string;
  appliedAt: string; expiresAt: string; renewedAt: string | null;
}
export interface WallLayerView {
  slot: number; wallet: string; tagId: string;
  appliedAt: string; releasedAt: string;
}

export interface WallView {
  district: number; slots: number; taken: number;
  items: WallSlotView[]; layers: WallLayerView[];
  /** Право зрителя занять слот — чтобы кнопка не молчала. */
  me?: ReturnType<typeof wallEligibility> & { mySlot: number | null };
}

/**
 * Стена района. Теги отдаются ссылкой на /v1/tags/{id}/svg, а не текстом:
 * браузер кеширует картинку, а JSON стены остаётся в сотни байт на слот.
 */
export function wallView(db: Db, district: number, viewer?: string): WallView {
  const rows = db.all<SlotRow>(`SELECT * FROM wall_slots WHERE district = ? ORDER BY slot`, district);
  const live = new Set(db.all<{ id: string }>(`SELECT id FROM tag_registry WHERE status = 'live'`).map((r) => r.id));
  const items: WallSlotView[] = [];
  for (const r of rows) {
    // Скрытый или удалённый тег не занимает стену: слот показывается пустым,
    // пока не выцветает по дате (событие tag.hidden заставляет клиента
    // перечитать стену).
    if (!live.has(r.tag_id)) continue;
    items.push({
      slot: r.slot, wallet: r.wallet, tagId: r.tag_id,
      appliedAt: iso(r.applied_at), expiresAt: iso(r.expires_at), renewedAt: r.renewed_at === null ? null : iso(r.renewed_at),
    });
  }
  const layers = db
    .all<{ slot: number; wallet: string; tag_id: string; applied_at: number; released_at: number }>(
      `SELECT slot, wallet, tag_id, applied_at, released_at FROM wall_slot_history` +
        ` WHERE district = ? AND tag_id IN (SELECT id FROM tag_registry WHERE status = 'live')` +
        ` ORDER BY slot, released_at DESC`,
      district,
    )
    .slice(0, WALL_SLOTS * WALL_LAYERS)
    .map((h) => ({ slot: h.slot, wallet: h.wallet, tagId: h.tag_id, appliedAt: iso(h.applied_at), releasedAt: iso(h.released_at) }));

  const out: WallView = { district, slots: WALL_SLOTS, taken: items.length, items, layers };
  if (viewer) {
    const mine = rows.find((r) => r.wallet === viewer);
    out.me = { ...wallEligibility(db, viewer), mySlot: mine?.slot ?? null };
  }
  return out;
}

function toHistory(db: Db, r: SlotRow) {
  db.run(
    `INSERT INTO wall_slot_history (district, slot, wallet, tag_id, applied_at, released_at) VALUES (?, ?, ?, ?, ?, ?)`,
    r.district, r.slot, r.wallet, r.tag_id, r.applied_at, now(),
  );
}

/** Освободить все слоты, где висел тег (модерация скрыла — стена не должна показывать пустое место вечно). */
export function releaseTag(db: Db, tagId: string): number {
  const rows = db.all<SlotRow>(`SELECT * FROM wall_slots WHERE tag_id = ?`, tagId);
  for (const r of rows) {
    toHistory(db, r);
    db.run(`DELETE FROM wall_slots WHERE district = ? AND slot = ?`, r.district, r.slot);
    publish({ wallets: [r.wallet], type: 'wall.slot_released', payload: { district: r.district, slot: r.slot, reason: 'tag_hidden' } });
    recordEvent(db, r.wallet, 'wall', 'release', { district: r.district, slot: r.slot, reason: 'tag_hidden' });
  }
  return rows.length;
}

/** POST /v1/wall/{district}/claim — занять слот. Один слот на кошелёк в районе. */
export function claimSlot(db: Db, wallet: string, district: number, tagId: string, preferred?: number): WallSlotView {
  if (district < 0 || district >= 8) throw new ServiceError(400, 'bad_district', 'district must be 0..7');
  const tag = db.get<{ id: string; wallet: string; status: string }>(`SELECT id, wallet, status FROM tag_registry WHERE id = ?`, tagId);
  if (!tag || tag.status !== 'live') throw new ServiceError(400, 'tag_not_live', 'The tag must be yours and live');
  if (tag.wallet !== wallet) throw new ServiceError(403, 'not_your_tag', 'You can only hang your own tag');
  const claim = wallEligibility(db, wallet);
  if (!claim.eligible) throw new ServiceError(409, 'not_eligible', claim.reason === 'need_staked_cap'
    ? 'Stake at least one cap and come back' : `Play ${WALL_ACTIVE_DAYS} days in a row to earn a slot`);

  return db.tx(() => {
    const mine = db.get<SlotRow>(`SELECT * FROM wall_slots WHERE district = ? AND wallet = ?`, district, wallet);
    if (mine) {
      // Свой слот не плодим: меняем тег на нём и продлеваем — «обновить тег бесплатно».
      if (mine.tag_id !== tagId) {
        toHistory(db, mine);
        db.run(`UPDATE wall_slots SET tag_id = ?, applied_at = ?, expires_at = ?, renewed_at = NULL WHERE district = ? AND slot = ?`,
          tagId, now(), now() + WALL_FADE_DAYS * DAY, district, mine.slot);
      } else {
        db.run(`UPDATE wall_slots SET applied_at = ?, expires_at = ? WHERE district = ? AND slot = ?`,
          now(), now() + WALL_FADE_DAYS * DAY, district, mine.slot);
      }
      return slotView(db, district, mine.slot)!;
    }
    const taken = new Set(db.all<{ slot: number }>(`SELECT slot FROM wall_slots WHERE district = ?`, district).map((r) => r.slot));
    let slot = preferred !== undefined && !taken.has(preferred) && preferred >= 0 && preferred < WALL_SLOTS ? preferred : -1;
    if (slot < 0) for (let i = 0; i < WALL_SLOTS; i++) if (!taken.has(i)) { slot = i; break; }
    if (slot < 0) throw new ServiceError(409, 'wall_full', 'Every slot on this wall is taken — try another district');
    db.run(
      `INSERT INTO wall_slots (district, slot, wallet, tag_id, applied_at, expires_at, renewed_at) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      district, slot, wallet, tagId, now(), now() + WALL_FADE_DAYS * DAY,
    );
    // Событие — в той же транзакции: иначе отчёт §12 разойдётся с самой стеной.
    recordEvent(db, wallet, 'wall', 'claim', { district, slot });
    return slotView(db, district, slot)!;
  });
}

function slotView(db: Db, district: number, slot: number): WallSlotView | null {
  const r = db.get<SlotRow>(`SELECT * FROM wall_slots WHERE district = ? AND slot = ?`, district, slot);
  if (!r) return null;
  return {
    slot: r.slot, wallet: r.wallet, tagId: r.tag_id,
    appliedAt: iso(r.applied_at), expiresAt: iso(r.expires_at), renewedAt: r.renewed_at === null ? null : iso(r.renewed_at),
  };
}

/** POST /v1/wall/{district}/renew — продлить ещё на 30 дней. Требование то же, что при занятии. */
export function renewSlot(db: Db, wallet: string, district: number): WallSlotView {
  const row = db.get<SlotRow>(`SELECT * FROM wall_slots WHERE district = ? AND wallet = ?`, district, wallet);
  if (!row) throw new ServiceError(404, 'no_slot', 'You hold no slot on this wall');
  const claim = wallEligibility(db, wallet);
  if (!claim.eligible) throw new ServiceError(409, 'not_eligible', claim.reason === 'need_staked_cap'
    ? 'Stake at least one cap to renew' : `Play ${WALL_ACTIVE_DAYS} days in a row to renew`);
  db.run(`UPDATE wall_slots SET expires_at = ?, renewed_at = ? WHERE district = ? AND slot = ?`,
    now() + WALL_FADE_DAYS * DAY, now(), district, row.slot);
  recordEvent(db, wallet, 'wall', 'renew', { district, slot: row.slot });
  return slotView(db, district, row.slot)!;
}

/** POST /v1/wall/{district}/release — снять свой тег со стены самому. */
export function releaseSlot(db: Db, wallet: string, district: number): { ok: true } {
  const row = db.get<SlotRow>(`SELECT * FROM wall_slots WHERE district = ? AND wallet = ?`, district, wallet);
  if (!row) throw new ServiceError(404, 'no_slot', 'You hold no slot on this wall');
  toHistory(db, row);
  db.run(`DELETE FROM wall_slots WHERE district = ? AND slot = ?`, district, row.slot);
  return { ok: true as const };
}

/**
 * Выцветание: просроченные слоты уходят в историю. Вызывается и по таймеру
 * (как arena.sweep), и лениво на чтении стены — так стена не показывает
 * мёртвые слоты даже в процессе, где таймер не поднят.
 */
export function expireSlots(db: Db, at = now()): number {
  const rows = db.all<SlotRow>(`SELECT * FROM wall_slots WHERE expires_at <= ?`, at);
  for (const r of rows) {
    toHistory(db, r);
    db.run(`DELETE FROM wall_slots WHERE district = ? AND slot = ?`, r.district, r.slot);
    publish({ wallets: [r.wallet], type: 'wall.slot_expired', payload: { district: r.district, slot: r.slot } });
    recordEvent(db, r.wallet, 'wall', 'expire', { district: r.district, slot: r.slot });
  }
  return rows.length;
}

/** GET /v1/me/wall — что у меня занято и хватает ли активности, чтобы занять ещё. */
export function myWall(db: Db, wallet: string) {
  const rows = db.all<SlotRow>(`SELECT * FROM wall_slots WHERE wallet = ? ORDER BY district`, wallet);
  return {
    eligibility: wallEligibility(db, wallet),
    items: rows.map((r) => ({
      district: r.district, slot: r.slot, tagId: r.tag_id,
      appliedAt: iso(r.applied_at), expiresAt: iso(r.expires_at),
      daysLeft: Math.max(0, Math.ceil((r.expires_at - now()) / DAY)),
    })),
  };
}
