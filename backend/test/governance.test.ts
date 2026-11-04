// SEC-G04 / SEC-G05 (Watchtower SW027 follow-ups): the claim-based fusion event reaches quests and the
// activity feed, and governance key rotations are indexed, served and turned into alertable series.
import { describe, it, expect, beforeEach } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { Db } from '../src/db.ts';
import { ingestTx } from '../src/ingest.ts';
import { activity } from '../src/queries.ts';
import { metricValue } from '../src/quests.ts';
import { wireEvent } from '../src/wire.ts';
import { configPda, emissionPda } from '../src/chain.ts';
import { arenaConfigPda, decodeArenaConfig } from '../src/battle-resolver.ts';
import { BorshWriter } from '../src/borsh.ts';
import { accountDiscriminator } from '../src/chain.ts';
import { authorityChangesIndexed, authorityPoints, governanceGauges, keyFingerprint, keyFingerprints, resetGovernanceGaugesForTests } from '../src/governance-metrics.ts';
import { FakeConnection, encodeEmissionState, encodeGameConfig } from './chainFixtures.ts';
import { kp, tx, DEFAULT } from './fixtures.ts';

const NOW = 1_800_000_000;

function encodeArenaConfig(o: { admin: PublicKey; battleOracle: PublicKey; treasuryCg: PublicKey; pauser?: PublicKey }): Uint8Array {
  return new Uint8Array([
    ...accountDiscriminator('ArenaConfig'),
    ...new BorshWriter().pubkey(o.admin).pubkey(o.battleOracle).pubkey(Keypair.generate().publicKey).pubkey(Keypair.generate().publicKey).pubkey(o.treasuryCg)
      .u64(120_000n * 1_000_000n).u64(0n).i64(BigInt(NOW)).bool(false).u8(255).pubkey(o.pauser ?? PublicKey.default).toBytes(),
  ]);
}

describe('SEC-G04: CompressedClaimsFused is a fusion for quests, the activity feed and the wire', () => {
  let db: Db;
  beforeEach(() => { db = new Db(':memory:'); });

  it('projects a fusions row shaped like ChipFused (success, roll 0 / threshold 10 000, materials = the claim PDAs)', () => {
    const owner = kp();
    const materials = [kp(), kp(), kp()];
    const resultClaim = kp();
    const t = tx([{ program: 'chip_core', name: 'CompressedClaimsFused', data: { owner, recipe: 0, materials, resultClaim, resultClaimNonce: '77', resultCollectionIdx: 3, resultRarity: 1, feeBurned: '2500000' } }], { blockTime: NOW - 10 });
    ingestTx(t, db);
    const row = db.get<{ owner: string; recipe: number; materials: string; result: string; success: number; roll_bps: number; threshold_bps: number; fee_burned: string; block_time: number }>(`SELECT * FROM fusions`);
    expect(row).toMatchObject({ owner, recipe: 0, result: resultClaim, success: 1, roll_bps: 0, threshold_bps: 10_000, fee_burned: '2500000', block_time: NOW - 10 });
    expect(JSON.parse(row!.materials)).toEqual(materials);
    // quests: `d_fuse1` / `p_first_fusion` count the fusions table — the claim path used to be invisible here
    expect(metricValue(db, owner, 'fusions', 0, NOW + 1, NOW)).toBe(1);
    // activity feed: same `fused` kind as the Core event
    expect(activity(db, owner).items.map((i) => i.kind)).toEqual(['fused']);
    // wallet became "active" (first_seen) through the owner field
    expect(db.scalar(`SELECT COUNT(*) FROM wallets WHERE address = ? AND first_seen IS NOT NULL`, owner)).toBe(1);
  });

  it('ships on the websocket as chip_fused with the ChipFused payload shape', () => {
    const owner = kp(), resultClaim = kp();
    const msg = wireEvent(db, { program: 'chip_core', programId: 'x', name: 'CompressedClaimsFused', ixIndex: 0, eventIndex: 0, data: { owner, recipe: 2, materials: [kp(), kp(), kp()], resultClaim, resultClaimNonce: '1', resultCollectionIdx: 0, resultRarity: 3, feeBurned: '15000000' } }, { slot: 9 });
    expect(msg).toMatchObject({ type: 'chip_fused', payload: { owner, result: resultClaim, recipe: 2, success: true } });
    expect(msg!.wallets).toContain(owner);
  });

  it('a late block time is healed into the fusions row', () => {
    const owner = kp();
    const t = tx([{ program: 'chip_core', name: 'CompressedClaimsFused', data: { owner, recipe: 1, materials: [kp(), kp(), kp()], resultClaim: kp(), resultClaimNonce: '2', resultCollectionIdx: 1, resultRarity: 2, feeBurned: '6000000' } }], { blockTime: null });
    ingestTx(t, db);
    expect(db.scalar(`SELECT COUNT(*) FROM fusions WHERE block_time IS NULL`)).toBe(1);
    ingestTx({ ...t, blockTime: NOW }, db);
    expect(db.get<{ block_time: number }>(`SELECT block_time FROM fusions`)!.block_time).toBe(NOW);
  });
});

describe('H3: ClaimFusionRevealed is a fusion for quests, the activity feed and the wire', () => {
  let db: Db;
  beforeEach(() => { db = new Db(':memory:'); });

  it('projects a fusions row with the real roll; failures store NULL result and still count for quests', () => {
    const owner = kp();
    const materials = [kp(), kp(), kp()];
    const resultClaim = kp();
    ingestTx(tx([{ program: 'chip_core', name: 'ClaimFusionCommitted', data: { owner, nonce: '9', recipe: 4, materials } }], { blockTime: NOW - 20 }), db);
    ingestTx(tx([{ program: 'chip_core', name: 'ClaimFusionRevealed', data: { owner, nonce: '9', recipe: 4, materials, resultClaim, success: true, rollBps: 4200, thresholdBps: 5000, feeBurned: '500000' } }], { blockTime: NOW - 10 }), db);
    const row = db.get<{ result: string; success: number; roll_bps: number; threshold_bps: number; block_time: number }>(`SELECT * FROM fusions`);
    expect(row).toMatchObject({ result: resultClaim, success: 1, roll_bps: 4200, threshold_bps: 5000, block_time: NOW - 10 });
    ingestTx(tx([{ program: 'chip_core', name: 'ClaimFusionRevealed', data: { owner, nonce: '10', recipe: 4, materials, resultClaim: DEFAULT, success: false, rollBps: 9100, thresholdBps: 8500, feeBurned: '500000' } }], { blockTime: NOW - 5 }), db);
    expect(db.get<{ result: string | null }>(`SELECT result FROM fusions WHERE success = 0`)!.result).toBeNull();
    // quests count attempts, the feed shows both, the commit already marked the wallet active
    expect(metricValue(db, owner, 'fusions', 0, NOW + 1, NOW)).toBe(2);
    expect(activity(db, owner).items.map((i) => i.kind)).toEqual(['fused', 'fused']);
    expect(db.scalar(`SELECT COUNT(*) FROM wallets WHERE address = ? AND first_seen IS NOT NULL`, owner)).toBe(1);
  });

  it('ships on the websocket as chip_fused with the ChipFused payload shape', () => {
    const owner = kp(), resultClaim = kp();
    const msg = wireEvent(db, { program: 'chip_core', programId: 'x', name: 'ClaimFusionRevealed', ixIndex: 0, eventIndex: 0, data: { owner, nonce: '9', recipe: 4, materials: [kp(), kp(), kp()], resultClaim, success: true, rollBps: 4200, thresholdBps: 5000, feeBurned: '500000' } }, { slot: 9 });
    expect(msg).toMatchObject({ type: 'chip_fused', payload: { owner, result: resultClaim, recipe: 4, success: true } });
    expect(msg!.wallets).toContain(owner);
  });

  it('a late block time is healed into the fusions row', () => {
    const owner = kp();
    const t = tx([{ program: 'chip_core', name: 'ClaimFusionRevealed', data: { owner, nonce: '9', recipe: 4, materials: [kp(), kp(), kp()], resultClaim: kp(), success: true, rollBps: 1, thresholdBps: 5000, feeBurned: '500000' } }], { blockTime: null });
    ingestTx(t, db);
    expect(db.scalar(`SELECT COUNT(*) FROM fusions WHERE block_time IS NULL`)).toBe(1);
    ingestTx({ ...t, blockTime: NOW }, db);
    expect(db.get<{ block_time: number }>(`SELECT block_time FROM fusions`)!.block_time).toBe(NOW);
  });
});

describe('SEC-G05: governance rotations are indexed per role', () => {
  let db: Db;
  beforeEach(() => { db = new Db(':memory:'); });

  it('PauserChanged from any of the three programs, AdminProposed/Accepted, OraclesChanged (4 roles), ArenaConfigChanged (2 roles), CollectionCreated', () => {
    const admin = kp(), hot = kp(), next = kp();
    ingestTx(tx([{ program: 'staking', name: 'PauserChanged', data: { by: admin, pauser: hot } }], { blockTime: NOW - 500 }), db);
    ingestTx(tx([{ program: 'arena', name: 'PauserChanged', data: { by: admin, pauser: DEFAULT } }], { blockTime: NOW - 400 }), db);
    ingestTx(tx([{ program: 'chip_core', name: 'AdminProposed', data: { by: admin, newAdmin: next } }], { blockTime: NOW - 300 }), db);
    ingestTx(tx([{ program: 'chip_core', name: 'AdminAccepted', data: { oldAdmin: admin, newAdmin: next } }], { blockTime: NOW - 200 }), db);
    const oracles = { questOracle: kp(), seasonOracle: kp(), setOracle: kp(), burnOracle: DEFAULT };
    ingestTx(tx([{ program: 'staking', name: 'OraclesChanged', data: { by: next, ...oracles } }], { blockTime: NOW - 100 }), db);
    const arena = { battleOracle: kp(), oracleDailyCap: '120000000000', treasuryCg: kp() };
    ingestTx(tx([{ program: 'arena', name: 'ArenaConfigChanged', data: { by: next, ...arena } }], { blockTime: NOW - 50 }), db);
    ingestTx(tx([{ program: 'chip_core', name: 'CollectionCreated', data: { by: next, idx: 7, coreCollection: kp() } }], { blockTime: NOW - 10 }), db);

    const rows = db.all<{ program: string; kind: string; by_wallet: string; key: string; detail: string; block_time: number }>(`SELECT program, kind, by_wallet, key, detail, block_time FROM authority_changes ORDER BY slot, kind`);
    expect(rows.map((r) => [r.program, r.kind, r.key])).toEqual([
      ['staking', 'pauser', hot],
      ['arena', 'pauser', DEFAULT],
      ['chip_core', 'admin_proposed', next],
      ['chip_core', 'admin', next],
      ['staking', 'burn_oracle', DEFAULT], ['staking', 'quest_oracle', oracles.questOracle], ['staking', 'season_oracle', oracles.seasonOracle], ['staking', 'set_oracle', oracles.setOracle],
      ['arena', 'battle_oracle', arena.battleOracle], ['arena', 'treasury_cg', arena.treasuryCg],
      ['chip_core', 'collection', expect.any(String)],
    ]);
    // the signer column is the handing-over admin for AdminAccepted (there is no `by` in that event)
    expect(rows.find((r) => r.kind === 'admin')!.by_wallet).toBe(admin);
    // the whole payload survives for the /admin history (the cap that came with a battle_oracle rotation)
    expect(JSON.parse(rows.find((r) => r.kind === 'battle_oracle')!.detail).oracleDailyCap).toBe('120000000000');
    expect(rows.every((r) => r.block_time !== null)).toBe(true);
    // the gauge the AuthorityChangeIndexed rule reads
    expect(authorityChangesIndexed(db)).toEqual(expect.arrayContaining([
      { program: 'staking', kind: 'pauser', count: 1 }, { program: 'staking', kind: 'quest_oracle', count: 1 }, { program: 'chip_core', kind: 'admin_proposed', count: 1 },
    ]));
    expect(authorityChangesIndexed(db)).toHaveLength(11);
  });

  it('is idempotent across a re-ingest and heals a late block time', () => {
    const t = tx([{ program: 'chip_core', name: 'PauserChanged', data: { by: kp(), pauser: kp() } }], { blockTime: null });
    ingestTx(t, db);
    ingestTx(t, db);
    expect(db.scalar(`SELECT COUNT(*) FROM authority_changes`)).toBe(1);
    expect(db.scalar(`SELECT COUNT(*) FROM authority_changes WHERE block_time IS NULL`)).toBe(1);
    ingestTx({ ...t, blockTime: NOW }, db);
    expect(db.get<{ block_time: number }>(`SELECT block_time FROM authority_changes`)!.block_time).toBe(NOW);
  });
});

describe('SEC-G05: program_authority_* gauges', () => {
  beforeEach(() => resetGovernanceGaugesForTests());

  it('fingerprint: 96-bit sha256 split into two exact 48-bit halves, 0 for the default key (находка 70)', () => {
    expect(keyFingerprints(PublicKey.default)).toEqual({ hi: 0, lo: 0 });
    const a = Keypair.generate().publicKey;
    const fp = keyFingerprints(a);
    // Обе половины точны в float64 (48 бит) и не равны нулю у настоящего ключа.
    expect(Number.isSafeInteger(fp.hi)).toBe(true);
    expect(Number.isSafeInteger(fp.lo)).toBe(true);
    expect(fp.hi).toBeGreaterThan(0);
    expect(fp.lo).toBeGreaterThan(0);
    expect(fp.hi).toBeLessThan(2 ** 48);
    expect(fp.lo).toBeLessThan(2 ** 48);
    // Отпечаток детерминирован, а старшая половина — то, что экспортирует `program_authority_fingerprint`.
    expect(keyFingerprints(a)).toEqual(fp);
    expect(keyFingerprint(a)).toBe(fp.hi);
    // Раньше отпечатком были первые 6 байт ключа: такой «префиксный» ключ больше не совпадает.
    const raw = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26]);
    expect(keyFingerprint(new PublicKey(raw))).not.toBe(2 ** 48 - 1);
  });

  it('reads the 15 roles from the three config accounts and flags a pending admin', async () => {
    const conn = new FakeConnection();
    const treasury = Keypair.generate().publicKey, questOracle = Keypair.generate().publicKey, battleOracle = Keypair.generate().publicKey, arenaAdmin = Keypair.generate().publicKey;
    conn.set(configPda()[0], encodeGameConfig({ treasury, cgMint: Keypair.generate().publicKey, collectionsCreated: 3 }));
    conn.set(emissionPda()[0], encodeEmissionState({ questOracle }));
    conn.set(arenaConfigPda()[0], encodeArenaConfig({ admin: arenaAdmin, battleOracle, treasuryCg: Keypair.generate().publicKey }));
    // gated off → nothing, no RPC
    expect(await governanceGauges({ enabled: false, connection: conn })).toEqual({ readable: 0, points: [], adminTransferPending: 0, enabled: 0 });
    const g = await governanceGauges({ enabled: true, connection: conn, nowMs: 1 });
    expect(g.readable).toBe(1);
    expect(g.enabled).toBe(1);
    expect(g.points).toHaveLength(15);
    const by = (program: string, role: string) => g.points.find((p) => p.program === program && p.role === role)!;
    expect(by('chip_core', 'treasury').key).toBe(treasury.toBase58());
    expect(by('chip_core', 'pending_admin').value).toBe(0); // fixture: no pending admin
    expect(by('chip_core', 'pauser').value).toBe(0);
    expect(by('staking', 'quest_oracle')).toMatchObject({ key: questOracle.toBase58(), value: keyFingerprint(questOracle) });
    expect(by('staking', 'burn_oracle').value).toBe(0);
    expect(by('arena', 'battle_oracle').key).toBe(battleOracle.toBase58());
    expect(by('arena', 'admin').key).toBe(arenaAdmin.toBase58());
    expect(by('arena', 'pauser').value).toBe(0);
    expect(g.adminTransferPending).toBe(0);
    // decodeArenaConfig now surfaces the appended pauser (and tolerates the older layout)
    expect(decodeArenaConfig(conn.get(arenaConfigPda()[0])!).pauser.equals(PublicKey.default)).toBe(true);

    // a pending admin → the early-warning gauge
    const pending = Keypair.generate().publicKey;
    const cfg = encodeGameConfig({ treasury, cgMint: Keypair.generate().publicKey, collectionsCreated: 3 });
    cfg.set(pending.toBytes(), 8 + 32); // pending_admin is the second pubkey
    conn.set(configPda()[0], cfg);
    // cached for 60 s
    expect((await governanceGauges({ enabled: true, connection: conn, nowMs: 30_000 })).adminTransferPending).toBe(0);
    const g2 = await governanceGauges({ enabled: true, connection: conn, nowMs: 61_000 });
    expect(g2.adminTransferPending).toBe(1);
    expect(g2.points.find((p) => p.role === 'pending_admin')!.key).toBe(pending.toBase58());
    expect(authorityPoints({ chipCore: cfg, staking: conn.get(emissionPda()[0])!, arena: conn.get(arenaConfigPda()[0])! }).adminTransferPending).toBe(1);
  });

  it('keeps the last known keys across a failed read (an RPC blip is not a rotation) and never throws', async () => {
    const conn = new FakeConnection();
    conn.set(configPda()[0], encodeGameConfig({ treasury: Keypair.generate().publicKey, cgMint: Keypair.generate().publicKey, collectionsCreated: 1 }));
    conn.set(emissionPda()[0], encodeEmissionState());
    conn.set(arenaConfigPda()[0], encodeArenaConfig({ admin: Keypair.generate().publicKey, battleOracle: Keypair.generate().publicKey, treasuryCg: Keypair.generate().publicKey }));
    const first = await governanceGauges({ enabled: true, connection: conn, nowMs: 1 });
    expect(first.readable).toBe(1);
    conn.del(emissionPda()[0]); // one account missing → the whole read is "unreadable"
    const second = await governanceGauges({ enabled: true, connection: conn, nowMs: 100_000 });
    expect(second.readable).toBe(0);
    expect(second.points).toEqual(first.points);
    // and before any successful read there is simply nothing (no sentinel that could later "change")
    resetGovernanceGaugesForTests();
    const bare = await governanceGauges({ enabled: true, connection: conn, nowMs: 200_000 });
    expect(bare).toMatchObject({ readable: 0, points: [] });
  });
});
