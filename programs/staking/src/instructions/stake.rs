//! Token staking (4 lock tiers) and compressed-chip staking (freeze-in-place)
//! on MasterChef pools. Rewards are minted on claim from the pool's accrued
//! budget, so nothing is pre-minted and unclaimed rewards never exist as
//! supply.
//!
//! The chip side stakes a `CompressedMintClaim`: `stake_compressed_chip` (the
//! V1 claim handle) and `stake_compressed_chip_v2` (a registered Bubblegum V2
//! leaf, carrying its own proof). `unstake_compressed_chip` closes the stake
//! and mints the pending reward in the same transaction — there is no separate
//! claim step, so no reward can be left behind.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount};

use chip_core::bubblegum::{
    leaf_asset_id, verify_v2_leaf, LeafProofArgs, MPL_ACCOUNT_COMPRESSION_ID,
};
use chip_core::cpi::accounts::SetCompressedClaimStaked;
use chip_core::economy::level_mult_bps;
use chip_core::program::ChipCore;
use chip_core::state::{ChipState, CompressedChipState, CompressedMintClaim, GameConfig};

use crate::errors::StakeError;
use crate::instructions::emission::{mint_to_user, record_internal_burn};
use crate::state::*;

// ---------------------------------------------------------------------------
// $CG staking
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(tier: u8)]
pub struct StakeCg<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"emission"], bump = emission.bump, constraint = !emission.paused @ StakeError::Paused)]
    pub emission: Box<Account<'info, EmissionState>>,
    #[account(mut, seeds = [b"token_pool"], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    // Note: PDA cannot be closed; Anchor discriminator prevents re-init
    // sentio-ignore-next-line SW016
    #[account(init_if_needed, payer = owner, space = 8 + TokenStake::INIT_SPACE, seeds = [b"tstake", owner.key().as_ref(), &[tier]], bump)]
    pub stake: Box<Account<'info, TokenStake>>,
    #[account(mut, address = emission.cg_mint)]
    pub cg_mint: Account<'info, Mint>,
    #[account(mut, token::mint = emission.cg_mint, token::authority = owner)]
    pub owner_cg: Account<'info, TokenAccount>,
    /// program-owned vault ATA (authority = emission PDA)
    #[account(mut, token::mint = emission.cg_mint, token::authority = emission)]
    pub vault_cg: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn stake_cg(ctx: Context<StakeCg>, tier: u8, amount: u64) -> Result<()> {
    require!((tier as usize) < TIER_COUNT, StakeError::InvalidTier);
    require!(amount >= MIN_STAKE_MICRO, StakeError::BelowMinimum);
    let now = Clock::get()?.unix_timestamp;
    let pool = &mut ctx.accounts.pool;
    pool.update(now)?;

    let s = &mut ctx.accounts.stake;
    // harvest pending first (so weight change doesn't retro-apply)
    if s.weight > 0 {
        let pending = pool.pending(s.weight, s.reward_debt)?;
        if pending > 0 {
            mint_to_user(
                &mut ctx.accounts.emission,
                &ctx.accounts.cg_mint.to_account_info(),
                &ctx.accounts.owner_cg.to_account_info(),
                &ctx.accounts.token_program.to_account_info(),
                pending,
                now,
            )?;
            emit!(Claimed {
                owner: ctx.accounts.owner.key(),
                kind: 0,
                amount: pending
            });
        }
    } else {
        s.owner = ctx.accounts.owner.key();
        s.tier = tier;
        s.bump = ctx.bumps.stake;
    }
    require_keys_eq!(s.owner, ctx.accounts.owner.key(), StakeError::NotOwner);
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token::Transfer {
                from: ctx.accounts.owner_cg.to_account_info(),
                to: ctx.accounts.vault_cg.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
    )?;

    s.amount = s.amount.checked_add(amount).ok_or(StakeError::Overflow)?;
    let new_weight = s.amount as u128 * TIER_BOOST_BPS[tier as usize] as u128 / 10_000;
    pool.total_weight = pool
        .total_weight
        .checked_sub(s.weight)
        .and_then(|w| w.checked_add(new_weight))
        .ok_or(StakeError::Overflow)?;
    s.weight = new_weight;
    s.reward_debt = (new_weight * pool.acc_reward_per_weight) / ACC_PRECISION;
    // adding to a locked position re-locks the whole position (prevents "top-up to dodge lock")
    s.unlock_at = now + TIER_LOCK_SECS[tier as usize];
    emit!(Staked {
        owner: s.owner,
        kind: 0,
        key: s.key(),
        amount,
        weight: new_weight,
        unlock_at: s.unlock_at
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(tier: u8)]
pub struct UnstakeCg<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"emission"], bump = emission.bump)]
    pub emission: Box<Account<'info, EmissionState>>,
    #[account(mut, seeds = [b"token_pool"], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [b"tstake", owner.key().as_ref(), &[tier]], bump = stake.bump, has_one = owner)]
    pub stake: Box<Account<'info, TokenStake>>,
    #[account(mut, address = emission.cg_mint)]
    pub cg_mint: Account<'info, Mint>,
    #[account(mut, token::mint = emission.cg_mint, token::authority = owner)]
    pub owner_cg: Account<'info, TokenAccount>,
    #[account(mut, token::mint = emission.cg_mint, token::authority = emission)]
    pub vault_cg: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// `amount` = 0 → claim only. Early exit burns the tier penalty from principal.
pub fn unstake_cg(ctx: Context<UnstakeCg>, tier: u8, amount: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let pool = &mut ctx.accounts.pool;
    pool.update(now)?;
    let s = &mut ctx.accounts.stake;
    let pending = pool.pending(s.weight, s.reward_debt)?;
    if pending > 0 {
        mint_to_user(
            &mut ctx.accounts.emission,
            &ctx.accounts.cg_mint.to_account_info(),
            &ctx.accounts.owner_cg.to_account_info(),
            &ctx.accounts.token_program.to_account_info(),
            pending,
            now,
        )?;
        emit!(Claimed {
            owner: s.owner,
            kind: 0,
            amount: pending
        });
    }
    let mut penalty = 0u64;
    if amount > 0 {
        require!(amount <= s.amount, StakeError::Overflow);
        if now < s.unlock_at {
            penalty = early_exit_penalty(amount, TIER_PENALTY_BPS[tier as usize]);
        }
        let seeds: &[&[u8]] = &[b"emission", &[ctx.accounts.emission.bump]];
        if penalty > 0 {
            token::burn(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    token::Burn {
                        mint: ctx.accounts.cg_mint.to_account_info(),
                        from: ctx.accounts.vault_cg.to_account_info(),
                        authority: ctx.accounts.emission.to_account_info(),
                    },
                    &[seeds],
                ),
                penalty,
            )?;
            record_internal_burn(&mut ctx.accounts.emission, penalty);
        }
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.vault_cg.to_account_info(),
                    to: ctx.accounts.owner_cg.to_account_info(),
                    authority: ctx.accounts.emission.to_account_info(),
                },
                &[seeds],
            ),
            amount - penalty,
        )?;
        s.amount = s.amount.checked_sub(amount).ok_or(StakeError::Overflow)?;
    }
    let new_weight = s.amount as u128 * TIER_BOOST_BPS[tier as usize] as u128 / 10_000;
    pool.total_weight = pool
        .total_weight
        .checked_sub(s.weight)
        .and_then(|w| w.checked_add(new_weight))
        .ok_or(StakeError::Overflow)?;
    s.weight = new_weight;
    s.reward_debt = (new_weight * pool.acc_reward_per_weight) / ACC_PRECISION;
    emit!(Unstaked {
        owner: s.owner,
        kind: 0,
        key: s.key(),
        amount,
        penalty_burned: penalty
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Compressed-chip staking
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct StakeCompressedChip<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"emission"], bump = emission.bump, constraint = !emission.paused @ StakeError::Paused)]
    pub emission: Box<Account<'info, EmissionState>>,
    #[account(mut, seeds = [b"chip_pool"], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(init, payer = owner, space = 8 + CompressedChipStake::INIT_SPACE, seeds = [b"compressed_cstake", claim.key().as_ref()], bump)]
    pub cstake: Box<Account<'info, CompressedChipStake>>,
    // Note: PDA cannot be closed; Anchor discriminator prevents re-init
    // sentio-ignore-next-line SW016
    #[account(init_if_needed, payer = owner, space = 8 + SetBonus::INIT_SPACE, seeds = [b"setbonus", owner.key().as_ref()], bump)]
    pub set_bonus: Box<Account<'info, SetBonus>>,
    // sentio-ignore-next-line SW013
    /// CHECK: ["stake_auth"] PDA signer for chip_core CPI
    #[account(seeds = [b"stake_auth"], bump)]
    pub stake_auth: UncheckedAccount<'info>,
    #[account(mut)]
    pub claim: Account<'info, CompressedMintClaim>,
    pub chip_core: Program<'info, ChipCore>,
    pub system_program: Program<'info, System>,
}

fn compressed_chip_weight(claim: &CompressedMintClaim, sets: u8) -> u128 {
    claim.rarity.stake_weight() as u128 * MICRO as u128 * level_mult_bps(claim.level) as u128
        / 10_000
        * SetBonus::mult_bps(sets) as u128
        / 10_000
}

pub fn stake_compressed_chip(ctx: Context<StakeCompressedChip>) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.claim.buyer,
        ctx.accounts.owner.key(),
        StakeError::NotOwner
    );
    require!(
        !ctx.accounts.claim.listed && !ctx.accounts.claim.consumed && !ctx.accounts.claim.staked,
        StakeError::ChipNotFree
    );
    let now = Clock::get()?.unix_timestamp;
    // SEC-F04: never stake a dead claim. An unminted claim past its 7-day deadline can never be
    // minted/registered — it is only cancellable — so its weight is a claim on the pool backed
    // by nothing. Minted claims stay stakeable after the deadline exactly like
    // register_compressed_chip (DAS retries keep them alive).
    require!(
        now <= ctx.accounts.claim.expires_at || ctx.accounts.claim.minted,
        StakeError::ClaimExpired
    );
    let sb = &mut ctx.accounts.set_bonus;
    if sb.owner == Pubkey::default() {
        sb.owner = ctx.accounts.owner.key();
        sb.bump = ctx.bumps.set_bonus;
    }
    require_keys_eq!(sb.owner, ctx.accounts.owner.key(), StakeError::NotOwner);
    let seeds: &[&[u8]] = &[b"stake_auth", &[ctx.bumps.stake_auth]];
    chip_core::cpi::set_compressed_claim_staked(
        CpiContext::new_with_signer(
            ctx.accounts.chip_core.to_account_info(),
            SetCompressedClaimStaked {
                caller: ctx.accounts.stake_auth.to_account_info(),
                claim: ctx.accounts.claim.to_account_info(),
            },
            &[seeds],
        ),
        ctx.accounts.owner.key(),
        true,
    )?;
    let pool = &mut ctx.accounts.pool;
    pool.update(now)?;
    let weight = compressed_chip_weight(&ctx.accounts.claim, sb.completed_sets);
    let c = &mut ctx.accounts.cstake;
    c.owner = ctx.accounts.owner.key();
    c.claim = ctx.accounts.claim.key();
    c.weight = weight;
    c.reward_debt = (weight * pool.acc_reward_per_weight) / ACC_PRECISION;
    c.staked_at = now;
    c.bump = ctx.bumps.cstake;
    pool.total_weight = pool
        .total_weight
        .checked_add(weight)
        .ok_or(StakeError::Overflow)?;
    emit!(Staked {
        owner: c.owner,
        kind: 1,
        key: c.claim,
        amount: 1,
        weight,
        unlock_at: 0
    });
    Ok(())
}

/// Proof-backed Bubblegum V2 staking entry point. The legacy claim-only
/// instruction remains for pre-mint economic fixtures, while production cNFT
/// staking must use this path: the projection and the live Account
/// Compression root are checked before any reward weight is created.
#[rustfmt::skip]
#[derive(Accounts)]
#[instruction(delegate: Pubkey)]
pub struct StakeCompressedChipV2<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"emission"], bump = emission.bump, constraint = !emission.paused @ StakeError::Paused)]
    pub emission: Box<Account<'info, EmissionState>>,
    #[account(mut, seeds = [b"chip_pool"], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(init, payer = owner, space = 8 + CompressedChipStake::INIT_SPACE, seeds = [b"compressed_cstake", claim.key().as_ref()], bump)]
    pub cstake: Box<Account<'info, CompressedChipStake>>,
    // Note: PDA cannot be closed; Anchor discriminator prevents re-init
    // sentio-ignore-next-line SW016
    #[account(init_if_needed, payer = owner, space = 8 + SetBonus::INIT_SPACE, seeds = [b"setbonus", owner.key().as_ref()], bump)]
    pub set_bonus: Box<Account<'info, SetBonus>>,
    // sentio-ignore-next-line SW013
    /// CHECK: stake_auth is the fixed PDA used by chip_core for state changes.
    #[account(seeds = [b"stake_auth"], bump)]
    pub stake_auth: UncheckedAccount<'info>,
    #[account(mut)]
    pub claim: Account<'info, CompressedMintClaim>,
    #[account(
        constraint = chip.claim == claim.key() @ StakeError::InvalidBubblegumProof,
        constraint = chip.asset == leaf_asset_id(&chip.merkle_tree, chip.leaf_index) @ StakeError::InvalidBubblegumProof,
    )]
    pub chip: Account<'info, CompressedChipState>,
    /// CHECK: the tree is bound to the registered projection and checked by
    /// Account Compression during the proof CPI.
    #[account(address = chip.merkle_tree)]
    pub merkle_tree: UncheckedAccount<'info>,
    /// CHECK: fixed MPL Account Compression program.
    #[account(address = MPL_ACCOUNT_COMPRESSION_ID)]
    pub compression_program: UncheckedAccount<'info>,
    pub chip_core: Program<'info, ChipCore>,
    pub system_program: Program<'info, System>,
}

#[rustfmt::skip]
// sentio-ignore-fn SW023
pub fn stake_compressed_chip_v2<'info>(
    ctx: Context<'_, '_, 'info, 'info, StakeCompressedChipV2<'info>>,
    delegate: Pubkey,
    proof: LeafProofArgs,
) -> Result<()> {
    let claim = &ctx.accounts.claim;
    let chip = &ctx.accounts.chip;
    require!(
        claim.minted && claim.registered && !claim.listed && !claim.consumed && !claim.staked,
        StakeError::InvalidBubblegumProof
    );
    require_keys_eq!(claim.buyer, ctx.accounts.owner.key(), StakeError::NotOwner);
    proof
        .validate_coordinates(chip.leaf_nonce, chip.leaf_index)
        .map_err(|_| error!(StakeError::InvalidBubblegumProof))?;
    require!(
        proof.data_hash == chip.data_hash
            && proof.creator_hash == chip.creator_hash
            && proof.collection_hash == chip.collection_hash
            && proof.asset_data_hash == chip.asset_data_hash
            && proof.flags == chip.leaf_flags,
        StakeError::InvalidBubblegumProof
    );
    verify_v2_leaf(
        &ctx.accounts.compression_program.to_account_info(),
        &ctx.accounts.merkle_tree.to_account_info(),
        chip.asset,
        ctx.accounts.owner.key(),
        delegate,
        &proof,
        ctx.remaining_accounts,
    )
    .map_err(|_| error!(StakeError::InvalidBubblegumProof))?;

    // Keep the economic transition identical to the claim path, but only after
    // the live V2 leaf has been proven.
    let now = Clock::get()?.unix_timestamp;
    let sb = &mut ctx.accounts.set_bonus;
    if sb.owner == Pubkey::default() {
        sb.owner = ctx.accounts.owner.key();
        sb.bump = ctx.bumps.set_bonus;
    }
    require_keys_eq!(sb.owner, ctx.accounts.owner.key(), StakeError::NotOwner);
    let seeds: &[&[u8]] = &[b"stake_auth", &[ctx.bumps.stake_auth]];
    chip_core::cpi::set_compressed_claim_staked(
        CpiContext::new_with_signer(
            ctx.accounts.chip_core.to_account_info(),
            SetCompressedClaimStaked {
                caller: ctx.accounts.stake_auth.to_account_info(),
                claim: ctx.accounts.claim.to_account_info(),
            },
            &[seeds],
        ),
        ctx.accounts.owner.key(),
        true,
    )?;
    let pool = &mut ctx.accounts.pool;
    pool.update(now)?;
    let weight = compressed_chip_weight(&ctx.accounts.claim, sb.completed_sets);
    let c = &mut ctx.accounts.cstake;
    c.owner = ctx.accounts.owner.key();
    c.claim = ctx.accounts.claim.key();
    c.weight = weight;
    c.reward_debt = (weight * pool.acc_reward_per_weight) / ACC_PRECISION;
    c.staked_at = now;
    c.bump = ctx.bumps.cstake;
    pool.total_weight = pool
        .total_weight
        .checked_add(weight)
        .ok_or(StakeError::Overflow)?;
    emit!(Staked {
        owner: c.owner,
        kind: 1,
        key: c.claim,
        amount: 1,
        weight,
        unlock_at: 0,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct UnstakeCompressedChip<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"emission"], bump = emission.bump)]
    pub emission: Box<Account<'info, EmissionState>>,
    #[account(mut, seeds = [b"chip_pool"], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, close = owner, seeds = [b"compressed_cstake", claim.key().as_ref()], bump = cstake.bump, has_one = owner, has_one = claim)]
    pub cstake: Box<Account<'info, CompressedChipStake>>,
    // sentio-ignore-next-line SW013
    /// CHECK: ["stake_auth"] PDA signer for chip_core CPI
    #[account(seeds = [b"stake_auth"], bump)]
    pub stake_auth: UncheckedAccount<'info>,
    #[account(mut)]
    pub claim: Account<'info, CompressedMintClaim>,
    #[account(mut, address = emission.cg_mint)]
    pub cg_mint: Account<'info, Mint>,
    #[account(mut, token::mint = emission.cg_mint, token::authority = owner)]
    pub owner_cg: Account<'info, TokenAccount>,
    pub chip_core: Program<'info, ChipCore>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn unstake_compressed_chip(ctx: Context<UnstakeCompressedChip>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let pool = &mut ctx.accounts.pool;
    pool.update(now)?;
    let c = &ctx.accounts.cstake;
    let pending = pool.pending(c.weight, c.reward_debt)?;
    if pending > 0 {
        mint_to_user(
            &mut ctx.accounts.emission,
            &ctx.accounts.cg_mint.to_account_info(),
            &ctx.accounts.owner_cg.to_account_info(),
            &ctx.accounts.token_program.to_account_info(),
            pending,
            now,
        )?;
        emit!(Claimed {
            owner: c.owner,
            kind: 1,
            amount: pending
        });
    }
    pool.total_weight = pool
        .total_weight
        .checked_sub(c.weight)
        .ok_or(StakeError::Overflow)?;
    let seeds: &[&[u8]] = &[b"stake_auth", &[ctx.bumps.stake_auth]];
    chip_core::cpi::set_compressed_claim_staked(
        CpiContext::new_with_signer(
            ctx.accounts.chip_core.to_account_info(),
            SetCompressedClaimStaked {
                caller: ctx.accounts.stake_auth.to_account_info(),
                claim: ctx.accounts.claim.to_account_info(),
            },
            &[seeds],
        ),
        ctx.accounts.owner.key(),
        false,
    )?;
    emit!(Unstaked {
        owner: c.owner,
        kind: 1,
        key: c.claim,
        amount: 1,
        penalty_burned: 0
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimChip<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"emission"], bump = emission.bump, constraint = !emission.paused @ StakeError::Paused)]
    pub emission: Box<Account<'info, EmissionState>>,
    #[account(mut, seeds = [b"chip_pool"], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [b"cstake", cstake.asset.as_ref()], bump = cstake.bump, has_one = owner)]
    pub cstake: Box<Account<'info, ChipStake>>,
    #[account(seeds = [b"setbonus", owner.key().as_ref()], bump = set_bonus.bump)]
    pub set_bonus: Box<Account<'info, SetBonus>>,
    #[account(seeds = [b"chip", cstake.asset.as_ref()], bump = chip.bump, seeds::program = chip_core::ID)]
    pub chip: Account<'info, ChipState>,
    #[account(mut, address = emission.cg_mint)]
    pub cg_mint: Account<'info, Mint>,
    #[account(mut, token::mint = emission.cg_mint, token::authority = owner)]
    pub owner_cg: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// Claim and re-weigh (level-ups / set bonus changes take effect here).
pub fn claim_chip(ctx: Context<ClaimChip>) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.set_bonus.owner,
        ctx.accounts.owner.key(),
        StakeError::NotOwner
    );
    let now = Clock::get()?.unix_timestamp;
    let pool = &mut ctx.accounts.pool;
    pool.update(now)?;
    let c = &mut ctx.accounts.cstake;
    let pending = pool.pending(c.weight, c.reward_debt)?;
    require!(pending > 0, StakeError::NothingToClaim);
    mint_to_user(
        &mut ctx.accounts.emission,
        &ctx.accounts.cg_mint.to_account_info(),
        &ctx.accounts.owner_cg.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
        pending,
        now,
    )?;
    let w = chip_weight(&ctx.accounts.chip, ctx.accounts.set_bonus.completed_sets);
    pool.total_weight = pool.total_weight - c.weight + w;
    c.weight = w;
    c.reward_debt = (w * pool.acc_reward_per_weight) / ACC_PRECISION;
    emit!(Claimed {
        owner: c.owner,
        kind: 1,
        amount: pending
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Set bonus (oracle-attested; indexer proves 9/9 tiers of a district held or staked)
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct SyncSetBonus<'info> {
    pub set_oracle: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"emission"], bump = emission.bump, constraint = emission.set_oracle == set_oracle.key() @ StakeError::BadOracle)]
    pub emission: Box<Account<'info, EmissionState>>,
    /// CHECK: any wallet
    pub owner: UncheckedAccount<'info>,
    // Note: PDA cannot be closed; Anchor discriminator prevents re-init
    // sentio-ignore-next-line SW013, SW016
    #[account(init_if_needed, payer = payer, space = 8 + SetBonus::INIT_SPACE, seeds = [b"setbonus", owner.key().as_ref()], bump)]
    pub set_bonus: Box<Account<'info, SetBonus>>,
    pub system_program: Program<'info, System>,
}

pub fn sync_set_bonus(ctx: Context<SyncSetBonus>, sets: u8) -> Result<()> {
    require!(sets <= 10, StakeError::TooManySets);
    let sb = &mut ctx.accounts.set_bonus;
    if sb.owner == Pubkey::default() {
        sb.owner = ctx.accounts.owner.key();
        sb.bump = ctx.bumps.set_bonus;
    }
    require_keys_eq!(sb.owner, ctx.accounts.owner.key(), StakeError::NotOwner);
    sb.completed_sets = sets;
    sb.updated_at = Clock::get()?.unix_timestamp;
    emit!(SetBonusSynced {
        owner: sb.owner,
        sets
    });
    Ok(())
}
