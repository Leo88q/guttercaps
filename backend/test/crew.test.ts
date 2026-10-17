// Команды (docs/16 §5.6).
//
// Что здесь держится:
//   1. хартия покупает имя и доску, но не стену: сегмент занимается так же, как слот;
//   2. имя команды — модель хендла: алфавит, блоклист, бронь, 30 дней, 90 дней карантина;
//   3. платёж тратится ровно один раз и только на то имя, под которое он подписан;
//   4. командный результат — пять лучших, а не весь состав;
//   5. жалоба на имя идёт в ту же очередь, что жалоба на тег.
import { beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { Db, now } from '../src/db.ts';
import { serviceRefHash, toHex, type ServiceError } from '../src/services.ts';
import * as crew from '../src/crew.ts';
import { weekIndex } from '../src/quests.ts';
import { CREW, SERVICE_BY_ID } from '@guttercaps/economy';

const kp = () => Keypair.generate().publicKey.toBase58();
const sig58 = () => kp();
const DAY = 86_400;
const T0 = 1_700_000_000;
/** Неделя «сейчас»: доска и карточки считают результат за текущую неделю. */
const WEEK = weekIndex(now());

const fails = (fn: () => unknown, code: string) => {
  try { fn(); } catch (e) { expect((e as ServiceError).code).toBe(code); return; }
  throw new Error(`ожидалась ошибка ${code}`);
};

let db: Db;

/** Платёж за имя: ровно тот разбор, что делает продакшен (ServicePaid + финализация). */
function payName(wallet: string, sig: string, kind: number, payload: Record<string, unknown>, t = T0) {
  const ref = toHex(serviceRefHash(kind, wallet, payload));
  db.run(
    `INSERT INTO service_payments (signature, event_index, buyer, kind, currency, amount, burned, ref_hash, slot, block_time)
     VALUES (?, 0, ?, ?, 0, '199', '0', ?, 1, ?)`, sig, wallet, kind, ref, t);
  db.run(
    `INSERT INTO events_raw (signature, ix_index, event_index, program, name, data, slot, finalized_at)
     VALUES (?, 0, 0, 'services', 'ServicePaid', '{}', 1, ?)`, sig, t);
  return ref;
}

const charter = (wallet: string, name: string, district = 0, sig = sig58(), t = T0) => {
  payName(wallet, sig, SERVICE_BY_ID.crewCharter.kind, { id: 'crewCharter', name }, t);
  return crew.charterCrew(db, wallet, name, district, sig);
};
/** Заезд участника за неделю: командная доска считается по лучшим заездам линии. */
const runOf = (wallet: string, score: number, week = WEEK) =>
  db.run(`INSERT INTO line_runs (wallet, day, week, seed, inputs, score, tricks, best_combo, bails, paid, submitted_at, replay_ttl)
          VALUES (?, ?, ?, 1, '[]', ?, 1, 1, 0, 0, ?, ?)`, wallet, week * 7, week, score, T0, T0 + DAY);

beforeEach(() => { db = new Db(':memory:'); });

describe('команда: хартия', () => {
  it('имя, состав и сегмент стены; платёж тратится один раз', () => {
    const w = kp();
    const v = charter(w, 'GutterKids');
    expect(v.name).toBe('GutterKids');
    expect(v.captain).toBe(w);
    expect(v.memberCount).toBe(1);
    expect(v.iAmCaptain).toBe(true);
    expect(v.slots).toEqual({ from: 0, to: CREW.wallSegmentSlots, size: CREW.wallSegmentSlots });
    expect(v.inviteCode).toMatch(/^[A-Z0-9]{8}$/);
    expect(v.counts).toBe(false); // одна живая душа — это не команда
    // платёж списан: вторая хартия по той же подписи не проходит
    const sig = db.get<{ signature: string }>(`SELECT signature FROM service_payments WHERE buyer = ?`, w)!.signature;
    expect(db.scalar(`SELECT COUNT(*) FROM service_payments WHERE signature = ? AND consumed_by IS NOT NULL`, sig)).toBe(1);
  });

  it('хартия за другое имя не подходит: платёж привязан к имени', () => {
    const w = kp();
    const sig = sig58();
    payName(w, sig, SERVICE_BY_ID.crewCharter.kind, { id: 'crewCharter', name: 'One' });
    fails(() => crew.charterCrew(db, w, 'Two', 0, sig), 'ref_hash_mismatch');
    expect(db.scalar(`SELECT COUNT(*) FROM crews`)).toBe(0);
    expect(db.scalar(`SELECT COUNT(*) FROM service_payments WHERE consumed_by IS NOT NULL`)).toBe(0);
  });

  it('одна команда на кошелёк: вторая хартия не создаётся', () => {
    const w = kp();
    charter(w, 'First');
    fails(() => charter(w, 'Second'), 'already_in_crew');
  });

  it('сегменты района кончаются: одиннадцатая команда без места', () => {
    const per = crew.CREW_SEGMENTS_PER_DISTRICT;
    for (let i = 0; i < per; i++) charter(kp(), `Crew${i}`);
    expect(crew.crewSegments(db)).toEqual([{ district: 0, segments: per, taken: per }]);
    fails(() => charter(kp(), 'NoRoom'), 'district_full');
  });
});

describe('команда: имя — это модель хендла', () => {
  it('алфавит, блоклист и регистр: одна модель на весь город', () => {
    const w = kp();
    const check = crew.crewCheck(db, w, 'Gu');
    expect(check.available).toBe(false);
    expect(check.reason).toBe('invalid');
    expect(crew.crewCheck(db, w, 'admin').reason).toBe('blocked');
    fails(() => charter(w, 'bad name'), 'invalid_name');

    charter(w, 'Gutter');
    // «gutter» и «GUTTER» — занято тем же именем
    expect(crew.crewCheck(db, kp(), 'gutter').reason).toBe('taken');
    fails(() => charter(kp(), 'GUTTER'), 'crew_taken');
  });

  it('бронь держит имя два минуты — но только для чужого кошелька', () => {
    const a = kp();
    const b = kp();
    const held = crew.crewCheck(db, a, 'Hold');
    expect(held.available).toBe(true);
    expect(held.reservedUntil).toBeTruthy();
    // a ещё может взять имя сам, b — уже нет
    expect(crew.crewCheck(db, a, 'Hold').available).toBe(true);
    expect(crew.crewCheck(db, b, 'Hold').reason).toBe('reserved');
    // бронь истекла — имя снова свободно для всех
    db.run(`UPDATE crew_reservations SET expires_at = ?`, now() - 1);
    expect(crew.crewCheck(db, b, 'Hold').available).toBe(true);
  });

  it('переименование: только капитан, раз в 30 дней, старое имя в карантин на 90', () => {
    const captain = kp();
    const mate = kp();
    charter(captain, 'OldName');
    const code = crew.myCrew(db, captain)!.inviteCode!;
    crew.joinCrew(db, mate, code);

    // не капитан платить не может, даже заплатив
    const badSig = sig58();
    payName(mate, badSig, SERVICE_BY_ID.crewRename.kind, { id: 'crewRename', name: 'NewName' });
    fails(() => crew.renameCrew(db, mate, 'NewName', badSig), 'not_captain');

    // пауза 30 дней считается от создания: свежая команда имени не меняет
    expect(crew.crewCheck(db, captain, 'NewName').reason).toBe('cooldown');

    // команда создана 31 день назад — пауза прошла
    db.run(`UPDATE crews SET created_at = ? WHERE captain = ?`, now() - 31 * DAY, captain);
    const sig = sig58();
    payName(captain, sig, SERVICE_BY_ID.crewRename.kind, { id: 'crewRename', name: 'NewName' });
    const renamed = crew.renameCrew(db, captain, 'NewName', sig);
    expect(renamed.name).toBe('NewName');
    expect(crew.myCrew(db, mate)!.name).toBe('NewName'); // команда одна на всех

    // старое имя в карантине: подобрать его нельзя
    expect(crew.crewCheck(db, kp(), 'OldName').reason).toBe('taken');
    db.run(`UPDATE crew_name_history SET released_at = ?`, now() - 91 * DAY);
    expect(crew.crewCheck(db, kp(), 'OldName').available).toBe(true);
  });
});

describe('команда: состав', () => {
  const five = () => [kp(), kp(), kp(), kp(), kp()];

  it('пять-десять человек, вступление по коду, один кошелёк — одна команда', () => {
    const captain = kp();
    charter(captain, 'Roster');
    const code = crew.myCrew(db, captain)!.inviteCode!;
    const mates = five().slice(1);
    for (const m of mates) crew.joinCrew(db, m, code);
    const v = crew.myCrew(db, captain)!;
    expect(v.memberCount).toBe(5);
    expect(v.counts).toBe(false); // заездов ещё нет

    fails(() => crew.joinCrew(db, kp(), 'NOPE0000'), 'bad_code');
    const extra: string[] = [];
    for (let i = 0; i < CREW.maxMembers - 5; i++) { const w = kp(); extra.push(w); crew.joinCrew(db, w, code); }
    fails(() => crew.joinCrew(db, kp(), code), 'crew_full');
    expect(crew.myCrew(db, captain)!.memberCount).toBe(CREW.maxMembers);

    // выход и возврат: ушедший не считается новым, состав не дублируется
    const gone = extra[0];
    crew.leaveCrew(db, gone);
    expect(crew.myCrew(db, captain)!.memberCount).toBe(CREW.maxMembers - 1);
    crew.joinCrew(db, gone, code);
    expect(crew.myCrew(db, captain)!.memberCount).toBe(CREW.maxMembers);
    expect(crew.myCrew(db, gone)!.id).toBe(crew.myCrew(db, captain)!.id);
    // вступить второй раз нельзя: проверка состава идёт раньше кода
    fails(() => crew.joinCrew(db, gone, code), 'already_in_crew');
  });

  it('капитан, уходящий последним, передаёт роль старейшему участнику', () => {
    const captain = kp();
    charter(captain, 'Handover');
    const code = crew.myCrew(db, captain)!.inviteCode!;
    const a = kp();
    const b = kp();
    crew.joinCrew(db, a, code);
    crew.joinCrew(db, b, code);
    // старейшинство — по joined_at: у a и b секунды могут совпасть, раскидываем их
    db.run(`UPDATE crew_members SET joined_at = ? WHERE wallet = ?`, now() - 10, a);
    db.run(`UPDATE crew_members SET joined_at = ? WHERE wallet = ?`, now() - 5, b);
    const out = crew.leaveCrew(db, captain);
    expect(out.captain).toBe(a); // joined_at ASC — старейший после капитана
    expect(crew.myCrew(db, a)!.iAmCaptain).toBe(true);
    expect(crew.myCrew(db, captain)).toBe(null);
  });
});

describe('команда: доска считается по пяти лучшим', () => {
  it('десять человек не побеждают пятерых одной численностью', () => {
    const week = WEEK;
    const captain = kp();
    charter(captain, 'Five');
    const code = crew.myCrew(db, captain)!.inviteCode!;
    const strong = [captain];
    for (let i = 0; i < 4; i++) { const w = kp(); crew.joinCrew(db, w, code); strong.push(w); }
    strong.forEach((w, i) => runOf(w, 3_000 + i, week));

    const boss = kp();
    charter(boss, 'Ten', 1);
    const code2 = crew.myCrew(db, boss)!.inviteCode!;
    const many = [boss];
    for (let i = 0; i < 9; i++) { const w = kp(); crew.joinCrew(db, w, code2); many.push(w); }
    // у всех десяти есть заезд, но слабый: 1 000 × 5 = 5 000 против 14 950
    many.forEach((w) => runOf(w, 500, week));

    const board = crew.crewBoard(db, week);
    expect(board.rows[0].name).toBe('Five');
    expect(board.rows[0].score).toBe(3_000 + 3_001 + 3_002 + 3_003 + 3_004);
    expect(board.rows[1].score).toBe(2_500);
    expect(board.rows[0].members).toBe(5);
    expect(board.rows[1].members).toBe(10);
    expect(board.rows[0].tier).toBe('gold'); // CREW_TIERS: золото = 15 000 за пятерых
    expect(board.rows[1].tier).toBe('none');
  });

  it('команда из пяти без заездов на доску не попадает', () => {
    const week = WEEK;
    const captain = kp();
    charter(captain, 'Quiet');
    const code = crew.myCrew(db, captain)!.inviteCode!;
    const mates = [captain];
    for (let i = 0; i < 4; i++) { const w = kp(); crew.joinCrew(db, w, code); mates.push(w); }
    expect(crew.crewBoard(db, week).rows).toEqual([]);
    mates.forEach((w) => runOf(w, 500, week));
    const board = crew.crewBoard(db, week);
    expect(board.rows.length).toBe(1);
    expect(crew.myCrew(db, captain)!.counts).toBe(true);
  });

  it('шестой участник команду не поднимает', () => {
    const week = WEEK;
    const captain = kp();
    charter(captain, 'Cap');
    const code = crew.myCrew(db, captain)!.inviteCode!;
    const mates = [captain];
    for (let i = 0; i < 5; i++) { const w = kp(); crew.joinCrew(db, w, code); mates.push(w); }
    mates.forEach((w, i) => runOf(w, 1_000 + i, week)); // 1000..1005 → в сумму идут 1001..1005
    const v = crew.myCrew(db, captain)!;
    expect(v.score).toBe(1_005 + 1_004 + 1_003 + 1_002 + 1_001);
    expect(v.members.filter((m) => m.counting).length).toBe(5);
    expect(v.members.filter((m) => !m.counting)[0].bestWeek).toBe(1_000);
  });
});

describe('команда: модерация имени — одна очередь на весь UGC', () => {
  it('жалоба на имя команды лежит в wall_reports и одна на репортёра', () => {
    const captain = kp();
    charter(captain, 'Reported');
    const viewer = kp();
    const r = crew.reportCrew(db, viewer, 'reported', 'Name impersonates a district crew');
    expect(r.crew).toBe(crew.crewView(db, 'Reported').id);
    expect(r.reports).toBe(1);
    const row = db.get<{ crew_id: number | null; tag_id: string; reporter: string; resolution: string | null }>(
      `SELECT crew_id, tag_id, reporter, resolution FROM wall_reports`);
    expect(row!.crew_id).toBe(r.crew);
    expect(row!.reporter).toBe(viewer);
    fails(() => crew.reportCrew(db, viewer, 'Reported', 'again'), 'already_reported');
    fails(() => crew.reportCrew(db, viewer, 'Reported', ''), 'bad_reason');
    fails(() => crew.reportCrew(db, kp(), 'no-such-crew', 'impersonating a district crew'), 'no_crew');
  });
});

describe('команда: сегмент держится активностью (решение 6, §0.3)', () => {
  /** Заезд с явным submitted_at — экспирация смотрит на свежесть активности. */
  const runAt = (wallet: string, submittedAt: number) =>
    db.run(`INSERT INTO line_runs (wallet, day, week, seed, inputs, score, tricks, best_combo, bails, paid, submitted_at, replay_ttl)
            VALUES (?, 0, 0, 1, '[]', 10, 1, 1, 0, 0, ?, ?)`, wallet, submittedAt, submittedAt + DAY);

  it('неактивный состав теряет сегмент: archived, имя в карантин, сегмент свободен', () => {
    charter(kp(), 'SleepyCrew');
    const t = now() + (CREW.segmentExpireDays + 1) * DAY;
    expect(crew.expireCrewSegments(db, t)).toBe(1);
    expect(db.get<{ status: string }>(`SELECT status FROM crews WHERE name = 'SleepyCrew'`)!.status).toBe('archived');
    // сегмент занимает новая хартия сразу — тот же район, тот же сегмент
    const fresh = charter(kp(), 'FreshCrew');
    expect(fresh.slots).toEqual({ from: 0, to: CREW.wallSegmentSlots, size: CREW.wallSegmentSlots });
    // имя ушло в карантин: 90 дней вывеску не подберёшь (reason 'taken', как у распавшихся)
    const check = crew.crewCheck(db, kp(), 'SleepyCrew');
    expect(check.available).toBe(false);
    expect(check.reason).toBe('taken');
    // доска и карточка мёртвую команду не показывают
    expect(crew.crewBoard(db).rows.find((r) => r.name === 'SleepyCrew')).toBeUndefined();
    fails(() => crew.crewView(db, 'SleepyCrew'), 'no_crew');
  });

  it('заезд живого участника держит сегмент', () => {
    const captain = kp();
    charter(captain, 'Riders');
    const t = now() + (CREW.segmentExpireDays + 1) * DAY;
    runAt(captain, t - DAY); // заезд за день до проверки — в окне 30 дней
    expect(crew.expireCrewSegments(db, t)).toBe(0);
    expect(db.get<{ status: string }>(`SELECT status FROM crews WHERE name = 'Riders'`)!.status).toBe('live');
  });

  it('заезд ушедшего участника сегмент не держит', () => {
    const captain = kp();
    charter(captain, 'Ghosted');
    const mate = kp();
    crew.joinCrew(db, mate, crew.myCrew(db, captain)!.inviteCode!);
    const t = now() + (CREW.segmentExpireDays + 1) * DAY;
    runAt(mate, t - DAY);
    crew.leaveCrew(db, mate);
    expect(crew.expireCrewSegments(db, t)).toBe(1);
  });

  it('команда без единого заезда выцветает по дате хартии', () => {
    charter(kp(), 'SoloCrew');
    // COALESCE(MAX(submitted_at), created_at): без заездов живёт дата хартии
    expect(crew.expireCrewSegments(db, now() + CREW.segmentExpireDays * DAY + 1)).toBe(1);
  });

  it('экспирация пишет событие капитану и идемпотентна', () => {
    const captain = kp();
    charter(captain, 'Evented');
    const t = now() + (CREW.segmentExpireDays + 1) * DAY;
    crew.expireCrewSegments(db, t);
    expect(crew.expireCrewSegments(db, t)).toBe(0); // второй прогон не находит live-команды
    const ev = db.all<{ feature: string; kind: string }>(`SELECT feature, kind FROM feature_events`);
    expect(ev).toContainEqual({ feature: 'crew', kind: 'expire' });
  });
});
