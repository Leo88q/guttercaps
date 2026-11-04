// The arena's documented oracle-cap path (programs/arena/src/lib.rs:1265-1281): when a pot would push
// `oracle_paid_today` past the cap, `resolve_battle` sets `paused = true` and returns Ok() WITHOUT paying
// anybody, leaving the battle `Accepted` for `cancel_stale_battle`. This test feeds the resolver exactly
// that outcome (a successful transaction that does not settle) and records what it writes.
import { describe, it, expect } from 'vitest';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { onChainSquadPower } from '@guttercaps/economy';
import { Db } from '../src/db.ts';
import { ingestTx } from '../src/ingest.ts';
import { arenaConfigPda, resolveOne, squadFromDb } from '../src/battle-resolver.ts';
import { BATTLE_STATUS } from '../src/chain.ts';
import { encodeArenaConfig, encodeRandomness, encodeWagerBattle, FakeConnection, ARENA_ID, pk } from './chainFixtures.ts';
import { DEFAULT, hex32, kp, tx } from './fixtures.ts';

describe('arena oracle-cap path', () => {
  it('a successful resolve_battle that pays nobody is recorded as a resolved match', async () => {
    const db = new Db(':memory:'), conn = new FakeConnection(), oracle = Keypair.generate();
    const alice = kp(), bob = kp(), battleKey = pk(), rndKey = pk(), cgMint = pk();
    const A = [pk(), pk(), pk()], B = [pk(), pk(), pk()];
    const open = (buyer: string, assets: PublicKey[], nonce: string, roll: number) => ingestTx(tx([{ program: 'chip_core', name: 'PackOpened', data: { buyer, sku: 1, nonce, assets: [...assets.map(k=>k.toBase58()), DEFAULT, DEFAULT], rarities: [0,1,2,0,0], collections: [3,4,5,0,0], count: 3, roll: hex32(roll), pityBefore: 0, pityAfter: 1 } }]), db);
    open(alice, A, '1', 0x5a); open(bob, B, '2', 0x5b);
    const squadA = squadFromDb(db, A)!, squadB = squadFromDb(db, B)!;
    const battle = encodeWagerBattle({ challenger: new PublicKey(alice), opponent: new PublicKey(bob), randomness: rndKey, commitSlot: 42n, status: BATTLE_STATUS.ACCEPTED, nonce: 7n, squadA: A, squadB: B, powerA: onChainSquadPower(squadA), powerB: onChainSquadPower(squadB) });
    conn.set(battleKey, battle, ARENA_ID);
    conn.set(rndKey, encodeRandomness({ authority: oracle.publicKey, queue: pk(), oracle: pk(), seedSlot: 42n, revealSlot: 50n, value: new Uint8Array(32).fill(0x33) }), pk());
    conn.set(arenaConfigPda()[0], encodeArenaConfig({ admin: pk(), battleOracle: oracle.publicKey, cgMint, seasonPool: pk(), treasuryCg: pk() }), ARENA_ID);
    // the cap path: Ok, arena paused, battle still Accepted, no token movement
    const out = await resolveOne({ connection: conn as unknown as Connection, db, oracle }, battleKey);
    const row = db.get<{ status: string; winner: string; resolve_sig: string }>(`SELECT status, winner, resolve_sig FROM matches WHERE id = ?`, battleKey.toBase58());
    const result = {
      outcome: out.kind,
      battleStatusAfter: conn.get(battleKey)![8 + 32 + 32 + 8 + 6 * 32 + 4 + 4 + 32 + 8],
      matchRow: row,
      xpAwards: db.all(`SELECT xp FROM chip_xp_awards`),
      boardHints: db.all(`SELECT source, amount FROM grid_item_grants`),
      battleResolvedEvents: db.scalar(`SELECT COUNT(*) FROM events_raw WHERE name = 'BattleResolved'`),
      battlesProjection: db.all(`SELECT status FROM battles`),
    };
    console.log(JSON.stringify(result));
    expect(out.kind).toBe('resolved');                       // keeper: "settled"
    expect(result.battleStatusAfter).toBe(BATTLE_STATUS.ACCEPTED); // chain: unsettled, refundable later
    expect(row?.status).toBe('resolved');                    // record: a winner that never won anything
    expect(result.xpAwards.length).toBe(3);                  // chip XP for a battle nobody settled
    expect(result.boardHints.length).toBe(1);                // arena_win board part
    expect(result.battleResolvedEvents).toBe(0);             // no on-chain settlement event
  });
});
