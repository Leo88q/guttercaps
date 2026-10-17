// Дневной турнир линии (docs/16 §5.4).
//
// Что здесь держится:
//   1. вход — платёж 30 $CG, привязанный к дню (с roll-forward
//      через UTC-полночь: платёж за вчера продаёт вход сегодня);
//   2. один вход — один турнирный заезд, заезд тратит кредит,
//      бесплатные заезды не ранжируются;
//   3. общий потолок paid-попыток (линия + турнир);
//   4. сет: ранжирование по лучшему заезду, полосы по полю,
//      приз закрывает дыру района, идемпотентность по PK дня.
import { beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { Db, now } from '../src/db.ts';
import { ServiceError, serviceRefHash, toHex } from '../src/services.ts';
import * as tournament from '../src/tournament.ts';
import * as runs from '../src/runs.ts';
import { dayIndex, weekIndex } from '../src/quests.ts';
import { LINE, SERVICE_BY_ID, TOURNAMENT, BOARD_SET_SLOTS, boardDistrictOfWeek, tournamentBandOfRank, type BoardSlot } from '@guttercaps/economy';
import { grantPart } from '../src/board.ts';

/** Заезд начисляет XP трека — сезон должен жить (как в runs.test.ts). */
const seedSeason = (t: number) =>
  db.run(`INSERT INTO seasons (id, starts_at, ends_at, server_secret, server_secret_hash) VALUES (1, ?, ?, 'aa', 'bb')`, t - DAY, t + DAY * 40);

const kp = () => Keypair.generate().publicKey.toBase58();
const sig58 = () => kp();
const DAY = 86_400;
const T0 = 1_700_000_000;
const fails = (fn: () => unknown, code: string) => {
  try { fn(); } catch (e) { expect((e as ServiceError).code).toBe(code); return; }
  throw new Error(`ожидалась ошибка ${code}`);
};

let db: Db;
beforeEach(() => { db = new Db(':memory:'); seedSeason(T0); });

/** Платёж за вход: ровно тот разбор, что делает продакшен (ServicePaid + финализация). */
function payEntry(wallet: string, day: number, sig: string, t = T0, amount: number = TOURNAMENT.entryCgMicro) {
  const ref = toHex(serviceRefHash(SERVICE_BY_ID.lineTournamentEntry.kind, wallet, { id: 'lineTournamentEntry', day }));
  db.run(
    `INSERT INTO service_payments (signature, event_index, buyer, kind, currency, amount, burned, ref_hash, slot, block_time)
     VALUES (?, 0, ?, ?, 2, ?, ?, ?, 1, ?)`, sig, wallet, SERVICE_BY_ID.lineTournamentEntry.kind, String(amount), amount, ref, t);
  db.run(
    `INSERT INTO events_raw (signature, ix_index, event_index, program, name, data, slot, finalized_at)
     VALUES (?, 0, 0, 'services', 'ServicePaid', '{}', 1, ?)`, sig, t);
  return ref;
}

const enter = (wallet: string, day: number, sig: string, t = T0) =>
  tournament.enterTournament(db, wallet, { day, signature: sig }, t);

const run = (wallet: string, day: number, score: number, t = T0) =>
  db.run(`INSERT INTO line_runs (wallet, day, week, seed, inputs, score, tricks, best_combo, bails, paid, submitted_at, replay_ttl)
          VALUES (?, ?, 1, 1, '[]', ?, 1, 1, 0, 1, ?, ?)`, wallet, day, score, t, t + DAY);

const tourneyRun = (wallet: string, day: number, score: number, t = T0) => {
  const info = run(wallet, day, score, t);
  db.run(`INSERT INTO line_tournament_runs (run_id, wallet, day, score, submitted_at) VALUES (?, ?, ?, ?, ?)`,
    Number(info.lastInsertRowid), wallet, day, score, t);
};

/** Первый слот района, которого у кошелька ещё нет (порядок BOARD_SET_SLOTS). */
function firstMissing(db: Db, wallet: string, district: number): BoardSlot {
  const owned = new Set(
    (db.all<{ part: string }>(`SELECT part FROM board_parts WHERE wallet = ? AND qty > 0`, wallet)).map((r) => r.part));
  for (const slot of BOARD_SET_SLOTS) {
    if (!owned.has(`${slot}_d${district}`)) return slot;
  }
  throw new Error('сет района уже собран');
}

describe('турнир: вход', () => {
  it('платёж 30 $CG покупает один вход сегодня', () => {
    const w = kp();
    const day = dayIndex(T0);
    const sig = sig58();
    payEntry(w, day, sig);
    const r = enter(w, day, sig);
    expect(r.day).toBe(day);
    expect(r.entries).toBe(1);
    // тот же платёж дважды входа не покупает
    fails(() => enter(w, day, sig), 'payment_consumed');
  });

  it('платёж другой суммы не входит', () => {
    const w = kp();
    const s = sig58();
    payEntry(w, dayIndex(T0), s, T0, 29_000_000);
    fails(() => enter(w, dayIndex(T0), s), 'cg_burn_required');
  });

  it('roll-forward: платёж, подписанный на вчера, продаёт вход сегодня', () => {
    const w = kp();
    const yesterday = dayIndex(T0) - 1;
    const sig = sig58();
    payEntry(w, yesterday, sig);
    const r = enter(w, dayIndex(T0), sig, T0);
    expect(r.day).toBe(dayIndex(T0));
    // и фиксируется событием — это не silent-исключение
    expect(db.scalar(`SELECT COUNT(*) FROM feature_events WHERE wallet = ? AND feature = 'tournament' AND kind = 'enter_rollover'`, w)).toBe(1);
  });

  it('платёж за день старше вчера — чужой', () => {
    const w = kp();
    const sig = sig58();
    payEntry(w, dayIndex(T0) - 2, sig);
    fails(() => enter(w, dayIndex(T0), sig), 'ref_hash_mismatch');
  });

  it('общий потолок paid-попыток держит и входы', () => {
    const w = kp();
    const day = dayIndex(T0);
    for (let i = 0; i < LINE.maxPaidRunsPerDay; i++) run(w, day, 100 + i);
    const sig = sig58();
    payEntry(w, day, sig);
    fails(() => enter(w, day, sig), 'run_credit_cap');
  });

  it('день — только сегодня (±1 для roll-forward)', () => {
    fails(() => enter(kp(), dayIndex(T0) + 2, sig58()), 'bad_day');
  });
});

describe('турнир: заезд', () => {
  const day = dayIndex(T0);
  const inputs: [number, number][] = [[0, 0], [1, 1], [2, 0]];

  it('турнирный заезд тратит вход и ранжирует; второй без входа — 402', () => {
    const w = kp();
    const sig = sig58();
    payEntry(w, day, sig);
    enter(w, day, sig);
    const r = runs.submitRun(db, w, { day, inputs, tournament: true }, T0);
    expect(r.run.paid).toBe(true);
    const state = tournament.tournamentState(db, w, T0);
    expect(state.entries.unused).toBe(0);
    expect(state.best?.score).toBe(r.run.score);
    expect(state.rank).toBe(1);
    expect(tournament.tournamentBoard(db, day).rows).toHaveLength(1);
    fails(() => runs.submitRun(db, w, { day, inputs, tournament: true }, T0), 'tournament_entries_exhausted');
  });

  it('бесплатный заезд не тратит вход и не ранжируется', () => {
    const w = kp();
    const sig = sig58();
    payEntry(w, day, sig);
    enter(w, day, sig);
    runs.submitRun(db, w, { day, inputs, tournament: false }, T0);
    const state = tournament.tournamentState(db, w, T0);
    expect(state.entries.unused).toBe(1);
    expect(state.best).toBeNull();
    expect(tournament.tournamentBoard(db, day).rows).toHaveLength(0);
  });

  it('лучший из двух турнирных заездов — в доске', () => {
    const w = kp();
    for (const s of [sig58(), sig58()]) { payEntry(w, day, s); enter(w, day, s); }
    runs.submitRun(db, w, { day, inputs, tournament: true }, T0);
    const second = runs.submitRun(db, w, { day, inputs, tournament: true }, T0 + 60);
    const state = tournament.tournamentState(db, w, T0 + 60);
    expect(state.entries.unused).toBe(0);
    expect(state.best?.score).toBe(second.run.score);
  });
});

describe('турнир: сет дня', () => {
  const day = dayIndex(T0);

  it('ранжирует по лучшему заезду, приз — дыру района недели', () => {
    const wallets = Array.from({ length: 10 }, () => kp());
    // 10 участников: полосы — 1 / 2 / 7 (band 0, 3, 4 при поле 10)
    wallets.forEach((w, i) => tourneyRun(w, day, 1000 - i, T0));
    expect(tournamentBandOfRank(1, 10)).toBe(0);
    const district = boardDistrictOfWeek(weekIndex(day * DAY));
    const r = tournament.settleLineTournament(db, day, T0 + DAY);
    expect(r.alreadySettled).toBe(false);
    expect(r.entrants).toBe(10);
    // победитель (band 0) получает оба трофея
    expect(r.prizes.filter((p) => p.rank === 1).map((p) => p.part).sort())
      .toEqual(['deck_trophy', 'grip_trophy']);
    // остальные призовые полосы — первый недостающий слот района
    // недели (все кошельки стартуют с пустой доски)
    for (const p of r.prizes.filter((x) => x.rank !== 1)) {
      expect(p.part).toBe(`deck_d${district}`);
    }
    // проекция и очередь ончейн-выдачи
    for (const p of r.prizes) {
      expect(db.scalar(`SELECT qty FROM board_parts WHERE wallet = ? AND part = ?`, p.wallet, p.part)).toBe(1);
      expect(db.scalar(`SELECT COUNT(*) FROM board_part_leaves WHERE wallet = ?`, p.wallet)).toBeGreaterThan(0);
    }
  });

  it('приз закрывает дыру, а не плодит собранное', () => {
    const district = boardDistrictOfWeek(weekIndex(day * DAY));
    const owner = kp(), first = kp(), last = kp();
    // владелец деки района финишит вторым: при поле 3 —
    // band 4 (top 50% = ceil(1.5) = 2 места), и приз
    // закрывает СЛЕДУЮЩУЮ дыру, а не плодит вторую деку
    grantPart(db, owner, `deck_d${district}`, 'run', T0);
    tourneyRun(first, day, 5000, T0);
    tourneyRun(owner, day, 4000, T0);
    tourneyRun(last, day, 3000, T0);
    const r = tournament.settleLineTournament(db, day, T0 + DAY);
    const mine = r.prizes.filter((p) => p.wallet === owner);
    expect(mine.map((p) => p.part)).toEqual([`trucks_d${district}`]);
  });

  it('идемпотентен: повторный сет не дублирует призы', () => {
    const wallets = Array.from({ length: 3 }, () => kp());
    wallets.forEach((w, i) => tourneyRun(w, day, 3000 - i, T0));
    const r1 = tournament.settleLineTournament(db, day, T0 + DAY);
    expect(r1.prizes.length).toBeGreaterThan(0);
    const parts1 = db.all(`SELECT wallet, part FROM line_tournament_prizes WHERE day = ?`, day);
    const r2 = tournament.settleLineTournament(db, day, T0 + 2 * DAY);
    expect(r2.alreadySettled).toBe(true);
    expect(r2.prizes).toEqual(r1.prizes);
    expect(db.all(`SELECT wallet, part FROM line_tournament_prizes WHERE day = ?`, day)).toEqual(parts1);
    expect(db.scalar(`SELECT COUNT(*) FROM board_parts`)).toBe(r1.prizes.length);
  });

  it('день без участников не создаёт строку сета', () => {
    const r = tournament.settleLineTournament(db, day, T0);
    expect(r.entrants).toBe(0);
    expect(r.prizes).toEqual([]);
    expect(db.scalar(`SELECT COUNT(*) FROM line_tournament_days`)).toBe(0);
  });
});
