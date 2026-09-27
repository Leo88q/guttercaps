// SEC-B30: the wager resolver decides who gets the pot, so the squad it computes the fight from must be the
// squad the opponent matched — the one whose power the battle account recorded at accept time.
//
// The program is deliberately server-authoritative here: `resolve_battle` checks that the winner is a party,
// that the winner's ATA owner is the winner, that the VRF was revealed and that the daily cap holds — it never
// re-simulates the fight (the round list is hashed into `result_hash` for audits). That makes the off-chain
// inputs the whole game: `squad_a/b` come from the battle account, but (collection, rarity, level) come from the
// `chips` projection, which keeps changing. Nothing on chain flags a chip that sits in an accepted battle, so
// between `accept_battle` and the reveal a player could fuse a level into a squad chip (power only goes up) and
// fight a stronger squad than the power the opponent matched against. Hence: reproduce `power_a/b` exactly, or
// refuse — `cancel_stale_battle` refunds both wagers after RESOLVE_TIMEOUT, so refusing costs nobody funds.
import { describe, it, expect, beforeEach } from 'vitest';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { levelMult, onChainSquadPower, profile, resolveFight, type RarityIndex } from '@guttercaps/economy';
import { Db } from '../src/db.ts';
import { ingestTx } from '../src/ingest.ts';
import { arenaConfigPda, resolveOne, rollFromValue, squadFromDb } from '../src/battle-resolver.ts';
import { BATTLE_STATUS, decodeRandomness, ixDiscriminator } from '../src/chain.ts';
import { encodeArenaConfig, encodeRandomness, encodeWagerBattle, FakeConnection, ARENA_ID, pk } from './chainFixtures.ts';
import { DEFAULT, hex32, kp, tx } from './fixtures.ts';

const asConn = (c: FakeConnection) => c as unknown as Connection;
/** `events_raw.data` is JSON, so asset keys travel as base58 strings (the indexer decodes them back). */
const b58 = (keys: readonly PublicKey[]) => keys.map((k) => k.toBase58());
const VRF_VALUE = new Uint8Array(32).fill(0x33);

describe('battle resolver (SEC-B30)', () => {
  let db: Db;
  let conn: FakeConnection;
  const oracle = Keypair.generate();
  const alice = kp(), bob = kp();
  const battleKey = pk();
  const rndKey = pk();
  const cgMint = pk();
  const A = [pk(), pk(), pk()], B = [pk(), pk(), pk()];
  const RARITY = [0, 1, 2], COLL = [3, 4, 5];

  beforeEach(() => {
    db = new Db(':memory:');
    conn = new FakeConnection();
  });

  /** Three chips each side, through the projections the indexer really writes (PackOpened → `chips`). */
  function mintSquads() {
    ingestTx(tx([{
      program: 'chip_core', name: 'PackOpened',
      data: { buyer: alice, sku: 1, nonce: '1', assets: [...b58(A), DEFAULT, DEFAULT], rarities: [...RARITY, 0, 0], collections: [...COLL, 0, 0], count: 3, roll: hex32(0x5a), pityBefore: 0, pityAfter: 1 },
    }]), db);
    ingestTx(tx([{
      program: 'chip_core', name: 'PackOpened',
      data: { buyer: bob, sku: 1, nonce: '2', assets: [...b58(B), DEFAULT, DEFAULT], rarities: [...RARITY, 0, 0], collections: [...COLL, 0, 0], count: 3, roll: hex32(0x5b), pityBefore: 0, pityAfter: 1 },
    }]), db);
  }

  /** The accepted battle account + the revealed randomness + the arena config, all as the RPC would serve them. */
  function chainAccepted(powerA?: number, powerB?: number) {
    const squadA = squadFromDb(db, A), squadB = squadFromDb(db, B);
    conn.set(battleKey, encodeWagerBattle({
      challenger: new PublicKey(alice), opponent: new PublicKey(bob), randomness: rndKey, commitSlot: 42n, status: BATTLE_STATUS.ACCEPTED, nonce: 7n,
      squadA: A, squadB: B,
      powerA: powerA ?? (squadA ? onChainSquadPower(squadA) : 0), powerB: powerB ?? (squadB ? onChainSquadPower(squadB) : 0),
    }), ARENA_ID);
    conn.set(rndKey, encodeRandomness({ authority: oracle.publicKey, queue: pk(), oracle: pk(), seedSlot: 42n, revealSlot: 50n, value: VRF_VALUE }), pk());
    conn.set(arenaConfigPda()[0], encodeArenaConfig({ admin: pk(), battleOracle: oracle.publicKey, cgMint, seasonPool: pk(), treasuryCg: pk() }), ARENA_ID);
  }

  const deps = () => ({ connection: asConn(conn), db, oracle, log: (s: string) => logs.push(s) });
  let logs: string[] = [];
  beforeEach(() => { logs = []; });

  it('resolves an accepted battle with the committed squads and records the fight', async () => {
    mintSquads();
    chainAccepted();
    const out = await resolveOne(deps(), battleKey);
    expect(out.kind).toBe('resolved');
    // the winner is one of the two parties, and it is the winner the seed implies
    const value = decodeRandomness(conn.get(rndKey)!).value;
    const fight = resolveFight(squadFromDb(db, A)!, squadFromDb(db, B)!, rollFromValue(value));
    const expected = fight.winner === 'A' ? alice : bob;
    expect(out.kind === 'resolved' && out.winner).toBe(expected);
    // one resolve_battle went out, carrying that winner and the hash of the rounds (the compute-budget ix
    // that `sendAndConfirm` prepends is not it)
    const disc = Buffer.from(ixDiscriminator('resolve_battle')).toString('hex');
    const ixs = conn.sent[0]!.ixs.filter((i) => Buffer.from(i.data.subarray(0, 8)).toString('hex') === disc);
    expect(ixs).toHaveLength(1);
    expect(ixs[0]!.data.length).toBe(8 + 32 + 32);
    expect(new PublicKey(ixs[0]!.data.subarray(8, 40)).toBase58()).toBe(expected);
    // and the record matches the account it settles
    const row = db.get<{ squad_a: string; power_a: number; power_b: number; winner: string; status: string; resolve_sig: string }>(
      `SELECT squad_a, power_a, power_b, winner, status, resolve_sig FROM matches WHERE id = ?`, battleKey.toBase58())!;
    expect(row.status).toBe('resolved');
    expect(row.winner).toBe(expected);
    expect(row.power_a).toBe(onChainSquadPower(squadFromDb(db, A)!));
    expect(row.power_b).toBe(onChainSquadPower(squadFromDb(db, B)!));
    expect(JSON.parse(row.squad_a).map((c: { asset: string }) => c.asset)).toEqual(A.map((a) => a.toBase58()));
    expect(logs.some((l) => l.startsWith('[battle-resolver] ALERT'))).toBe(false);
  });

  it('refuses to resolve when a squad chip was levelled up after the opponent matched', async () => {
    mintSquads();
    chainAccepted();
    // the only ways a chip's power can move: a fusion levels the target up (arena flags nothing meanwhile)
    db.run(`UPDATE chips SET level = level + 1 WHERE asset = ?`, A[0]!.toBase58());
    const out = await resolveOne(deps(), battleKey);
    expect(out.kind).toBe('skipped');
    expect(out.kind === 'skipped' && out.reason).toMatch(/does not match the recorded/);
    // nothing was sent and nothing was settled on a squad that was never agreed to
    expect(conn.sent).toHaveLength(0);
    expect(db.get(`SELECT id FROM matches WHERE id = ?`, battleKey.toBase58())).toBeUndefined();
    expect(logs.some((l) => l.includes('ALERT') && l.includes('power'))).toBe(true);
  });

  it('refuses to resolve with a squad chip that was consumed by a fusion', async () => {
    mintSquads();
    chainAccepted();
    db.run(`UPDATE chips SET burned_at = 1 WHERE asset = ?`, B[1]!.toBase58()); // consumed as fusion material
    expect(squadFromDb(db, B)).toBeUndefined();
    const out = await resolveOne(deps(), battleKey);
    expect(out).toMatchObject({ kind: 'skipped', reason: expect.stringContaining('not indexed yet') });
    expect(conn.sent).toHaveLength(0);
  });

  it('skips a battle whose squads the indexer has not seen yet (retry later, no guess)', async () => {
    chainAccepted(); // no chips in the projection at all
    expect(await resolveOne(deps(), battleKey)).toMatchObject({ kind: 'skipped', reason: expect.stringContaining('not indexed yet') });
    expect(conn.sent).toHaveLength(0);
  });

  it('the recorded power is what the program computes: the mirror is the check itself', () => {
    mintSquads();
    // arena::validate_squad sums floor(base_power × (10 000 + 250·(level − 1)) / 10 000) and records that sum
    // in the battle account; `onChainSquadPower` is the mirror the resolver compares against, so the identity
    // with the rarity table (already pinned in packages/economy/test/economy.test.ts against the Rust) is the
    // whole check — a drift here would refuse every battle, which is why the gate fails closed instead.
    const squad = squadFromDb(db, A)!;
    expect(onChainSquadPower(squad)).toBe(squad.reduce((sum, c) => sum + Math.floor((profile(c.rarity as RarityIndex).basePower * (10_000 + 250 * (c.level - 1))) / 10_000), 0));
    // sanity: the mirror is a real number that moves with the level, not a constant
    const levelled = squad.map((c, i) => (i === 0 ? { ...c, level: c.level + 1 } : c));
    expect(onChainSquadPower(levelled)).toBeGreaterThan(onChainSquadPower(squad));
    expect(levelMult(2)).toBeGreaterThan(levelMult(1));
  });

  it('a battle that is not ACCEPTED is left alone (the program settles it, not the keeper)', async () => {
    mintSquads();
    conn.set(battleKey, encodeWagerBattle({ challenger: new PublicKey(alice), opponent: new PublicKey(bob), randomness: rndKey, commitSlot: 42n, status: BATTLE_STATUS.OPEN, nonce: 7n, squadA: A, squadB: B }), ARENA_ID);
    expect(await resolveOne(deps(), battleKey)).toMatchObject({ kind: 'skipped', reason: expect.stringContaining('status') });
    expect(conn.sent).toHaveLength(0);
  });

  it('a missing battle account is a skip, not a throw (the walk may race the indexer)', async () => {
    expect(await resolveOne(deps(), battleKey)).toMatchObject({ kind: 'skipped', reason: 'battle account missing' });
    expect(conn.sent).toHaveLength(0);
  });
});
