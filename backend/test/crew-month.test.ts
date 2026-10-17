// Ежемесячный конкурс команд (docs/16 §5.6).
//
// Что здесь держится:
//   1. месяц считается ОДИН раз: PK месяца в crew_month_settlements;
//   2. ВТОРОЙ месяц тоже считается (регрессия: маркер «часть с
//      created_at ≥ начала месяца» poisoning-ился частями СЕТА
//      предыдущего месяца, который выполняется в самом начале
//      текущего — второй и каждый следующий месяц молча
//      пропускались бы);
//   3. счёт — сумма недель, чей понедельник внутри месяца;
//      неделя учитывается ровно один раз; состав недели —
//      исторический, а не текущий;
//   4. полные команды только (≥5 членов и ≥5 с заездом);
//   5. приз — состав месяца: вступил до конца месяца и не ушёл
//      раньше его начала.
import { beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { Db } from '../src/db.ts';
import { serviceRefHash, toHex } from '../src/services.ts';
import * as crew from '../src/crew.ts';
import { weekIndex, WEEK, WEEK_EPOCH_OFFSET } from '../src/quests.ts';
import { CREW, SERVICE_BY_ID } from '@guttercaps/economy';

const kp = () => Keypair.generate().publicKey.toBase58();
const sig58 = () => kp();
const DAY = 86_400;

/** Нули месяца (UTC) и недели, чей понедельник лежит внутри — та же арифметика, что в crew.ts. */
const monthBounds = (month: number) => {
  const start = Math.floor(Date.UTC(Math.floor(month / 100), (month % 100) - 1, 1) / 1000);
  const end = Math.floor(Date.UTC(Math.floor(month / 100), month % 100, 1) / 1000);
  const weeks: number[] = [];
  for (let w = weekIndex(start); w <= weekIndex(end - 1); w++) {
    const ws = w * WEEK + WEEK_EPOCH_OFFSET;
    if (ws >= start && ws < end) weeks.push(w);
  }
  return { start, end, weeks };
};

let db: Db;

function payName(wallet: string, sig: string, kind: number, payload: Record<string, unknown>, t: number) {
  const ref = toHex(serviceRefHash(kind, wallet, payload));
  db.run(
    `INSERT INTO service_payments (signature, event_index, buyer, kind, currency, amount, burned, ref_hash, slot, block_time)
     VALUES (?, 0, ?, ?, 0, '199', '0', ?, 1, ?)`, sig, wallet, kind, ref, t);
  db.run(
    `INSERT INTO events_raw (signature, ix_index, event_index, program, name, data, slot, finalized_at)
     VALUES (?, 0, 0, 'services', 'ServicePaid', '{}', 1, ?)`, sig, t);
  return ref;
}

const charter = (wallet: string, name: string, district: number, t: number) => {
  const sig = sig58();
  payName(wallet, sig, SERVICE_BY_ID.crewCharter.kind, { id: 'crewCharter', name }, t);
  return crew.charterCrew(db, wallet, name, district, sig);
};

/** Заезды райдера (капитан уже в составе — ему нужны только заезды). */
const runsOf = (wallet: string, weeks: number[], score = 5000, t = 0) => {
  for (const w of weeks) {
    db.run(`INSERT INTO line_runs (wallet, day, week, seed, inputs, score, tricks, best_combo, bails, paid, submitted_at, replay_ttl)
            VALUES (?, ?, ?, 1, '[]', ?, 1, 1, 0, 0, ?, ?)`, wallet, 20_000, w, score, t, t + DAY);
  }
};

/** Живой член команды: встал в неё и ездил в указанных неделях. */
const joins = (crewId: number, wallet: string, weeks: number[], joinedAt: number, leftAt: number | null = null) => {
  db.run(`INSERT INTO crew_members (crew_id, wallet, joined_at, left_at) VALUES (?, ?, ?, ?)`, crewId, wallet, joinedAt, leftAt);
  runsOf(wallet, weeks, 5000, joinedAt);
};

/** Полная команда: капитан + (minMembers-1) райдеров, все с заездами.
 *  Хартия ставит капитану joined_at = real now() — в тестах со
 *  сфабрикованным временем его надо вернуть в месяц. */
const fullCrew = (name: string, district: number, weeks: number[], t: number) => {
  const v = charter(kp(), name, district, t);
  db.run(`UPDATE crew_members SET joined_at = ? WHERE crew_id = ? AND wallet = ?`, t, v.id, v.captain);
  runsOf(v.captain, weeks, 5000, t);
  for (let i = 0; i < CREW.minMembers - 1; i++) joins(v.id, kp(), weeks, t);
  return v;
};

beforeEach(() => { db = new Db(':memory:'); });

describe('settleCrewMonth: маркер сета', () => {
  it('два месяца подряд: второй НЕ съедается маркером первого (регрессия)', () => {
    const sep = monthBounds(202609), oct = monthBounds(202610);
    const t = sep.start + 10 * DAY;
    const crews = [fullCrew('CrewOne', 0, sep.weeks, t), fullCrew('CrewTwo', 1, sep.weeks, t)];

    // Сет сентября выполняется в самом начале октября (как своп сервера).
    const r1 = crew.settleCrewMonth(db, 202609, oct.start + 60);
    expect(r1.alreadySettled).toBe(false);
    expect(r1.prizes).toHaveLength(2);
    for (const p of r1.prizes) expect(p.members).toHaveLength(CREW.minMembers);

    // Октябрь: свежая активность тех же команд.
    crews.forEach((v, i) => {
      runsOf(v.captain, oct.weeks, 5000, oct.start + DAY);
      for (let j = 0; j < CREW.minMembers - 1; j++) joins(v.id, kp(), oct.weeks, oct.start + DAY);
    });
    // Сет октября — в самом начале ноября. Без починки маркера здесь
    // возвращался alreadySettled и призов не было.
    const r2 = crew.settleCrewMonth(db, 202610, monthBounds(202611).start + 60);
    expect(r2.alreadySettled).toBe(false);
    expect(r2.prizes).toHaveLength(2);
    // состав октября: сентябрьские райдеры + новые, все — в призе
    for (const p of r2.prizes) expect(p.members.length).toBeGreaterThanOrEqual(CREW.minMembers);
  });

  it('повторный сет того же месяца — no-op', () => {
    const sep = monthBounds(202609);
    const t = sep.start + 10 * DAY;
    fullCrew('Once', 0, sep.weeks, t);
    const r1 = crew.settleCrewMonth(db, 202609, sep.end + 60);
    expect(r1.prizes).toHaveLength(1);
    const granted = db.scalar(`SELECT COUNT(*) FROM board_parts WHERE part LIKE 'deck_crew_d%'`);
    const r2 = crew.settleCrewMonth(db, 202609, sep.end + 120);
    expect(r2.alreadySettled).toBe(true);
    expect(r2.prizes).toHaveLength(0);
    expect(db.scalar(`SELECT COUNT(*) FROM board_parts WHERE part LIKE 'deck_crew_d%'`)).toBe(granted);
  });

  it('сет пишет строку маркера: без неё месяц не закрыт', () => {
    const sep = monthBounds(202609);
    const t = sep.start + 10 * DAY;
    fullCrew('Marked', 0, sep.weeks, t);
    expect(db.scalar(`SELECT COUNT(*) FROM crew_month_settlements WHERE month = 202609`)).toBe(0);
    crew.settleCrewMonth(db, 202609, sep.end + 60);
    expect(db.scalar(`SELECT COUNT(*) FROM crew_month_settlements WHERE month = 202609`)).toBe(1);
    // строка — внутри той же транзакции, что выдача: крах посреди
    // сета откатывает и призы, и маркер (структурно — db.tx в crew.ts)
    expect(db.scalar(`SELECT COUNT(*) FROM board_parts WHERE part LIKE 'deck_crew_d%'`)).toBe(CREW.minMembers);
  });
});

describe('settleCrewMonth: ранжирование и состав', () => {
  it('неполная команда не считается, приз — весь состав месяца', () => {
    const sep = monthBounds(202609);
    const t = sep.start + 10 * DAY;
    fullCrew('Full', 2, sep.weeks, t);
    const thin = charter(kp(), 'Thin', 2, t); // один райдер — доски недели не хватает
    runsOf(thin.captain, sep.weeks, 5000, t);

    const r = crew.settleCrewMonth(db, 202609, sep.end + 60);
    expect(r.prizes.map((p) => p.name)).toEqual(['Full']);
    // пять райдеров получили часть района команды
    expect(db.scalar(`SELECT COUNT(*) FROM board_parts WHERE part = 'deck_crew_d2'`)).toBe(CREW.minMembers);
  });

  it('состав месяца: вступил до конца — получает, ушедший ДО начала — нет', () => {
    const sep = monthBounds(202609);
    const t = sep.start + 10 * DAY;
    const v = charter(kp(), 'Roster', 1, t);
    db.run(`UPDATE crew_members SET joined_at = ? WHERE crew_id = ? AND wallet = ?`, t, v.id, v.captain);
    const stays = kp(), joinsMid = kp(), leavesMid = kp(), early = kp();
    runsOf(stays, sep.weeks, 5000, t);
    db.run(`INSERT INTO crew_members (crew_id, wallet, joined_at) VALUES (?, ?, ?)`, v.id, stays, t);
    runsOf(joinsMid, sep.weeks, 5000, t);
    db.run(`INSERT INTO crew_members (crew_id, wallet, joined_at) VALUES (?, ?, ?)`, v.id, joinsMid, sep.start + 15 * DAY);
    runsOf(leavesMid, sep.weeks, 5000, t);
    db.run(`INSERT INTO crew_members (crew_id, wallet, joined_at, left_at) VALUES (?, ?, ?, ?)`, v.id, leavesMid, t, sep.start + 20 * DAY);
    runsOf(early, sep.weeks, 5000, t);
    db.run(`INSERT INTO crew_members (crew_id, wallet, joined_at, left_at) VALUES (?, ?, ?, ?)`, v.id, early, t, sep.start - DAY);
    for (let i = 0; i < CREW.minMembers - 2; i++) joins(v.id, kp(), sep.weeks, t);

    const r = crew.settleCrewMonth(db, 202609, sep.end + 60);
    expect(r.prizes).toHaveLength(1);
    const m = r.prizes[0].members;
    expect(m).toContain(stays);       // был весь месяц
    expect(m).toContain(joinsMid);    // вступил в середине месяца
    expect(m).toContain(leavesMid);   // ушёл в середине — ПОСЛЕ начала: в составе месяца
    expect(m).not.toContain(early);   // ушёл ДО начала месяца
  });

  it('уход райдера в следующем месяце не обнуляет прошлые недели', () => {
    const sep = monthBounds(202609);
    const t = sep.start + 10 * DAY;
    const v = fullCrew('Steady', 3, sep.weeks, t);
    // сет сентября — в начале октября
    const r1 = crew.settleCrewMonth(db, 202609, sep.end + 60);
    expect(r1.prizes).toHaveLength(1);
    // в ноябре двое ушли — но сентябрь уже посчитан и оплачен
    const gone = db.all<{ wallet: string }>(`SELECT wallet FROM crew_members WHERE crew_id = ? AND left_at IS NULL LIMIT 2`, v.id);
    for (const m of gone) db.run(`UPDATE crew_members SET left_at = ? WHERE crew_id = ? AND wallet = ?`, sep.end + 40 * DAY, v.id, m.wallet);
    const board = crew.crewMonthBoard(db, 202609);
    expect(board.rows[0].score).toBeGreaterThan(0);
  });

  it('неделя входит в месяц своего понедельника ровно один раз', () => {
    const sep = monthBounds(202609);
    for (const w of sep.weeks) {
      const ws = w * WEEK + WEEK_EPOCH_OFFSET;
      expect(ws).toBeGreaterThanOrEqual(sep.start);
      expect(ws).toBeLessThan(sep.end);
    }
    // неделя, начавшаяся в августе, не входит в сентябрь
    const aug = monthBounds(202608);
    expect(sep.weeks).not.toContain(aug.weeks[aug.weeks.length - 1]);
  });

  it('nextMonthKey: декабрь переходит в январь следующего года', () => {
    expect(crew.nextMonthKey(202601)).toBe(202602);
    expect(crew.nextMonthKey(202612)).toBe(202701);
  });
});
