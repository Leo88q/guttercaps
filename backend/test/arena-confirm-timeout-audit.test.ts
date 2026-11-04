// Регрессия находки 41: подтверждение с таймаутом ПОСЛЕ исполнения навсегда лишало бой записи и XP.
//
// Сценарий: `resolve_battle` исполнилась в цепи, но `confirmTransaction` её не дождался (reorg/перегрузка
// RPC, «block height exceeded»). `resolveOne` бросал, строки `matches` не появлялось, а следующий проход
// даже не пытался: аккаунт боя в цепи уже `resolved` → он не в `acceptedBattles`, и запись не появлялась
// НИКОГДА — ни победителя, ни истории, ни XP отряда.
//
// Здесь проверяется весь путь целиком, без подмены звеньев: настоящий `resolveOne` → настоящий
// `submitChainOp` (подпись в ledger'е до отправки) → reconcile по подписи → `healResolvedMatches` →
// строка `matches` и XP. Транзакция исполняется один раз и не отправляется заново.
import { describe, expect, it, beforeEach } from 'vitest';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { onChainSquadPower } from '@guttercaps/economy';
import { Db } from '../src/db.ts';
import { ingestTx } from '../src/ingest.ts';
import { arenaConfigPda, BATTLE_RESOLVE_KIND, healResolvedMatches, resolveOne, squadFromDb } from '../src/battle-resolver.ts';
import { findChainOp, reconcileChainOps } from '../src/chain-ops.ts';
import { BATTLE_STATUS, ixDiscriminator } from '../src/chain.ts';
import { encodeArenaConfig, encodeRandomness, encodeWagerBattle, FakeConnection, ARENA_ID, pk } from './chainFixtures.ts';
import { DEFAULT, hex32, kp, tx } from './fixtures.ts';

const b58 = (keys: readonly PublicKey[]) => keys.map((k) => k.toBase58());
/** FakeConnection моделирует RPC частично: статусы подписей подменяются точечно (это и есть сценарий таймаута). */
type SigStatusRpc = { getSignatureStatuses: (sigs: string[], cfg: { searchTransactionHistory: boolean }) => Promise<{ value: ({ confirmationStatus?: string; err: unknown } | null)[] }> };
const rpc = (c: FakeConnection) => c as unknown as SigStatusRpc;
const VRF_VALUE = new Uint8Array(32).fill(0x33);

describe('находка 41: таймаут подтверждения не теряет бой', () => {
  let db: Db;
  let conn: FakeConnection;
  const oracle = Keypair.generate();
  const alice = kp(), bob = kp();
  const battleKey = pk(), rndKey = pk(), cgMint = pk();
  const A = [pk(), pk(), pk()], B = [pk(), pk(), pk()];

  beforeEach(() => {
    db = new Db(':memory:');
    conn = new FakeConnection();
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

  const deps = () => ({ connection: conn as unknown as Connection, db, oracle, log: () => {} });

  it('исполненная, но неподтверждённая транзакция доводится по реестру операций: бой, победитель и XP появляются', async () => {
    // подтверждение не приходит: RPC отвечает ошибкой на подтверждение и не знает статуса подписи
    conn.confirmTransaction = async () => { throw new Error('block height exceeded'); };
    rpc(conn).getSignatureStatuses = async () => ({ value: [null] });
    await expect(resolveOne(deps(), battleKey)).rejects.toThrow();
    // «нет ответа» → та же ПОДПИСАННАЯ транзакция отправляется повторно: подпись одна, второго исполнения
    // быть не может (§1.1 п. 61), поэтому считаем именно уникальные подписи
    const disc = Buffer.from(ixDiscriminator('resolve_battle')).toString('hex');
    const sentSigs = conn.sent.filter((s) => s.ixs.some((i) => Buffer.from(i.data.subarray(0, 8)).toString('hex') === disc)).map((s) => s.signature);
    expect(sentSigs.length).toBeGreaterThan(0);
    expect(new Set(sentSigs).size).toBe(1);
    // записи ещё нет, но операция известна и её подпись сохранена до отправки
    expect(db.get(`SELECT 1 FROM matches WHERE id = ?`, battleKey.toBase58())).toBeFalsy();
    const op = findChainOp(db, BATTLE_RESOLVE_KIND, `battle:${battleKey.toBase58()}`)!;
    expect(op.signature).toBeTruthy();
    expect(['signed', 'sent', 'landed']).toContain(op.status);

    // цепь подтверждает подпись — reconcile доводит операцию
    rpc(conn).getSignatureStatuses = async (sigs: string[]) => ({ value: sigs.map(() => ({ confirmationStatus: 'confirmed', err: null })) });
    expect(await reconcileChainOps(db, conn as unknown as Connection, { tip: 10_000 })).toMatchObject({ confirmed: 1 });

    // ...а heal перепроецирует бой без новой транзакции
    expect(healResolvedMatches(db)).toBe(1);
    const row = db.get<{ status: string; winner: string; resolve_sig: string }>(`SELECT status, winner, resolve_sig FROM matches WHERE id = ?`, battleKey.toBase58())!;
    expect(row.status).toBe('resolved');
    expect([alice, bob]).toContain(row.winner);
    expect(row.resolve_sig).toBe(op.signature);
    expect(db.scalar(`SELECT COUNT(*) FROM chip_xp_awards`)).toBe(3); // XP победившей дружине, один раз
    expect(healResolvedMatches(db)).toBe(0);                          // идемпотентно
    expect(db.scalar(`SELECT COUNT(*) FROM matches`)).toBe(1);
    // после подтверждения — ни одной новой подписи: heal не отправляет транзакций
    expect(new Set(conn.sent.map((s) => s.signature)).size).toBe(1);
  });
});
