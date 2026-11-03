// Регрессия находки 40: путь предохранителя по дневному лимиту оракула записывался как «бой проведён».
//
// `resolve_battle` при `oracle_paid_today + pot > oracle_daily_cap` НЕ проводит бой: ставит `paused = true`,
// эмитит `ArenaAutoPaused` и возвращает `Ok(())`, оставляя бой в `Accepted`
// (programs/arena/src/lib.rs: «an unsuccessful tx cannot persist paused = true … leave the battle Accepted
// so cancel_stale_battle can refund both sides»).
//
// Резолвер смотрел только на то, что транзакция исполнилась (`submitChainOp` → подпись), и сразу писал
// строку `matches` со статусом `resolved`: начислялся XP отряда (`grantSquadXp`), бой попадал в статистику
// и ладдер, победитель получал запись о выигрыше — при том что ни один $CG не сдвинулся, а ставки остались
// в эскроу. Теперь успех транзакции не считается доказательством: события транзакции разбираются, и
// `ArenaAutoPaused` означает «бой не проведён» — запись не создаётся, а операция помечается неуспешной,
// чтобы повтор ушёл после снятия паузы (пока арена на паузе, резолвер и сам ничего не отправляет).
import { describe, expect, it, beforeEach } from 'vitest';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { onChainSquadPower } from '@guttercaps/economy';
import { Db } from '../src/db.ts';
import { ingestTx } from '../src/ingest.ts';
import { fakeLogs } from '../src/events.ts';
import { arenaConfigPda, BATTLE_RESOLVE_KIND, resolveOne, squadFromDb } from '../src/battle-resolver.ts';
import { findChainOp } from '../src/chain-ops.ts';
import { BATTLE_STATUS, ixDiscriminator } from '../src/chain.ts';
import { encodeArenaConfig, encodeRandomness, encodeWagerBattle, FakeConnection, ARENA_ID, pk } from './chainFixtures.ts';
import { DEFAULT, hex32, kp, tx } from './fixtures.ts';

const asConn = (c: FakeConnection) => c as unknown as Connection;
const b58 = (keys: readonly PublicKey[]) => keys.map((k) => k.toBase58());
const VRF_VALUE = new Uint8Array(32).fill(0x33);

/** Логи успешной транзакции, в которой предохранитель по дневному лимиту оракула отменил проведение боя. */
const breakerLogs = () => fakeLogs([{ program: 'arena', name: 'ArenaAutoPaused', data: { by: pk(), oraclePaidToday: '900000000', oracleDailyCap: '1000000000' } }]);

describe('находка 40: предохранитель оракула не считается проведённым боем', () => {
  let db: Db;
  let conn: FakeConnection;
  let logs: string[];
  const oracle = Keypair.generate();
  const alice = kp(), bob = kp();
  const battleKey = pk(), rndKey = pk(), cgMint = pk();
  const A = [pk(), pk(), pk()], B = [pk(), pk(), pk()];

  beforeEach(() => {
    db = new Db(':memory:');
    conn = new FakeConnection();
    logs = [];
    ingestTx(tx([{ program: 'chip_core', name: 'PackOpened', data: { buyer: alice, sku: 1, nonce: '1', assets: [...b58(A), DEFAULT, DEFAULT], rarities: [0, 1, 2, 0, 0], collections: [3, 4, 5, 0, 0], count: 3, roll: hex32(0x5a), pityBefore: 0, pityAfter: 1 } }]), db);
    ingestTx(tx([{ program: 'chip_core', name: 'PackOpened', data: { buyer: bob, sku: 1, nonce: '2', assets: [...b58(B), DEFAULT, DEFAULT], rarities: [0, 1, 2, 0, 0], collections: [3, 4, 5, 0, 0], count: 3, roll: hex32(0x5b), pityBefore: 0, pityAfter: 1 } }]), db);
    const squadA = squadFromDb(db, A), squadB = squadFromDb(db, B);
    conn.set(battleKey, encodeWagerBattle({
      challenger: new PublicKey(alice), opponent: new PublicKey(bob), randomness: rndKey, commitSlot: 42n, status: BATTLE_STATUS.ACCEPTED, nonce: 7n,
      squadA: A, squadB: B, powerA: squadA ? onChainSquadPower(squadA) : 0, powerB: squadB ? onChainSquadPower(squadB) : 0,
    }), ARENA_ID);
    conn.set(rndKey, encodeRandomness({ authority: oracle.publicKey, queue: pk(), oracle: pk(), seedSlot: 42n, revealSlot: 50n, value: VRF_VALUE }), pk());
    conn.set(arenaConfigPda()[0], encodeArenaConfig({ admin: pk(), battleOracle: oracle.publicKey, cgMint, seasonPool: pk(), treasuryCg: pk() }), ARENA_ID);
  });

  const deps = () => ({ connection: asConn(conn), db, oracle, log: (s: string) => logs.push(s) });
  /** Подменить логи транзакции так, как их вернул бы RPC (meta.logMessages). */
  const withLogs = (lines: string[]) => {
    const orig = conn.getTransaction.bind(conn);
    (conn as unknown as { getTransaction: (s: string) => Promise<unknown> }).getTransaction = async (sig: string) => {
      const r = (await orig(sig)) as { slot: number; meta: { logMessages: string[] } };
      return { ...r, meta: { ...r.meta, logMessages: lines } };
    };
    return () => { (conn as unknown as { getTransaction: unknown }).getTransaction = orig; };
  };

  it('бой не записывается как проведённый: нет `matches`, нет XP, операция помечена неуспешной', async () => {
    const restore = withLogs(breakerLogs());
    const out = await resolveOne(deps(), battleKey);
    restore();
    expect(out).toMatchObject({ kind: 'skipped', reason: expect.stringContaining('daily cap') });
    // главное: бой не попал в проекцию как resolved (значит не начислен XP и не пошли очки ладдера)
    expect(db.get(`SELECT id FROM matches WHERE id = ?`, battleKey.toBase58())).toBeUndefined();
    expect(db.scalar(`SELECT COUNT(*) FROM matches`)).toBe(0);
    // транзакция ушла, но операция не считается выполненной — иначе следующий проход «переиспользовал» бы подпись
    const op = findChainOp(db, BATTLE_RESOLVE_KIND, `battle:${battleKey.toBase58()}`)!;
    expect(op.status).toBe('failed');
    expect(op.error).toMatch(/daily cap/);
    expect(logs.some((l) => l.includes('ALERT') && l.includes('NOT resolved'))).toBe(true);
    // ровно одна попытка отправки
    const disc = Buffer.from(ixDiscriminator('resolve_battle')).toString('hex');
    expect(conn.sent.filter((s) => s.ixs.some((i) => Buffer.from(i.data.subarray(0, 8)).toString('hex') === disc))).toHaveLength(1);
  });

  it('после снятия паузы повтор действительно проводит бой и записывает его один раз', async () => {
    const restore = withLogs(breakerLogs());
    expect((await resolveOne(deps(), battleKey)).kind).toBe('skipped');
    restore();
    const out = await resolveOne(deps(), battleKey);
    expect(out.kind).toBe('resolved');
    const row = db.get<{ status: string; winner: string }>(`SELECT status, winner FROM matches WHERE id = ?`, battleKey.toBase58());
    expect(row?.status).toBe('resolved');
    expect([alice, bob]).toContain(row!.winner);
    expect(findChainOp(db, BATTLE_RESOLVE_KIND, `battle:${battleKey.toBase58()}`)!.error ?? '').not.toMatch(/daily cap/);
    // третий проход ничего не добавляет (бой уже resolved на цепи и в проекции)
    expect(db.scalar(`SELECT COUNT(*) FROM matches`)).toBe(1);
  });
});
