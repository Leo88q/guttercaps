//! Admin surface: initialize, collections, params with guard-rails, 2-step
//! admin transfer, pause. Admin key = Squads multisig (48 h timelock on
//! set_params is enforced at the multisig level; on-chain we additionally
//! bump `params_version` so the indexer/admin-panel can diff & audit).

use anchor_lang::prelude::*;
use mpl_bubblegum::instructions::CreateTreeConfigV2CpiBuilder;
use mpl_core::{
    instructions::CreateCollectionV2CpiBuilder,
    types::{
        BubblegumV2, Creator, PermanentTransferDelegate, Plugin, PluginAuthority,
        PluginAuthorityPair, Royalties, RuleSet,
    },
    ID as MPL_CORE_ID,
};

use crate::errors::ChipError;
use crate::state::*;
use crate::{
    bubblegum::{tree_config_pda, MPL_ACCOUNT_COMPRESSION_ID, MPL_NOOP_ID},
    economy::*,
    BUBBLEGUM_V2_ID,
};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + GameConfig::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Box<Account<'info, GameConfig>>,
    // sentio-ignore-next-line SW013
    /// CHECK: vault PDA, system-owned, holds SOL
    #[account(mut, seeds = [b"vault"], bump)]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: SEC-F7 — this program's ProgramData (upgradeable-loader PDA `[program_id]`); address,
    /// owner and recorded upgrade authority are verified in the handler (`deploy_guard`).
    pub program_data: UncheckedAccount<'info>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitArgs {
    pub treasury: Pubkey,
    pub buyback_wallet: Pubkey,
    pub cg_mint: Pubkey,
    pub usdc_mint: Pubkey,
    pub skr_mint: Pubkey,
    pub staking_program: Pubkey,
    pub pyth_sol_usd_feed: Pubkey,
    pub pyth_skr_usd_feed: Pubkey,
}

pub fn initialize(ctx: Context<Initialize>, args: InitArgs) -> Result<()> {
    // SEC-F7: first-caller-wins closed — only the upgrade authority can create the config.
    require!(
        crate::deploy_guard::signer_is_upgrade_authority(
            ctx.program_id,
            &ctx.accounts.program_data.to_account_info(),
            ctx.accounts.admin.key,
        ),
        ChipError::NotUpgradeAuthority
    );
    let c = &mut ctx.accounts.config;
    c.admin = ctx.accounts.admin.key();
    c.pending_admin = Pubkey::default();
    c.treasury = args.treasury;
    c.buyback_wallet = args.buyback_wallet;
    c.cg_mint = args.cg_mint;
    c.usdc_mint = args.usdc_mint;
    c.skr_mint = args.skr_mint;
    c.staking_program = args.staking_program;
    c.pyth_sol_usd_feed = args.pyth_sol_usd_feed;
    c.pyth_skr_usd_feed = args.pyth_skr_usd_feed;
    c.skr_discount_bps = DEFAULT_SKR_DISCOUNT_BPS;
    c.featured_collection = 0;
    c.paused = false;
    c.packs = DEFAULT_PACKS;
    c.market_fee_bps = DEFAULT_MARKET_FEE_BPS;
    c.collections_created = 0;
    c.params_version = 1;
    c.vault_bump = ctx.bumps.vault;
    c.bump = ctx.bumps.config;
    c.pauser = Pubkey::default();
    // fund vault with rent-exempt minimum so it can never be garbage-collected
    let min = Rent::get()?.minimum_balance(0);
    anchor_lang::system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.admin.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        ),
        min,
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(idx: u8)]
pub struct CreateCollection<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin @ ChipError::Unauthorized)]
    pub config: Box<Account<'info, GameConfig>>,
    // `.as_ref()` / `[..]` on the seeds, and only on the `init` accounts: anchor's `init` path puts the
    // seed expressions into an array literal with no annotation, so element 0 decides the type of all of
    // them — with `b"collection"` (a `+[u8; 10]`) first, `&[idx]` was demanded to be the same array and got
    // E0308 "expected an array with a size of 10". Making every element a `&[u8]` is the same bytes and the
    // same PDA, so no client-side derivation moves; the non-`init` constraints elsewhere in the workspace do
    // not need it (chip.rs's identical `seeds = [b"collection", &[chip.collection_idx]]` compiled clean) and
    // are deliberately left alone.
    #[account(init, payer = admin, space = 8 + CollectionMeta::INIT_SPACE, seeds = [b"collection".as_ref(), &[idx][..]], bump)]
    pub meta: Box<Account<'info, CollectionMeta>>,
    /// CHECK: fresh keypair for the Core collection account
    #[account(mut)]
    pub core_collection: Signer<'info>,
    /// CHECK: Metaplex Core
    #[account(address = MPL_CORE_ID)]
    pub mpl_core: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn create_collection(
    ctx: Context<CreateCollection>,
    idx: u8,
    symbol: String,
    name: String,
    uri: String,
    element: u8,
) -> Result<()> {
    require!(idx < COLLECTION_COUNT, ChipError::InvalidCollection);
    require!(
        idx == ctx.accounts.config.collections_created,
        ChipError::CollectionExists
    ); // sequential
    require!(element < 5, ChipError::InvalidElement);
    require!(symbol.len() <= 16, ChipError::InvalidCollection);

    let meta = &mut ctx.accounts.meta;
    meta.idx = idx;
    meta.core_collection = ctx.accounts.core_collection.key();
    meta.symbol = symbol;
    meta.element = element;
    meta.minted = 0;
    meta.minted_by_rarity = [0; RARITY_COUNT];
    meta.bump = ctx.bumps.meta;

    // Royalties are enforced at the collection level (2.5 % → treasury). The
    // permanent transfer delegate is the custom market PDA, not the collection
    // update authority: Bubblegum V2 transfer can therefore settle a buyer-only
    // transaction while the market still signs the CPI with its PDA seeds.
    let (market_auth, _) = Pubkey::find_program_address(
        &[b"market_auth"],
        &crate::instructions::chip::MARKET_PROGRAM_ID,
    );
    let plugins = vec![
        PluginAuthorityPair {
            plugin: Plugin::Royalties(Royalties {
                basis_points: ROYALTY_BPS,
                creators: vec![Creator {
                    address: ctx.accounts.config.treasury,
                    percentage: 100,
                }],
                rule_set: RuleSet::None,
            }),
            authority: Some(PluginAuthority::UpdateAuthority),
        },
        PluginAuthorityPair {
            plugin: Plugin::PermanentTransferDelegate(PermanentTransferDelegate {}),
            authority: Some(PluginAuthority::Address {
                address: market_auth,
            }),
        },
        PluginAuthorityPair {
            plugin: Plugin::BubblegumV2(BubblegumV2 {}),
            authority: None,
        },
    ];
    let seeds: &[&[u8]] = &[b"collection", &[idx], &[meta.bump]];
    CreateCollectionV2CpiBuilder::new(&ctx.accounts.mpl_core.to_account_info())
        .collection(&ctx.accounts.core_collection.to_account_info())
        .update_authority(Some(&meta.to_account_info()))
        .payer(&ctx.accounts.admin.to_account_info())
        .system_program(&ctx.accounts.system_program.to_account_info())
        .name(name)
        .uri(uri)
        .plugins(plugins)
        .invoke_signed(&[seeds])?;

    ctx.accounts.config.collections_created += 1;
    emit!(CollectionCreated {
        by: ctx.accounts.admin.key(),
        idx,
        core_collection: ctx.accounts.core_collection.key(),
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Bubblegum V2 deployment binding
// ---------------------------------------------------------------------------

/// Creates the Bubblegum V2 TreeConfig with the collection PDA as its tree
/// creator/delegate. The Merkle tree storage account is preallocated by the
/// operations transaction with Account Compression as owner; Bubblegum then
/// initializes the config and binds the signer policy.
#[derive(Accounts)]
#[instruction(idx: u8, max_depth: u8, canopy: u8, max_buffer_size: u32)]
pub struct CreateBubblegumTree<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin @ ChipError::Unauthorized)]
    pub config: Box<Account<'info, GameConfig>>,
    #[account(seeds = [b"collection".as_ref(), &[idx][..]], bump = collection.bump)]
    pub collection: Box<Account<'info, CollectionMeta>>,
    #[account(
        init,
        payer = admin,
        space = 8 + BubblegumTreeMeta::INIT_SPACE,
        seeds = [b"bubblegum_tree".as_ref(), &[idx][..]],
        bump,
    )]
    pub tree_meta: Box<Account<'info, BubblegumTreeMeta>>,
    /// CHECK: preallocated Account Compression Merkle tree storage.
    #[account(mut)]
    pub merkle_tree: UncheckedAccount<'info>,
    /// CHECK: Bubblegum V2 TreeConfig PDA, initialized by the CPI.
    #[account(mut, address = tree_config_pda(&merkle_tree.key()))]
    pub tree_config: UncheckedAccount<'info>,
    /// CHECK: Bubblegum V2.
    #[account(address = BUBBLEGUM_V2_ID)]
    pub bubblegum_program: UncheckedAccount<'info>,
    /// CHECK: MPL Noop log wrapper.
    #[account(address = MPL_NOOP_ID)]
    pub log_wrapper: UncheckedAccount<'info>,
    /// CHECK: MPL Account Compression.
    #[account(address = MPL_ACCOUNT_COMPRESSION_ID)]
    pub compression_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn create_bubblegum_tree(
    ctx: Context<CreateBubblegumTree>,
    idx: u8,
    max_depth: u8,
    canopy: u8,
    max_buffer_size: u32,
) -> Result<()> {
    require!(
        idx < ctx.accounts.config.collections_created,
        ChipError::InvalidCollection
    );
    require_eq!(
        ctx.accounts.collection.idx,
        idx,
        ChipError::InvalidCollection
    );
    require!(
        (1..=30).contains(&max_depth) && canopy <= max_depth && max_buffer_size > 0,
        ChipError::InvalidBubblegumTree
    );
    require!(
        ctx.accounts.bubblegum_program.to_account_info().executable,
        ChipError::InvalidBubblegumTree
    );
    require!(
        ctx.accounts.tree_config.to_account_info().data_is_empty(),
        ChipError::InvalidBubblegumTree
    );
    require_keys_eq!(
        *ctx.accounts.merkle_tree.to_account_info().owner,
        MPL_ACCOUNT_COMPRESSION_ID,
        ChipError::InvalidBubblegumTree
    );
    require!(
        ctx.accounts.merkle_tree.to_account_info().data_len() > 0,
        ChipError::InvalidBubblegumTree
    );

    let collection_seeds: &[&[u8]] = &[
        b"collection",
        &[ctx.accounts.collection.idx],
        &[ctx.accounts.collection.bump],
    ];
    CreateTreeConfigV2CpiBuilder::new(&ctx.accounts.bubblegum_program.to_account_info())
        .tree_config(&ctx.accounts.tree_config.to_account_info())
        .merkle_tree(&ctx.accounts.merkle_tree.to_account_info())
        .payer(&ctx.accounts.admin.to_account_info())
        .tree_creator(Some(&ctx.accounts.collection.to_account_info()))
        .log_wrapper(&ctx.accounts.log_wrapper.to_account_info())
        .compression_program(&ctx.accounts.compression_program.to_account_info())
        .system_program(&ctx.accounts.system_program.to_account_info())
        .max_depth(max_depth as u32)
        .max_buffer_size(max_buffer_size)
        .public(false)
        .invoke_signed(&[collection_seeds])?;

    let tree = &mut ctx.accounts.tree_meta;
    tree.collection_idx = idx;
    tree.core_collection = ctx.accounts.collection.core_collection;
    tree.merkle_tree = ctx.accounts.merkle_tree.key();
    tree.tree_config = ctx.accounts.tree_config.key();
    tree.tree_authority = ctx.accounts.collection.key();
    tree.max_depth = max_depth;
    tree.canopy = canopy;
    tree.active = true;
    tree.bump = ctx.bumps.tree_meta;
    Ok(())
}

#[derive(Accounts)]
#[instruction(idx: u8)]
pub struct ConfigureBubblegumTree<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin @ ChipError::Unauthorized)]
    pub config: Box<Account<'info, GameConfig>>,
    #[account(seeds = [b"collection".as_ref(), &[idx][..]], bump = meta.bump)]
    pub meta: Box<Account<'info, CollectionMeta>>,
    #[account(init, payer = admin, space = 8 + BubblegumTreeMeta::INIT_SPACE, seeds = [b"bubblegum_tree".as_ref(), &[idx][..]], bump)]
    pub tree_meta: Box<Account<'info, BubblegumTreeMeta>>,
    /// CHECK: Bubblegum V2 Merkle tree. Its owner and V2 layout are checked by
    /// Bubblegum CPI during mint and leaf replacement; this registry only binds
    /// the key and never parses tree bytes.
    pub merkle_tree: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: Bubblegum-owned TreeConfigV2 PDA.
    pub tree_config: UncheckedAccount<'info>,
    /// CHECK: tree authority configured by the createTreeV2 operations tx.
    pub tree_authority: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn configure_bubblegum_tree(
    ctx: Context<ConfigureBubblegumTree>,
    idx: u8,
    max_depth: u8,
    canopy: u8,
) -> Result<()> {
    require!(
        idx < ctx.accounts.config.collections_created,
        ChipError::InvalidCollection
    );
    require_eq!(ctx.accounts.meta.idx, idx, ChipError::InvalidCollection);
    require!(
        (1..=30).contains(&max_depth) && canopy <= max_depth,
        ChipError::InvalidBubblegumTree
    );
    require!(
        !ctx.accounts.merkle_tree.key().eq(&Pubkey::default())
            && !ctx.accounts.tree_authority.key().eq(&Pubkey::default()),
        ChipError::InvalidBubblegumTree
    );
    // The Core collection PDA is the only supported tree delegate. This lets
    // the mint CPI sign both Bubblegum's tree-authority check and MPL Core's
    // collection-authority check with one explicit, auditable seed policy.
    require_keys_eq!(
        ctx.accounts.tree_authority.key(),
        ctx.accounts.meta.key(),
        ChipError::InvalidBubblegumTree
    );
    let (expected_tree_config, _) = Pubkey::find_program_address(
        &[ctx.accounts.merkle_tree.key().as_ref()],
        &crate::BUBBLEGUM_V2_ID,
    );
    require_keys_eq!(
        expected_tree_config,
        ctx.accounts.tree_config.key(),
        ChipError::InvalidBubblegumTree
    );

    let tree = &mut ctx.accounts.tree_meta;
    tree.collection_idx = idx;
    tree.core_collection = ctx.accounts.meta.core_collection;
    tree.merkle_tree = ctx.accounts.merkle_tree.key();
    tree.tree_config = ctx.accounts.tree_config.key();
    tree.tree_authority = ctx.accounts.tree_authority.key();
    tree.max_depth = max_depth;
    tree.canopy = canopy;
    tree.active = true;
    tree.bump = ctx.bumps.tree_meta;
    Ok(())
}

// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin @ ChipError::Unauthorized)]
    pub config: Box<Account<'info, GameConfig>>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ParamsPatch {
    pub packs: Option<[PackDef; 4]>,
    pub market_fee_bps: Option<u16>,
    pub featured_collection: Option<u8>,
    pub treasury: Option<Pubkey>,
    pub buyback_wallet: Option<Pubkey>,
    pub pyth_sol_usd_feed: Option<Pubkey>,
    pub pyth_skr_usd_feed: Option<Pubkey>,
    pub skr_mint: Option<Pubkey>,
    pub skr_discount_bps: Option<u16>,
}

/// Bit per `ParamsPatch` field, carried in `ParamsPatched.changed` (SEC-B22). A field whose bit is
/// clear was absent from the patch and keeps its current value in the emitted event.
pub const PARAMS_FIELD_PACKS: u16 = 1 << 0;
pub const PARAMS_FIELD_MARKET_FEE: u16 = 1 << 1;
pub const PARAMS_FIELD_FEATURED: u16 = 1 << 2;
pub const PARAMS_FIELD_TREASURY: u16 = 1 << 3;
pub const PARAMS_FIELD_BUYBACK: u16 = 1 << 4;
pub const PARAMS_FIELD_PYTH_SOL: u16 = 1 << 5;
pub const PARAMS_FIELD_PYTH_SKR: u16 = 1 << 6;
pub const PARAMS_FIELD_SKR_MINT: u16 = 1 << 7;
pub const PARAMS_FIELD_SKR_DISCOUNT: u16 = 1 << 8;

/// SEC-B22: every one of these addresses redirects money or a price source, and `Pubkey::default()` is
/// never a valid destination — a set-to-zero would send a whole revenue path (or a treasury) to the
/// system program's address, where those lamports are unreachable. Nothing upstream prevents it today:
/// `set_params` takes any key the admin signs.
fn require_non_default(key: Pubkey) -> Result<()> {
    require!(key != Pubkey::default(), ChipError::InvalidConfigAddress);
    Ok(())
}

/// Every edit is validated against economy guard-rails. These are the
/// bounds inside which the live-ops admin panel may tune without a program
/// upgrade; anything outside needs a new deploy (and therefore the 48 h
/// timelock + public diff).
pub fn set_params(ctx: Context<AdminOnly>, patch: ParamsPatch) -> Result<()> {
    let c = &mut ctx.accounts.config;
    if let Some(packs) = patch.packs {
        for (i, p) in packs.iter().enumerate() {
            let sum: u32 = p.odds_bps.iter().map(|&b| b as u32).sum();
            require!(sum == BPS_DENOM, ChipError::OddsSumInvalid);
            require!(
                (1..=MAX_CHIPS_PER_PACK as u8).contains(&p.chips),
                ChipError::InvalidQuantity
            );
            require!(p.floor < RARITY_COUNT as u8, ChipError::OddsGuardRail);
            require!(p.pity_tier < RARITY_COUNT as u8, ChipError::OddsGuardRail);
            require!(p.odds_bps[0] >= 500, ChipError::OddsGuardRail); // Common ≥ 5 % always
            let top2 = p.odds_bps[7] as u32 + p.odds_bps[8] as u32;
            // Starter/Standard may never exceed 2 % Legend+/Diamond per slot; Premium/Limited 4 %.
            let cap = if i <= 1 {
                MAX_TOP2_BPS_STANDARD as u32
            } else {
                2 * MAX_TOP2_BPS_STANDARD as u32
            };
            require!(top2 <= cap, ChipError::OddsGuardRail);
            // price sanity: never free, never > $500
            require!(
                (50..=50_000).contains(&p.price_usd_cents),
                ChipError::OddsGuardRail
            );
            // SEC-F13: $CG price band — the only admin price with no oracle. One-shot moves are
            // limited to ×½–2× of the current value (old == 0 is free-form: CG sales are off and
            // pre-launch pricing is unthrottled), plus an absolute fat-finger cap.
            if p.price_cg_micro > 0 {
                require!(
                    p.price_cg_micro <= MAX_PACK_CG_PRICE_MICRO,
                    ChipError::CgPriceGuardRail
                );
                let old = c.packs[i].price_cg_micro;
                if old > 0 {
                    require!(
                        p.price_cg_micro >= old / 2 && p.price_cg_micro <= old.saturating_mul(2),
                        ChipError::CgPriceGuardRail
                    );
                }
            }
            if p.pity_tier > 0 {
                require!(
                    p.pity_hard_at >= 10
                        && p.pity_soft_start <= p.pity_hard_at
                        && p.pity_soft_step_bps <= 200,
                    ChipError::OddsGuardRail
                );
            }
            // Starter stays soulbound + 1/wallet by construction (sku 0 semantics are in code).
        }
        c.packs = packs;
    }
    if let Some(fee) = patch.market_fee_bps {
        require!(fee <= MAX_MARKET_FEE_BPS, ChipError::FeeTooHigh);
        c.market_fee_bps = fee;
    }
    if let Some(f) = patch.featured_collection {
        require!(f < c.collections_created, ChipError::InvalidCollection);
        c.featured_collection = f;
    }
    if let Some(t) = patch.treasury {
        require_non_default(t)?;
        c.treasury = t;
    }
    if let Some(b) = patch.buyback_wallet {
        require_non_default(b)?;
        c.buyback_wallet = b;
    }
    if let Some(p) = patch.pyth_sol_usd_feed {
        require_non_default(p)?;
        c.pyth_sol_usd_feed = p;
    }
    if let Some(p) = patch.pyth_skr_usd_feed {
        require_non_default(p)?;
        c.pyth_skr_usd_feed = p;
    }
    if let Some(m) = patch.skr_mint {
        require_non_default(m)?;
        c.skr_mint = m;
    }
    if let Some(d) = patch.skr_discount_bps {
        require!(d <= MAX_SKR_DISCOUNT_BPS, ChipError::FeeTooHigh);
        c.skr_discount_bps = d;
    }
    c.params_version = c.params_version.checked_add(1).ok_or(ChipError::Overflow)?;
    emit!(ParamsChanged {
        admin: ctx.accounts.admin.key(),
        version: c.params_version
    });
    // SEC-B22: `ParamsChanged` says that something moved; this says what. Emitted next to it (not
    // instead of it) so every existing consumer — the admin audit log, `params_changes` projections,
    // the fairness note in `queries.ts` — keeps working untouched.
    let mut changed: u16 = 0;
    if patch.packs.is_some() {
        changed |= PARAMS_FIELD_PACKS;
    }
    if patch.market_fee_bps.is_some() {
        changed |= PARAMS_FIELD_MARKET_FEE;
    }
    if patch.featured_collection.is_some() {
        changed |= PARAMS_FIELD_FEATURED;
    }
    if patch.treasury.is_some() {
        changed |= PARAMS_FIELD_TREASURY;
    }
    if patch.buyback_wallet.is_some() {
        changed |= PARAMS_FIELD_BUYBACK;
    }
    if patch.pyth_sol_usd_feed.is_some() {
        changed |= PARAMS_FIELD_PYTH_SOL;
    }
    if patch.pyth_skr_usd_feed.is_some() {
        changed |= PARAMS_FIELD_PYTH_SKR;
    }
    if patch.skr_mint.is_some() {
        changed |= PARAMS_FIELD_SKR_MINT;
    }
    if patch.skr_discount_bps.is_some() {
        changed |= PARAMS_FIELD_SKR_DISCOUNT;
    }
    emit!(ParamsPatched {
        admin: ctx.accounts.admin.key(),
        version: c.params_version,
        changed,
        treasury: c.treasury,
        buyback_wallet: c.buyback_wallet,
        pyth_sol_usd_feed: c.pyth_sol_usd_feed,
        pyth_skr_usd_feed: c.pyth_skr_usd_feed,
        skr_mint: c.skr_mint,
        market_fee_bps: c.market_fee_bps,
        skr_discount_bps: c.skr_discount_bps,
        featured_collection: c.featured_collection,
        packs: patch.packs.is_some(),
    });
    Ok(())
}

/// Admin: pause or un-pause. Un-pausing is admin-only by construction (the pauser has no
/// instruction that writes `paused = false`).
pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
    ctx.accounts.config.paused = paused;
    emit!(PauseChanged {
        by: ctx.accounts.admin.key(),
        paused
    });
    Ok(())
}

/// Admin: designate (or clear with `Pubkey::default()`) the hot pauser key (SEC-H2).
pub fn set_pauser(ctx: Context<AdminOnly>, pauser: Pubkey) -> Result<()> {
    ctx.accounts.config.pauser = pauser;
    emit!(PauserChanged {
        by: ctx.accounts.admin.key(),
        pauser
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Pause<'info> {
    /// Either the configured pauser or the admin.
    pub authority: Signer<'info>,
    #[account(
        mut, seeds = [b"config"], bump = config.bump,
        constraint = authority.key() == config.admin || (config.pauser != Pubkey::default() && authority.key() == config.pauser) @ ChipError::Unauthorized,
    )]
    pub config: Box<Account<'info, GameConfig>>,
}

/// Emergency stop (SEC-H2): pauser **or** admin, `paused = true` only, idempotent. No timelock:
/// the pauser is a 1/3 hot multisig, the runbook target is ≤ 10 min from alert to pause.
pub fn pause(ctx: Context<Pause>) -> Result<()> {
    ctx.accounts.config.paused = true;
    emit!(PauseChanged {
        by: ctx.accounts.authority.key(),
        paused: true
    });
    Ok(())
}

pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
    ctx.accounts.config.pending_admin = new_admin;
    emit!(AdminProposed {
        by: ctx.accounts.admin.key(),
        new_admin
    });
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, constraint = config.pending_admin == new_admin.key() @ ChipError::Unauthorized)]
    pub config: Box<Account<'info, GameConfig>>,
}

pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let c = &mut ctx.accounts.config;
    let old_admin = c.admin;
    c.admin = c.pending_admin;
    c.pending_admin = Pubkey::default();
    emit!(AdminAccepted {
        old_admin,
        new_admin: c.admin
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Grant boosters (quest rewards) — only via the staking program's reward
// claim path (CPI) or admin for support cases. Boosters are never sold.
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct GrantBooster<'info> {
    pub authority: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, GameConfig>>,
    /// CHECK: any wallet
    pub owner: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW013, SW016
    #[account(init_if_needed, payer = payer, space = 8 + PlayerItems::INIT_SPACE, seeds = [b"items", owner.key().as_ref()], bump)]
    pub items: Box<Account<'info, PlayerItems>>,
    pub system_program: Program<'info, System>,
}

pub fn grant_booster(ctx: Context<GrantBooster>, count: u16) -> Result<()> {
    let c = &ctx.accounts.config;
    // authority = admin (support) or the staking program's reward-signer PDA ["rewarder"] (quest claims)
    let (rewarder, _) = Pubkey::find_program_address(&[b"rewarder"], &c.staking_program);
    let a = ctx.accounts.authority.key();
    require!(a == c.admin || a == rewarder, ChipError::Unauthorized);
    require!(count <= 10, ChipError::InvalidQuantity);
    let items = &mut ctx.accounts.items;
    if items.owner == Pubkey::default() {
        items.owner = ctx.accounts.owner.key();
        items.bump = ctx.bumps.items;
    }
    require_keys_eq!(
        items.owner,
        ctx.accounts.owner.key(),
        ChipError::Unauthorized
    );
    items.boosters = items
        .boosters
        .checked_add(count)
        .ok_or(ChipError::Overflow)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(byte: u8) -> Pubkey {
        Pubkey::new_from_array([byte; 32])
    }

    /// SEC-B22: the zero key is not a destination. Every address in the patch that can move money or
    /// choose a price source must be rejected before it reaches `GameConfig`.
    #[test]
    fn zero_addresses_are_rejected_for_every_money_or_feed_field() {
        assert!(require_non_default(key(1)).is_ok());
        let err = require_non_default(Pubkey::default()).expect_err("zero key must be rejected");
        match err {
            anchor_lang::error::Error::AnchorError(e) => {
                assert_eq!(
                    e.error_code_number,
                    u32::from(ChipError::InvalidConfigAddress)
                )
            }
            other => panic!("unexpected error {other:?}"),
        }
    }

    /// The mask is the audit trail's index into the event: one bit per patch field, no bits shared.
    #[test]
    fn field_mask_bits_are_distinct_and_cover_every_patch_field() {
        let bits = [
            PARAMS_FIELD_PACKS,
            PARAMS_FIELD_MARKET_FEE,
            PARAMS_FIELD_FEATURED,
            PARAMS_FIELD_TREASURY,
            PARAMS_FIELD_BUYBACK,
            PARAMS_FIELD_PYTH_SOL,
            PARAMS_FIELD_PYTH_SKR,
            PARAMS_FIELD_SKR_MINT,
            PARAMS_FIELD_SKR_DISCOUNT,
        ];
        let mut union = 0u16;
        for (i, b) in bits.iter().enumerate() {
            assert_eq!(b.count_ones(), 1, "bit {i} is not a single bit");
            assert_eq!(union & b, 0, "bit {i} collides with an earlier field");
            union |= b;
        }
        // `ParamsPatch` has exactly these nine `Option` fields — a tenth field added without a bit
        // would make the emitted `changed` mask lie by omission.
        assert_eq!(bits.len(), 9);
    }
}
