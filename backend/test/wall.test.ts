// Стена района (docs/16 §3.4): слот нельзя купить — его можно только заслужить.
// Тесты держат ровно это: деньги и вес кошелька здесь ни на что не влияют,
// влияют активность (7 дней подряд) и хотя бы одна крышка в стейкинге.
import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { Db, now } from '../src/db.ts';
import { ServiceError } from '../src/services.ts';
import { dayIndex } from '../src/quests.ts';
import { sanitizeTagSvg, saveTag } from '../src/tags.ts';
import { WALL_ACTIVE_DAYS, WALL_FADE_DAYS, WALL_SLOTS, activeDayStreak, claimSlot, expireSlots, myWall, releaseSlot, releaseTag, renewSlot, wallEligibility, wallView } from '../src/wall.ts';

const kp = () => Keypair.generate().publicKey.toBase58();
const DAY = 86_400;
const today = () => dayIndex(now());
const fails = (fn: () => unknown, code: string) => {
  try { fn(); } catch (e) { expect((e as ServiceError).code).toBe(code); return; }
  throw new Error(`ожидалась ошибка ${code}`);
};

const TAG = (n = 1) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 512"><path d="M${n} ${n}L${n + 20} ${n + 30}" stroke="#FF2E8A" stroke-width="8" fill="none"/></svg>`;

function seedDays(db: Db, wallet: string, days: number, until = today()) {
  for (let i = 0; i < days; i++) db.run(`INSERT OR IGNORE INTO quest_logins (wallet, day) VALUES (?, ?)`, wallet, until - i);
}
function seedStake(db: Db, wallet: string) {
  db.run(`INSERT INTO stakes (key, owner, kind, amount, weight, unlock_at, since, slot, active) VALUES (?, ?, 1, '1', '1000', 0, ?, 1, 1)`, kp(), wallet, now());
}
/** Игрок, который выполнил оба условия: активность и стейкинг. */
function seedEligible(db: Db, wallet: string) {
  seedDays(db, wallet, WALL_ACTIVE_DAYS);
  seedStake(db, wallet);
}

describe('wall — право на слот', () => {
  it('считает серию дней подряд и прощает вчерашний день', () => {
    const db = new Db(':memory:');
    const w = kp();
    seedDays(db, w, 6);
    expect(activeDayStreak(db, w)).toBe(6);
    seedDays(db, w, 1, today() - 6);
    expect(activeDayStreak(db, w)).toBe(WALL_ACTIVE_DAYS); // 7 подряд
    // разрыв в один день ломает серию
    const other = kp();
    seedDays(db, other, 3);
    seedDays(db, other, 3, today() - 4);
    expect(activeDayStreak(db, other)).toBe(3);
    // вчера, но не сегодня — серия仍然 жива (часовая поправка)
    const tz = kp();
    seedDays(db, tz, WALL_ACTIVE_DAYS, today() - 1);
    expect(activeDayStreak(db, tz)).toBe(WALL_ACTIVE_DAYS);
  });

  it('деньги не заменяют условия: ни активности, ни стейка — нет и слота', () => {
    const db = new Db(':memory:');
    const w = kp();
    expect(wallEligibility(db, w)).toMatchObject({ eligible: false, reason: 'need_active_days' });
    seedDays(db, w, WALL_ACTIVE_DAYS);
    expect(wallEligibility(db, w)).toMatchObject({ eligible: false, reason: 'need_staked_cap' });
    seedStake(db, w);
    expect(wallEligibility(db, w)).toMatchObject({ eligible: true, reason: null, activeDays: WALL_ACTIVE_DAYS, stakedCaps: 1 });
  });

  it('без права занимать слот нельзя', () => {
    const db = new Db(':memory:');
    const w = kp();
    const tag = saveTag(db, w, TAG());
    fails(() => claimSlot(db, w, 0, tag.id), 'not_eligible');
    seedDays(db, w, WALL_ACTIVE_DAYS);
    fails(() => claimSlot(db, w, 0, tag.id), 'not_eligible'); // есть активность, нет стейка
  });
});

describe('wall — занятие и жизнь слота', () => {
  it('раздаёт слоты по порядку и уважает явный выбор', () => {
    const db = new Db(':memory:');
    const a = kp(), b = kp();
    seedEligible(db, a); seedEligible(db, b);
    const ta = saveTag(db, a, TAG(1)), tb = saveTag(db, b, TAG(2));
    expect(claimSlot(db, a, 0, ta.id).slot).toBe(0);
    expect(claimSlot(db, b, 0, tb.id).slot).toBe(1);
    expect(wallView(db, 0).taken).toBe(2);
    const c = kp();
    seedEligible(db, c);
    expect(claimSlot(db, c, 0, saveTag(db, c, TAG(3)).id, 42).slot).toBe(42);
  });

  it('один кошелёк — один слот в районе: второй тег меняет первый на месте', () => {
    const db = new Db(':memory:');
    const w = kp();
    seedEligible(db, w);
    const first = claimSlot(db, w, 3, saveTag(db, w, TAG(1)).id);
    const second = claimSlot(db, w, 3, saveTag(db, w, TAG(2)).id);
    expect(second.slot).toBe(first.slot);
    expect(second.tagId).not.toBe(first.tagId);
    expect(wallView(db, 3).items).toHaveLength(1);
    // старый тег остался слоем краски под новым
    expect(wallView(db, 3).layers.map((l) => l.tagId)).toEqual([first.tagId]);
  });

  it('чужой и скрытый тег на стену не вешают', () => {
    const db = new Db(':memory:');
    const w = kp(), other = kp();
    seedEligible(db, w);
    const foreign = saveTag(db, other, TAG(5));
    fails(() => claimSlot(db, w, 0, foreign.id), 'not_your_tag');
  });

  it('продление требует того же, что занятие, и двигает выцветание', () => {
    const db = new Db(':memory:');
    const w = kp();
    seedEligible(db, w);
    const slot = claimSlot(db, w, 1, saveTag(db, w, TAG(1)).id);
    db.run(`UPDATE wall_slots SET expires_at = ? WHERE district = 1 AND slot = ?`, now() + 3 * DAY, slot.slot); // до выцветания 3 дня
    const renewed = renewSlot(db, w, 1);
    // продление — это снова 30 дней от сейчас, а не «+30 к остатку»
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThanOrEqual((now() + (WALL_FADE_DAYS - 1) * DAY) * 1000);
    expect(renewed.renewedAt).not.toBeNull();
    db.run(`UPDATE stakes SET active = 0 WHERE owner = ?`, w); // снял крышку из стейка
    fails(() => renewSlot(db, w, 1), 'not_eligible');
  });

  it('снятие и выцветание освобождают слот и уходят в историю', () => {
    const db = new Db(':memory:');
    const w = kp();
    seedEligible(db, w);
    const tag = saveTag(db, w, TAG(1));
    claimSlot(db, w, 2, tag.id);
    releaseSlot(db, w, 2);
    expect(wallView(db, 2).taken).toBe(0);
    expect(wallView(db, 2).layers).toHaveLength(1);

    claimSlot(db, w, 2, tag.id);
    db.run(`UPDATE wall_slots SET expires_at = ? WHERE district = 2`, now() - 1);
    expect(expireSlots(db)).toBe(1);
    expect(wallView(db, 2).taken).toBe(0);
    expect(myWall(db, w).items).toHaveLength(0);
  });

  it('скрытый модератором тег перестаёт занимать стену', () => {
    const db = new Db(':memory:');
    const w = kp();
    seedEligible(db, w);
    const tag = saveTag(db, w, TAG(1));
    claimSlot(db, w, 4, tag.id);
    expect(wallView(db, 4).taken).toBe(1);
    expect(releaseTag(db, tag.id)).toBe(1);
    expect(wallView(db, 4).taken).toBe(0);
  });

  it('когда стена полна, берётся другой район, а не деньги', () => {
    const db = new Db(':memory:');
    const w = kp();
    seedEligible(db, w);
    const tag = saveTag(db, w, TAG(1));
    for (let i = 0; i < WALL_SLOTS; i++) {
      const ghost = kp();
      db.run(`INSERT INTO wall_slots (district, slot, wallet, tag_id, applied_at, expires_at, renewed_at) VALUES (0, ?, ?, ?, ?, ?, NULL)`,
        i, ghost, tag.id, now(), now() + DAY);
    }
    fails(() => claimSlot(db, w, 0, tag.id), 'wall_full');
    expect(claimSlot(db, w, 5, tag.id).slot).toBe(0); // соседний район свободен
  });
});

describe('wall — формат', () => {
  it('стена отдаёт ссылки на теги, а не их текст: JSON остаётся лёгким', () => {
    const db = new Db(':memory:');
    const w = kp();
    seedEligible(db, w);
    const tag = saveTag(db, w, TAG(1));
    claimSlot(db, w, 0, tag.id);
    const view = wallView(db, 0, w);
    expect(view.slots).toBe(WALL_SLOTS);
    expect(view.items[0]!.tagId).toBe(tag.id);
    expect(JSON.stringify(view)).not.toContain('<svg'); // сам SVG грузится отдельной картинкой
    expect(view.me).toMatchObject({ eligible: true, mySlot: 0 });
    expect(sanitizeTagSvg(tag.svg!).svg.startsWith('<svg')).toBe(true);
  });
});
