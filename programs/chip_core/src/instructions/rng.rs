//! Program-owned Switchboard randomness accounts (SEC-C3 part 2).
//!
//! * `init_randomness(kind, nonce, recent_slot)` — creates the randomness
//!   account as a PDA `["rng", kind, owner, nonce]` of chip_core with
//!   `authority = ["rng_auth"]` (CPI `randomness_init`; the wallet only pays
//!   rent). The player signs it in the SAME transaction as `buy_pack` / `fuse` /
//!   `fuse_claims_commit`, which perform the CPI `randomness_commit` themselves.
//! * `reveal_randomness(signature, recovery_id, value)` — permissionless CPI
//!   `randomness_reveal` with the PDA signature. The oracle's secp256k1
//!   signature is what Switchboard verifies, so a crank (or the player) just
//!   relays the gateway response; the value is then read by `open_pack` /
//!   `fuse_reveal` through `randomness::revealed_value`.
//! * `close_randomness(kind, nonce)` — permissionless; once the pending
//!   pack/fusion that pinned the account is gone (opened or refunded), CPI
//!   `randomness_close` returns the rent (account + wSOL escrow) to `rng_auth`,
//!   and the instruction forwards every lamport to the player (SEC-M7).
//! * `close_randomness_lut(kind, nonce, lut_slot)` — permissionless, callable once the randomness
//!   account above is gone and the Address Lookup Table has finished its cooldown: CPI
//!   `randomness_close_lut` returns the table's rent (~0.0015 SOL per bundle, backlog #23) straight
//!   to the player. `lut_slot` is not trusted: the instruction derives `["LutSigner", randomness]`
//!   and the ALT address from it and requires both accounts to match, so a caller cannot point the
//!   CPI at somebody else's table, and the payer is pinned as Switchboard's `recipient`.
//!
//! Why PDAs and not a client keypair with `authority = rng_auth`? A keypair
//! account would still let its creator pick *which* account a pending action
//! pins — harmless today, but the PDA makes the binding purchase ↔ randomness
//! structural (one account per `(kind, owner, nonce)`) and lets the crank
//! derive everything from the `PackBought` event without extra lookups.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::Token;

use crate::errors::ChipError;
use crate::randomness::{
    self, ADDRESS_LOOKUP_TABLE_PROGRAM_ID, RNG_AUTH_SEED, RNG_KIND_CLAIM_FUSION, RNG_KIND_FUSION,
    RNG_KIND_PACK, RNG_SEED, SB_PROGRAM_ID, SB_QUEUE, SLOT_HASHES_ID, WSOL_MINT,
};

#[derive(Accounts)]
#[instruction(kind: u8, nonce: u64)]
pub struct InitRandomness<'info> {
    /// Player: pays rent of the randomness account, its wSOL reward escrow and the LUT.
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: PDA `["rng", kind, owner, nonce]` — created by Switchboard via CPI (system-owned & empty before).
    #[account(mut, seeds = [RNG_SEED, &[kind], owner.key().as_ref(), &nonce.to_le_bytes()], bump)]
    pub randomness: UncheckedAccount<'info>,
    /// CHECK: Switchboard authority of every chip_core randomness account.
    #[account(seeds = [RNG_AUTH_SEED], bump)]
    pub rng_auth: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: wSOL ATA of `randomness` (Switchboard creates it; oracle reward escrow).
    #[account(mut)]
    pub reward_escrow: UncheckedAccount<'info>,
    /// CHECK: pinned queue (`randomness::SB_QUEUE`) — verified in the helper.
    #[account(mut, address = SB_QUEUE @ ChipError::RandomnessMismatch)]
    pub queue: UncheckedAccount<'info>,
    /// CHECK: Switchboard `["STATE"]`.
    pub program_state: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: Switchboard `["LutSigner", randomness]`.
    pub lut_signer: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: `AddressLookupTableProgram.createLookupTable({authority: lut_signer, recentSlot})`.
    #[account(mut)]
    pub lut: UncheckedAccount<'info>,
    /// CHECK: Switchboard On-Demand program for this cluster.
    #[account(address = SB_PROGRAM_ID @ ChipError::RandomnessMismatch)]
    pub switchboard_program: UncheckedAccount<'info>,
    /// CHECK: wSOL mint.
    #[account(address = WSOL_MINT)]
    pub wrapped_sol_mint: UncheckedAccount<'info>,
    /// CHECK: Address Lookup Table program.
    #[account(address = ADDRESS_LOOKUP_TABLE_PROGRAM_ID)]
    pub address_lookup_table_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn init_randomness(
    ctx: Context<InitRandomness>,
    kind: u8,
    nonce: u64,
    recent_slot: u64,
) -> Result<()> {
    require!(
        kind == RNG_KIND_PACK || kind == RNG_KIND_FUSION || kind == RNG_KIND_CLAIM_FUSION,
        ChipError::RandomnessMismatch
    );
    let owner = ctx.accounts.owner.key();
    let nonce_le = nonce.to_le_bytes();
    let rng_seeds: &[&[u8]] = &[
        RNG_SEED,
        &[kind],
        owner.as_ref(),
        &nonce_le,
        &[ctx.bumps.randomness],
    ];
    let auth_seeds: &[&[u8]] = &[RNG_AUTH_SEED, &[ctx.bumps.rng_auth]];
    let a = randomness::SbInitAccounts {
        randomness: ctx.accounts.randomness.to_account_info(),
        reward_escrow: ctx.accounts.reward_escrow.to_account_info(),
        authority: ctx.accounts.rng_auth.to_account_info(),
        queue: ctx.accounts.queue.to_account_info(),
        payer: ctx.accounts.owner.to_account_info(),
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
    )?;
    Ok(())
}

#[derive(Accounts)]
pub struct RevealRandomness<'info> {
    /// Permissionless crank (pays the tx fee; Switchboard may top up the oracle escrow from it).
    #[account(mut)]
    pub payer: Signer<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: any chip_core-owned randomness account (authority checked in the helper).
    #[account(mut)]
    pub randomness: UncheckedAccount<'info>,
    /// CHECK: `["rng_auth"]`.
    #[account(seeds = [RNG_AUTH_SEED], bump)]
    pub rng_auth: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: the oracle assigned at commit (`RandomnessAccountData.oracle`); Switchboard verifies the relation.
    pub oracle: UncheckedAccount<'info>,
    /// CHECK: pinned queue.
    #[account(address = SB_QUEUE @ ChipError::RandomnessMismatch)]
    pub queue: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: `["OracleRandomnessStats", oracle]` of the Switchboard program.
    #[account(mut)]
    pub stats: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: wSOL ATA of `randomness`.
    #[account(mut)]
    pub reward_escrow: UncheckedAccount<'info>,
    /// CHECK: Switchboard `["STATE"]`.
    pub program_state: UncheckedAccount<'info>,
    /// CHECK: SlotHashes sysvar.
    #[account(address = SLOT_HASHES_ID)]
    pub recent_slothashes: UncheckedAccount<'info>,
    /// CHECK: Switchboard On-Demand program for this cluster.
    #[account(address = SB_PROGRAM_ID @ ChipError::RandomnessMismatch)]
    pub switchboard_program: UncheckedAccount<'info>,
    /// CHECK: wSOL mint.
    #[account(address = WSOL_MINT)]
    pub wrapped_sol_mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn reveal_randomness(
    ctx: Context<RevealRandomness>,
    signature: [u8; 64],
    recovery_id: u8,
    value: [u8; 32],
) -> Result<()> {
    let auth_seeds: &[&[u8]] = &[RNG_AUTH_SEED, &[ctx.bumps.rng_auth]];
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
    )?;
    Ok(())
}

#[derive(Accounts)]
#[instruction(kind: u8, nonce: u64)]
pub struct CloseRandomness<'info> {
    /// Permissionless (our crank batches these); rent always goes to `owner`.
    #[account(mut)]
    pub payer: Signer<'info>,
    // sentio-ignore-next-line SW002, SW013
    /// CHECK: the player who paid the rent — bound by the randomness PDA seeds.
    #[account(mut)]
    pub owner: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW013
    /// CHECK: `["rng", kind, owner, nonce]` and Switchboard-owned.
    #[account(
        mut,
        owner = SB_PROGRAM_ID @ ChipError::RandomnessMismatch,
        seeds = [RNG_SEED, &[kind], owner.key().as_ref(), &nonce.to_le_bytes()],
        bump,
        seeds::program = crate::ID,
    )]
    pub randomness: UncheckedAccount<'info>,
    /// CHECK: `["rng_auth"]` — receives the rent from Switchboard and forwards it to `owner`.
    #[account(mut, seeds = [RNG_AUTH_SEED], bump)]
    pub rng_auth: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: `["pending", owner, nonce]` (kind 0) / `["fusion", owner, nonce]` (kind 1) /
    /// `["claim_fusion", owner, nonce]` (kind 3) — must be closed.
    pub pending: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: wSOL ATA of `randomness`.
    #[account(mut)]
    pub reward_escrow: UncheckedAccount<'info>,
    /// CHECK: Switchboard `["STATE"]`.
    pub program_state: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: lookup table of this randomness account (`lut_slot` in its data).
    #[account(mut)]
    pub lut: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: Switchboard `["LutSigner", randomness]`.
    pub lut_signer: UncheckedAccount<'info>,
    /// CHECK: Switchboard On-Demand program for this cluster.
    #[account(address = SB_PROGRAM_ID @ ChipError::RandomnessMismatch)]
    pub switchboard_program: UncheckedAccount<'info>,
    /// CHECK: wSOL mint.
    #[account(address = WSOL_MINT)]
    pub wrapped_sol_mint: UncheckedAccount<'info>,
    /// CHECK: Address Lookup Table program.
    #[account(address = ADDRESS_LOOKUP_TABLE_PROGRAM_ID)]
    pub address_lookup_table_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn close_randomness(ctx: Context<CloseRandomness>, kind: u8, nonce: u64) -> Result<()> {
    require!(
        kind == RNG_KIND_PACK || kind == RNG_KIND_FUSION || kind == RNG_KIND_CLAIM_FUSION,
        ChipError::RandomnessMismatch
    );
    // nothing may still pin this account: the pending PDA for (owner, nonce) must be gone
    let owner = ctx.accounts.owner.key();
    let nonce_le = nonce.to_le_bytes();
    let pending_seed: &[u8] = if kind == RNG_KIND_PACK {
        b"pending"
    } else if kind == RNG_KIND_FUSION {
        b"fusion"
    } else {
        b"claim_fusion"
    };
    let (exp_pending, _) =
        Pubkey::find_program_address(&[pending_seed, owner.as_ref(), &nonce_le], ctx.program_id);
    require_keys_eq!(
        exp_pending,
        ctx.accounts.pending.key(),
        ChipError::RandomnessMismatch
    );
    // SEC-F8: "gone" = no data and not owned by this program (a live PendingPack / PendingFusion /
    // PendingClaimFusion is always chip_core-owned with data). Lamports are deliberately NOT checked:
    // anyone can transfer SOL to the closed PDA address, and `lamports() == 0` let that donation pin
    // the owner's Switchboard rent forever. Only chip_core can re-assign its PDA, so a system-owned,
    // empty account at this address can never be a pending purchase / fusion.
    let pending = &ctx.accounts.pending;
    require!(
        pending.data_is_empty() && *pending.owner == system_program::ID,
        ChipError::InvalidChipState
    );

    let auth_seeds: &[&[u8]] = &[RNG_AUTH_SEED, &[ctx.bumps.rng_auth]];
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
    )?;
    if returned > 0 {
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.rng_auth.to_account_info(),
                    to: ctx.accounts.owner.to_account_info(),
                },
                &[auth_seeds],
            ),
            returned,
        )?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// randomness_close_lut (backlog #23) — the lookup table's rent, after cooldown.
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(kind: u8, nonce: u64, lut_slot: u64)]
pub struct CloseRandomnessLut<'info> {
    /// Permissionless (our crank batches these); the table's rent always goes to `owner`.
    #[account(mut)]
    pub payer: Signer<'info>,
    // sentio-ignore-next-line SW013
    /// CHECK: the player who paid the table's rent. It is one of the randomness PDA seeds *and* the
    /// account Switchboard pays (`recipient`), so a relayer cannot redirect the rent to itself.
    #[account(mut)]
    pub owner: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW013
    /// CHECK: `["rng", kind, owner, nonce]` — must already be CLOSED (`randomness_close` deactivates
    /// the table as it closes the account, and the ALT cooldown starts there). `close_lut_owned`
    /// re-checks "gone" = no data + system-owned (SEC-F8). `mut` mirrors the SDK's metas (Switchboard
    /// marks this account writable); the seeds below are what the CPI signs with.
    #[account(
        mut,
        seeds = [RNG_SEED, &[kind], owner.key().as_ref(), &nonce.to_le_bytes()],
        bump,
        seeds::program = crate::ID,
    )]
    pub randomness: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: `["pending", owner, nonce]` (kind 0) / `["fusion", owner, nonce]` (kind 1) /
    /// `["claim_fusion", owner, nonce]` (kind 3) — must be closed (nothing may still pin the request).
    pub pending: UncheckedAccount<'info>,
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
    #[account(address = SB_PROGRAM_ID @ ChipError::RandomnessMismatch)]
    pub switchboard_program: UncheckedAccount<'info>,
    /// CHECK: Address Lookup Table program.
    #[account(address = ADDRESS_LOOKUP_TABLE_PROGRAM_ID)]
    pub address_lookup_table_program: UncheckedAccount<'info>,
}

/// Reclaim the lookup table of a finished request. Safe to call repeatedly: an already-closed table
/// (or one still inside its cooldown) fails inside Switchboard/the ALT program and costs the caller
/// only the fee.
pub fn close_randomness_lut(
    ctx: Context<CloseRandomnessLut>,
    kind: u8,
    nonce: u64,
    lut_slot: u64,
) -> Result<()> {
    require!(
        kind == RNG_KIND_PACK || kind == RNG_KIND_FUSION || kind == RNG_KIND_CLAIM_FUSION,
        ChipError::RandomnessMismatch
    );
    // the same "nothing may still pin this request" rule as `close_randomness`
    let owner = ctx.accounts.owner.key();
    let nonce_le = nonce.to_le_bytes();
    let pending_seed: &[u8] = if kind == RNG_KIND_PACK {
        b"pending"
    } else if kind == RNG_KIND_FUSION {
        b"fusion"
    } else {
        b"claim_fusion"
    };
    let (exp_pending, _) =
        Pubkey::find_program_address(&[pending_seed, owner.as_ref(), &nonce_le], ctx.program_id);
    require_keys_eq!(
        exp_pending,
        ctx.accounts.pending.key(),
        ChipError::RandomnessMismatch
    );
    let pending = &ctx.accounts.pending;
    require!(
        pending.data_is_empty() && *pending.owner == system_program::ID,
        ChipError::InvalidChipState
    );

    let rng_seeds: &[&[u8]] = &[
        RNG_SEED,
        &[kind],
        owner.as_ref(),
        &nonce_le,
        &[ctx.bumps.randomness],
    ];
    let a = randomness::SbCloseLutAccounts {
        randomness: ctx.accounts.randomness.to_account_info(),
        lut: ctx.accounts.lut.to_account_info(),
        lut_signer: ctx.accounts.lut_signer.to_account_info(),
        recipient: ctx.accounts.owner.to_account_info(),
        address_lookup_table_program: ctx.accounts.address_lookup_table_program.to_account_info(),
    };
    randomness::close_lut_owned(
        &ctx.accounts.switchboard_program.to_account_info(),
        &a,
        lut_slot,
        &[rng_seeds],
    )
}
