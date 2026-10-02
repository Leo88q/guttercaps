//! Emission authority: the ONLY place $CG is ever minted.
//!
//! Invariants enforced here (audited by tests in lib.rs):
//!  * minted_total ≤ Σ yearly caps to date; per-year minted ≤ that year's cap
//!  * a day is closed at most once; its guarded budget is split into slices
//!  * slices for quests/pvp/events accumulate and are only released through
//!    Merkle roots (1 h timelock, revocable by admin during the window)
//!  * burn reports are accepted only from the four game programs' PDAs and
//!    feed the 7-day ring that indexes the guard
//!  * SEC-L5: the arena's 20 % wager rake lands in the season pool (ATA of
//!    ["season_pool"]); `fund_slice` burns it into slice_budget[PvpSeason] and the
//!    re-mint at claim is charged to `recycled_*`, never to the yearly caps
//!    (recycled_minted ≤ recycled_total ⇒ supply-neutral)

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::token::{self, Mint, Token, TokenAccount};

use crate::errors::StakeError;
use crate::state::*;

#[derive(Accounts)]
pub struct InitEmission<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + EmissionState::INIT_SPACE, seeds = [b"emission"], bump)]
    pub emission: Box<Account<'info, EmissionState>>,
    #[account(init, payer = admin, space = 8 + Pool::INIT_SPACE, seeds = [b"token_pool"], bump)]
    pub token_pool: Box<Account<'info, Pool>>,
    #[account(init, payer = admin, space = 8 + Pool::INIT_SPACE, seeds = [b"chip_pool"], bump)]
    pub chip_pool: Box<Account<'info, Pool>>,
    /// $CG mint; its mint authority must be (or be set in the same tx to) the emission PDA.
    #[account(mut, mint::decimals = CG_DECIMALS)]
    pub cg_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitEmissionArgs {
    pub chip_core_program: Pubkey,
    pub market_program: Pubkey,
    pub arena_program: Pubkey,
    pub quest_oracle: Pubkey,
    pub season_oracle: Pubkey,
    pub set_oracle: Pubkey,
    pub split_bps: [u16; SPLIT_COUNT],
    pub genesis_ts: i64,
}

/// SEC-F1 (2026-09-25): docs/02-economy.md promises a 1 B hard cap and "freeze authority: none".
/// `init_emission` used to accept any 6-decimal mint, so a mint that still carried a freeze
/// authority (anyone holding it can freeze every player's and every pool's $CG account) or that
/// had been pre-minted beyond the non-play allocation (supply + play emission > hard cap) would
/// have been bound to the emission singleton forever. The non-play allocation is
/// `HARD_CAP_MICRO - PLAY_BUCKET_MICRO` (45 %); everything else only ever comes out of `tick_day`.
pub fn validate_cg_mint(freeze_authority: &COption<Pubkey>, supply: u64) -> Result<()> {
    require!(freeze_authority.is_none(), StakeError::BadMint);
    require!(
        supply <= HARD_CAP_MICRO - PLAY_BUCKET_MICRO,
        StakeError::BadMint
    );
    Ok(())
}

pub fn init_emission(ctx: Context<InitEmission>, args: InitEmissionArgs) -> Result<()> {
    validate_cg_mint(
        &ctx.accounts.cg_mint.freeze_authority,
        ctx.accounts.cg_mint.supply,
    )?;
    require!(
        args.split_bps.iter().map(|&b| b as u32).sum::<u32>() == 10_000,
        StakeError::SplitSum
    );
    let now = Clock::get()?.unix_timestamp;
    let e = &mut ctx.accounts.emission;
    e.admin = ctx.accounts.admin.key();
    e.cg_mint = ctx.accounts.cg_mint.key();
    e.chip_core_program = args.chip_core_program;
    e.market_program = args.market_program;
    e.arena_program = args.arena_program;
    e.quest_oracle = args.quest_oracle;
    e.season_oracle = args.season_oracle;
    e.set_oracle = args.set_oracle;
    e.genesis_ts = if args.genesis_ts == 0 {
        now
    } else {
        args.genesis_ts
    };
    e.day_index = 0;
    e.split_bps = args.split_bps;
    e.split_changed_at = now;
    e.bump = ctx.bumps.emission;
    e.pauser = Pubkey::default();
    e.burn_oracle = Pubkey::default();
    // hand over mint authority to the PDA (admin must currently be authority)
    token::set_authority(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token::SetAuthority {
                current_authority: ctx.accounts.admin.to_account_info(),
                account_or_mint: ctx.accounts.cg_mint.to_account_info(),
            },
        ),
        token::spl_token::instruction::AuthorityType::MintTokens,
        Some(e.key()),
    )?;
    for (p, k) in [
        (&mut ctx.accounts.token_pool, 0u8),
        (&mut ctx.accounts.chip_pool, 1u8),
    ] {
        p.kind = k;
        p.last_update = now;
        p.bump = if k == 0 {
            ctx.bumps.token_pool
        } else {
            ctx.bumps.chip_pool
        };
    }
    Ok(())
}

// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct EmissionAdmin<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"emission"], bump = emission.bump, has_one = admin @ StakeError::Unauthorized)]
    pub emission: Box<Account<'info, EmissionState>>,
}

pub fn set_split(ctx: Context<EmissionAdmin>, split_bps: [u16; SPLIT_COUNT]) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let e = &mut ctx.accounts.emission;
    require!(
        split_bps.iter().map(|&b| b as u32).sum::<u32>() == 10_000,
        StakeError::SplitSum
    );
    require!(
        now - e.split_changed_at >= MIN_SPLIT_INTERVAL,
        StakeError::SplitGuard
    );
    for (new, old) in split_bps.iter().zip(e.split_bps.iter()) {
        let d = (*new as i32 - *old as i32).unsigned_abs();
        require!(d <= MAX_SPLIT_DELTA_BPS as u32, StakeError::SplitGuard);
    }
    e.split_bps = split_bps;
    e.split_changed_at = now;
    Ok(())
}

/// Admin: pause / un-pause (un-pausing is admin-only — the pauser has no such instruction).
pub fn set_paused(ctx: Context<EmissionAdmin>, paused: bool) -> Result<()> {
    ctx.accounts.emission.paused = paused;
    emit!(PauseChanged {
        by: ctx.accounts.admin.key(),
        paused
    });
    Ok(())
}

/// One event name (`PauserChanged{by, pauser}`) across chip_core / staking / arena, like `PauseChanged`:
/// the indexer decodes it per program (`events.ts` `alsoFrom`) and `authority_changes` keeps the program.
pub fn set_pauser(ctx: Context<EmissionAdmin>, pauser: Pubkey) -> Result<()> {
    ctx.accounts.emission.pauser = pauser;
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
        mut, seeds = [b"emission"], bump = emission.bump,
        constraint = authority.key() == emission.admin || (emission.pauser != Pubkey::default() && authority.key() == emission.pauser) @ StakeError::Unauthorized,
    )]
    pub emission: Box<Account<'info, EmissionState>>,
}

/// SEC-H2 emergency stop: pauser or admin, `paused = true` only. Blocks stake/tick/publish/claim;
/// `unstake_*` keep working (see docs/06 §2.4).
pub fn pause(ctx: Context<Pause>) -> Result<()> {
    ctx.accounts.emission.paused = true;
    emit!(PauseChanged {
        by: ctx.accounts.authority.key(),
        paused: true
    });
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct OraclePatch {
    pub quest_oracle: Option<Pubkey>,
    pub season_oracle: Option<Pubkey>,
    pub set_oracle: Option<Pubkey>,
    /// SEC-M1: `Some(Pubkey::default())` clears the burn oracle.
    pub burn_oracle: Option<Pubkey>,
}

pub fn set_oracles(ctx: Context<EmissionAdmin>, p: OraclePatch) -> Result<()> {
    let e = &mut ctx.accounts.emission;
    if let Some(k) = p.quest_oracle {
        e.quest_oracle = k;
    }
    if let Some(k) = p.season_oracle {
        e.season_oracle = k;
    }
    if let Some(k) = p.set_oracle {
        e.set_oracle = k;
    }
    if let Some(k) = p.burn_oracle {
        e.burn_oracle = k;
    }
    emit!(OraclesChanged {
        by: ctx.accounts.admin.key(),
        quest_oracle: e.quest_oracle,
        season_oracle: e.season_oracle,
        set_oracle: e.set_oracle,
        burn_oracle: e.burn_oracle,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// tick_day — permissionless crank, once per UTC day
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct TickDay<'info> {
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [b"emission"], bump = emission.bump, constraint = !emission.paused @ StakeError::Paused)]
    pub emission: Box<Account<'info, EmissionState>>,
    #[account(mut, seeds = [b"token_pool"], bump = token_pool.bump)]
    pub token_pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [b"chip_pool"], bump = chip_pool.bump)]
    pub chip_pool: Box<Account<'info, Pool>>,
}

pub fn tick_day(ctx: Context<TickDay>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let e = &mut ctx.accounts.emission;
    // SEC-G01: `init_emission` accepts a future `genesis_ts` (scheduled launch, `GENESIS_TS` in
    // scripts/setup.ts). Before genesis `now - genesis_ts` is negative and the former
    // `((now - genesis_ts) / DAY) as u32` wrapped it to ≈ 4.29e9; the first — permissionless — tick
    // then passed the day-0 exception below and stored `day_index = 4_294_967_295`, after which
    // `today > day_index` could never hold again: emission bricked until a program upgrade.
    // Refuse to tick before genesis; the day counter is range-checked before the cast from then on.
    require!(now >= e.genesis_ts, StakeError::BeforeGenesis);
    require!(now >= e.genesis_ts, StakeError::BeforeGenesis);
    let days = now
        .saturating_sub(e.genesis_ts)
        .checked_div(DAY)
        .unwrap_or(0); // ≥ 0 after the check above
    require!(days <= u32::MAX as i64, StakeError::Overflow);
    let today = days as u32;
    // Day 0 may be ticked once (`day_index` starts at 0, so `today > day_index` cannot hold on the
    // genesis day). SEC-G02: "once" is pinned by the live pools as well — with a split that routes
    // 100 % to the two pools `slice_budget` stays all-zero after the first tick, and the old check
    // let anyone re-tick day 0, each time resetting `budget_remaining` to a full daily slice on top
    // of what `Pool::update` had already accrued.
    let (tp, cp) = (&ctx.accounts.token_pool, &ctx.accounts.chip_pool);
    let token_pool_untouched = tp.budget_per_sec == 0 && tp.budget_remaining == 0;
    let chip_pool_untouched = cp.budget_per_sec == 0 && cp.budget_remaining == 0;
    let slices_untouched = e.minted_total == 0 && e.slice_budget.iter().all(|&b| b == 0);
    let pools_untouched = token_pool_untouched && chip_pool_untouched;
    let genesis_untouched = e.day_index == 0 && slices_untouched && pools_untouched;
    require!(
        today > e.day_index || genesis_untouched,
        StakeError::DayAlreadyClosed
    );

    // roll the burn ring
    let slot = (e.day_index as usize) % 7;
    e.burn_ring[slot] = e.burn_today;
    e.burn_today = 0;

    let year = e.year_index(now);
    let schedule_cap = EmissionState::daily_schedule_cap(year);
    let mut budget = e.guarded_daily(year);
    // yearly cap hard stop
    let year_left = EmissionState::yearly_cap_micro(year).saturating_sub(e.schedule_minted[year]);
    budget = budget.min(year_left);

    // finalize pools for the previous day (unspent budget is NOT carried — it stays unminted)
    let tp = &mut ctx.accounts.token_pool;
    tp.update(now)?;
    let cp = &mut ctx.accounts.chip_pool;
    cp.update(now)?;

    let mut slice = [0u64; SPLIT_COUNT];
    for (out, &bps) in slice.iter_mut().zip(e.split_bps.iter()) {
        *out = (budget as u128 * bps as u128 / 10_000) as u64;
    }
    cp.budget_per_sec = slice[Slice::ChipStaking as usize]
        .checked_div(DAY as u64)
        .unwrap_or(0);
    cp.budget_remaining = slice[Slice::ChipStaking as usize];
    tp.budget_per_sec = slice[Slice::TokenStaking as usize]
        .checked_div(DAY as u64)
        .unwrap_or(0);
    tp.budget_remaining = slice[Slice::TokenStaking as usize];
    // 2.. because the first two slots are the live pools written above; the rest accumulate until claimed.
    for (dst, &add) in e.slice_budget[2..].iter_mut().zip(&slice[2..]) {
        *dst = dst.checked_add(add).ok_or(StakeError::Overflow)?;
    }

    // Pool budgets are minted lazily at claim time; roots are minted at claim time too.
    // schedule_minted is charged at claim (see mint_to_user) so unclaimed budget never inflates supply.
    e.day_index = today;
    emit!(DayClosed {
        day_index: today,
        year: year as u8,
        schedule_cap,
        guarded: budget,
        burn_7d_avg: e.trailing_burn_avg(),
        slice_budget: e.slice_budget
    });
    Ok(())
}

/// Central mint path — every $CG that enters circulation passes here.
pub fn mint_to_user<'info>(
    emission: &mut Account<'info, EmissionState>,
    cg_mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    amount: u64,
    now: i64,
) -> Result<()> {
    mint_to_user_from(emission, cg_mint, to, token_program, amount, now, false)
}

/// `recycled = true` only for kind-3 (PvpSeason) root claims: the slice was topped up by `fund_slice`
/// with $CG burned out of the season pool, so up to `recycled_total − recycled_minted` of the claim is
/// re-minted outside the schedule (it left supply when burned — the net effect is a transfer).
/// Everything else, and any remainder, is charged to the yearly caps as before.
pub fn mint_to_user_from<'info>(
    emission: &mut Account<'info, EmissionState>,
    cg_mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    amount: u64,
    now: i64,
    recycled: bool,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let year = emission.year_index(now);
    let from_recycled = if recycled {
        amount.min(
            emission
                .recycled_total
                .saturating_sub(emission.recycled_minted),
        )
    } else {
        0
    };
    let scheduled = amount - from_recycled;
    if scheduled > 0 {
        // lifetime + yearly caps (cumulative: unspent past-year budget is forfeited, not rolled)
        let cum_cap: u64 = (0..=year).map(EmissionState::yearly_cap_micro).sum();
        require!(
            emission
                .minted_total
                .checked_add(scheduled)
                .ok_or(StakeError::Overflow)?
                <= cum_cap,
            StakeError::YearlyCap
        );
        require!(
            emission.schedule_minted[year]
                .checked_add(scheduled)
                .ok_or(StakeError::Overflow)?
                <= EmissionState::yearly_cap_micro(year),
            StakeError::YearlyCap
        );
        emission.minted_total += scheduled;
        emission.schedule_minted[year] += scheduled;
    }
    emission.recycled_minted += from_recycled;
    let seeds: &[&[u8]] = &[b"emission", &[emission.bump]];
    token::mint_to(
        CpiContext::new_with_signer(
            token_program.clone(),
            token::MintTo {
                mint: cg_mint.clone(),
                to: to.clone(),
                authority: emission.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// report_burn — feeds the emission guard's 7-day burn ring.
//
// Accepted signers: the ["burn_reporter"] PDAs of chip_core / market / arena
// (v2: direct CPI from open_pack / fuse / list / resolve_battle) and, since
// SEC-M1, `emission.burn_oracle` — the indexer's keeper key, which sums the
// $CG burned by those programs from their events (`BurnReported`,
// `ChipListed` × listing fee, `BattleResolved.rake_burn`) and reports the
// delta hourly (`backend/src/burn-oracle.ts`), counting only burns at or below
// the finalized horizon (SEC-B29: `report_burn` cannot be un-sent). Unstake penalties are recorded
// in-program (`record_internal_burn`) and must not be reported again.
//
// `burn_today` is clamped to BURN_SANITY_MULT × today's schedule cap: the
// guard cannot exceed the schedule anyway, so a lying/buggy oracle can at
// most lift emission from the 30 % floor to 100 % of the schedule.
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct ReportBurn<'info> {
    pub reporter: Signer<'info>,
    #[account(mut, seeds = [b"emission"], bump = emission.bump)]
    pub emission: Box<Account<'info, EmissionState>>,
}

pub fn report_burn(ctx: Context<ReportBurn>, amount: u64) -> Result<()> {
    let e = &mut ctx.accounts.emission;
    let r = ctx.accounts.reporter.key();
    let is_program = [e.chip_core_program, e.market_program, e.arena_program]
        .iter()
        .any(|p| Pubkey::find_program_address(&[b"burn_reporter"], p).0 == r);
    let is_oracle = e.burn_oracle != Pubkey::default() && r == e.burn_oracle;
    require!(is_program || is_oracle, StakeError::NotBurnReporter);
    let now = Clock::get()?.unix_timestamp;
    let clamp =
        EmissionState::daily_schedule_cap(e.year_index(now)).saturating_mul(BURN_SANITY_MULT);
    e.burn_today = e.burn_today.saturating_add(amount).min(clamp);
    emit!(BurnRecorded {
        source: r,
        amount,
        burn_today: e.burn_today
    });
    Ok(())
}

/// Self-reported burn from *this* program (unstake penalties).
pub fn record_internal_burn(e: &mut EmissionState, amount: u64) {
    e.burn_today = e.burn_today.saturating_add(amount);
}

// ---------------------------------------------------------------------------
// fund_slice (SEC-L5) — recycle the arena's 20 % wager rake into the PvpSeason slice.
//
// `arena::resolve_battle` transfers `rake_pool` into `ArenaConfig.season_pool`, a $CG token
// account whose authority is this program's ["season_pool"] PDA (NOT the staking vault — the
// vault holds stakers' principal and must never be spent from). Season roots (kind 3) mint from
// `slice_budget[PvpSeason]`, so the rake is made claimable by burning it here and crediting the
// slice; kind-3 `claim_root` (`mint_to_user_from(.., recycled = true)`) charges the later re-mint
// to `recycled_*` instead of the schedule.
// The burn is NOT recorded in the guard ring: it is a transfer in disguise, not demand.
// Signers: `season_oracle` (the reward oracle calls it when a season settles, before publishing
// the kind-3 root) or `admin`. Blast radius of a leaked oracle key = the pool balance, and only
// into a slice it could already draw from (publish_root + 1 h revoke window).
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct FundSlice<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut, seeds = [b"emission"], bump = emission.bump,
        constraint = !emission.paused @ StakeError::Paused,
        constraint = authority.key() == emission.admin || (emission.season_oracle != Pubkey::default() && authority.key() == emission.season_oracle) @ StakeError::Unauthorized,
    )]
    pub emission: Box<Account<'info, EmissionState>>,
    #[account(mut, address = emission.cg_mint)]
    pub cg_mint: Account<'info, Mint>,
    /// CHECK: ["season_pool"] PDA — authority of the season pool token account; holds no data
    #[account(seeds = [b"season_pool"], bump)]
    pub season_pool_auth: UncheckedAccount<'info>,
    /// The arena's `ArenaConfig.season_pool` (its ATA; any token account under the PDA works).
    #[account(mut, token::mint = emission.cg_mint, token::authority = season_pool_auth)]
    pub season_pool: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn fund_slice(ctx: Context<FundSlice>, kind: u8, amount: u64) -> Result<()> {
    require!(kind == Slice::PvpSeason as u8, StakeError::WrongSlice);
    require!(amount > 0, StakeError::ZeroAmount);
    require!(
        amount <= ctx.accounts.season_pool.amount,
        StakeError::InsufficientPool
    );
    // state first (CEI), then the burn CPI
    let (slice_budget, recycled_total) = {
        let e = &mut ctx.accounts.emission;
        let k = kind as usize;
        e.slice_budget[k] = e.slice_budget[k]
            .checked_add(amount)
            .ok_or(StakeError::Overflow)?;
        e.recycled_total = e
            .recycled_total
            .checked_add(amount)
            .ok_or(StakeError::Overflow)?;
        (e.slice_budget, e.recycled_total)
    };
    let seeds: &[&[u8]] = &[b"season_pool", &[ctx.bumps.season_pool_auth]];
    token::burn(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            token::Burn {
                mint: ctx.accounts.cg_mint.to_account_info(),
                from: ctx.accounts.season_pool.to_account_info(),
                authority: ctx.accounts.season_pool_auth.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;
    emit!(SliceFunded {
        by: ctx.accounts.authority.key(),
        kind,
        amount,
        slice_budget,
        recycled_total
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Merkle reward roots (quests / season / events)
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(kind: u8, epoch: u32)]
pub struct PublishRoot<'info> {
    #[account(mut)]
    pub oracle: Signer<'info>,
    #[account(mut, seeds = [b"emission"], bump = emission.bump, constraint = !emission.paused @ StakeError::Paused)]
    pub emission: Box<Account<'info, EmissionState>>,
    #[account(init, payer = oracle, space = 8 + RewardRoot::INIT_SPACE, seeds = [b"root".as_ref(), &[kind][..], &epoch.to_le_bytes()[..]], bump)]
    pub root: Box<Account<'info, RewardRoot>>,
    pub system_program: Program<'info, System>,
}

pub fn publish_root(
    ctx: Context<PublishRoot>,
    kind: u8,
    epoch: u32,
    root: [u8; 32],
    budget: u64,
) -> Result<()> {
    let e = &mut ctx.accounts.emission;
    let o = ctx.accounts.oracle.key();
    let allowed = match kind {
        2 => o == e.quest_oracle,
        3 | 4 => o == e.season_oracle,
        _ => false,
    };
    require!(allowed, StakeError::BadOracle);
    let k = kind as usize;
    require!(budget <= e.slice_budget[k], StakeError::BudgetExceeded);
    e.slice_budget[k] -= budget; // reserved now; refunded on revoke
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
pub struct RevokeRoot<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"emission"], bump = emission.bump, has_one = admin @ StakeError::Unauthorized)]
    pub emission: Box<Account<'info, EmissionState>>,
    #[account(mut, seeds = [b"root", &[root.kind], &root.epoch.to_le_bytes()], bump = root.bump)]
    pub root: Box<Account<'info, RewardRoot>>,
}

/// Admin (multisig) can pull a root while it is timelocked or after — the
/// unclaimed remainder returns to the slice budget. Used when the anti-fraud
/// pipeline flags a batch after publication.
pub fn revoke_root(ctx: Context<RevokeRoot>) -> Result<()> {
    let r = &mut ctx.accounts.root;
    // SKR roots (kind ≥ 5) are revoked through `revoke_skr_root` — indexing slice_budget with them would be OOB.
    require!(
        (r.kind as usize) < SPLIT_COUNT,
        StakeError::WrongRootCurrency
    );
    require!(!r.revoked, StakeError::RootRevoked);
    r.revoked = true;
    // SEC-A3 (2026-10-02): `slice_budget[k]` is a running total that `tick_day` / `fund_slice` keep
    // far below u64::MAX, so this cannot overflow today — but every sibling path in this file uses
    // `checked_add` with `StakeError::Overflow`, and a raw `+=` would *wrap* on the dev/test profile
    // (where `overflow-checks` is off) instead of failing the transaction.
    let k = r.kind as usize;
    let refund = r.budget - r.claimed;
    let e = &mut ctx.accounts.emission;
    let sum = e.slice_budget[k]
        .checked_add(refund)
        .ok_or(StakeError::Overflow)?;
    e.slice_budget[k] = sum;
    emit!(RootRevoked {
        kind: r.kind,
        epoch: r.epoch
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimRoot<'info> {
    #[account(mut)]
    pub wallet: Signer<'info>,
    #[account(mut, seeds = [b"emission"], bump = emission.bump, constraint = !emission.paused @ StakeError::Paused)]
    pub emission: Box<Account<'info, EmissionState>>,
    #[account(mut, seeds = [b"root", &[root.kind], &root.epoch.to_le_bytes()], bump = root.bump)]
    pub root: Box<Account<'info, RewardRoot>>,
    #[account(init, payer = wallet, space = 8 + ClaimReceipt::INIT_SPACE, seeds = [b"claim", root.key().as_ref(), wallet.key().as_ref()], bump)]
    pub receipt: Box<Account<'info, ClaimReceipt>>,
    #[account(mut, address = emission.cg_mint)]
    pub cg_mint: Account<'info, Mint>,
    #[account(mut, token::mint = emission.cg_mint, token::authority = wallet)]
    pub wallet_cg: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Leaf = keccak(0x00 ‖ wallet ‖ amount_le_u64 ‖ kind ‖ epoch_le_u32); nodes = keccak(0x01 ‖ min ‖ max).
pub fn verify_proof(root: &[u8; 32], leaf: [u8; 32], proof: &[[u8; 32]]) -> bool {
    use anchor_lang::solana_program::keccak::hashv;
    let mut node = leaf;
    for p in proof {
        node = if node <= *p {
            hashv(&[&[1u8], &node, p]).to_bytes()
        } else {
            hashv(&[&[1u8], p, &node]).to_bytes()
        };
    }
    node == *root
}

pub fn claim_root(ctx: Context<ClaimRoot>, amount: u64, proof: Vec<[u8; 32]>) -> Result<()> {
    use anchor_lang::solana_program::keccak::hashv;
    let now = Clock::get()?.unix_timestamp;
    let r = &mut ctx.accounts.root;
    // An SKR root must never reach the $CG mint path (see `claim_skr_root`).
    require!(
        (r.kind as usize) < SPLIT_COUNT,
        StakeError::WrongRootCurrency
    );
    require!(!r.revoked, StakeError::RootRevoked);
    require!(
        now >= r.published_at + ROOT_TIMELOCK,
        StakeError::RootTimelocked
    );
    require!(proof.len() <= 24, StakeError::BadProof);
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
    let recycled = r.kind == Slice::PvpSeason as u8; // SEC-L5: season roots may draw on the recycled rake
    mint_to_user_from(
        &mut ctx.accounts.emission,
        &ctx.accounts.cg_mint.to_account_info(),
        &ctx.accounts.wallet_cg.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
        amount,
        now,
        recycled,
    )?;
    emit!(RootClaimed {
        kind: r.kind,
        epoch: r.epoch,
        wallet: ctx.accounts.wallet.key(),
        amount
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{validate_cg_mint, verify_proof};
    use crate::state::{HARD_CAP_MICRO, MICRO, PLAY_BUCKET_MICRO};
    use anchor_lang::prelude::*;
    use anchor_lang::solana_program::program_option::COption;

    /// SEC-F1: only a freeze-less mint whose pre-existing supply fits the non-play allocation
    /// can be bound to the emission singleton.
    #[test]
    fn cg_mint_guard_enforces_hard_cap_and_no_freeze() {
        let none: COption<Pubkey> = COption::None;
        let frozen = COption::Some(Pubkey::new_unique());
        let non_play = HARD_CAP_MICRO - PLAY_BUCKET_MICRO;
        assert!(validate_cg_mint(&none, 0).is_ok());
        assert!(validate_cg_mint(&none, non_play).is_ok());
        assert!(validate_cg_mint(&none, non_play + 1).is_err());
        assert!(validate_cg_mint(&none, u64::MAX).is_err());
        assert!(validate_cg_mint(&frozen, 0).is_err());
        // the localnet harness premint (100 M $CG) stays valid
        let harness_premint = 100_000_000 * MICRO;
        assert!(validate_cg_mint(&none, harness_premint).is_ok());
        // bound + the whole play bucket lands exactly on the hard cap
        assert_eq!(non_play + PLAY_BUCKET_MICRO, HARD_CAP_MICRO);
    }

    /// A reward proof is bound to (wallet, amount, kind, epoch): it cannot be replayed for another
    /// wallet, a larger amount, the other currency's root kind or another epoch.
    #[test]
    fn merkle_leaf_binds_wallet_amount_kind_epoch() {
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
        let node = |x: &[u8; 32], y: &[u8; 32]| -> [u8; 32] {
            if x <= y {
                hashv(&[&[1u8], x, y]).to_bytes()
            } else {
                hashv(&[&[1u8], y, x]).to_bytes()
            }
        };
        let mine = leaf(1, 5_000_000, 2, 9);
        let other = leaf(2, 7_000_000, 2, 9);
        let root = node(&mine, &other);
        assert!(verify_proof(&root, mine, &[other]));
        assert!(verify_proof(&root, other, &[mine]));
        let forged = [
            leaf(3, 5_000_000, 2, 9),
            leaf(1, 5_000_001, 2, 9),
            leaf(1, 5_000_000, 5, 9),
            leaf(1, 5_000_000, 2, 10),
        ];
        for f in forged {
            assert!(!verify_proof(&root, f, &[other]));
        }
        assert!(!verify_proof(&root, mine, &[]));
        assert!(!verify_proof(&root, mine, &[mine]));
    }
}
