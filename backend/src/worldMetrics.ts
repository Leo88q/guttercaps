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
/**
 * Фичи мира, у которых есть когорта в отчёте. `line` (§5.1) — заезды: доля
 * игроков с ≥3 заездами в день и сток $CG на платных заездах. `crew` (§5.6) —
 * команды: когорта «вступил в команду», метрика — заезды линии на кошелёк,
 * потому что командная доска и есть стрелка команды в линию.
 */
export const WORLD_FEATURES = ['wall', 'exhibit', 'tag', 'inspect', 'rider', 'achievement', 'line', 'crew'] as const;

/** Порог флипа (docs/16 §2.1) — редкость, начиная с которой дроп считается «редким». */
export const EPIC_PLUS = 5;
export type WorldFeature = (typeof WORLD_FEATURES)[number];

/**
 * Псевдофича для когорт, которые считаются из состояния данных, а не из
 * событий: мурал района (§2.3) — это владение, событий у него нет. Строка
 * нужна ровно для того, чтобы карточку в админке можно было подписать.
 */
export const DATA_COHORT_FEATURE = 'collection' as const;

/**
 * Одно событие мира. Пишется внутри того же запроса, что и само действие:
 * выставить крышку и записать событие — одна транзакция (см. `setRig`).
 * `at` в секундах (как `now()` и `block_time`); параметр нужен тестам и
 * догону, сам код времени не передаёт.
 */
export function recordEvent(db: Db, wallet: string, feature: WorldFeature, kind: string, meta?: Record<string, unknown>, at = now()): void {
  db.run(`INSERT INTO feature_events (wallet, feature, kind, at, meta) VALUES (?, ?, ?, ?, ?)`, wallet, feature, kind, at, meta ? JSON.stringify(meta) : null);
}

/** Строка метрик одной группы: все — средние на кошелёк. */
export interface Repeat24h {
  cohort: { opens: number; repeatRate: number | null };
  baseline: { opens: number; repeatRate: number | null };
  delta: number | null;
}

interface GroupRow { n: number; packs: number; trades: number; fusions: number; logins: number; stakes: number; refs: number; services: number; runs: number; rundays: number }

export interface CohortStats {
  wallets: number;
  /** Средние на кошелёк — иначе сравнение когорты из 200 человек с базой из 5 000 бессмысленно. */
  packsPerWallet: number;
  tradesPerWallet: number;
  fusionsPerWallet: number;
  loginDaysPerWallet: number;
  stakedCapsPerWallet: number;
  /** Кошельков, пришедших по ссылке этого игрока, на одного делителя (§12 строка 2). */
  referralsPerWallet: number;
  /**
   * Оплаченных сервисов на кошелёк (§4.6): косметика, хендлы, скины — ровно тот
   * «контур предметов», которым райдер должен кормить петлю. Покупки паков этот
   * контур не покрывают: косметика продаётся отдельно.
   */
  servicesPerWallet: number;
  /**
   * Заездов линии на кошелёк и дней с тремя заездами на кошелёк (§5.1, строка
   * §12). Дельты по ним в отчёте нет и быть не может: базовая линия набрана так,
   * что линии не касалась, — сравнивать 8 с 0 значит мерить когорту, а не эффект.
   */
  runsPerWallet: number;
  runDaysPerWallet: number;
}

export interface CohortReport {
  feature: string;
  windowDays: number;
  from: string;
  to: string;
  cohort: CohortStats;
  baseline: CohortStats;
  /** Отношение средних минус единица: +0.42 = «на 42 % больше сделок на кошелёк». null, когда считать нечего. */
  delta: { packs: number | null; trades: number | null; fusions: number | null; loginDays: number | null; stakedCaps: number | null; referrals: number | null; services: number | null };
  /** События по дням: кривая принятия фичи. */
  series: { day: number; events: number; wallets: number }[];
}

const round = (v: number) => Math.round(v * 1000) / 1000;
const ratio = (a: number, b: number): number | null => (b > 0 ? round(a / b - 1) : null);
/** Отношение средних, но только когда в когорте кто-то есть: пустая когорта — null, а не −1. */
const delta = (wallets: number, a: number, b: number): number | null => (wallets > 0 ? ratio(a, b) : null);

function empty(): CohortStats {
  return { wallets: 0, packsPerWallet: 0, tradesPerWallet: 0, fusionsPerWallet: 0, loginDaysPerWallet: 0, stakedCapsPerWallet: 0, referralsPerWallet: 0, servicesPerWallet: 0, runsPerWallet: 0, runDaysPerWallet: 0 };
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
    referralsPerWallet: round(row.refs / row.n),
    servicesPerWallet: round(row.services / row.n),
    runsPerWallet: round(row.runs / row.n),
    runDaysPerWallet: round(row.rundays / row.n),
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
           COALESCE(SUM(stakes), 0) stakes,
           COALESCE(SUM(refs), 0) refs,
           COALESCE(SUM(services), 0) services,
           COALESCE(SUM(runs), 0) runs,
           COALESCE(SUM(rundays), 0) rundays
      FROM (
        SELECT w.wallet,
               (SELECT COUNT(*) FROM pack_purchases p WHERE p.buyer = w.wallet AND COALESCE(p.block_time, 0) >= ? AND COALESCE(p.block_time, 0) < ?) packs,
               (SELECT COUNT(*) FROM sales s WHERE (s.buyer = w.wallet OR s.seller = w.wallet) AND COALESCE(s.block_time, 0) >= ? AND COALESCE(s.block_time, 0) < ?) trades,
               (SELECT COUNT(*) FROM fusions f WHERE f.owner = w.wallet AND COALESCE(f.block_time, 0) >= ? AND COALESCE(f.block_time, 0) < ?) fusions,
               (SELECT COUNT(*) FROM quest_logins l WHERE l.wallet = w.wallet AND l.day >= ? AND l.day <= ?) logins,
               (SELECT COUNT(*) FROM stakes k WHERE k.owner = w.wallet AND k.active = 1) stakes,
               (SELECT COUNT(*) FROM wallets r WHERE r.referrer = w.wallet AND COALESCE(r.first_seen, 0) >= ? AND COALESCE(r.first_seen, 0) < ?) refs,
               (SELECT COUNT(*) FROM service_payments sp WHERE sp.buyer = w.wallet AND COALESCE(sp.block_time, 0) >= ? AND COALESCE(sp.block_time, 0) < ?) services,
               (SELECT COUNT(*) FROM line_runs lr WHERE lr.wallet = w.wallet AND lr.submitted_at >= ? AND lr.submitted_at < ?) runs,
               (SELECT COUNT(*) FROM (SELECT lr2.day FROM line_runs lr2 WHERE lr2.wallet = w.wallet AND lr2.submitted_at >= ? AND lr2.submitted_at < ? GROUP BY lr2.day HAVING COUNT(*) >= 3)) rundays
          FROM (${members}) w
      )`;
  // Порядок биндинга — по порядку появления в тексте: сначала коррелированные
  // подзапросы в SELECT, потом параметры подзапроса-членства в FROM. Окно здесь
  // в секундах, как и `line_runs.submitted_at`, — переводить нечего.
  return db.get<GroupRow>(sql, from, to, from, to, from, to, dayFrom, dayTo, from, to, from, to, from, to, from, to, ...memberParams);
}

/**
 * Когорта фичи против базовой линии.
 *
 * Базовая линия — кошельки, игравшие в то же окно (≥1 вход), но **не**
 * трогавшие фичу. Сравнивать с «всеми кошельками» нельзя: тогда в базу
 * попадают мёртвые аккаунты, и любая фича выглядит как чудо-удержание.
 */
export interface CohortOpts {
  windowDays?: number;
  /**
   * Узкий срез внутри фичи: только события с этим `kind` (например, `board`
   * внутри `wall`). Без него считается вся фича целиком.
   */
  kind?: string;
  /**
   * С кем сравниваем.
   * `players` (по умолчанию) — все, кто играл в окне, но среза не касался.
   * `feature` — трогавшие ту же фичу, но в срез не попавшие. Второй вариант
   * отвечает на вопрос «добавляет ли срез что-то сверх самой фичи», и именно
   * он честен для доски недели: каждый автор доски и так держит слот (§3.4),
   * поэтому сравнивать его со «всеми игравшими» — значит измерять слот, а не доску.
   */
  baseline?: 'players' | 'feature';
  /**
   * Своё определение когорты: подзапрос с колонкой `wallet` и его параметры.
   * Нужно там, где когорта — не событие фичи, а состояние данных: мурал района
   * (§2.3) собран не событием, а подбором коллекции, и отдельную запись в
   * `feature_events` под него писать незачем — индексатор переигрывается.
   */
  members?: { sql: string; params?: (string | number)[] };
  /** Имя в отчёте, когда когорта не про фичу целиком (например `collection.mural`). */
  label?: string;
}

export function cohortReport(db: Db, feature: WorldFeature | typeof DATA_COHORT_FEATURE, opts: CohortOpts = {}, t = now()): CohortReport {
  const { windowDays = 30, kind, members, label } = opts;
  // Когорта из данных (§2.3) не про фичу, поэтому базовая линия у неё одна —
  // игравшие в том же окне. Сравнивать её с «остальными, кто трогал фичу»
  // не с чем: фичи у неё нет.
  const baselineMode = members ? 'players' : (opts.baseline ?? 'players');
  const to = t;
  const from = t - windowDays * DAY;
  // Окно в днях — включительно с двух сторон: отчёт за «последние 30 дней»
  // обязан видеть сегодняшний вход, иначе базовая линия каждый день теряет сутки.
  const dayFrom = Math.floor(from / DAY);
  const dayTo = Math.floor(to / DAY);
  // Срез по kind — такой же фильтр, что и по фиче: `board` внутри `wall`.
  const sliceSql = kind === undefined ? '' : ' AND kind = ?';
  const cohortMembers = members?.sql ?? `SELECT DISTINCT wallet FROM feature_events WHERE feature = ? AND at >= ? AND at < ?${sliceSql}`;
  // Своя когорта — свои параметры (и их может не быть вовсе). Смешивать с
  // параметрами фичи нельзя: лишний биндинг ломает весь запрос.
  const cohortParams: (string | number)[] = members ? (members.params ?? []) : (kind === undefined ? [feature, from, to] : [feature, from, to, kind]);
  // Базовая линия исключает ровно то же множество, что и когорта, — тем же
  // подзапросом. Иначе при своей когорте она выродилась бы в «все игравшие»,
  // и мы сравнивали бы когорту с самой собой.
  const cohortSel = cohortMembers.replace(/^SELECT DISTINCT wallet FROM /, 'SELECT wallet FROM ');
  // В режиме `feature` базу набирают те же события фичи — но без среза. Это не
  // «все игравшие»: у фичи уже есть своё ядро, и сравнивать срез надо с ним.
  const baselineMembers = baselineMode === 'feature'
    ? `SELECT DISTINCT wallet FROM feature_events WHERE feature = ? AND at >= ? AND at < ?
        AND wallet NOT IN (${cohortSel})`
    : `SELECT DISTINCT wallet FROM quest_logins WHERE day >= ? AND day <= ?
        AND wallet NOT IN (${cohortSel})`;
  const baselineParams: (string | number)[] = baselineMode === 'feature'
    ? [feature, from, to, ...cohortParams]
    : [dayFrom, dayTo, ...cohortParams];

  const cohortRow = group(db, cohortMembers, cohortParams, from, to, dayFrom, dayTo);
  const baselineRow = group(db, baselineMembers, baselineParams, from, to, dayFrom, dayTo);
  const cohort = statsOf(cohortRow);
  const baseline = statsOf(baselineRow);

  // Кривой принятия здесь нет: у когорты из данных (§2.3) нет событий, а
  // «сколько муралов собрано по дням» — другой вопрос, и на него отвечает не
  // этот отчёт. Пустой массив вместо серии нулевых дней.
  const series = members ? [] : db.all<{ day: number; events: number; wallets: number }>(
    `SELECT at / ${DAY} AS day, COUNT(*) AS events, COUNT(DISTINCT wallet) AS wallets
       FROM feature_events WHERE feature = ? AND at >= ? AND at < ?${sliceSql}
      GROUP BY 1 ORDER BY 1`, ...(kind === undefined ? [feature, from, to] : [feature, from, to, kind]),
  ).map((r) => ({ day: r.day, events: Number(r.events), wallets: Number(r.wallets) }));

  return {
    // Для среза имя — это имя среза, а не фичи: в админке карточки фич и
    // карточки срезов лежат рядом, и подписи не должны повторяться.
    feature: label ?? (kind === undefined ? feature : `${feature}.${kind}`), windowDays, from: iso(from), to: iso(to),
    cohort, baseline,
    // Пустая когорта — не «−100 %», а «считать нечего». Раньше она давала −1 по
    // каждой метрике, и фича, которой никто не пользовался, выглядела в отчёте
    // как фича, всё испортившая. §12 требует null ровно в этом случае.
    delta: {
      packs: delta(cohort.wallets, cohort.packsPerWallet, baseline.packsPerWallet),
      trades: delta(cohort.wallets, cohort.tradesPerWallet, baseline.tradesPerWallet),
      fusions: delta(cohort.wallets, cohort.fusionsPerWallet, baseline.fusionsPerWallet),
      loginDays: delta(cohort.wallets, cohort.loginDaysPerWallet, baseline.loginDaysPerWallet),
      stakedCaps: delta(cohort.wallets, cohort.stakedCapsPerWallet, baseline.stakedCapsPerWallet),
      referrals: delta(cohort.wallets, cohort.referralsPerWallet, baseline.referralsPerWallet),
      services: delta(cohort.wallets, cohort.servicesPerWallet, baseline.servicesPerWallet),
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
/**
 * §12 строка «доска недели» (§3.7): авторы доски против держателей слотов,
 * которые на доску не попали.
 *
 * Именно такое сравнение, а не «авторы против всех игравших»: попасть на доску
 * можно только держа слот (§3.4), а держатель слота и так заходит чаще среднего
 * игрока (он выполнил 7 дней подряд и застейкал крышку). Сравни со всеми —
 * измеришь слот. Сравни с держателями — измеришь доску.
 */
export function boardCohort(db: Db, windowDays = 30, t = now()): CohortReport {
  return cohortReport(db, 'wall', { windowDays, kind: 'board', baseline: 'feature' }, t);
}

/**
 * §2.3: «собранный район» — мурал района собран на ≥80 %, то есть закрыто
 * восемь крышек из девяти (семь — это 78 %, порог не взят).
 *
 * Когорта берётся не из `feature_events`, а из состояния коллекции: собрать
 * мурал — не действие, а владение, и событие под него пришлось бы
 * пересчитывать при каждом переигрывании индексатора. База — игравшие в том же
 * окне, до мурала не дошедшие; срез считает сделки и фьюжны, потому что именно
 * ими (§2.3) мурал должен кормить основную петлю.
 *
 * Сожжённые фьюжном крышки не считаются: их больше нет, и мурал они не держат.
 */
export const MURAL_RARITIES = 9;
export const MURAL_COMPLETE_AT = 8;

export function muralCohort(db: Db, windowDays = 30, t = now()): CohortReport {
  return cohortReport(db, DATA_COHORT_FEATURE, {
    windowDays,
    label: 'collection.mural',
    members: {
      sql: `SELECT DISTINCT owner AS wallet
              FROM chips
             WHERE owner IS NOT NULL AND owner <> '' AND COALESCE(burned_at, 0) = 0
             GROUP BY owner, collection_idx
            HAVING COUNT(DISTINCT rarity) >= ${MURAL_COMPLETE_AT}`,
    },
  }, t);
}

export function worldReport(db: Db, windowDays = 30, t = now()) {
  return {
    windowDays, asOf: iso(t),
    features: WORLD_FEATURES.map((f) => cohortReport(db, f, { windowDays }, t)),
    /** Срезы внутри фич: то же сравнение, но уже внутри тех, кто фичу трогал. */
    slices: [boardCohort(db, windowDays, t), muralCohort(db, windowDays, t)],
    epicPlus: epicPlusRepeat(db, windowDays, t),
    arenaRematch: arenaRematch(db, windowDays, t),
  };
}
