// =============================================================================
// GUTTERCAPS — телеметрия скейт-мира (docs/16 §12)
// -----------------------------------------------------------------------------
// Зачем этот модуль существует. Правило-гейт §0.2 звучит просто: у каждой фичи
// есть стрелка в основную петлю и метрика, которой это проверяется; нет метрики
// — фича не взята в спринт. Стена и экспозиция уже работают, но доказать, что
// они кормят петлю, было нечем: когорта «владельцы выставленной крышки»
// существовала только в документе.
//
// Здесь ровно одна таблица событий и один отчёт. Никаких таблиц под каждую
// метрику и никакого «посчитаем потом»: событие пишется там же, где происходит
// действие, а когорта считается запросом поверх уже существующих данных
// (паки, сделки, фьюжн, входы, стейкинг) — тех самых контуров, которые мир и
// должен кормить.
//
// Честность сравнения: когорта и базовая линия разного размера, поэтому в отчёт
// идут **средние на кошелёк**, а дельта — это отношение средних, а не сумм.
// Сумма сказала бы «в когорте больше сделок», потому что когорта больше.
// =============================================================================

import type { Db } from './db.ts';
import { now } from './db.ts';

const DAY = 86_400;
const iso = (s: number) => new Date(s * 1000).toISOString();

/** Признаки, о которых мы умеем считать когорты (ровно то, что перечислено в §12). */
export const WORLD_FEATURES = ['wall', 'exhibit', 'tag'] as const;

/** Порог флипа (docs/16 §2.1) — редкость, начиная с которой дроп считается «редким». */
export const EPIC_PLUS = 5;
export type WorldFeature = (typeof WORLD_FEATURES)[number];

/**
 * Одно событие мира. Пишется внутри того же запроса, что и само действие:
 * выставить крышку и записать событие — одна транзакция (см. `setRig`).
 * `at` в секундах (как `now()` и `block_time`); параметр нужен тестам и
 * догону, сам код времени не передаёт.
 */
export function recordEvent(db: Db, wallet: string, feature: WorldFeature, kind: string, meta?: Record<string, unknown>, at = now()): void {
  db.run(`INSERT INTO feature_events (wallet, feature, kind, at, meta) VALUES (?, ?, ?, ?, ?)`, wallet, feature, kind, at, meta ? JSON.stringify(meta) : null);
}

export interface Repeat24h {
  cohort: { opens: number; repeatRate: number | null };
  baseline: { opens: number; repeatRate: number | null };
  delta: number | null;
}

interface GroupRow { n: number; packs: number; trades: number; fusions: number; logins: number; stakes: number }

export interface CohortStats {
  wallets: number;
  /** Средние на кошелёк — иначе сравнение когорты из 200 человек с базой из 5 000 бессмысленно. */
  packsPerWallet: number;
  tradesPerWallet: number;
  fusionsPerWallet: number;
  loginDaysPerWallet: number;
  stakedCapsPerWallet: number;
}

export interface CohortReport {
  feature: string;
  windowDays: number;
  from: string;
  to: string;
  cohort: CohortStats;
  baseline: CohortStats;
  /** Отношение средних минус единица: +0.42 = «на 42 % больше сделок на кошелёк». null, когда считать нечего. */
  delta: { packs: number | null; trades: number | null; fusions: number | null; loginDays: number | null; stakedCaps: number | null };
  /** События по дням: кривая принятия фичи. */
  series: { day: number; events: number; wallets: number }[];
}

const round = (v: number) => Math.round(v * 1000) / 1000;
const ratio = (a: number, b: number): number | null => (b > 0 ? round(a / b - 1) : null);

function empty(): CohortStats {
  return { wallets: 0, packsPerWallet: 0, tradesPerWallet: 0, fusionsPerWallet: 0, loginDaysPerWallet: 0, stakedCapsPerWallet: 0 };
}

function statsOf(row: GroupRow | undefined): CohortStats {
  if (!row || row.n === 0) return empty();
  return {
    wallets: row.n,
    packsPerWallet: round(row.packs / row.n),
    tradesPerWallet: round(row.trades / row.n),
    fusionsPerWallet: round(row.fusions / row.n),
    loginDaysPerWallet: round(row.logins / row.n),
    stakedCapsPerWallet: round(row.stakes / row.n),
  };
}

/**
 * Считает одну группу: сколько паков, сделок, фьюжнов, входов и застейканных
 * крышек пришлось на кошелёк. `members` — подзапрос, возвращающий колонку
 * `wallet`; коррелированные подзапросы намеренно: групп две, а данных в
 * админском отчёте — обозримое число кошельков.
 */
function group(db: Db, members: string, memberParams: (string | number)[], from: number, to: number, dayFrom: number, dayTo: number): GroupRow | undefined {
  const sql = `
    SELECT COUNT(*) n,
           COALESCE(SUM(packs), 0) packs,
           COALESCE(SUM(trades), 0) trades,
           COALESCE(SUM(fusions), 0) fusions,
           COALESCE(SUM(logins), 0) logins,
           COALESCE(SUM(stakes), 0) stakes
      FROM (
        SELECT w.wallet,
               (SELECT COUNT(*) FROM pack_purchases p WHERE p.buyer = w.wallet AND COALESCE(p.block_time, 0) >= ? AND COALESCE(p.block_time, 0) < ?) packs,
               (SELECT COUNT(*) FROM sales s WHERE (s.buyer = w.wallet OR s.seller = w.wallet) AND COALESCE(s.block_time, 0) >= ? AND COALESCE(s.block_time, 0) < ?) trades,
               (SELECT COUNT(*) FROM fusions f WHERE f.owner = w.wallet AND COALESCE(f.block_time, 0) >= ? AND COALESCE(f.block_time, 0) < ?) fusions,
               (SELECT COUNT(*) FROM quest_logins l WHERE l.wallet = w.wallet AND l.day >= ? AND l.day <= ?) logins,
               (SELECT COUNT(*) FROM stakes k WHERE k.owner = w.wallet AND k.active = 1) stakes
          FROM (${members}) w
      )`;
  // Порядок биндинга — по порядку появления в тексте: сначала коррелированные
  // подзапросы в SELECT, потом параметры подзапроса-членства в FROM.
  return db.get<GroupRow>(sql, from, to, from, to, from, to, dayFrom, dayTo, ...memberParams);
}

/**
 * Когорта фичи против базовой линии.
 *
 * Базовая линия — кошельки, игравшие в то же окно (≥1 вход), но **не**
 * трогавшие фичу. Сравнивать с «всеми кошельками» нельзя: тогда в базу
 * попадают мёртвые аккаунты, и любая фича выглядит как чудо-удержание.
 */
export function cohortReport(db: Db, feature: WorldFeature, windowDays = 30, t = now()): CohortReport {
  const to = t;
  const from = t - windowDays * DAY;
  // Окно в днях — включительно с двух сторон: отчёт за «последние 30 дней»
  // обязан видеть сегодняшний вход, иначе базовая линия каждый день теряет сутки.
  const dayFrom = Math.floor(from / DAY);
  const dayTo = Math.floor(to / DAY);
  const cohortMembers = `SELECT DISTINCT wallet FROM feature_events WHERE feature = ? AND at >= ? AND at < ?`;
  const baselineMembers = `SELECT DISTINCT wallet FROM quest_logins WHERE day >= ? AND day <= ?
                            AND wallet NOT IN (SELECT wallet FROM feature_events WHERE feature = ? AND at >= ? AND at < ?)`;

  const cohortRow = group(db, cohortMembers, [feature, from, to], from, to, dayFrom, dayTo);
  const baselineRow = group(db, baselineMembers, [dayFrom, dayTo, feature, from, to], from, to, dayFrom, dayTo);
  const cohort = statsOf(cohortRow);
  const baseline = statsOf(baselineRow);

  const series = db.all<{ day: number; events: number; wallets: number }>(
    `SELECT at / ${DAY} AS day, COUNT(*) AS events, COUNT(DISTINCT wallet) AS wallets
       FROM feature_events WHERE feature = ? AND at >= ? AND at < ?
      GROUP BY 1 ORDER BY 1`, feature, from, to,
  ).map((r) => ({ day: r.day, events: Number(r.events), wallets: Number(r.wallets) }));

  return {
    feature, windowDays, from: iso(from), to: iso(to),
    cohort, baseline,
    delta: {
      packs: ratio(cohort.packsPerWallet, baseline.packsPerWallet),
      trades: ratio(cohort.tradesPerWallet, baseline.tradesPerWallet),
      fusions: ratio(cohort.fusionsPerWallet, baseline.fusionsPerWallet),
      loginDays: ratio(cohort.loginDaysPerWallet, baseline.loginDaysPerWallet),
      stakedCaps: ratio(cohort.stakedCapsPerWallet, baseline.stakedCapsPerWallet),
    },
    series,
  };
}

/**
 * §12 строка 1: доля вскрытий, за которыми в течение 24 ч купили ещё один пак.
 *
 * Когорта — вскрытия с хотя бы одной крышкой Epic+ (редкость ≥ 5, тот же порог,
 * при котором карточку крутит флип), база — вскрытия, где такого дропа не было.
 * События под это не пишем: `pack_opens` и так хранит блок и редкости, а индексатор
 * переигрывается — лишняя строка в `feature_events` при пересборке превратилась бы
 * в дубль. Дубликатов здесь не бывает по построению.
 */
export function epicPlusRepeat(db: Db, windowDays = 30, t = now()): Repeat24h {
  const to = t;
  const from = t - windowDays * DAY;
  const share = (minRarity: number, below: boolean) => {
    const row = db.get<{ n: number; hits: number }>(`
      SELECT COUNT(*) n, COALESCE(SUM(repeat), 0) hits
        FROM (
          SELECT o.buyer, o.block_time,
                 CASE WHEN EXISTS (
                   SELECT 1 FROM pack_purchases p
                    WHERE p.buyer = o.buyer
                      AND COALESCE(p.block_time, 0) > o.block_time
                      AND COALESCE(p.block_time, 0) < o.block_time + ?
                 ) THEN 1 ELSE 0 END repeat
            FROM pack_opens o
           WHERE o.block_time >= ? AND o.block_time < ?
             AND (SELECT MAX(je.value) FROM json_each(o.rarities) je) ${below ? '<' : '>='} ?
        )`, DAY, from, to, minRarity);
    const n = row?.n ?? 0;
    return { opens: n, repeatRate: n > 0 ? round((row?.hits ?? 0) / n) : null };
  };
  const cohort = share(EPIC_PLUS, false);
  const baseline = share(EPIC_PLUS, true);
  return { cohort, baseline, delta: ratio(cohort.repeatRate ?? 0, baseline.repeatRate ?? 0) };
}

/**
 * §12 строка 4: доля реванша после проигрыша.
 *
 * Считаем по боям, а не по кошелькам: за окно игрок может проиграть несколько
 * раз, и «вернулся ли он» — вопрос к каждому поражению. Когорта — поражения,
 * база — победы: если после поражения в бой возвращаются не реже, чем после
 * победы, трик-рил (§2.4) делает своё дело или, как минимум, не добивает.
 * Время в `matches` — миллисекунды (старт/финиш боя), в отличие от остальных
 * таблиц, где секунды.
 */
export const REMATCH_WINDOW_MS = 30 * 60 * 1000;

export function arenaRematch(db: Db, windowDays = 30, t = now()): Repeat24h {
  const to = t * 1000;
  const from = (t - windowDays * DAY) * 1000;
  const share = (won: 0 | 1) => {
    const row = db.get<{ n: number; hits: number }>(`
      WITH sides AS (
        SELECT id, a AS wallet, ended_at, CASE WHEN winner = a THEN 1 ELSE 0 END won FROM matches
         WHERE status = 'resolved' AND winner IS NOT NULL AND ended_at IS NOT NULL
        UNION ALL
        SELECT id, b AS wallet, ended_at, CASE WHEN winner = b THEN 1 ELSE 0 END won FROM matches
         WHERE status = 'resolved' AND winner IS NOT NULL AND ended_at IS NOT NULL
      )
      SELECT COUNT(*) n, COALESCE(SUM(followed), 0) hits
        FROM (
          SELECT s.id, s.wallet, s.ended_at,
                 CASE WHEN EXISTS (
                   SELECT 1 FROM matches n
                    WHERE (n.a = s.wallet OR n.b = s.wallet)
                      AND n.started_at > s.ended_at
                      AND n.started_at < s.ended_at + ?
                 ) THEN 1 ELSE 0 END followed
            FROM sides s
           WHERE s.won = ? AND s.ended_at >= ? AND s.ended_at < ?
        )`, REMATCH_WINDOW_MS, won, from, to);
    const n = row?.n ?? 0;
    return { opens: n, repeatRate: n > 0 ? round((row?.hits ?? 0) / n) : null };
  };
  const cohort = share(0);
  const baseline = share(1);
  return { cohort, baseline, delta: ratio(cohort.repeatRate ?? 0, baseline.repeatRate ?? 0) };
}

/** Все фичи сразу — ровно то, что смотрит админский экран. */
export function worldReport(db: Db, windowDays = 30, t = now()) {
  return {
    windowDays, asOf: iso(t),
    features: WORLD_FEATURES.map((f) => cohortReport(db, f, windowDays, t)),
    epicPlus: epicPlusRepeat(db, windowDays, t),
    arenaRematch: arenaRematch(db, windowDays, t),
  };
}
