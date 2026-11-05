// Battle resolver — the arena program's `battle_oracle` (docs/02 §4.6 on-chain column).
//
// A wager battle is escrowed on chain (`create_battle` → `accept_battle`); the crank reveals the
// battle's Switchboard randomness; THIS keeper then runs the same fight engine as ranked matches
// with the on-chain VRF value as the seed and settles by `resolve_battle(winner, result_hash)`:
//   roll(lane, side) = u32le(sha256(value ‖ lane ‖ side)) / 2^32          (value = revealed VRF, 32 bytes)
//   result_hash      = sha256(canonical JSON of the round list)             (pinned on chain for audits)
// The program re-checks the winner ∈ {challenger, opponent}, the winner's ATA owner, the revealed
// value (auditable seed), the daily oracle cap, and splits the rake 40/40/20 itself — the oracle key
// cannot move a lamport outside a battle's own escrow.
//
// Squads: `WagerBattle.squad_a/b` are asset keys; the fight needs (collection, rarity, level), read
// from the `chips` projection (indexed at mint / fuse). Unknown assets → skip and retry later (the
// indexer may be behind); after RESOLVE_TIMEOUT (30 min) either side can `cancel_stale_battle`.
//
// SEC-B30: the battle also commits `power_a/b` — the power the program computed from the chip state at
// accept time (arena::validate_squad). The fight below is recomputed from the *current* rows, and nothing on
// chain flags a chip that sits in an accepted battle, so a player could level a squad chip up by fusion
// after the opponent matched and fight stronger than the power that was matched. Both squads must therefore
// reproduce the recorded power (and no squad chip may have been consumed by a fusion) before the fight is
// allowed to decide who gets the pot; a mismatch skips — the battle can then be cancelled, which refunds
// both wagers — instead of settling on a squad nobody agreed to.
import { createHash } from 'node:crypto';
import { Connection, Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { onChainSquadPower, resolveFight, type FighterChip, type FightRound } from '@guttercaps/economy';
import { db as sharedDb, now, type Db } from './db.ts';
import { grantSquadXp } from './chip-xp.ts';
import { BorshWriter } from './borsh.ts';
import { PROGRAMS } from './config.ts';
import {
  ARENA_ID, BATTLE_STATUS, TOKEN_PROGRAM_ID, ata, battlePda, decodeRandomness, decodeWagerBattle, ixData, ro, rw, signer, type WagerBattle,
} from './chain.ts';
import { getConnection, sleep } from './ingest.ts';
import { loadKeypair } from './crank.ts';
import { sendAndConfirm } from './tx.ts';
import type { ChipRow } from './queries.ts';
import { insertIgnore } from './sql.ts';
import { ChainOpInFlight, findChainOp, opPayload, recordFailedByKey, submitChainOp } from './chain-ops.ts';
import { decodeLogs } from './events.ts';

const env = process.env;
export const BATTLE_ORACLE_KEYPAIR = env.BATTLE_ORACLE_KEYPAIR ?? '';
export const BATTLE_RESOLVER_POLL_MS = Number(env.BATTLE_RESOLVER_POLL_MS ?? 5_000);
export const CU_RESOLVE_BATTLE = 120_000;

import { arenaConfigPda, decodeArenaConfig } from './arena-config.ts';
export { arenaConfigPda, decodeArenaConfig, type ArenaConfig } from './arena-config.ts';

const sha256 = (...parts: (Uint8Array | string)[]) => { const h = createHash('sha256'); for (const p of parts) h.update(p); return h.digest(); };

/** Deterministic roll from the revealed VRF value — identical for anyone re-running the fight. */
export const rollFromValue = (value: Uint8Array) => (lane: number, side: 0 | 1): number => sha256(value, Uint8Array.of(lane, side)).readUInt32LE(0) / 2 ** 32;

/** Canonical result hash: sha256 of the rounds JSON with sorted keys (stable across runtimes). */
export function resultHash(rounds: readonly FightRound[]): Buffer {
  const canon = rounds.map((r) => ({ attacker: r.attacker, defender: r.defender, effA: r.effA, effB: r.effB, elementEdge: r.elementEdge, lane: r.lane, luckA: r.luckA, luckB: r.luckB, winner: r.winner }));
  return sha256(JSON.stringify(canon));
}

/** `resolve_battle(winner: Pubkey, result_hash: [u8; 32])` account list — mirrors programs/arena `ResolveBattle`. */
export function resolveBattleIx(a: { oracle: PublicKey; challenger: PublicKey; nonce: bigint; randomness: PublicKey; cgMint: PublicKey; winner: PublicKey; seasonPool: PublicKey; treasuryCg: PublicKey; resultHash: Uint8Array }): TransactionInstruction {
  const [battle] = battlePda(a.challenger, a.nonce);
  return new TransactionInstruction({
    programId: ARENA_ID,
    keys: [
      signer(a.oracle, true), rw(arenaConfigPda()[0]), rw(battle), ro(a.randomness), rw(a.cgMint), rw(ata(a.cgMint, battle)),
      rw(ata(a.cgMint, a.winner)), rw(a.seasonPool), rw(a.treasuryCg), rw(a.challenger), ro(TOKEN_PROGRAM_ID),
    ],
    data: ixData('resolve_battle', new BorshWriter().pubkey(a.winner).bytes(a.resultHash).toBytes()),
  });
}


/**
 * On-chain `claim.level` until merkle `level_up` ships. Ranked XP writes `chips.level` and must not
 * feed this fight: after one Cap Slam win the projection is lv 2+, while `create_battle` /
 * `accept_battle` still hashed mint-1 power. Using the ranked level here trips SEC-B30 forever
 * (skip → cancel_stale). Fusion still burns the asset, which returns `undefined` below.
 */
const WAGER_ON_CHAIN_LEVEL = 1;

export function squadFromDb(db: Db, assets: readonly PublicKey[]): FighterChip[] | undefined {
  const out: FighterChip[] = [];
  for (const a of assets) {
    // SEC-B30: an asset consumed by a fusion is not a chip any more — its row is a tombstone for the audit
    // trail, not an input for a fight that decides the pot.
    const r = db.get<ChipRow>(`SELECT * FROM chips WHERE asset = ? AND burned_at IS NULL`, a.toBase58());
    if (!r) return undefined;
    out.push({ asset: r.asset, collection: r.collection_idx, rarity: r.rarity, level: WAGER_ON_CHAIN_LEVEL });
  }
  return out;
}

export interface ResolverDeps { connection: Connection; db: Db; oracle: Keypair; log?: (s: string) => void }
export type ResolveOutcome = { kind: 'resolved'; signature: string; winner: string } | { kind: 'skipped'; reason: string };

/** Resolve one accepted battle if its randomness is revealed and both squads are known. */
export async function resolveOne(d: ResolverDeps, battleKey: PublicKey): Promise<ResolveOutcome> {
  const info = await d.connection.getAccountInfo(battleKey);
  if (!info) return { kind: 'skipped', reason: 'battle account missing' };
  const b: WagerBattle = decodeWagerBattle(new Uint8Array(info.data));
  if (b.status !== BATTLE_STATUS.ACCEPTED) return { kind: 'skipped', reason: `status ${b.status}` };
  const rndInfo = await d.connection.getAccountInfo(b.randomness);
  if (!rndInfo) return { kind: 'skipped', reason: 'randomness account missing' };
  const rnd = decodeRandomness(new Uint8Array(rndInfo.data));
  if (rnd.seedSlot !== b.commitSlot || rnd.revealSlot === 0n) return { kind: 'skipped', reason: 'randomness not revealed yet' };
  const squadA = squadFromDb(d.db, b.squadA), squadB = squadFromDb(d.db, b.squadB);
  if (!squadA || !squadB) return { kind: 'skipped', reason: 'squad chips not indexed yet (or one was fused away since acceptance)' };
  // SEC-B30: the fight must be computed from the squad the opponent matched. `accept_battle` verified the
  // squads only against the power recorded in the battle account, and chip_core flags nothing while a chip
  // sits in an accepted battle — so a fusion after acceptance could raise a level (and never lower one).
  // Reproducing the recorded power is what makes the recomputed fight the committed one; a mismatch is a
  // refusal, not a guess, and `cancel_stale_battle` refunds both sides after RESOLVE_TIMEOUT.
  const powerA = onChainSquadPower(squadA), powerB = onChainSquadPower(squadB);
  if (powerA !== b.powerA || powerB !== b.powerB) {
    d.log?.(`[battle-resolver] ALERT ${battleKey.toBase58()} squad power ${powerA}/${powerB} does not match the recorded ${b.powerA}/${b.powerB} — refusing to resolve (a squad chip changed after acceptance); either side can cancel_stale_battle after RESOLVE_TIMEOUT`);
    return { kind: 'skipped', reason: `squad power ${powerA}/${powerB} does not match the recorded ${b.powerA}/${b.powerB}` };
  }
  const cfgInfo = await d.connection.getAccountInfo(arenaConfigPda()[0]);
  if (!cfgInfo) return { kind: 'skipped', reason: 'arena config missing' };
  const cfg = decodeArenaConfig(new Uint8Array(cfgInfo.data));
  if (!cfg.battleOracle.equals(d.oracle.publicKey)) return { kind: 'skipped', reason: `battle_oracle is ${cfg.battleOracle.toBase58()}, not this key` };
  if (cfg.paused) return { kind: 'skipped', reason: 'arena paused' };

  const fight = resolveFight(squadA, squadB, rollFromValue(rnd.value));
  const winner = fight.winner === 'A' ? b.challenger : b.opponent;
  const hash = resultHash(fight.rounds);
  const ix = resolveBattleIx({ oracle: d.oracle.publicKey, challenger: b.challenger, nonce: b.nonce, randomness: b.randomness, cgMint: cfg.cgMint, winner, seasonPool: cfg.seasonPool, treasuryCg: cfg.treasuryCg, resultHash: hash });
  // §1.1: бой разрешается ровно одной операцией. Раньше «нет ответа» после send оставляло бой
  // разрешённым в цепи и отсутствующим в `matches`: аккаунт уже `resolved`, следующий проход
  // отказывался («status 2»), и запись не появлялась никогда (пп. 40, 41, 61).
  const matchId = battleKey.toBase58();
  const payload: ResolvedMatch = {
    matchId,
    a: b.challenger.toBase58(),
    b: b.opponent.toBase58(),
    // полные бойцы, а не адреса: `matches.squad_a` — это вход для повтора боя и для XP, и он должен
    // совпадать с тем, что уходило в цепь (`onChainSquadPower` по тем же уровням)
    squadA,
    squadB,
    powerA: b.powerA,
    powerB: b.powerB,
    winner: winner.toBase58(),
    winnerSide: fight.winner,
    rounds: fight.rounds,
    seed: Buffer.from(rnd.value).toString('hex'),
    wager: b.wager.toString(),
    acceptedAt: Number(b.acceptedAt),
  };
  let txLogs: string[] = [];
  const r = await submitChainOp(
    d.db,
    { kind: BATTLE_RESOLVE_KIND, bizKey: `battle:${matchId}`, payload },
    async (hooks) => {
      const { signature, logs } = await sendAndConfirm(d.connection, d.oracle, [ix], {
        cuLimit: CU_RESOLVE_BATTLE,
        onSigned: (signature, extra) => hooks.beforeSend(signature, { rawTx: extra.rawTx, lastValidBlockHeight: extra.lastValidBlockHeight, cuPrice: extra.cuPrice }),
      });
      txLogs = logs;
      return { signature };
    },
  );
  const signature = r.signature;
  // Находка 40: предохранитель по дневному лимиту оракула — УСПЕШНАЯ транзакция, которая бой НЕ проводит.
  // `resolve_battle` при `oracle_paid_today + pot > oracle_daily_cap` ставит `paused = true`, эмитит
  // `ArenaAutoPaused` и возвращает `Ok(())`, оставляя бой в `Accepted` (так и задумано: откат не смог бы
  // сохранить паузу, а `cancel_stale_battle` вернёт ставки). Раньше этот путь не отличался от настоящего
  // разрешения: бой попадал в `matches` как `resolved`, начислялся XP отряда и очки ладдера, а награды
  // никто не получал. Теперь успех транзакции — не доказательство: смотрим её события и, если сработал
  // предохранитель, бой не записываем, а операцию помечаем неуспешной, чтобы она повторилась после
  // снятия паузы (пока арена на паузе, `resolveOne` и так ничего не отправляет).
  const breaker = decodeLogs(txLogs).find((e) => e.program === 'arena' && e.name === 'ArenaAutoPaused');
  if (breaker) {
    recordFailedByKey(d.db, BATTLE_RESOLVE_KIND, `battle:${matchId}`,
      `arena oracle daily cap reached (paid_today ${String(breaker.data.oraclePaidToday)} of ${String(breaker.data.oracleDailyCap)}): battle left Accepted, awaiting cancel_stale_battle or the next day`);
    d.log?.(`[battle-resolver] ALERT ${matchId} NOT resolved: arena oracle daily cap reached — battle stays Accepted, nothing recorded; will retry after the pause is lifted`);
    return { kind: 'skipped', reason: 'arena oracle daily cap reached (ArenaAutoPaused) — battle left unsettled' };
  }
  writeResolvedMatch(d.db, payload, signature);
  d.log?.(`[battle-resolver] resolve_battle ${matchId} winner ${winner.toBase58()} → ${signature}${r.reused ? ' (already confirmed earlier)' : ''}`);
  return { kind: 'resolved', signature, winner: winner.toBase58() };
}

export const BATTLE_RESOLVE_KIND = 'battle_resolve' as const;

/** Всё, что нужно, чтобы записать `matches` без повторной отправки (payload операции в `chain_ops`). */
export interface ResolvedMatch {
  matchId: string;
  a: string;
  b: string;
  squadA: FighterChip[];
  squadB: FighterChip[];
  powerA: number;
  powerB: number;
  winner: string;
  winnerSide: 'A' | 'B' | 'draw';
  rounds: unknown;
  seed: string;
  wager: string;
  acceptedAt: number;
}

/**
 * Записать разрешённый бой в проекцию. Идемпотентно (`insertIgnore` по `matchId`) и вызывается как из
 * пути «только что отправили», так и из пути «операция уже подтверждена» — поэтому падение процесса
 * между send и INSERT больше не теряет бой.
 */
export function writeResolvedMatch(db: Db, p: ResolvedMatch, signature: string): boolean {
  const inserted = Number(db.run(
    // every value is a parameter now (the literals were inline in the VALUES list): same row, and the
    // statement shape is what `sql.ts` guarantees across dialects
    insertIgnore('matches', ['id', 'season', 'a', 'b', 'squad_a', 'squad_b', 'power_a', 'power_b', 'league', 'commit_a', 'commit_b', 'nonce_a', 'nonce_b', 'seed', 'rounds', 'winner', 'wager', 'battle_pda', 'resolve_sig', 'status', 'started_at', 'ended_at', 'rewarded']),
    p.matchId, 0, p.a, p.b, JSON.stringify(p.squadA), JSON.stringify(p.squadB), p.powerA, p.powerB, leagueOfPower(p.powerA),
    '', '', '', '', p.seed, JSON.stringify(p.rounds), p.winner, p.wager, p.matchId, signature, 'resolved',
    p.acceptedAt * 1000, Date.now(), 0,
  ).changes);
  // first insert only: ranked-style chip XP (indexer-authoritative). claim.level stays mint 1.
  if (inserted > 0) {
    const t = now();
    grantSquadXp(db, JSON.stringify(p.squadA), p.winnerSide === 'A', t, p.a, p.matchId);
    grantSquadXp(db, JSON.stringify(p.squadB), p.winnerSide === 'B', t, p.b, p.matchId);
  }
  return inserted > 0;
}

/**
 * Догнать бои, разрешённые на цепи, но не записанные в `matches` (падение между send и записью).
 * Смотрит только подтверждённые операции ledger'а, поэтому не может создать запись о бое,
 * которого нет в цепи. Возвращает число восстановленных записей.
 */
export function healResolvedMatches(db: Db): number {
  let healed = 0;
  for (const op of db.all<{ signature: string | null; payload: string | null }>(
    `SELECT signature, payload FROM chain_ops WHERE kind = ? AND status = 'confirmed'`, BATTLE_RESOLVE_KIND,
  )) {
    if (!op.signature || !op.payload) continue;
    let p: ResolvedMatch;
    try { p = JSON.parse(op.payload) as ResolvedMatch; } catch { continue; }
    if (!p?.matchId) continue;
    if (db.get(`SELECT 1 FROM matches WHERE id = ?`, p.matchId)) continue;
    if (writeResolvedMatch(db, p, op.signature)) healed++;
  }
  return healed;
}
const leagueOfPower = (p: number) => [800, 1400, 2400, 4000, 7000, Infinity].findIndex((u) => p < u);

/** Every accepted battle the indexer knows about (BattleAccepted without BattleResolved/Cancelled). */
export function acceptedBattles(db: Db): PublicKey[] {
  return db.all<{ battle: string }>(`SELECT battle FROM battles WHERE status = 'accepted' ORDER BY slot ASC LIMIT 100`).map((r) => new PublicKey(r.battle));
}

export async function resolveAll(d: ResolverDeps): Promise<{ resolved: number; skipped: number; failed: number }> {
  let resolved = 0, skipped = 0, failed = 0;
  // Бои, разрешённые в цепи, но потерянные проекцией: догоняем ДО очереди, чтобы «резолв ушёл,
  // запись не появилась» не оставалось навсегда.
  try {
    const healed = healResolvedMatches(d.db);
    if (healed) d.log?.(`[battle-resolver] healed ${healed} resolved battle(s) from the chain-ops ledger`);
  } catch (e) { d.log?.(`[battle-resolver] ledger heal failed: ${(e as Error).message}`); }
  for (const key of acceptedBattles(d.db)) {
    try {
      const r = await resolveOne(d, key);
      if (r.kind === 'resolved') resolved++; else { skipped++; d.log?.(`[battle-resolver] ${key.toBase58()} skipped: ${r.reason}`); }
    } catch (e) { failed++; d.log?.(`[battle-resolver] ${key.toBase58()} failed: ${(e as Error).message}`); }
  }
  return { resolved, skipped, failed };
}

export async function battleResolver(log: (s: string) => void = console.log) {
  if (!BATTLE_ORACLE_KEYPAIR) throw new Error('BATTLE_ORACLE_KEYPAIR is required; refusing to use the crank signer');
  const oracle = loadKeypair(BATTLE_ORACLE_KEYPAIR, 'BATTLE_ORACLE_KEYPAIR');
  const connection = getConnection();
  const db = sharedDb();
  log(`[battle-resolver] oracle ${oracle.publicKey.toBase58()} · arena ${PROGRAMS.arena.toBase58()} · poll ${BATTLE_RESOLVER_POLL_MS} ms`);
  while (true) {
    try { const r = await resolveAll({ connection, db, oracle, log }); if (r.resolved || r.failed) log(`[battle-resolver] resolved ${r.resolved} skipped ${r.skipped} failed ${r.failed}`); }
    catch (e) { log(`[battle-resolver] cycle failed: ${(e as Error).message}`); }
    await sleep(BATTLE_RESOLVER_POLL_MS);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  battleResolver().catch((err) => { console.error('battle-resolver crashed:', err); process.exit(1); });
}
