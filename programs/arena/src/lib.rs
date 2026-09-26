//! GUTTERCAPS — arena
//!
//! PvP itself is server-authoritative (queue, matchmaking, resolution,
//! rating — docs/02-economy.md §4). This program only exists so that
//! **wagered** matches never require trusting the server with funds:
//!
//!  * both stakes sit in a PDA-owned $CG escrow;
//!  * the battle oracle can only name a winner ∈ {challenger, opponent};
//!  * rake is fixed at 5 % — 40 % → treasury ATA (studio revenue), 40 % burned
//!    on-chain, 20 % → season pool ATA (Phase 5 fee schedule v2);
//!  * the oracle has a daily payout cap (circuit breaker if its key leaks);
//!  * the squad is pinned at create/accept (ownership + not-listed checked
//!    on-chain), and the battle is bound to an arena-owned Switchboard
//!    randomness account (PDA, authority `["rng_auth"]`) committed by CPI at
//!    create and revealed permissionlessly — the server derives the battle
//!    seed as sha256(matchId ‖ commitA ‖ commitB ‖ vrf), so it cannot pick the RNG.
//!  * stale battles are cancellable by either side with a full refund.
//!
//! Chips are never at risk; only $CG.

#![allow(clippy::result_large_err)]

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount};
use chip_core::bubblegum::{
    leaf_asset_id, verify_v2_leaf, LeafProofArgs, MPL_ACCOUNT_COMPRESSION_ID,
};
use chip_core::randomness;
use mpl_core::accounts::BaseAssetV1;

use chip_core::state::{ChipState, CompressedChipState, CompressedMintClaim};

declare_id!("GCfERiohebYDJLtNwAZpGxudwbXRqnxmuTT413fkTYrM");

pub const MICRO: u64 = 1_000_000;
pub const MIN_WAGER: u64 = 5 * MICRO;
pub const MAX_WAGER: u64 = 5_000 * MICRO;
pub const RAKE_BPS: u64 = 500;
pub const RAKE_TREASURY_BPS: u64 = 4_000; // share of the rake → treasury
pub const RAKE_POOL_BPS: u64 = 2_000; // share of the rake → season pool; the rest is burned
pub const ACCEPT_TIMEOUT: i64 = 10 * 60;
pub const RESOLVE_TIMEOUT: i64 = 30 * 60;
pub const SQUAD: usize = 3;
pub const DAY: i64 = 86_400;
pub const MIN_SQUAD_POWER: u32 = 400;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
#[repr(u8)]
pub enum BattleStatus {
    Open = 0,
    Accepted = 1,
    Resolved = 2,
    Cancelled = 3,
}

#[account]
#[derive(InitSpace)]
pub struct ArenaConfig {
    pub admin: Pubkey,
    pub battle_oracle: Pubkey,
    pub cg_mint: Pubkey,
    pub season_pool: Pubkey, // ATA receiving 20 % of rake (owned by staking emission PDA)
    pub treasury_cg: Pubkey, // ATA receiving 40 % of rake (Squads treasury)
    pub oracle_daily_cap: u64, // micro $CG the oracle may pay out per day (sum of pots)
    pub oracle_paid_today: u64,
    pub oracle_day_start: i64,
    pub paused: bool,
    pub bump: u8,
    /// SEC-H2 hot pauser (may only call `pause`); `Pubkey::default()` = none. Appended last.
    pub pauser: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct WagerBattle {
    pub challenger: Pubkey,
    pub opponent: Pubkey,
    pub wager: u64,
    pub squad_a: [Pubkey; SQUAD],
    pub squad_b: [Pubkey; SQUAD],
    pub power_a: u32,
    pub power_b: u32,
    pub randomness: Pubkey,
    pub commit_slot: u64,
    pub status: BattleStatus,
    pub created_at: i64,
    pub accepted_at: i64,
    pub winner: Pubkey,
    pub result_hash: [u8; 32], // sha256 of the full server battle log (auditable vs published season secret)
    pub nonce: u64,
    pub bump: u8,
}

#[event]
pub struct BattleCreated {
    pub battle: Pubkey,
    pub challenger: Pubkey,
    pub wager: u64,
    pub power_a: u32,
    pub randomness: Pubkey,
}
#[event]
pub struct BattleAccepted {
    pub battle: Pubkey,
    pub opponent: Pubkey,
    pub power_b: u32,
}
#[event]
pub struct BattleResolved {
    pub battle: Pubkey,
    pub winner: Pubkey,
    pub pot: u64,
    pub rake_burn: u64,
    pub rake_pool: u64,
    pub rake_treasury: u64,
    pub result_hash: [u8; 32],
    pub roll: [u8; 32],
}
#[event]
pub struct BattleCancelled {
    pub battle: Pubkey,
    pub refunded_a: u64,
    pub refunded_b: u64,
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
/// `set_arena` touched a non-pause field; the payload is the resulting config, not the delta.
/// `battle_oracle` is the key that signs every payout, so a rotation must page (runbook §3.2).
#[event]
pub struct ArenaConfigChanged {
    pub by: Pubkey,
    pub battle_oracle: Pubkey,
    pub oracle_daily_cap: u64,
    pub treasury_cg: Pubkey,
}

#[error_code]
pub enum ArenaError {
    #[msg("Paused")]
    Paused,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Wager out of range (5–5000 $CG)")]
    WagerRange,
    #[msg("Battle is not in the expected status")]
    BadStatus,
    #[msg("Squad chip not owned by signer")]
    NotOwner,
    #[msg("Squad chip is listed / fusing / locked")]
    ChipBusy,
    #[msg("Bubblegum V2 ownership proof is invalid")]
    InvalidBubblegumProof,
    #[msg("Duplicate chip in squad")]
    DuplicateChip,
    #[msg("Squad power below minimum")]
    SquadTooWeak,
    #[msg("Squad power mismatch between players is beyond league bounds")]
    LeagueMismatch,
    #[msg("Winner must be challenger or opponent")]
    BadWinner,
    #[msg("Oracle daily payout cap reached")]
    OracleCap,
    #[msg("Not stale yet")]
    NotStale,
    #[msg("Cannot battle yourself")]
    SelfBattle,
    #[msg("Randomness account expired / already revealed / not resolved")]
    Randomness,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Only the program upgrade authority may initialise (SEC-F7)")]
    NotUpgradeAuthority,
}

/// Squad power = Σ basePower(rarity) × levelMult. Element/synergy live off-chain (they need the opponent).
fn squad_power(chips: &[Account<ChipState>]) -> u32 {
    chips
        .iter()
        .map(|c| {
            (c.rarity.base_power() as u64 * chip_core::economy::level_mult_bps(c.level) / 10_000)
                as u32
        })
        .sum()
}

// `&'info [AccountInfo<'info>]`, not `&[AccountInfo<'info>]`: the loop below feeds these elements to
// `Account::try_from`, whose `Account<'info, _>` keeps the handle, so the borrow of the slice has to be
// `'info` too. With the outer lifetime elided the compiler answers `error[E0621]: explicit lifetime required
// in the type of rem` and prints this exact signature as the fix. Every caller here passes
// `ctx.remaining_accounts`, which is already `&'info [...]`.
fn validate_compressed_squad<'info>(
    rem: &'info [AccountInfo<'info>],
    owner: &Pubkey,
) -> Result<([Pubkey; SQUAD], u32)> {
    require!(rem.len() == SQUAD, ArenaError::DuplicateChip);
    let mut keys = [Pubkey::default(); SQUAD];
    let mut states: Vec<Account<CompressedMintClaim>> = Vec::with_capacity(SQUAD);
    for i in 0..SQUAD {
        let claim_ai = &rem[i];
        require_keys_eq!(*claim_ai.owner, chip_core::ID, ArenaError::NotOwner);
        let claim: Account<CompressedMintClaim> = Account::try_from(claim_ai)?;
        require_keys_eq!(claim.buyer, *owner, ArenaError::NotOwner);
        // Same rule as `validate_squad` / v2 (SEC-F14): owned, not listed, not consumed by fusion;
        // staked claims may fight. A claim is the paid pack outcome — rarity and level are final
        // before the Bubblegum mint — so an unminted claim fights with its recorded power.
        require!(!claim.listed && !claim.consumed, ArenaError::ChipBusy);
        for k in &keys[..i] {
            require!(*k != claim.key(), ArenaError::DuplicateChip);
        }
        keys[i] = claim.key();
        states.push(claim);
    }
    let power = states
        .iter()
        .map(|c| {
            (c.rarity.base_power() as u64 * chip_core::economy::level_mult_bps(c.level) / 10_000)
                as u32
        })
        .sum();
    require!(power >= MIN_SQUAD_POWER, ArenaError::SquadTooWeak);
    Ok((keys, power))
}

/// Validates three registered compressed chips against the live Bubblegum V2
/// root. Remaining accounts are `[claim, chip_state, merkle_tree, proof_nodes…]`
/// for each slot; `proof_depths` makes the variable-length layout explicit.
#[rustfmt::skip]
fn validate_compressed_squad_v2<'info>(
    rem: &'info [AccountInfo<'info>],
    compression_program: &AccountInfo<'info>,
    owner: &Pubkey,
    delegates: &[Pubkey; SQUAD],
    proofs: &[LeafProofArgs; SQUAD],
    proof_depths: &[u8; SQUAD],
) -> Result<([Pubkey; SQUAD], u32)> {
    require_keys_eq!(
        *compression_program.key,
        MPL_ACCOUNT_COMPRESSION_ID,
        ArenaError::InvalidBubblegumProof
    );
    let mut offset = 0usize;
    let mut keys = [Pubkey::default(); SQUAD];
    let mut power = 0u32;
    for i in 0..SQUAD {
        let depth = usize::from(proof_depths[i]);
        require!(depth > 0 && depth <= 32, ArenaError::InvalidBubblegumProof);
        require!(offset.checked_add(3 + depth).is_some(), ArenaError::InvalidBubblegumProof);
        let claim_ai = rem.get(offset).ok_or(error!(ArenaError::InvalidBubblegumProof))?;
        let chip_ai = rem.get(offset + 1).ok_or(error!(ArenaError::InvalidBubblegumProof))?;
        let tree_ai = rem.get(offset + 2).ok_or(error!(ArenaError::InvalidBubblegumProof))?;
        let proof_end = offset + 3 + depth;
        require_keys_eq!(*claim_ai.owner, chip_core::ID, ArenaError::InvalidBubblegumProof);
        let claim: Account<CompressedMintClaim> = Account::try_from(claim_ai)
            .map_err(|_| error!(ArenaError::InvalidBubblegumProof))?;
        let chip: Account<CompressedChipState> = Account::try_from(chip_ai)
            .map_err(|_| error!(ArenaError::InvalidBubblegumProof))?;
        require_keys_eq!(claim.buyer, *owner, ArenaError::NotOwner);
        // One squad rule for every chip shape (SEC-F14, docs/02 §4.6): owned, not listed, not in
        // fusion, and staked chips MAY fight, exactly like `validate_squad` (Core) and the v1
        // claim path. `minted && registered` is not an ownership rule but what this path needs
        // to verify the leaf against the live tree at all.
        require!(
            claim.minted && claim.registered && !claim.listed && !claim.consumed,
            ArenaError::ChipBusy
        );
        require_keys_eq!(chip.claim, claim.key(), ArenaError::InvalidBubblegumProof);
        require_keys_eq!(chip.merkle_tree, *tree_ai.key, ArenaError::InvalidBubblegumProof);
        require_keys_eq!(
            chip.asset,
            leaf_asset_id(&chip.merkle_tree, chip.leaf_index),
            ArenaError::InvalidBubblegumProof
        );
        proofs[i]
            .validate_coordinates(chip.leaf_nonce, chip.leaf_index)
            .map_err(|_| error!(ArenaError::InvalidBubblegumProof))?;
        require!(
            proofs[i].data_hash == chip.data_hash
                && proofs[i].creator_hash == chip.creator_hash
                && proofs[i].collection_hash == chip.collection_hash
                && proofs[i].asset_data_hash == chip.asset_data_hash
                && proofs[i].flags == chip.leaf_flags,
            ArenaError::InvalidBubblegumProof
        );
        verify_v2_leaf(
            compression_program,
            tree_ai,
            chip.asset,
            *owner,
            delegates[i],
            &proofs[i],
            &rem[offset + 3..proof_end],
        )
        .map_err(|_| error!(ArenaError::InvalidBubblegumProof))?;
        for key in &keys[..i] {
            require!(*key != claim.key(), ArenaError::DuplicateChip);
        }
        keys[i] = claim.key();
        power = power
            .checked_add(
                (claim.rarity.base_power() as u64
                    * chip_core::economy::level_mult_bps(claim.level)
                    / 10_000) as u32,
            )
            .ok_or(ArenaError::Overflow)?;
        offset = proof_end;
    }
    require!(offset == rem.len(), ArenaError::InvalidBubblegumProof);
    require!(power >= MIN_SQUAD_POWER, ArenaError::SquadTooWeak);
    Ok((keys, power))
}

fn validate_squad<'info>(
    rem: &'info [AccountInfo<'info>],
    owner: &Pubkey,
    now: i64,
) -> Result<([Pubkey; SQUAD], u32)> {
    if rem.len() == SQUAD {
        return validate_compressed_squad(rem, owner);
    }
    require!(rem.len() == SQUAD * 2, ArenaError::DuplicateChip);
    let mut keys = [Pubkey::default(); SQUAD];
    let mut states: Vec<Account<ChipState>> = Vec::with_capacity(SQUAD);
    for i in 0..SQUAD {
        let asset = &rem[i * 2];
        let state_ai = &rem[i * 2 + 1];
        require_keys_eq!(*asset.owner, mpl_core::ID, ArenaError::NotOwner);
        let base = BaseAssetV1::from_bytes(&asset.try_borrow_data()?)
            .map_err(|_| error!(ArenaError::NotOwner))?;
        require_keys_eq!(base.owner, *owner, ArenaError::NotOwner);
        let (exp, _) =
            Pubkey::find_program_address(&[b"chip", asset.key().as_ref()], &chip_core::ID);
        require_keys_eq!(exp, state_ai.key(), ArenaError::NotOwner);
        let st: Account<ChipState> = Account::try_from(state_ai)?;
        // staked chips MAY fight (they're frozen, not gone); listed / fusing may not: the one
        // squad rule shared with both compressed paths (SEC-F14, docs/02 §4.6)
        require!(
            st.flags & (ChipState::F_LISTED | ChipState::F_FUSING) == 0,
            ArenaError::ChipBusy
        );
        let _ = now;
        for k in &keys[..i] {
            require!(*k != asset.key(), ArenaError::DuplicateChip);
        }
        keys[i] = asset.key();
        states.push(st);
    }
    let power = squad_power(&states);
    require!(power >= MIN_SQUAD_POWER, ArenaError::SquadTooWeak);
    Ok((keys, power))
}

/// League bands from docs/02-economy.md §4.5 — opponents must share a league.
fn league(power: u32) -> u8 {
    match power {
        0..=799 => 0,
        800..=1399 => 1,
        1400..=2399 => 2,
        2400..=3999 => 3,
        4000..=6999 => 4,
        _ => 5,
    }
}

// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitArena<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + ArenaConfig::INIT_SPACE, seeds = [b"arena_config"], bump)]
    pub config: Account<'info, ArenaConfig>,
    pub system_program: Program<'info, System>,
    /// CHECK: SEC-F7 — this program's ProgramData (upgradeable-loader PDA `[program_id]`); address,
    /// owner and recorded upgrade authority are verified in the handler (`chip_core::deploy_guard`).
    pub program_data: UncheckedAccount<'info>,
}

pub fn init_arena_handler(
    ctx: Context<InitArena>,
    battle_oracle: Pubkey,
    cg_mint: Pubkey,
    season_pool: Pubkey,
    treasury_cg: Pubkey,
    oracle_daily_cap: u64,
) -> Result<()> {
    // SEC-F7: first-caller-wins closed — only the upgrade authority can create the arena config.
    require!(
        chip_core::deploy_guard::signer_is_upgrade_authority(
            ctx.program_id,
            &ctx.accounts.program_data.to_account_info(),
            ctx.accounts.admin.key,
        ),
        ArenaError::NotUpgradeAuthority
    );
    let c = &mut ctx.accounts.config;
    c.admin = ctx.accounts.admin.key();
    c.battle_oracle = battle_oracle;
    c.cg_mint = cg_mint;
    c.season_pool = season_pool;
    c.treasury_cg = treasury_cg;
    c.oracle_daily_cap = oracle_daily_cap;
    c.oracle_day_start = Clock::get()?.unix_timestamp;
    c.bump = ctx.bumps.config;
    c.pauser = Pubkey::default();
    Ok(())
}

#[derive(Accounts)]
pub struct ArenaAdmin<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"arena_config"], bump = config.bump, has_one = admin @ ArenaError::Unauthorized)]
    pub config: Account<'info, ArenaConfig>,
}

pub fn set_arena_handler(
    ctx: Context<ArenaAdmin>,
    battle_oracle: Option<Pubkey>,
    oracle_daily_cap: Option<u64>,
    paused: Option<bool>,
    treasury_cg: Option<Pubkey>,
) -> Result<()> {
    let c = &mut ctx.accounts.config;
    if let Some(o) = battle_oracle {
        c.battle_oracle = o;
    }
    if let Some(cap) = oracle_daily_cap {
        c.oracle_daily_cap = cap;
    }
    if let Some(p) = paused {
        c.paused = p;
        emit!(PauseChanged {
            by: ctx.accounts.admin.key(),
            paused: p
        });
    }
    if let Some(t) = treasury_cg {
        c.treasury_cg = t;
    }
    if battle_oracle.is_some() || oracle_daily_cap.is_some() || treasury_cg.is_some() {
        emit!(ArenaConfigChanged {
            by: ctx.accounts.admin.key(),
            battle_oracle: c.battle_oracle,
            oracle_daily_cap: c.oracle_daily_cap,
            treasury_cg: c.treasury_cg,
        });
    }
    Ok(())
}

pub fn set_pauser_handler(ctx: Context<ArenaAdmin>, pauser: Pubkey) -> Result<()> {
    ctx.accounts.config.pauser = pauser;
    emit!(PauserChanged {
        by: ctx.accounts.admin.key(),
        pauser
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Pause<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut, seeds = [b"arena_config"], bump = config.bump,
        constraint = authority.key() == config.admin || (config.pauser != Pubkey::default() && authority.key() == config.pauser) @ ArenaError::Unauthorized,
    )]
    pub config: Account<'info, ArenaConfig>,
}

/// SEC-H2 emergency stop: pauser or admin, `paused = true` only (blocks create/accept; resolve,
/// cancel_stale and randomness close keep working so escrows can always be settled/refunded).
pub fn pause_handler(ctx: Context<Pause>) -> Result<()> {
    ctx.accounts.config.paused = true;
    emit!(PauseChanged {
        by: ctx.accounts.authority.key(),
        paused: true
    });
    Ok(())
}

// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CreateBattle<'info> {
    #[account(mut)]
    pub challenger: Signer<'info>,
    #[account(seeds = [b"arena_config"], bump = config.bump, constraint = !config.paused @ ArenaError::Paused)]
    pub config: Account<'info, ArenaConfig>,
    #[account(init, payer = challenger, space = 8 + WagerBattle::INIT_SPACE, seeds = [b"battle", challenger.key().as_ref(), &nonce.to_le_bytes()], bump)]
    pub battle: Account<'info, WagerBattle>,
    /// CHECK: arena-owned Switchboard randomness `["rng", 2, challenger, nonce]` created by
    /// `init_battle_randomness` in this tx (owner = Switchboard, SEC-C1); committed HERE by CPI
    /// with the arena `rng_auth` signature (SEC-C3 part 2).
    #[account(
        mut, owner = randomness::SB_PROGRAM_ID @ ArenaError::Randomness,
        seeds = [randomness::RNG_SEED, &[randomness::RNG_KIND_BATTLE], challenger.key().as_ref(), &nonce.to_le_bytes()], bump,
    )]
    pub randomness: UncheckedAccount<'info>,
    /// CHECK: arena's Switchboard authority PDA.
    #[account(seeds = [randomness::RNG_AUTH_SEED], bump)]
    pub rng_auth: UncheckedAccount<'info>,
    /// CHECK: Switchboard On-Demand program for this cluster.
    #[account(address = randomness::SB_PROGRAM_ID @ ArenaError::Randomness)]
    pub switchboard_program: UncheckedAccount<'info>,
    /// CHECK: pinned queue (verified in `commit_owned`).
    #[account(address = randomness::SB_QUEUE @ ArenaError::Randomness)]
    pub queue: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: oracle chosen by the client from the queue.
    #[account(mut)]
    pub oracle: UncheckedAccount<'info>,
    /// CHECK: SlotHashes sysvar.
    #[account(address = randomness::SLOT_HASHES_ID)]
    pub recent_slothashes: UncheckedAccount<'info>,
    #[account(address = config.cg_mint)]
    pub cg_mint: Account<'info, Mint>,
    #[account(mut, token::mint = cg_mint, token::authority = challenger)]
    pub challenger_cg: Account<'info, TokenAccount>,
    #[account(init, payer = challenger, associated_token::mint = cg_mint, associated_token::authority = battle)]
    pub escrow: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    // remaining_accounts: [asset_i, chip_state_i] × 3
}

#[rustfmt::skip]
#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CreateBattleV2<'info> {
    #[account(mut)]
    pub challenger: Signer<'info>,
    #[account(seeds = [b"arena_config"], bump = config.bump, constraint = !config.paused @ ArenaError::Paused)]
    pub config: Account<'info, ArenaConfig>,
    #[account(init, payer = challenger, space = 8 + WagerBattle::INIT_SPACE, seeds = [b"battle", challenger.key().as_ref(), &nonce.to_le_bytes()], bump)]
    pub battle: Account<'info, WagerBattle>,
    /// CHECK: arena-owned Switchboard randomness PDA.
    #[account(mut, owner = randomness::SB_PROGRAM_ID @ ArenaError::Randomness, seeds = [randomness::RNG_SEED, &[randomness::RNG_KIND_BATTLE], challenger.key().as_ref(), &nonce.to_le_bytes()], bump)]
    pub randomness: UncheckedAccount<'info>,
    /// CHECK: arena's Switchboard authority PDA.
    #[account(seeds = [randomness::RNG_AUTH_SEED], bump)]
    pub rng_auth: UncheckedAccount<'info>,
    /// CHECK: Switchboard On-Demand program.
    #[account(address = randomness::SB_PROGRAM_ID @ ArenaError::Randomness)]
    pub switchboard_program: UncheckedAccount<'info>,
    /// CHECK: pinned Switchboard queue.
    #[account(address = randomness::SB_QUEUE @ ArenaError::Randomness)]
    pub queue: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: queue-selected oracle.
    #[account(mut)]
    pub oracle: UncheckedAccount<'info>,
    /// CHECK: SlotHashes sysvar.
    #[account(address = randomness::SLOT_HASHES_ID)]
    pub recent_slothashes: UncheckedAccount<'info>,
    #[account(address = config.cg_mint)]
    pub cg_mint: Account<'info, Mint>,
    #[account(mut, token::mint = cg_mint, token::authority = challenger)]
    pub challenger_cg: Account<'info, TokenAccount>,
    #[account(init, payer = challenger, associated_token::mint = cg_mint, associated_token::authority = battle)]
    pub escrow: Account<'info, TokenAccount>,
    /// CHECK: fixed MPL Account Compression program used by every proof.
    #[account(address = MPL_ACCOUNT_COMPRESSION_ID)]
    pub compression_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[rustfmt::skip]
// sentio-ignore-fn SW023
pub fn create_battle_v2_handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, CreateBattleV2<'info>>,
    nonce: u64,
    wager: u64,
    delegates: [Pubkey; SQUAD],
    proofs: [LeafProofArgs; SQUAD],
    proof_depths: [u8; SQUAD],
) -> Result<()> {
    require!((MIN_WAGER..=MAX_WAGER).contains(&wager), ArenaError::WagerRange);
    let clock = Clock::get()?;
    let auth_seeds: &[&[u8]] = &[randomness::RNG_AUTH_SEED, &[ctx.bumps.rng_auth]];
    let rnd = randomness::commit_owned(
        &ctx.accounts.switchboard_program.to_account_info(),
        &ctx.accounts.randomness.to_account_info(),
        &ctx.accounts.queue.to_account_info(),
        &ctx.accounts.oracle.to_account_info(),
        &ctx.accounts.rng_auth.to_account_info(),
        &ctx.accounts.recent_slothashes.to_account_info(),
        &[auth_seeds],
        clock.slot,
    )
    .map_err(|_| error!(ArenaError::Randomness))?;
    let (squad, power) = validate_compressed_squad_v2(
        ctx.remaining_accounts,
        &ctx.accounts.compression_program.to_account_info(),
        &ctx.accounts.challenger.key(),
        &delegates,
        &proofs,
        &proof_depths,
    )?;
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token::Transfer {
                from: ctx.accounts.challenger_cg.to_account_info(),
                to: ctx.accounts.escrow.to_account_info(),
                authority: ctx.accounts.challenger.to_account_info(),
            },
        ),
        wager,
    )?;
    let b = &mut ctx.accounts.battle;
    b.challenger = ctx.accounts.challenger.key();
    b.wager = wager;
    b.squad_a = squad;
    b.power_a = power;
    b.randomness = ctx.accounts.randomness.key();
    b.commit_slot = rnd.seed_slot;
    b.status = BattleStatus::Open;
    b.created_at = clock.unix_timestamp;
    b.nonce = nonce;
    b.bump = ctx.bumps.battle;
    emit!(BattleCreated { battle: b.key(), challenger: b.challenger, wager, power_a: power, randomness: b.randomness });
    Ok(())
}

// sentio-ignore-fn SW023
pub fn create_battle_handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, CreateBattle<'info>>,
    nonce: u64,
    wager: u64,
) -> Result<()> {
    require!(
        (MIN_WAGER..=MAX_WAGER).contains(&wager),
        ArenaError::WagerRange
    );
    let clock = Clock::get()?;
    // commit the arena-owned randomness by CPI: authority == rng_auth, never used, fresh after (SEC-C3 part 2)
    let auth_seeds: &[&[u8]] = &[randomness::RNG_AUTH_SEED, &[ctx.bumps.rng_auth]];
    let rnd = randomness::commit_owned(
        &ctx.accounts.switchboard_program.to_account_info(),
        &ctx.accounts.randomness.to_account_info(),
        &ctx.accounts.queue.to_account_info(),
        &ctx.accounts.oracle.to_account_info(),
        &ctx.accounts.rng_auth.to_account_info(),
        &ctx.accounts.recent_slothashes.to_account_info(),
        &[auth_seeds],
        clock.slot,
    )
    .map_err(|_| error!(ArenaError::Randomness))?;

    let (squad, power) = validate_squad(
        ctx.remaining_accounts,
        &ctx.accounts.challenger.key(),
        clock.unix_timestamp,
    )?;
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token::Transfer {
                from: ctx.accounts.challenger_cg.to_account_info(),
                to: ctx.accounts.escrow.to_account_info(),
                authority: ctx.accounts.challenger.to_account_info(),
            },
        ),
        wager,
    )?;

    let b = &mut ctx.accounts.battle;
    b.challenger = ctx.accounts.challenger.key();
    b.wager = wager;
    b.squad_a = squad;
    b.power_a = power;
    b.randomness = ctx.accounts.randomness.key();
    b.commit_slot = rnd.seed_slot;
    b.status = BattleStatus::Open;
    b.created_at = clock.unix_timestamp;
    b.nonce = nonce;
    b.bump = ctx.bumps.battle;
    emit!(BattleCreated {
        battle: b.key(),
        challenger: b.challenger,
        wager,
        power_a: power,
        randomness: b.randomness
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Program-owned Switchboard randomness (SEC-C3 part 2) — arena has its own
// `["rng_auth"]` because only the program that owns the PDA can sign for it.
// The account metas mirror chip_core::instructions::rng; the CPI helpers are shared.
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct InitBattleRandomness<'info> {
    #[account(mut)]
    pub challenger: Signer<'info>,
    // sentio-ignore-next-line SW013
    /// CHECK: PDA `["rng", 2, challenger, nonce]`, created by Switchboard via CPI.
    #[account(mut, seeds = [randomness::RNG_SEED, &[randomness::RNG_KIND_BATTLE], challenger.key().as_ref(), &nonce.to_le_bytes()], bump)]
    pub randomness: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW013
    /// CHECK: arena's Switchboard authority PDA.
    #[account(seeds = [randomness::RNG_AUTH_SEED], bump)]
    pub rng_auth: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: wSOL ATA of `randomness` (Switchboard creates it).
    #[account(mut)]
    pub reward_escrow: UncheckedAccount<'info>,
    /// CHECK: pinned queue (verified in `init_owned`).
    #[account(mut, address = randomness::SB_QUEUE @ ArenaError::Randomness)]
    pub queue: UncheckedAccount<'info>,
    /// CHECK: Switchboard `["STATE"]`.
    pub program_state: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: Switchboard `["LutSigner", randomness]`.
    pub lut_signer: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: lookup table derived from (lut_signer, recent_slot).
    #[account(mut)]
    pub lut: UncheckedAccount<'info>,
    /// CHECK: Switchboard On-Demand program for this cluster.
    #[account(address = randomness::SB_PROGRAM_ID @ ArenaError::Randomness)]
    pub switchboard_program: UncheckedAccount<'info>,
    /// CHECK: wSOL mint.
    #[account(address = randomness::WSOL_MINT)]
    pub wrapped_sol_mint: UncheckedAccount<'info>,
    /// CHECK: Address Lookup Table program.
    #[account(address = randomness::ADDRESS_LOOKUP_TABLE_PROGRAM_ID)]
    pub address_lookup_table_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn init_battle_randomness_handler(
    ctx: Context<InitBattleRandomness>,
    nonce: u64,
    recent_slot: u64,
) -> Result<()> {
    let challenger = ctx.accounts.challenger.key();
    let nonce_le = nonce.to_le_bytes();
    let rng_seeds: &[&[u8]] = &[
        randomness::RNG_SEED,
        &[randomness::RNG_KIND_BATTLE],
        challenger.as_ref(),
        &nonce_le,
        &[ctx.bumps.randomness],
    ];
    let auth_seeds: &[&[u8]] = &[randomness::RNG_AUTH_SEED, &[ctx.bumps.rng_auth]];
    let a = randomness::SbInitAccounts {
        randomness: ctx.accounts.randomness.to_account_info(),
        reward_escrow: ctx.accounts.reward_escrow.to_account_info(),
        authority: ctx.accounts.rng_auth.to_account_info(),
        queue: ctx.accounts.queue.to_account_info(),
        payer: ctx.accounts.challenger.to_account_info(),
        system_program: ctx.accounts.system_program.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
        associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
        wrapped_sol_mint: ctx.accounts.wrapped_sol_mint.to_account_info(),
        program_state: ctx.accounts.program_state.to_account_info(),
        lut_signer: ctx.accounts.lut_signer.to_account_info(),
        lut: ctx.accounts.lut.to_account_info(),
        address_lookup_table_program: ctx.accounts.address_lookup_table_program.to_account_info(),
    };
    randomness::init_owned(
        &ctx.accounts.switchboard_program.to_account_info(),
        &a,
        recent_slot,
        &[rng_seeds, auth_seeds],
    )
    .map_err(|_| error!(ArenaError::Randomness))?;
    Ok(())
}

#[derive(Accounts)]
pub struct RevealBattleRandomness<'info> {
    /// permissionless crank
    #[account(mut)]
    pub payer: Signer<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: any arena-owned randomness account (authority checked in the helper).
    #[account(mut)]
    pub randomness: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW013
    /// CHECK: `["rng_auth"]` of the arena.
    #[account(seeds = [randomness::RNG_AUTH_SEED], bump)]
    pub rng_auth: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: oracle assigned at commit.
    pub oracle: UncheckedAccount<'info>,
    /// CHECK: pinned queue.
    #[account(address = randomness::SB_QUEUE @ ArenaError::Randomness)]
    pub queue: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: `["OracleRandomnessStats", oracle]` (Switchboard).
    #[account(mut)]
    pub stats: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: wSOL ATA of `randomness`.
    #[account(mut)]
    pub reward_escrow: UncheckedAccount<'info>,
    /// CHECK: Switchboard `["STATE"]`.
    pub program_state: UncheckedAccount<'info>,
    /// CHECK: SlotHashes sysvar.
    #[account(address = randomness::SLOT_HASHES_ID)]
    pub recent_slothashes: UncheckedAccount<'info>,
    /// CHECK: Switchboard On-Demand program for this cluster.
    #[account(address = randomness::SB_PROGRAM_ID @ ArenaError::Randomness)]
    pub switchboard_program: UncheckedAccount<'info>,
    /// CHECK: wSOL mint.
    #[account(address = randomness::WSOL_MINT)]
    pub wrapped_sol_mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn reveal_battle_randomness_handler(
    ctx: Context<RevealBattleRandomness>,
    signature: [u8; 64],
    recovery_id: u8,
    value: [u8; 32],
) -> Result<()> {
    let auth_seeds: &[&[u8]] = &[randomness::RNG_AUTH_SEED, &[ctx.bumps.rng_auth]];
    let a = randomness::SbRevealAccounts {
        randomness: ctx.accounts.randomness.to_account_info(),
        oracle: ctx.accounts.oracle.to_account_info(),
        queue: ctx.accounts.queue.to_account_info(),
        stats: ctx.accounts.stats.to_account_info(),
        authority: ctx.accounts.rng_auth.to_account_info(),
        payer: ctx.accounts.payer.to_account_info(),
        recent_slothashes: ctx.accounts.recent_slothashes.to_account_info(),
        system_program: ctx.accounts.system_program.to_account_info(),
        reward_escrow: ctx.accounts.reward_escrow.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
        wrapped_sol_mint: ctx.accounts.wrapped_sol_mint.to_account_info(),
        program_state: ctx.accounts.program_state.to_account_info(),
    };
    randomness::reveal_owned(
        &ctx.accounts.switchboard_program.to_account_info(),
        &a,
        &signature,
        recovery_id,
        &value,
        &[auth_seeds],
    )
    .map_err(|_| error!(ArenaError::Randomness))?;
    Ok(())
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CloseBattleRandomness<'info> {
    /// permissionless (crank); rent always goes to the challenger
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: paid the rent at `init_battle_randomness`; bound by the PDA seeds.
    #[account(mut, address = battle.challenger)]
    pub challenger: UncheckedAccount<'info>,
    /// CHECK: `["rng", 2, challenger, nonce]` and Switchboard-owned.
    #[account(
        mut,
        owner = randomness::SB_PROGRAM_ID @ ArenaError::Randomness,
        seeds = [randomness::RNG_SEED, &[randomness::RNG_KIND_BATTLE], challenger.key().as_ref(), &nonce.to_le_bytes()],
        bump,
        seeds::program = crate::ID,
    )]
    pub randomness: UncheckedAccount<'info>,
    /// CHECK: `["rng_auth"]` — receives the rent and forwards it.
    #[account(mut, seeds = [randomness::RNG_AUTH_SEED], bump)]
    pub rng_auth: UncheckedAccount<'info>,
    /// The battle that pinned this account must be settled (resolved or cancelled).
    #[account(
        seeds = [b"battle", challenger.key().as_ref(), &nonce.to_le_bytes()], bump = battle.bump,
        constraint = battle.randomness == randomness.key() @ ArenaError::Randomness,
        constraint = battle.status == BattleStatus::Resolved || battle.status == BattleStatus::Cancelled @ ArenaError::BadStatus,
    )]
    pub battle: Account<'info, WagerBattle>,
    // sentio-ignore-next-line SW002
    /// CHECK: wSOL ATA of `randomness`.
    #[account(mut)]
    pub reward_escrow: UncheckedAccount<'info>,
    /// CHECK: Switchboard `["STATE"]`.
    pub program_state: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: lookup table of this randomness account.
    #[account(mut)]
    pub lut: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: `["LutSigner", randomness]`.
    pub lut_signer: UncheckedAccount<'info>,
    /// CHECK: Switchboard On-Demand program for this cluster.
    #[account(address = randomness::SB_PROGRAM_ID @ ArenaError::Randomness)]
    pub switchboard_program: UncheckedAccount<'info>,
    /// CHECK: wSOL mint.
    #[account(address = randomness::WSOL_MINT)]
    pub wrapped_sol_mint: UncheckedAccount<'info>,
    /// CHECK: Address Lookup Table program.
    #[account(address = randomness::ADDRESS_LOOKUP_TABLE_PROGRAM_ID)]
    pub address_lookup_table_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn close_battle_randomness_handler(
    ctx: Context<CloseBattleRandomness>,
    _nonce: u64,
) -> Result<()> {
    let auth_seeds: &[&[u8]] = &[randomness::RNG_AUTH_SEED, &[ctx.bumps.rng_auth]];
    let a = randomness::SbCloseAccounts {
        randomness: ctx.accounts.randomness.to_account_info(),
        reward_escrow: ctx.accounts.reward_escrow.to_account_info(),
        authority: ctx.accounts.rng_auth.to_account_info(),
        program_state: ctx.accounts.program_state.to_account_info(),
        system_program: ctx.accounts.system_program.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
        wrapped_sol_mint: ctx.accounts.wrapped_sol_mint.to_account_info(),
        lut: ctx.accounts.lut.to_account_info(),
        lut_signer: ctx.accounts.lut_signer.to_account_info(),
        address_lookup_table_program: ctx.accounts.address_lookup_table_program.to_account_info(),
    };
    let returned = randomness::close_owned(
        &ctx.accounts.switchboard_program.to_account_info(),
        &a,
        &[auth_seeds],
    )
    .map_err(|_| error!(ArenaError::Randomness))?;
    if returned > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.rng_auth.to_account_info(),
                    to: ctx.accounts.challenger.to_account_info(),
                },
                &[auth_seeds],
            ),
            returned,
        )?;
    }
    Ok(())
}

#[derive(Accounts)]
#[instruction(nonce: u64, lut_slot: u64)]
pub struct CloseBattleRandomnessLut<'info> {
    /// Permissionless (our crank batches these); the table's rent always goes to the challenger.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the player who paid the table's rent — pinned to `battle.challenger` below and paid by
    /// Switchboard (`recipient`), so a relayer cannot redirect the rent to itself.
    #[account(mut)]
    pub challenger: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW013
    /// CHECK: `["rng", 2, challenger, nonce]` — must already be CLOSED (`close_battle_randomness`
    /// deactivates the table as it closes the account, and the ALT cooldown starts there);
    /// `close_lut_owned` re-checks "gone" = no data + system-owned (SEC-F8). `mut` mirrors the SDK's
    /// metas; the seeds below are what the CPI signs with.
    #[account(
        mut,
        seeds = [randomness::RNG_SEED, &[randomness::RNG_KIND_BATTLE], challenger.key().as_ref(), &nonce.to_le_bytes()],
        bump,
        seeds::program = crate::ID,
    )]
    pub randomness: UncheckedAccount<'info>,
    /// The battle that pinned this account must be settled (resolved or cancelled) — as in
    /// `close_battle_randomness`, and the account pins the randomness and the recipient.
    #[account(
        seeds = [b"battle", challenger.key().as_ref(), &nonce.to_le_bytes()], bump = battle.bump,
        constraint = battle.randomness == randomness.key() @ ArenaError::Randomness,
        constraint = battle.status == BattleStatus::Resolved || battle.status == BattleStatus::Cancelled @ ArenaError::BadStatus,
        constraint = battle.challenger == challenger.key() @ ArenaError::Unauthorized,
    )]
    pub battle: Account<'info, WagerBattle>,
    // sentio-ignore-next-line SW002
    /// CHECK: Switchboard `["LutSigner", randomness]` — derived and checked in `close_lut_owned`.
    pub lut_signer: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: `AddressLookupTable.createLookupTable({authority: lut_signer, recentSlot: lut_slot})` —
    /// derived from `lut_slot` and checked in `close_lut_owned`; Switchboard verifies it holds the
    /// deactivated table, the ALT program enforces the cooldown.
    #[account(mut)]
    pub lut: UncheckedAccount<'info>,
    /// CHECK: Switchboard On-Demand program for this cluster.
    #[account(address = randomness::SB_PROGRAM_ID @ ArenaError::Randomness)]
    pub switchboard_program: UncheckedAccount<'info>,
    /// CHECK: Address Lookup Table program.
    #[account(address = randomness::ADDRESS_LOOKUP_TABLE_PROGRAM_ID)]
    pub address_lookup_table_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Reclaim the lookup table of a finished battle (backlog #23). Safe to call repeatedly: a table that
/// is closed already, or still inside its cooldown, fails inside Switchboard/the ALT program and
/// costs the caller only the fee.
pub fn close_battle_randomness_lut(
    ctx: Context<CloseBattleRandomnessLut>,
    nonce: u64,
    lut_slot: u64,
) -> Result<()> {
    let challenger = ctx.accounts.challenger.key();
    let nonce_le = nonce.to_le_bytes();
    let rng_seeds: &[&[u8]] = &[
        randomness::RNG_SEED,
        &[randomness::RNG_KIND_BATTLE],
        challenger.as_ref(),
        &nonce_le,
        &[ctx.bumps.randomness],
    ];
    let a = randomness::SbCloseLutAccounts {
        randomness: ctx.accounts.randomness.to_account_info(),
        lut: ctx.accounts.lut.to_account_info(),
        lut_signer: ctx.accounts.lut_signer.to_account_info(),
        recipient: ctx.accounts.challenger.to_account_info(),
        address_lookup_table_program: ctx.accounts.address_lookup_table_program.to_account_info(),
    };
    randomness::close_lut_owned(
        &ctx.accounts.switchboard_program.to_account_info(),
        &a,
        lut_slot,
        &[rng_seeds],
    )
}

#[derive(Accounts)]
pub struct AcceptBattle<'info> {
    #[account(mut)]
    pub opponent: Signer<'info>,
    #[account(seeds = [b"arena_config"], bump = config.bump, constraint = !config.paused @ ArenaError::Paused)]
    pub config: Account<'info, ArenaConfig>,
    #[account(mut, seeds = [b"battle", battle.challenger.as_ref(), &battle.nonce.to_le_bytes()], bump = battle.bump, constraint = battle.status == BattleStatus::Open @ ArenaError::BadStatus)]
    pub battle: Account<'info, WagerBattle>,
    #[account(mut, token::mint = config.cg_mint, token::authority = opponent)]
    pub opponent_cg: Account<'info, TokenAccount>,
    #[account(mut, associated_token::mint = config.cg_mint, associated_token::authority = battle)]
    pub escrow: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    // remaining_accounts: [asset_i, chip_state_i] × 3
}

#[rustfmt::skip]
#[derive(Accounts)]
pub struct AcceptBattleV2<'info> {
    #[account(mut)]
    pub opponent: Signer<'info>,
    #[account(seeds = [b"arena_config"], bump = config.bump, constraint = !config.paused @ ArenaError::Paused)]
    pub config: Account<'info, ArenaConfig>,
    #[account(mut, seeds = [b"battle", battle.challenger.as_ref(), &battle.nonce.to_le_bytes()], bump = battle.bump, constraint = battle.status == BattleStatus::Open @ ArenaError::BadStatus)]
    pub battle: Account<'info, WagerBattle>,
    #[account(mut, token::mint = config.cg_mint, token::authority = opponent)]
    pub opponent_cg: Account<'info, TokenAccount>,
    #[account(mut, associated_token::mint = config.cg_mint, associated_token::authority = battle)]
    pub escrow: Account<'info, TokenAccount>,
    /// CHECK: fixed MPL Account Compression program used by every proof.
    #[account(address = MPL_ACCOUNT_COMPRESSION_ID)]
    pub compression_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[rustfmt::skip]
// sentio-ignore-fn SW023
pub fn accept_battle_v2_handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, AcceptBattleV2<'info>>,
    delegates: [Pubkey; SQUAD],
    proofs: [LeafProofArgs; SQUAD],
    proof_depths: [u8; SQUAD],
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let b = &ctx.accounts.battle;
    require!(b.challenger != ctx.accounts.opponent.key(), ArenaError::SelfBattle);
    require!(now <= b.created_at + ACCEPT_TIMEOUT, ArenaError::BadStatus);
    let (squad, power) = validate_compressed_squad_v2(
        ctx.remaining_accounts,
        &ctx.accounts.compression_program.to_account_info(),
        &ctx.accounts.opponent.key(),
        &delegates,
        &proofs,
        &proof_depths,
    )?;
    require!(league(power) == league(b.power_a), ArenaError::LeagueMismatch);
    let wager = b.wager;
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token::Transfer {
                from: ctx.accounts.opponent_cg.to_account_info(),
                to: ctx.accounts.escrow.to_account_info(),
                authority: ctx.accounts.opponent.to_account_info(),
            },
        ),
        wager,
    )?;
    let b = &mut ctx.accounts.battle;
    b.opponent = ctx.accounts.opponent.key();
    b.squad_b = squad;
    b.power_b = power;
    b.status = BattleStatus::Accepted;
    b.accepted_at = now;
    emit!(BattleAccepted { battle: b.key(), opponent: b.opponent, power_b: power });
    Ok(())
}

// sentio-ignore-fn SW023
pub fn accept_battle_handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, AcceptBattle<'info>>,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let b = &ctx.accounts.battle;
    require!(
        b.challenger != ctx.accounts.opponent.key(),
        ArenaError::SelfBattle
    );
    require!(now <= b.created_at + ACCEPT_TIMEOUT, ArenaError::BadStatus);
    let (squad, power) = validate_squad(ctx.remaining_accounts, &ctx.accounts.opponent.key(), now)?;
    require!(
        league(power) == league(b.power_a),
        ArenaError::LeagueMismatch
    );
    let wager = b.wager;
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token::Transfer {
                from: ctx.accounts.opponent_cg.to_account_info(),
                to: ctx.accounts.escrow.to_account_info(),
                authority: ctx.accounts.opponent.to_account_info(),
            },
        ),
        wager,
    )?;
    let b = &mut ctx.accounts.battle;
    b.opponent = ctx.accounts.opponent.key();
    b.squad_b = squad;
    b.power_b = power;
    b.status = BattleStatus::Accepted;
    b.accepted_at = now;
    emit!(BattleAccepted {
        battle: b.key(),
        opponent: b.opponent,
        power_b: power
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(winner: Pubkey, result_hash: [u8; 32])]
pub struct ResolveBattle<'info> {
    pub battle_oracle: Signer<'info>,
    #[account(mut, seeds = [b"arena_config"], bump = config.bump, constraint = config.battle_oracle == battle_oracle.key() @ ArenaError::Unauthorized)]
    pub config: Account<'info, ArenaConfig>,
    #[account(mut, seeds = [b"battle", battle.challenger.as_ref(), &battle.nonce.to_le_bytes()], bump = battle.bump, constraint = battle.status == BattleStatus::Accepted @ ArenaError::BadStatus)]
    pub battle: Account<'info, WagerBattle>,
    /// CHECK: pinned
    #[account(address = battle.randomness)]
    pub randomness: UncheckedAccount<'info>,
    #[account(mut, address = config.cg_mint)]
    pub cg_mint: Account<'info, Mint>,
    #[account(mut, associated_token::mint = config.cg_mint, associated_token::authority = battle)]
    pub escrow: Account<'info, TokenAccount>,
    /// winner's ATA — must be owned by `winner`
    #[account(mut, token::mint = config.cg_mint, constraint = winner_cg.owner == winner @ ArenaError::BadWinner)]
    pub winner_cg: Account<'info, TokenAccount>,
    #[account(mut, address = config.season_pool)]
    pub season_pool: Account<'info, TokenAccount>,
    #[account(mut, address = config.treasury_cg)]
    pub treasury_cg: Account<'info, TokenAccount>,
    /// CHECK: the battle challenger — receives the escrow ATA rent back on close (SEC-F07):
    /// renting to the oracle made the crank profit from resolving over cancelling, and the
    /// player had paid for that account in the first place. Pinned to battle.challenger.
    #[account(mut, address = battle.challenger)]
    pub challenger: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn resolve_battle_handler(
    ctx: Context<ResolveBattle>,
    winner: Pubkey,
    result_hash: [u8; 32],
) -> Result<()> {
    let clock = Clock::get()?;
    let b = &ctx.accounts.battle;
    require!(
        winner == b.challenger || winner == b.opponent,
        ArenaError::BadWinner
    );
    require_keys_eq!(ctx.accounts.winner_cg.owner, winner, ArenaError::BadWinner);
    // the VRF value must exist so the server-side seed is auditable; the program does not
    // re-simulate the battle (that's the documented server-authoritative boundary)
    let rnd = randomness::parse_checked(&ctx.accounts.randomness)
        .map_err(|_| error!(ArenaError::Randomness))?;
    let roll = randomness::revealed_value(&rnd, b.commit_slot)
        .map_err(|_| error!(ArenaError::Randomness))?;

    let pot = b.wager.checked_mul(2).ok_or(ArenaError::Overflow)?;
    let rake = pot * RAKE_BPS / 10_000;
    let rake_treasury = rake * RAKE_TREASURY_BPS / 10_000;
    let rake_pool = rake * RAKE_POOL_BPS / 10_000;
    let rake_burn = rake - rake_treasury - rake_pool; // remainder burned (rounding dust burns too)
    let payout = pot - rake;

    // oracle circuit-breaker
    let c = &mut ctx.accounts.config;
    if clock.unix_timestamp - c.oracle_day_start >= DAY {
        c.oracle_day_start = clock.unix_timestamp;
        c.oracle_paid_today = 0;
    }
    c.oracle_paid_today = c
        .oracle_paid_today
        .checked_add(pot)
        .ok_or(ArenaError::Overflow)?;
    require!(
        c.oracle_paid_today <= c.oracle_daily_cap,
        ArenaError::OracleCap
    );

    let (ch, nonce, bump) = (b.challenger, b.nonce, b.bump);
    let seeds: &[&[u8]] = &[b"battle", ch.as_ref(), &nonce.to_le_bytes(), &[bump]];
    let tp = ctx.accounts.token_program.to_account_info();
    let b_ai = ctx.accounts.battle.to_account_info();
    token::transfer(
        CpiContext::new_with_signer(
            tp.clone(),
            token::Transfer {
                from: ctx.accounts.escrow.to_account_info(),
                to: ctx.accounts.winner_cg.to_account_info(),
                authority: b_ai.clone(),
            },
            &[seeds],
        ),
        payout,
    )?;
    token::transfer(
        CpiContext::new_with_signer(
            tp.clone(),
            token::Transfer {
                from: ctx.accounts.escrow.to_account_info(),
                to: ctx.accounts.season_pool.to_account_info(),
                authority: b_ai.clone(),
            },
            &[seeds],
        ),
        rake_pool,
    )?;
    token::transfer(
        CpiContext::new_with_signer(
            tp.clone(),
            token::Transfer {
                from: ctx.accounts.escrow.to_account_info(),
                to: ctx.accounts.treasury_cg.to_account_info(),
                authority: b_ai.clone(),
            },
            &[seeds],
        ),
        rake_treasury,
    )?;
    token::burn(
        CpiContext::new_with_signer(
            tp.clone(),
            token::Burn {
                mint: ctx.accounts.cg_mint.to_account_info(),
                from: ctx.accounts.escrow.to_account_info(),
                authority: b_ai.clone(),
            },
            &[seeds],
        ),
        rake_burn,
    )?;
    token::close_account(CpiContext::new_with_signer(
        tp,
        token::CloseAccount {
            account: ctx.accounts.escrow.to_account_info(),
            destination: ctx.accounts.challenger.to_account_info(),
            authority: b_ai,
        },
        &[seeds],
    ))?;

    let b = &mut ctx.accounts.battle;
    b.status = BattleStatus::Resolved;
    b.winner = winner;
    b.result_hash = result_hash;
    emit!(BattleResolved {
        battle: b.key(),
        winner,
        pot,
        rake_burn,
        rake_pool,
        rake_treasury,
        result_hash,
        roll
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CancelStaleBattle<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(seeds = [b"arena_config"], bump = config.bump)]
    pub config: Account<'info, ArenaConfig>,
    #[account(mut, seeds = [b"battle", battle.challenger.as_ref(), &battle.nonce.to_le_bytes()], bump = battle.bump)]
    pub battle: Account<'info, WagerBattle>,
    #[account(mut, associated_token::mint = config.cg_mint, associated_token::authority = battle)]
    pub escrow: Account<'info, TokenAccount>,
    // The caller may be either side of an accepted battle, so the destination
    // cannot be left as "any CG token account": otherwise the opponent could
    // redirect the challenger's refund to an account they control.
    #[account(mut, token::mint = config.cg_mint, token::authority = battle.challenger)]
    pub challenger_cg: Account<'info, TokenAccount>,
    /// only required when status == Accepted
    #[account(mut, token::mint = config.cg_mint)]
    pub opponent_cg: Option<Account<'info, TokenAccount>>,
    /// CHECK: rent destination = challenger
    #[account(mut, address = battle.challenger)]
    pub challenger: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn cancel_stale_battle_handler(ctx: Context<CancelStaleBattle>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let b = &ctx.accounts.battle;
    let caller = ctx.accounts.caller.key();
    require!(
        caller == b.challenger || caller == b.opponent,
        ArenaError::Unauthorized
    );
    let (ref_a, ref_b) = match b.status {
        BattleStatus::Open => {
            require!(
                now > b.created_at + ACCEPT_TIMEOUT || caller == b.challenger,
                ArenaError::NotStale
            );
            (b.wager, 0)
        }
        BattleStatus::Accepted => {
            require!(now > b.accepted_at + RESOLVE_TIMEOUT, ArenaError::NotStale);
            (b.wager, b.wager)
        }
        _ => return err!(ArenaError::BadStatus),
    };
    let (ch, nonce, bump) = (b.challenger, b.nonce, b.bump);
    let seeds: &[&[u8]] = &[b"battle", ch.as_ref(), &nonce.to_le_bytes(), &[bump]];
    let tp = ctx.accounts.token_program.to_account_info();
    let b_ai = ctx.accounts.battle.to_account_info();
    token::transfer(
        CpiContext::new_with_signer(
            tp.clone(),
            token::Transfer {
                from: ctx.accounts.escrow.to_account_info(),
                to: ctx.accounts.challenger_cg.to_account_info(),
                authority: b_ai.clone(),
            },
            &[seeds],
        ),
        ref_a,
    )?;
    if ref_b > 0 {
        let o = ctx
            .accounts
            .opponent_cg
            .as_ref()
            .ok_or(ArenaError::BadStatus)?;
        require_keys_eq!(o.owner, b.opponent, ArenaError::Unauthorized);
        token::transfer(
            CpiContext::new_with_signer(
                tp.clone(),
                token::Transfer {
                    from: ctx.accounts.escrow.to_account_info(),
                    to: o.to_account_info(),
                    authority: b_ai.clone(),
                },
                &[seeds],
            ),
            ref_b,
        )?;
    }
    token::close_account(CpiContext::new_with_signer(
        tp,
        token::CloseAccount {
            account: ctx.accounts.escrow.to_account_info(),
            destination: ctx.accounts.challenger.to_account_info(),
            authority: b_ai,
        },
        &[seeds],
    ))?;
    let b = &mut ctx.accounts.battle;
    b.status = BattleStatus::Cancelled;
    emit!(BattleCancelled {
        battle: b.key(),
        refunded_a: ref_a,
        refunded_b: ref_b
    });
    Ok(())
}

// ---------------------------------------------------------------------------

#[program]
pub mod arena {
    use super::*;
    pub fn init_arena(
        ctx: Context<InitArena>,
        battle_oracle: Pubkey,
        cg_mint: Pubkey,
        season_pool: Pubkey,
        treasury_cg: Pubkey,
        oracle_daily_cap: u64,
    ) -> Result<()> {
        init_arena_handler(
            ctx,
            battle_oracle,
            cg_mint,
            season_pool,
            treasury_cg,
            oracle_daily_cap,
        )
    }
    pub fn set_arena(
        ctx: Context<ArenaAdmin>,
        battle_oracle: Option<Pubkey>,
        oracle_daily_cap: Option<u64>,
        paused: Option<bool>,
        treasury_cg: Option<Pubkey>,
    ) -> Result<()> {
        set_arena_handler(ctx, battle_oracle, oracle_daily_cap, paused, treasury_cg)
    }
    pub fn set_pauser(ctx: Context<ArenaAdmin>, pauser: Pubkey) -> Result<()> {
        set_pauser_handler(ctx, pauser)
    }
    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        pause_handler(ctx)
    }
    pub fn init_battle_randomness(
        ctx: Context<InitBattleRandomness>,
        nonce: u64,
        recent_slot: u64,
    ) -> Result<()> {
        init_battle_randomness_handler(ctx, nonce, recent_slot)
    }
    pub fn reveal_battle_randomness(
        ctx: Context<RevealBattleRandomness>,
        signature: [u8; 64],
        recovery_id: u8,
        value: [u8; 32],
    ) -> Result<()> {
        reveal_battle_randomness_handler(ctx, signature, recovery_id, value)
    }
    pub fn close_battle_randomness(ctx: Context<CloseBattleRandomness>, nonce: u64) -> Result<()> {
        close_battle_randomness_handler(ctx, nonce)
    }

    /// Permissionless, after the battle's randomness is closed and the ALT cooldown has passed:
    /// the lookup table's rent (~0.0015 SOL/battle, backlog #23) → challenger, never the caller.
    pub fn close_battle_randomness_lut(
        ctx: Context<CloseBattleRandomnessLut>,
        nonce: u64,
        lut_slot: u64,
    ) -> Result<()> {
        close_battle_randomness_lut(ctx, nonce, lut_slot)
    }
    pub fn create_battle<'info>(
        ctx: Context<'_, '_, 'info, 'info, CreateBattle<'info>>,
        nonce: u64,
        wager: u64,
    ) -> Result<()> {
        create_battle_handler(ctx, nonce, wager)
    }
    pub fn accept_battle<'info>(
        ctx: Context<'_, '_, 'info, 'info, AcceptBattle<'info>>,
    ) -> Result<()> {
        accept_battle_handler(ctx)
    }
    pub fn create_battle_v2<'info>(
        ctx: Context<'_, '_, 'info, 'info, CreateBattleV2<'info>>,
        nonce: u64,
        wager: u64,
        delegates: [Pubkey; SQUAD],
        proofs: [LeafProofArgs; SQUAD],
        proof_depths: [u8; SQUAD],
    ) -> Result<()> {
        create_battle_v2_handler(ctx, nonce, wager, delegates, proofs, proof_depths)
    }
    pub fn accept_battle_v2<'info>(
        ctx: Context<'_, '_, 'info, 'info, AcceptBattleV2<'info>>,
        delegates: [Pubkey; SQUAD],
        proofs: [LeafProofArgs; SQUAD],
        proof_depths: [u8; SQUAD],
    ) -> Result<()> {
        accept_battle_v2_handler(ctx, delegates, proofs, proof_depths)
    }
    pub fn resolve_battle(
        ctx: Context<ResolveBattle>,
        winner: Pubkey,
        result_hash: [u8; 32],
    ) -> Result<()> {
        resolve_battle_handler(ctx, winner, result_hash)
    }
    pub fn cancel_stale_battle(ctx: Context<CancelStaleBattle>) -> Result<()> {
        cancel_stale_battle_handler(ctx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rake_split_exact() {
        let pot = 2 * 1_000 * MICRO;
        let rake = pot * RAKE_BPS / 10_000;
        assert_eq!(rake, 100 * MICRO);
        let tr = rake * RAKE_TREASURY_BPS / 10_000;
        let pool = rake * RAKE_POOL_BPS / 10_000;
        assert_eq!(
            (tr, pool, rake - tr - pool),
            (40 * MICRO, 20 * MICRO, 40 * MICRO)
        );
        assert_eq!(pot - rake, 1_900 * MICRO);
    }
    #[test]
    fn leagues() {
        assert_eq!(league(799), 0);
        assert_eq!(league(800), 1);
        assert_eq!(league(2399), 2);
        assert_eq!(league(7000), 5);
    }
}
