// =============================================================================
// Линия — заезды (docs/16 §5.1–5.3)
// -----------------------------------------------------------------------------
// Три обещания, которые здесь держат:
//
//  1. **Очки считает сервер.** Клиент присылает только реплей — список вводов.
//     Очки, которые прислал клиент, не читаются вообще: пересчёт идёт той же
//     функцией из `packages/economy`, которой клиент играл живьём (§5.2).
//  2. **Награды — косметика и существующие предметы.** pass XP (косметический
//     трек) даётся за каждый заезд; подсказки и клапаны Флудгрида — один раз
//     в день за лучший заезд и под те же потолки стока, что у квестов. Ни одной
//     новой монеты $CG, квоты 25/140 не двигаются.
//  3. **Реплей живёт 14 дней.** Потом остаются очки и хеш, а не видео: хранить
//     чужой ввод вечно не зачем ни игроку, ни нам (§5.2).
//
// Платный заезд — не «ещё одна попытка за деньги»: 30 $CG сжигаются, и это та
// же точка цены, что у дополнительного погружения Глубокого паводка.
// =============================================================================

import type { Db } from './db.ts';
import { now } from './db.ts';
import {
  LINE, LINE_TICKS, SERVICE_BY_ID,
  lineLayout, lineSeed, lineTier, runPassXp, simulateRun,
  type LineTier, type RunInput, type RunResult,
} from '@guttercaps/economy';
import { ServiceError, consume, findPayment, serviceRefHash, toHex } from './services.ts';
import { grantGridHints, grantGridValve } from './grid.ts';
import { addPassXp, passSeasonId } from './pass.ts';
import { dayIndex, weekIndex } from './quests.ts';
import { recordEvent } from './worldMetrics.ts';
import { grantWeeklyRunPart } from './board.ts';

const DAY = 86_400;
/** Сколько живёт реплей (docs/16 §5.2): 14 дней, потом только очки и хеш. */
export const REPLAY_TTL_S = 14 * DAY;
/** Заезд, начатый перед полуночью, можно прислать после: день считаем по началу. */
const DAY_GRACE = 1;

const iso = (s: number) => new Date(s * 1000).toISOString();

// --------------------------------------------------------------- разбор реплея

/**
 * Реплей — это весь ввод, поэтому его разбор важнее, чем разбор «очков»:
 * что попало в базу, то и будет переиграно. Здесь отсекается и мусор, и
 * попытка прислать вместо реплея мешок нажатий.
 */
export function parseReplay(raw: unknown): RunInput[] {
  if (!Array.isArray(raw)) throw new ServiceError(400, 'bad_replay', 'inputs must be an array of [tick, action]');
  if (raw.length > LINE.maxInputs) throw new ServiceError(400, 'bad_replay', `At most ${LINE.maxInputs} inputs per run`);
  const out: RunInput[] = [];
  for (const item of raw) {
    const pair = Array.isArray(item) ? item : [item?.tick, item?.action];
    const tick = Number(pair[0]);
    const action = Number(pair[1]);
    if (!Number.isInteger(tick) || tick < 0 || tick >= LINE_TICKS) {
      throw new ServiceError(400, 'bad_replay', `tick must be an integer in [0, ${LINE_TICKS})`);
    }
    if (action !== 0 && action !== 1) throw new ServiceError(400, 'bad_replay', 'action must be 0 (hop) or 1 (grab)');
    out.push({ tick, action: action === 1 ? 1 : 0 });
  }
  return out;
}

// ------------------------------------------------------------------- состояние

export interface LineState {
  day: number;
  week: number;
  /** Сид раскладки: клиент считает её сам, но сверяет сид — иначе он играет не ту чашу. */
  seed: number;
  ticks: number;
  length: number;
  freeRunsPerDay: number;
  freeLeft: number;
  paidLeft: number;
  runsToday: number;
  bestToday: number;
  tierToday: LineTier;
  rewardsToday: { passXp: number; hints: number; valve: number };
  bestWeek: number;
  extraRunCgMicro: number;
}

export function lineState(db: Db, wallet: string, t = now()): LineState {
  const day = dayIndex(t);
  const week = weekIndex(t);
  const row = db.get<{ n: number; paid: number; best: number }>(
    `SELECT COUNT(*) n, COALESCE(SUM(paid), 0) paid, COALESCE(MAX(score), 0) best FROM line_runs WHERE wallet = ? AND day = ?`, wallet, day);
  const freeUsed = (row?.n ?? 0) - (row?.paid ?? 0);
  const paidUsed = row?.paid ?? 0;
  const bestToday = row?.best ?? 0;
  const rew = db.get<{ tier: LineTier; hints: number; valve: number }>(
    `SELECT tier, hints, valve FROM line_rewards WHERE wallet = ? AND day = ?`, wallet, day);
  // XP косметического трека за день — своей строкой: трек считает pass.ts, а здесь
  // лежит только «сколько линия дала сегодня», чтобы экран мог это показать.
  const passXpToday = db.scalar(
    `SELECT COALESCE(SUM(xp), 0) FROM line_pass_xp WHERE wallet = ? AND day = ?`, wallet, day);
  const bestWeek = db.scalar(`SELECT COALESCE(MAX(score), 0) FROM line_runs WHERE wallet = ? AND week = ?`, wallet, week);
  return {
    day, week, seed: lineSeed(day), ticks: LINE_TICKS, length: LINE.trackLength,
    freeRunsPerDay: LINE.freeRunsPerDay,
    freeLeft: Math.max(0, LINE.freeRunsPerDay - freeUsed),
    paidLeft: Math.max(0, LINE.maxPaidRunsPerDay - paidUsed),
    runsToday: row?.n ?? 0,
    bestToday,
    tierToday: lineTier(bestToday),
    rewardsToday: { passXp: passXpToday, hints: rew?.hints ?? 0, valve: rew?.valve ?? 0 },
    bestWeek,
    extraRunCgMicro: LINE.extraRunCgMicro,
  };
}

// --------------------------------------------------------------------- заезд

export interface RunRow {
  id: number;
  day: number;
  week: number;
  score: number;
  tricks: number;
  bestCombo: number;
  bails: number;
  paid: boolean;
  tier: LineTier;
  submittedAt: string;
}

export interface SubmitResult {
  run: RunRow;
  /** Что дал именно этот заезд, а не «что у игрока есть». */
  /** Что дал именно этот заезд, а не «что у игрока есть». `part` — районная
   *  часть доски (§4.2), null когда неделя уже закрыта или порог не взят. */
  granted: { passXp: number; hints: number; valve: number; tier: LineTier; part: string | null };
  state: LineState;
}

/**
 * Принять реплей, пересчитать очки, выдать награду.
 *
 * Порядок важен и он такой же, как у выдачи достижений: сначала тратим
 * попытку, потом считаем, потом пишем результат — в одной транзакции. Иначе
 * две подряд присланные попытки обе увидят «есть ещё бесплатная».
 */
export function submitRun(db: Db, wallet: string, body: Record<string, unknown> | undefined, t = now()): SubmitResult {
  const day = Number(body?.day);
  const today = dayIndex(t);
  if (!Number.isInteger(day) || day > today || day < today - DAY_GRACE) {
    throw new ServiceError(400, 'bad_day', `day must be today (${today}) or yesterday`);
  }
  const inputs = parseReplay(body?.inputs);
  // Турнирный заезд (§5.4): тот же реплей и тот же счёт, но попытка
  // оплачена входом в турнир (кредит `line_tournament_entries`),
  // а не кредитом доп. заезда, и заезд дополнительно попадает в ранжирование дня.
  const tournament = body?.tournament === true;
  // Клиент играет раскладкой дня локально; сервер её не спрашивает — он её знает.
  const layout = lineLayout(day);

  return db.tx(() => {
    const used = db.get<{ n: number; paid: number }>(
      `SELECT COUNT(*) n, COALESCE(SUM(paid), 0) paid FROM line_runs WHERE wallet = ? AND day = ?`, wallet, day);
    const freeUsed = (used?.n ?? 0) - (used?.paid ?? 0);
    const paidUsed = used?.paid ?? 0;
    let paid = false;
    let creditId: number | null = null;
    let tournamentEntryId: number | null = null;
    if (tournament) {
      // Турнирная попытка не берёт ни бесплатную, ни кредит доп.
      // заезда: она оплачена входом. Потолок общий — paid-заезды
      // (любого вида) уже видны в `paidUsed`.
      const entry = db.get<{ id: number }>(
        `SELECT id FROM line_tournament_entries WHERE wallet = ? AND day = ? AND used_by IS NULL ORDER BY id LIMIT 1`, wallet, day);
      if (!entry) throw new ServiceError(402, 'tournament_entries_exhausted', 'No unused tournament entry for today — enter the tournament first');
      if (paidUsed >= LINE.maxPaidRunsPerDay) throw new ServiceError(409, 'run_credit_cap', `At most ${LINE.maxPaidRunsPerDay} paid runs per day`);
      tournamentEntryId = entry.id;
      paid = true;
    } else if (freeUsed < LINE.freeRunsPerDay) {
      paid = false;
    } else {
      const credit = db.get<{ id: number }>(
        `SELECT id FROM line_credits WHERE wallet = ? AND day = ? AND used_by IS NULL ORDER BY id LIMIT 1`, wallet, day);
      if (!credit) throw new ServiceError(402, 'runs_exhausted', 'Free runs are over for today — buy an extra one (30 $CG, burned)');
      if (paidUsed >= LINE.maxPaidRunsPerDay) throw new ServiceError(409, 'run_credit_cap', `At most ${LINE.maxPaidRunsPerDay} paid runs per day`);
      creditId = credit.id;
      paid = true;
    }

    const res: RunResult = simulateRun(layout, inputs);
    const info = db.run(
      `INSERT INTO line_runs (wallet, day, week, seed, inputs, score, tricks, best_combo, bails, paid, submitted_at, replay_ttl)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      wallet, day, weekIndex(t), layout.seed, JSON.stringify(inputs.map((i) => [i.tick, i.action])),
      res.score, res.tricks, res.bestCombo, res.bails, paid ? 1 : 0, t, t + REPLAY_TTL_S,
    );
    const id = Number(info.lastInsertRowid);
    if (creditId !== null) db.run(`UPDATE line_credits SET used_by = ? WHERE id = ? AND used_by IS NULL`, id, creditId);
    if (tournamentEntryId !== null) {
      db.run(`UPDATE line_tournament_entries SET used_by = ? WHERE id = ? AND used_by IS NULL`, id, tournamentEntryId);
      db.run(
        `INSERT INTO line_tournament_runs (run_id, wallet, day, score, submitted_at) VALUES (?, ?, ?, ?, ?)`,
        id, wallet, day, res.score, t);
    }

    // Награда 1: косметический трек. За каждый заезд, потолок на заезд стоит в economy.
    const xp = runPassXp(res.score);
    if (xp > 0) {
      addPassXp(db, passSeasonId(db, t), wallet, xp);
      db.run(`INSERT INTO line_pass_xp (wallet, day, xp, run_id) VALUES (?, ?, ?, ?)`, wallet, day, xp, id);
    }

    // Награда 2: предметы — один раз в день, за лучший заезд. Платные заезды
    // покупают попытку, а не вторую горсть подсказок.
    const tier = lineTier(res.score);
    let hints = 0;
    let valve = 0;
    const prev = db.get<{ tier: LineTier; score: number }>(`SELECT tier, score FROM line_rewards WHERE wallet = ? AND day = ?`, wallet, day);
    const better = !prev || res.score > prev.score;
    if (better && tier !== 'none') {
      const order = { none: 0, bronze: 1, silver: 2, gold: 3 } as const;
      if (!prev || order[tier] > order[prev.tier]) {
        const reward = tier === 'gold' ? { hints: 1, valve: 1 } : tier === 'silver' ? { hints: 1, valve: 0 } : { hints: 0, valve: 0 };
        if (reward.hints > 0) hints = grantGridHints(db, wallet, reward.hints, t);
        if (reward.valve > 0) valve = grantGridValve(db, wallet, t);
        db.run(`INSERT INTO line_rewards (wallet, day, tier, score, hints, valve, granted_at) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(wallet, day) DO UPDATE SET tier = excluded.tier, score = excluded.score,
                  hints = line_rewards.hints + excluded.hints, valve = line_rewards.valve + excluded.valve, granted_at = excluded.granted_at`,
          wallet, day, tier, res.score, hints, valve, t);
      }
    }

    // Награда 3: часть доски (§4.2). Один раз в неделю и только за «проехал
    // линию» — ниже silver доска не собирается: «выехал и упал» не то же, что
    // «проехал». Выдаётся недостающий слот района недели, а не всегда дека,
    // поэтому повтор недели не складывает в инвентарь четыре деки подряд.
    const part = tier === 'none' ? null : grantWeeklyRunPart(db, wallet, tier, t);

    recordEvent(db, wallet, 'line', 'run', { score: res.score, paid, tier, bails: res.bails }, t);
    if (tournament) recordEvent(db, wallet, 'tournament', 'run', { score: res.score, tier }, t);

    return {
      run: {
        id, day, week: weekIndex(t), score: res.score, tricks: res.tricks, bestCombo: res.bestCombo,
        bails: res.bails, paid, tier, submittedAt: iso(t),
      },
      granted: { passXp: xp, hints, valve, tier, part: part?.part ?? null },
      state: lineState(db, wallet, t),
    };
  });
}

// ------------------------------------------------------------ платный заезд

/**
 * Один дополнительный заезд за 30 $CG. Разбор ровно тот, что у Глубокого
 * паводка: ищем платёж по подписи, требуем $CG и ровно ту сумму, тратим
 * платёж один раз. Другой валютой доп. заезд не покупается: сток — это $CG.
 */
export function buyExtraRun(db: Db, wallet: string, body: Record<string, unknown> | undefined, t = now()): { day: number; credits: number } {
  const day = Number(body?.day);
  const today = dayIndex(t);
  if (!Number.isInteger(day) || day > today || day < today - DAY_GRACE) {
    throw new ServiceError(400, 'bad_day', `day must be today (${today}) or yesterday`);
  }
  const signature = String(body?.signature ?? '').trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,128}$/.test(signature)) throw new ServiceError(400, 'bad_signature', 'signature must be a transaction id');
  const kind = SERVICE_BY_ID.lineExtraRun.kind;
  const payload = { id: 'lineExtraRun', day };
  const expected = toHex(serviceRefHash(kind, wallet, payload));
  return db.tx(() => {
    const p = findPayment(db, signature, wallet, [kind], expected);
    if (p.ref_hash !== expected) throw new ServiceError(402, 'ref_hash_mismatch', 'Payment was committed for a different day');
    if (p.currency !== 2 || BigInt(p.amount) !== BigInt(LINE.extraRunCgMicro)) {
      throw new ServiceError(402, 'cg_burn_required', 'Extra runs are bought with exactly 30 $CG (burned)');
    }
    // Считаем и проехатые, и ещё не потраченные: потраченный кредит уже виден в
    // `paid`, поэтому складываем платные заезды с неиспользованными кредитами.
    const paid = db.scalar(`SELECT COALESCE(SUM(paid), 0) FROM line_runs WHERE wallet = ? AND day = ?`, wallet, day);
    const credits = db.scalar(`SELECT COUNT(*) FROM line_credits WHERE wallet = ? AND day = ?`, wallet, day);
    const unused = db.scalar(`SELECT COUNT(*) FROM line_credits WHERE wallet = ? AND day = ? AND used_by IS NULL`, wallet, day);
    if (paid + unused >= LINE.maxPaidRunsPerDay) throw new ServiceError(409, 'run_credit_cap', `At most ${LINE.maxPaidRunsPerDay} paid runs per day`);
    db.run(`INSERT INTO line_credits (wallet, day, signature, granted_at) VALUES (?, ?, ?, ?)`, wallet, day, p.signature, t);
    consume(db, p, `line:${day}`);
    return { day, credits: credits + 1 };
  });
}

// ------------------------------------------------------------------- реплеи

/** Реплей живёт 14 дней (§5.2): стираем ввод, очки и строка остаются. */
export function pruneLineReplays(db: Db, t = now()): number {
  const r = db.run(`UPDATE line_runs SET inputs = '[]' WHERE replay_ttl <= ? AND inputs <> '[]'`, t);
  return Number(r.changes);
}

/** Реплей для просмотра (§5.5): только свой или с доски недели — чужую езду не отдаём. */
/**
 * Реплей заезда для просмотра (docs/16 §5.5).
 *
 * Публичный намеренно: строка заезда и так лежит на доске недели с кошельком и
 * очками, а в реплее нет ничего, кроме нажатий — секретов там не бывает по
 * построению. «Просмотр, не скачивание» означает, что интерфейс показывает
 * заезд, а не отдаёт файл: ввод живёт 14 дней и стирается подметальщиком.
 */
export function runReplay(db: Db, id: number): RunReplay | null {
  const r = db.get<{ id: number; day: number; seed: number; score: number; tricks: number; bails: number; wallet: string; handle: string | null; at: number; inputs: string }>(
    `SELECT r.id, r.day, r.seed, r.score, r.tricks, r.bails, r.wallet, w.handle, r.submitted_at at, r.inputs
       FROM line_runs r LEFT JOIN wallets w ON w.address = r.wallet
      WHERE r.id = ?`, id);
  if (!r) return null;
  return {
    runId: r.id, day: r.day, seed: r.seed, score: r.score, tricks: r.tricks, bails: r.bails,
    wallet: r.wallet, handle: r.handle, at: iso(r.at), inputs: JSON.parse(r.inputs),
  };
}

export interface RunReplay {
  runId: number;
  day: number;
  seed: number;
  score: number;
  tricks: number;
  bails: number;
  wallet: string;
  handle: string | null;
  at: string;
  /** `[тик, действие]` — ровно то, что прислал клиент; [] когда ввод уже стёрт. */
  inputs: [number, number][];
}

export const currentWeek = (t = now()): number => weekIndex(t);

// --------------------------------------------------------------------- доска

export interface LeaderRow {
  rank: number;
  wallet: string;
  handle: string | null;
  score: number;
  tricks: number;
  bails: number;
  runId: number;
  at: string;
  /** Есть ли что смотреть: ввод живёт 14 дней, и доска не должна давать мёртвую ссылку. */
  hasReplay: boolean;
}

export function lineLeaderboard(db: Db, week: number, limit = 50): { week: number; rows: LeaderRow[] } {
  const rows = db.all<{ wallet: string; handle: string | null; score: number; tricks: number; bails: number; id: number; at: number; inputs: string }>(
    `SELECT r.wallet, w.handle, r.score, r.tricks, r.bails, r.id, r.submitted_at at, r.inputs inputs
       FROM line_runs r
       LEFT JOIN wallets w ON w.address = r.wallet
      WHERE r.week = ? AND r.id = (SELECT id FROM line_runs b WHERE b.week = r.week AND b.wallet = r.wallet ORDER BY b.score DESC, b.id ASC LIMIT 1)
      ORDER BY r.score DESC, r.id ASC
      LIMIT ?`, week, limit);
  return {
    week,
    rows: rows.map((r, i) => ({
      rank: i + 1, wallet: r.wallet, handle: r.handle, score: r.score, tricks: r.tricks, bails: r.bails,
      runId: r.id, at: iso(r.at),
      // Строгое сравнение со стёртым вводом: подметальщик пишет ровно '[]'.
      hasReplay: r.inputs !== '[]',
    })),
  };
}
