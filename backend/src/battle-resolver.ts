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
import { db as sharedDb, type Db } from './db.ts';
import { BorshWriter } from './borsh.ts';
import { PROGRAMS } from './config.ts';
import {
  ARENA_ID, BATTLE_STATUS, TOKEN_PROGRAM_ID, ata, battlePda, decodeRandomness, decodeWagerBattle, expectDiscriminator, ixData, ro, rw, signer, type WagerBattle,
} from './chain.ts';
import { getConnection, sleep } from './ingest.ts';
import { loadKeypair } from './crank.ts';
import { sendAndConfirm } from './tx.ts';
import type { ChipRow } from './queries.ts';
import { insertIgnore } from './sql.ts';

const env = process.env;
export const BATTLE_ORACLE_KEYPAIR = env.BATTLE_ORACLE_KEYPAIR ?? '';
export const BATTLE_RESOLVER_POLL_MS = Number(env.BATTLE_RESOLVER_POLL_MS ?? 5_000);
export const CU_RESOLVE_BATTLE = 120_000;

export const arenaConfigPda = () => PublicKey.findProgramAddressSync([Buffer.from('arena_config')], ARENA_ID);

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

export interface ArenaConfig {
  admin: PublicKey; battleOracle: PublicKey; cgMint: PublicKey; seasonPool: PublicKey; treasuryCg: PublicKey; oracleDailyCap: bigint; oraclePaidToday: bigint; oracleDayStart: bigint; paused: boolean;
  /** SEC-H2 hot pauser, appended last on chain; `PublicKey.default` = none (also for a pre-pauser account layout). */
  pauser: PublicKey;
}
export function decodeArenaConfig(data: Uint8Array): ArenaConfig {
  const r = expectDiscriminator(data, 'ArenaConfig');
  const head = { admin: r.pubkey(), battleOracle: r.pubkey(), cgMint: r.pubkey(), seasonPool: r.pubkey(), treasuryCg: r.pubkey(), oracleDailyCap: r.u64(), oraclePaidToday: r.u64(), oracleDayStart: r.i64(), paused: r.bool() };
  // bump (u8) then the appended pauser; tolerate a fixture / legacy layout that stops at `paused`
  const pauser = r.remaining >= 33 ? (r.u8(), r.pubkey()) : PublicKey.default;
  return { ...head, pauser };
}

export function squadFromDb(db: Db, assets: readonly PublicKey[]): FighterChip[] | undefined {
  const out: FighterChip[] = [];
  for (const a of assets) {
    // SEC-B30: an asset consumed by a fusion is not a chip any more — its row is a tombstone for the audit
    // trail, not an input for a fight that decides the pot.
    const r = db.get<ChipRow>(`SELECT * FROM chips WHERE asset = ? AND burned_at IS NULL`, a.toBase58());
    if (!r) return undefined;
    out.push({ asset: r.asset, collection: r.collection_idx, rarity: r.rarity, level: r.level });
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
  const { signature } = await sendAndConfirm(d.connection, d.oracle, [ix], { cuLimit: CU_RESOLVE_BATTLE });
  // keep the round list so /arena/matches/:battle can replay a wager battle exactly like a ranked one
  d.db.run(
    // every value is a parameter now (the literals were inline in the VALUES list): same row, and the
    // statement shape is what `sql.ts` guarantees across dialects
    insertIgnore('matches', ['id', 'season', 'a', 'b', 'squad_a', 'squad_b', 'power_a', 'power_b', 'league', 'commit_a', 'commit_b', 'nonce_a', 'nonce_b', 'seed', 'rounds', 'winner', 'wager', 'battle_pda', 'resolve_sig', 'status', 'started_at', 'ended_at', 'rewarded']),
    battleKey.toBase58(), 0, b.challenger.toBase58(), b.opponent.toBase58(), JSON.stringify(squadA), JSON.stringify(squadB), b.powerA, b.powerB, leagueOfPower(b.powerA),
    '', '', '', '', Buffer.from(rnd.value).toString('hex'), JSON.stringify(fight.rounds), winner.toBase58(), b.wager.toString(), battleKey.toBase58(), signature, 'resolved',
    Number(b.acceptedAt) * 1000, Date.now(), 0,
  );
  d.log?.(`[battle-resolver] resolve_battle ${battleKey.toBase58()} winner ${winner.toBase58()} → ${signature}`);
  return { kind: 'resolved', signature, winner: winner.toBase58() };
}
const leagueOfPower = (p: number) => [800, 1400, 2400, 4000, 7000, Infinity].findIndex((u) => p < u);

/** Every accepted battle the indexer knows about (BattleAccepted without BattleResolved/Cancelled). */
export function acceptedBattles(db: Db): PublicKey[] {
  return db.all<{ battle: string }>(`SELECT battle FROM battles WHERE status = 'accepted' ORDER BY slot ASC LIMIT 100`).map((r) => new PublicKey(r.battle));
}

export async function resolveAll(d: ResolverDeps): Promise<{ resolved: number; skipped: number; failed: number }> {
  let resolved = 0, skipped = 0, failed = 0;
  for (const key of acceptedBattles(d.db)) {
    try {
      const r = await resolveOne(d, key);
      if (r.kind === 'resolved') resolved++; else { skipped++; d.log?.(`[battle-resolver] ${key.toBase58()} skipped: ${r.reason}`); }
    } catch (e) { failed++; d.log?.(`[battle-resolver] ${key.toBase58()} failed: ${(e as Error).message}`); }
  }
  return { resolved, skipped, failed };
}

export async function battleResolver(log: (s: string) => void = console.log) {
  const oracle = loadKeypair(BATTLE_ORACLE_KEYPAIR || undefined);
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
