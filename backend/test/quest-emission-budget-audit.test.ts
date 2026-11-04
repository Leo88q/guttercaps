// Находка 48: квестовая доля эмиссии была меньше типовых обязательств, а очередь наград не делилась по
// бюджету. Решение владельца — вариант Б: поднять долю (а не вводить отложенную очередь).
//
// Расчёт (по константам кода, без допущений):
//   play-бакет         = 1 млрд × 55 %            = 550 000 000 $CG
//   год 1 (18 %/год)   = 99 000 000 $CG/год       = 271 232.9 $CG/день
//   квесты при 25 %    = 67 808.2 $CG/день  ← было, меньше нормы на базовых 5 000 DAU
//   квесты при 30 %    = 81 369.9 $CG/день  ← стало
//   норма 5 000 DAU × 15 $CG = 75 000 $CG/день  → укладывается (запас 8.4 %)
//
// Цепь при этом fail-closed: `staking::publish_root` требует `budget <= slice_budget[k]` и списывает
// бюджет, поэтому «переплатить из воздуха» нельзя — при переполнении очередь просто не публикуется.
// Тест держит оба факта, чтобы доля не вернулась к дефицитной незаметно.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ANTI_FARM, EMISSION_GUARD, EMISSION_SPLIT, dailyEmission, playBucketTokens,
} from '@guttercaps/economy';

const CG = 1_000_000; // микро-$CG в $CG
/** Базовая численность из экономической модели (`BASELINE_ASSUMPTIONS.dau`). */
const BASE_DAU = 5_000;
/** Типовой дневной заработок квестов на игрока (потолок `ANTI_FARM` — 25 $CG, это не норма). */
const TYPICAL_DAILY_QUEST_CG = 15;

const questSliceCg = (year = 0) => (dailyEmission(year) * EMISSION_SPLIT.quests) / 100;
const floorSliceCg = (year = 0) => (dailyEmission(year) * EMISSION_GUARD.floorShare * EMISSION_SPLIT.quests) / 100;

describe('квестовая доля эмиссии против обязательств (находка 48)', () => {
  it('сплит по-прежнему суммируется в 100 %', () => {
    const pct = Object.values(EMISSION_SPLIT).reduce((a, b) => a + b, 0);
    expect(pct).toBe(100);
  });

  it('норма на базовых DAU укладывается в квестовый срез года 1', () => {
    const obligation = BASE_DAU * TYPICAL_DAILY_QUEST_CG;
    const slice = questSliceCg(0);
    expect(slice).toBeGreaterThan(obligation);
    // и прежняя доля (25 %) действительно не укладывалась — то есть находка была не теоретической
    expect((slice * 25) / EMISSION_SPLIT.quests).toBeLessThan(obligation);
  });

  it('срез считается от play-бакета, а не от всего кап-саплая', () => {
    expect(playBucketTokens()).toBe(550_000_000);
    expect(Math.round(questSliceCg(0))).toBe(81_370); // 271 232.9 × 30 %
  });

  it('потолок на кошелёк выше подушевого бюджета — это зафиксированный остаток, а не тихая переплата', () => {
    const perWallet = questSliceCg(0) / BASE_DAU;
    expect(ANTI_FARM.dailyQuestRewardCapCgMicro / CG).toBeGreaterThan(perWallet);
    // значит при «все по потолку» обязательства выше среза — и это ловится цепью, а не кошельком программы
    const worstCase = BASE_DAU * (ANTI_FARM.dailyQuestRewardCapCgMicro / CG);
    expect(worstCase).toBeGreaterThan(questSliceCg(0));
  });

  it('на полу гарда бюджет сжимается по определению, и это записано числом', () => {
    expect(Math.round(floorSliceCg(0))).toBe(1_627); // 5 424.7 × 30 %
  });

  it('цепь отказывает в публикации сверх бюджета, а не платит из резерва', () => {
    const emission = readFileSync(new URL('../../programs/staking/src/instructions/emission.rs', import.meta.url), 'utf8');
    expect(emission).toMatch(/require!\(budget <= e\.slice_budget\[k\], StakeError::BudgetExceeded\)/);
  });

  it('дефолтный сплит на цепи совпадает с пакетом (тестовый фикстур staking)', () => {
    const staking = readFileSync(new URL('../../programs/staking/src/lib.rs', import.meta.url), 'utf8');
    // в файле есть и сигнатура `set_split(split_bps: [u16; SPLIT_COUNT])`, поэтому ищем числовой литерал
    const m = /split_bps: \[([\d,\s]+)\]/.exec(staking);
    expect(m).not.toBeNull();
    const rs = m![1]!.split(',').map((x) => Number(x.trim()));
    expect(rs).toEqual([
      EMISSION_SPLIT.chipStaking, EMISSION_SPLIT.tokenStaking, EMISSION_SPLIT.quests, EMISSION_SPLIT.pvpSeason, EMISSION_SPLIT.eventsReserve,
    ].map((p) => p * 100));
  });
});
