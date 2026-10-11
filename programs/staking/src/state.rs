use anchor_lang::prelude::*;

pub const CG_DECIMALS: u8 = 6;
pub const MICRO: u64 = 1_000_000;
pub const HARD_CAP_MICRO: u64 = 1_000_000_000 * MICRO;
pub const PLAY_BUCKET_MICRO: u64 = HARD_CAP_MICRO / 100 * 55;
/// % of the play bucket emitted per year (schedule ceiling). Σ = 78 %.
pub const YEARLY_PCT: [u8; 8] = [18, 15, 12, 10, 8, 6, 5, 4];
pub const DAY: i64 = 86_400;
pub const YEAR_DAYS: i64 = 365;
pub const ACC_PRECISION: u128 = 1_000_000_000_000; // 1e12
pub const SPLIT_COUNT: usize = 5; // chip / token / quests / pvp / events
pub const MAX_SPLIT_DELTA_BPS: u16 = 1_000; // ±10 pp per change
pub const MIN_SPLIT_INTERVAL: i64 = 7 * DAY;
pub const GUARD_FLOOR_BPS: u64 = 200; // 0.02 × cap
pub const GUARD_BURN_MULT_BPS: u64 = 12_500; // 1.25 × trailing burn
/// SEC-M1 sanity clamp for `report_burn`: `burn_today` never exceeds this multiple of the
/// day's schedule cap. The guard saturates at `cap` once the 7-day average passes 0.56 × cap,
/// so nothing above 3 × cap can change the emission — a lying oracle is bounded by the schedule.
pub const BURN_SANITY_MULT: u64 = 3;
pub const ROOT_TIMELOCK: i64 = 3_600;
pub const TIER_COUNT: usize = 4;
pub const TIER_LOCK_SECS: [i64; TIER_COUNT] = [0, 30 * DAY, 90 * DAY, 180 * DAY];
pub const TIER_BOOST_BPS: [u64; TIER_COUNT] = [10_000, 15_000, 22_000, 30_000];
pub const TIER_PENALTY_BPS: [u64; TIER_COUNT] = [0, 500, 1_000, 1_500];

/// Early-exit penalty for unstaking `amount` from a locked tier, **rounded up** (SEC-F3): with a
/// floor, splitting an early exit into chunks of ≤ 19 micro-$CG (500 bps) paid no penalty at all.
/// Ceil keeps every non-zero early exit ≥ 1 micro burned and never exceeds `amount` (bps ≤ 10 000).
/// Mirrors `client/src/chain/ix/staking.ts::unstakePenalty` and `backend/src/staking.ts`.
pub fn early_exit_penalty(amount: u64, penalty_bps: u64) -> u64 {
    let bps = penalty_bps.min(10_000) as u128;
    ((amount as u128 * bps).div_ceil(10_000)) as u64
}
pub const MIN_STAKE_MICRO: u64 = 10 * MICRO;
/// Per-wallet daily claim caps (launch cash rails). Excess pending is not minted.
pub const CHIP_STAKE_DAILY_CAP_MICRO: u64 = 30 * MICRO;
pub const TOKEN_STAKE_DAILY_CAP_MICRO: u64 = 15 * MICRO;
/// A chip that has not been in a Cap Slam for this long keeps 25 % stake weight.
pub const ALIVE_WINDOW_SECS: i64 = 7 * DAY;
pub const IDLE_WEIGHT_BPS: u64 = 2_500;
pub const SET_BONUS_CAP_BPS: u64 = 17_000;
/// Reward-root kinds: 0..4 are $CG emission slices (`Slice`), 5..7 are SKR prize-pool roots
/// (quests / season / events) paid from `SkrPool` — never minted. Mirrored in
/// packages/economy/src/skrRewards.ts (`REWARD_ROOT_KINDS`) and checked by sync-check.
pub const SKR_ROOT_KIND_BASE: u8 = 5;
pub const SKR_KIND_QUESTS: u8 = 5;
pub const SKR_KIND_SEASON: u8 = 6;
pub const SKR_KIND_EVENTS: u8 = 7;
/// SKR (Seeker) is a classic SPL token with 6 decimals; devnet test mints must match.
pub const SKR_DECIMALS: u8 = 6;
/// Per-root ceiling used when `init_skr_pool` is called with 0 (100 000 SKR). Bounds the blast
/// radius of a leaked oracle key to one root per epoch inside the 1 h revoke window.
pub const DEFAULT_MAX_SKR_ROOT_BUDGET: u64 = 100_000 * MICRO;
/// Item roots (backlog #27): kind 8 pays fusion boosters. The leaf amount is a UNIT COUNT (boosters),
/// not micro-tokens; `claim_item_root` CPIs `chip_core::grant_booster` signed by `["rewarder"]` — the
/// PDA chip_core already trusts (`GameConfig.staking_program`). Nothing is minted and no slice / pool
/// is debited: the only budget is the per-root cap below. Mirrored in packages/economy/src/skrRewards.ts
/// (`REWARD_ROOT_KINDS.itemBoosters`, `ITEM_REWARDS`) and checked by sync-check.
pub const ITEM_ROOT_KIND_BASE: u8 = 8;
pub const ITEM_KIND_BOOSTERS: u8 = 8;
/// Boosters per root (≈ $790 at the $0.79 service price): the blast radius of a leaked quest-oracle
/// key inside the 1 h revoke window. The oracle splits a bigger backlog across epochs.
pub const MAX_ITEM_ROOT_BUDGET: u64 = 1_000;
/// Boosters per leaf — `chip_core::grant_booster` accepts `count ≤ 10`; the oracle carries the rest over.
pub const MAX_ITEM_CLAIM: u64 = 10;

/// Chip voucher roots (backlog #28): kind 9 pays ONE free quest chip per leaf. The leaf amount is the
/// voucher TEMPLATE id (index into `chip_core::economy::VOUCHER_DEFS` — odds + soulbound days), not a
/// count: a wallet with two vouchers owed gets two leaves in two epochs (the oracle carries over).
/// `claim_chip_root` CPIs `chip_core::open_voucher` signed by `["rewarder"]`, which creates a free
/// 1-chip `PendingPack` committed to Switchboard; the regular `open_pack` crank mints it. Mirrored in
/// packages/economy/src/skrRewards.ts (`REWARD_ROOT_KINDS.chipVouchers`, `CHIP_VOUCHER_REWARDS`).
pub const CHIP_ROOT_KIND_BASE: u8 = 9;
pub const CHIP_KIND_VOUCHERS: u8 = 9;
/// Vouchers per root (`budget` = leaf count): the blast radius of a leaked quest-oracle key inside the
/// 1 h revoke window ≈ 500 chips, most of them Commons (template odds), all soulbound for days.
pub const MAX_CHIP_ROOT_BUDGET: u64 = 500;
/// Highest template id a leaf may carry (`VOUCHER_DEFS.len() − 1`); chip_core re-checks (`InvalidVoucher`).
pub const MAX_CHIP_TEMPLATE: u64 = 3;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
#[repr(u8)]
pub enum Slice {
    ChipStaking = 0,
    TokenStaking = 1,
    Quests = 2,
    PvpSeason = 3,
    Events = 4,
}

/// Sole holder of the $CG mint authority. `["emission"]`.
#[account]
#[derive(InitSpace)]
pub struct EmissionState {
    pub admin: Pubkey,
    pub cg_mint: Pubkey,
    pub chip_core_program: Pubkey,
    pub market_program: Pubkey,
    pub arena_program: Pubkey,
    pub quest_oracle: Pubkey,      // may publish Quests roots
    pub season_oracle: Pubkey,     // may publish PvpSeason/Events roots
    pub set_oracle: Pubkey,        // may sync SetBonus
    pub genesis_ts: i64,           // day 0
    pub day_index: u32,            // last closed day
    pub minted_total: u64, // lifetime minted from the schedule (micro; recycled re-mints excluded — see recycled_*)
    pub schedule_minted: [u64; 8], // per-year minted, to enforce yearly caps
    pub burn_ring: [u64; 7], // daily burn totals, 7-day ring
    pub burn_today: u64,
    pub split_bps: [u16; SPLIT_COUNT],
    pub split_changed_at: i64,
    /// unminted budget accumulated per slice (micro). Quests/PvP/Events roots draw from these.
    pub slice_budget: [u64; SPLIT_COUNT],
    pub paused: bool,
    pub bump: u8,
    /// SEC-H2 hot pauser (may only call `pause`); `Pubkey::default()` = none. Appended last.
    pub pauser: Pubkey,
    /// SEC-M1 burn oracle: the indexer's keeper key that may call `report_burn` with the $CG
    /// burned by chip_core / market / arena (which only emit events, no CPI in v1).
    /// `Pubkey::default()` = none. Appended after `pauser`.
    pub burn_oracle: Pubkey,
    /// SEC-L5: lifetime $CG burned out of the season pool by `fund_slice` (the arena's 20 % wager
    /// rake, recycled into `slice_budget[PvpSeason]`). Re-minted by kind-3 `claim_root` OUTSIDE the
    /// schedule — see `mint_to_user_from`: invariant `recycled_minted ≤ recycled_total`, so net supply
    /// never grows by it.
    pub recycled_total: u64,
    pub recycled_minted: u64,
}

impl EmissionState {
    pub fn year_index(&self, now: i64) -> usize {
        (((now - self.genesis_ts) / DAY) / YEAR_DAYS).clamp(0, 7) as usize
    }
    pub fn yearly_cap_micro(year: usize) -> u64 {
        (PLAY_BUCKET_MICRO as u128 * YEARLY_PCT[year.min(7)] as u128 / 100) as u64
    }
    pub fn daily_schedule_cap(year: usize) -> u64 {
        Self::yearly_cap_micro(year) / YEAR_DAYS as u64
    }
    pub fn trailing_burn_avg(&self) -> u64 {
        let s: u128 = self.burn_ring.iter().map(|&b| b as u128).sum();
        (s / 7) as u64
    }
    /// min(cap, 0.02·cap + 1.25·burn7d)
    pub fn guarded_daily(&self, year: usize) -> u64 {
        let cap = Self::daily_schedule_cap(year) as u128;
        let g = cap * GUARD_FLOOR_BPS as u128 / 10_000
            + self.trailing_burn_avg() as u128 * GUARD_BURN_MULT_BPS as u128 / 10_000;
        g.min(cap) as u64
    }
}

/// MasterChef pool. `["token_pool"]` and `["chip_pool"]`.
#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub kind: u8, // 0 token, 1 chip
    pub total_weight: u128,
    pub acc_reward_per_weight: u128, // scaled 1e12
    pub budget_per_sec: u64,         // micro/sec, set at tick_day
    pub budget_remaining: u64,       // micro left to distribute today
    pub last_update: i64,
    pub bump: u8,
}

impl Pool {
    /// Accrue rewards since last_update into the accumulator (bounded by today's remaining budget).
    pub fn update(&mut self, now: i64) -> Result<()> {
        if now <= self.last_update {
            return Ok(());
        }
        let dt = (now - self.last_update) as u64;
        self.last_update = now;
        if self.total_weight == 0 {
            return Ok(());
        }
        let reward = (self.budget_per_sec as u128 * dt as u128).min(self.budget_remaining as u128);
        self.budget_remaining -= reward as u64;
        let inc = (reward * ACC_PRECISION)
            .checked_div(self.total_weight)
            .ok_or(crate::errors::StakeError::Overflow)?;
        self.acc_reward_per_weight = self
            .acc_reward_per_weight
            .checked_add(inc)
            .ok_or(crate::errors::StakeError::Overflow)?;
        Ok(())
    }
    pub fn pending(&self, weight: u128, debt: u128) -> Result<u64> {
        let accrued = weight
            .checked_mul(self.acc_reward_per_weight)
            .ok_or(crate::errors::StakeError::Overflow)?
            / ACC_PRECISION;
        let pending = accrued.saturating_sub(debt);
        u64::try_from(pending).map_err(|_| error!(crate::errors::StakeError::Overflow))
    }
}

/// `["tstake", wallet, tier]`
#[account]
#[derive(InitSpace)]
pub struct TokenStake {
    pub owner: Pubkey,
    pub tier: u8,
    pub amount: u64,
    pub weight: u128,
    pub reward_debt: u128,
    pub unlock_at: i64,
    pub bump: u8,
}

/// `["cstake", asset]` — one per staked chip
#[account]
#[derive(InitSpace)]
pub struct ChipStake {
    pub owner: Pubkey,
    pub asset: Pubkey,
    pub weight: u128,
    pub reward_debt: u128,
    pub staked_at: i64,
    pub bump: u8,
}

/// `["compressed_cstake", claim]` — one per staked Bubblegum V2 claim
#[account]
#[derive(InitSpace)]
pub struct CompressedChipStake {
    pub owner: Pubkey,
    pub claim: Pubkey,
    pub weight: u128,
    pub reward_debt: u128,
    pub staked_at: i64,
    pub bump: u8,
}

/// `["wday", wallet]` — rolling UTC-day claim counters (token + chip).
#[account]
#[derive(InitSpace)]
pub struct WalletStakeDay {
    pub owner: Pubkey,
    pub day: u32,
    pub token_claimed: u64,
    pub chip_claimed: u64,
    pub bump: u8,
}

/// `["chipplay", claim_or_asset]` — last Cap Slam that used this chip (oracle-attested).
#[account]
#[derive(InitSpace)]
pub struct ChipPlay {
    pub chip: Pubkey,
    pub last_played: i64,
    pub bump: u8,
}

pub fn alive_mult_bps(last_played: i64, now: i64) -> u64 {
    if last_played > 0 && now.saturating_sub(last_played) <= ALIVE_WINDOW_SECS {
        10_000
    } else {
        IDLE_WEIGHT_BPS
    }
}

/// Mint at most the remaining daily quota. Excess is never minted (stays out of supply).
pub fn take_daily_cap(
    acc: &mut WalletStakeDay,
    owner: Pubkey,
    now: i64,
    kind: u8,
    pending: u64,
    bump: u8,
) -> Result<u64> {
    let today = (now / DAY) as u32;
    if acc.owner == Pubkey::default() {
        acc.owner = owner;
        acc.bump = bump;
        acc.day = today;
    }
    require_keys_eq!(acc.owner, owner, crate::errors::StakeError::NotOwner);
    if acc.day != today {
        acc.day = today;
        acc.token_claimed = 0;
        acc.chip_claimed = 0;
    }
    let (used, cap) = if kind == 0 {
        (&mut acc.token_claimed, TOKEN_STAKE_DAILY_CAP_MICRO)
    } else {
        (&mut acc.chip_claimed, CHIP_STAKE_DAILY_CAP_MICRO)
    };
    let room = cap.saturating_sub(*used);
    let pay = pending.min(room);
    *used = used
        .checked_add(pay)
        .ok_or(crate::errors::StakeError::Overflow)?;
    Ok(pay)
}

/// `["setbonus", wallet]` — completed sets proven by the set-oracle (indexer)
#[account]
#[derive(InitSpace)]
pub struct SetBonus {
    pub owner: Pubkey,
    pub completed_sets: u8,
    pub updated_at: i64,
    pub bump: u8,
}

impl SetBonus {
    /// 1 + 0.12·min(sets,5) + 0.02·max(0,sets−5), cap 1.70 → bps
    pub fn mult_bps(sets: u8) -> u64 {
        let s = sets as u64;
        let m = 10_000 + 1_200 * s.min(5) + 200 * s.saturating_sub(5);
        m.min(SET_BONUS_CAP_BPS)
    }
}

/// `["root", kind, epoch]` — Merkle root of off-chain computed payouts.
#[account]
#[derive(InitSpace)]
pub struct RewardRoot {
    pub kind: u8, // 2 quests / 3 pvp / 4 events ($CG slices) · 5..7 SKR pool · 8 boosters (items)
    pub epoch: u32,
    pub root: [u8; 32],
    pub budget: u64, // micro; ≤ slice_budget at publish
    pub claimed: u64,
    pub published_at: i64,
    pub publisher: Pubkey,
    pub revoked: bool,
    pub bump: u8,
}

/// `["claim", root, wallet]`
#[account]
#[derive(InitSpace)]
pub struct ClaimReceipt {
    pub amount: u64,
    pub bump: u8,
}

/// `["skr_pool"]` — treasury-funded SKR prize pool (the game cannot mint SKR).
/// Invariant: `vault.amount ≥ budget + reserved` — funding only credits `budget`,
/// roots move `budget → reserved` at publish, claims only draw from `reserved`.
#[account]
#[derive(InitSpace)]
pub struct SkrPool {
    pub skr_mint: Pubkey,
    pub vault: Pubkey, // token account, authority = this PDA
    pub budget: u64,   // micro-SKR available for new roots
    pub reserved: u64, // micro-SKR locked in live roots, not yet claimed
    pub funded_total: u64,
    pub paid_total: u64,
    pub max_root_budget: u64, // per-root ceiling (admin-tunable)
    pub paused: bool,
    pub bump: u8,
    /// Slot of the last `withdraw_skr`. Two instructions in one transaction share a slot, so this
    /// is what turns the 10 % per-call cap into ≥ 10 separate transactions rather than 10
    /// instructions packed into one.
    pub last_withdraw_slot: u64,
    /// Unix timestamp of the current withdraw-day window (`DAY` seconds).
    pub withdraw_day_start: i64,
    /// Micro-SKR withdrawn since `withdraw_day_start`; capped at 10 % of the day's opening budget.
    pub withdrawn_today: u64,
}

impl SkrPool {
    pub fn is_skr_kind(kind: u8) -> bool {
        (SKR_ROOT_KIND_BASE..SKR_ROOT_KIND_BASE + 3).contains(&kind)
    }
    /// Some(true) → season oracle, Some(false) → quest oracle, None → not an SKR kind.
    pub fn uses_season_oracle(kind: u8) -> Option<bool> {
        match kind {
            SKR_KIND_QUESTS => Some(false),
            SKR_KIND_SEASON | SKR_KIND_EVENTS => Some(true),
            _ => None,
        }
    }
}

#[event]
pub struct DayClosed {
    pub day_index: u32,
    pub year: u8,
    pub schedule_cap: u64,
    pub guarded: u64,
    pub burn_7d_avg: u64,
    pub slice_budget: [u64; SPLIT_COUNT],
}
#[event]
pub struct Staked {
    pub owner: Pubkey,
    pub kind: u8,
    pub key: Pubkey,
    pub amount: u64,
    pub weight: u128,
    pub unlock_at: i64,
}
#[event]
pub struct Unstaked {
    pub owner: Pubkey,
    pub kind: u8,
    pub key: Pubkey,
    pub amount: u64,
    pub penalty_burned: u64,
}
#[event]
pub struct Claimed {
    pub owner: Pubkey,
    pub kind: u8,
    pub amount: u64,
}
#[event]
pub struct RootPublished {
    pub kind: u8,
    pub epoch: u32,
    pub root: [u8; 32],
    pub budget: u64,
}
#[event]
pub struct RootRevoked {
    pub kind: u8,
    pub epoch: u32,
}
#[event]
pub struct RootClaimed {
    pub kind: u8,
    pub epoch: u32,
    pub wallet: Pubkey,
    pub amount: u64,
}
#[event]
pub struct BurnRecorded {
    pub source: Pubkey,
    pub amount: u64,
    pub burn_today: u64,
}
#[event]
pub struct SetBonusSynced {
    pub owner: Pubkey,
    pub sets: u8,
}
/// `funder = Pubkey::default()` when a direct vault transfer was absorbed by `sync_skr_pool`.
#[event]
pub struct SkrFunded {
    pub funder: Pubkey,
    pub amount: u64,
    pub budget: u64,
    pub reserved: u64,
}
#[event]
pub struct SkrWithdrawn {
    pub to: Pubkey,
    pub amount: u64,
    pub budget: u64,
}
#[event]
pub struct SkrPoolChanged {
    pub max_root_budget: u64,
    pub paused: bool,
}
#[event]
pub struct PauseChanged {
    pub by: Pubkey,
    pub paused: bool,
}
/// SEC-G05 governance audit trail (see chip_core `PauserChanged`): `set_pauser`.
#[event]
pub struct PauserChanged {
    pub by: Pubkey,
    pub pauser: Pubkey,
}
#[event]
pub struct ClaimCapped {
    pub owner: Pubkey,
    pub kind: u8,
    pub pending: u64,
    pub paid: u64,
}
#[event]
pub struct PlayPulsed {
    pub key: Pubkey,
    pub last_played: i64,
}
/// `set_oracles`: the resulting oracle set. These keys publish reward roots and burn reports, so a
/// rotation is money-relevant and must be visible off-chain the moment it lands.
#[event]
pub struct OraclesChanged {
    pub by: Pubkey,
    pub quest_oracle: Pubkey,
    pub season_oracle: Pubkey,
    pub set_oracle: Pubkey,
    pub burn_oracle: Pubkey,
}
/// SEC-L5: `fund_slice` burned `amount` $CG out of the season pool (ATA of `["season_pool"]`, fed by the arena's 20 % wager rake) into `slice_budget[kind]`.
#[event]
pub struct SliceFunded {
    pub by: Pubkey,
    pub kind: u8,
    pub amount: u64,
    pub slice_budget: [u64; SPLIT_COUNT],
    pub recycled_total: u64,
}

#[cfg(test)]
mod penalty_tests {
    use super::*;

    #[test]
    fn early_exit_penalty_rounds_up_and_never_exceeds_principal() {
        // round amounts are unchanged vs the old floor formula
        assert_eq!(early_exit_penalty(1_000_000, 1_000), 100_000);
        assert_eq!(early_exit_penalty(500 * MICRO, 1_000), 50 * MICRO);
        // SEC-F3: dust chunks can no longer dodge the burn
        for bps in [500u64, 1_000, 1_500] {
            for amount in 1u64..=100 {
                let p = early_exit_penalty(amount, bps);
                assert!(p >= 1, "amount {amount} bps {bps} paid no penalty");
                assert!(p <= amount);
                assert!(p * 10_000 >= amount * bps && (p - 1) * 10_000 < amount * bps);
            }
        }
        // chunking never pays less in total than a single exit
        let whole = early_exit_penalty(1_000, 500);
        let chunked: u64 = (0..100).map(|_| early_exit_penalty(10, 500)).sum();
        assert!(chunked >= whole);
        // flex tier and zero amount → nothing; no overflow at u64::MAX; bps clamped
        assert_eq!(early_exit_penalty(12_345, 0), 0);
        assert_eq!(early_exit_penalty(0, 1_500), 0);
        let max = (u64::MAX as u128 * 1_500).div_ceil(10_000) as u64;
        assert_eq!(early_exit_penalty(u64::MAX, 1_500), max);
        assert_eq!(early_exit_penalty(777, 20_000), 777);
    }
}
