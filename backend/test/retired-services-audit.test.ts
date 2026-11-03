// Reproducer: the "the Line is retired" guards can never fire.
//
// backend/src/runs.ts:266-267 (extra run) and backend/src/tournament.ts:60-62 (tournament entry) do:
//     const svc = SERVICE_BY_ID.lineExtraRun as ... | undefined;
//     if (!svc) throw new ServiceError(410, 'line_retired', ...);
// but `SERVICE_BY_ID` is built from every entry of `SERVICES` (packages/economy/src/services.ts:94),
// retired ones included — only the /services *listing* filters `retired` out (backend/src/services.ts:67).
// So `svc` is always defined, the purchase path stays open, and a client that still has the old bundle can
// burn 30 $CG on a mode the product removed (submitRun has no retirement check either).
import { describe, expect, it } from 'vitest';
import { SERVICE_BY_ID, SERVICES } from '@guttercaps/economy';

describe('retired services', () => {
  // П. 63 (R3) — ещё не исправлено: снятые с продажи услуги по-прежнему покупаются (нужно решение
  // владельца: довести снятие до конца и переписать runs/tournament-тесты или вернуть услугу в продажу).
  it.fails('a retired service must not be resolvable as purchasable', () => {
    const retired = SERVICES.filter((s) => s.retired).map((s) => ({ id: s.id, kind: s.kind }));
    const stillResolvable = retired.filter((r) => (SERVICE_BY_ID as Record<string, unknown>)[r.id] !== undefined);
    const listedPublicly = SERVICES.filter((s) => !s.retired).map((s) => s.id);
    console.log(JSON.stringify({ retired, stillResolvable, listedPublicly }));
    // the guards in runs.ts / tournament.ts rely on this being empty
    expect(stillResolvable).toEqual([]);
  });
});
