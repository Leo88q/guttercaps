import { describe, it, expect, beforeEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { Db, PROJECTION_TABLES } from '../src/db.ts';
import { healEventTimes, ingestTx, replayStored, untimedStatus } from '../src/ingest.ts';
import { compressedMintClaimPda } from '../src/chain.ts';
import * as q from '../src/queries.ts';
import { world, tx, kp, DEFAULT, hex32 } from './fixtures.ts';

let db: Db;
beforeEach(() => { db = new Db(':memory:'); });

describe('ingest + projections', () => {
  it('stores every event once and applies projections in order', () => {
    const w = world();
    let inserted = 0;
    for (const t of w.txs) inserted += ingestTx(t, db).inserted;
    expect(inserted).toBe(15);
    expect(db.scalar(`SELECT COUNT(*) FROM events_raw`)).toBe(15);

    // inventory: alice opened 6 chips, sold 1, burned 3 in a fusion, gained 1 → 3 alive
    const alice = q.myChips(db, w.alice, {});
    expect(alice.total).toBe(3);
    expect(alice.items.map((c) => c.asset)).toContain(w.chips[4]);
    expect(alice.items.find((c) => c.asset === w.chips[4])!.rarity).toBe(1);   // Common+ from recipe 0
    expect(alice.items.find((c) => c.asset === w.chips[4])!.flags.staked).toBe(true);
    const bob = q.myChips(db, w.bob, {});
    expect(bob.items.map((c) => c.asset)).toEqual([w.chips[2]]);
    expect(bob.items[0].flags.listed).toBe(false);

    // market
    expect(db.scalar(`SELECT COUNT(*) FROM listings`)).toBe(0);
    const sales = q.history(db, {});
    expect(sales.items).toHaveLength(1);
    expect(sales.items[0]).toMatchObject({ seller: w.alice, buyer: w.bob, currency: 'SOL', fee: '7500000', royalty: '2500000', rarity: 2 });

    // boards: chain-verified wager wins; the season rating board is empty until the server arena has a match
    const lb = q.leaderboard(db, 'wins', 10, undefined, w.alice);
    expect(lb.items[0]).toMatchObject({ wallet: w.alice, value: 1 });
    expect(lb.me).toEqual({ rank: 1, value: 1 });
    expect(q.leaderboard(db, 'rating', 10, undefined, w.alice)).toMatchObject({ season: 0, me: null, items: [] });

    // staking
    expect(db.scalar(`SELECT COUNT(*) FROM stakes WHERE active = 1`)).toBe(2);
    const st = q.stats(db);
    expect(st).toMatchObject({ chipsMinted: 7, chipsAlive: 4, packsOpened: 2, totalBattlesResolved: 1, fusions: 1, sales: 1, chipsCurrentlyStaked: 1, tokenStakedMicro: '500000000', servicesSold: 1 });
    // fusion fee + service payment (chip_core BurnReported) + 0.5 $CG listing fee (market) + 2 $CG rake burn (arena)
    expect(st.burnedCgMicro).toBe(String(2_500_000 + 199_000_000 + 500_000 + 2_000_000));

    // pack open result + pity
    const open = q.packOpen(db, w.packSig)!;
    expect(open.chips).toHaveLength(3);
    expect(open.highlights.bestRarity).toBe(2);
    expect(q.me(db, w.alice).pity.counters[1]).toBe(6);
  });

  it('tracks compressed claims through mint, registration, timeout cancellation, and settlement', () => {
    const buyer = kp();
    const nonce = '77';
    const claims = ['9856', '9857', '0', '0', '0'];
    ingestTx(tx([{ program: 'chip_core', name: 'CompressedClaimsCreated', data: { buyer, nonce, packNo: 0, claimNonces: claims, count: 2 } }]), db);
    ingestTx(tx([{ program: 'chip_core', name: 'CompressedChipMinted', data: { buyer, collectionIdx: 2, claimNonce: claims[0], rarity: 3, level: 1, gameIndex: '19', claim: compressedMintClaimPda(new PublicKey(buyer), BigInt(claims[0]!))[0].toBase58() } }]), db);
    // H1: the register event carries the claim's soulbound window — a Starter lock lands on the chip row
    const t0 = Math.floor(Date.now() / 1000) - 60;
    const soulbound = kp();
    ingestTx(tx([{ program: 'chip_core', name: 'CompressedChipRegistered', data: { asset: soulbound, claimNonce: claims[0], claim: compressedMintClaimPda(new PublicKey(buyer), BigInt(claims[0]!))[0].toBase58(), collectionIdx: 2, merkleTree: kp(), leafIndex: 4, leafNonce: '0', owner: buyer, delegate: buyer, rarity: 3, level: 1, gameIndex: '19', flags: 8, lockUntil: String(t0 + 7 * 86_400) } }], { blockTime: t0 }), db);
    ingestTx(tx([{ program: 'chip_core', name: 'CompressedClaimCancelled', data: { buyer, nonce, claimNonce: claims[1] } }]), db);
    ingestTx(tx([{ program: 'chip_core', name: 'CompressedPackSettled', data: { buyer, nonce, refunded: true } }]), db);
    expect(db.scalar(`SELECT COUNT(*) FROM compressed_claims`)).toBe(2);
    expect(db.scalar(`SELECT COUNT(*) FROM compressed_claims WHERE status = 'registered'`)).toBe(1);
    expect(db.scalar(`SELECT COUNT(*) FROM compressed_claims WHERE status = 'cancelled'`)).toBe(1);
    expect(db.get<{ total_claims: number; registered_claims: number; cancelled_claims: number; status: string }>(`SELECT * FROM compressed_settlements`)).toMatchObject({ total_claims: 2, registered_claims: 1, cancelled_claims: 1, status: 'refunded' });
    expect(db.scalar(`SELECT COUNT(*) FROM chips WHERE origin = 'compressed'`)).toBe(1);
    const c = q.myChips(db, buyer, {}).items.find((x) => x.asset === soulbound)!;
    expect(c.flags.soulbound).toBe(true);
    expect(c.lockUntil).toBe(new Date((t0 + 7 * 86_400) * 1000).toISOString());
    expect(q.myChips(db, buyer, { status: 'free' }).total).toBe(0);
    expect(q.myChips(db, buyer, { status: 'locked' }).total).toBe(1);
  });

  it('is idempotent: re-ingesting the same transactions changes nothing', () => {
    const w = world();
    for (const t of w.txs) ingestTx(t, db);
    const before = q.stats(db);
    let inserted = 0;
    for (const t of w.txs) inserted += ingestTx(t, db).inserted;
    expect(inserted).toBe(0);
    expect(q.stats(db)).toEqual(before);
  });

  it('fills block_time later when a websocket-first event is backfilled', () => {
    const w = world();
    const live = { ...w.txs[0], blockTime: null };
    ingestTx(live, db);
    expect(db.get<{ block_time: number | null }>(`SELECT block_time FROM events_raw`)!.block_time).toBeNull();
    ingestTx(w.txs[0], db);
    expect(db.get<{ block_time: number | null }>(`SELECT block_time FROM events_raw`)!.block_time).toBe(w.txs[0].blockTime);
  });

  it('rebuild: projections are a pure function of events_raw', () => {
    const w = world();
    for (const t of w.txs) ingestTx(t, db);
    const before = { stats: q.stats(db), alice: q.myChips(db, w.alice, {}), lb: q.leaderboard(db, 'collection', 10) };
    db.tx(() => { for (const t of PROJECTION_TABLES) db.run(`DELETE FROM ${t}`); });
    expect(q.stats(db).chipsMinted).toBe(0);
    expect(replayStored(db)).toBe(15);
    expect(q.stats(db)).toEqual(before.stats);
    expect(q.myChips(db, w.alice, {})).toEqual(before.alice);
    expect(q.leaderboard(db, 'collection', 10)).toEqual(before.lb);
  });

  it('failed fusion refunds the lowest-key material for recipes ≥ 4 and burns the rest', () => {
    const owner = kp();
    const mats = [kp(), kp(), kp()];
    ingestTx(tx([{ program: 'chip_core', name: 'PackOpened', data: { buyer: owner, sku: 2, nonce: '1', assets: [...mats, DEFAULT, DEFAULT], rarities: [4, 4, 4, 0, 0], collections: [1, 1, 1, 0, 0], count: 3, roll: hex32(1), pityBefore: 0, pityAfter: 1 } }]), db);
    ingestTx(tx([{ program: 'chip_core', name: 'ChipFused', data: { owner, recipe: 4, materials: mats, result: DEFAULT, success: false, rollBps: 9100, thresholdBps: 8500, feeBurned: '0' } }]), db);
    const alive = q.myChips(db, owner, {}).items.map((c) => c.asset);
    expect(alive).toHaveLength(1);
    const sortedByBytes = [...mats].sort((a, b) => Buffer.compare(Buffer.from(new PublicKey(a).toBytes()), Buffer.from(new PublicKey(b).toBytes())));
    expect(alive[0]).toBe(sortedByBytes[0]);
    expect(db.scalar(`SELECT COUNT(*) FROM fusions WHERE success = 0`)).toBe(1);
  });

  it('H3 claim fusion: commit touches the wallet, reveal writes the fusions row with the real roll', () => {
    const owner = kp();
    const mats = [kp(), kp(), kp()];
    const result = kp();
    ingestTx(tx([{ program: 'chip_core', name: 'ClaimFusionCommitted', data: { owner, nonce: '9', recipe: 4, materials: mats } }]), db);
    expect(db.scalar(`SELECT COUNT(*) FROM wallets WHERE address = ?`, owner)).toBe(1);
    expect(db.scalar(`SELECT COUNT(*) FROM fusions`)).toBe(0);
    ingestTx(tx([{ program: 'chip_core', name: 'ClaimFusionRevealed', data: { owner, nonce: '9', recipe: 4, materials: mats, resultClaim: result, success: true, rollBps: 4200, thresholdBps: 5000, feeBurned: '500000' } }]), db);
    const row = db.get<{ result: string; success: number; roll_bps: number; threshold_bps: number }>(`SELECT result, success, roll_bps, threshold_bps FROM fusions WHERE owner = ?`, owner)!;
    expect(row).toMatchObject({ result, success: 1, roll_bps: 4200, threshold_bps: 5000 });
    // failure: default-pubkey result → NULL, survivors stay off-ledger (unminted shells are not inventory)
    ingestTx(tx([{ program: 'chip_core', name: 'ClaimFusionRevealed', data: { owner, nonce: '10', recipe: 4, materials: mats, resultClaim: DEFAULT, success: false, rollBps: 9100, thresholdBps: 8500, feeBurned: '500000' } }]), db);
    expect(db.get<{ result: string | null }>(`SELECT result FROM fusions WHERE owner = ? AND success = 0`, owner)!.result).toBeNull();
    expect(db.scalar(`SELECT COUNT(*) FROM fusions`)).toBe(2);
    expect(db.scalar(`SELECT COUNT(*) FROM chips`)).toBe(0);
    expect(q.leaderboard(db, 'fusion', 10).items).toMatchObject([{ wallet: owner, value: 1 }]);
  });

  it('starter packs mint soulbound chips with a 7-day lock', () => {
    const owner = kp(); const a = kp();
    const t0 = Math.floor(Date.now() / 1000) - 60;
    ingestTx(tx([{ program: 'chip_core', name: 'PackOpened', data: { buyer: owner, sku: 0, nonce: '1', assets: [a, kp(), kp(), DEFAULT, DEFAULT], rarities: [0, 0, 2, 0, 0], collections: [0, 1, 2, 0, 0], count: 3, roll: hex32(1), pityBefore: 0, pityAfter: 0 } }], { blockTime: t0 }), db);
    const c = q.myChips(db, owner, {}).items.find((x) => x.asset === a)!;
    expect(c.flags.soulbound).toBe(true);
    expect(c.lockUntil).toBe(new Date((t0 + 7 * 86_400) * 1000).toISOString());
    expect(q.myChips(db, owner, { status: 'free' }).total).toBe(0);
    expect(q.myChips(db, owner, { status: 'locked' }).total).toBe(3);
    expect(q.me(db, owner).pity.starterClaimed).toBe(false); // starter purchases go through PackBought; none recorded here
  });

  it('floor matrix picks the cheapest USD-normalised listing per archetype', () => {
    const s = kp(); const a1 = kp(), a2 = kp();
    ingestTx(tx([{ program: 'chip_core', name: 'PackOpened', data: { buyer: s, sku: 1, nonce: '1', assets: [a1, a2, kp(), DEFAULT, DEFAULT], rarities: [2, 2, 0, 0, 0], collections: [4, 4, 4, 0, 0], count: 3, roll: hex32(1), pityBefore: 0, pityAfter: 0 } }]), db);
    ingestTx(tx([{ program: 'market', name: 'ChipListed', data: { asset: a1, seller: s, price: '200000000', currency: 0 } }]), db);   // 0.2 SOL ≈ $30 @150
    ingestTx(tx([{ program: 'market', name: 'ChipListed', data: { asset: a2, seller: s, price: '12000000', currency: 1 } }]), db);    // 12 USDC
    const f = q.floor(db);
    expect(f.floors[4][2]).toBe(12);
    expect(f.listedCount[4][2]).toBe(2);
    const l = q.listings(db, { sort: 'price_asc' });
    expect(l.items.map((i) => i.asset)).toEqual([a2, a1]);
    expect(q.listings(db, { currency: 'USDC' }).total).toBe(1);
  });

  it('SEC-L5 SliceFunded: season-pool recycling is a ledger row, not a burn (the guard ring must not see it); rebuild keeps it', () => {
    const oracleKey = kp();
    const burnsBefore = db.scalar(`SELECT COUNT(*) FROM burns`);
    ingestTx(tx([{ program: 'staking', name: 'SliceFunded', data: { by: oracleKey, kind: 3, amount: '2000000', sliceBudget: ['0', '0', '0', '12000000', '0'], recycledTotal: '2000000' } }], { blockTime: 1_700_000_500 }), db);
    const row = db.get<{ by_wallet: string; kind: number; amount: string; slice_budget: string; recycled_total: string; block_time: number }>(`SELECT * FROM slice_fundings`)!;
    expect(row).toMatchObject({ by_wallet: oracleKey, kind: 3, amount: '2000000', recycled_total: '2000000', block_time: 1_700_000_500 });
    expect(JSON.parse(row.slice_budget)).toEqual(['0', '0', '0', '12000000', '0']);
    expect(db.scalar(`SELECT COUNT(*) FROM burns`)).toBe(burnsBefore);
    expect(PROJECTION_TABLES).toContain('slice_fundings');
    replayStored(db);
    expect(db.scalar(`SELECT COUNT(*) FROM slice_fundings`)).toBe(1);
  });

  it('SKR prize pool: roots of kind ≥ 5 are SKR, ledger proves paid + reserved ≤ funded', () => {
    const treasury = kp(), alice = kp(), bob = kp();
    // treasury funds 1 000 SKR, oracle publishes a $CG quest root (kind 2) and an SKR quest root (kind 5, 300 SKR)
    ingestTx(tx([{ program: 'staking', name: 'SkrFunded', data: { funder: treasury, amount: '1000000000', budget: '1000000000', reserved: '0' } }]), db);
    ingestTx(tx([{ program: 'staking', name: 'RootPublished', data: { kind: 2, epoch: 7, root: hex32(0xaa), budget: '50000000' } }]), db);
    ingestTx(tx([{ program: 'staking', name: 'RootPublished', data: { kind: 5, epoch: 7, root: hex32(0xbb), budget: '300000000' } }]), db);
    ingestTx(tx([{ program: 'staking', name: 'SkrPoolChanged', data: { maxRootBudget: '100000000000', paused: false } }]), db);
    // alice claims 12.5 SKR from the SKR root and 9 $CG from the $CG root; bob's SKR root gets revoked afterwards
    ingestTx(tx([{ program: 'staking', name: 'RootClaimed', data: { kind: 5, epoch: 7, wallet: alice, amount: '12500000' } }]), db);
    ingestTx(tx([{ program: 'staking', name: 'RootClaimed', data: { kind: 2, epoch: 7, wallet: alice, amount: '9000000' } }]), db);
    ingestTx(tx([{ program: 'staking', name: 'RootPublished', data: { kind: 6, epoch: 1, root: hex32(0xcc), budget: '200000000' } }]), db);
    ingestTx(tx([{ program: 'staking', name: 'RootClaimed', data: { kind: 6, epoch: 1, wallet: bob, amount: '20000000' } }]), db);
    ingestTx(tx([{ program: 'staking', name: 'RootRevoked', data: { kind: 6, epoch: 1 } }]), db);
    ingestTx(tx([{ program: 'staking', name: 'SkrWithdrawn', data: { to: treasury, amount: '100000000', budget: '580000000' } }]), db);

    expect(db.all<{ kind: number; currency: string }>(`SELECT kind, currency FROM reward_roots ORDER BY kind`)).toEqual([
      { kind: 2, currency: 'CG' }, { kind: 5, currency: 'SKR' }, { kind: 6, currency: 'SKR' },
    ]);
    const pool = q.skrPool(db);
    expect(pool.fundedTotalMicro).toBe('1000000000');
    expect(pool.withdrawnTotalMicro).toBe('100000000');
    expect(pool.paidTotalMicro).toBe('32500000');            // 12.5 + 20 SKR — the $CG claim is not counted
    expect(pool.reservedMicro).toBe('287500000');            // live root 5: 300 − 12.5; revoked root 6 released
    expect(pool.budgetMicro).toBe('580000000');              // matches the on-chain `budget` echoed by SkrWithdrawn
    expect(pool.maxRootBudgetMicro).toBe('100000000000');
    expect(pool.paused).toBe(false);
    expect(BigInt(pool.paidTotalMicro) + BigInt(pool.reservedMicro) + BigInt(pool.withdrawnTotalMicro) <= BigInt(pool.fundedTotalMicro)).toBe(true);
    expect(q.stats(db).skrRewardsPaidMicro).toBe('32500000');
    expect(pool.roots.find((r) => r.kind === 6)!.revoked).toBe(true);
    // no SKR revenue yet → nothing due; funding is pure surplus
    expect(pool.funding.dueMicro).toBe('0');
    expect(pool.funding.surplusMicro).toBe('1000000000');
    expect(pool.funding.policyBps).toEqual({ packRevenue: 1500, marketFeeTreasury: 1000, servicesRevenue: 500 });
  });

  it('SKR funding audit: due = 15 % of opened SKR packs + 10 % of the treasury part of SKR sale fees + 5 % of SKR services', () => {
    const treasury = kp(), alice = kp(), bob = kp(), asset = kp();
    // 1 000 SKR standard pack, opened (revenue) + 500 SKR pack still pending (liability, not revenue) + 200 SKR pack cancelled
    ingestTx(tx([{ program: 'chip_core', name: 'PackBought', data: { buyer: alice, sku: 1, qty: 1, currency: 3, amount: '1000000000', nonce: '1', randomness: kp() } }]), db);
    ingestTx(tx([{ program: 'chip_core', name: 'PackOpened', data: { buyer: alice, sku: 1, nonce: '1', assets: [kp(), kp(), kp(), DEFAULT, DEFAULT], rarities: [0, 0, 1, 0, 0], collections: [1, 2, 3, 0, 0], count: 3, roll: hex32(0x01), pityBefore: 0, pityAfter: 1 } }]), db);
    ingestTx(tx([{ program: 'chip_core', name: 'PackBought', data: { buyer: alice, sku: 1, qty: 1, currency: 3, amount: '500000000', nonce: '2', randomness: kp() } }]), db);
    ingestTx(tx([{ program: 'chip_core', name: 'PackBought', data: { buyer: bob, sku: 1, qty: 1, currency: 3, amount: '200000000', nonce: '3', randomness: kp() } }]), db);
    ingestTx(tx([{ program: 'chip_core', name: 'PackCancelled', data: { buyer: bob, nonce: '3', refunded: '200000000' } }]), db);
    // a 100 SKR sale: fee 7.5 SKR → treasury part 5.00025 SKR; a SOL sale must not count
    ingestTx(tx([{ program: 'market', name: 'ChipSold', data: { asset, seller: alice, buyer: bob, price: '100000000', currency: 3, fee: '7500000', royalty: '2500000', viaOffer: false } }]), db);
    ingestTx(tx([{ program: 'market', name: 'ChipSold', data: { asset: kp(), seller: alice, buyer: bob, price: '100000000', currency: 0, fee: '7500000', royalty: '2500000', viaOffer: false } }]), db);
    // 100 SKR of services (+ a $CG one that must not count)
    ingestTx(tx([{ program: 'chip_core', name: 'ServicePaid', data: { buyer: alice, kind: 1, currency: 3, amount: '100000000', burned: '0', refHash: hex32(0x77) } }]), db);
    ingestTx(tx([{ program: 'chip_core', name: 'ServicePaid', data: { buyer: alice, kind: 0, currency: 2, amount: '199000000', burned: '199000000', refHash: hex32(0x78) } }]), db);
    // treasury funds 100 SKR
    ingestTx(tx([{ program: 'staking', name: 'SkrFunded', data: { funder: treasury, amount: '100000000', budget: '100000000', reserved: '0' } }]), db);

    const rev = q.skrRevenue(db);
    expect(rev.packRevenueMicro).toBe(1_000_000_000n);
    expect(rev.marketFeeTreasuryMicro).toBe(5_000_250n);
    expect(rev.servicesRevenueMicro).toBe(100_000_000n);
    const f = q.skrPool(db).funding;
    expect(f.dueBreakdownMicro).toEqual({ packs: '150000000', market: '500025', services: '5000000' });
    expect(f.dueMicro).toBe('155500025');
    expect(f.surplusMicro).toBe(String(100_000_000n - 155_500_025n)); // behind by 55.500025 SKR
    expect(f.treasuryWallet).toBe('HPMr5r9sS5ApWsPNJytZRLbm2jz1veFxTn1wepjAhtho');
  });

  it('SEC-H2 pause audit: PauseChanged from all three programs lands in pause_changes; /health reports the latest state per program', () => {
    const pauser = kp(), admin = kp();
    ingestTx(tx([{ program: 'chip_core', name: 'PauseChanged', data: { by: pauser, paused: true } }]), db);
    ingestTx(tx([{ program: 'staking', name: 'PauseChanged', data: { by: pauser, paused: true } }]), db);
    ingestTx(tx([{ program: 'arena', name: 'PauseChanged', data: { by: admin, paused: false } }]), db);
    ingestTx(tx([{ program: 'chip_core', name: 'PauseChanged', data: { by: admin, paused: false } }]), db);
    expect(db.scalar(`SELECT COUNT(*) FROM pause_changes`)).toBe(4);
    const st = q.pauseStatus(db);
    expect(st.chip_core).toMatchObject({ paused: false, by: admin });
    expect(st.staking).toMatchObject({ paused: true, by: pauser });
    expect(st.arena).toMatchObject({ paused: false, by: admin });
    // the same discriminator under an unrelated program (market) is ignored
    const before = db.scalar(`SELECT COUNT(*) FROM events_raw`);
    ingestTx(tx([{ program: 'market' as never, name: 'PauseChanged', data: { by: admin, paused: true } }]), db);
    expect(db.scalar(`SELECT COUNT(*) FROM events_raw`)).toBe(before);
  });
  // SEC-B13: a row the websocket delivered has no block_time, and only a re-read heals it. The live
  // healer reaches back LISTEN_HEAL_DEPTH signatures, so an outage leaves gaps — and every day-bucketed
  // query (metrics, quests, accrual, the season slice) then disagrees with a rebuild.
  it('healEventTimes fills block_time of stored events AND the projection rows written untimed', async () => {
    const w = world();
    const db = new Db(':memory:');
    // 1. the money event arrives over the websocket: no block time
    const delayed = tx([{ program: 'chip_core', name: 'PackBought', data: { buyer: kp(), sku: 1, qty: 1, currency: 0, amount: '33000000', nonce: '5', randomness: kp() } }], { blockTime: null });
    ingestTx(delayed, db);
    expect(db.scalar(`SELECT COUNT(*) FROM events_raw WHERE block_time IS NULL`)).toBe(1);
    expect(db.get<{ block_time: number | null }>(`SELECT block_time FROM pack_purchases`)!.block_time).toBeNull();
    // the divergence: a day-bucketed consumer (here the admin revenue counter) cannot see the row,
    // while a rebuild — which replays the stored event with its time — would count it
    const payer = db.get<{ buyer: string }>(`SELECT buyer FROM pack_purchases LIMIT 1`)!.buyer;
    const revenue30 = () => db.scalar(`SELECT COUNT(DISTINCT buyer) FROM pack_purchases WHERE sku > 0 AND buyer = ? AND COALESCE(block_time, 0) >= ?`, payer, 1_700_000_000 - 30 * 86_400);
    expect(revenue30()).toBe(0);
    // 2. the heal pass re-reads exactly that signature; the RPC now knows the time
    const conn = { getTransaction: async () => ({ slot: delayed.slot, blockTime: 1_700_000_123, meta: { logMessages: delayed.logs, err: null } }) };
    expect(await healEventTimes(conn as never, db, 25)).toBe(1);
    expect(db.scalar(`SELECT COUNT(*) FROM events_raw WHERE block_time IS NULL`)).toBe(0);
    expect(db.get<{ block_time: number | null }>(`SELECT block_time FROM pack_purchases`)!.block_time).toBe(1_700_000_123); // patchLateTimes ran, not just events_raw
    expect(revenue30()).toBe(1); // and the day-bucketed consumer agrees with a rebuild now
    // 3. idempotent: nothing left to heal, and a re-run changes nothing
    expect(await healEventTimes(conn as never, db, 25)).toBe(0);
    expect(db.scalar(`SELECT COUNT(*) FROM pack_purchases`)).toBe(1);
  });

  it('healEventTimes survives an RPC that no longer serves the signature (the row stays NULL, nothing throws)', async () => {
    const db = new Db(':memory:');
    ingestTx(tx([{ program: 'chip_core', name: 'PackBought', data: { buyer: kp(), sku: 1, qty: 1, currency: 0, amount: '33000000', nonce: '6', randomness: kp() } }], { blockTime: null }), db);
    const gone = { getTransaction: async () => null };
    expect(await healEventTimes(gone as never, db, 25)).toBe(0);
    expect(db.scalar(`SELECT COUNT(*) FROM events_raw WHERE block_time IS NULL`)).toBe(1);
  });

  it('healEventTimes falls back to the slot time when the transaction itself is gone from the RPC', async () => {
    const db = new Db(':memory:');
    ingestTx(tx([{ program: 'chip_core', name: 'PackBought', data: { buyer: kp(), sku: 1, qty: 1, currency: 0, amount: '33000000', nonce: '6', randomness: kp() } }], { blockTime: null }), db);
    const gone = { getTransaction: async () => null, getBlockTime: async () => 1_700_000_777 };
    expect(await healEventTimes(gone as never, db, 25)).toBe(1);
    expect(db.get<{ block_time: number | null }>(`SELECT block_time FROM events_raw`)!.block_time).toBe(1_700_000_777);
    // the projection is patched too, not just the raw row (that is what `patchLateTimes` is for)
    expect(db.get<{ block_time: number | null }>(`SELECT block_time FROM pack_purchases`)!.block_time).toBe(1_700_000_777);
  });

  it('an unhealable signature is parked after the attempt cap, so it cannot starve the rows that can be healed', async () => {
    const db = new Db(':memory:');
    const dead = (nonce: string) => tx([{ program: 'chip_core', name: 'PackBought', data: { buyer: kp(), sku: 1, qty: 1, currency: 0, amount: '11000000', nonce, randomness: kp() } }], { blockTime: null });
    const a = dead('1'), b = dead('2'), live = dead('3');
    for (const t of [a, b, live]) ingestTx(t, db);
    const times = new Map([[live.signature, 1_700_000_999]]);
    const conn = {
      getTransaction: async (sig: string) => (times.has(sig) ? { slot: 1, blockTime: times.get(sig)!, meta: { logMessages: live.logs, err: null } } : null),
      getBlockTime: async () => null, // the slot is gone too — this row can never be healed
    };
    // batch of 2, cap of 1 attempt: pass 1 spends itself on the two oldest (both dead), pass 2 reaches `live`
    expect(await healEventTimes(conn as never, db, 2, 1)).toBe(0);
    expect(db.all<{ signature: string }>(`SELECT signature FROM events_raw WHERE time_heal_attempts > 0`).map((r) => r.signature).sort()).toEqual([a.signature, b.signature].sort());
    expect(await healEventTimes(conn as never, db, 2, 1)).toBe(1);
    expect(times.size).toBe(1);
    expect(db.scalar(`SELECT COUNT(*) FROM events_raw WHERE block_time IS NULL`)).toBe(2);
    // and an operator can see the difference between "waiting" and "parked"
    expect(untimedStatus(db, 1)).toEqual({ pending: 0, stuck: 2, oldestSlot: a.slot < b.slot ? a.slot : b.slot });
    expect(untimedStatus(db, 99)).toEqual({ pending: 2, stuck: 0, oldestSlot: a.slot < b.slot ? a.slot : b.slot });
  });

});
