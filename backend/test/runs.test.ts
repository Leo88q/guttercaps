// Линия (docs/16 §5.1–5.3).
//
// Что здесь держится:
//   1. очки считает сервер, а не клиент — клиент присылает только реплей;
//   2. три заезда в день бесплатны, четвёртый стоит 30 $CG, и это сжигается;
//   3. награды — косметика и существующие предметы, предметы — один раз в день;
//   4. реплей живёт 14 дней, потом остаются очки.
import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { Db, now } from '../src/db.ts';
import { ServiceError } from '../src/services.ts';
import { serviceRefHash, toHex } from '../src/services.ts';
import * as runs from '../src/runs.ts';
import { dayIndex, weekIndex } from '../src/quests.ts';
import { LINE, LINE_TICKS, LINE_UNITS_PER_TICK, LINE_HOP, LINE_GRAB, lineLayout, lineSeed, simulateRun, type RunInput } from '@guttercaps/economy';

const kp = () => Keypair.generate().publicKey.toBase58();
/** Подпись платежа — настоящая base58-строка: разбор не пропустит мусор. */
const sig58 = () => kp();
const U = LINE_UNITS_PER_TICK;
const T0 = 1_700_000_000;
const iso = (s: number) => new Date(s * 1000).toISOString();
const fails = (fn: () => unknown, code: string) => {
  try { fn(); } catch (e) { expect((e as ServiceError).code).toBe(code); return; }
  throw new Error(`ожидалась ошибка ${code}`);
};
const seedSeason = (db: Db, t: number) => db.run(`INSERT INTO seasons (id, starts_at, ends_at, server_secret, server_secret_hash) VALUES (1, ?, ?, 'aa', 'bb')`, t - 86_400, t + 86_400 * 40);

/** Бот «в окно»: прыжок перед препятствием, грэб сразу после толчка. */
function plan(layout: ReturnType<typeof lineLayout>, jitter = 0): RunInput[] {
  const out: RunInput[] = [];
  let busy = -1;
  for (const f of layout.features) {
    if (f.kind === 'kicker') {
      const t = Math.floor(f.start / U) + 1;
      if (t > busy) out.push({ tick: t, action: LINE_GRAB });
      busy = Math.floor(f.start / U) + LINE.kickTicks;
      continue;
    }
    const t = f.kind === 'rail' ? Math.floor((f.start + 20 - 220) / U) : Math.floor(f.start / U) - 1;
    const at = t + jitter;
    if (at < 0 || at <= busy) continue;
    out.push({ tick: at, action: LINE_HOP });
    out.push({ tick: at + 1, action: LINE_GRAB });
    busy = at + LINE.hopTicks;
  }
  return out;
}
const replay = (inputs: RunInput[]) => inputs.map((i) => [i.tick, i.action] as [number, number]);

/** Платёж за доп. заезд: ровно тот разбор, что делает продакшен. */
function payExtra(db: Db, wallet: string, day: number, sig: string, t = T0) {
  const ref = toHex(serviceRefHash(13, wallet, { id: 'lineExtraRun', day }));
  db.run(`INSERT INTO service_payments (signature, event_index, buyer, kind, currency, amount, burned, ref_hash, block_time, slot, consumed_by) VALUES (?, 0, ?, 13, 2, '30000000', '30000000', ?, ?, 1, NULL)`, sig, wallet, ref, t);
  db.run(`INSERT INTO events_raw (signature, ix_index, event_index, program, name, data, slot, finalized_at) VALUES (?, 0, 0, 'services', 'ServicePaid', '{}', 1, ?)`, sig, t);
  return ref;
}

describe('линия: заезд считает сервер', () => {
  it('очки берутся из реплея, а не из слов клиента', () => {
    const db = new Db(':memory:'); seedSeason(db, T0);
    const w = kp();
    const day = dayIndex(T0);
    const layout = lineLayout(day);
    const inputs = plan(layout);
    const r = runs.submitRun(db, w, { day, inputs: replay(inputs), score: 999_999 }, T0);
    expect(r.run.score).toBe(simulateRun(layout, inputs).score);
    expect(r.run.score).toBeLessThan(999_999);
    // строка хранения: реплей, сид и посчитанный результат
    const row = db.get<{ seed: number; inputs: string; score: number; paid: number }>(`SELECT seed, inputs, score, paid FROM line_runs WHERE id = ?`, r.run.id)!;
    expect(row.seed).toBe(lineSeed(day));
    expect(JSON.parse(row.inputs)).toEqual(replay(inputs));
    expect(row.paid).toBe(0);
  });

  it('реплей обязателен к разбору: мусор не проходит', () => {
    const db = new Db(':memory:'); seedSeason(db, T0);
    const w = kp();
    const day = dayIndex(T0);
    fails(() => runs.submitRun(db, w, { day, inputs: 'nope' }, T0), 'bad_replay');
    fails(() => runs.submitRun(db, w, { day, inputs: [[0, 7]] }, T0), 'bad_replay');
    fails(() => runs.submitRun(db, w, { day, inputs: [[LINE_TICKS + 5, 0]] }, T0), 'bad_replay');
    fails(() => runs.submitRun(db, w, { day, inputs: [[-1, 0]] }, T0), 'bad_replay');
    fails(() => runs.submitRun(db, w, { day, inputs: new Array(LINE.maxInputs + 1).fill([0, 0]) }, T0), 'bad_replay');
    fails(() => runs.submitRun(db, w, { day: day + 2, inputs: [] }, T0), 'bad_day');
    expect(db.scalar(`SELECT COUNT(*) FROM line_runs`)).toBe(0);
  });

  it('день один на всех: раскладку клиент строит сам и сверяет сид', () => {
    const db = new Db(':memory:');
    const w = kp();
    const st = runs.lineState(db, w, T0);
    expect(st.day).toBe(dayIndex(T0));
    expect(st.seed).toBe(lineSeed(st.day));
    expect(st.seed).toBe(lineLayout(st.day).seed);
    expect(st.freeLeft).toBe(LINE.freeRunsPerDay);
    expect(st.bestToday).toBe(0);
  });
});

describe('линия: три бесплатных, четвёртый за 30 $CG', () => {
  it('после трёх бесплатных заезд просит деньги, а не четвёртую попытку', () => {
    const db = new Db(':memory:'); seedSeason(db, T0);
    const w = kp();
    const day = dayIndex(T0);
    for (let i = 0; i < LINE.freeRunsPerDay; i++) {
      const r = runs.submitRun(db, w, { day, inputs: [] }, T0 + i);
      expect(r.run.paid).toBe(false);
      expect(r.state.freeLeft).toBe(LINE.freeRunsPerDay - i - 1);
    }
    fails(() => runs.submitRun(db, w, { day, inputs: [] }, T0 + 10), 'runs_exhausted');
    expect(db.scalar(`SELECT COUNT(*) FROM line_runs WHERE wallet = ?`, w)).toBe(3);
  });

  it('30 $CG сжигаются ровно один раз: платёж тратится, второй раз не проходит', () => {
    const db = new Db(':memory:'); seedSeason(db, T0);
    const w = kp();
    const day = dayIndex(T0);
    for (let i = 0; i < LINE.freeRunsPerDay; i++) runs.submitRun(db, w, { day, inputs: [] }, T0 + i);
    const sig = sig58();
    payExtra(db, w, day, sig);
    expect(runs.buyExtraRun(db, w, { day, signature: sig }, T0).credits).toBe(1);
    fails(() => runs.buyExtraRun(db, w, { day, signature: sig }, T0), 'payment_consumed');
    const r = runs.submitRun(db, w, { day, inputs: [] }, T0 + 20);
    expect(r.run.paid).toBe(true);
    expect(db.scalar(`SELECT COUNT(*) FROM line_credits WHERE wallet = ? AND used_by IS NOT NULL`, w)).toBe(1);
  });

  it('другой валютой и другой суммой доп. заезд не купить: это сток, а не выручка', () => {
    const db = new Db(':memory:'); seedSeason(db, T0);
    const w = kp();
    const day = dayIndex(T0);
    const sig = sig58();
    const ref = toHex(serviceRefHash(13, w, { id: 'lineExtraRun', day }));
    db.run(`INSERT INTO service_payments (signature, event_index, buyer, kind, currency, amount, burned, ref_hash, block_time, slot) VALUES (?, 0, ?, 13, 0, '100000', '0', ?, ?, 1)`, sig, w, ref, T0);
    db.run(`INSERT INTO events_raw (signature, ix_index, event_index, program, name, data, slot, finalized_at) VALUES (?, 0, 0, 'services', 'ServicePaid', '{}', 1, ?)`, sig, T0);
    fails(() => runs.buyExtraRun(db, w, { day, signature: sig }, T0), 'cg_burn_required');
    // и платёж за другой день не подойдёт
    const sig2 = sig58();
    payExtra(db, w, day, sig2);
    fails(() => runs.buyExtraRun(db, w, { day: day - 1, signature: sig2 }, T0), 'ref_hash_mismatch');
  });

  it('платных заездов в день не больше потолка', () => {
    const db = new Db(':memory:'); seedSeason(db, T0);
    const w = kp();
    const day = dayIndex(T0);
    while (runs.lineState(db, w, T0).freeLeft > 0) runs.submitRun(db, w, { day, inputs: [] }, T0);
    for (let i = 0; i < LINE.maxPaidRunsPerDay; i++) {
      const sig = sig58();
      payExtra(db, w, day, sig);
      // credits — сколько кредитов на день накоплено, а не «сколько дала эта покупка»
      expect(runs.buyExtraRun(db, w, { day, signature: sig }, T0).credits).toBe(i + 1);
      expect(runs.submitRun(db, w, { day, inputs: [] }, T0 + 100 + i).run.paid).toBe(true);
    }
    // шестой платный — ни купить, ни проехать
    const sig = sig58();
    payExtra(db, w, day, sig);
    fails(() => runs.buyExtraRun(db, w, { day, signature: sig }, T0), 'run_credit_cap');
    // и проехать шестой нельзя: ни бесплатной попытки, ни кредита
    fails(() => runs.submitRun(db, w, { day, inputs: [] }, T0 + 500), 'runs_exhausted');
    expect(db.scalar(`SELECT COUNT(*) FROM line_runs WHERE wallet = ? AND paid = 1`, w)).toBe(LINE.maxPaidRunsPerDay);
  });
});

describe('линия: награды — косметика и предметы, а не деньги', () => {
  it('за заезд даётся XP косметического трека и ничего больше', () => {
    const db = new Db(':memory:'); seedSeason(db, T0);
    const w = kp();
    const day = dayIndex(T0);
    const layout = lineLayout(day);
    const r = runs.submitRun(db, w, { day, inputs: replay(plan(layout)) }, T0);
    expect(r.granted.passXp).toBeGreaterThan(0);
    expect(r.granted.passXp).toBeLessThanOrEqual(LINE.passXpCap);
    expect(db.scalar(`SELECT xp FROM pass_xp WHERE wallet = ? AND season = 1`, w)).toBe(r.granted.passXp);
    // ни одной монеты: $CG за заезды не платят, квоты квестов не двигаются
    expect(db.scalar(`SELECT COUNT(*) FROM quest_completions WHERE wallet = ?`, w)).toBe(0);
  });

  it('предметы — один раз в день, за лучший заезд, и под тот же потолок стока', () => {
    const db = new Db(':memory:'); seedSeason(db, T0);
    const w = kp();
    const day = dayIndex(T0);
    const layout = lineLayout(day);
    const gold = plan(layout);
    const r = runs.submitRun(db, w, { day, inputs: replay(gold) }, T0);
    expect(r.granted.tier).toBe(runs.lineState(db, w, T0).tierToday);
    const hintsAfter = r.granted.hints + r.granted.valve;
    if (hintsAfter > 0) {
      // второй, такой же заезд предметов не удваивает
      const again = runs.submitRun(db, w, { day, inputs: replay(gold) }, T0 + 30);
      expect(again.granted.hints).toBe(0);
      expect(again.granted.valve).toBe(0);
      expect(again.state.rewardsToday.hints).toBe(r.state.rewardsToday.hints);
    }
    // платный заезд покупает попытку, а не вторую горсть подсказок
    while (runs.lineState(db, w, T0).freeLeft > 0) runs.submitRun(db, w, { day, inputs: [] }, T0 + 200);
    const sig = sig58();
    payExtra(db, w, day, sig);
    runs.buyExtraRun(db, w, { day, signature: sig }, T0);
    const paid = runs.submitRun(db, w, { day, inputs: replay(gold) }, T0 + 300);
    expect(paid.run.paid).toBe(true);
    expect(paid.granted.hints).toBe(0);
    expect(paid.granted.valve).toBe(0);
  });

  it('большой результат поднимает награду, меньший — нет', () => {
    const db = new Db(':memory:'); seedSeason(db, T0);
    const w = kp();
    const day = dayIndex(T0);
    const layout = lineLayout(day);
    const best = plan(layout);
    const r1 = runs.submitRun(db, w, { day, inputs: replay(best) }, T0);
    const before = r1.state.rewardsToday.hints + r1.state.rewardsToday.valve;
    const r2 = runs.submitRun(db, w, { day, inputs: [] }, T0 + 60); // пустой заезд
    expect(r2.run.score).toBeLessThanOrEqual(r1.run.score);
    expect(r2.state.bestToday).toBe(r1.run.score);
    expect(r2.state.rewardsToday.hints + r2.state.rewardsToday.valve).toBe(before);
  });
});

describe('линия: реплей живёт 14 дней', () => {
  it('ввод стирается, очки остаются', () => {
    const db = new Db(':memory:'); seedSeason(db, T0);
    const w = kp();
    const day = dayIndex(T0);
    const r = runs.submitRun(db, w, { day, inputs: replay(plan(lineLayout(day))) }, T0);
    expect(db.scalar(`SELECT LENGTH(inputs) FROM line_runs WHERE id = ?`, r.run.id)).toBeGreaterThan(2);
    expect(runs.pruneLineReplays(db, T0 + 100)).toBe(0);
    expect(runs.pruneLineReplays(db, T0 + runs.REPLAY_TTL_S + 1)).toBe(1);
    const row = db.get<{ inputs: string; score: number }>(`SELECT inputs, score FROM line_runs WHERE id = ?`, r.run.id)!;
    expect(row.inputs).toBe('[]');
    expect(row.score).toBe(r.run.score);
    // свой заезд можно пересмотреть, чужой — нет
    expect(runs.runReplay(db, w, r.run.id)?.score).toBe(r.run.score);
    expect(runs.runReplay(db, kp(), r.run.id)).toBeNull();
  });
});

describe('линия: доска недели', () => {
  it('в доске — лучший заезд кошелька за неделю', () => {
    const db = new Db(':memory:'); seedSeason(db, T0);
    const a = kp(); const b = kp();
    const day = dayIndex(T0);
    const layout = lineLayout(day);
    const ra = runs.submitRun(db, a, { day, inputs: replay(plan(layout)) }, T0);
    runs.submitRun(db, a, { day, inputs: [] }, T0 + 60);                       // слабый второй заезд
    const rb = runs.submitRun(db, b, { day, inputs: replay(plan(layout, 3)) }, T0 + 90);
    const board = runs.lineLeaderboard(db, weekIndex(T0), 50);
    expect(board.rows.length).toBe(2);
    expect(board.rows[0].score).toBe(Math.max(ra.run.score, rb.run.score));
    expect(board.rows[0].rank).toBe(1);
    expect(board.rows.map((r) => r.wallet).sort()).toEqual([a, b].sort());
    expect(db.scalar(`SELECT COUNT(*) FROM line_runs`)).toBe(3);
  });

  it('событие пишется самой выдачей — когорта не может разойтись с доской', () => {
    const db = new Db(':memory:'); seedSeason(db, T0);
    const w = kp();
    runs.submitRun(db, w, { day: dayIndex(T0), inputs: [] }, T0);
    const ev = db.all<{ feature: string; kind: string; meta: string }>(`SELECT feature, kind, meta FROM feature_events WHERE wallet = ? ORDER BY id`, w);
    expect(ev.map((e) => `${e.feature}.${e.kind}`)).toEqual(['line.run']);
    const meta = JSON.parse(ev[0]!.meta ?? '{}') as { paid: boolean; tier: string };
    expect(meta.paid).toBe(false);
    expect(typeof meta.tier).toBe('string');
  });
});
