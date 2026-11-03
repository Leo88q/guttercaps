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
// (`POST /v1/me/phaseg/stake`) are mounted in every phase (`server.ts:711`). Nothing anywhere checked
// "this chip already earns from the pool" — исправлено: `stakeChip` отказывает чипу с битом 0 без
// строки `phaseg_stakes` (бит ставит только CPI staking-программы), повторного среза эмиссии нет.
import { describe, expect, it } from 'vitest';
import { EMISSION_SPLIT } from '@guttercaps/economy';
import { Db } from '../src/db.ts';
import { accrueStakingDay, softStakingLive, stakeChip } from '../src/phaseg-staking.ts';
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
  it('refuses to soft-stake a chip that is already staked on chain', () => {
    const db = new Db(':memory:');
    const wallet = 'So11111111111111111111111111111111111111112';
    chip(db, 'staked-on-chain', wallet, 0b001); // bit0 = staked (chips.flags comment, db.ts:110)
    chip(db, 'listed', wallet, 0b010);

    // Control: the gate that was already implemented.
    expect(() => stakeChip(db, wallet, 'listed', 1_800_000_000, 'g')).toThrow(/listed chip cannot stake/);
    // Находка 15: бит 0 без строки `phaseg_stakes` = чип застейкан на цепи, а он уже получает долю
    // из он-чейн пула — soft-стейк отказывает, второго среза эмиссии не появляется.
    expect(() => stakeChip(db, wallet, 'staked-on-chain', 1_800_000_000, 'g')).toThrow(/already staked on chain/);

    // День не платит ничего этому кошельку: двойного среза эмиссии нет.
    const day = Math.floor(1_800_000_000 / DAY);
    accrueStakingDay(db, day, 1_800_000_000, 'g');
    const paid = db.get<{ pending_micro: string }>(`SELECT pending_micro FROM phaseg_rewards WHERE wallet = ?`, wallet);
    const emission = latestEmissionDay(db);
    const chipBudget = (emission.guardedMicro * BigInt(EMISSION_SPLIT.chipStaking)) / 100n;

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      softStakeAcceptedWhileOnChainStaked: false,
      pendingMicro: paid?.pending_micro ?? '0',
      dayBudgetMicro: chipBudget.toString(),
      chipStakingSplitPct: EMISSION_SPLIT.chipStaking,
      emissionSource: emission.source,
    }));

    expect(BigInt(paid?.pending_micro ?? '0')).toBe(0n);
    expect(chipBudget).toBeGreaterThan(0n);
    db.raw.close();
  });

  it('soft-путь живёт только в фазе G: в v и в эталонном full пул владеет срезом (пп. 15, 74)', () => {
    const db0 = new Db(':memory:');
    const wallet0 = 'So11111111111111111111111111111111111111112';
    chip(db0, 'plain', wallet0, 0);
    expect(softStakingLive('g')).toBe(true);
    expect(softStakingLive('v')).toBe(false);
    // Находка 74: эталонный прод-профиль (п. 60) — `LAUNCH_PHASE=full`; раньше условие было `phase !== 'v'`
    // и в `full` soft-путь платил второй срез эмиссии рядом с работающим он-чейн пулом.
    expect(softStakingLive('full')).toBe(false);
    db0.raw.close();

    for (const phase of ['v', 'full'] as const) {
      const db = new Db(':memory:');
      const wallet = 'So11111111111111111111111111111111111111112';
      chip(db, 'plain', wallet, 0);
      expect(() => stakeChip(db, wallet, 'plain', 1_800_000_000, phase)).toThrow(/exists only in Phase G/);
      const day = Math.floor(1_800_000_000 / DAY);
      expect(accrueStakingDay(db, day, 1_800_000_000, phase)).toEqual({ credited: 0, budgetMicro: '0' });
      expect(db.get(`SELECT pending_micro FROM phaseg_rewards WHERE wallet = ?`, wallet)).toBeUndefined();
      // день даже не помечен обработанным: payout-цикл не «съест» его навсегда
      expect(db.get(`SELECT day_index FROM phaseg_stake_days WHERE day_index = ?`, day)).toBeUndefined();
      db.raw.close();
    }
  });
});
