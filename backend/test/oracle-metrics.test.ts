// SEC-F02 / SEC-F06 follow-up: oracle liveness gauges + the battle-oracle key-misuse canary.
import { describe, it, expect, beforeEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { Db } from '../src/db.ts';
import { ingestTx } from '../src/ingest.ts';
import { accountDiscriminator } from '../src/chain.ts';
import { BorshWriter } from '../src/borsh.ts';
import { arenaConfigPda } from '../src/battle-resolver.ts';
import { insertIgnore } from '../src/sql.ts';
import { arenaOracleGauge, burnOracleGauges, resetArenaOracleGaugeForTests, rewardOracleGauges, unattributedResolves } from '../src/oracle-metrics.ts';
import { FakeConnection } from './chainFixtures.ts';
import { finalizeAll, hex32, kp, tx } from './fixtures.ts';

const NOW = 1_800_000_000; // unix s, well after the fixtures' default block times (1.7e9 + slot)

const resolved = (battle: string, opts: { signature?: string; blockTime?: number | null } = {}) =>
  tx([{ program: 'arena', name: 'BattleResolved', data: { battle, winner: kp(), pot: '100000000', rakeBurn: '2000000', rakePool: '1000000', rakeTreasury: '2000000', resultHash: hex32(0x22), roll: hex32(0x33) } }], { blockTime: NOW - 60, ...opts });

/** What battle-resolver.ts writes after its own `sendAndConfirm` (only the columns the canary reads matter). */
function attribute(db: Db, battle: string, signature: string) {
  db.run(
    insertIgnore('matches', ['id', 'season', 'a', 'b', 'squad_a', 'squad_b', 'power_a', 'power_b', 'league', 'commit_a', 'commit_b', 'battle_pda', 'resolve_sig', 'status', 'started_at']),
    battle, 0, kp(), kp(), '[]', '[]', 600, 600, 0, '', '', battle, signature, 'resolved', NOW * 1000,
  );
}

describe('oracle metrics (SEC-F02 / SEC-F06)', () => {
  let db: Db;
  beforeEach(() => { db = new Db(':memory:'); resetArenaOracleGaugeForTests(); });

  it('arena_unattributed_resolves: a BattleResolved nobody wrote a matches row for, inside the 24 h window', () => {
    expect(unattributedResolves(db, NOW)).toEqual({ count: 0, sample: [] });
    const battle = kp();
    ingestTx(resolved(battle, { signature: 'sigForeign' }), db);
    const u = unattributedResolves(db, NOW);
    expect(u.count).toBe(1);
    expect(u.sample).toEqual([{ battle, signature: 'sigForeign', resolvedAt: NOW - 60 }]);
    // the battle worker's own row clears it (the race with the indexer is what the alert's `for:` absorbs)
    attribute(db, battle, 'sigForeign');
    expect(unattributedResolves(db, NOW).count).toBe(0);
  });

  it('arena_unattributed_resolves: outside the window is ignored, an unknown block time counts as recent', () => {
    ingestTx(resolved(kp(), { signature: 'sigOld', blockTime: NOW - 86_400 - 1 }), db);
    expect(unattributedResolves(db, NOW).count).toBe(0);
    ingestTx(resolved(kp(), { signature: 'sigWs', blockTime: null }), db); // first seen via websocket, no block time yet
    expect(unattributedResolves(db, NOW).count).toBe(1);
    // an attributed resolve of *another* battle does not vouch for this one
    attribute(db, kp(), 'sigOther');
    expect(unattributedResolves(db, NOW).count).toBe(1);
  });

  it('burn_oracle_*: fresh DB is healthy with age -1; a confirmed burn is deferred, a finalized one is pending', () => {
    expect(burnOracleGauges(db)).toEqual({ reportAgeS: -1, pendingCg: 0, deferredCg: 0, healthy: 1 });
    ingestTx(resolved(kp()), db);
    // SEC-B29: nothing may be reported yet (a fork could still take this burn back), so `pending` stays 0 —
    // the deferred series is what makes the stall visible, and material deferrals are not "healthy"
    expect(burnOracleGauges(db)).toEqual({ reportAgeS: -1, pendingCg: 0, deferredCg: 2, healthy: 0 });
    finalizeAll(db);
    expect(burnOracleGauges(db)).toEqual({ reportAgeS: -1, pendingCg: 2, deferredCg: 0, healthy: 0 });
  });

  it('reward_oracle_*: pending batch age drives healthy; publish age comes from the newest published batch', () => {
    expect(rewardOracleGauges(db, NOW)).toMatchObject({ publishAgeS: -1, pendingBatches: 0, oldestPendingAgeS: 0, healthy: 1, unrootedCg: { quests: 0, pvp: 0, referrals: 0 } });
    const nowS = Math.floor(Date.now() / 1000); // rewardOracleStatus measures batch age against the wall clock
    db.run(`INSERT INTO reward_batches (kind, epoch, root, budget, leaves, status, created_at) VALUES (1, 1, 'r', '5000000', 1, 'pending', ?)`, nowS - 7 * 24 * 3600);
    const g = rewardOracleGauges(db, nowS);
    expect(g).toMatchObject({ pendingBatches: 1, healthy: 0 });
    expect(g.oldestPendingAgeS).toBeGreaterThanOrEqual(7 * 24 * 3600);
    db.run(`INSERT INTO reward_batches (kind, epoch, root, budget, leaves, status, created_at, published_at) VALUES (1, 2, 'r2', '5000000', 1, 'published', ?, ?)`, nowS - 4000, nowS - 3600);
    expect(rewardOracleGauges(db, nowS).publishAgeS).toBe(3600);
  });

  it('arena_oracle_cap_*: reads ArenaConfig, treats a lapsed window as 0 paid, and is inert when not enabled', async () => {
    const conn = new FakeConnection();
    const cfg = (paid: bigint, dayStart: number) => new Uint8Array([
      ...accountDiscriminator('ArenaConfig'),
      ...new BorshWriter().pubkey(Keypair.generate().publicKey).pubkey(Keypair.generate().publicKey).pubkey(Keypair.generate().publicKey)
        .pubkey(Keypair.generate().publicKey).pubkey(Keypair.generate().publicKey).u64(120_000n * 1_000_000n).u64(paid).i64(dayStart).bool(false).toBytes(),
    ]);
    expect(await arenaOracleGauge({ enabled: false, connection: conn })).toEqual({ capCg: -1, paidTodayCg: -1, readable: 0, dayAgeS: -1 });
    // no account yet → unreadable, never throws
    expect(await arenaOracleGauge({ enabled: true, connection: conn, nowS: NOW })).toMatchObject({ readable: 0 });
    resetArenaOracleGaugeForTests();
    conn.set(arenaConfigPda()[0], cfg(96_000n * 1_000_000n, NOW - 3600));
    expect(await arenaOracleGauge({ enabled: true, connection: conn, nowS: NOW })).toEqual({ capCg: 120_000, paidTodayCg: 96_000, readable: 1, dayAgeS: 3600 });
    // cached for 30 s: a changed account is not re-read yet
    conn.set(arenaConfigPda()[0], cfg(1n, NOW - 90_000));
    expect((await arenaOracleGauge({ enabled: true, connection: conn, nowS: NOW })).paidTodayCg).toBe(96_000);
    resetArenaOracleGaugeForTests();
    // the program zeroes paid_today on the first resolve after 24 h; the gauge reports what that resolve will see
    expect(await arenaOracleGauge({ enabled: true, connection: conn, nowS: NOW })).toMatchObject({ capCg: 120_000, paidTodayCg: 0, readable: 1, dayAgeS: 90_000 });
  });
});
