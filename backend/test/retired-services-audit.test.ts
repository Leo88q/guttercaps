// Reproducer: the "the Line is retired" guards could never fire.
//
// backend/src/runs.ts (extra run) and backend/src/tournament.ts (tournament entry) did:
//     const svc = SERVICE_BY_ID.lineExtraRun as ... | undefined;
//     if (!svc) throw new ServiceError(410, 'line_retired', ...);
// but `SERVICE_BY_ID` is built from every entry of `SERVICES` (packages/economy/src/services.ts),
// retired ones included — only the /services *listing* filtered `retired` out. So `svc` was always
// defined, the purchase path stayed open, and a client that still had the old bundle could burn
// 30 $CG on a mode the product removed.
//
// Исправлено (находка 63, решение владельца 2026-11-03 — довести снятие): денежные пути спрашивают
// `isPurchasable` (флаг `retired`), а не наличие записи в таблице; витрина строится из
// `ACTIVE_SERVICES`; покупка доп. заезда и входа в турнир отвечает 410 `line_retired`. Записи в
// `SERVICE_BY_ID`/`SERVICE_BY_KIND` остаются — по ним читается история платежей и entitlement'ов,
// а выданные ранее кредиты доигрываются.
import { describe, expect, it } from 'vitest';
import { ACTIVE_SERVICES, SERVICE_BY_ID, SERVICES, isPurchasable } from '@guttercaps/economy';
import { Db } from '../src/db.ts';
import { ServiceError, catalogue, claimService } from '../src/services.ts';
import { buyExtraRun } from '../src/runs.ts';
import { enterTournament } from '../src/tournament.ts';
import { dayIndex } from '../src/quests.ts';

const WALLET = 'So11111111111111111111111111111111111111112';
const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';
const T = 1_800_000_000;
const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { return (e as ServiceError).code; }
  throw new Error('ожидалась ошибка');
};

describe('retired services', () => {
  it('a retired service is not purchasable and is not in the shop window', () => {
    const retired = SERVICES.filter((s) => s.retired);
    expect(retired.length).toBeGreaterThan(0);
    for (const s of retired) {
      expect(isPurchasable(s)).toBe(false);
      // история по снятой услуге по-прежнему читается
      expect((SERVICE_BY_ID as Record<string, unknown>)[s.id]).toBeDefined();
    }
    for (const s of ACTIVE_SERVICES) expect(isPurchasable(s)).toBe(true);
    const db = new Db(':memory:');
    const shown = catalogue(db).services.map((s) => s.id);
    for (const s of retired) expect(shown).not.toContain(s.id);
    expect(shown.length).toBe(ACTIVE_SERVICES.length);
  });

  it('every money path refuses a retired service with 410 line_retired', () => {
    const db = new Db(':memory:');
    const day = dayIndex(T);
    expect(code(() => buyExtraRun(db, WALLET, { day, signature: SIG }, T))).toBe('line_retired');
    expect(code(() => enterTournament(db, WALLET, { day, signature: SIG }, T))).toBe('line_retired');
    for (const s of SERVICES.filter((x) => x.retired)) {
      expect(code(() => claimService(db, WALLET, SIG, s.kind, {}))).toBe('line_retired');
    }
    // деньги не тронуты: ни кредитов, ни входов
    expect(db.scalar(`SELECT COUNT(*) FROM line_credits`)).toBe(0);
    expect(db.scalar(`SELECT COUNT(*) FROM line_tournament_entries`)).toBe(0);
  });

  it('active services still resolve (control)', () => {
    const db = new Db(':memory:');
    expect(code(() => claimService(db, WALLET, SIG, 999, {}))).toBe('unknown_kind');
    expect(isPurchasable(SERVICE_BY_ID.capSkin)).toBe(true);
  });
});
