//! Chip-state transitions used by other programs (market, staking) and by
//! the player (thaw after lock). The freeze itself is a Metaplex Core
//! PermanentFreezeDelegate update signed by the collection PDA — so the
//! asset really cannot move, regardless of what wallet UI a user tries.
//!
//! Callers: `set_chip_flag` is CPI-only from the market/staking programs,
//! authenticated by their PDA signer (["market_auth"] / ["stake_auth"]).

use anchor_lang::prelude::*;
use mpl_core::{
    accounts::BaseAssetV1,
    instructions::UpdatePluginV1CpiBuilder,
    types::{PermanentFreezeDelegate, Plugin},
    ID as MPL_CORE_ID,
};

use crate::errors::ChipError;
use crate::state::*;

pub const MARKET_PROGRAM_ID: Pubkey = pubkey!("5skEmmhgFYn5xjHEdrcsiQ68kUg5kvhXKhjWTWSppjfo");
pub const STAKING_PROGRAM_ID: Pubkey = pubkey!("Ewkbp7WpqbiJAu3ofEcTPinqnr5oH3e94YJDZFg1eSJn");

/// Core asset accounts are unchecked because mpl-core does not expose an
/// Anchor account type. Keep the owner check next to the parser so every
/// caller gets the same protection before interpreting arbitrary bytes.
fn load_core_asset(asset: &AccountInfo<'_>) -> Result<BaseAssetV1> {
    require_keys_eq!(*asset.owner, MPL_CORE_ID, ChipError::NotAssetOwner);
    BaseAssetV1::from_bytes(&asset.try_borrow_data()?).map_err(|_| error!(ChipError::NotAssetOwner))
}

#[derive(Accounts)]
pub struct SetChipFlag<'info> {
    /// PDA signer of the calling program (market_auth / stake_auth).
    pub caller: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, GameConfig>>,
    /// CHECK: Core asset
    #[account(mut, owner = MPL_CORE_ID)]
    pub asset: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"chip", asset.key().as_ref()], bump = chip.bump, has_one = asset)]
    pub chip: Box<Account<'info, ChipState>>,
    #[account(seeds = [b"collection", &[chip.collection_idx]], bump = meta.bump)]
    pub meta: Box<Account<'info, CollectionMeta>>,
    /// CHECK:
    #[account(mut, address = meta.core_collection)]
    pub core_collection: UncheckedAccount<'info>,
    /// CHECK: Metaplex Core
    #[account(address = MPL_CORE_ID)]
    pub mpl_core: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

fn expected_caller(flag: u8) -> Result<(Pubkey, &'static [u8])> {
    match flag {
        ChipState::F_LISTED => Ok((MARKET_PROGRAM_ID, b"market_auth")),
        ChipState::F_STAKED => Ok((STAKING_PROGRAM_ID, b"stake_auth")),
        _ => err!(ChipError::InvalidChipState),
    }
}

/// set = true → freeze + set flag; set = false → unfreeze + clear flag.
/// `expected_owner` is checked against the Core asset owner so a program
/// can't flag a chip its user doesn't own.
pub fn set_chip_flag(
    ctx: Context<SetChipFlag>,
    flag: u8,
    set: bool,
    expected_owner: Pubkey,
) -> Result<()> {
    let (prog, seed) = expected_caller(flag)?;
    let (auth, _) = Pubkey::find_program_address(&[seed], &prog);
    require_keys_eq!(ctx.accounts.caller.key(), auth, ChipError::NotProgramCaller);

    let base = load_core_asset(&ctx.accounts.asset.to_account_info())?;
    require_keys_eq!(base.owner, expected_owner, ChipError::NotAssetOwner);

    let now = Clock::get()?.unix_timestamp;
    let chip = &mut ctx.accounts.chip;
    if set {
        require!(chip.is_free(now), ChipError::ChipNotFree);
        chip.flags |= flag;
    } else {
        require!(chip.flags & flag != 0, ChipError::InvalidChipState);
        chip.flags &= !flag;
    }
    let still_frozen = set
        || chip.flags & (ChipState::F_STAKED | ChipState::F_LISTED | ChipState::F_FUSING) != 0
        || now < chip.lock_until;
    let seeds: &[&[u8]] = &[
        b"collection",
        &[chip.collection_idx],
        &[ctx.accounts.meta.bump],
    ];
    UpdatePluginV1CpiBuilder::new(&ctx.accounts.mpl_core.to_account_info())
        .asset(&ctx.accounts.asset.to_account_info())
        .collection(Some(&ctx.accounts.core_collection.to_account_info()))
        .authority(Some(&ctx.accounts.meta.to_account_info()))
        .payer(&ctx.accounts.payer.to_account_info())
        .system_program(&ctx.accounts.system_program.to_account_info())
        .plugin(Plugin::PermanentFreezeDelegate(PermanentFreezeDelegate {
            frozen: still_frozen,
        }))
        .invoke_signed(&[seeds])?;
    emit!(ChipFlagsChanged {
        asset: chip.asset,
        flags: chip.flags,
        lock_until: chip.lock_until
    });
    Ok(())
}

// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct ThawChip<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, GameConfig>>,
    /// CHECK: Core asset owned by `owner`
    #[account(mut, owner = MPL_CORE_ID)]
    pub asset: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"chip", asset.key().as_ref()], bump = chip.bump, has_one = asset)]
    pub chip: Box<Account<'info, ChipState>>,
    #[account(seeds = [b"collection", &[chip.collection_idx]], bump = meta.bump)]
    pub meta: Box<Account<'info, CollectionMeta>>,
    /// CHECK:
    #[account(mut, address = meta.core_collection)]
    pub core_collection: UncheckedAccount<'info>,
    /// CHECK: Metaplex Core
    #[account(address = MPL_CORE_ID)]
    pub mpl_core: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// After a soulbound / fusion-result lock expires the owner (or anyone
/// paying the fee on their behalf) lifts the Core freeze.
pub fn thaw_chip(ctx: Context<ThawChip>) -> Result<()> {
    let base = load_core_asset(&ctx.accounts.asset.to_account_info())?;
    require_keys_eq!(
        base.owner,
        ctx.accounts.owner.key(),
        ChipError::NotAssetOwner
    );
    let now = Clock::get()?.unix_timestamp;
    let chip = &mut ctx.accounts.chip;
    require!(now >= chip.lock_until, ChipError::StillLocked);
    require!(
        chip.flags & (ChipState::F_STAKED | ChipState::F_LISTED | ChipState::F_FUSING) == 0,
        ChipError::ChipNotFree
    );
    chip.flags &= !ChipState::F_SOULBOUND;
    let seeds: &[&[u8]] = &[
        b"collection",
        &[chip.collection_idx],
        &[ctx.accounts.meta.bump],
    ];
    UpdatePluginV1CpiBuilder::new(&ctx.accounts.mpl_core.to_account_info())
        .asset(&ctx.accounts.asset.to_account_info())
        .collection(Some(&ctx.accounts.core_collection.to_account_info()))
        .authority(Some(&ctx.accounts.meta.to_account_info()))
        .payer(&ctx.accounts.owner.to_account_info())
        .system_program(&ctx.accounts.system_program.to_account_info())
        .plugin(Plugin::PermanentFreezeDelegate(PermanentFreezeDelegate {
            frozen: false,
        }))
        .invoke_signed(&[seeds])?;
    emit!(ChipFlagsChanged {
        asset: chip.asset,
        flags: chip.flags,
        lock_until: chip.lock_until
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Market settlement: deliver a listed (frozen) chip to the buyer and clear
// the LISTED flag in one CPI. Only the market program's PDA may call it, and
// only for chips currently flagged LISTED — so this is not a generic
// "transfer anyone's chip" backdoor.
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct DeliverSold<'info> {
    /// ["market_auth"] PDA of the market program
    pub caller: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, GameConfig>>,
    /// CHECK: Core asset
    #[account(mut, owner = MPL_CORE_ID)]
    pub asset: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"chip", asset.key().as_ref()], bump = chip.bump, has_one = asset)]
    pub chip: Box<Account<'info, ChipState>>,
    #[account(seeds = [b"collection", &[chip.collection_idx]], bump = meta.bump)]
    pub meta: Box<Account<'info, CollectionMeta>>,
    /// CHECK:
    #[account(mut, address = meta.core_collection)]
    pub core_collection: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: new owner wallet
    pub new_owner: UncheckedAccount<'info>,
    /// CHECK: Metaplex Core
    #[account(address = MPL_CORE_ID)]
    pub mpl_core: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn deliver_sold(ctx: Context<DeliverSold>, expected_seller: Pubkey) -> Result<()> {
    let (auth, _) = Pubkey::find_program_address(&[b"market_auth"], &MARKET_PROGRAM_ID);
    require_keys_eq!(ctx.accounts.caller.key(), auth, ChipError::NotProgramCaller);
    let base = load_core_asset(&ctx.accounts.asset.to_account_info())?;
    require_keys_eq!(base.owner, expected_seller, ChipError::NotAssetOwner);
    let chip = &mut ctx.accounts.chip;
    require!(
        chip.flags & ChipState::F_LISTED != 0,
        ChipError::InvalidChipState
    );
    chip.flags &= !ChipState::F_LISTED;

    let seeds: &[&[u8]] = &[
        b"collection",
        &[chip.collection_idx],
        &[ctx.accounts.meta.bump],
    ];
    let mpl = ctx.accounts.mpl_core.to_account_info();
    // 1) unfreeze, 2) move via PermanentTransferDelegate (authority = collection PDA)
    UpdatePluginV1CpiBuilder::new(&mpl)
        .asset(&ctx.accounts.asset.to_account_info())
        .collection(Some(&ctx.accounts.core_collection.to_account_info()))
        .authority(Some(&ctx.accounts.meta.to_account_info()))
        .payer(&ctx.accounts.payer.to_account_info())
        .system_program(&ctx.accounts.system_program.to_account_info())
        .plugin(Plugin::PermanentFreezeDelegate(PermanentFreezeDelegate {
            frozen: false,
        }))
        .invoke_signed(&[seeds])?;
    mpl_core::instructions::TransferV1CpiBuilder::new(&mpl)
        .asset(&ctx.accounts.asset.to_account_info())
        .collection(Some(&ctx.accounts.core_collection.to_account_info()))
        .authority(Some(&ctx.accounts.meta.to_account_info()))
        .payer(&ctx.accounts.payer.to_account_info())
        .new_owner(&ctx.accounts.new_owner.to_account_info())
        .system_program(Some(&ctx.accounts.system_program.to_account_info()))
        .invoke_signed(&[seeds])?;
    emit!(ChipFlagsChanged {
        asset: chip.asset,
        flags: chip.flags,
        lock_until: chip.lock_until
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// NOTE (H2): the former `level_up` instruction was removed — its only
// authorized caller (the arena program's `arena_auth` PDA) never implemented
// the XP claim, so no level could ever change and the privileged entrypoint
// was dead code. Every chip mints at level 1; `max_level` stays in the
// rarity profile for the future XP system, which must ship WITH its caller.
// ---------------------------------------------------------------------------
