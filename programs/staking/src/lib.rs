//! GUTTERCAPS — staking + emission
//!
//! Holds the $CG mint authority (EmissionState PDA). Two MasterChef pools
//! (token / chip) plus Merkle reward roots for quests, PvP seasons and
//! events. Daily budget = min(schedule, 0.30·schedule + 1.25·burn7d).
//!
//! Second reward currency: SKR (Seeker). The game cannot mint SKR, so SKR
//! rewards are paid from a treasury-funded prize pool (`SkrPool`) through
//! Merkle roots of kinds 5..7 — see `instructions/skr.rs`.

#![allow(clippy::result_large_err)]

use anchor_lang::prelude::*;
use chip_core::bubblegum::LeafProofArgs;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;
use state::SPLIT_COUNT;

declare_id!("GCuGx7fnLcKnw1NWU4dLzQvnJWggMVniQ4u7EuMaQevA");

#[program]
pub mod staking {
    use super::*;

    pub fn init_emission(ctx: Context<InitEmission>, args: InitEmissionArgs) -> Result<()> {
        instructions::init_emission(ctx, args)
    }
    pub fn set_split(ctx: Context<EmissionAdmin>, split_bps: [u16; SPLIT_COUNT]) -> Result<()> {
        instructions::set_split(ctx, split_bps)
    }
    pub fn set_paused(ctx: Context<EmissionAdmin>, paused: bool) -> Result<()> {
        instructions::set_paused(ctx, paused)
    }
    pub fn set_pauser(ctx: Context<EmissionAdmin>, pauser: Pubkey) -> Result<()> {
        instructions::set_pauser(ctx, pauser)
    }
    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        instructions::pause(ctx)
    }
    pub fn set_oracles(ctx: Context<EmissionAdmin>, patch: OraclePatch) -> Result<()> {
        instructions::set_oracles(ctx, patch)
    }
    pub fn tick_day(ctx: Context<TickDay>) -> Result<()> {
        instructions::tick_day(ctx)
    }
    pub fn report_burn(ctx: Context<ReportBurn>, amount: u64) -> Result<()> {
        instructions::report_burn(ctx, amount)
    }
    /// SEC-L5: season oracle / admin recycles the arena's 20 % wager rake (season pool ATA) into the PvpSeason slice.
    pub fn fund_slice(ctx: Context<FundSlice>, kind: u8, amount: u64) -> Result<()> {
        instructions::fund_slice(ctx, kind, amount)
    }

    pub fn publish_root(
        ctx: Context<PublishRoot>,
        kind: u8,
        epoch: u32,
        root: [u8; 32],
        budget: u64,
    ) -> Result<()> {
        instructions::publish_root(ctx, kind, epoch, root, budget)
    }
    pub fn revoke_root(ctx: Context<RevokeRoot>) -> Result<()> {
        instructions::revoke_root(ctx)
    }
    pub fn claim_root(ctx: Context<ClaimRoot>, amount: u64, proof: Vec<[u8; 32]>) -> Result<()> {
        instructions::claim_root(ctx, amount, proof)
    }

    // --- SKR prize pool (reward currency #2; kinds 5..7) ---
    pub fn init_skr_pool(ctx: Context<InitSkrPool>, max_root_budget: u64) -> Result<()> {
        instructions::init_skr_pool(ctx, max_root_budget)
    }
    pub fn fund_skr(ctx: Context<FundSkr>, amount: u64) -> Result<()> {
        instructions::fund_skr(ctx, amount)
    }
    pub fn sync_skr_pool(ctx: Context<SyncSkrPool>) -> Result<()> {
        instructions::sync_skr_pool(ctx)
    }
    pub fn withdraw_skr(ctx: Context<WithdrawSkr>, amount: u64) -> Result<()> {
        instructions::withdraw_skr(ctx, amount)
    }
    pub fn set_skr_pool(
        ctx: Context<SkrPoolAdmin>,
        max_root_budget: Option<u64>,
        paused: Option<bool>,
    ) -> Result<()> {
        instructions::set_skr_pool(ctx, max_root_budget, paused)
    }
    pub fn publish_skr_root(
        ctx: Context<PublishSkrRoot>,
        kind: u8,
        epoch: u32,
        root: [u8; 32],
        budget: u64,
    ) -> Result<()> {
        instructions::publish_skr_root(ctx, kind, epoch, root, budget)
    }
    pub fn revoke_skr_root(ctx: Context<RevokeSkrRoot>) -> Result<()> {
        instructions::revoke_skr_root(ctx)
    }
    pub fn claim_skr_root(
        ctx: Context<ClaimSkrRoot>,
        amount: u64,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        instructions::claim_skr_root(ctx, amount, proof)
    }

    // --- item roots (backlog #27; kind 8 = fusion boosters, delivered by CPI into chip_core::PlayerItems) ---
    pub fn publish_item_root(
        ctx: Context<PublishItemRoot>,
        kind: u8,
        epoch: u32,
        root: [u8; 32],
        budget: u64,
    ) -> Result<()> {
        instructions::publish_item_root(ctx, kind, epoch, root, budget)
    }
    pub fn revoke_item_root(ctx: Context<RevokeItemRoot>) -> Result<()> {
        instructions::revoke_item_root(ctx)
    }
    pub fn claim_item_root(
        ctx: Context<ClaimItemRoot>,
        amount: u64,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        instructions::claim_item_root(ctx, amount, proof)
    }

    // --- chip voucher roots (backlog #28; kind 9 = one free quest chip per leaf, minted through chip_core's VRF pack flow) ---
    pub fn publish_chip_root(
        ctx: Context<PublishChipRoot>,
        kind: u8,
        epoch: u32,
        root: [u8; 32],
        budget: u64,
    ) -> Result<()> {
        instructions::publish_chip_root(ctx, kind, epoch, root, budget)
    }
    pub fn revoke_chip_root(ctx: Context<RevokeChipRoot>) -> Result<()> {
        instructions::revoke_chip_root(ctx)
    }
    /// `amount` = voucher template id; `nonce` = the wallet's fresh pack nonce (same tx as chip_core `init_randomness(0, nonce)`).
    pub fn claim_chip_root(
        ctx: Context<ClaimChipRoot>,
        amount: u64,
        proof: Vec<[u8; 32]>,
        nonce: u64,
    ) -> Result<()> {
        instructions::claim_chip_root(ctx, amount, proof, nonce)
    }

    pub fn stake_cg(ctx: Context<StakeCg>, tier: u8, amount: u64) -> Result<()> {
        instructions::stake_cg(ctx, tier, amount)
    }
    pub fn unstake_cg(ctx: Context<UnstakeCg>, tier: u8, amount: u64) -> Result<()> {
        instructions::unstake_cg(ctx, tier, amount)
    }
    pub fn stake_compressed_chip(ctx: Context<StakeCompressedChip>) -> Result<()> {
        instructions::stake_compressed_chip(ctx)
    }
    pub fn stake_compressed_chip_v2<'info>(
        ctx: Context<'_, '_, 'info, 'info, StakeCompressedChipV2<'info>>,
        delegate: Pubkey,
        proof: LeafProofArgs,
    ) -> Result<()> {
        instructions::stake_compressed_chip_v2(ctx, delegate, proof)
    }
    pub fn unstake_compressed_chip(ctx: Context<UnstakeCompressedChip>) -> Result<()> {
        instructions::unstake_compressed_chip(ctx)
    }
    pub fn claim_chip(ctx: Context<ClaimChip>) -> Result<()> {
        instructions::claim_chip(ctx)
    }
    pub fn sync_set_bonus(ctx: Context<SyncSetBonus>, sets: u8) -> Result<()> {
        instructions::sync_set_bonus(ctx, sets)
    }
}

#[cfg(test)]
mod tests {
    use super::state::*;

    #[test]
    fn schedule_matches_ts_model() {
        // Y1 daily cap = 1e9 × 0.55 × 0.18 / 365 = 271 232.87 $CG
        assert_eq!(EmissionState::daily_schedule_cap(0) / MICRO, 271_232);
        assert_eq!(EmissionState::daily_schedule_cap(1) / MICRO, 226_027);
        assert_eq!(EmissionState::daily_schedule_cap(4) / MICRO, 120_547);
        let total: u128 = (0..8)
            .map(|y| EmissionState::yearly_cap_micro(y) as u128)
            .sum();
        assert_eq!(total, PLAY_BUCKET_MICRO as u128 * 78 / 100);
    }

    #[test]
    fn guard_floor_and_ceiling() {
        let mut e = EmissionState {
            admin: Default::default(),
            cg_mint: Default::default(),
            chip_core_program: Default::default(),
            market_program: Default::default(),
            arena_program: Default::default(),
            quest_oracle: Default::default(),
            season_oracle: Default::default(),
            set_oracle: Default::default(),
            genesis_ts: 0,
            day_index: 0,
            minted_total: 0,
            schedule_minted: [0; 8],
            burn_ring: [0; 7],
            burn_today: 0,
            split_bps: [2000, 1000, 2200, 3300, 1500],
            split_changed_at: 0,
            slice_budget: [0; 5],
            paused: false,
            bump: 0,
            pauser: Default::default(),
            burn_oracle: Default::default(),
            recycled_total: 0,
            recycled_minted: 0,
        };
        let cap = EmissionState::daily_schedule_cap(0);
        assert_eq!(e.guarded_daily(0), cap / 10);
        e.burn_ring = [cap; 7];
        assert_eq!(e.guarded_daily(0), cap);
        e.burn_ring = [117_433 * MICRO; 7]; // baseline burn from the TS report
        assert_eq!(e.guarded_daily(0) / MICRO, 173_914); // 10 % floor + 1.25 × burn
    }

    #[test]
    fn set_bonus_curve() {
        assert_eq!(SetBonus::mult_bps(0), 10_000);
        assert_eq!(SetBonus::mult_bps(1), 11_200);
        assert_eq!(SetBonus::mult_bps(5), 16_000);
        assert_eq!(SetBonus::mult_bps(10), 17_000);
        assert_eq!(SetBonus::mult_bps(40), 17_000);
    }

    #[test]
    fn pool_accrual_is_budget_bounded() {
        let mut p = Pool {
            kind: 0,
            total_weight: 1_000,
            acc_reward_per_weight: 0,
            budget_per_sec: 10,
            budget_remaining: 100,
            last_update: 0,
            bump: 0,
        };
        p.update(5).unwrap();
        assert_eq!(p.budget_remaining, 50);
        p.update(1_000).unwrap();
        assert_eq!(p.budget_remaining, 0);
        assert_eq!(p.pending(1_000, 0).unwrap(), 100);
    }

    #[test]
    fn merkle_golden_vector() {
        // Same vector as client/src/chain/chain.test.ts ("reward Merkle tree") — pins the leaf / node
        // byte layout shared by claim_root and claim_skr_root.
        use super::instructions::emission::verify_proof;
        use anchor_lang::solana_program::keccak::hashv;
        let leaf = |w: u8, amount: u64, kind: u8, epoch: u32| -> [u8; 32] {
            hashv(&[
                &[0u8],
                &[w; 32],
                &amount.to_le_bytes(),
                &[kind],
                &epoch.to_le_bytes(),
            ])
            .to_bytes()
        };
        let hex = |b: &[u8; 32]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
        let (l0, l1, l2) = (
            leaf(1, 1_500_000, 2, 7),
            leaf(2, 12_500_000, 5, 7),
            leaf(3, 1, 6, 1),
        );
        assert_eq!(
            hex(&l0),
            "3d0d922cddaa7e75b60963bd999a604e5c858d5996620351b1857bc242a0259f"
        );
        assert_eq!(
            hex(&l1),
            "3a27eed74dbc6ba29f5ed01add35e3e8f65abd55b131524fc1d62bab72c3f390"
        );
        assert_eq!(
            hex(&l2),
            "336bae46ed31ed8c92d7c24cf5b9a5198429de1836830e92e3229a2e89a636b6"
        );
        let pair = |a: &[u8; 32], b: &[u8; 32]| -> [u8; 32] {
            if a <= b {
                hashv(&[&[1u8], a, b]).to_bytes()
            } else {
                hashv(&[&[1u8], b, a]).to_bytes()
            }
        };
        let p01 = pair(&l0, &l1);
        assert_eq!(
            hex(&p01),
            "7f8ee1caec715d020b43c5887cbaa71c543171c2dec8317b73866d4bb1326fb9"
        );
        let root = pair(&p01, &l2);
        assert_eq!(
            hex(&root),
            "08a5f93435e89ae1fb9ea8821bf61eb469008c475d327b0a0114dd1e980b5027"
        );
        assert!(verify_proof(&root, l0, &[l1, l2]));
        assert!(verify_proof(&root, l1, &[l0, l2]));
        assert!(verify_proof(&root, l2, &[p01]));
        // wrong kind (cross-currency replay of the same wallet/amount/epoch) must fail
        assert!(!verify_proof(&root, leaf(1, 1_500_000, 5, 7), &[l1, l2]));
        assert!(!verify_proof(&root, l0, &[l2, l1]));
    }

    #[test]
    fn skr_root_kinds_are_disjoint_from_cg_slices() {
        // kinds 0..4 index slice_budget; 5..7 are SKR — the two claim paths must never overlap
        for k in 0..SPLIT_COUNT as u8 {
            assert!(!SkrPool::is_skr_kind(k));
            assert!(SkrPool::uses_season_oracle(k).is_none());
        }
        assert_eq!(SkrPool::uses_season_oracle(SKR_KIND_QUESTS), Some(false));
        assert_eq!(SkrPool::uses_season_oracle(SKR_KIND_SEASON), Some(true));
        assert_eq!(SkrPool::uses_season_oracle(SKR_KIND_EVENTS), Some(true));
        assert!(!SkrPool::is_skr_kind(SKR_KIND_EVENTS + 1));
        assert_eq!(SKR_ROOT_KIND_BASE as usize, SPLIT_COUNT);
        assert_eq!(DEFAULT_MAX_SKR_ROOT_BUDGET / MICRO, 100_000);
    }

    #[test]
    fn merkle_proof_roundtrip() {
        use crate::instructions::verify_proof;
        use anchor_lang::solana_program::keccak::hashv;
        let a = [1u8; 32];
        let b = [2u8; 32];
        let c = [3u8; 32];
        let ab = hashv(&[&[1u8], &a, &b]).to_bytes();
        let cc = hashv(&[&[1u8], &c, &c]).to_bytes();
        let root = if ab <= cc {
            hashv(&[&[1u8], &ab, &cc]).to_bytes()
        } else {
            hashv(&[&[1u8], &cc, &ab]).to_bytes()
        };
        assert!(verify_proof(&root, a, &[b, cc]));
        assert!(!verify_proof(&root, a, &[c, cc]));
    }
}
