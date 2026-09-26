// Fusion planner, staking read-model, arena (queue → reveal → resolve → rewards → forfeits → seasons),
// quests (progress from events, eligibility, caps, streak) and the reward oracle (batches → publish_root).
import { describe, it, expect, beforeEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { ANTI_FARM, DAILY_QUESTS, FUSION_RECIPES, MATCH_REWARDS, MATCHMAKING, QUEST_CHIP_TEMPLATES, WEEKLY_QUESTS, resolveFight, onChainSquadPower, type FighterChip } from '@guttercaps/economy';
import { Db } from '../src/db.ts';
import { ingestTx } from '../src/ingest.ts';
import { ServiceError } from '../src/services.ts';
import { PROGRAMS } from '../src/config.ts';
import { ixDiscriminator } from '../src/chain.ts';
import * as fusion from '../src/fusion.ts';
import * as staking from '../src/staking.ts';
import * as arena from '../src/arena.ts';
import * as quests from '../src/quests.ts';
import * as oracle from '../src/reward-oracle.ts';
import * as antifraud from '../src/antifraud.ts';
import * as referrals from '../src/referrals.ts';
import * as human from '../src/human.ts';
import * as q from '../src/queries.ts';
import { buildRewardTree, rewardLeaf, toHex, verifyRewardProof, fromHex } from '../src/merkle.ts';
import { resolveBattleIx, resultHash, rollFromValue, squadFromDb } from '../src/battle-resolver.ts';
import { FakeConnection, encodeEmissionState, encodeSkrPool } from './chainFixtures.ts';
import { DEFAULT, finalizeAll, hex32, kp, tx, world } from './fixtures.ts';
import { finalizedHorizon } from '../src/finality.ts';

const sha256hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const asConn = (c: FakeConnection) => c as unknown as Connection;
const err = (fn: () => unknown): ServiceError => { try { fn(); } catch (e) { if (e instanceof ServiceError) return e; throw e; } throw new Error('expected a ServiceError'); };

/** Mint `n` chips for `owner` via a PackOpened event (rarity/collection per index). */
function mint(db: Db, owner: string, specs: { rarity: number; collection: number }[], opts: { nonce?: string; sku?: number; blockTime?: number } = {}): string[] {
  const assets = specs.map(() => kp());
  const nonce = opts.nonce ?? String(Math.floor(Math.random() * 1e9));
  ingestTx(tx([{ program: 'chip_core', name: 'PackBought', data: { buyer: owner, sku: opts.sku ?? 1, qty: 1, currency: 0, amount: '33000000', nonce, randomness: kp() } }], { blockTime: opts.blockTime }), db);
  for (let i = 0; i < assets.length; i += 5) {
    const slice = assets.slice(i, i + 5);
    const pad = <T,>(arr: T[], v: T) => [...arr, ...Array(5 - arr.length).fill(v)] as T[];
    ingestTx(tx([{ program: 'chip_core', name: 'PackOpened', data: {
      buyer: owner, sku: opts.sku ?? 1, nonce, assets: pad(slice, DEFAULT), rarities: pad(specs.slice(i, i + 5).map((s) => s.rarity), 0), collections: pad(specs.slice(i, i + 5).map((s) => s.collection), 0),
      count: slice.length, roll: hex32(0x9f), pityBefore: 0, pityAfter: 1,
    } }], { blockTime: opts.blockTime }), db);
  }
  return assets;
}
const squadOf = (assets: string[]) => assets.slice(0, 3);
const commitFor = (nonce: Buffer) => sha256hex(nonce);

/** Queue two players and return the match (pairing is attempted on join). */
function pair(db: Db, a: { wallet: string; squad: string[] }, b: { wallet: string; squad: string[] }, t = Math.floor(Date.now() / 1000)) {
  const na = randomBytes(16), nb = randomBytes(16);
  arena.joinQueue(db, a.wallet, { squad: a.squad, commit: commitFor(na) }, t, t * 1000);
  const r = arena.joinQueue(db, b.wallet, { squad: b.squad, commit: commitFor(nb) }, t, t * 1000 + 10);
  // ratings may have drifted apart / the pair fought ≥ 3× today: let the queue widen past the bot-fill threshold
  const matchId = r.matchId ?? (arena.sweep(db, t + 46), arena.currentMatchFor(db, a.wallet)?.id ?? null);
  return { matchId: matchId!, na, nb };
}

describe('fusion planner', () => {
  let db: Db; let w: ReturnType<typeof world>;
  beforeEach(() => { db = new Db(':memory:'); w = world(); for (const t of w.txs) ingestTx(t, db); });

  it('recipes mirror packages/economy (8 steps, strings for u64)', () => {
    const r = fusion.recipes();
    expect(r).toHaveLength(8);
    expect(r[0]).toMatchObject({ from: 'Common', to: 'Common+', rule: 'any', successBps: 10_000, feeCgMicro: '2500000', boosterBonusBps: 1500, boosterCapBps: 9500 });
    expect(r[7]).toMatchObject({ from: 'Legend+', to: 'Diamond', rule: 'same-collection', successBps: 5_000, refundOnFail: 1, feeCgMicro: '6000000000' });
  });

  it('plan: 3 owned free commons → Common+ (atomic, no randomness, fee 2.5 $CG, PDAs derived)', () => {
    const assets = mint(db, w.bob, [{ rarity: 0, collection: 1 }, { rarity: 0, collection: 4 }, { rarity: 0, collection: 1 }]);
    const p = fusion.plan(db, w.bob, fusion.validatePlanRequest({ materials: assets, resultCollection: 4 }));
    expect(p).toMatchObject({ resultRarity: 'Common+', resultCollection: 4, successBps: 10_000, feeCgMicro: '2500000', needsRandomness: false, breaksSet: false });
    expect(p.materials.map((m) => m.asset)).toEqual(assets);
    expect(p.accounts.randomness).toBeUndefined();
    expect(Object.keys(p.accounts)).toEqual(expect.arrayContaining(['config', 'vault', 'items', 'pending', 'resultMeta', 'material0', 'chipState2', 'collectionMeta1', 'collectionMeta4']));
    expect(BigInt(p.nonce)).toBeGreaterThan(0n);
  });

  it('plan: same-collection step rejects mixed districts; any step rejects a result district not among the inputs', () => {
    const mixed = mint(db, w.bob, [{ rarity: 1, collection: 2 }, { rarity: 1, collection: 2 }, { rarity: 1, collection: 3 }]);
    expect(err(() => fusion.plan(db, w.bob, { materials: mixed })).code).toBe('collection_mismatch');
    const same = mint(db, w.bob, [{ rarity: 1, collection: 2 }, { rarity: 1, collection: 2 }, { rarity: 1, collection: 2 }]);
    expect(fusion.plan(db, w.bob, { materials: same, resultCollection: 9 })).toMatchObject({ resultCollection: 2, resultRarity: 'Rare' }); // forced to the shared district
    const anyStep = mint(db, w.bob, [{ rarity: 2, collection: 0 }, { rarity: 2, collection: 1 }, { rarity: 2, collection: 2 }]);
    expect(err(() => fusion.plan(db, w.bob, { materials: anyStep, resultCollection: 7 })).code).toBe('collection_mismatch');
  });

  it('plan: rarity mismatch, not owner, staked / listed / fusing / locked / duplicate / Diamond → 422 with the chain\'s reason', () => {
    const [a, b, c] = mint(db, w.bob, [{ rarity: 0, collection: 0 }, { rarity: 1, collection: 0 }, { rarity: 0, collection: 0 }]);
    expect(err(() => fusion.plan(db, w.bob, { materials: [a, b, c] })).code).toBe('rarity_mismatch');
    expect(err(() => fusion.plan(db, w.bob, { materials: [a, a, c] })).code).toBe('duplicate_material');
    expect(err(() => fusion.plan(db, w.alice, { materials: [a, b, c] })).message).toContain('not_owner');
    const [d] = mint(db, w.bob, [{ rarity: 0, collection: 0 }]);
    ingestTx(tx([{ program: 'staking', name: 'Staked', data: { owner: w.bob, kind: 1, key: d, amount: '1', weight: '1000000', unlockAt: '0' } }]), db);
    expect(err(() => fusion.plan(db, w.bob, { materials: [a, c, d] })).message).toContain('staked');
    const [e] = mint(db, w.bob, [{ rarity: 0, collection: 0 }]);
    ingestTx(tx([{ program: 'chip_core', name: 'ChipFlagsChanged', data: { asset: e, flags: 8, lockUntil: String(Math.floor(Date.now() / 1000) + 86_400) } }]), db);
    expect(err(() => fusion.plan(db, w.bob, { materials: [a, c, e] })).message).toContain('locked');
    const diamonds = mint(db, w.bob, [{ rarity: 8, collection: 0 }, { rarity: 8, collection: 0 }, { rarity: 8, collection: 0 }]);
    expect(err(() => fusion.plan(db, w.bob, { materials: diamonds })).code).toBe('no_recipe');
    expect(err(() => fusion.validatePlanRequest({ materials: [a, b] })).code).toBe('bad_materials');
  });

  it('plan: randomized recipe → randomness PDA + booster maths (+15 pp, cap 95 %) + escrow warning; breaksSet flags a completed set', () => {
    const epics = mint(db, w.bob, [{ rarity: 4, collection: 5 }, { rarity: 4, collection: 6 }, { rarity: 4, collection: 5 }]);
    const p = fusion.plan(db, w.bob, { materials: epics, useBooster: true });
    expect(p).toMatchObject({ successBps: 9_500, needsRandomness: true, resultRarity: 'Epic+' });
    expect(p.accounts.randomness).toBeDefined();
    expect(p.warnings).toContain('result_locked_21600s');
    // 85 % + 15 pp = 100 % → capped at 95 %
    expect(fusion.successBps(FUSION_RECIPES[4], true)).toBe(9_500);
    expect(fusion.successBps(FUSION_RECIPES[7], true)).toBe(6_500);
    expect(fusion.successBps(FUSION_RECIPES[0], true)).toBe(10_000);
    // a complete district set: fusing 3 of its commons (only copies) breaks it
    const full = mint(db, w.bob, Array.from({ length: 9 }, (_, r) => ({ rarity: r, collection: 7 })));
    const extra = mint(db, w.bob, [{ rarity: 0, collection: 7 }, { rarity: 0, collection: 7 }]);
    const p2 = fusion.plan(db, w.bob, { materials: [full[0], ...extra] });
    expect(p2.breaksSet).toBe(true);
    expect(p2.warnings).toContain('breaks_set');
  });

  it('suggest: groups free chips per recipe rule, keeps sets intact when protectSets, ignores busy chips', () => {
    // 3 commons of districts 0/1/2 + 3 Common+ of one district + 3 Common+ of mixed districts (not fusable together)
    mint(db, w.bob, [{ rarity: 0, collection: 0 }, { rarity: 0, collection: 1 }, { rarity: 0, collection: 2 }]);
    mint(db, w.bob, [{ rarity: 1, collection: 4 }, { rarity: 1, collection: 4 }, { rarity: 1, collection: 4 }]);
    mint(db, w.bob, [{ rarity: 1, collection: 5 }, { rarity: 1, collection: 6 }, { rarity: 1, collection: 7 }]);
    // district 0 is two tiers away from a full set → its only Common is set-critical
    mint(db, w.bob, Array.from({ length: 6 }, (_, i) => ({ rarity: i + 3, collection: 0 })));
    const s = fusion.suggest(db, w.bob, false);
    expect(s.map((x) => x.resultRarity).sort()).toEqual(['Common+', 'Rare']);
    // with set protection the district-0 Common is kept → only two spare commons → only the Common+ triple remains
    const guarded = fusion.suggest(db, w.bob, true);
    expect(guarded.map((x) => x.resultRarity)).toEqual(['Rare']);
    // staked chips never appear
    const staked = mint(db, w.bob, [{ rarity: 3, collection: 9 }, { rarity: 3, collection: 9 }, { rarity: 3, collection: 9 }]);
    ingestTx(tx([{ program: 'staking', name: 'Staked', data: { owner: w.bob, kind: 1, key: staked[0], amount: '1', weight: '1', unlockAt: '0' } }]), db);
    expect(fusion.suggest(db, w.bob, false).some((x) => x.resultRarity === 'Epic')).toBe(false);
  });
});

describe('staking read-model', () => {
  let db: Db; let w: ReturnType<typeof world>;
  beforeEach(() => { db = new Db(':memory:'); w = world(); for (const t of w.txs) ingestTx(t, db); });

  it('overview before the first tick_day: schedule floor (30 %), pool totals from Staked events, split 30/15/17/23/15', () => {
    const o = staking.overview(db);
    expect(o.emission.source).toBe('schedule');
    expect(BigInt(o.emission.scheduleCapMicro) * 3n - BigInt(o.emission.guardedMicro) * 10n).toBeLessThan(10n); // floor(cap × 0.30)
    expect(o.emission.splitBps).toEqual([3000, 1500, 1700, 2300, 1500]);
    expect(o.tokenPool).toMatchObject({ tvlMicro: '500000000', totalWeight: '750000000' });
    expect(o.chipPool).toMatchObject({ stakedChips: 1, totalWeight: '2000' });
    expect(BigInt(o.tokenPool.budgetTodayMicro)).toBe((BigInt(o.emission.guardedMicro) * 15n) / 100n);
    expect(o.tokenPool.apyByTier).toHaveLength(4);
    expect(o.tokenPool.apyByTier[3]).toBeGreaterThan(o.tokenPool.apyByTier[0]);
  });

  it('overview after DayClosed uses the chain numbers', () => {
    ingestTx(tx([{ program: 'staking', name: 'DayClosed', data: { dayIndex: 12, year: 0, scheduleCap: '271232876712', guarded: '150000000000', burn7dAvg: '40000000000', sliceBudget: ['0', '0', '1', '2', '3'] } }]), db);
    const o = staking.overview(db);
    expect(o.emission).toMatchObject({ dayIndex: 12, guardedMicro: '150000000000', burn7dAvgMicro: '40000000000', source: 'chain' });
    expect(o.chipPool.budgetTodayMicro).toBe('45000000000');
  });

  it('me: token stake tier from the PDA, penalty while locked, pending = share of the emitted budget since the stake opened (0 before any DayClosed)', () => {
    const owner = Keypair.generate().publicKey;
    const t = Math.floor(Date.now() / 1000);
    const key = staking.tokenStakePda(owner, 2).toBase58();
    ingestTx(tx([{ program: 'staking', name: 'Staked', data: { owner: owner.toBase58(), kind: 0, key, amount: '1000000000', weight: '2200000000', unlockAt: String(t + 80 * 86_400) } }], { blockTime: t - 3 * 86_400 }), db);
    let m = staking.me(db, owner.toBase58());
    expect(m.tokenStakes[0]).toMatchObject({ tier: 2, amount: '1000000000', weight: '2200000000', earlyExitPenalty: '100000000', pending: '0' });
    expect(m.pendingEstimated).toBe(true);
    // a day closed 2 days ago with a 100 $CG guarded budget → token pool got 15 $CG over 24 h; this stake holds 2.2e9 of 2.95e9 weight
    ingestTx(tx([{ program: 'staking', name: 'DayClosed', data: { dayIndex: 1, year: 0, scheduleCap: '271232876712', guarded: '100000000', burn7dAvg: '0', sliceBudget: ['0', '0', '0', '0', '0'] } }], { blockTime: t - 2 * 86_400 }), db);
    m = staking.me(db, owner.toBase58());
    const expected = (2_200_000_000n * 15_000_000n) / 2_950_000_000n;
    expect(BigInt(m.tokenStakes[0].pending)).toBe(expected);
    expect(m.totalPendingMicro).toBe(expected.toString());
    // set bonus: on-chain 0 sets vs computed 0 → no sync pending; after a full set arrives it flips
    expect(m.setBonus).toMatchObject({ onChainSets: 0, computedSets: 0, multBps: 10_000, syncPending: false });
    mint(db, owner.toBase58(), Array.from({ length: 9 }, (_, r) => ({ rarity: r, collection: 2 })));
    expect(staking.me(db, owner.toBase58()).setBonus).toMatchObject({ computedSets: 1, syncPending: true });
    ingestTx(tx([{ program: 'staking', name: 'SetBonusSynced', data: { owner: owner.toBase58(), sets: 1 } }]), db);
    expect(staking.me(db, owner.toBase58()).setBonus).toMatchObject({ onChainSets: 1, multBps: 11_200, syncPending: false });
  });

  it('estimate: validates tier/amount; APY falls as the amount grows (pro-rata pool); chip weight mirrors staking::chip_weight', () => {
    expect(err(() => staking.validateEstimate({ amountCgMicro: '1000000', tier: 4 })).code).toBe('bad_tier');
    expect(err(() => staking.validateEstimate({ amountCgMicro: 'abc', tier: 1 })).code).toBe('bad_amount');
    const small = staking.estimate(db, staking.validateEstimate({ amountCgMicro: '1000000000', tier: 3 }));
    const big = staking.estimate(db, staking.validateEstimate({ amountCgMicro: '100000000000000', tier: 3 }));
    expect(small.apyPct).toBeGreaterThan(big.apyPct);
    expect(small).toMatchObject({ earlyExitPenaltyBps: 1500, boostBps: 30_000, indicativeApyRange: [36, 90] });
    // Common lvl 1, 0 sets → 1e6; Rare lvl 5, 2 sets → 5e6 × 1.1 × 1.24
    expect(staking.chipWeightRaw(0, 1, 0)).toBe(1_000_000n);
    expect(staking.chipWeightRaw(2, 5, 2)).toBe((5_000_000n * 11_000n) / 10_000n * 12_400n / 10_000n);
    expect(staking.setBonusMultBps(10)).toBe(17_000);
  });
});

describe('arena — ranked commit/reveal', () => {
  let db: Db; let alice: string; let bob: string; let sa: string[]; let sb: string[];
  const T = 1_800_000_000; // fixed "now" (s) so days/seasons are deterministic
  beforeEach(() => {
    db = new Db(':memory:');
    alice = kp(); bob = kp();
    sa = squadOf(mint(db, alice, [{ rarity: 2, collection: 0 }, { rarity: 2, collection: 1 }, { rarity: 1, collection: 2 }], { blockTime: T - 3 * 86_400 }));
    sb = squadOf(mint(db, bob, [{ rarity: 2, collection: 3 }, { rarity: 1, collection: 4 }, { rarity: 2, collection: 5 }], { blockTime: T - 3 * 86_400 }));
  });

  it('season: created on first touch with a public hash and a private secret; previous season secret revealed after it ends', () => {
    const s = arena.seasonApi(db, T);
    expect(s.serverSecret).toBeNull();
    expect(s.serverSecretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(s.endsAt) - Date.parse(s.startsAt)).toBe(arena.SEASON_SECONDS * 1000);
    const row = arena.currentSeason(db, T);
    expect(sha256hex(Buffer.from(row.server_secret, 'hex'))).toBe(row.server_secret_hash);
    const next = arena.seasonApi(db, T + arena.SEASON_SECONDS + 5);
    expect(next.id).toBe(s.id + 1);
    expect(next.previous).toMatchObject({ id: s.id, serverSecretHash: s.serverSecretHash, serverSecret: row.server_secret });
  });

  it('season pool = 20 % rake from resolved wager battles + 40 % of each day\'s pvpSeason slice (guarded × 23 %), never the cumulative slice_budget', () => {
    const s = arena.currentSeason(db, T);
    ingestTx(tx([{ program: 'staking', name: 'DayClosed', data: { dayIndex: 1, year: 0, scheduleCap: '271232876712', guarded: '100000000000', burn7dAvg: '0', sliceBudget: ['0', '0', '0', '999999999999', '0'] } }], { blockTime: s.starts_at + 86_400 }), db);
    ingestTx(tx([{ program: 'staking', name: 'DayClosed', data: { dayIndex: 2, year: 0, scheduleCap: '271232876712', guarded: '100000000000', burn7dAvg: '0', sliceBudget: ['0', '0', '0', '999999999999', '0'] } }], { blockTime: s.starts_at + 2 * 86_400 }), db);
    ingestTx(tx([{ program: 'arena', name: 'BattleResolved', data: { battle: kp(), winner: alice, pot: '100000000', rakeBurn: '2000000', rakePool: '1000000', rakeTreasury: '2000000', resultHash: hex32(0x22), roll: hex32(0x33) } }], { blockTime: s.starts_at + 3 * 86_400 }), db);
    // 2 days × 100 $CG × 23 % × 40 % = 18.4 $CG + 1 $CG rake pool
    expect(arena.seasonApi(db, T).poolCgMicro).toBe(String(2 * 9_200_000_000 + 1_000_000));
  });

  it('SEC-L5: settlement freezes the rake share (finalized battles of the season only) next to the emission share; an unfinalized BattleResolved postpones it', () => {
    const s = arena.currentSeason(db, T);
    // a qualified player: 12 non-forfeit games
    let t = T;
    for (let i = 0; i < 12; i++) {
      const o = kp(); const so = squadOf(mint(db, o, [{ rarity: 1, collection: 1 }, { rarity: 1, collection: 2 }, { rarity: 1, collection: 3 }]));
      const { matchId, na, nb } = pair(db, { wallet: alice, squad: sa }, { wallet: o, squad: so }, t);
      arena.reveal(db, alice, matchId, { nonce: na.toString('hex') }, t); arena.reveal(db, o, matchId, { nonce: nb.toString('hex') }, t); t += 60;
    }
    ingestTx(tx([{ program: 'staking', name: 'DayClosed', data: { dayIndex: 1, year: 0, scheduleCap: '271232876712', guarded: '100000000000', burn7dAvg: '0', sliceBudget: ['0', '0', '0', '0', '0'] } }], { blockTime: s.starts_at + 86_400 }), db);
    // two wager battles inside the season (rake_pool 1 + 3 $CG) and one resolved after it ends (belongs to the next season)
    ingestTx(tx([{ program: 'arena', name: 'BattleResolved', data: { battle: kp(), winner: alice, pot: '100000000', rakeBurn: '2000000', rakePool: '1000000', rakeTreasury: '2000000', resultHash: hex32(0x22), roll: hex32(0x33) } }], { blockTime: s.starts_at + 2 * 86_400 }), db);
    ingestTx(tx([{ program: 'arena', name: 'BattleResolved', data: { battle: kp(), winner: alice, pot: '300000000', rakeBurn: '6000000', rakePool: '3000000', rakeTreasury: '6000000', resultHash: hex32(0x22), roll: hex32(0x33) } }], { blockTime: s.starts_at + 3 * 86_400 }), db);
    ingestTx(tx([{ program: 'arena', name: 'BattleResolved', data: { battle: kp(), winner: alice, pot: '100000000', rakeBurn: '2000000', rakePool: '1000000', rakeTreasury: '2000000', resultHash: hex32(0x22), roll: hex32(0x33) } }], { blockTime: s.ends_at + 10 }), db);
    expect(arena.seasonPoolMicro(db, s)).toBe(9_200_000_000n + 4_000_000n); // live estimate: 100 × 23 % × 40 % + 4 $CG rake
    const end = s.ends_at + 1;
    expect(arena.settleSeason(db, s.id, end)).toBeUndefined(); // BattleResolved not finalized → wait
    finalizeAll(db);
    const r = arena.settleSeason(db, s.id, end)!;
    expect(r.rakeMicro).toBe(4_000_000n);
    const row = db.get<{ pool_micro: string; rake_micro: string; rake_funded_at: number | null }>(`SELECT pool_micro, rake_micro, rake_funded_at FROM seasons WHERE id = ?`, s.id)!;
    expect(row).toMatchObject({ pool_micro: String(9_200_000_000 + 4_000_000), rake_micro: '4000000', rake_funded_at: null });
    // 1 of 1000 → 1/1000 of the whole pool (rake included) goes to rank 1
    expect(r.paidMicro).toBe((9_200_000_000n + 4_000_000n) / 1000n);
    expect(oracle.unfundedRake(db)).toMatchObject({ targetMicro: 4_000_000n, seasons: [s.id] });
    const api = arena.seasonApi(db, end + 5);
    expect(api.previous).toMatchObject({ id: s.id, settled: true, rakeMicro: '4000000', rakeFunded: false });
  });

  it('a live-ingested BattleResolved (block_time still NULL) above the horizon postpones the settlement too', () => {
    const s = arena.currentSeason(db, T);
    // websocket-first ingestion: the event is in `events_raw` but the timed re-read has not healed its
    // block_time yet. It *may* belong to the season (we cannot tell from a NULL), so freezing the pool
    // now would price the season off an incomplete rake sum — the settlement must wait.
    ingestTx(tx([{ program: 'arena', name: 'BattleResolved', data: { battle: kp(), winner: kp(), pot: '100000000', rakeBurn: '2000000', rakePool: '1000000', rakeTreasury: '2000000', resultHash: hex32(0x22), roll: hex32(0x33) } }], { blockTime: null }), db);
    expect(arena.settleSeason(db, s.id, s.ends_at + 1)).toBeUndefined();
    // once the timed re-read heals the time and the event is finalized, the season settles as before
    db.run(`UPDATE events_raw SET block_time = ? WHERE name = 'BattleResolved'`, s.starts_at + 86_400);
    finalizeAll(db);
    expect(arena.settleSeason(db, s.id, s.ends_at + 1)).toBeDefined();
  });

  it('queue validation mirrors validate_squad: 3 distinct owned chips, not listed/fusing, power ≥ 400, commit = 32-byte hex', () => {
    const c = commitFor(randomBytes(16));
    expect(err(() => arena.joinQueue(db, alice, { squad: sa.slice(0, 2), commit: c }, T)).code).toBe('bad_squad');
    expect(err(() => arena.joinQueue(db, alice, { squad: [sa[0], sa[0], sa[1]], commit: c }, T)).code).toBe('duplicate_chip');
    expect(err(() => arena.joinQueue(db, alice, { squad: sb, commit: c }, T)).code).toBe('not_owner');
    expect(err(() => arena.joinQueue(db, alice, { squad: sa, commit: 'zz' }, T)).code).toBe('bad_commit');
    expect(err(() => arena.joinQueue(db, alice, { squad: sa, commit: c, wagerCgMicro: '5000000' }, T)).code).toBe('wager_is_on_chain');
    const weak = mint(db, alice, [{ rarity: 0, collection: 0 }, { rarity: 0, collection: 0 }, { rarity: 0, collection: 0 }]);
    expect(err(() => arena.joinQueue(db, alice, { squad: weak, commit: c }, T)).code).toBe('squad_too_weak');
    ingestTx(tx([{ program: 'market', name: 'ChipListed', data: { asset: sa[0], seller: alice, price: '1', currency: 0 } }]), db);
    expect(err(() => arena.joinQueue(db, alice, { squad: sa, commit: c }, T)).code).toBe('chip_busy');
  });

  it('join → pair in the same league → both reveal → deterministic resolution, ratings, rewards; the record is auditable', () => {
    const r1 = arena.joinQueue(db, alice, { squad: sa, commit: commitFor(Buffer.from('aa'.repeat(16), 'hex')) }, T, T * 1000);
    expect(r1.matchId).toBeNull();
    expect(r1.league).toBe(0); // 210+210+145 = 565 < 800
    expect(arena.arenaMe(db, alice, T).queue?.ticket).toBe(r1.ticket);
    const nb = randomBytes(16);
    const r2 = arena.joinQueue(db, bob, { square: 1, squad: sb, commit: commitFor(nb) } as never, T, T * 1000 + 500);
    expect(r2.matchId).toBeTruthy();
    expect(r2.estimatedWaitSec).toBe(0);
    expect(db.scalar(`SELECT COUNT(*) FROM arena_queue`)).toBe(0);
    const id = r2.matchId!;
    // nobody can see the other side's nonce before both revealed; the seed is hidden
    const pre = arena.matchApi(db, id, bob)!;
    expect(pre.status).toBe('revealing');
    expect(pre.seed).toBeNull();
    // wrong nonce → commit mismatch; alice reveals, bob must reveal too
    expect(err(() => arena.reveal(db, alice, id, { nonce: 'bb'.repeat(16) }, T)).code).toBe('commit_mismatch');
    expect(err(() => arena.reveal(db, kp(), id, { nonce: 'aa'.repeat(16) }, T)).code).toBe('not_a_player');
    expect(arena.reveal(db, alice, id, { nonce: 'aa'.repeat(16) }, T)).toMatchObject({ resolved: false, waitingFor: 'b' });
    expect(arena.arenaMe(db, alice, T).currentMatch).toMatchObject({ id, iRevealed: true, opponent: bob });
    const done = arena.reveal(db, bob, id, { nonce: nb.toString('hex') }, T);
    expect(done.resolved).toBe(true);
    const m = arena.matchApi(db, id)!;
    expect(m.status).toBe('resolved');
    expect([alice, bob]).toContain(m.winner);
    expect(m.rounds.length).toBeGreaterThanOrEqual(2);
    // re-derive the seed and the fight from the public record + the season secret
    const season = arena.currentSeason(db, T);
    const seed = arena.matchSeed(id, m.nonceA!, m.nonceB!, season.server_secret);
    expect(seed.toString('hex')).toBe(m.seed);
    const replay = resolveFight(m.squadA.map((c) => ({ asset: c.asset, collection: c.collection, rarity: c.rarity, level: c.level })), m.squadB.map((c) => ({ asset: c.asset, collection: c.collection, rarity: c.rarity, level: c.level })), arena.rollFromSeed(seed));
    expect(replay.rounds.map((r) => r.winner)).toEqual(m.rounds.map((r) => (r.winner === alice ? 'A' : 'B')));
    expect(replay.winner === 'A' ? alice : bob).toBe(m.winner);
    // ratings moved symmetrically (K = 40, both at 1000 → ±20), rewards 2 / 0.5 $CG
    const ra = arena.rating(db, alice, season.id), rb = arena.rating(db, bob, season.id);
    expect(ra.games).toBe(1); expect(rb.games).toBe(1);
    expect(Math.round(Math.abs(ra.rating - 1000))).toBe(20);
    expect(ra.rating + rb.rating).toBeCloseTo(2000, 6);
    const winnerReward = m.winner === alice ? m.rewardA : m.rewardB, loserReward = m.winner === alice ? m.rewardB : m.rewardA;
    expect(winnerReward).toBe(String(MATCH_REWARDS.winCgMicro));
    expect(loserReward).toBe(String(MATCH_REWARDS.lossCgMicro));
    expect(arena.arenaMe(db, alice, T)).toMatchObject({ games: 1, rewardedMatchesLeft: 7, currentMatch: null });
    expect(arena.arenaMe(db, m.winner!, T).wins).toBe(1);
    // the public rating board is this ladder: winner first, league column, `me` ranks the loser second; the previous season is addressable
    const lb = q.leaderboard(db, 'rating', 10, undefined, m.winner === alice ? bob : alice, season.id);
    expect(lb.season).toBe(season.id);
    expect(lb.items.map((r) => r.wallet)).toEqual([m.winner, m.winner === alice ? bob : alice]);
    expect(lb.items[0]).toMatchObject({ rank: 1, value: 1020, league: 0 });
    expect(lb.me).toEqual({ rank: 2, value: 980 });
    expect(q.leaderboard(db, 'rating', 10, undefined, undefined, season.id - 1).items).toEqual([]);
    // idempotent reveal after resolution
    expect(arena.reveal(db, alice, id, { nonce: 'aa'.repeat(16) }, T)).toMatchObject({ resolved: true });
  });

  it('pairing respects league bands and the rating spread widening over time', () => {
    const carol = kp();
    const strong = squadOf(mint(db, carol, [{ rarity: 6, collection: 0 }, { rarity: 6, collection: 1 }, { rarity: 6, collection: 2 }])); // 2790 → league 3
    arena.joinQueue(db, alice, { squad: sa, commit: commitFor(randomBytes(16)) }, T, T * 1000);
    expect(arena.joinQueue(db, carol, { squad: strong, commit: commitFor(randomBytes(16)) }, T, T * 1000).matchId).toBeNull();
    // same league but 200 rating apart: not paired at t=0 (spread 25), paired once the queue widened (5/s → 35 s)
    db.run(`INSERT INTO ratings (wallet, season, rating, games) VALUES (?, ?, 1200, 40)`, bob, arena.currentSeason(db, T).id);
    expect(arena.joinQueue(db, bob, { squad: sb, commit: commitFor(randomBytes(16)) }, T, T * 1000 + 1_000).matchId).toBeNull();
    expect(arena.sweep(db, T + 10, T * 1000 + 10_000).paired).toBe(0);
    expect(arena.sweep(db, T + 40, T * 1000 + 40_000).paired).toBe(1);
    expect(db.scalar(`SELECT COUNT(*) FROM matches`)).toBe(1);
    expect(db.scalar(`SELECT COUNT(*) FROM arena_queue`)).toBe(1); // carol still waiting in league 3
  });

  it('bot fill after 45 s: bot squad in the same power band, bot reveals instantly, participation reward only, rating still moves', () => {
    arena.joinQueue(db, alice, { squad: sa, commit: commitFor(Buffer.from('cc'.repeat(16), 'hex')) }, T, T * 1000);
    expect(arena.sweep(db, T + 30, T * 1000 + 30_000).bots).toBe(0);
    expect(arena.sweep(db, T + 46, T * 1000 + 46_000).bots).toBe(1);
    const me = arena.arenaMe(db, alice, T + 46);
    expect(me.currentMatch?.opponent).toMatch(/^bot:/);
    const id = me.currentMatch!.id;
    const pre = arena.matchApi(db, id)!;
    // a synthetic bot chip has no on-chain number: `index: null` (the UI drops the `#N`), never a
    // placeholder `#0` — that is a real chip of the district (SEC-B3)
    expect(pre.squadB.every((c) => c.index === null)).toBe(true);
    const botPower = onChainSquadPower(pre.squadB.map((c) => ({ asset: c.asset, collection: c.collection, rarity: c.rarity, level: c.level })));
    expect(Math.abs(botPower - pre.powerA) / pre.powerA).toBeLessThan(0.1);
    expect(arena.leagueOf(botPower)).toBe(arena.leagueOf(pre.powerA));
    expect(pre.powerB).toBe(botPower);
    const r = arena.reveal(db, alice, id, { nonce: 'cc'.repeat(16) }, T + 50);
    expect(r.resolved).toBe(true);
    const m = arena.matchApi(db, id)!;
    expect(m.bot).toBe(true);
    expect(m.rewardA).toBe(String(MATCH_REWARDS.lossCgMicro)); // vs bot: participation only, win or lose
    expect(m.rewardB).toBe('0');
    expect(arena.rating(db, alice, m.season).games).toBe(1);
    expect(db.scalar(`SELECT COUNT(*) FROM ratings WHERE wallet LIKE 'bot:%'`)).toBe(0);
  });

  it('SEC-F11 bot farming: a mono-element squad beats power-matched bots ~67 %, but 300 bot games cannot push the rating past start + 350', () => {
    // three Rares of one element (collections 1 / 3 / 7 = wheels): synergy ×1.16 vs random-element bots
    const mono = mint(db, alice, [{ rarity: 2, collection: 1 }, { rarity: 2, collection: 3 }, { rarity: 2, collection: 7 }]);
    let t = T, wins = 0;
    for (let i = 0; i < 300; i++) {
      const nonce = randomBytes(16);
      arena.joinQueue(db, alice, { squad: mono, commit: commitFor(nonce) }, t, t * 1000);
      expect(arena.sweep(db, t + 46, (t + 46) * 1000).bots).toBe(1);
      const id = arena.currentMatchFor(db, alice)!.id;
      expect(arena.reveal(db, alice, id, { nonce: nonce.toString('hex') }, t + 50, (t + 50) * 1000).resolved).toBe(true);
      if (arena.matchApi(db, id)!.winner === alice) wins++;
      t += 60;
    }
    const season = arena.currentSeason(db, t).id;
    const me = arena.rating(db, alice, season);
    expect(me.games).toBe(300);
    expect(wins / 300).toBeGreaterThan(0.55); // the edge is real — the rating rule is what has to absorb it
    // old rule (bot rated at the player's own rating): median ≈ 2 100 after 300 games; fixed BOT_RATING: ≈ 1 120, max ≈ 1 300
    expect(me.rating).toBeLessThan(MATCHMAKING.startRating + 350);
  });

  it('forfeit: the side that revealed wins after REVEAL_TIMEOUT (no rewards); nobody revealed → cancelled', () => {
    const { matchId, na } = pair(db, { wallet: alice, squad: sa }, { wallet: bob, squad: sb }, T);
    arena.reveal(db, alice, matchId, { nonce: na.toString('hex') }, T + 5);
    expect(arena.sweep(db, T + 60, (T + 60) * 1000).forfeits).toBe(0);
    expect(arena.sweep(db, T + arena.REVEAL_TIMEOUT_S + 1, (T + arena.REVEAL_TIMEOUT_S + 1) * 1000).forfeits).toBe(1);
    const m = arena.matchApi(db, matchId)!;
    expect(m).toMatchObject({ status: 'resolved', forfeit: true, winner: alice, rewardA: '0', rewardB: '0' });
    expect(arena.rating(db, bob, m.season).rating).toBeLessThan(1000);
    // second match, nobody reveals
    const second = pair(db, { wallet: alice, squad: sa }, { wallet: bob, squad: sb }, T + 300);
    arena.sweep(db, T + 300 + arena.REVEAL_TIMEOUT_S + 1, (T + 300 + arena.REVEAL_TIMEOUT_S + 1) * 1000);
    expect(arena.matchApi(db, second.matchId)!.status).toBe('cancelled');
    // a player with a match still in 'revealing' cannot queue again
    const third = pair(db, { wallet: alice, squad: sa }, { wallet: bob, squad: sb }, T + 900);
    expect(third.matchId).toBeTruthy();
    expect(err(() => arena.joinQueue(db, alice, { squad: sa, commit: commitFor(randomBytes(16)) }, T + 901)).code).toBe('match_pending');
  });

  it('anti-farm: 8 rewarded matches per day, ≤ 3 rewarded vs the same wallet, squad < 400 power earns nothing', () => {
    let t = T;
    const play = () => { const { matchId, na, nb } = pair(db, { wallet: alice, squad: sa }, { wallet: bob, squad: sb }, t); arena.reveal(db, alice, matchId, { nonce: na.toString('hex') }, t); arena.reveal(db, bob, matchId, { nonce: nb.toString('hex') }, t); t += 60; return arena.matchApi(db, matchId)!; };
    const results = Array.from({ length: 4 }, play);
    expect(results.slice(0, 3).every((m) => m.rewardA !== '0' && m.rewardB !== '0')).toBe(true);
    expect(results[3]).toMatchObject({ rewardA: '0', rewardB: '0' }); // 4th vs the same opponent today
    // 5 more vs distinct opponents → alice hits the daily cap of 8 rewarded matches
    for (let i = 0; i < 6; i++) {
      const o = kp();
      const so = squadOf(mint(db, o, [{ rarity: 2, collection: 1 }, { rarity: 2, collection: 2 }, { rarity: 1, collection: 3 }]));
      const { matchId, na, nb } = pair(db, { wallet: alice, squad: sa }, { wallet: o, squad: so }, t);
      arena.reveal(db, alice, matchId, { nonce: na.toString('hex') }, t); arena.reveal(db, o, matchId, { nonce: nb.toString('hex') }, t); t += 60;
      const m = arena.matchApi(db, matchId)!;
      expect(m.rewardA !== '0').toBe(i < 5); // rewarded matches 4..8, then capped
      expect(m.rewardB).not.toBe('0');
    }
    expect(arena.arenaMe(db, alice, t).rewardedMatchesLeft).toBe(0);
    expect(db.scalar(`SELECT COUNT(*) FROM pvp_rewards WHERE wallet = ?`, alice)).toBe(MATCH_REWARDS.dailyRewardedMatches);
    // next day the counter resets
    expect(arena.arenaMe(db, alice, t + 86_400).rewardedMatchesLeft).toBe(MATCH_REWARDS.dailyRewardedMatches);
  });

  it('season settlement: only wallets with ≥ 10 non-forfeit games qualify, brackets split the frozen emission share, payouts flow into the kind-3 batch', () => {
    const s = arena.currentSeason(db, T);
    // 5 closed days × 100 $CG guarded → 5 × 100 × 23 % × 40 % = 46 $CG ladder pool
    for (let d = 1; d <= 5; d++) ingestTx(tx([{ program: 'staking', name: 'DayClosed', data: { dayIndex: d, year: 0, scheduleCap: '271232876712', guarded: '100000000000', burn7dAvg: '0', sliceBudget: ['0', '0', '0', '0', '0'] } }], { blockTime: s.starts_at + d * 86_400 }), db);
    // alice vs 12 distinct opponents (each plays once) → alice qualifies, nobody else does
    let t = T;
    for (let i = 0; i < 12; i++) {
      const o = kp(); const so = squadOf(mint(db, o, [{ rarity: 1, collection: 1 }, { rarity: 1, collection: 2 }, { rarity: 1, collection: 3 }]));
      const { matchId, na, nb } = pair(db, { wallet: alice, squad: sa }, { wallet: o, squad: so }, t);
      arena.reveal(db, alice, matchId, { nonce: na.toString('hex') }, t); arena.reveal(db, o, matchId, { nonce: nb.toString('hex') }, t); t += 60;
    }
    expect(arena.settleSeason(db, s.id, t)).toBeUndefined(); // not over yet
    const end = s.ends_at + 1;
    // SEC-M5 / #9: the pool is frozen from FINALIZED DayClosed events only — while one is pending the settlement waits
    expect(arena.settleSeason(db, s.id, end)).toBeUndefined();
    expect(arena.unsettledSeasons(db, end)).toEqual([s.id]);
    finalizeAll(db);
    const r = arena.settleSeason(db, s.id, end)!;
    expect(r).toMatchObject({ season: s.id, participants: 1, rows: 1, rakeMicro: 0n });
    // 1 qualified of 1000 needed → pool × 1/1000 × 100 % (all bands roll up to rank 1)
    expect(r.paidMicro).toBe((46_000_000_000n * 1n) / 1000n);
    const row = db.get<{ wallet: string; rank: number; amount: string }>(`SELECT wallet, rank, amount FROM season_payouts WHERE season = ?`, s.id)!;
    expect(row).toMatchObject({ wallet: alice, rank: 1, amount: r.paidMicro.toString() });
    expect(arena.settleSeason(db, s.id, end + 5)!.rows).toBe(0); // idempotent
    expect(arena.unsettledSeasons(db, end)).toEqual([]);
    expect(arena.seasonApi(db, end + arena.SEASON_SECONDS / 2).previous).toMatchObject({ id: s.id, settled: true, paidPoolMicro: '46000000000' });
    // the payout joins the next kind-3 batch together with match rewards
    const me = arena.arenaMe(db, alice, end);
    expect(BigInt(me.pendingRewardMicro)).toBe(r.paidMicro + BigInt(db.all<{ amount: string }>(`SELECT amount FROM pvp_rewards WHERE wallet = ?`, alice).reduce((a, x) => a + Number(x.amount), 0)));
    expect(me.lastSeasonPayout).toMatchObject({ season: s.id, rank: 1 });
  });

  it('simulate: probabilities from the shared engine, spec squads allowed, league per side', () => {
    const s = arena.simulate(db, { squadA: sa, squadB: [{ collection: 0, rarity: 8, level: 1 }, { collection: 1, rarity: 8, level: 1 }, { collection: 2, rarity: 8, level: 1 }] });
    expect(s.pWinA).toBeLessThan(0.05);
    expect(s).toMatchObject({ powerA: 565, powerB: 6000, leagueA: 0, leagueB: 4 });
    expect(s.sampleRounds.length).toBeGreaterThanOrEqual(2);
    expect(err(() => arena.simulate(db, { squadA: sa, squadB: [{ collection: 11, rarity: 0, level: 1 }, {}, {}] })).code).toBe('bad_chip');
    // identical squads → 50 %
    expect(arena.simulate(db, { squadA: sa, squadB: sa }).pWinA).toBeCloseTo(0.5, 2);
    expect(MATCHMAKING.startRating).toBe(1000);
  });
});

describe('quests', () => {
  let db: Db; let alice: string; let bob: string; let sa: string[]; let sb: string[];
  const T = 1_800_000_000 + 12 * 3600; // noon so the day does not roll during the test
  beforeEach(() => {
    db = new Db(':memory:');
    alice = kp(); bob = kp();
    sa = squadOf(mint(db, alice, [{ rarity: 2, collection: 0 }, { rarity: 2, collection: 1 }, { rarity: 1, collection: 2 }], { blockTime: T - 3 * 86_400 }));
    sb = squadOf(mint(db, bob, [{ rarity: 2, collection: 3 }, { rarity: 1, collection: 4 }, { rarity: 2, collection: 5 }], { blockTime: T - 3 * 86_400 }));
  });
  const playMatch = (t: number) => { const { matchId, na, nb } = pair(db, { wallet: alice, squad: sa }, { wallet: bob, squad: sb }, t); arena.reveal(db, alice, matchId, { nonce: na.toString('hex') }, t); arena.reveal(db, bob, matchId, { nonce: nb.toString('hex') }, t); return arena.matchApi(db, matchId)!; };

  it('progress comes from events: login, matches, wins, fusions, trades; periods reset; permanent milestones accumulate', () => {
    const list0 = quests.list(db, alice, T);
    expect(list0).toHaveLength(DAILY_QUESTS.length + WEEKLY_QUESTS.length + 6);
    expect(list0.find((q) => q.id === 'd_login')).toMatchObject({ value: 0, claimable: false, ineligibleReason: null }); // paid pack (sku 1) → eligible
    quests.recordLogin(db, alice, T);
    expect(quests.list(db, alice, T).find((q) => q.id === 'd_login')).toMatchObject({ value: 1, claimable: true });
    let wins = 0;
    for (let i = 0; i < 3; i++) { const m = playMatch(T + i * 60); if (m.winner === alice) wins++; }
    const l = quests.list(db, alice, T + 200);
    expect(l.find((q) => q.id === 'd_pvp3')).toMatchObject({ value: 3, claimable: true });
    expect(l.find((q) => q.id === 'd_win1')!.value).toBe(Math.min(1, wins));
    expect(l.find((q) => q.id === 'w_pvp20')!.value).toBe(3);
    expect(l.find((q) => q.id === 'p_win50')!.value).toBe(wins);
    // yesterday's matches do not count for today's daily but do for the week (same week only if the day is not Monday)
    expect(quests.metricValue(db, alice, 'pvp_played', quests.periodStart(DAILY_QUESTS[1], T + 86_400), quests.periodEnd(DAILY_QUESTS[1], T + 86_400), T + 86_400)).toBe(0);
    // fusion + trade
    const mats = mint(db, alice, [{ rarity: 0, collection: 0 }, { rarity: 0, collection: 0 }, { rarity: 0, collection: 0 }]);
    ingestTx(tx([{ program: 'chip_core', name: 'ChipFused', data: { owner: alice, recipe: 0, materials: mats, result: kp(), success: true, rollBps: 0, thresholdBps: 10000, feeBurned: '2500000' } }], { blockTime: T + 300 }), db);
    ingestTx(tx([{ program: 'market', name: 'ChipSold', data: { asset: sb[0], seller: bob, buyer: alice, price: '1', currency: 0, fee: '0', royalty: '0', viaOffer: false } }], { blockTime: T + 301 }), db);
    const l2 = quests.list(db, alice, T + 400);
    expect(l2.find((q) => q.id === 'd_fuse1')).toMatchObject({ value: 1, claimable: true });
    expect(l2.find((q) => q.id === 'p_first_fusion')).toMatchObject({ value: 1, claimable: true });
    expect(l2.find((q) => q.id === 'w_trade')).toMatchObject({ value: 1, claimable: true });
    expect(l2.find((q) => q.id === 'p_set1')!.value).toBe(0);
  });

  it('eligibility: new wallet without a paid pack is ineligible until 24 h + 10 matches; rewards_paused flag blocks; caps apply on settlement', () => {
    const newbie = kp();
    db.run(`INSERT INTO wallets (address, first_seen) VALUES (?, ?)`, newbie, T - 3600);
    expect(quests.eligibility(db, newbie, T)).toMatchObject({ eligible: false, reason: 'account_too_new', hasPaidPack: false });
    db.run(`UPDATE wallets SET first_seen = ? WHERE address = ?`, T - 2 * 86_400, newbie);
    expect(quests.eligibility(db, newbie, T)).toMatchObject({ eligible: false, reason: 'play_10_matches_or_buy_a_pack' });
    db.run(`UPDATE wallets SET flags = '{"rewardsPaused":true}' WHERE address = ?`, alice);
    expect(quests.eligibility(db, alice, T)).toMatchObject({ eligible: false, reason: 'rewards_paused' });
    db.run(`UPDATE wallets SET flags = '{}' WHERE address = ?`, alice);
    expect(quests.eligibility(db, alice, T).eligible).toBe(true);
    // settlement with caps: complete every daily (12 $CG) + the weekly trade (10) + first fusion (10, permanent — not capped)
    quests.recordLogin(db, alice, T);
    for (let i = 0; i < 3; i++) playMatch(T + i * 60);
    // make sure alice has a win (play until she wins once, vs fresh opponents so rewards don't matter)
    for (let i = 0; i < 6 && quests.metricValue(db, alice, 'pvp_won', 0, Number.MAX_SAFE_INTEGER, T + 1000) === 0; i++) {
      const o = kp(); const so = squadOf(mint(db, o, [{ rarity: 1, collection: 1 }, { rarity: 1, collection: 2 }, { rarity: 1, collection: 3 }])); // 435 power, league 0, weaker than alice
      const { matchId, na, nb } = pair(db, { wallet: alice, squad: sa }, { wallet: o, squad: so }, T + 500 + i * 60);
      arena.reveal(db, alice, matchId, { nonce: na.toString('hex') }, T + 500 + i * 60); arena.reveal(db, o, matchId, { nonce: nb.toString('hex') }, T + 500 + i * 60);
    }
    const mats = mint(db, alice, [{ rarity: 0, collection: 0 }, { rarity: 0, collection: 0 }, { rarity: 0, collection: 0 }]);
    finalizeAll(db);
    ingestTx(tx([{ program: 'chip_core', name: 'ChipFused', data: { owner: alice, recipe: 0, materials: mats, result: kp(), success: true, rollBps: 0, thresholdBps: 10000, feeBurned: '2500000' } }], { blockTime: T + 1200 }), db);
    ingestTx(tx([{ program: 'market', name: 'ChipSold', data: { asset: sb[0], seller: bob, buyer: alice, price: '1', currency: 0, fee: '0', royalty: '0', viaOffer: false } }], { blockTime: T + 1201 }), db);
    // the fusion + trade are only confirmed: the live list shows them, settlement does not pay them yet (SEC-M5 / #9)
    expect(quests.list(db, alice, T + 1250).find((q) => q.id === 'd_fuse1')).toMatchObject({ value: 1, claimable: true });
    const early = quests.settleWallet(db, alice, T + 1250);
    expect(early).toBeGreaterThan(0);
    expect(db.all<{ quest_id: string }>(`SELECT quest_id FROM quest_completions WHERE wallet = ?`, alice).map((r) => r.quest_id)).not.toContain('d_fuse1');
    expect(db.all<{ quest_id: string }>(`SELECT quest_id FROM quest_completions WHERE wallet = ?`, alice).map((r) => r.quest_id)).not.toContain('w_trade');
    finalizeAll(db);
    const n = quests.settleWallet(db, alice, T + 1300);
    expect(early + n).toBeGreaterThanOrEqual(6);
    const rows = db.all<{ quest_id: string; amount: string }>(`SELECT quest_id, amount FROM quest_completions WHERE wallet = ?`, alice);
    const daily = rows.filter((r) => r.quest_id.startsWith('d_')).reduce((s, r) => s + BigInt(r.amount), 0n);
    expect(daily).toBe(12_000_000n); // 2 + 4 + 3 + 3 — under the 15 $CG daily cap
    expect(rows.find((r) => r.quest_id === 'w_trade')!.amount).toBe('3000000'); // capped: 15 − 12 already paid today
    expect(rows.find((r) => r.quest_id === 'p_first_fusion')!.amount).toBe('10000000'); // permanent milestones bypass the daily cap
    expect(quests.settleWallet(db, alice, T + 1400)).toBe(0); // idempotent
    // streak: all 4 $CG dailies done today → 1 day
    expect(quests.streak(db, alice, T + 1400)).toMatchObject({ days: 1, todayDone: true });
    expect(quests.list(db, alice, T + 1400).find((q) => q.id === 'd_login')).toMatchObject({ claimable: false, rooted: false, creditedCgMicro: '2000000' });
    expect(ANTI_FARM.dailyQuestRewardCapCgMicro).toBe(15_000_000);
  });

  it('streak counts consecutive completed days ending today or yesterday; progress wraps every 7 days and the chip is credited once per 7-day run', () => {
    const day = quests.dayIndex(T);
    for (const d of [day - 4, day - 3, day - 2, day - 1]) db.run(`INSERT INTO quest_days (wallet, day, dailies_done) VALUES (?, ?, 1)`, alice, d);
    expect(quests.streak(db, alice, T)).toMatchObject({ days: 4, total: 4, todayDone: false });
    db.run(`DELETE FROM quest_days WHERE wallet = ? AND day = ?`, alice, day - 3);
    expect(quests.streak(db, alice, T).days).toBe(2);
    for (const d of Array.from({ length: 9 }, (_, i) => day - i)) db.run(`INSERT OR REPLACE INTO quest_days (wallet, day, dailies_done) VALUES (?, ?, 1)`, alice, d);
    expect(quests.streak(db, alice, T)).toMatchObject({ days: 2, total: 9, todayDone: true }); // 9 = one chip earned (day 7) + 2 toward the next
    expect(quests.streakEndingOn(db, alice, day - 2)).toBe(7);
    // settlement metric: d_streak7 reaches 7 exactly on the day the 7th day completed (day − 2); day − 1 / today are 1 / 2 toward the next chip
    expect([day - 2, day - 1, day].map((d) => quests.metricValue(db, alice, 'streak_days', d * 86_400, (d + 1) * 86_400, T))).toEqual([7, 1, 2]);
    // the live list recomputes today's row from finalized events (alice did nothing today) → today drops out, progress shows 1/7
    const l = quests.list(db, alice, T).find((q) => q.id === 'd_streak7')!;
    expect(l).toMatchObject({ value: 1, claimable: false });
    expect(quests.streak(db, alice, T)).toMatchObject({ days: 1, total: 8, todayDone: false });
  });

  it('settlement pays only from finalized events, catches up the previous day/week, and attributes caps to the period day', () => {
    const day = quests.dayIndex(T);
    // alice logs in yesterday and today; yesterday's login is still claimable on today's pass (previous period catch-up)
    quests.recordLogin(db, alice, T - 86_400);
    quests.recordLogin(db, alice, T);
    // nothing finalized yet → the horizon sits below the first indexed event: no on-chain metric can pay, server-side logins can
    expect(finalizedHorizon(db)).toBe(db.scalar(`SELECT MIN(slot) FROM events_raw`) - 1);
    finalizeAll(db);
    const n = quests.settleWallet(db, alice, T);
    const rows = db.all<{ quest_id: string; period_key: string; amount: string; day: number }>(`SELECT quest_id, period_key, amount, day FROM quest_completions WHERE wallet = ? ORDER BY period_key`, alice);
    expect(n).toBe(2);
    expect(rows).toEqual([
      { quest_id: 'd_login', period_key: `d${day - 1}`, amount: '2000000', day: day - 1 },
      { quest_id: 'd_login', period_key: `d${day}`, amount: '2000000', day },
    ]);
    // horizon: the slot below the oldest unfinalized event; FINALITY_ASSUME is off in tests
    const mats = mint(db, alice, [{ rarity: 0, collection: 0 }, { rarity: 0, collection: 0 }, { rarity: 0, collection: 0 }]);
    const pendingSlot = db.scalar(`SELECT MIN(slot) FROM events_raw WHERE finalized_at IS NULL`);
    expect(finalizedHorizon(db)).toBe(pendingSlot - 1);
    ingestTx(tx([{ program: 'chip_core', name: 'ChipFused', data: { owner: alice, recipe: 0, materials: mats, result: kp(), success: true, rollBps: 0, thresholdBps: 10000, feeBurned: '2500000' } }], { blockTime: T + 10 }), db);
    expect(quests.settleWallet(db, alice, T + 20)).toBe(0);
    finalizeAll(db);
    expect(quests.settleWallet(db, alice, T + 30)).toBe(2); // d_fuse1 + p_first_fusion
    expect(db.get<{ amount: string; day: number }>(`SELECT amount, day FROM quest_completions WHERE wallet = ? AND quest_id = 'd_fuse1'`, alice)).toEqual({ amount: '3000000', day });
  });
});

describe('reward oracle', () => {
  let db: Db; let alice: string; let bob: string; let sa: string[]; let sb: string[];
  const T = 1_800_000_000 + 12 * 3600;
  beforeEach(() => {
    db = new Db(':memory:');
    alice = kp(); bob = kp();
    sa = squadOf(mint(db, alice, [{ rarity: 2, collection: 0 }, { rarity: 2, collection: 1 }, { rarity: 1, collection: 2 }], { blockTime: T - 3 * 86_400 }));
    sb = squadOf(mint(db, bob, [{ rarity: 2, collection: 3 }, { rarity: 1, collection: 4 }, { rarity: 2, collection: 5 }], { blockTime: T - 3 * 86_400 }));
    const { matchId, na, nb } = pair(db, { wallet: alice, squad: sa }, { wallet: bob, squad: sb }, T);
    arena.reveal(db, alice, matchId, { nonce: na.toString('hex') }, T); arena.reveal(db, bob, matchId, { nonce: nb.toString('hex') }, T);
    quests.recordLogin(db, alice, T);
  });

  it('merkle mirrors the on-chain verifier (golden vector shared with client + Rust)', () => {
    const w = (b: number) => new Uint8Array(32).fill(b);
    const leaves = [{ wallet: w(1), amountMicro: 1_500_000n, kind: 2, epoch: 7 }, { wallet: w(2), amountMicro: 12_500_000n, kind: 5, epoch: 7 }, { wallet: w(3), amountMicro: 1n, kind: 6, epoch: 1 }];
    expect(toHex(rewardLeaf(leaves[0]))).toBe('3d0d922cddaa7e75b60963bd999a604e5c858d5996620351b1857bc242a0259f');
    const t = buildRewardTree(leaves);
    expect(toHex(t.root)).toBe('08a5f93435e89ae1fb9ea8821bf61eb469008c475d327b0a0114dd1e980b5027');
    leaves.forEach((l, i) => expect(verifyRewardProof(l, t.proofs[i], t.root)).toBe(true));
    expect(verifyRewardProof({ ...leaves[0], kind: 5 }, t.proofs[0], t.root)).toBe(false);
  });

  it('buildBatch: pvp rewards → kind 3 leaves (sorted wallets, proofs verify), sources marked, min-batch respected, one pending batch at a time', () => {
    expect(oracle.buildBatch(db, oracle.KIND_QUESTS, T)).toBeUndefined();          // nothing settled yet
    expect(oracle.buildBatch(db, oracle.KIND_PVP, T, 10_000_000n)).toBeUndefined(); // 2.5 $CG < min 10
    const b = oracle.buildBatch(db, oracle.KIND_PVP, T, 1_000_000n)!;
    expect(b).toMatchObject({ kind: 3, epoch: 0, budget: 2_500_000n, leaves: 2 });
    const leaves = db.all<{ wallet: string; amount: string; proof: string }>(`SELECT wallet, amount, proof FROM reward_leaves WHERE kind = 3 AND epoch = 0 ORDER BY wallet`);
    expect(leaves.map((l) => l.wallet)).toEqual([alice, bob].sort());
    for (const l of leaves) expect(verifyRewardProof({ wallet: l.wallet, amountMicro: l.amount, kind: 3, epoch: 0 }, (JSON.parse(l.proof) as string[]).map(fromHex), fromHex(b.root))).toBe(true);
    expect(db.scalar(`SELECT COUNT(*) FROM pvp_rewards WHERE root_kind IS NULL`)).toBe(0);
    expect(oracle.buildBatch(db, oracle.KIND_PVP, T, 1n)).toBeUndefined(); // pending batch blocks a second one
    // /quests/claims lists the leaf as not yet published (no claimableAt)
    const c = quests.claims(db, alice, T);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ kind: 3, epoch: 0, currency: 'CG', published: false, claimableAt: null, claimed: false });
    expect(c[0].rootPda).toBe(quests.rootPdaOf(3, 0));
  });

  it('publishPending sends publish_root with the right accounts/args, marks published; RootPublished + RootClaimed drive /quests/claims', async () => {
    const seasonOracle = Keypair.generate();
    const conn = new FakeConnection();
    const b = oracle.buildBatch(db, oracle.KIND_PVP, T, 1n)!;
    const r = await oracle.publishPending({ connection: asConn(conn), db, seasonOracle });
    expect(r).toEqual({ published: 1, failed: 0, skipped: 0 });
    const sent = conn.sent[0].ixs.find((ix) => ix.programId.equals(PROGRAMS.staking))!; // after the compute-budget ixs
    expect(sent).toBeDefined();
    expect(Buffer.from(sent.data.subarray(0, 8)).toString('hex')).toBe(Buffer.from(ixDiscriminator('publish_root')).toString('hex'));
    expect(sent.data[8]).toBe(3);                                   // kind
    expect(sent.data.readUInt32LE(9)).toBe(0);                      // epoch
    expect(sent.data.subarray(13, 45).toString('hex')).toBe(b.root); // root
    expect(sent.data.readBigUInt64LE(45)).toBe(2_500_000n);          // budget
    expect(sent.keys[0].equals(seasonOracle.publicKey)).toBe(true);
    expect(sent.keys[2].equals(oracle.rewardRootPda(3, 0)[0])).toBe(true);
    expect(db.get<{ status: string }>(`SELECT status FROM reward_batches WHERE kind = 3 AND epoch = 0`)!.status).toBe('published');
    // a quest batch without the quest key is skipped, not failed
    finalizeAll(db);
    quests.settleWallet(db, alice, T);
    expect(oracle.buildBatch(db, oracle.KIND_QUESTS, T, 1n)).toMatchObject({ kind: 2, epoch: 0 });
    expect(await oracle.publishPending({ connection: asConn(conn), db, seasonOracle })).toMatchObject({ skipped: 1 });
    // indexer sees the root → claimable after the 1 h timelock; claim → claimed
    ingestTx(tx([{ program: 'staking', name: 'RootPublished', data: { kind: 3, epoch: 0, root: b.root, budget: '2500000' } }], { blockTime: T + 10 }), db);
    let c = quests.claims(db, alice, T + 20).find((x) => x.kind === 3)!;
    expect(c.published).toBe(true);
    expect(Date.parse(c.claimableAt!)).toBe((T + 10 + 3600) * 1000);
    ingestTx(tx([{ program: 'staking', name: 'RootClaimed', data: { kind: 3, epoch: 0, wallet: alice, amount: c.amountMicro } }]), db);
    c = quests.claims(db, alice, T + 4000).find((x) => x.kind === 3)!;
    expect(c.claimed).toBe(true);
    // revoked roots disappear from the list
    ingestTx(tx([{ program: 'staking', name: 'RootRevoked', data: { kind: 3, epoch: 0 } }]), db);
    expect(quests.claims(db, alice, T + 5000).some((x) => x.kind === 3)).toBe(false);
    expect(oracle.rewardOracleStatus(db).healthy).toBe(true);
  });

  it('runOnce settles active wallets, builds both kinds and reports; a re-run publishes nothing new', async () => {
    const conn = new FakeConnection();
    const questOracle = Keypair.generate(), seasonOracle = Keypair.generate();
    finalizeAll(db);
    const r = await oracle.runOnce({ connection: asConn(conn), db, questOracle, seasonOracle, minBatchMicro: 1n }, T + 100);
    expect(r.settled).toBeGreaterThan(0);
    expect(r.horizon).toBe(db.scalar(`SELECT MAX(slot) FROM events_raw`));
    expect(r.seasons).toEqual([]);
    expect(r.built.map((b) => b.kind).sort()).toEqual([2, 3]);
    expect(r.published).toBe(2);
    // a finished season is settled inside the cycle and its payouts land in the next kind-3 batch
    const sid = arena.currentSeason(db, T).id;
    db.run(`UPDATE ratings SET games = 10 WHERE season = ?`, sid);
    for (let i = 0; i < 10; i++) db.run(`INSERT INTO matches (id, season, a, b, squad_a, squad_b, power_a, power_b, league, commit_a, commit_b, status, forfeit, started_at) VALUES (?, ?, ?, ?, '[]', '[]', 500, 500, 0, '', '', 'resolved', 0, ?)`, `m${i}`, sid, alice, bob, T * 1000);
    ingestTx(tx([{ program: 'staking', name: 'DayClosed', data: { dayIndex: 3, year: 0, scheduleCap: '271232876712', guarded: '100000000000', burn7dAvg: '0', sliceBudget: ['0', '0', '0', '0', '0'] } }], { blockTime: T + 86_400 }), db);
    // the DayClosed is only confirmed → the season is postponed; finalized → settled
    const wait = await oracle.runOnce({ connection: asConn(conn), db, questOracle, seasonOracle, minBatchMicro: 1n }, T + arena.SEASON_SECONDS + 5);
    expect(wait.seasons).toEqual([]);
    finalizeAll(db);
    const late = await oracle.runOnce({ connection: asConn(conn), db, questOracle, seasonOracle, minBatchMicro: 1n }, T + arena.SEASON_SECONDS + 10);
    expect(late.seasons).toEqual([sid]);
    expect(late.built.map((b) => b.kind)).toEqual([3]);
    // 2 qualified of 1000 → top-50 % band = rank 1 only (ceil(2 × 0.5) = 1); rank 2 receives nothing
    expect(db.scalar(`SELECT COUNT(*) FROM season_payouts WHERE season = ? AND root_kind = 3`, sid)).toBe(1);
    expect(db.get<{ wallet: string }>(`SELECT wallet FROM season_payouts WHERE season = ?`, sid)!.wallet).toBe(db.get<{ wallet: string }>(`SELECT wallet FROM ratings WHERE season = ? ORDER BY rating DESC, wallet ASC LIMIT 1`, sid)!.wallet);
    const again = await oracle.runOnce({ connection: asConn(conn), db, questOracle, seasonOracle, minBatchMicro: 1n }, T + 200);
    expect(again.built).toEqual([]);
    expect(again.published).toBe(0);
    expect(again.rakeFundedMicro).toBe(0n); // no wager battles in this season → nothing to recycle
    expect(db.get<{ rake_funded_sig: string }>(`SELECT rake_funded_sig FROM seasons WHERE id = ?`, sid)!.rake_funded_sig).toBe('covered');
    // alice: quest root + match-reward root (+ the season ladder root when she was the top-rated of the two)
    const paidTo = db.get<{ wallet: string }>(`SELECT wallet FROM season_payouts WHERE season = ?`, sid)!.wallet;
    expect(quests.claims(db, alice, T + 300).map((c) => c.kind).sort()).toEqual(paidTo === alice ? [2, 3, 3] : [2, 3]);
  });

  it('referrals (kind 4): 5 % of finalized, opened, SOL/USDC/SKR pack spend to the referrer + a one-off welcome bonus; $CG-paid packs excluded; cap; idempotent; batched under kind 4 and published by the season oracle', async () => {
    human.configureHuman({ enabled: false, maxWalletsPerDevice: 3, salt: 'test-salt' });
    // alice (has a paid pack from beforeEach → reward-eligible) referred carol; carol buys a Premium ×5 bundle in SOL and a Standard in $CG
    const carol = kp();
    db.run(`INSERT INTO wallets (address, first_seen, referrer) VALUES (?, ?, ?)`, carol, T - 2 * 86_400, alice);
    ingestTx(tx([{ program: 'chip_core', name: 'PackBought', data: { buyer: carol, sku: 2, qty: 5, currency: 0, amount: '400000000', nonce: '901', randomness: kp() } }], { blockTime: T - 3600 }), db);
    ingestTx(tx([{ program: 'chip_core', name: 'PackBought', data: { buyer: carol, sku: 1, qty: 1, currency: 2, amount: '750000000', nonce: '902', randomness: kp() } }], { blockTime: T - 3600 }), db);
    finalizeAll(db);
    // nothing opened yet → the purchase is still refundable (SEC-C3) → nothing accrues
    expect(referrals.settleReferrals(db, T)).toEqual({ rows: 0, paidMicro: 0n, welcomeMicro: 0n, postponed: 0 });
    for (const nonce of ['901', '902']) ingestTx(tx([{ program: 'chip_core', name: 'PackOpened', data: { buyer: carol, sku: nonce === '901' ? 2 : 1, nonce, assets: [kp(), kp(), kp(), DEFAULT, DEFAULT], rarities: [0, 0, 1, 0, 0], collections: [1, 2, 3, 0, 0], count: 3, roll: hex32(0x42), pityBefore: 0, pityAfter: 1 } }], { blockTime: T - 3000 }), db);
    finalizeAll(db);
    // Premium $12.99 × 5 × (1 − 7 %) = $60.40 → 6 040 ¢ → 5 % = 302 $CG, capped at 200 $CG; the $CG-paid Standard is not revenue
    expect(referrals.countedSpendCents(2, 5, 0)).toBe(6040);
    expect(referrals.countedSpendCents(1, 1, 2)).toBe(0);
    expect(referrals.countedSpendCents(1, 1, 3)).toBe(474); // $4.99 − 5 % SKR discount
    const r = referrals.settleReferrals(db, T);
    expect(r).toEqual({ rows: 2, paidMicro: 200_000_000n, welcomeMicro: 149_000_000n, postponed: 0 });
    const rows = db.all<{ referee: string; nonce: string; wallet: string; amount: string; spend_cents: number; reason: string | null }>(`SELECT referee, nonce, wallet, amount, spend_cents, reason FROM referral_rewards ORDER BY nonce`);
    expect(rows).toEqual([
      { referee: carol, nonce: '901', wallet: alice, amount: '200000000', spend_cents: 6040, reason: null },
      { referee: carol, nonce: 'welcome', wallet: carol, amount: '149000000', spend_cents: 0, reason: null },
    ]);
    // idempotent; a later purchase of the same referee hits the lifetime cap → 0 with `cap_reached`
    expect(referrals.settleReferrals(db, T + 1)).toEqual({ rows: 0, paidMicro: 0n, welcomeMicro: 0n, postponed: 0 });
    mint(db, carol, [{ rarity: 0, collection: 4 }], { sku: 1, nonce: '903', blockTime: T - 1000 }); finalizeAll(db);
    expect(referrals.settleReferrals(db, T + 2)).toEqual({ rows: 1, paidMicro: 0n, welcomeMicro: 0n, postponed: 0 });
    expect(db.get<{ reason: string }>(`SELECT reason FROM referral_rewards WHERE nonce = '903'`)!.reason).toBe('cap_reached');
    // self-referral: dave refers erin, both seen on one device → 0 for both sides, recorded so it is never re-evaluated
    const dave = kp(), erin = kp();
    db.run(`INSERT INTO wallets (address, first_seen) VALUES (?, ?)`, dave, T - 5 * 86_400);
    db.run(`INSERT INTO wallets (address, first_seen, referrer) VALUES (?, ?, ?)`, erin, T - 86_400, dave);
    human.recordDevice(db, dave, 'same-device-fingerprint', T - 5 * 86_400); human.recordDevice(db, erin, 'same-device-fingerprint', T - 86_400);
    mint(db, dave, [{ rarity: 0, collection: 0 }], { sku: 1, nonce: '904', blockTime: T - 4 * 86_400 });
    mint(db, erin, [{ rarity: 0, collection: 0 }], { sku: 1, nonce: '905', blockTime: T - 3000 }); finalizeAll(db);
    expect(referrals.settleReferrals(db, T + 3)).toEqual({ rows: 2, paidMicro: 0n, welcomeMicro: 0n, postponed: 0 });
    expect(db.all<{ reason: string }>(`SELECT reason FROM referral_rewards WHERE referee = ?`, erin).map((x) => x.reason)).toEqual(['self_referral', 'self_referral']);
    // shadow-banned referrer → 0; a referrer without a paid pack / 10 matches → referrer_ineligible
    const frank = kp(), gina = kp(), hank = kp(), iris = kp();
    db.run(`INSERT INTO wallets (address, first_seen, flags) VALUES (?, ?, '{"shadowBanned":true}')`, frank, T - 9 * 86_400);
    db.run(`INSERT INTO wallets (address, first_seen, referrer) VALUES (?, ?, ?)`, gina, T - 86_400, frank);
    db.run(`INSERT INTO wallets (address, first_seen) VALUES (?, ?)`, hank, T - 9 * 86_400);
    db.run(`INSERT INTO wallets (address, first_seen, referrer) VALUES (?, ?, ?)`, iris, T - 86_400, hank);
    mint(db, gina, [{ rarity: 0, collection: 0 }], { sku: 1, nonce: '906', blockTime: T - 3000 });
    mint(db, iris, [{ rarity: 0, collection: 0 }], { sku: 1, nonce: '907', blockTime: T - 3000 }); finalizeAll(db);
    expect(referrals.settleReferrals(db, T + 4).rows).toBe(4);
    expect(db.get<{ reason: string; amount: string }>(`SELECT reason, amount FROM referral_rewards WHERE nonce = '906'`)).toEqual({ reason: 'shadow_banned', amount: '0' });
    expect(db.get<{ amount: string }>(`SELECT amount FROM referral_rewards WHERE referee = ? AND nonce = 'welcome'`, gina)!.amount).toBe('149000000'); // the referee is not punished for the referrer's ban
    expect(db.get<{ reason: string }>(`SELECT reason FROM referral_rewards WHERE nonce = '907'`)!.reason).toBe('referrer_ineligible');
    // dashboard
    const dash = referrals.referralSummary(db, alice, T + 5);
    expect(dash.totals).toEqual({ referees: 1, paying: 1, earnedCgMicro: '200000000', inRootsCgMicro: '0', awaitingRootCgMicro: '200000000', unsettledPurchases: 0 });
    expect(dash.referees[0]).toMatchObject({ wallet: carol, paidPurchases: 2, spendUsd: 65.39, earnedCgMicro: '200000000', capLeftCgMicro: '0' });
    expect(referrals.referralSummary(db, carol, T + 5).welcome).toEqual({ amountCgMicro: '149000000', inRoot: false });
    // kind-4 batch: only amount > 0 rows, leaves per wallet, sources marked; publish needs the season oracle
    const b = oracle.buildBatch(db, oracle.KIND_REFERRALS, T + 6, 1n)!;
    expect(b).toMatchObject({ kind: 4, epoch: 0, budget: 200_000_000n + 149_000_000n * 3n, leaves: 4 }); // alice + carol, gina, iris welcome bonuses
    expect(db.scalar(`SELECT COUNT(*) FROM referral_rewards WHERE root_kind IS NULL AND CAST(amount AS INTEGER) > 0`)).toBe(0);
    expect(db.scalar(`SELECT COUNT(*) FROM referral_rewards WHERE root_kind = 4`)).toBe(4);
    expect(referrals.referralSummary(db, alice, T + 7).totals.inRootsCgMicro).toBe('200000000');
    const conn = new FakeConnection();
    let kinds: number[] = [];
    conn.onTx = (ixs) => { const ix = ixs.find((i) => i.programId.equals(PROGRAMS.staking))!; expect(Buffer.from(ix.data.subarray(0, 8)).toString('hex')).toBe(Buffer.from(ixDiscriminator('publish_root')).toString('hex')); kinds.push(ix.data[8]); };
    expect(await oracle.publishPending({ connection: asConn(conn), db, questOracle: Keypair.generate() })).toEqual({ published: 0, failed: 0, skipped: 1 }); // quest key cannot sign kind 4
    expect(await oracle.publishPending({ connection: asConn(conn), db, seasonOracle: Keypair.generate() })).toEqual({ published: 1, failed: 0, skipped: 0 });
    expect(kinds).toEqual([4]);
    expect(quests.claims(db, alice, T + 8).filter((c) => c.kind === 4)).toHaveLength(1);
    expect(oracle.rewardOracleStatus(db).unrootedMicro.referrals).toBe('0');
  });

  it('#27 item roots: booster completions → kind-8 leaves (unit count, ≤ 10 per wallet, ≤ 1 000 per root, carry-over), publish_item_root by the quest oracle, ITEM currency in /quests/claims', async () => {
    const T2 = T + 10;
    const day = quests.dayIndex(T2);
    const row = (w: string, id: string, key: string, boosters: number, at = T2) => db.run(`INSERT INTO quest_completions (wallet, quest_id, period_key, amount, reward_booster, completed_at, day) VALUES (?, ?, ?, '0', ?, ?, ?)`, w, id, key, boosters, at, day);
    // alice: 1 weekly booster + the set milestone; bob: 12 weekly rows (more than one claim can carry); carol: nothing owed (0)
    const carol = kp();
    row(alice, 'w_stake', 'w100', 1); row(alice, 'p_set1', 'all', 1);
    for (let i = 0; i < 12; i++) row(bob, 'w_stake', `w${100 + i}`, 1, T2 - (12 - i));
    row(carol, 'w_all', 'w100', 0);
    expect(oracle.rewardOracleStatus(db).unrootedBoosters).toEqual({ count: 14, wallets: 2 });
    // the $CG builder ignores booster-only rows (amount 0) — nothing to root there
    expect(oracle.buildBatch(db, oracle.KIND_QUESTS, T2, 1n)).toBeUndefined();
    const b = oracle.buildItemBatch(db, T2)!;
    expect(b).toMatchObject({ kind: 8, epoch: 0, budget: 12n, leaves: 2 }); // alice 2 + bob 10 (2 of bob's rows carry over)
    const leaves = db.all<{ wallet: string; amount: string; proof: string; memo: string }>(`SELECT wallet, amount, proof, memo FROM reward_leaves WHERE kind = 8 AND epoch = 0 ORDER BY wallet`);
    expect(leaves.map((l) => [l.wallet, l.amount])).toEqual([alice, bob].sort().map((w) => [w, w === alice ? '2' : '10']));
    for (const l of leaves) expect(verifyRewardProof({ wallet: l.wallet, amountMicro: l.amount, kind: 8, epoch: 0 }, (JSON.parse(l.proof) as string[]).map(fromHex), fromHex(b.root))).toBe(true);
    expect((JSON.parse(leaves.find((l) => l.wallet === alice)!.memo) as string[]).sort()).toEqual(['p_set1@all', 'w_stake@w100']);
    expect(db.scalar(`SELECT COUNT(*) FROM quest_completions WHERE item_root_kind = 8 AND item_root_epoch = 0`)).toBe(12);
    expect(db.scalar(`SELECT COUNT(*) FROM quest_completions WHERE wallet = ? AND item_root_kind IS NULL AND reward_booster > 0`, bob)).toBe(2); // carried over, oldest first were taken
    expect(db.get<{ period_key: string }>(`SELECT period_key FROM quest_completions WHERE wallet = ? AND item_root_kind IS NULL AND reward_booster > 0 ORDER BY period_key`, bob)!.period_key).toBe('w110');
    expect(oracle.rewardOracleStatus(db).unrootedBoosters).toEqual({ count: 2, wallets: 1 });
    expect(oracle.buildItemBatch(db, T2)).toBeUndefined(); // one pending item batch at a time
    // the $CG root_kind column is untouched by item rooting (the same row can still carry a $CG leaf)
    expect(db.scalar(`SELECT COUNT(*) FROM quest_completions WHERE root_kind IS NOT NULL`)).toBe(0);
    // /quests shows the booster as rooted; /quests/claims lists an ITEM leaf whose "amount" is the count
    expect(quests.list(db, alice, T2).find((x) => x.id === 'p_set1')).toMatchObject({ rewardBooster: 1, boosterRooted: true });
    const c = quests.claims(db, alice, T2).find((x) => x.kind === 8)!;
    expect(c).toMatchObject({ currency: 'ITEM', amountMicro: '2', published: false, claimableAt: null, rootPda: quests.rootPdaOf(8, 0) });
    // publish: quest oracle only, publish_item_root discriminator, emission read-only, budget = 12
    const conn = new FakeConnection();
    const seen: { disc: string; kind: number; budget: bigint; keys: number; root: boolean }[] = [];
    conn.onTx = (ixs) => { const ix = ixs.find((i) => i.programId.equals(PROGRAMS.staking))!; seen.push({ disc: Buffer.from(ix.data.subarray(0, 8)).toString('hex'), kind: ix.data[8], budget: ix.data.readBigUInt64LE(45), keys: ix.keys.length, root: ix.keys[2].equals(oracle.rewardRootPda(8, 0)[0]) }); };
    expect(await oracle.publishPending({ connection: asConn(conn), db, seasonOracle: Keypair.generate() })).toEqual({ published: 0, failed: 0, skipped: 1 });
    expect(await oracle.publishPending({ connection: asConn(conn), db, questOracle: Keypair.generate() })).toEqual({ published: 1, failed: 0, skipped: 0 });
    expect(seen).toEqual([{ disc: Buffer.from(ixDiscriminator('publish_item_root')).toString('hex'), kind: 8, budget: 12n, keys: 4, root: true }]); // oracle, emission (read-only), root, system
    // indexer: RootPublished / RootClaimed on kind 8 → currency ITEM, claimable after the 1 h timelock, claimed after the CPI claim
    ingestTx(tx([{ program: 'staking', name: 'RootPublished', data: { kind: 8, epoch: 0, root: b.root, budget: '12' } }], { blockTime: T2 + 10 }), db);
    expect(db.get<{ currency: string }>(`SELECT currency FROM reward_roots WHERE kind = 8 AND epoch = 0`)!.currency).toBe('ITEM');
    expect(quests.claims(db, alice, T2 + 20).find((x) => x.kind === 8)).toMatchObject({ published: true, claimableAt: new Date((T2 + 10 + 3600) * 1000).toISOString() });
    ingestTx(tx([{ program: 'staking', name: 'RootClaimed', data: { kind: 8, epoch: 0, wallet: alice, amount: '2' } }]), db);
    expect(quests.claims(db, alice, T2 + 4000).find((x) => x.kind === 8)!.claimed).toBe(true);
    expect(db.get<{ currency: string; amount: string }>(`SELECT currency, amount FROM reward_claims WHERE kind = 8 AND wallet = ?`, alice)).toEqual({ currency: 'ITEM', amount: '2' });
    // next cycle: bob's 2 carried-over rows form epoch 1 (nextEpoch reads the indexed root too)
    const b2 = oracle.buildItemBatch(db, T2 + 5000)!;
    expect(b2).toMatchObject({ kind: 8, epoch: 1, budget: 2n, leaves: 1 });
    expect(oracle.rewardOracleStatus(db).unrootedBoosters).toEqual({ count: 0, wallets: 0 });
    // ineligible wallets earn no boosters: settleWallet records the completion with reward_booster = 0
    const newbie = kp();
    db.run(`INSERT INTO wallets (address, first_seen) VALUES (?, ?)`, newbie, T2 - 60);
    for (let i = 0; i < 3; i++) db.run(`INSERT INTO stakes (key, owner, kind, amount, weight, unlock_at, since, slot, active) VALUES (?, ?, 1, '0', '0', 0, ?, 1, 1)`, `stake${i}`, newbie, T2 - 20 * 86_400); // ≥ 5 full days inside LAST week (settlement looks one period back)
    finalizeAll(db);
    quests.settleWallet(db, newbie, T2);
    expect(db.get<{ reward_booster: number; amount: string }>(`SELECT reward_booster, amount FROM quest_completions WHERE wallet = ? AND quest_id = 'w_stake'`, newbie)).toEqual({ reward_booster: 0, amount: '0' });
  });

  it('#28 chip roots: chip completions → kind-9 leaves (amount = template id, ONE per wallet per epoch, ≤ 2 per wallet per week, ≤ 500 per root, carry-over), publish_chip_root by the quest oracle, CHIP currency, voucher lifecycle in the indexer', async () => {
    const T2 = T + 10;
    const day = quests.dayIndex(T2);
    const chip = (template: number) => JSON.stringify(QUEST_CHIP_TEMPLATES[template]);
    const row = (w: string, id: string, key: string, reward: string | null, at = T2) => db.run(`INSERT INTO quest_completions (wallet, quest_id, period_key, amount, reward_chip, completed_at, day) VALUES (?, ?, ?, '0', ?, ?, ?)`, w, id, key, reward, at, day);
    const carol = kp(), dave = kp();
    // alice: streak chip (template 0) then the weekly chip (template 1) — two vouchers, two epochs; bob: 3 streak chips inside one week (the 3rd waits for the cap window);
    // carol: a pre-#28 row without `template` (matched by odds → template 2); dave: unknown odds (left for ops)
    row(alice, 'd_streak7', 'd100', chip(0), T2 - 100); row(alice, 'w_all', 'w100', chip(1), T2 - 50);
    for (let i = 0; i < 3; i++) row(bob, 'd_streak7', `d${100 + i}`, chip(0), T2 - 200 + i);
    row(carol, 'p_win500', 'all', JSON.stringify({ odds: [0, 0, 0, 0, 10000, 0, 0, 0, 0], soulboundDays: 30 }), T2 - 10);
    row(dave, 'p_win500', 'all', JSON.stringify({ odds: [1, 2, 3], soulboundDays: 1 }), T2 - 5);
    expect(oracle.rewardOracleStatus(db).unrootedVouchers).toEqual({ count: 7, wallets: 4, unknownTemplate: 1 });
    // the $CG / item builders ignore chip-only rows
    expect(oracle.buildBatch(db, oracle.KIND_QUESTS, T2, 1n)).toBeUndefined();
    expect(oracle.buildItemBatch(db, T2)).toBeUndefined();
    const b = oracle.buildChipBatch(db, T2)!;
    expect(b).toMatchObject({ kind: 9, epoch: 0, budget: 3n, leaves: 3 }); // alice (oldest: streak), bob (1st streak), carol — budget = leaf COUNT
    const leaves = db.all<{ wallet: string; amount: string; proof: string; memo: string }>(`SELECT wallet, amount, proof, memo FROM reward_leaves WHERE kind = 9 AND epoch = 0 ORDER BY wallet`);
    expect(Object.fromEntries(leaves.map((l) => [l.wallet, l.amount]))).toEqual({ [alice]: '0', [bob]: '0', [carol]: '2' });
    for (const l of leaves) expect(verifyRewardProof({ wallet: l.wallet, amountMicro: l.amount, kind: 9, epoch: 0 }, (JSON.parse(l.proof) as string[]).map(fromHex), fromHex(b.root))).toBe(true);
    expect(JSON.parse(leaves.find((l) => l.wallet === alice)!.memo)).toEqual(['d_streak7@d100', 'template:0']);
    expect(db.scalar(`SELECT COUNT(*) FROM quest_completions WHERE chip_root_kind = 9 AND chip_root_epoch = 0`)).toBe(3);
    expect(db.scalar(`SELECT COUNT(*) FROM quest_completions WHERE chip_root_kind IS NULL AND reward_chip IS NOT NULL`)).toBe(4); // alice w_all, bob ×2, dave
    expect(db.scalar(`SELECT COUNT(*) FROM quest_completions WHERE root_kind IS NOT NULL OR item_root_kind IS NOT NULL`)).toBe(0);
    expect(oracle.buildChipBatch(db, T2)).toBeUndefined(); // one pending chip batch at a time
    // /quests shows the streak chip as rooted; /quests/claims lists a CHIP leaf whose "amount" is the template
    expect(quests.list(db, alice, T2).find((x) => x.id === 'w_all')).toMatchObject({ chipRooted: false });
    const c = quests.claims(db, alice, T2).find((x) => x.kind === 9)!;
    expect(c).toMatchObject({ currency: 'CHIP', amountMicro: '0', published: false, claimableAt: null, rootPda: quests.rootPdaOf(9, 0) });
    // publish: quest oracle only, publish_chip_root discriminator, emission read-only, budget = 3 (leaves)
    const conn = new FakeConnection();
    const seen: { disc: string; kind: number; budget: bigint; keys: number; root: boolean }[] = [];
    conn.onTx = (ixs) => { const ix = ixs.find((i) => i.programId.equals(PROGRAMS.staking))!; seen.push({ disc: Buffer.from(ix.data.subarray(0, 8)).toString('hex'), kind: ix.data[8], budget: ix.data.readBigUInt64LE(45), keys: ix.keys.length, root: ix.keys[2].equals(oracle.rewardRootPda(9, 0)[0]) }); };
    expect(await oracle.publishPending({ connection: asConn(conn), db, seasonOracle: Keypair.generate() })).toEqual({ published: 0, failed: 0, skipped: 1 });
    expect(await oracle.publishPending({ connection: asConn(conn), db, questOracle: Keypair.generate() })).toEqual({ published: 1, failed: 0, skipped: 0 });
    expect(seen).toEqual([{ disc: Buffer.from(ixDiscriminator('publish_chip_root')).toString('hex'), kind: 9, budget: 3n, keys: 4, root: true }]);
    // indexer: RootPublished / RootClaimed on kind 9 → currency CHIP; the claim tx also carries chip_core's VoucherIssued (CPI) → vouchers row
    ingestTx(tx([{ program: 'staking', name: 'RootPublished', data: { kind: 9, epoch: 0, root: b.root, budget: '3' } }], { blockTime: T2 + 10 }), db);
    expect(db.get<{ currency: string }>(`SELECT currency FROM reward_roots WHERE kind = 9 AND epoch = 0`)!.currency).toBe('CHIP');
    const rnd = kp();
    ingestTx(tx([
      { program: 'staking', name: 'RootClaimed', data: { kind: 9, epoch: 0, wallet: alice, amount: '0' } },
      { program: 'chip_core', name: 'VoucherIssued', data: { wallet: alice, nonce: '901', template: 0, randomness: rnd } },
    ], { blockTime: T2 + 4000 }), db);
    expect(quests.claims(db, alice, T2 + 4000).find((x) => x.kind === 9)!.claimed).toBe(true);
    expect(db.get(`SELECT currency, amount FROM reward_claims WHERE kind = 9 AND wallet = ?`, alice)).toEqual({ currency: 'CHIP', amount: '0' });
    expect(db.get(`SELECT template, randomness, status FROM vouchers WHERE wallet = ? AND nonce = '901'`, alice)).toEqual({ template: 0, randomness: rnd, status: 'pending' });
    expect(db.scalar(`SELECT COUNT(*) FROM pack_purchases WHERE buyer = ? AND nonce = '901'`, alice)).toBe(0); // a voucher is not a purchase (payer / Starter stats untouched)
    // the crank opens it like any pack: PackOpened { sku 0, count 1 } → chip origin 'voucher', soulbound for the TEMPLATE's days (3), voucher row closed
    const asset = kp();
    ingestTx(tx([{ program: 'chip_core', name: 'PackOpened', data: { buyer: alice, sku: 0, nonce: '901', assets: [asset, DEFAULT, DEFAULT, DEFAULT, DEFAULT], rarities: [1, 0, 0, 0, 0], collections: [4, 0, 0, 0, 0], count: 1, roll: hex32(0x28), pityBefore: 0, pityAfter: 0 } }], { blockTime: T2 + 4100 }), db);
    expect(db.get(`SELECT origin, flags, lock_until, rarity, collection_idx FROM chips WHERE asset = ?`, asset)).toEqual({ origin: 'voucher', flags: 8, lock_until: T2 + 4100 + 3 * 86_400, rarity: 1, collection_idx: 4 });
    expect(db.get(`SELECT status FROM vouchers WHERE wallet = ? AND nonce = '901'`, alice)).toEqual({ status: 'opened' });
    expect(q.chipDetail(db, asset)!.provenance).toMatchObject({ origin: 'voucher', rollHex: hex32(0x28) });
    // provably-fair verifier: the voucher open reports the TEMPLATE odds (no Starter table, no pity), and says so
    const open = q.packOpen(db, db.get<{ signature: string }>(`SELECT signature FROM pack_opens WHERE buyer = ? AND nonce = '901'`, alice)!.signature)!;
    expect(open).toMatchObject({ sku: 0, effectiveOddsBps: [8000, 1800, 200, 0, 0, 0, 0, 0, 0], voucher: { template: 0, soulboundDays: 3 } });
    // a Starter open (also sku 0) is unaffected: 7-day lock, origin 'pack'
    const starter = kp();
    ingestTx(tx([{ program: 'chip_core', name: 'PackBought', data: { buyer: bob, sku: 0, qty: 1, currency: 1, amount: '1490000', nonce: '77', randomness: kp() } }]), db);
    ingestTx(tx([{ program: 'chip_core', name: 'PackOpened', data: { buyer: bob, sku: 0, nonce: '77', assets: [starter, kp(), kp(), DEFAULT, DEFAULT], rarities: [0, 0, 2, 0, 0], collections: [1, 2, 3, 0, 0], count: 3, roll: hex32(0x01), pityBefore: 0, pityAfter: 0 } }], { blockTime: T2 + 4200 }), db);
    expect(db.get(`SELECT origin, lock_until FROM chips WHERE asset = ?`, starter)).toEqual({ origin: 'pack', lock_until: T2 + 4200 + 7 * 86_400 });
    // next cycle (same week): alice's weekly chip + bob's 2nd streak chip; bob's 3rd is blocked by the 2-per-week cap and dave stays unknown
    const b2 = oracle.buildChipBatch(db, T2 + 5000)!;
    expect(b2).toMatchObject({ kind: 9, epoch: 1, budget: 2n, leaves: 2 });
    expect(Object.fromEntries(db.all<{ wallet: string; amount: string }>(`SELECT wallet, amount FROM reward_leaves WHERE kind = 9 AND epoch = 1`).map((l) => [l.wallet, l.amount]))).toEqual({ [alice]: '1', [bob]: '0' });
    expect(oracle.rewardOracleStatus(db).unrootedVouchers).toEqual({ count: 2, wallets: 2, unknownTemplate: 1 });
    ingestTx(tx([{ program: 'staking', name: 'RootPublished', data: { kind: 9, epoch: 1, root: b2.root, budget: '2' } }], { blockTime: T2 + 5010 }), db);
    expect(await oracle.publishPending({ connection: asConn(conn), db })).toEqual({ published: 1, failed: 0, skipped: 0 }); // already on chain → just marked
    // a week later bob's 3rd streak chip fits again
    const b3 = oracle.buildChipBatch(db, T2 + 8 * 86_400)!;
    expect(b3).toMatchObject({ kind: 9, epoch: 2, budget: 1n, leaves: 1 });
    expect(db.get<{ wallet: string }>(`SELECT wallet FROM reward_leaves WHERE kind = 9 AND epoch = 2`)!.wallet).toBe(bob);
    // ineligible wallets earn no chip voucher: settleWallet records the completion with reward_chip NULL
    const newbie = kp();
    db.run(`INSERT INTO wallets (address, first_seen) VALUES (?, ?)`, newbie, T2 - 60);
    for (let d = 1; d <= 7; d++) db.run(`INSERT INTO quest_days (wallet, day, dailies_done) VALUES (?, ?, 1)`, newbie, day - d);
    finalizeAll(db);
    quests.settleWallet(db, newbie, T2);
    const streakRow = db.get<{ reward_chip: string | null; amount: string }>(`SELECT reward_chip, amount FROM quest_completions WHERE wallet = ? AND quest_id = 'd_streak7'`, newbie);
    if (streakRow) expect(streakRow).toEqual({ reward_chip: null, amount: '0' });
  });

  it('SEC-L5 fundSettledRake: season oracle sends fund_slice(3, Σ rake − recycled_total) with the program account list, clamps to the pool balance, marks covered seasons, idempotent', async () => {
    const seasonOracle = Keypair.generate(), cgMint = Keypair.generate().publicKey;
    const conn = new FakeConnection();
    const { emissionPda, seasonPoolAta, seasonPoolAuthPda, decodeEmissionState } = await import('../src/chain.ts');
    let recycled = 0n;
    const setState = () => conn.set(emissionPda()[0], encodeEmissionState({ cgMint, seasonOracle: seasonOracle.publicKey, recycledTotal: recycled }), PROGRAMS.staking);
    setState();
    conn.tokenBalances.set(seasonPoolAta(cgMint).toBase58(), 5_000_000n);
    // the "runtime": fund_slice burns from the pool and bumps recycled_total
    conn.onTx = (ixs) => {
      const ix = ixs.find((i) => i.programId.equals(PROGRAMS.staking))!;
      expect(Buffer.from(ix.data.subarray(0, 8)).toString('hex')).toBe(Buffer.from(ixDiscriminator('fund_slice')).toString('hex'));
      expect(ix.data[8]).toBe(3);
      const amount = ix.data.readBigUInt64LE(9);
      expect(ix.keys.map((k) => k.toBase58())).toEqual([seasonOracle.publicKey, emissionPda()[0], cgMint, seasonPoolAuthPda()[0], seasonPoolAta(cgMint), new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')].map((k) => k.toBase58()));
      const bal = conn.tokenBalances.get(seasonPoolAta(cgMint).toBase58())!;
      if (amount > bal) throw new Error('InsufficientPool');
      conn.tokenBalances.set(seasonPoolAta(cgMint).toBase58(), bal - amount);
      recycled += amount; setState();
    };
    // two settled seasons: 3 $CG and 4 $CG of rake; nothing to do without seasons
    expect(await oracle.fundSettledRake({ connection: asConn(conn), db, seasonOracle }, T)).toEqual({ fundedMicro: 0n, seasons: [] });
    // (ids far from the live season row the beforeEach created; a settled season with zero rake is covered without any chain access)
    const mk = (id: number, rake: string) => db.run(`INSERT INTO seasons (id, starts_at, ends_at, server_secret, server_secret_hash, settled_at, pool_micro, rake_micro) VALUES (?, ?, ?, 'aa', 'bb', ?, ?, ?)`, id, T - (110 - id) * 100, T - (109 - id) * 100, T, rake, rake);
    mk(100, '0'); mk(101, '3000000'); mk(102, '4000000');
    // no key → skipped, nothing marked
    expect((await oracle.fundSettledRake({ connection: asConn(conn), db }, T)).skipped).toMatch(/no season oracle/);
    expect(db.get<{ rake_funded_sig: string | null }>(`SELECT rake_funded_sig FROM seasons WHERE id = 100`)!.rake_funded_sig).toBe('covered');
    expect(db.get<{ rake_funded_sig: string | null }>(`SELECT rake_funded_sig FROM seasons WHERE id = 101`)!.rake_funded_sig).toBeNull();
    // pool holds 5 of the 7 needed → funds 5, only season 101 (3) is covered; season 102 stays pending
    const r1 = await oracle.fundSettledRake({ connection: asConn(conn), db, seasonOracle }, T);
    expect(r1).toMatchObject({ fundedMicro: 5_000_000n, seasons: [101] });
    expect(conn.sent).toHaveLength(1);
    expect(decodeEmissionState(conn.get(emissionPda()[0])!).recycledTotal).toBe(5_000_000n);
    expect(db.get<{ rake_funded_sig: string | null }>(`SELECT rake_funded_sig FROM seasons WHERE id = 101`)!.rake_funded_sig).toBe(r1.signature);
    expect(oracle.unfundedRake(db)).toMatchObject({ targetMicro: 4_000_000n, seasons: [102] });
    expect(oracle.rewardOracleStatus(db).unfundedRake).toEqual({ seasons: [102], micro: '4000000' });
    // pool empty → skipped, no tx
    expect((await oracle.fundSettledRake({ connection: asConn(conn), db, seasonOracle }, T + 1)).skipped).toBe('season pool empty');
    expect(conn.sent).toHaveLength(1);
    // more rake lands in the pool → the remaining 2 $CG are recycled and season 2 is covered
    conn.tokenBalances.set(seasonPoolAta(cgMint).toBase58(), 9_000_000n);
    const r2 = await oracle.fundSettledRake({ connection: asConn(conn), db, seasonOracle }, T + 2);
    expect(r2).toMatchObject({ fundedMicro: 2_000_000n, seasons: [102] });
    expect(conn.tokenBalances.get(seasonPoolAta(cgMint).toBase58())).toBe(7_000_000n); // the rest belongs to later seasons
    // idempotent: chain already covers everything
    expect(await oracle.fundSettledRake({ connection: asConn(conn), db, seasonOracle }, T + 3)).toEqual({ fundedMicro: 0n, seasons: [] });
    expect(conn.sent).toHaveLength(2);
    // a foreign oracle key is refused before any tx (fresh unfunded season so the check is reached)
    mk(103, '1000000');
    expect((await oracle.fundSettledRake({ connection: asConn(conn), db, seasonOracle: Keypair.generate() }, T + 4)).skipped).toMatch(/season oracle mismatch/);
    expect(conn.sent).toHaveLength(2);
    expect(oracle.rewardOracleStatus(db).healthy).toBe(true); // unfunded for < 3 intervals is fine
  });
});

describe('reward oracle · SKR prize pool (kinds 5 / 6)', () => {
  let db: Db; let alice: string; let bob: string; let carol: string;
  const T = 1_800_000_000 + 12 * 3600;
  const SKR = 1_000_000n;
  const week = quests.weekIndex(T) - 1;   // the last finished week
  const wAll = (w: string, wk = week) => db.run(`INSERT INTO quest_completions (wallet, quest_id, period_key, amount, reward_booster, completed_at, day) VALUES (?, 'w_all', ?, '0', 0, ?, ?)`, w, `w${wk}`, T, quests.dayIndex(T));
  const poolOn = (conn: FakeConnection, o: { budget: bigint; maxRootBudget?: bigint; paused?: boolean; questOracle: PublicKey; seasonOracle: PublicKey }) => {
    const { skrPoolPda, emissionPda } = chain;
    conn.set(skrPoolPda()[0], encodeSkrPool({ budget: o.budget, maxRootBudget: o.maxRootBudget, paused: o.paused }), PROGRAMS.staking);
    conn.set(emissionPda()[0], encodeEmissionState({ questOracle: o.questOracle, seasonOracle: o.seasonOracle }), PROGRAMS.staking);
  };
  let chain: typeof import('../src/chain.ts');
  beforeEach(async () => {
    chain = await import('../src/chain.ts');
    db = new Db(':memory:');
    alice = kp(); bob = kp(); carol = kp();
    // alice + bob: paid pack 10 days ago (eligible); carol: paid pack but only 2 days old (too new)
    mint(db, alice, [{ rarity: 2, collection: 0 }], { blockTime: T - 10 * 86_400 });
    mint(db, bob, [{ rarity: 2, collection: 1 }], { blockTime: T - 10 * 86_400 });
    mint(db, carol, [{ rarity: 2, collection: 2 }], { blockTime: T - 2 * 86_400 });
    finalizeAll(db);
  });

  it('skrEligibility: paid pack + 7 d age, flags and bots excluded, unfinalized pack does not count', () => {
    expect(quests.skrEligibility(db, alice, T)).toMatchObject({ eligible: true, reason: null, accountAgeD: 10, hasPaidPack: true });
    expect(quests.skrEligibility(db, carol, T)).toMatchObject({ eligible: false, reason: 'account_too_new' });
    expect(quests.skrEligibility(db, kp(), T)).toMatchObject({ eligible: false, reason: 'needs_paid_pack' });
    expect(quests.skrEligibility(db, 'bot:3', T)).toMatchObject({ eligible: false, reason: 'bot' });
    expect(quests.skrEligibility(db, alice, T, 0)).toMatchObject({ eligible: false, reason: 'needs_paid_pack' }); // horizon below the purchase
    antifraud.resolveWallet(db, alice, 'rewards_pause', 'test');
    expect(quests.skrEligibility(db, alice, T)).toMatchObject({ eligible: false, reason: 'rewards_paused' });
  });

  it('Seeker week: all-weeklies wallets share 25 % of the pool budget equally, capped at 25 SKR, one allotment per week, paused / thin pool waits', () => {
    const pool = { budgetMicro: 1_000n * SKR, reservedMicro: 0n, maxRootBudgetMicro: 100_000n * SKR, paused: false, questOracle: PublicKey.default, seasonOracle: PublicKey.default };
    expect(oracle.buildSeekerWeek(db, pool, T)).toBeUndefined();   // nobody finished the week → recorded as empty
    expect(db.get<{ wallets: number; budget: string }>(`SELECT wallets, budget FROM skr_allotments WHERE kind = 5 AND period_key = ?`, `w${week}`)).toEqual({ wallets: 0, budget: '0' });
    db.run(`DELETE FROM skr_allotments`);
    wAll(alice); wAll(bob); wAll(carol); wAll(kp());               // carol too new, the stranger has no pack
    const b = oracle.buildSeekerWeek(db, pool, T)!;
    // 25 % of 1 000 SKR = 250 → 125 each, capped at 25 SKR each
    expect(b).toMatchObject({ kind: 5, epoch: 0, budget: 50n * SKR, leaves: 2 });
    const leaves = db.all<{ wallet: string; amount: string; memo: string }>(`SELECT wallet, amount, memo FROM reward_leaves WHERE kind = 5 ORDER BY wallet`);
    expect(leaves.map((l) => l.wallet)).toEqual([alice, bob].sort());
    expect(leaves.every((l) => l.amount === (25n * SKR).toString() && JSON.parse(l.memo)[0] === `seeker-week:w${week}`)).toBe(true);
    expect(db.get<{ epoch: number }>(`SELECT epoch FROM skr_allotments WHERE kind = 5 AND period_key = ?`, `w${week}`)!.epoch).toBe(0);
    // idempotent for the week; a pending batch blocks the next week anyway
    expect(oracle.buildSeekerWeek(db, pool, T)).toBeUndefined();
    expect(oracle.buildSeekerWeek(db, pool, T + 7 * 86_400)).toBeUndefined();
    db.run(`UPDATE reward_batches SET status = 'published'`);
    // next week: the pool is thin (10 % × 25 % = 2.5 SKR < 10 SKR min) → nothing built, week stays open; paused → nothing
    wAll(alice, week + 1);
    expect(oracle.buildSeekerWeek(db, { ...pool, budgetMicro: 10n * SKR }, T + 7 * 86_400)).toBeUndefined();
    expect(db.get(`SELECT 1 FROM skr_allotments WHERE kind = 5 AND period_key = ?`, `w${week + 1}`)).toBeUndefined();
    expect(oracle.buildSeekerWeek(db, { ...pool, paused: true }, T + 7 * 86_400)).toBeUndefined();
    // funded again → the week is paid (a single wallet gets min(250, 25) = 25 SKR)
    expect(oracle.buildSeekerWeek(db, pool, T + 7 * 86_400)).toMatchObject({ kind: 5, epoch: 1, budget: 25n * SKR, leaves: 1 });
    // the claim list shows the SKR leaf routed to claim_skr_root
    expect(quests.claims(db, alice, T + 7 * 86_400).find((c) => c.kind === 5)).toMatchObject({ currency: 'SKR', amountMicro: (25n * SKR).toString(), published: false });
  });

  it('season SKR ladder: settled season → brackets over eligible qualified wallets, 2 000 SKR cap, one allotment per season, pool-sized', () => {
    const sid = 200;
    db.run(`INSERT INTO seasons (id, starts_at, ends_at, server_secret, server_secret_hash, settled_at, pool_micro, rake_micro) VALUES (?, ?, ?, 'aa', 'bb', ?, '0', '0')`, sid, T - 50 * 86_400, T - 8 * 86_400, T - 86_400);
    const rate = (w: string, rating: number) => {
      db.run(`INSERT INTO ratings (wallet, season, rating, games, wins) VALUES (?, ?, ?, 12, 6)`, w, sid, rating);
      for (let i = 0; i < 10; i++) db.run(`INSERT INTO matches (id, season, a, b, squad_a, squad_b, power_a, power_b, league, commit_a, commit_b, status, forfeit, started_at) VALUES (?, ?, ?, 'bot:1', '[]', '[]', 500, 500, 0, '', '', 'resolved', 0, ?)`, `${w}-${i}`, sid, w, T * 1000);
    };
    rate(alice, 1500); rate(bob, 1200); rate(carol, 1900);          // carol leads but is too new for SKR
    expect(oracle.unpaidSkrSeasons(db)).toEqual([sid]);
    const pool = { budgetMicro: 1_000_000n * SKR, reservedMicro: 0n, maxRootBudgetMicro: 100_000n * SKR, paused: false, questOracle: PublicKey.default, seasonOracle: PublicKey.default };
    const b = oracle.buildSkrSeason(db, pool, T)!;
    // 55 % of 1 M = 550 k, capped by max_root_budget 100 k; 2 qualified of 1000 → scaled ×0.002 = 200 SKR; top-50 % band = rank 1 (alice) gets everything
    expect(b).toMatchObject({ kind: 6, epoch: 0, leaves: 1 });
    expect(b.budget).toBe((100_000n * SKR * 2n) / 1000n);
    expect(db.get<{ wallet: string; memo: string }>(`SELECT wallet, memo FROM reward_leaves WHERE kind = 6`)).toEqual({ wallet: alice, memo: JSON.stringify([`season:${sid}#1`]) });
    expect(oracle.unpaidSkrSeasons(db)).toEqual([]);
    expect(oracle.buildSkrSeason(db, pool, T)).toBeUndefined();
    // the per-season cap: a huge pool with 1 000 qualified wallets would pay rank 1 > 2 000 SKR → capped
    db.run(`UPDATE reward_batches SET status = 'published'`);
    const sid2 = 201;
    db.run(`INSERT INTO seasons (id, starts_at, ends_at, server_secret, server_secret_hash, settled_at, pool_micro, rake_micro) VALUES (?, ?, ?, 'aa', 'bb', ?, '0', '0')`, sid2, T - 8 * 86_400, T - 3600, T - 60);
    db.run(`INSERT INTO ratings (wallet, season, rating, games, wins) VALUES (?, ?, 2000, 12, 6)`, alice, sid2);
    for (let i = 0; i < 10; i++) db.run(`INSERT INTO matches (id, season, a, b, squad_a, squad_b, power_a, power_b, league, commit_a, commit_b, status, forfeit, started_at) VALUES (?, ?, ?, 'bot:1', '[]', '[]', 500, 500, 0, '', '', 'resolved', 0, ?)`, `s2-${i}`, sid2, alice, T * 1000);
    const big = oracle.buildSkrSeason(db, { ...pool, maxRootBudgetMicro: 100_000_000n * SKR }, T)!;
    // 1 qualified of 1000 → 0.1 % of 550 k = 550 SKR (< 2 000 cap) — the cap only bites above it
    expect(big.budget).toBe(550n * SKR);
    // reward-oracle status exposes the SKR periods
    expect(oracle.rewardOracleStatus(db).skr).toMatchObject({ lastSeason: { period_key: `s${sid2}`, wallets: 1 }, unpaidSeasons: [] });
  });

  it('runOnce with a live SkrPool builds kind 5 / 6 for the matching oracle keys and publishes publish_skr_root with the program account list', async () => {
    const conn = new FakeConnection();
    const questOracle = Keypair.generate(), seasonOracle = Keypair.generate();
    wAll(alice); wAll(bob);
    // no pool account → the $CG cycle runs, SKR is skipped silently
    let r = await oracle.runOnce({ connection: asConn(conn), db, questOracle, seasonOracle, minBatchMicro: 1n }, T);
    expect(r.built.filter((b) => b.kind >= 5)).toEqual([]);
    expect(db.get(`SELECT 1 FROM skr_allotments`)).toBeUndefined();
    // pool on chain, but the emission's quest oracle is another key → the Seeker week is NOT built with our key
    poolOn(conn, { budget: 1_000n * SKR, questOracle: Keypair.generate().publicKey, seasonOracle: seasonOracle.publicKey });
    r = await oracle.runOnce({ connection: asConn(conn), db, questOracle, seasonOracle, minBatchMicro: 1n }, T + 1);
    expect(r.built.filter((b) => b.kind === 5)).toEqual([]);
    // matching keys → built and published
    poolOn(conn, { budget: 1_000n * SKR, questOracle: questOracle.publicKey, seasonOracle: seasonOracle.publicKey });
    r = await oracle.runOnce({ connection: asConn(conn), db, questOracle, seasonOracle, minBatchMicro: 1n }, T + 2);
    expect(r.built.map((b) => b.kind)).toEqual([5]);
    expect(r.published).toBe(1);
    const sent = conn.sent.at(-1)!.ixs.find((ix) => ix.programId.equals(PROGRAMS.staking))!;
    expect(Buffer.from(sent.data.subarray(0, 8)).toString('hex')).toBe(Buffer.from(ixDiscriminator('publish_skr_root')).toString('hex'));
    expect(sent.data[8]).toBe(5);
    expect(sent.data.readUInt32LE(9)).toBe(0);
    expect(sent.data.readBigUInt64LE(45)).toBe(50n * SKR);
    expect(sent.keys.map((k) => k.toBase58())).toEqual([questOracle.publicKey, chain.emissionPda()[0], chain.skrPoolPda()[0], oracle.rewardRootPda(5, 0)[0], new PublicKey('11111111111111111111111111111111')].map((k) => k.toBase58()));
    expect(db.get<{ status: string; signature: string }>(`SELECT status, signature FROM reward_batches WHERE kind = 5 AND epoch = 0`)).toMatchObject({ status: 'published' });
    // the indexer's RootPublished (kind 5 ⇒ SKR) makes the leaf claimable through claim_skr_root
    ingestTx(tx([{ program: 'staking', name: 'RootPublished', data: { kind: 5, epoch: 0, root: r.built[0].root, budget: (50n * SKR).toString() } }], { blockTime: T + 10 }), db);
    expect(quests.claims(db, alice, T + 20).find((c) => c.kind === 5)).toMatchObject({ currency: 'SKR', published: true });
    expect(db.get<{ currency: string }>(`SELECT currency FROM reward_roots WHERE kind = 5 AND epoch = 0`)!.currency).toBe('SKR');
  });
});

describe('battle resolver', () => {
  it('rolls from the VRF value are deterministic; result_hash canonical; resolve_battle account list mirrors the program', () => {
    const value = new Uint8Array(32).map((_, i) => i * 7);
    const A: FighterChip[] = [{ asset: 'a', collection: 0, rarity: 3, level: 2 }, { asset: 'b', collection: 1, rarity: 3, level: 1 }, { asset: 'c', collection: 2, rarity: 2, level: 1 }];
    const B: FighterChip[] = [{ asset: 'd', collection: 3, rarity: 3, level: 1 }, { asset: 'e', collection: 4, rarity: 3, level: 1 }, { asset: 'f', collection: 5, rarity: 2, level: 3 }];
    const f1 = resolveFight(A, B, rollFromValue(value)), f2 = resolveFight(A, B, rollFromValue(value));
    expect(f1).toEqual(f2);
    expect(resultHash(f1.rounds).equals(resultHash(f2.rounds))).toBe(true);
    expect(resultHash(f1.rounds).equals(resultHash(f1.rounds.slice(0, 1)))).toBe(false);
    const oracleKp = Keypair.generate(), challenger = Keypair.generate().publicKey, cg = Keypair.generate().publicKey;
    const ix = resolveBattleIx({ oracle: oracleKp.publicKey, challenger, nonce: 9n, randomness: Keypair.generate().publicKey, cgMint: cg, winner: challenger, seasonPool: Keypair.generate().publicKey, treasuryCg: Keypair.generate().publicKey, resultHash: resultHash(f1.rounds) });
    expect(ix.programId.equals(PROGRAMS.arena)).toBe(true);
    expect(ix.keys).toHaveLength(11);
    expect(ix.keys[0]).toMatchObject({ isSigner: true });
    expect(Buffer.from(ix.data.subarray(0, 8)).toString('hex')).toBe(Buffer.from(ixDiscriminator('resolve_battle')).toString('hex'));
    expect(new PublicKey(ix.data.subarray(8, 40)).equals(challenger)).toBe(true);
    expect(ix.data.length).toBe(8 + 32 + 32);
    // squads come from the chips projection
    const db = new Db(':memory:');
    const owner = kp();
    const assets = mint(db, owner, [{ rarity: 1, collection: 2 }, { rarity: 2, collection: 3 }, { rarity: 0, collection: 4 }]);
    const sq = squadFromDb(db, assets.map((a) => new PublicKey(a)))!;
    expect(sq.map((c) => [c.collection, c.rarity])).toEqual([[2, 1], [3, 2], [4, 0]]);
    expect(squadFromDb(db, [new PublicKey(kp())])).toBeUndefined();
  });
});

describe('anti-fraud detectors', () => {
  let db: Db; let alice: string; let bob: string; let sa: string[]; let sb: string[];
  const T = 1_800_000_000 + 12 * 3600;
  beforeEach(() => {
    db = new Db(':memory:');
    alice = kp(); bob = kp();
    sa = squadOf(mint(db, alice, [{ rarity: 2, collection: 0 }, { rarity: 2, collection: 1 }, { rarity: 1, collection: 2 }], { blockTime: T - 3 * 86_400 }));
    sb = squadOf(mint(db, bob, [{ rarity: 2, collection: 3 }, { rarity: 1, collection: 4 }, { rarity: 2, collection: 5 }], { blockTime: T - 3 * 86_400 }));
  });
  /** Insert a resolved ranked match directly (the detector reads the projection, not the engine). */
  const fakeMatch = (id: string, a: string, b: string, winner: string, endedS: number, rewardA = '0', rewardB = '0') =>
    db.run(`INSERT INTO matches (id, season, a, b, squad_a, squad_b, power_a, power_b, league, commit_a, commit_b, winner, status, forfeit, rewarded, reward_a, reward_b, started_at, ended_at) VALUES (?, 1, ?, ?, '[]', '[]', 500, 500, 0, '', '', ?, 'resolved', 0, ?, ?, ?, ?, ?)`,
      id, a, b, winner, rewardA !== '0' || rewardB !== '0' ? 1 : 0, rewardA, rewardB, endedS * 1000 - 1000, endedS * 1000);

  it('win-trading: a lopsided pair with a small rating gap is flagged; a mixed rivalry is not; the pair stops earning today', () => {
    arena.currentSeason(db, T);
    db.run(`INSERT INTO ratings (wallet, season, rating, games) VALUES (?, 1, 1010, 8), (?, 1, 990, 8)`, alice, bob);
    for (let i = 0; i < 8; i++) fakeMatch(`wt${i}`, alice, bob, i < 7 ? alice : bob, T - 3600 + i * 60, '2000000', '500000');
    const signals = antifraud.detectWinTrading(db, T);
    expect(signals.filter((s) => s.kind === 'win_trading').map((s) => s.wallet).sort()).toEqual([alice, bob].sort());
    expect(signals[0].evidence).toMatchObject({ matches: 8, winPct: 88, ratingGap: 20 });
    expect(signals[0].score).toBeGreaterThanOrEqual(60);
    expect(antifraud.suspiciousPairToday(db, alice, bob, T)).toBe(true);
    // the live reward path honours it: a real match between them now pays nothing
    const { matchId, na, nb } = pair(db, { wallet: alice, squad: sa }, { wallet: bob, squad: sb }, T);
    arena.reveal(db, alice, matchId, { nonce: na.toString('hex') }, T); arena.reveal(db, bob, matchId, { nonce: nb.toString('hex') }, T);
    const m = arena.matchApi(db, matchId)!;
    expect(m.rewardA).toBe('0'); expect(m.rewardB).toBe('0');
    // an honest rivalry: 8 matches split 4/4 → no signal, rewards flow (subject to the ≤ 3 same-opponent cap)
    const carol = kp(), dave = kp();
    db.run(`INSERT INTO ratings (wallet, season, rating, games) VALUES (?, 1, 1000, 8), (?, 1, 1000, 8)`, carol, dave);
    for (let i = 0; i < 8; i++) fakeMatch(`ok${i}`, carol, dave, i % 2 ? carol : dave, T - 3600 + i * 60);
    expect(antifraud.detectWinTrading(db, T).some((s) => s.wallet === carol || s.wallet === dave)).toBe(false);
    expect(antifraud.suspiciousPairToday(db, carol, dave, T)).toBe(false);
    // a lopsided pair whose ratings already diverged (honest stomping) is left alone
    const erin = kp(), finn = kp();
    db.run(`INSERT INTO ratings (wallet, season, rating, games) VALUES (?, 1, 1400, 30), (?, 1, 900, 30)`, erin, finn);
    for (let i = 0; i < 8; i++) fakeMatch(`st${i}`, erin, finn, erin, T - 3600 + i * 60);
    expect(antifraud.detectWinTrading(db, T).some((s) => s.wallet === erin)).toBe(false);
  });

  it('wash trades: the same chip bouncing A→B→A twice is flagged for both wallets', () => {
    const asset = sa[0];
    let t = T - 3000;
    for (let i = 0; i < 2; i++) {
      ingestTx(tx([{ program: 'market', name: 'ChipSold', data: { asset, seller: alice, buyer: bob, price: '100000000', currency: 0, fee: '0', royalty: '0', viaOffer: false } }], { blockTime: t += 60 }), db);
      ingestTx(tx([{ program: 'market', name: 'ChipSold', data: { asset, seller: bob, buyer: alice, price: '100000000', currency: 0, fee: '0', royalty: '0', viaOffer: false } }], { blockTime: t += 60 }), db);
    }
    const s = antifraud.detectWashTrades(db, T);
    expect(s.map((x) => x.wallet).sort()).toEqual([alice, bob].sort());
    expect(s[0]).toMatchObject({ kind: 'wash_trade', evidence: { asset, roundTrips: 2 } });
    expect(s[0].score).toBeGreaterThanOrEqual(80);
  });

  it('quest bots: 25 logins at the same minute with no other activity; multi-account: a referrer with 5 starter-only siblings', () => {
    const bot = kp();
    db.run(`INSERT INTO wallets (address, first_seen) VALUES (?, ?)`, bot, T - 40 * 86_400);
    const day = quests.dayIndex(T);
    for (let d = 0; d < 26; d++) quests.recordLogin(db, bot, (day - d) * 86_400 + 9 * 3600 + 61); // 09:01 every day
    const qb = antifraud.detectQuestBots(db, T);
    expect(qb).toHaveLength(1);
    expect(qb[0]).toMatchObject({ wallet: bot, kind: 'quest_bot', evidence: { consecutiveLogins: 26, minuteSpread: 0 } });
    // alice logs in at random times → not flagged
    for (let d = 0; d < 26; d++) quests.recordLogin(db, alice, (day - d) * 86_400 + (d * 37 % 1440) * 60);
    expect(antifraud.detectQuestBots(db, T).some((s) => s.wallet === alice)).toBe(false);
    // referral ring
    const referrer = kp();
    for (let i = 0; i < 5; i++) {
      const sib = kp();
      mint(db, sib, [{ rarity: 0, collection: 0 }], { sku: 0 });
      db.run(`UPDATE wallets SET referrer = ? WHERE address = ?`, referrer, sib);
    }
    const ma = antifraud.detectMultiAccounts(db);
    expect(ma).toHaveLength(1);
    expect(ma[0]).toMatchObject({ wallet: referrer, kind: 'multi_account', evidence: { starterOnlySiblings: 5 } });
    // one sibling buys a paid pack → ring shrinks below the threshold
    const paid = ma[0].evidence.sample as string[];
    mint(db, paid[0], [{ rarity: 0, collection: 1 }], { sku: 1 });
    expect(antifraud.detectMultiAccounts(db)).toHaveLength(0);
  });

  it('signals persist once per subject, ops resolution writes wallet flags: rewardsPaused stops quests + match rewards + season slots, shadowBanned hides from boards', async () => {
    arena.currentSeason(db, T);
    db.run(`INSERT INTO ratings (wallet, season, rating, games) VALUES (?, 1, 1010, 8), (?, 1, 990, 8)`, alice, bob);
    for (let i = 0; i < 8; i++) fakeMatch(`wt${i}`, alice, bob, alice, T - 3600 + i * 60);
    expect(antifraud.recordSignals(db, antifraud.runDetectors(db, T), T)).toBe(2);
    expect(antifraud.recordSignals(db, antifraud.runDetectors(db, T + 60), T + 60)).toBe(0); // refreshed, not duplicated
    expect(db.scalar(`SELECT COUNT(*) FROM fraud_signals`)).toBe(2);
    const queue = antifraud.fraudQueue(db);
    expect(queue).toHaveLength(2);
    expect(queue[0]).toMatchObject({ kind: 'win_trading', flags: {} });
    // the oracle cycle runs the detectors and reports them
    finalizeAll(db);
    const r = await oracle.runOnce({ connection: asConn(new FakeConnection()), db, minBatchMicro: 1n }, T + 100);
    expect(r.signals).toBe(0); // already open
    expect(antifraud.antifraudStatus(db)).toMatchObject({ openSignals: { win_trading: 2 }, paused: 0, shadowBanned: 0 });
    // ops: pause alice's rewards → no quest $CG, no match rewards, no season bracket slot; shadow-ban bob → hidden from boards
    expect(antifraud.resolveWallet(db, alice, 'rewards_pause', 'ops:test', 'win trading ring #1')).toMatchObject({ flags: { rewardsPaused: true, note: 'win trading ring #1' }, closed: 1 });
    expect(antifraud.resolveWallet(db, bob, 'shadow_ban', 'ops:test')).toMatchObject({ flags: { shadowBanned: true }, closed: 1 });
    expect(antifraud.fraudQueue(db)).toHaveLength(0);
    expect(quests.eligibility(db, alice, T)).toMatchObject({ eligible: false, reason: 'rewards_paused' });
    const carol = kp(); const sc = squadOf(mint(db, carol, [{ rarity: 2, collection: 6 }, { rarity: 2, collection: 7 }, { rarity: 1, collection: 8 }], { blockTime: T - 3 * 86_400 }));
    const { matchId, na, nb } = pair(db, { wallet: alice, squad: sa }, { wallet: carol, squad: sc }, T);
    arena.reveal(db, alice, matchId, { nonce: na.toString('hex') }, T); arena.reveal(db, carol, matchId, { nonce: nb.toString('hex') }, T);
    const m = arena.matchApi(db, matchId)!;
    expect(m.rewardA).toBe('0');                      // alice paused
    expect(BigInt(m.rewardB)).toBeGreaterThan(0n);    // carol still earns
    const board = (me?: string) => q.leaderboard(db, 'rating', 50, undefined, me, 1);
    expect(board().items.map((x) => x.wallet)).not.toContain(bob);
    expect(board().items.map((x) => x.wallet)).toContain(alice);
    expect(board(bob).me).toEqual({ rank: 2, value: 990 }); // the banned wallet still sees a plausible own rank
    // season settlement skips both (alice paused, bob shadow-banned) even though they have the games
    db.run(`UPDATE ratings SET games = 12 WHERE season = 1`);
    for (let i = 0; i < 12; i++) fakeMatch(`s${i}`, alice, bob, alice, T - 7200 + i * 60);
    ingestTx(tx([{ program: 'staking', name: 'DayClosed', data: { dayIndex: 1, year: 0, scheduleCap: '271232876712', guarded: '100000000000', burn7dAvg: '0', sliceBudget: ['0', '0', '0', '0', '0'] } }], { blockTime: T + 60 }), db);
    finalizeAll(db);
    const s = arena.currentSeason(db, T);
    const settled = arena.settleSeason(db, s.id, s.ends_at + 1)!;
    expect(settled.participants).toBe(0);
    expect(settled.rows).toBe(0);
    // unflag restores everything
    expect(antifraud.resolveWallet(db, alice, 'unflag', 'ops:test').flags).toEqual({ note: 'win trading ring #1' });
    expect(quests.eligibility(db, alice, T).eligible).toBe(true);
  });
});
