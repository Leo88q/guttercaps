//! SKR (Seeker) prize pool — the second reward currency.
//!
//! SKR's mint authority belongs to Solana Mobile, so the game can neither mint
//! nor burn it. Rewards in SKR are therefore paid from a **treasury-funded
//! pool** (`SkrPool`, `["skr_pool"]`) that the multisig tops up from SKR
//! revenue (packs −5 %, listings, services) — a fixed share decided in
//! `packages/economy/src/skrRewards.ts`. Distribution reuses the Merkle-root
//! machinery of `emission.rs` with dedicated root kinds 5..7:
//!
//!   5 = SKR quests   (quest_oracle)
//!   6 = SKR season   (season_oracle)
//!   7 = SKR events   (season_oracle)
//!
//! Invariants:
//!  * `vault.amount ≥ pool.budget + pool.reserved` at all times — funding only
//!    credits `budget`; `publish_skr_root` moves `budget → reserved`;
//!    `claim_skr_root` pays strictly out of `reserved`; `revoke_skr_root`
//!    returns the unclaimed remainder to `budget`.
//!  * an SKR root can never touch the $CG mint path (`claim_root` rejects
//!    kinds ≥ SPLIT_COUNT) and a $CG root can never touch the SKR vault
//!    (`claim_skr_root` rejects kinds < SKR_ROOT_KIND_BASE).
//!  * per-root ceiling `max_root_budget` + the shared 1 h `ROOT_TIMELOCK`
//!    bound the damage of a leaked oracle key to one revocable root.
//!  * the pool is a treasury liability, not supply: `withdraw_skr` lets the
//!    multisig pull only the unreserved `budget`, never SKR promised to a
//!    published root.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount};

use crate::errors::StakeError;
use crate::instructions::emission::verify_proof;
use crate::state::*;

// ---------------------------------------------------------------------------
// init_skr_pool — admin, once
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitSkrPool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"emission"], bump = emission.bump, has_one = admin @ StakeError::Unauthorized)]
    pub emission: Box<Account<'info, EmissionState>>,
    #[account(init, payer = admin, space = 8 + SkrPool::INIT_SPACE, seeds = [b"skr_pool"], bump)]
    pub pool: Box<Account<'info, SkrPool>>,
    #[account(mint::decimals = SKR_DECIMALS)]
    pub skr_mint: Account<'info, Mint>,
    /// Pool vault: a token account whose authority is the pool PDA (an ATA of the
    /// pool works; created by the admin in the same tx).
    #[account(token::mint = skr_mint, token::authority = pool)]
    pub vault: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
}

pub fn init_skr_pool(ctx: Context<InitSkrPool>, max_root_budget: u64) -> Result<()> {
    let p = &mut ctx.accounts.pool;
    p.skr_mint = ctx.accounts.skr_mint.key();
    p.vault = ctx.accounts.vault.key();
    p.budget = 0;
    p.reserved = 0;
    p.funded_total = 0;
    p.paid_total = 0;
    p.max_root_budget = if max_root_budget == 0 {
        DEFAULT_MAX_SKR_ROOT_BUDGET
    } else {
        max_root_budget
    };
    p.paused = false;
    p.bump = ctx.bumps.pool;
    emit!(SkrPoolChanged {
        max_root_budget: p.max_root_budget,
        paused: false
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// fund_skr — anyone (treasury multisig in practice) moves SKR into the vault
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct FundSkr<'info> {
    pub funder: Signer<'info>,
    #[account(mut, seeds = [b"skr_pool"], bump = pool.bump)]
    pub pool: Box<Account<'info, SkrPool>>,
    #[account(mut, token::mint = pool.skr_mint, token::authority = funder)]
    pub funder_skr: Account<'info, TokenAccount>,
    #[account(mut, address = pool.vault)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn fund_skr(ctx: Context<FundSkr>, amount: u64) -> Result<()> {
    require!(amount > 0, StakeError::ZeroAmount);
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token::Transfer {
                from: ctx.accounts.funder_skr.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.funder.to_account_info(),
            },
        ),
        amount,
    )?;
    let p = &mut ctx.accounts.pool;
    p.budget = p.budget.checked_add(amount).ok_or(StakeError::Overflow)?;
    p.funded_total = p
        .funded_total
        .checked_add(amount)
        .ok_or(StakeError::Overflow)?;
    emit!(SkrFunded {
        funder: ctx.accounts.funder.key(),
        amount,
        budget: p.budget,
        reserved: p.reserved
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// sync_skr_pool — permissionless: absorb SKR sent straight to the vault
// (airdrops, direct treasury transfers) into `budget`.
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct SyncSkrPool<'info> {
    #[account(mut, seeds = [b"skr_pool"], bump = pool.bump)]
    pub pool: Box<Account<'info, SkrPool>>,
    #[account(address = pool.vault)]
    pub vault: Account<'info, TokenAccount>,
}

pub fn sync_skr_pool(ctx: Context<SyncSkrPool>) -> Result<()> {
    let p = &mut ctx.accounts.pool;
    let accounted = p
        .budget
        .checked_add(p.reserved)
        .ok_or(StakeError::Overflow)?;
    let extra = ctx.accounts.vault.amount.saturating_sub(accounted);
    if extra > 0 {
        p.budget += extra;
        p.funded_total = p
            .funded_total
            .checked_add(extra)
            .ok_or(StakeError::Overflow)?;
        emit!(SkrFunded {
            funder: Pubkey::default(),
            amount: extra,
            budget: p.budget,
            reserved: p.reserved
        });
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// admin: withdraw unreserved budget / tune the per-root cap / pause
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct WithdrawSkr<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [b"emission"], bump = emission.bump, has_one = admin @ StakeError::Unauthorized)]
    pub emission: Box<Account<'info, EmissionState>>,
    #[account(mut, seeds = [b"skr_pool"], bump = pool.bump)]
    pub pool: Box<Account<'info, SkrPool>>,
    #[account(mut, address = pool.vault)]
    pub vault: Account<'info, TokenAccount>,
    /// Destination is deliberately *not* pinned to `admin` (Watchtower SW010): the instruction is
    /// admin-only (`has_one = admin`, a Squads vault) and the money goes to the treasury vault's ATA
    /// (localnet S18) — forcing `to.owner == admin` would only add a hop through the multisig's own
    /// ATA without removing any capability an admin key already has. Mint is pinned; amount ≤ `budget`.
    // sentio-ignore-next-line SW013
    #[account(mut, token::mint = pool.skr_mint)]
    pub to: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// Only the unreserved `budget` can leave — SKR promised to a live root stays.
pub fn withdraw_skr(ctx: Context<WithdrawSkr>, amount: u64) -> Result<()> {
    require!(amount > 0, StakeError::ZeroAmount);
    let p = &mut ctx.accounts.pool;
    require!(amount <= p.budget, StakeError::SkrBudgetExceeded);
    // SEC-A6 (2026-10-02): the destination is deliberately not pinned (SW010), so a leaked admin key
    // can move the whole unreserved budget in one transaction. Capping a single call at 10 % of the
    // budget bounds the loss per tx and turns a silent one-tx drain into ≥ 10 visible transactions.
    // Pinning `to` to a config treasury ATA is the real fix and needs a `SkrPool` layout migration
    // (`state:layout -- --write`) — tracked as the follow-up to this cap in AUDIT-2026-10-02.md.
    let per_call_cap = (p.budget / 10).max(1);
    require!(amount <= per_call_cap, StakeError::SkrBudgetExceeded);
    p.budget -= amount;
    let seeds: &[&[u8]] = &[b"skr_pool", &[p.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            token::Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.to.to_account_info(),
                authority: p.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;
    emit!(SkrWithdrawn {
        to: ctx.accounts.to.key(),
        amount,
        budget: p.budget
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SkrPoolAdmin<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [b"emission"], bump = emission.bump, has_one = admin @ StakeError::Unauthorized)]
    pub emission: Box<Account<'info, EmissionState>>,
    #[account(mut, seeds = [b"skr_pool"], bump = pool.bump)]
    pub pool: Box<Account<'info, SkrPool>>,
}

pub fn set_skr_pool(
    ctx: Context<SkrPoolAdmin>,
    max_root_budget: Option<u64>,
    paused: Option<bool>,
) -> Result<()> {
    let p = &mut ctx.accounts.pool;
    if let Some(m) = max_root_budget {
        require!(m > 0, StakeError::ZeroAmount);
        p.max_root_budget = m;
    }
    if let Some(x) = paused {
        p.paused = x;
    }
    emit!(SkrPoolChanged {
        max_root_budget: p.max_root_budget,
        paused: p.paused
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Merkle roots paid in SKR (kinds 5..7). Same leaf format as $CG roots — the
// kind byte inside the leaf keeps proofs from being replayed across currencies.
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(kind: u8, epoch: u32)]
pub struct PublishSkrRoot<'info> {
    #[account(mut)]
    pub oracle: Signer<'info>,
    #[account(seeds = [b"emission"], bump = emission.bump, constraint = !emission.paused @ StakeError::Paused)]
    pub emission: Box<Account<'info, EmissionState>>,
    #[account(mut, seeds = [b"skr_pool"], bump = pool.bump, constraint = !pool.paused @ StakeError::SkrPoolPaused)]
    pub pool: Box<Account<'info, SkrPool>>,
    #[account(init, payer = oracle, space = 8 + RewardRoot::INIT_SPACE, seeds = [b"root".as_ref(), &[kind][..], &epoch.to_le_bytes()[..]], bump)]
    pub root: Box<Account<'info, RewardRoot>>,
    pub system_program: Program<'info, System>,
}

pub fn publish_skr_root(
    ctx: Context<PublishSkrRoot>,
    kind: u8,
    epoch: u32,
    root: [u8; 32],
    budget: u64,
) -> Result<()> {
    let e = &ctx.accounts.emission;
    let o = ctx.accounts.oracle.key();
    let season = SkrPool::uses_season_oracle(kind).ok_or(StakeError::WrongRootCurrency)?;
    require!(
        if season {
            o == e.season_oracle
        } else {
            o == e.quest_oracle
        },
        StakeError::BadOracle
    );
    require!(budget > 0, StakeError::ZeroAmount);
    let p = &mut ctx.accounts.pool;
    require!(
        budget <= p.budget && budget <= p.max_root_budget,
        StakeError::SkrBudgetExceeded
    );
    p.budget -= budget;
    p.reserved = p.reserved.checked_add(budget).ok_or(StakeError::Overflow)?;
    let r = &mut ctx.accounts.root;
    r.kind = kind;
    r.epoch = epoch;
    r.root = root;
    r.budget = budget;
    r.claimed = 0;
    r.published_at = Clock::get()?.unix_timestamp;
    r.publisher = o;
    r.revoked = false;
    r.bump = ctx.bumps.root;
    emit!(RootPublished {
        kind,
        epoch,
        root,
        budget
    });
    Ok(())
}

#[derive(Accounts)]
pub struct RevokeSkrRoot<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [b"emission"], bump = emission.bump, has_one = admin @ StakeError::Unauthorized)]
    pub emission: Box<Account<'info, EmissionState>>,
    #[account(mut, seeds = [b"skr_pool"], bump = pool.bump)]
    pub pool: Box<Account<'info, SkrPool>>,
    #[account(mut, seeds = [b"root", &[root.kind], &root.epoch.to_le_bytes()], bump = root.bump)]
    pub root: Box<Account<'info, RewardRoot>>,
}

pub fn revoke_skr_root(ctx: Context<RevokeSkrRoot>) -> Result<()> {
    let r = &mut ctx.accounts.root;
    require!(SkrPool::is_skr_kind(r.kind), StakeError::WrongRootCurrency);
    require!(!r.revoked, StakeError::RootRevoked);
    r.revoked = true;
    let left = r.budget - r.claimed;
    let p = &mut ctx.accounts.pool;
    // SEC-A3 (2026-10-02): the invariant `reserved == Σ(budget − claimed)` over live roots holds
    // today, so this subtraction cannot underflow — but `claim_skr_root` and `publish_skr_root`
    // both use `checked_*` for the same fields, and a raw `-=` wraps on the dev/test profile.
    p.reserved = p.reserved.checked_sub(left).ok_or(StakeError::Overflow)?;
    p.budget = p.budget.checked_add(left).ok_or(StakeError::Overflow)?;
    emit!(RootRevoked {
        kind: r.kind,
        epoch: r.epoch
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimSkrRoot<'info> {
    #[account(mut)]
    pub wallet: Signer<'info>,
    #[account(seeds = [b"emission"], bump = emission.bump, constraint = !emission.paused @ StakeError::Paused)]
    pub emission: Box<Account<'info, EmissionState>>,
    #[account(mut, seeds = [b"skr_pool"], bump = pool.bump, constraint = !pool.paused @ StakeError::SkrPoolPaused)]
    pub pool: Box<Account<'info, SkrPool>>,
    #[account(mut, seeds = [b"root", &[root.kind], &root.epoch.to_le_bytes()], bump = root.bump)]
    pub root: Box<Account<'info, RewardRoot>>,
    #[account(init, payer = wallet, space = 8 + ClaimReceipt::INIT_SPACE, seeds = [b"claim", root.key().as_ref(), wallet.key().as_ref()], bump)]
    pub receipt: Box<Account<'info, ClaimReceipt>>,
    #[account(mut, address = pool.vault)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = pool.skr_mint, token::authority = wallet)]
    pub wallet_skr: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn claim_skr_root(ctx: Context<ClaimSkrRoot>, amount: u64, proof: Vec<[u8; 32]>) -> Result<()> {
    use anchor_lang::solana_program::keccak::hashv;
    let now = Clock::get()?.unix_timestamp;
    let r = &mut ctx.accounts.root;
    require!(SkrPool::is_skr_kind(r.kind), StakeError::WrongRootCurrency);
    require!(!r.revoked, StakeError::RootRevoked);
    require!(
        now >= r.published_at + ROOT_TIMELOCK,
        StakeError::RootTimelocked
    );
    require!(proof.len() <= 24, StakeError::BadProof);
    require!(amount > 0, StakeError::ZeroAmount);
    let leaf = hashv(&[
        &[0u8],
        ctx.accounts.wallet.key().as_ref(),
        &amount.to_le_bytes(),
        &[r.kind],
        &r.epoch.to_le_bytes(),
    ])
    .to_bytes();
    require!(verify_proof(&r.root, leaf, &proof), StakeError::BadProof);
    r.claimed = r.claimed.checked_add(amount).ok_or(StakeError::Overflow)?;
    require!(r.claimed <= r.budget, StakeError::RootBudgetExceeded);
    ctx.accounts.receipt.amount = amount;
    ctx.accounts.receipt.bump = ctx.bumps.receipt;

    let p = &mut ctx.accounts.pool;
    require!(amount <= p.reserved, StakeError::SkrBudgetExceeded); // cannot fail if invariants hold; defence in depth
    p.reserved -= amount;
    p.paid_total = p
        .paid_total
        .checked_add(amount)
        .ok_or(StakeError::Overflow)?;
    let seeds: &[&[u8]] = &[b"skr_pool", &[p.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            token::Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.wallet_skr.to_account_info(),
                authority: p.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;
    emit!(RootClaimed {
        kind: r.kind,
        epoch: r.epoch,
        wallet: ctx.accounts.wallet.key(),
        amount
    });
    Ok(())
}
