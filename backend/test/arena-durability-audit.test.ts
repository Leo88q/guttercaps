import { describe, it, expect } from 'vitest';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { onChainSquadPower } from '@guttercaps/economy';
import { Db } from '../src/db.ts';
import { ingestTx } from '../src/ingest.ts';
import { arenaConfigPda, resolveOne, squadFromDb } from '../src/battle-resolver.ts';
import { BATTLE_STATUS } from '../src/chain.ts';
import { encodeArenaConfig, encodeRandomness, encodeWagerBattle, FakeConnection, ARENA_ID, pk } from './chainFixtures.ts';
import { DEFAULT, hex32, kp, tx } from './fixtures.ts';

describe('battle resolver durability', () => {
  it('a confirmed tx whose confirm call times out leaves no match row, and the next cycle cannot fix it', async () => {
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
    // the transaction lands (battle account becomes Resolved, vault pays out) ...
    conn.onTx = () => { const copy = Uint8Array.from(battle); copy[8 + 32 + 32 + 8 + 6 * 32 + 4 + 4 + 32 + 8] = BATTLE_STATUS.RESOLVED; conn.set(battleKey, copy, ARENA_ID); };
    // ... but the confirm never comes back
    conn.confirmTransaction = async () => { throw new Error('Transaction was not confirmed in 60.00 seconds'); };
    const d = { connection: conn as unknown as Connection, db, oracle };
    let threw = '';
    try { await resolveOne(d, battleKey); } catch (e) { threw = (e as Error).message; }
    const after = { threw, matches: db.scalar(`SELECT COUNT(*) FROM matches`), xp: db.scalar(`SELECT COUNT(*) FROM chip_xp_awards`), battleStatus: conn.get(battleKey)![8 + 32 + 32 + 8 + 6 * 32 + 4 + 4 + 32 + 8] };
    // recovery attempt: the same keeper runs again (and no event has been ingested yet)
    const second = await resolveOne(d, battleKey);
    console.log(JSON.stringify({ after, second, matchesLater: db.scalar(`SELECT COUNT(*) FROM matches`) }));
    expect(threw).toContain('not confirmed');
    expect(after.battleStatus).toBe(BATTLE_STATUS.RESOLVED);
    expect(after.matches).toBe(0);
    expect(second.kind).toBe('skipped');
    expect(db.scalar(`SELECT COUNT(*) FROM matches`)).toBe(0);
  });
});
