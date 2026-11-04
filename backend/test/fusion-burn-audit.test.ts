// Регрессия находки 12: ошибка DAS больше не считается доказательством сжигания.
//
// `dasBurnVerifier` в server.ts ловил `catch { /* gone from DAS → burned */ }` на ЛЮБОЕ исключение —
// таймаут, HTTP 5xx, битый JSON, несовпадение asset id. При недоступном DAS все три материала fusion
// «сгорали», и после оплаты комиссии intent переходил в `paid` без реального burn: результат мог быть
// выпущен из непотраченных материалов.
//
// После исправления доказательством служит только явный факт: индексер уже видел burn
// (`chips.burned_at`), DAS отдал `burnt: true`, либо DAS прямо ответил «ассета нет» (`not_found`).
// Любой другой сбой — `BurnCheckUnavailable` («не проверено»), который маршрут превращает в 503.
import { describe, expect, it } from 'vitest';
import { Db } from '../src/db.ts';
import { DasError } from '../src/das.ts';
import { BurnCheckUnavailable, verifyBurns } from '../src/fusion-burn.ts';

const A = 'A1', B = 'B1', C = 'C1';

function dbWithChips(burned?: string): Db {
  const db = new Db(':memory:');
  for (const a of [A, B, C]) {
    db.run(
      `INSERT INTO chips (asset, owner, collection_idx, rarity, level, flags, lock_until, origin, origin_signature, minted_at, burned_at)
       VALUES (?, 'W', 0, 4, 1, 0, 0, 'pack', 'sig', 0, ?)`, a, a === burned ? 1_800_000_000 : null,
    );
  }
  return db;
}

/** DAS-фейк: по каждому asset отвечает одним из исходов. */
function das(outcomes: Record<string, 'burnt' | 'alive' | 'missing' | 'timeout' | 'http500' | 'garbage'>) {
  return {
    async getAsset(id: string) {
      const o = outcomes[id] ?? 'alive';
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ finding: 12, asset: id, das: o }));
      if (o === 'burnt') return { burnt: true };
      if (o === 'alive') return { burnt: false };
      if (o === 'missing') throw new DasError('not_found', `DAS has no asset ${id}`);
      if (o === 'timeout') throw new DasError('transport', 'DAS getAsset request failed: The operation was aborted due to timeout');
      if (o === 'http500') throw new DasError('transport', 'DAS getAsset returned HTTP 500');
      throw new DasError('schema', 'DAS asset payload is not an object');
    },
  };
}

describe('находка 12: только явный ответ доказывает сжигание', () => {
  it('a DAS outage is not a proof of burn', async () => {
    const db = dbWithChips();
    await expect(verifyBurns(db, [A, B, C], das({ [A]: 'timeout', [B]: 'timeout', [C]: 'timeout' })))
      .rejects.toBeInstanceOf(BurnCheckUnavailable);
    // и ни один материал не считается сожжённым
    expect(db.scalar(`SELECT COUNT(*) FROM chips WHERE burned_at IS NOT NULL`)).toBe(0);
  });

  it('HTTP errors, garbage payloads and mismatches are not proof either', async () => {
    for (const bad of ['http500', 'garbage'] as const) {
      await expect(verifyBurns(dbWithChips(), [A, B, C], das({ [A]: 'burnt', [B]: 'burnt', [C]: bad })))
        .rejects.toBeInstanceOf(BurnCheckUnavailable);
    }
  });

  it('a live asset means "not burned", not "unknown"', async () => {
    expect(await verifyBurns(dbWithChips(), [A, B, C], das({ [A]: 'burnt', [B]: 'alive', [C]: 'burnt' }))).toBe(false);
  });

  it('proofs that do count: an explicit not-found, the burnt flag, and the indexer row', async () => {
    expect(await verifyBurns(dbWithChips(), [A, B, C], das({ [A]: 'missing', [B]: 'burnt', [C]: 'burnt' }))).toBe(true);
    // chips.burned_at уже записан индексером — DAS не спрашиваем вовсе
    const indexed = dbWithChips(A);
    let asked = 0;
    const spy = { async getAsset(id: string) { asked++; return { burnt: false }; } };
    expect(await verifyBurns(indexed, [A], spy)).toBe(true);
    expect(asked).toBe(0);
  });
});
