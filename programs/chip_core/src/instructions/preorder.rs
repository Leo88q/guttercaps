//! Beta pre-sale ("preorder") delivery.
//!
//! Money and chips are deliberately decoupled in time: while the game runs its
//! devnet beta, buyers pay for a limited pack drop **off-chain** (SOL to the
//! team's multisig treasury, memo `GC-PRE|<ref>`), and the liability is tracked
//! by the backend registry (`backend/src/preorders.ts`). Once mainnet is funded
//! and deployed, the admin converts every paid preorder into a real pack with
//! [`grant_preorder_pack`] — the buyer signs nothing and pays nothing on-chain:
//! the admin fronts the pending rent, the rent reserve and the Switchboard
//! request, all of which flow back when the pack settles (or on
//! `cancel_stale_pack`).
//!
//! On-chain guardrails (the registry is convenience; the program is the gate):
//!  * [`PreorderDrop`] (`["drop", sku]`) — one drop per SKU, opened by the
//!    admin with a hard `total`; every grant increments `granted`, so the
//!    program itself refuses the `total + 1`-th pack.
//!  * [`PreorderGrant`] (`["pregrant", drop, beneficiary]`) — per-wallet count,
//!    capped by `max_per_wallet` (0 = uncapped), and the audit trail of who got
//!    what.
//!  * The granted pack is a *normal* `PendingPack` (`voucher = false`,
//!    `paid_* = 0`): it opens through the exact compressed pipeline a purchase
//!    uses, so the roll is Switchboard-committed (provably fair, `PackGranted`
//!    carries the randomness account) and every settlement invariant
//!    (liability ledger, pro-rata refunds, stale-cancel) applies with a zero
//!    payment.
//!  * `preorder_ref` is the backend registry id, emitted in [`PackGranted`] so
//!    the indexer can join the on-chain grant to the off-chain payment
//!    (payment tx memo ↔ registry row ↔ on-chain pending).

use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::economy::*;
use crate::errors::ChipError;
use crate::randomness;
use crate::state::*;

use super::packs::RENT_RESERVE_PER_CHIP;

// ---------------------------------------------------------------------------
// init_preorder_drop — admin opens the limited drop for one SKU.
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(sku: u8)]
pub struct InitPreorderDrop<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump, has_one = admin @ ChipError::Unauthorized)]
    pub config: Box<Account<'info, GameConfig>>,

    #[account(
        init, payer = admin, space = 8 + PreorderDrop::INIT_SPACE,
        seeds = [b"drop".as_ref(), &[sku]], bump
    )]
    pub drop: Box<Account<'info, PreorderDrop>>,

    pub system_program: Program<'info, System>,
}

pub fn init_preorder_drop(
    ctx: Context<InitPreorderDrop>,
    sku: u8,
    total: u32,
    max_per_wallet: u8,
) -> Result<()> {
    require!(PackSku::from_u8(sku).is_some(), ChipError::InvalidSku);
    require!(total > 0, ChipError::InvalidQuantity);

    let drop = &mut ctx.accounts.drop;
    drop.admin = ctx.accounts.admin.key();
    drop.sku = sku;
    drop.bump = ctx.bumps.drop;
    drop.max_per_wallet = max_per_wallet;
    drop.total = total;
    drop.granted = 0;
    drop.opened_at = Clock::get()?.unix_timestamp;
    drop.closed = false;

    emit!(PreorderDropOpened {
        admin: ctx.accounts.admin.key(),
        drop: drop.key(),
        sku,
        total,
        max_per_wallet,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// grant_preorder_pack — admin converts one paid preorder into a pack owned by
// the beneficiary. Same randomness-commit shape as `buy_pack` / `open_voucher`;
// no payment leg (money moved off-chain to the multisig treasury).
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(qty: u8, nonce: u64)]
pub struct GrantPreorderPack<'info> {
    /// GameConfig admin: signs and fronts the pending rent, the rent reserve and the
    /// Switchboard request — all of which flow back when the pack settles or is cancelled.
    #[account(mut)]
    pub admin: Signer<'info>,

    /// CHECK: preorder beneficiary — the wallet the pack is granted to. Neither signs nor
    /// pays; only its key is read (pending / pity / pregrant seeds).
    pub beneficiary: UncheckedAccount<'info>,

    #[account(
        seeds = [b"config"], bump = config.bump,
        constraint = !config.paused @ ChipError::Paused,
        has_one = admin @ ChipError::Unauthorized
    )]
    pub config: Box<Account<'info, GameConfig>>,

    #[account(
        mut,
        seeds = [b"drop", &[drop.sku]], bump = drop.bump,
        constraint = !drop.closed @ ChipError::PreorderDropClosed
    )]
    pub drop: Box<Account<'info, PreorderDrop>>,

    // Note: PDA cannot be closed; Anchor discriminator prevents re-init
    // sentio-ignore-next-line SW016
    #[account(
        init_if_needed, payer = admin, space = 8 + PreorderGrant::INIT_SPACE,
        seeds = [b"pregrant", drop.key().as_ref(), beneficiary.key().as_ref()], bump
    )]
    pub pregrant: Box<Account<'info, PreorderGrant>>,

    // Note: PDA cannot be closed; Anchor discriminator prevents re-init
    // sentio-ignore-next-line SW016
    #[account(
        init_if_needed, payer = admin, space = 8 + PlayerPity::INIT_SPACE,
        seeds = [b"pity", beneficiary.key().as_ref()], bump
    )]
    pub pity: Box<Account<'info, PlayerPity>>,

    #[account(
        init, payer = admin, space = 8 + PendingPack::INIT_SPACE,
        seeds = [b"pending", beneficiary.key().as_ref(), &nonce.to_le_bytes()], bump
    )]
    pub pending: Box<Account<'info, PendingPack>>,

    /// CHECK: program-owned Switchboard randomness account `["rng", 0, beneficiary, nonce]` created
    /// by `init_grant_randomness` in this tx (same kind as a purchase so `close_randomness` reclaims it).
    #[account(
        mut, owner = randomness::SB_PROGRAM_ID @ ChipError::RandomnessMismatch,
        seeds = [randomness::RNG_SEED, &[randomness::RNG_KIND_PACK], beneficiary.key().as_ref(), &nonce.to_le_bytes()], bump,
    )]
    pub randomness: UncheckedAccount<'info>,
    /// CHECK: Switchboard authority of our randomness accounts (signs the commit CPI).
    #[account(seeds = [randomness::RNG_AUTH_SEED], bump)]
    pub rng_auth: UncheckedAccount<'info>,
    /// CHECK: Switchboard On-Demand program for this cluster.
    #[account(address = randomness::SB_PROGRAM_ID @ ChipError::RandomnessMismatch)]
    pub switchboard_program: UncheckedAccount<'info>,
    /// CHECK: pinned oracle queue (`randomness::SB_QUEUE`, verified in `commit_owned`).
    #[account(address = randomness::SB_QUEUE @ ChipError::RandomnessMismatch)]
    pub queue: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: oracle from the queue chosen by the client.
    #[account(mut)]
    pub oracle: UncheckedAccount<'info>,
    /// CHECK: SlotHashes sysvar.
    #[account(address = randomness::SLOT_HASHES_ID)]
    pub recent_slothashes: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn grant_preorder_pack(
    ctx: Context<GrantPreorderPack>,
    qty: u8,
    nonce: u64,
    preorder_ref: u64,
) -> Result<()> {
    require!(
        (1..=MAX_PACK_QTY).contains(&qty),
        ChipError::InvalidQuantity
    );
    let sku = ctx.accounts.drop.sku;
    let def = ctx.accounts.config.packs[sku as usize];
    require!(def.enabled, ChipError::SkuDisabled);

    // --- drop and per-wallet caps: the program, not the registry, is the gate ---
    let granted_after = ctx
        .accounts
        .drop
        .granted
        .checked_add(qty as u32)
        .ok_or(ChipError::Overflow)?;
    require!(
        granted_after <= ctx.accounts.drop.total,
        ChipError::PreorderDropExhausted
    );
    let pregrant = &mut ctx.accounts.pregrant;
    if pregrant.drop == Pubkey::default() {
        pregrant.drop = ctx.accounts.drop.key();
        pregrant.beneficiary = ctx.accounts.beneficiary.key();
        pregrant.bump = ctx.bumps.pregrant;
    }
    require_keys_eq!(
        pregrant.drop,
        ctx.accounts.drop.key(),
        ChipError::Unauthorized
    );
    require_keys_eq!(
        pregrant.beneficiary,
        ctx.accounts.beneficiary.key(),
        ChipError::Unauthorized
    );
    let count_after = pregrant
        .count
        .checked_add(qty as u32)
        .ok_or(ChipError::Overflow)?;
    if ctx.accounts.drop.max_per_wallet > 0 {
        require!(
            count_after <= ctx.accounts.drop.max_per_wallet as u32,
            ChipError::PreorderWalletCap
        );
    }

    let clock = Clock::get()?;

    // commit the program-owned randomness account by CPI — identical to buy_pack (SEC-C3 part 2),
    // so a granted pack opens provably fair exactly like a purchased one
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
    )?;

    // pity must exist for the open path (it reads `counters[sku]`); grants are admin-batched and
    // the drop's own caps are the limit here, so the per-day purchase cap is deliberately not
    // charged — a launch-day batch for one wallet must not fail on `daily_cap`.
    let pity = &mut ctx.accounts.pity;
    if pity.owner == Pubkey::default() {
        pity.owner = ctx.accounts.beneficiary.key();
        pity.bump = ctx.bumps.pity;
    }
    require_keys_eq!(
        pity.owner,
        ctx.accounts.beneficiary.key(),
        ChipError::Unauthorized
    );

    // rent reserve so any cranker can open the granted pack (leftover flows back on settle)
    let rent_reserve = RENT_RESERVE_PER_CHIP
        .checked_mul(def.chips as u64)
        .ok_or(ChipError::Overflow)?
        .checked_mul(qty as u64)
        .ok_or(ChipError::Overflow)?;
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.admin.to_account_info(),
                to: ctx.accounts.pending.to_account_info(),
            },
        ),
        rent_reserve,
    )?;

    let pending = &mut ctx.accounts.pending;
    pending.buyer = ctx.accounts.beneficiary.key();
    pending.sku = sku;
    pending.qty = qty;
    pending.opened = 0;
    pending.randomness = ctx.accounts.randomness.key();
    pending.commit_slot = rnd.seed_slot;
    pending.paid_lamports = 0;
    pending.paid_usdc = 0;
    pending.paid_cg = 0;
    pending.paid_skr = 0;
    pending.pity_snapshot = pity.counters[sku as usize];
    pending.nonce = nonce;
    pending.bump = ctx.bumps.pending;
    pending.revealed = false;
    pending.value = [0u8; 32];
    pending.voucher = false;
    pending.voucher_odds = [0u16; RARITY_COUNT];
    pending.preorder = true; // founder frame: chips minted from this pack carry F_FOUNDER
    pending.soulbound_days = if PackSku::from_u8(sku) == Some(PackSku::Starter) {
        STARTER_SOULBOUND_DAYS
    } else {
        0
    };

    ctx.accounts.drop.granted = granted_after;
    pregrant.count = count_after;

    emit!(PackGranted {
        admin: ctx.accounts.admin.key(),
        beneficiary: pending.buyer,
        sku,
        qty,
        nonce,
        preorder_ref,
        randomness: pending.randomness,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// close_preorder_drop — once every pack of the drop is granted, reclaim the
// drop account's rent. Refusing until `granted == total` keeps the on-chain
// accounting final: a closed drop can never hide an undelivered remainder.
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct ClosePreorderDrop<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump, has_one = admin @ ChipError::Unauthorized)]
    pub config: Box<Account<'info, GameConfig>>,

    #[account(
        mut,
        close = admin,
        seeds = [b"drop", &[drop.sku]], bump = drop.bump,
        has_one = admin @ ChipError::Unauthorized
    )]
    pub drop: Box<Account<'info, PreorderDrop>>,
}

pub fn close_preorder_drop(ctx: Context<ClosePreorderDrop>) -> Result<()> {
    require!(
        ctx.accounts.drop.granted == ctx.accounts.drop.total,
        ChipError::PreorderNotExhausted
    );

    emit!(PreorderDropClosed {
        admin: ctx.accounts.admin.key(),
        drop: ctx.accounts.drop.key(),
        sku: ctx.accounts.drop.sku,
        total: ctx.accounts.drop.total,
    });
    Ok(())
}
