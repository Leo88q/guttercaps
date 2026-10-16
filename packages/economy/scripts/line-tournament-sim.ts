// =============================================================================
// GUTTERCAPS — платный вход в Линию: моделирование (docs/16 §5.4)
// -----------------------------------------------------------------------------
// Вопрос: можно ли открыть заезд со взносом в $CG и призовым фондом, чтобы это
// не сломало EV-якоря экономики.
//
// Что здесь считается из живых таблиц, а не придумано:
//   • навык → очки: тот самый бот `botReplay`, которым мерились пороги наград
//     (§5.1). Игрок моделируется дрожанием рук в тиках; его очки — результат
//     настоящего `simulateRun` на настоящей раскладке дня.
//   • форма выплат: `SEASON.payoutBrackets` (те же процентили, что у сезонной
//     лестницы арены) через `seasonPayoutByRank`.
//   • якоря: `STANDARD_EV_TARGET` (пак), `FEES`/`WAGER` (рейк Cap Slam),
//     `EMISSION_SPLIT.eventsReserve` (уже зарезервированная под турниры доля),
//     `guardedEmission` (гвард эмиссии).
//
// Что здесь ASSUMPTION (под sweep'ом, не спрятано):
//   • распределение навыка в поле (SKILL_MIX) и перекос входа (ENTRY_BIAS);
//   • размер поля и число мультиаккаунтов у одного оператора (CLUSTER).
//
// Якоря, которые проверяет прогон:
//   A1 «не лучше пака» — медианный участник не должен получать с каждого $CG
//      взноса больше, чем тот же $CG вернул бы паком (ценность пака × реализация
//      на маркете). Иначе $CG утекает из основного стока (75 % сжигания) в
//      слабосжигающий цикл.
//   A2 «не лучше арены» — ни одна когорта (включая мультиаккаунт) не должна
//      зарабатывать на взносе больше, чем сильный игрок на ставке Cap Slam.
//   A3 «сжигает не меньше арены» — доля взноса, уходящая из обращения, не ниже
//      сжигания на ставке (рейк 5 % × 40 %).
//   A4 «приз не из новой эмиссии» — если пул дотируется, то только из уже
//      зарезервированной под турниры доли eventsReserve.
//
// Run: node --experimental-strip-types packages/economy/scripts/line-tournament-sim.ts
//      node --experimental-strip-types packages/economy/scripts/line-tournament-sim.ts --json
// =============================================================================

import {
  EMISSION_GUARD, EMISSION_SPLIT, FEES, SEASON, STANDARD_EV_TARGET, WAGER,
  BASELINE_ASSUMPTIONS, botReplay, dailyEmission, dailyFlows, guardedEmission,
  lineLayout, packExpectedValueMult, PACKS, seasonPayoutByRank, simulateRun,
} from '../src/index.ts';

// ------------------------------------------------------------------ якоря

/** Пак возвращает STANDARD_EV_TARGET цены ценностью крышек; продаётся на маркете с 10 % издержек. */
const MARKET_HAIRCUT = 1 - (FEES.marketplaceFeeBps + 250) / 10_000;
export const PACK_VALUE_PER_CG = STANDARD_EV_TARGET * MARKET_HAIRCUT; // доля цены, которую реально вернёт пак

/** Сильный игрок арены (pWin = 0.8) на ставке: (2 × (1 − rake) × p) − 1 на каждый $CG риска. */
export const WAGER_PWIN = 0.8;
export const WAGER_EDGE_PER_CG = 2 * (1 - FEES.pvpRakeBps / 10_000) * WAGER_PWIN - 1;
/** Сжигание на ставке: рейк × доля рейка в сжигание. */
export const WAGER_BURN_PER_CG = (FEES.pvpRakeBps / 10_000) * (1 - (FEES.pvpRakeTreasuryShareBps + FEES.pvpRakePoolShareBps) / 10_000);

// ------------------------------------------------------------- модель навыка

const BANDS = ['pro', 'good', 'average', 'casual', 'masher'] as const;
export type Band = (typeof BANDS)[number];

/**
 * ASSUMPTION: дрожание рук по когортам (тики; 1 тик = 20 мс), перекос входа
 * (во сколько раз чаще когорта платит взнос) и попыток в день. Потолок попыток —
 * не выдумка модели: это `LINE.maxPaidRunsPerDay` из §5.1, тот самый, что
 * ограничивает платные заезды. Им же ограничивается ёмкость фермы.
 */
export const SKILL_MIX: { band: Band; from: number; to: number; share: number; bias: number; attempts: number }[] = [
  { band: 'pro', from: 0, to: 2, share: 0.05, bias: 3.0, attempts: 5 },
  { band: 'good', from: 3, to: 5, share: 0.20, bias: 1.6, attempts: 3 },
  { band: 'average', from: 6, to: 9, share: 0.40, bias: 1.0, attempts: 2 },
  { band: 'casual', from: 10, to: 14, share: 0.25, bias: 0.7, attempts: 1 },
  { band: 'masher', from: 15, to: 18, share: 0.10, bias: 0.4, attempts: 1 },
];

const SEEDS = 4;
const DAYS_SAMPLED = 24;

/**
 * Таблица «дрожание → очки»: настоящий бот на настоящих раскладках. Медианы
 * совпадают с теми, что ставили пороги наград (чистая езда ≈ 2,8 тыс.).
 */
export function buildScoreTable(): Map<number, number[]> {
  const table = new Map<number, number[]>();
  for (let j = 0; j <= 18; j++) {
    const scores: number[] = [];
    for (let d = 0; d < DAYS_SAMPLED; d++) {
      const day = 1_000 + d * 37;
      const layout = lineLayout(day);
      for (let s = 0; s < SEEDS; s++) {
        const inputs = botReplay(layout, j, j * 31 + s * 7 + 1);
        scores.push(simulateRun(layout, inputs).score);
      }
    }
    table.set(j, scores);
  }
  return table;
}

// ------------------------------------------------------------------ сценарии

export interface Scenario {
  name: string;
  /** Взнос в $CG. */
  entryCg: number;
  /** Что происходит со взносом, в bps от взноса. Сумма ≠ 10 000 — остаток идёт в пул. */
  burnBps: number;
  treasuryBps: number;
  /** Доля дневного бюджета eventsReserve, идущая в пул сверх взносов (0 = приз только из взносов). */
  reserveBps: number;
  /** Сколько участников в дне. */
  field: number;
  /** Сколько дней считаем. */
  days: number;
  /** Сколько аккаунтов у одного оператора-фермера поверх поля (все — уровень pro). */
  cluster: number;
  /** Потолок платных попыток на кошелёк в день. 0 = без потолка (проверка, что потолок что-то даёт). */
  capAttempts: number;
  /**
   * Какая доля пула выплачивается в $CG. Остальное — косметика (части доски,
   * трофеи): она не имеет цены в $CG и потому якорей не касается вовсе.
   */
  prizeCgShare: number;
}

export interface CohortResult {
  band: string;
  entries: number;
  /** Сколько $CG призов пришлось на 1 $CG взноса (1.0 — в ноль). */
  returnPerCg: number;
  shareOfPool: number;
}

export interface Metrics {
  scenario: string;
  entryCg: number;
  field: number;
  days: number;
  /** Доля взноса, идущая в пул. */
  poolShareOfEntry: number;
  poolPerDayCg: number;
  paidPerDayCg: number;
  burnPerDayCg: number;
  treasuryPerDayCg: number;
  reservePerDayCg: number;
  burnPerCg: number;
  /** Изменение чистой инфляции: эмиссия упёрта в расписание, поэтому лишнее сжигание = минус к чистой эмиссии. */
  netInflationDeltaCg: number;
  /** Сколько $CG в день выносит лучшая когорта (абсолют): потолок попыток ограничивает именно это. */
  bestCohortExtractCgPerDay: number;
  /** Ценность косметической части приза на 1 $CG взноса (в $CG-эквиваленте цены). */
  cosmeticValuePerCg: number;
  /** Вся ценность приза (косметика + $CG) на 1 $CG взноса — с чем игрок сравнивает пак. */
  totalValuePerCg: number;
  /** То же у арены для сравнения: 2 матча в день × минимальная ставка × край. */
  arenaExtractCgPerDay: number;
  top1ShareOfPool: number;
  top10ShareOfPool: number;
  medianReturnPerCg: number;
  cohorts: CohortResult[];
  clusterReturnPerCg: number;
  emissionDeltaCg: number;
  anchors: { id: string; ok: boolean; detail: string }[];
  /** Привлекательность — не безопасность: если приз не стоит взноса, платный вход никому не нужен. */
  appeal: { id: string; ok: boolean; detail: string };
}

const mulberry = (a: number) => () => {
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export function simulate(scn: Scenario, table = buildScoreTable(), seed = 20261016): Metrics {
  const rnd = mulberry(seed);
  // Поле: когорты смещены перекосом входа — сильные ездят чаще, слабые реже.
  const weights = SKILL_MIX.map((s) => s.share * s.bias);
  const total = weights.reduce((a, b) => a + b, 0);
  const quota = SKILL_MIX.map((s, i) => Math.max(1, Math.round((scn.field * weights[i]) / total)));
  const players: { band: Band; jitter: number }[] = [];
  SKILL_MIX.forEach((s, i) => {
    for (let k = 0; k < quota[i]; k++) players.push({ band: s.band, jitter: s.from + Math.floor(rnd() * (s.to - s.from + 1)) });
  });
  for (let k = 0; k < scn.cluster; k++) players.push({ band: 'pro', jitter: Math.floor(rnd() * 2) });

  const n = players.length;
  const attemptsOf = (i: number) => {
    const want = SKILL_MIX.find((s) => s.band === players[i].band)?.attempts ?? 1;
    return scn.capAttempts > 0 ? Math.min(want, scn.capAttempts) : want;
  };
  // Доска ранжирует кошельки по лучшему заезду дня — ровно так, как уже работает
  // недельная доска §5.1, а не «по сумме попыток». Поэтому лишняя попытка
  // улучшает не место само по себе, а только максимум из нескольких заездов.
  const entriesPerDay = players.reduce((sum, _, i) => sum + attemptsOf(i), 0);
  const entryTotal = entriesPerDay * scn.entryCg;
  const poolFromEntries = entryTotal * Math.max(0, 1 - (scn.burnBps + scn.treasuryBps) / 10_000);
  const reserveBudget = (dailyFlows(BASELINE_ASSUMPTIONS).emissionCg * EMISSION_SPLIT.eventsReserve) / 100;
  const reserve = (reserveBudget * scn.reserveBps) / 10_000;
  const pool = poolFromEntries + reserve;
  // Якоря мерят только ту часть приза, которая возвращается в оборот деньгами.
  // Косметика в $CG не конвертируется, поэтому в EV-$CG она нулевая.
  const poolCg = pool * scn.prizeCgShare;

  const wins = new Map<number, number>();
  const entriesBy = new Map<number, number>();
  players.forEach((_, i) => { wins.set(i, 0); entriesBy.set(i, 0); });
  let paidTotal = 0;

  for (let day = 0; day < scn.days; day++) {
    const scores = players.map((p, i) => {
      const row = table.get(p.jitter) ?? [0];
      let best = 0;
      for (let a = 0; a < attemptsOf(i); a++) best = Math.max(best, row[Math.floor(rnd() * row.length)]);
      return { ...p, score: best };
    });
    const order = scores.map((p, i) => ({ i, score: p.score })).sort((a, b) => b.score - a.score || a.i - b.i);
    // Выплаты — той же формы, что у сезонной лестницы арены (те же процентили и
    // тот же перенос доли пустой полосы вверх). Одно отличие: `seasonPayoutByRank`
    // ужимает пул при малом числе участников (правило «пустой сезон не отдаёт
    // шестинедельную эмиссию горстке кошельков»). Дневной пул линии дотирован
    // взносами целиком, поэтому ужатие компенсируется ровно на его коэффициент —
    // иначе модель врала бы в сторону безопасности: чем меньше поле, тем «безопаснее»
    // выглядел бы любой сценарий.
    const poolMicro = BigInt(Math.round(poolCg * 1e6));
    const grossUp = n >= SEASON.fullPoolParticipants ? poolMicro : (poolMicro * BigInt(SEASON.fullPoolParticipants)) / BigInt(n);
    const payout = seasonPayoutByRank(grossUp, n);
    players.forEach((_, i) => entriesBy.set(i, (entriesBy.get(i) ?? 0) + attemptsOf(i) * scn.entryCg));
    order.forEach((o, idx) => {
      const amount = Number(payout.get(idx + 1) ?? 0n) / 1e6;
      wins.set(o.i, (wins.get(o.i) ?? 0) + amount);
      paidTotal += amount;
    });
  }

  const cohortOf = (band: Band) => {
    let spent = 0, got = 0;
    players.forEach((p, i) => {
      if (p.band !== band) return;
      spent += entriesBy.get(i) ?? 0;
      got += wins.get(i) ?? 0;
    });
    return { band, entries: spent / scn.entryCg, returnPerCg: spent > 0 ? got / spent : 0, shareOfPool: paidTotal > 0 ? got / paidTotal : 0 };
  };
  const cohorts = BANDS.map((b) => cohortOf(b));
  // Кластер: последние `cluster` игроков — аккаунты одного оператора.
  let clusterSpent = 0, clusterGot = 0;
  for (let i = n - scn.cluster; i < n; i++) { clusterSpent += entriesBy.get(i) ?? 0; clusterGot += wins.get(i) ?? 0; }

  const perBand = [...cohorts].sort((a, b) => a.returnPerCg - b.returnPerCg);
  const medianReturnPerCg = perBand[Math.floor(perBand.length / 2)].returnPerCg;
  const paidSorted = [...wins.values()].sort((a, b) => b - a);
  const top1 = Math.max(1, Math.round(n * 0.01));
  const top10 = Math.max(1, Math.round(n * 0.10));
  const sumTop = (k: number) => paidSorted.slice(0, k).reduce((a, b) => a + b, 0);

  const burnPerDay = (entryTotal * scn.burnBps) / 10_000;
  const treasuryPerDay = (entryTotal * scn.treasuryBps) / 10_000;
  const baseline = dailyFlows(BASELINE_ASSUMPTIONS);
  const cap = dailyEmission(0);
  const emissionDelta = guardedEmission(cap, baseline.burnedCg + burnPerDay) - guardedEmission(cap, baseline.burnedCg);
  // Лучшая когорта: сколько $CG в день один её кошелёк выносит сверх взносов.
  const bestBand = [...cohorts].sort((a, b) => b.returnPerCg - a.returnPerCg)[0];
  const perWalletEntries = SKILL_MIX.find((x) => x.band === bestBand.band)?.attempts ?? 1;
  const bestExtract = Math.max(0, (bestBand.returnPerCg - 1) * perWalletEntries * scn.entryCg);
  const arenaExtract = 2 * (WAGER.minCgMicro / 1e6) * WAGER_EDGE_PER_CG;

  const m: Metrics = {
    scenario: scn.name, entryCg: scn.entryCg, field: scn.field, days: scn.days,
    poolShareOfEntry: Math.max(0, 1 - (scn.burnBps + scn.treasuryBps) / 10_000),
    poolPerDayCg: pool, paidPerDayCg: paidTotal / scn.days,
    burnPerDayCg: burnPerDay, treasuryPerDayCg: treasuryPerDay, reservePerDayCg: reserve,
    burnPerCg: scn.burnBps / 10_000,
    netInflationDeltaCg: -burnPerDay - treasuryPerDay,
    bestCohortExtractCgPerDay: bestExtract, arenaExtractCgPerDay: arenaExtract,
    cosmeticValuePerCg: (pool * (1 - scn.prizeCgShare)) / entryTotal,
    totalValuePerCg: (pool * (1 - scn.prizeCgShare)) / entryTotal + medianReturnPerCg,
    top1ShareOfPool: paidTotal > 0 ? sumTop(top1) / paidTotal : 0,
    top10ShareOfPool: paidTotal > 0 ? sumTop(top10) / paidTotal : 0,
    medianReturnPerCg, cohorts, clusterReturnPerCg: clusterSpent > 0 ? clusterGot / clusterSpent : 0,
    emissionDeltaCg: emissionDelta,
    anchors: [],
  };
  m.anchors = checkAnchors(m, scn, reserveBudget);
  m.appeal = {
    id: 'A5 приз стоит взноса',
    ok: m.totalValuePerCg >= PACK_VALUE_PER_CG * 0.9,
    detail: `ценность приза ${m.totalValuePerCg.toFixed(3)} на $CG (косметика ${m.cosmeticValuePerCg.toFixed(3)} + $CG ${m.medianReturnPerCg.toFixed(3)}) vs пак ${PACK_VALUE_PER_CG.toFixed(3)}`,
  };
  return m;
}

/** Якоря. Каждый возвращает OK/FAIL с числом, чтобы вердикт был проверяемым, а не вкусовым. */
export function checkAnchors(m: Metrics, scn: Scenario, reserveBudget: number) {
  const best = Math.max(...m.cohorts.map((c) => c.returnPerCg), m.clusterReturnPerCg) - 1;
  return [
    {
      id: 'A1 не лучше пака (медиана)',
      ok: m.medianReturnPerCg <= PACK_VALUE_PER_CG + 1e-9,
      detail: `медиана возвращает ${m.medianReturnPerCg.toFixed(3)} $CG на $CG взноса vs пак ${PACK_VALUE_PER_CG.toFixed(3)}`,
    },
    {
      id: 'A2 не лучше арены (лучшая когорта)',
      ok: best <= WAGER_EDGE_PER_CG + 1e-9,
      detail: `лучший край ${(best * 100).toFixed(1)} % vs арена ${(WAGER_EDGE_PER_CG * 100).toFixed(1)} % при pWin ${WAGER_PWIN}`,
    },
    {
      id: 'A3 сжигает не меньше арены',
      ok: m.burnPerCg >= WAGER_BURN_PER_CG - 1e-9,
      detail: `${(m.burnPerCg * 100).toFixed(1)} % взноса сжигается vs ${(WAGER_BURN_PER_CG * 100).toFixed(1)} % на ставке`,
    },
    {
      id: 'A4 приз не из новой эмиссии',
      ok: m.reservePerDayCg <= reserveBudget + 1e-9,
      detail: `из eventsReserve ${m.reservePerDayCg.toFixed(0)} $CG/день, бюджет ${reserveBudget.toFixed(0)} $CG/день`,
    },
  ];
}

// ------------------------------------------------------------------- прогон

const BASE = { entryCg: 30, field: 150, days: 90, cluster: 8, capAttempts: 5 } as const;

export const SCENARIOS: Scenario[] = [
  { ...BASE, name: 'как в черновике: пак-сжигание + рейк 5 %', burnBps: 7500, treasuryBps: 2000, reserveBps: 0, prizeCgShare: 1 },
  { ...BASE, name: 'как Cap Slam: рейк 5 %, остальное в пул', burnBps: 200, treasuryBps: 200, reserveBps: 0, prizeCgShare: 1 },
  { ...BASE, name: 'пак + рейк: сжигание 75 %, пул 23,75 %', burnBps: 7500, treasuryBps: 0, reserveBps: 0, prizeCgShare: 1 },
  { ...BASE, name: 'взнос сжигается как пак, приз из eventsReserve', burnBps: 7500, treasuryBps: 2500, reserveBps: 1000, prizeCgShare: 1 },
  { ...BASE, name: 'гибрид: пул 15 % взноса + 5 % резерва', burnBps: 7500, treasuryBps: 1000, reserveBps: 500, prizeCgShare: 1 },
  { ...BASE, name: 'приз косметикой: 75 % сжигания, $CG только 25 % пула', burnBps: 7500, treasuryBps: 1000, reserveBps: 500, prizeCgShare: 0.25 },
  { ...BASE, name: 'тот же гибрид, но без потолка попыток', burnBps: 7500, treasuryBps: 1000, reserveBps: 500, prizeCgShare: 1, capAttempts: 0 },
  { ...BASE, name: 'тот же гибрид, поле 600 и 40 аккаунтов', burnBps: 7500, treasuryBps: 1000, reserveBps: 500, prizeCgShare: 1, field: 600, cluster: 40 },
  // Рекомендация: приз mainly косметикой, дотация из уже зарезервированной доли
  // событий, взнос сжигается по пак-пути. Значение reserveBps подобрано так, чтобы
  // ценность приза вышла на паритет с паком (A5) при сохранении четырёх якорей.
  { ...BASE, name: 'РЕКОМЕНДАЦИЯ: 75 % сжигания, приз косметикой + 12,6 % резерва', burnBps: 7500, treasuryBps: 1000, reserveBps: 1263, prizeCgShare: 0.25 },
  // Крайности: модель обязана уметь сказать «нет», иначе она ничего не проверяет.
  { ...BASE, name: 'КРАЙНОСТЬ: резерв 300 % бюджета событий', burnBps: 7500, treasuryBps: 0, reserveBps: 30_000, prizeCgShare: 1 },
  { ...BASE, name: 'КРАЙНОСТЬ: пул 99 %, сжигания нет', burnBps: 0, treasuryBps: 100, reserveBps: 0, prizeCgShare: 1 },
  { ...BASE, name: 'КРАЙНОСТЬ: поле 12 кошельков, ферма 6', burnBps: 7500, treasuryBps: 1000, reserveBps: 0, prizeCgShare: 1, field: 12, cluster: 6 },
];

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function main(argv = process.argv.slice(2)) {
  const json = argv.includes('--json');
  const table = buildScoreTable();
  const baseline = dailyFlows(BASELINE_ASSUMPTIONS);
  const header = {
    'пак: ценность на $CG': PACK_VALUE_PER_CG.toFixed(3),
    'пак: EV-мультипликатор': packExpectedValueMult(PACKS.standard).toFixed(3),
    'арена: край на $CG при pWin 0.8': pct(WAGER_EDGE_PER_CG),
    'арена: сжигание на $CG': pct(WAGER_BURN_PER_CG),
    'эмиссия/день (baseline)': `${baseline.emissionCg} $CG`,
    'сжигание/день (baseline)': `${baseline.burnedCg} $CG`,
    'eventsReserve/день': `${Math.round((baseline.emissionCg * EMISSION_SPLIT.eventsReserve) / 100)} $CG`,
    'ставка Cap Slam': `${WAGER.minCgMicro / 1e6}–${WAGER.maxCgMicro / 1e6} $CG`,
  };
  const rows = SCENARIOS.map((s) => {
    const m = simulate(s, table);
    return {
      сценарий: s.name,
      'поле/аккаунтов': `${m.field}+${s.cluster}`,
      'пул/день': `${m.poolPerDayCg.toFixed(0)} $CG`,
      'из резерва': `${m.reservePerDayCg.toFixed(0)} $CG`,
      'выплачено $CG/день': `${m.paidPerDayCg.toFixed(0)} $CG`,
      'сжигание/день': `${m.burnPerDayCg.toFixed(0)} $CG`,
      'медиана на $CG': m.medianReturnPerCg.toFixed(3),
      'про на $CG': m.cohorts[0].returnPerCg.toFixed(3),
      'ферма на $CG': m.clusterReturnPerCg.toFixed(3),
      'топ-1 % пула': pct(m.top1ShareOfPool),
      'топ-10 % пула': pct(m.top10ShareOfPool),
      'Δ эмиссии': `${m.emissionDeltaCg >= 0 ? '+' : ''}${m.emissionDeltaCg.toFixed(0)} $CG`,
      'ценность/ $CG': m.totalValuePerCg.toFixed(3),
      якоря: m.anchors.filter((a) => a.ok).length + '/4',
      стоит: m.appeal.ok ? 'да' : 'нет',
    };
  });

  if (json) { console.log(JSON.stringify({ header, rows, detail: SCENARIOS.map((s) => simulate(s, table)) }, null, 2)); return; }

  console.log('=== якоря (считаны из живых таблиц) ===');
  console.table(header);
  console.log('\n=== сценарии платного входа (docs/16 §5.4) ===');
  console.table(rows);
  for (const s of SCENARIOS) {
    const m = simulate(s, table);
    console.log(`\n${s.name}`);
    console.table(m.cohorts.map((c) => ({ когорта: c.band, взносов: c.entries, 'возврат на $CG': c.returnPerCg.toFixed(3), 'доля пула': pct(c.shareOfPool) })));
    for (const a of m.anchors) console.log(`  ${a.ok ? '✓' : '✗'} ${a.id}: ${a.detail}`);
    console.log(`  ${m.appeal.ok ? '✓' : '✗'} ${m.appeal.id}: ${m.appeal.detail}`);
    console.log(`    добыча лучшей когорты: ${m.bestCohortExtractCgPerDay.toFixed(1)} $CG/день на кошелёк (арена при минимальной ставке: ${m.arenaExtractCgPerDay.toFixed(1)})`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
