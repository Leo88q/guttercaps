// Регрессия §1.1: бой, разрешённый в цепи, обязан появиться в `matches` даже если процесс умер
// между отправкой и записью (пп. 40, 41, 61).
//
// `resolveOne` отправлял `resolve_battle` и только потом писал строку `matches`. Любая потеря второго
// шага (рестарт, таймаут подтверждения, ошибка SQLite) оставляла бой разрешённым в цепи и отсутствующим
// в проекции — а следующий проход отказывался его трогать («status 2»), поэтому запись не появлялась
// никогда: ни победителя, ни XP, ни истории для /arena/matches. Теперь интент боя лежит в `chain_ops`,
// и `healResolvedMatches` перепроецирует его из подтверждённой операции без новой транзакции.
import { describe, expect, it } from 'vitest';
import { Db } from '../src/db.ts';
import {
  BATTLE_RESOLVE_KIND, healResolvedMatches, writeResolvedMatch, type ResolvedMatch,
} from '../src/battle-resolver.ts';
import { beginChainOp, recordConfirmed, recordSigned } from '../src/chain-ops.ts';

const sig = 'RESOLVE_SIG_1';

function intent(): ResolvedMatch {
  const chip = (asset: string) => ({ asset, collection: 0, rarity: 0, level: 1, power: 10, traits: [] }) as unknown as ResolvedMatch['squadA'][number];
  return {
    matchId: 'BATTLE1',
    a: 'Challenger1111111111111111111111111111111',
    b: 'Opponent111111111111111111111111111111111',
    squadA: [chip('A1'), chip('A2'), chip('A3')],
    squadB: [chip('B1'), chip('B2'), chip('B3')],
    powerA: 30,
    powerB: 30,
    winner: 'Challenger1111111111111111111111111111111',
    winnerSide: 'A',
    rounds: [{ round: 1, a: 10, b: 9 }],
    seed: 'aa'.repeat(32),
    wager: '0',
    acceptedAt: 1_800_000_000,
  };
}

/** Чипы должны существовать в проекции: XP начисляется только по индексированному ассету. */
function seedChips(db: Db, owner: string, assets: string[]) {
  for (const a of assets) {
    db.run(
      `INSERT INTO chips (asset, owner, collection_idx, rarity, level, flags, lock_until, origin, origin_signature, minted_at)
       VALUES (?, ?, 0, 0, 1, 0, 0, 'pack', 'seed', 0)`, a, owner,
    );
  }
}

describe('ledger разрешённых боёв (§1.1 пп. 40, 41, 61)', () => {
  it('re-projects a resolved battle that was lost between the send and the INSERT', () => {
    const db = new Db(':memory:');
    const p = intent();
    seedChips(db, p.a, p.squadA.map((c) => c.asset));
    seedChips(db, p.b, p.squadB.map((c) => c.asset));
    const op = beginChainOp(db, { kind: BATTLE_RESOLVE_KIND, bizKey: `battle:${p.matchId}`, payload: p });
    recordSigned(db, op.id, { signature: sig, lastValidBlockHeight: 999 });
    recordConfirmed(db, op.id, sig);
    // Процесс умер здесь: подпись в ledger'е есть, строки в `matches` нет.
    expect(db.get(`SELECT 1 FROM matches WHERE id = ?`, p.matchId)).toBeFalsy();

    expect(healResolvedMatches(db)).toBe(1);
    const row = db.get<{ status: string; winner: string; resolve_sig: string; squad_a: string }>(
      `SELECT status, winner, resolve_sig, squad_a FROM matches WHERE id = ?`, p.matchId,
    );
    expect(row?.status).toBe('resolved');
    expect(row?.winner).toBe(p.winner);
    expect(row?.resolve_sig).toBe(sig);
    expect((JSON.parse(row!.squad_a) as { asset: string }[]).map((c) => c.asset)).toEqual(['A1', 'A2', 'A3']);
    // XP победившей дружине, один раз
    expect(db.scalar(`SELECT COUNT(*) FROM chip_xp_awards`)).toBe(3);

    // Повторный проход ничего не дублирует.
    expect(healResolvedMatches(db)).toBe(0);
    expect(db.scalar(`SELECT COUNT(*) FROM chip_xp_awards`)).toBe(3);
    expect(db.scalar(`SELECT COUNT(*) FROM matches`)).toBe(1);
  });

  it('does not invent matches from operations that are not confirmed on chain', () => {
    const db = new Db(':memory:');
    const p = intent();
    const op = beginChainOp(db, { kind: BATTLE_RESOLVE_KIND, bizKey: `battle:${p.matchId}`, payload: p });
    recordSigned(db, op.id, { signature: sig, lastValidBlockHeight: 999 }); // 'signed': судьба неизвестна
    expect(healResolvedMatches(db)).toBe(0);
    expect(db.get(`SELECT 1 FROM matches`)).toBeFalsy();
  });

  it('writeResolvedMatch is idempotent on its own', () => {
    const db = new Db(':memory:');
    const p = intent();
    expect(writeResolvedMatch(db, p, sig)).toBe(true);
    expect(writeResolvedMatch(db, p, sig)).toBe(false);
    expect(db.scalar(`SELECT COUNT(*) FROM matches`)).toBe(1);
  });
});
