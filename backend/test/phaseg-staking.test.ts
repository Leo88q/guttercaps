// Phase-G soft staking (docs/MINIMAL-LAUNCH-CHECKLIST.md §5): stake records,
// ownership-checked daily accrual, idempotent claims and payouts.
import { beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { Db } from '../src/db.ts';
import * as staking from '../src/phaseg-staking.ts';

const T0 = 1_800_000_000;
const WALLET = Keypair.generate().publicKey.toBase58();
const OTHER = Keypair.generate().publicKey.toBase58();
let db: Db;
let seq = 0;
function chip(owner = WALLET, rarity = 0): string {
  const asset = `chip${seq++}`;
  db.run(`INSERT INTO chips (asset, owner, collection_idx, rarity, level, flags, lock_until, origin) VALUES (?, ?, 0, ?, 1, 0, 0, 'pack')`, asset, owner, rarity);
  return asset;
}
beforeEach(() => { db = new Db(':memory:'); seq = 0; });

describe('stake/unstake (§5.1)', () => {
  it('stakes own chip, blocks double stake and foreign stake, unstakes', () => {
    const a = chip();
    expect(staking.stakeChip(db, WALLET, a, T0).stakedAt).toBe(T0);
    expect(db.get<{ flags: number }>(`SELECT flags FROM chips WHERE asset=?`, a)?.flags).toBe(1);
    expect(() => staking.stakeChip(db, WALLET, a, T0)).toThrow(/already staked/);
    expect(() => staking.stakeChip(db, OTHER, chip(), T0)).toThrow(/Only the owner/);
    staking.unstakeChip(db, WALLET, a, T0);
    expect(db.get<{ flags: number }>(`SELECT flags FROM chips WHERE asset=?`, a)?.flags).toBe(0);
  });
});

describe('accrual (§5.1)', () => {
  it('credits pro-rata by weight; sold chip stops earning and is auto-unstaked', () => {
    const mine = chip(WALLET, 0);
    const sold = chip(WALLET, 0);
    const foreign = chip(OTHER, 0);
    staking.stakeChip(db, WALLET, mine, T0);
    staking.stakeChip(db, WALLET, sold, T0);
    staking.stakeChip(db, OTHER, foreign, T0);
    db.run(`UPDATE chips SET owner=? WHERE asset=?`, OTHER, sold); // sold mid-day
    const r1 = staking.accrueStakingDay(db, 1, T0);
    expect(r1.credited).toBe(2); // me + OTHER; the sold chip earned nothing
    const me = staking.stakingMe(db, WALLET);
    const other = staking.stakingMe(db, OTHER);
    expect(BigInt(me.pendingMicro)).toBeGreaterThan(0n);
    expect(me.pendingMicro).toBe(other.pendingMicro); // equal weights → equal shares
    expect(me.staked.map((s) => s.asset)).toEqual([mine]); // sold stake closed
    // same day again → idempotent no-op
    expect(staking.accrueStakingDay(db, 1, T0).credited).toBe(0);
    expect(staking.stakingMe(db, WALLET).pendingMicro).toBe(me.pendingMicro);
  });
});

describe('claims (§5.2)', () => {
  it('claim moves pending into one payout; crank pays once; second claim is the same row', async () => {
    const a = chip();
    staking.stakeChip(db, WALLET, a, T0);
    staking.accrueStakingDay(db, 1, T0);
    const c1 = staking.claimRewards(db, WALLET, T0);
    expect(BigInt(c1.amountMicro)).toBeGreaterThan(0n);
    expect(staking.stakingMe(db, WALLET).pendingMicro).toBe('0');
    const c2 = staking.claimRewards(db, WALLET, T0); // payout still pending → same row
    expect(c2.payoutId).toBe(c1.payoutId);
    let sends = 0;
    const send = async () => { sends++; return 'sig'.padEnd(40, 'x'); };
    expect((await staking.processPayouts(db, send, T0)).paid).toBe(1);
    expect((await staking.processPayouts(db, send, T0)).paid).toBe(0); // never twice
    expect(sends).toBe(1);
    const me = staking.stakingMe(db, WALLET);
    expect(me.claimedMicro).toBe(c1.amountMicro);
    expect(me.payouts[0].status).toBe('sent');
  });

  it('claim with nothing pending is rejected', () => {
    expect(() => staking.claimRewards(db, WALLET, T0)).toThrow(/No pending rewards/);
  });
});
