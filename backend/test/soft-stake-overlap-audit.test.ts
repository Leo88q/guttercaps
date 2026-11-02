// Reproducer: Phase-G "soft" staking does not know about the on-chain staking program, so the same
// chip can draw the chip-staking slice of emission twice — once from the program's pool and once as a
// plain `$CG` transfer out of the treasury (backend/src/phaseg-staking.ts:19-30,46-85,104-134,
// backend/src/crank.ts:1032-1036,1057-1061).
//
// `stakeChip` rejects a burned chip, a chip on cooldown and a *listed* chip (`flags & 0b010`), but not
// a chip that is already staked on chain (`flags & 0b001`, set by `chip_core::set_chip_flag` when the
// staking program CPI-stakes it). `accrueStakingDay` then pays every soft stake the full
// `EMISSION_SPLIT.chipStaking` share of the guarded emission — the very slice the on-chain pool
// distributes to the same chips (`staking::stake`/`Pool.acc_reward_per_weight`, mirrored by
// `backend/src/staking.ts:41-47`).
//
// In phase G there is no staking program, so the soft path *is* the budget. In phase V both exist: the
// crank runs `accrueStakingDay` (`crank.ts:1057`) next to the on-chain program, and the HTTP routes
// (`POST /v1/me/phaseg/stake`) are mounted in every phase (`server.ts:711`). Nothing anywhere checks
// "this chip already earns from the pool".
import { describe, expect, it } from 'vitest';
import { EMISSION_SPLIT } from '@guttercaps/economy';
import { Db } from '../src/db.ts';
import { accrueStakingDay, stakeChip } from '../src/phaseg-staking.ts';
import { latestEmissionDay } from '../src/staking.ts';

const DAY = 86_400;

function chip(db: Db, asset: string, owner: string, flags: number, level = 1) {
  db.run(
    `INSERT INTO chips (asset, owner, collection_idx, rarity, level, flags, lock_until, origin, minted_at)
     VALUES (?, ?, 0, 3, ?, ?, 0, 'pack', 0)`,
    asset, owner, level, flags,
  );
}

describe('phase-G soft staking vs the on-chain pool', () => {
  it('soft-stakes a chip that is already staked on chain', () => {
    const db = new Db(':memory:');
    const wallet = 'So11111111111111111111111111111111111111112';
    chip(db, 'staked-on-chain', wallet, 0b001); // bit0 = staked (chips.flags comment, db.ts:110)
    chip(db, 'listed', wallet, 0b010);

    // Control: the gate that *is* implemented.
    expect(() => stakeChip(db, wallet, 'listed', 1_800_000_000)).toThrow(/listed chip cannot stake/);
    // The gate that is not: an on-chain staked chip is accepted into the off-chain pool.
    const r = stakeChip(db, wallet, 'staked-on-chain', 1_800_000_000);
    expect(r.asset).toBe('staked-on-chain');

    // The day pays the whole chip-staking slice to that wallet, from a budget separate from the pool.
    const day = Math.floor(1_800_000_000 / DAY);
    accrueStakingDay(db, day, 1_800_000_000);
    const paid = db.get<{ pending_micro: string }>(`SELECT pending_micro FROM phaseg_rewards WHERE wallet = ?`, wallet);
    const emission = latestEmissionDay(db);
    const chipBudget = (emission.guardedMicro * BigInt(EMISSION_SPLIT.chipStaking)) / 100n;

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      softStakeAcceptedWhileOnChainStaked: r.asset === 'staked-on-chain',
      pendingMicro: paid?.pending_micro,
      dayBudgetMicro: chipBudget.toString(),
      chipStakingSplitPct: EMISSION_SPLIT.chipStaking,
      emissionSource: emission.source,
    }));

    expect(BigInt(paid?.pending_micro ?? '0')).toBeGreaterThan(0n);
    expect(chipBudget).toBeGreaterThan(0n);
    db.raw.close();
  });
});
