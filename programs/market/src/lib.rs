//! GUTTERCAPS — market
//!
//! Freeze-in-place marketplace. The production flow is the Bubblegum V2 asset
//! market: `list_compressed_asset` / `cancel_compressed_asset` /
//! `buy_compressed_asset` trade a registered compressed leaf. The leaf never
//! leaves the seller's wallet while listed (the claim's `listed` flag is the
//! lock, not a freeze delegate), there is no escrow account to drain, and the
//! buyer's lamports are split and transferred before the Bubblegum
//! `TransferV2` CPI settles ownership.
//!
//! Fee model v2 (docs/02-economy.md §7, Phase 5): price → 90 % seller,
//! protocol fee `GameConfig.market_fee_bps` (default 7.5 %, hard cap 10 %,
//! live-tunable by the multisig) split ⅓ buyback-wallet / ⅔ treasury, plus
//! 2.5 % creator royalty (treasury).
//!
//! Currency: SOL only. Every market instruction here settles by lamport
//! transfer and `require_sol_claim_market` refuses anything else (SEC-B28), so
//! there is no SPL leg to get wrong.
//!
//! Retained Core paths (`update_price`, `accept_offer`) operate on accounts
//! that the fail-closed `open_pack` can no longer create — see report §5.4.
//!
//! Security: seller-signed listing; buyer pins the price it was shown and the
//! tx fails with `ListingPriceChanged` if the seller relisted higher in the
//! same slot (SEC-F5); settlement re-derives the leaf id, the tree config and
//! the collection hash from the listing and the registered projection before
//! any lamport moves; `chip_core::transfer_compressed_claim` only works when
//! called by ["market_auth"].

#![allow(clippy::result_large_err)]

use anchor_lang::prelude::*;
use anchor_lang::system_program;
// 2026-10-01: the Core-market deletion took the only `Program<'info, AssociatedToken>` field with
// it. The surviving `accept_offer` context still carries an `associated_token::` constraint, which
// Anchor resolves through the `#[account]` attribute namespace and needs no import for.
use anchor_spl::token::{self, Token, TokenAccount};
use mpl_bubblegum::instructions::TransferV2CpiBuilder;
use mpl_core::accounts::BaseAssetV1;

use chip_core::bubblegum::{leaf_asset_id, LeafProofArgs, MPL_ACCOUNT_COMPRESSION_ID, MPL_NOOP_ID};
use chip_core::cpi::accounts::{
    DeliverSold, SetChipFlag, SetCompressedClaimListed, TransferCompressedClaim,
};
use chip_core::program::ChipCore;
use chip_core::state::{
    ChipState, CollectionMeta, CompressedChipState, CompressedMintClaim, GameConfig,
};

declare_id!("GCA2aUeX7ZFbGz3zvjqvsbjD1G3QjWxLhBpK5jwwPdcz");

pub const LISTING_FEE_CG: u64 = 500_000; // 0.5 $CG (6 dp)
/// Default protocol fee; the live value is `GameConfig.market_fee_bps` (≤ MAX_MARKET_FEE_BPS = 10 %).
pub const FEE_BPS: u16 = 750;
/// Share of the protocol fee that goes to the buyback-burn wallet; the rest → treasury.
pub const FEE_BUYBACK_SHARE_BPS: u64 = 3_333;
pub const ROYALTY_BPS: u16 = 250;
pub const BPS: u64 = 10_000;
pub const MIN_PRICE_LAMPORTS: u64 = 1_000_000; // 0.001 SOL
pub const MIN_PRICE_USDC: u64 = 100_000; // $0.10
pub const MIN_PRICE_SKR: u64 = 5_000_000; // 5 SKR (≈ $0.10 at listing time; floor is only an anti-dust guard)

/// `asset` is unchecked because Metaplex Core assets are not Anchor accounts.
/// Verify the program owner before parsing bytes, so malformed or foreign
/// accounts cannot be treated as marketplace NFTs.
fn load_core_asset(asset: &AccountInfo<'_>) -> Result<BaseAssetV1> {
    require_keys_eq!(*asset.owner, mpl_core::ID, MarketError::NotOwner);
    BaseAssetV1::from_bytes(&asset.try_borrow_data()?).map_err(|_| error!(MarketError::NotOwner))
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
#[repr(u8)]
pub enum Currency {
    Sol = 0,
    Usdc = 1,
    // No `= 3`: borsh-derive ignores explicit discriminants (they need `#[borsh(use_discriminant = true)]`,
    // which anchor's AnchorSerialize does not route through), so the wire tag is the variant INDEX
    // 0/1/2. The `= 3` was inherited from chip_core's four-variant Currency { Sol, Usdc, Cg, Skr },
    // where 3 happens to equal the index — here it made the client send 3 for SKR and the program
    // reject it with InstructionDidNotDeserialize (M01's list in SKR).
    Skr = 2,
}

impl Currency {
    pub fn min_price(self) -> u64 {
        match self {
            Currency::Sol => MIN_PRICE_LAMPORTS,
            Currency::Usdc => MIN_PRICE_USDC,
            Currency::Skr => MIN_PRICE_SKR,
        }
    }
    /// Mint of the SPL leg for this currency (None for SOL).
    pub fn mint(self, cfg: &GameConfig) -> Option<Pubkey> {
        match self {
            Currency::Sol => None,
            Currency::Usdc => Some(cfg.usdc_mint),
            Currency::Skr => Some(cfg.skr_mint),
        }
    }
}

#[account]
#[derive(InitSpace)]
pub struct Listing {
    pub asset: Pubkey,
    pub seller: Pubkey,
    pub price: u64,
    pub currency: Currency,
    pub created_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Offer {
    pub asset: Pubkey,
    pub bidder: Pubkey,
    pub amount_usdc: u64,
    pub expires_at: i64,
    pub bump: u8,
}

#[event]
pub struct ChipListed {
    pub asset: Pubkey,
    pub seller: Pubkey,
    pub price: u64,
    pub currency: u8,
}
#[event]
pub struct ListingUpdated {
    pub asset: Pubkey,
    pub price: u64,
}
#[event]
pub struct ListingCancelled {
    pub asset: Pubkey,
}
#[event]
pub struct ChipSold {
    pub asset: Pubkey,
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub price: u64,
    pub currency: u8,
    pub fee: u64,
    pub royalty: u64,
    pub via_offer: bool,
}
#[event]
pub struct OfferMade {
    pub asset: Pubkey,
    pub bidder: Pubkey,
    pub amount: u64,
    pub expires_at: i64,
}
#[event]
pub struct OfferCancelled {
    pub asset: Pubkey,
    pub bidder: Pubkey,
}

#[error_code]
pub enum MarketError {
    #[msg("Price below minimum")]
    PriceTooLow,
    #[msg("Not the asset owner")]
    NotOwner,
    #[msg("Not the seller")]
    NotSeller,
    #[msg("Currency mismatch")]
    CurrencyMismatch,
    #[msg("Offer expired")]
    OfferExpired,
    #[msg("Offer TTL too long")]
    TtlTooLong,
    #[msg("Cannot buy your own listing")]
    SelfTrade,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Chip is soulbound / time-locked")]
    ChipLocked,
    #[msg("Missing token accounts for this currency")]
    MissingAccounts,
    #[msg("Compressed claim is not tradable")]
    CompressedClaimNotTradable,
    #[msg("Compressed listing expects SOL")]
    CompressedCurrencyMismatch,
    #[msg("Invalid treasury address")]
    InvalidTreasury,
    #[msg("Invalid buyback wallet address")]
    InvalidBuyback,
    #[msg("Listing price changed since it was quoted")]
    ListingPriceChanged,
}

/// `fee_bps` comes from GameConfig (live-tunable, ≤ 10 %); royalty is fixed at mint time.
fn split(price: u64, fee_bps: u16) -> Result<(u64, u64, u64, u64)> {
    let fee_bps = fee_bps.min(chip_core::economy::MAX_MARKET_FEE_BPS);
    // Do the basis-point products in a wider domain. The resulting amounts are
    // bounded by `price`, so converting back to u64 is safe after division.
    let fee = ((price as u128)
        .checked_mul(fee_bps as u128)
        .ok_or(MarketError::Overflow)?
        / BPS as u128) as u64;
    let royalty = ((price as u128)
        .checked_mul(ROYALTY_BPS as u128)
        .ok_or(MarketError::Overflow)?
        / BPS as u128) as u64;
    let seller = price
        .checked_sub(fee)
        .and_then(|v| v.checked_sub(royalty))
        .ok_or(MarketError::Overflow)?;
    // Keep every intermediate in u128. `fee` itself is checked above, but multiplying a
    // near-u64::MAX fee by the buyback share can overflow before the division. A sale
    // must either settle with the exact split or fail deterministically — never wrap.
    let fee_buyback = ((fee as u128)
        .checked_mul(FEE_BUYBACK_SHARE_BPS as u128)
        .ok_or(MarketError::Overflow)?
        / BPS as u128) as u64;
    let fee_treasury = fee.checked_sub(fee_buyback).ok_or(MarketError::Overflow)?;
    Ok((seller, fee_buyback, fee_treasury, royalty))
}

/// The claim market settles in SOL only: `buy_compressed` / `buy_compressed_asset` pay the seller with
/// `system_program::transfer`, and the generic SPL legs of the legacy `buy` were never wired into this
/// path — so the buy side has always answered `CompressedCurrencyMismatch` for a USDC/SKR listing.
/// Accepting such a listing anyway was worse than a rejected transaction: `list_compressed` created the
/// listing PDA, flagged the claim `listed` (chip_core then refuses `mint_compressed_chip` and fusion for
/// it with `InvalidChipState`) and left the claim flagged with an unfillable listing on chain — a
/// self-inflicted lockout that a *seller* could trigger from any UI that offered the currencies the docs
/// listed. The currency is now checked in both list handlers, and the buy side keeps its own check
/// as defense in depth for a listing created before this guard (a failed transaction reverts, so a
/// refused listing leaves neither the PDA nor the flag). Relaxing this is a feature: it needs the SPL
/// legs in `buy_compressed*`, not just the removal of the check (SEC-B28).
fn require_sol_claim_market(currency: Currency) -> Result<()> {
    require!(
        currency == Currency::Sol,
        MarketError::CompressedCurrencyMismatch
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Shared CPI helper: flag/unflag through chip_core
// ---------------------------------------------------------------------------

struct FlagAccounts<'a, 'info> {
    chip_core: &'a Program<'info, ChipCore>,
    market_auth: &'a AccountInfo<'info>,
    payer: &'a AccountInfo<'info>,
    config: &'a AccountInfo<'info>,
    asset: &'a AccountInfo<'info>,
    chip: &'a AccountInfo<'info>,
    meta: &'a AccountInfo<'info>,
    core_collection: &'a AccountInfo<'info>,
    mpl_core: &'a AccountInfo<'info>,
    system_program: &'a AccountInfo<'info>,
}

fn set_listed(a: FlagAccounts, bump: u8, set: bool, owner: Pubkey) -> Result<()> {
    let seeds: &[&[u8]] = &[b"market_auth", &[bump]];
    chip_core::cpi::set_chip_flag(
        CpiContext::new_with_signer(
            a.chip_core.to_account_info(),
            SetChipFlag {
                caller: a.market_auth.clone(),
                payer: a.payer.clone(),
                config: a.config.clone(),
                asset: a.asset.clone(),
                chip: a.chip.clone(),
                meta: a.meta.clone(),
                core_collection: a.core_collection.clone(),
                mpl_core: a.mpl_core.clone(),
                system_program: a.system_program.clone(),
            },
            &[seeds],
        ),
        ChipState::F_LISTED,
        set,
        owner,
    )
}

// ---------------------------------------------------------------------------
// update_price
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct UpdatePrice<'info> {
    pub seller: Signer<'info>,
    #[account(mut, seeds = [b"listing", listing.asset.as_ref()], bump = listing.bump, has_one = seller @ MarketError::NotSeller)]
    pub listing: Account<'info, Listing>,
}

pub fn update_price_handler(ctx: Context<UpdatePrice>, price: u64) -> Result<()> {
    let l = &mut ctx.accounts.listing;
    require!(price >= l.currency.min_price(), MarketError::PriceTooLow);
    l.price = price;
    emit!(ListingUpdated {
        asset: l.asset,
        price
    });
    Ok(())
}

/// Seller accepts an offer on an UNLISTED chip they own (listed chips must be
/// cancelled first — keeps one code path for delivery). The chip is flagged
/// LISTED and delivered in the same tx, so `deliver_sold`'s invariant holds.
#[derive(Accounts)]
pub struct AcceptOffer<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    /// CHECK: bidder gets the chip and the escrow rent
    #[account(mut, address = offer.bidder)]
    pub bidder: UncheckedAccount<'info>,
    #[account(mut, close = bidder, seeds = [b"offer", asset.key().as_ref(), bidder.key().as_ref()], bump = offer.bump, has_one = asset)]
    pub offer: Box<Account<'info, Offer>>,
    #[account(mut, associated_token::mint = config.usdc_mint, associated_token::authority = offer)]
    pub escrow: Box<Account<'info, TokenAccount>>,
    // sentio-ignore-next-line SW013
    /// CHECK: ["market_auth"] PDA signer
    #[account(seeds = [b"market_auth"], bump)]
    pub market_auth: UncheckedAccount<'info>,
    /// CHECK: Core asset
    #[account(mut, owner = mpl_core::ID)]
    pub asset: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"chip", asset.key().as_ref()], bump = chip.bump, seeds::program = chip_core::ID)]
    pub chip: Box<Account<'info, ChipState>>,
    #[account(seeds = [b"collection", &[chip.collection_idx]], bump = meta.bump, seeds::program = chip_core::ID)]
    pub meta: Box<Account<'info, CollectionMeta>>,
    /// CHECK:
    #[account(mut, address = meta.core_collection)]
    pub core_collection: UncheckedAccount<'info>,
    #[account(seeds = [b"config"], bump = config.bump, seeds::program = chip_core::ID, has_one = treasury, has_one = buyback_wallet)]
    pub config: Box<Account<'info, GameConfig>>,
    /// CHECK:
    #[account(address = config.treasury @ MarketError::InvalidTreasury)]
    pub treasury: UncheckedAccount<'info>,
    /// CHECK:
    #[account(address = config.buyback_wallet @ MarketError::InvalidBuyback)]
    pub buyback_wallet: UncheckedAccount<'info>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = seller)]
    pub seller_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = treasury)]
    pub treasury_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = buyback_wallet)]
    pub buyback_usdc: Box<Account<'info, TokenAccount>>,
    pub chip_core: Program<'info, ChipCore>,
    /// CHECK:
    #[account(address = mpl_core::ID)]
    pub mpl_core: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn accept_offer_handler(ctx: Context<AcceptOffer>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let o = &ctx.accounts.offer;
    require!(now <= o.expires_at, MarketError::OfferExpired);
    let base = load_core_asset(&ctx.accounts.asset.to_account_info())?;
    require_keys_eq!(base.owner, ctx.accounts.seller.key(), MarketError::NotOwner);
    // SEC-F08: accepting your own offer fakes a sale (floor/history manipulation) — `buy` has had
    // this guard since day one; it was simply missing here.
    require!(
        o.bidder != ctx.accounts.seller.key(),
        MarketError::SelfTrade
    );
    require!(
        ctx.accounts.chip.flags & ChipState::F_LISTED == 0,
        MarketError::ChipLocked
    );
    require!(
        now >= ctx.accounts.chip.lock_until
            && ctx.accounts.chip.flags & ChipState::F_SOULBOUND == 0,
        MarketError::ChipLocked
    );

    let price = o.amount_usdc;
    let (to_seller, fee_bb, fee_tr, royalty) = split(price, ctx.accounts.config.market_fee_bps)?;
    let (asset, bidder, bump) = (o.asset, o.bidder, o.bump);
    let seeds: &[&[u8]] = &[b"offer", asset.as_ref(), bidder.as_ref(), &[bump]];
    let tp = ctx.accounts.token_program.to_account_info();
    let legs = [
        (ctx.accounts.seller_usdc.to_account_info(), to_seller),
        (ctx.accounts.buyback_usdc.to_account_info(), fee_bb),
        (
            ctx.accounts.treasury_usdc.to_account_info(),
            fee_tr + royalty,
        ),
    ];
    for (to, amt) in legs {
        if amt > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    tp.clone(),
                    token::Transfer {
                        from: ctx.accounts.escrow.to_account_info(),
                        to,
                        authority: o.to_account_info(),
                    },
                    &[seeds],
                ),
                amt,
            )?;
        }
    }
    token::close_account(CpiContext::new_with_signer(
        tp.clone(),
        token::CloseAccount {
            account: ctx.accounts.escrow.to_account_info(),
            destination: ctx.accounts.bidder.to_account_info(),
            authority: o.to_account_info(),
        },
        &[seeds],
    ))?;

    // flag LISTED then deliver (both via market_auth).
    //
    // This used to be a closure (`let fa = |payer| FlagAccounts { … }`) shared with the deliver path, and it
    // could not be made to typecheck: `FlagAccounts<'a, 'info>` holds `&'a AccountInfo<'info>` for every
    // field, so `&ctx.accounts.config.to_account_info()` is a reference to a temporary (E0515), and even
    // hoisting the handles into the closure body only trades that for E0597 — a binding inside the closure is
    // still not the `'a` the returned struct needs. A closure cannot name the environment lifetime its
    // return value borrows from, which is the whole reason the second error existed.
    //
    // It had exactly one call site, so the honest shape is the plain literal: handles hoisted to the
    // function body, one borrow each, no lifetime to infer. (If a second caller ever needs it, the reusable
    // form is a `fn` taking `&Context<'_, '_, 'info, 'info, …>` — not a closure.)
    let market_auth_ai = ctx.accounts.market_auth.to_account_info();
    let config_ai = ctx.accounts.config.to_account_info();
    let asset_ai = ctx.accounts.asset.to_account_info();
    let chip_ai = ctx.accounts.chip.to_account_info();
    let meta_ai = ctx.accounts.meta.to_account_info();
    let core_collection_ai = ctx.accounts.core_collection.to_account_info();
    let mpl_core_ai = ctx.accounts.mpl_core.to_account_info();
    let system_program_ai = ctx.accounts.system_program.to_account_info();
    let seller_ai = ctx.accounts.seller.to_account_info();
    set_listed(
        FlagAccounts {
            chip_core: &ctx.accounts.chip_core,
            market_auth: &market_auth_ai,
            payer: &seller_ai,
            config: &config_ai,
            asset: &asset_ai,
            chip: &chip_ai,
            meta: &meta_ai,
            core_collection: &core_collection_ai,
            mpl_core: &mpl_core_ai,
            system_program: &system_program_ai,
        },
        ctx.bumps.market_auth,
        true,
        ctx.accounts.seller.key(),
    )?;
    let ma_seeds: &[&[u8]] = &[b"market_auth", &[ctx.bumps.market_auth]];
    chip_core::cpi::deliver_sold(
        CpiContext::new_with_signer(
            ctx.accounts.chip_core.to_account_info(),
            DeliverSold {
                caller: ctx.accounts.market_auth.to_account_info(),
                payer: ctx.accounts.seller.to_account_info(),
                config: ctx.accounts.config.to_account_info(),
                asset: ctx.accounts.asset.to_account_info(),
                chip: ctx.accounts.chip.to_account_info(),
                meta: ctx.accounts.meta.to_account_info(),
                core_collection: ctx.accounts.core_collection.to_account_info(),
                new_owner: ctx.accounts.bidder.to_account_info(),
                mpl_core: ctx.accounts.mpl_core.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
            &[ma_seeds],
        ),
        ctx.accounts.seller.key(),
    )?;
    emit!(ChipSold {
        asset,
        seller: ctx.accounts.seller.key(),
        buyer: bidder,
        price,
        currency: Currency::Usdc as u8,
        fee: fee_bb + fee_tr,
        royalty,
        via_offer: true
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Bubblegum V2 claim marketplace. This is intentionally a custom protocol
// surface: it never calls MPL-Core and never fabricates a DAS asset id. The
// claim remains the economic authorization while the compressed leaf is shown
// and transferred by the wallet/indexer integration.

#[account]
#[derive(InitSpace)]
pub struct CompressedListing {
    pub claim: Pubkey,
    pub seller: Pubkey,
    pub price: u64,
    pub currency: Currency,
    pub created_at: i64,
    pub bump: u8,
}

#[event]
pub struct CompressedClaimListed {
    pub claim: Pubkey,
    pub seller: Pubkey,
    pub price: u64,
    pub currency: u8,
}

#[event]
pub struct CompressedClaimSold {
    pub claim: Pubkey,
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub price: u64,
    pub fee: u64,
    pub royalty: u64,
}

#[derive(Accounts)]
pub struct ListCompressed<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(
        init,
        payer = seller,
        space = 8 + CompressedListing::INIT_SPACE,
        seeds = [b"compressed_listing", claim.key().as_ref()],
        bump,
    )]
    pub listing: Account<'info, CompressedListing>,
    #[account(mut)]
    pub claim: Account<'info, CompressedMintClaim>,
    // sentio-ignore-next-line SW013
    /// CHECK: PDA signer recognized by chip_core for compressed claim transitions.
    #[account(seeds = [b"market_auth"], bump)]
    pub market_auth: UncheckedAccount<'info>,
    pub chip_core: Program<'info, ChipCore>,
    pub system_program: Program<'info, System>,
}

pub fn list_compressed_handler(
    ctx: Context<ListCompressed>,
    price: u64,
    currency: Currency,
) -> Result<()> {
    // SEC-B28: the claim market is SOL-only. Checked before the price so a caller that lists in a
    // currency this path cannot settle is told *that*, whatever price they sent.
    require_sol_claim_market(currency)?;
    require!(price >= currency.min_price(), MarketError::PriceTooLow);
    let claim = &ctx.accounts.claim;
    require!(
        claim.buyer == ctx.accounts.seller.key()
            && !claim.minted
            && !claim.consumed
            && !claim.listed
            && !claim.staked
            && Clock::get()?.unix_timestamp < claim.expires_at,
        MarketError::CompressedClaimNotTradable
    );
    // Soulbound / fusion-locked claims cannot be listed (the Core `F_SOULBOUND` gate that
    // `list_compressed_asset` mirrors on the asset side).
    require!(
        Clock::get()?.unix_timestamp >= claim.lock_until,
        MarketError::ChipLocked
    );
    let claim_key = claim.key();
    let market_auth_seeds: &[&[u8]] = &[b"market_auth", &[ctx.bumps.market_auth]];
    chip_core::cpi::set_compressed_claim_listed(
        CpiContext::new_with_signer(
            ctx.accounts.chip_core.to_account_info(),
            SetCompressedClaimListed {
                caller: ctx.accounts.market_auth.to_account_info(),
                claim: ctx.accounts.claim.to_account_info(),
            },
            &[market_auth_seeds],
        ),
        ctx.accounts.seller.key(),
        true,
    )?;
    let listing = &mut ctx.accounts.listing;
    listing.claim = claim_key;
    listing.seller = ctx.accounts.seller.key();
    listing.price = price;
    listing.currency = currency;
    listing.created_at = Clock::get()?.unix_timestamp;
    listing.bump = ctx.bumps.listing;
    emit!(CompressedClaimListed {
        claim: listing.claim,
        seller: listing.seller,
        price,
        currency: currency as u8,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CancelCompressed<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(
        mut,
        close = seller,
        seeds = [b"compressed_listing", claim.key().as_ref()],
        bump = listing.bump,
    )]
    pub listing: Account<'info, CompressedListing>,
    #[account(mut, address = listing.claim)]
    pub claim: Account<'info, CompressedMintClaim>,
    // sentio-ignore-next-line SW013
    /// CHECK: PDA signer recognized by chip_core for compressed claim transitions.
    #[account(seeds = [b"market_auth"], bump)]
    pub market_auth: UncheckedAccount<'info>,
    pub chip_core: Program<'info, ChipCore>,
    pub system_program: Program<'info, System>,
}

pub fn cancel_compressed_handler(ctx: Context<CancelCompressed>) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.listing.seller,
        ctx.accounts.seller.key(),
        MarketError::NotSeller
    );
    require!(
        ctx.accounts.claim.buyer == ctx.accounts.seller.key()
            && ctx.accounts.claim.listed
            && !ctx.accounts.claim.staked,
        MarketError::CompressedClaimNotTradable
    );
    let seeds: &[&[u8]] = &[b"market_auth", &[ctx.bumps.market_auth]];
    chip_core::cpi::set_compressed_claim_listed(
        CpiContext::new_with_signer(
            ctx.accounts.chip_core.to_account_info(),
            SetCompressedClaimListed {
                caller: ctx.accounts.market_auth.to_account_info(),
                claim: ctx.accounts.claim.to_account_info(),
            },
            &[seeds],
        ),
        ctx.accounts.seller.key(),
        false,
    )?;
    Ok(())
}

#[derive(Accounts)]
pub struct BuyCompressed<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(
        mut,
        close = seller,
        seeds = [b"compressed_listing", claim.key().as_ref()],
        bump = listing.bump,
    )]
    pub listing: Account<'info, CompressedListing>,
    #[account(mut, address = listing.claim)]
    pub claim: Account<'info, CompressedMintClaim>,
    /// CHECK: the seller is bound by the listing and receives the seller leg.
    #[account(mut, address = listing.seller)]
    pub seller: UncheckedAccount<'info>,
    /// CHECK: configured protocol destination.
    #[account(mut, address = config.treasury @ MarketError::InvalidTreasury)]
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: configured protocol buyback destination.
    #[account(mut, address = config.buyback_wallet @ MarketError::InvalidBuyback)]
    pub buyback: UncheckedAccount<'info>,
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        seeds::program = chip_core::ID,
        has_one = treasury,
    )]
    pub config: Account<'info, GameConfig>,
    // sentio-ignore-next-line SW013
    /// CHECK: PDA signer recognized by chip_core for compressed claim transitions.
    #[account(seeds = [b"market_auth"], bump)]
    pub market_auth: UncheckedAccount<'info>,
    pub chip_core: Program<'info, ChipCore>,
    pub system_program: Program<'info, System>,
}

pub fn buy_compressed_handler(ctx: Context<BuyCompressed>, expected_price: u64) -> Result<()> {
    let listing = &ctx.accounts.listing;
    // Defense in depth (SEC-B28): `list_compressed` refuses a non-SOL currency now, so this can only
    // fire for a listing that was created before that guard existed.
    require!(
        listing.currency == Currency::Sol,
        MarketError::CompressedCurrencyMismatch
    );
    // SEC-F5 (2026-09-25) front-running guard, same rule as the legacy `buy`: without it the
    // seller could cancel + relist the claim at a higher price in one transaction landing ahead of
    // the buyer's (or bundle it), and the buyer paid whatever the listing said at execution time.
    require!(
        listing.price == expected_price,
        MarketError::ListingPriceChanged
    );
    require!(
        ctx.accounts.buyer.key() != listing.seller,
        MarketError::SelfTrade
    );
    require!(
        ctx.accounts.claim.buyer == listing.seller
            && ctx.accounts.claim.listed
            && !ctx.accounts.claim.minted
            && !ctx.accounts.claim.consumed
            && !ctx.accounts.claim.staked
            && Clock::get()?.unix_timestamp < ctx.accounts.claim.expires_at,
        MarketError::CompressedClaimNotTradable
    );
    let (seller_amount, buyback_amount, treasury_fee, royalty) =
        split(listing.price, ctx.accounts.config.market_fee_bps)?;
    let system_program = ctx.accounts.system_program.to_account_info();
    let buyer = ctx.accounts.buyer.to_account_info();
    for (to, amount) in [
        (ctx.accounts.seller.to_account_info(), seller_amount),
        (ctx.accounts.buyback.to_account_info(), buyback_amount),
        (
            ctx.accounts.treasury.to_account_info(),
            treasury_fee + royalty,
        ),
    ] {
        if amount > 0 {
            system_program::transfer(
                CpiContext::new(
                    system_program.clone(),
                    system_program::Transfer {
                        from: buyer.clone(),
                        to,
                    },
                ),
                amount,
            )?;
        }
    }
    let market_auth_seeds: &[&[u8]] = &[b"market_auth", &[ctx.bumps.market_auth]];
    chip_core::cpi::transfer_compressed_claim(
        CpiContext::new_with_signer(
            ctx.accounts.chip_core.to_account_info(),
            TransferCompressedClaim {
                caller: ctx.accounts.market_auth.to_account_info(),
                claim: ctx.accounts.claim.to_account_info(),
            },
            &[market_auth_seeds],
        ),
        listing.seller,
        ctx.accounts.buyer.key(),
    )?;
    emit!(CompressedClaimSold {
        claim: listing.claim,
        seller: listing.seller,
        buyer: ctx.accounts.buyer.key(),
        price: listing.price,
        fee: buyback_amount + treasury_fee,
        royalty,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Bubblegum V2 asset delivery
// ---------------------------------------------------------------------------

/// A listing for an already-registered V2 leaf. The earlier claim market is
/// intentionally limited to pre-mint authorizations; this account is the
/// actual cNFT delivery path and stores only immutable tree/claim coordinates.
#[account]
#[derive(InitSpace)]
pub struct CompressedAssetListing {
    pub asset: Pubkey,
    pub claim: Pubkey,
    pub seller: Pubkey,
    pub merkle_tree: Pubkey,
    pub tree_config: Pubkey,
    pub core_collection: Pubkey,
    pub collection_idx: u8,
    pub price: u64,
    pub currency: Currency,
    pub created_at: i64,
    pub bump: u8,
}

#[event]
pub struct CompressedAssetListed {
    pub asset: Pubkey,
    pub claim: Pubkey,
    pub seller: Pubkey,
    pub price: u64,
    pub currency: u8,
}

#[event]
pub struct CompressedAssetSold {
    pub asset: Pubkey,
    pub claim: Pubkey,
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub price: u64,
    pub fee: u64,
    pub royalty: u64,
}

#[derive(Accounts)]
pub struct ListCompressedAsset<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    // sentio-ignore-next-line SW013
    #[account(
        init,
        payer = seller,
        space = 8 + CompressedAssetListing::INIT_SPACE,
        seeds = [b"compressed_asset_listing", asset.key().as_ref()],
        bump,
    )]
    pub listing: Account<'info, CompressedAssetListing>,
    // sentio-ignore-next-line SW013
    /// CHECK: Bubblegum asset id; the handler binds it to the registered projection.
    #[account(mut)]
    pub asset: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW013
    #[account(
        mut,
        seeds = [b"compressed_chip", asset.key().as_ref()],
        bump = chip.bump,
        seeds::program = chip_core::ID,
    )]
    pub chip: Account<'info, CompressedChipState>,
    #[account(seeds = [b"collection", &[chip.collection_idx]], bump = collection.bump, seeds::program = chip_core::ID)]
    pub collection: Account<'info, CollectionMeta>,
    #[account(mut, address = chip.claim)]
    pub claim: Account<'info, CompressedMintClaim>,
    // sentio-ignore-next-line SW013
    /// CHECK: PDA signer recognized by chip_core for the claim transition.
    #[account(seeds = [b"market_auth"], bump)]
    pub market_auth: UncheckedAccount<'info>,
    pub chip_core: Program<'info, ChipCore>,
    pub system_program: Program<'info, System>,
}

pub fn list_compressed_asset_handler(
    ctx: Context<ListCompressedAsset>,
    price: u64,
    currency: Currency,
) -> Result<()> {
    // SEC-B28: same rule as `list_compressed` — the V2 asset path is settled by lamport transfers too.
    require_sol_claim_market(currency)?;
    require!(price >= currency.min_price(), MarketError::PriceTooLow);
    require!(
        ctx.accounts.claim.buyer == ctx.accounts.seller.key()
            && ctx.accounts.claim.minted
            && ctx.accounts.claim.registered
            && !ctx.accounts.claim.consumed
            && !ctx.accounts.claim.listed
            && !ctx.accounts.claim.staked,
        MarketError::CompressedClaimNotTradable
    );
    // Soulbound / fusion-locked chips cannot be listed (mirrors the Core
    // `F_SOULBOUND` gate; the claim lock is the authority, the chip copy is
    // checked too so a stale registration cannot bypass it).
    require!(
        Clock::get()?.unix_timestamp >= ctx.accounts.claim.lock_until
            && Clock::get()?.unix_timestamp >= ctx.accounts.chip.lock_until,
        MarketError::ChipLocked
    );
    require_keys_eq!(
        ctx.accounts.chip.asset,
        ctx.accounts.asset.key(),
        MarketError::CompressedClaimNotTradable
    );
    require!(
        ctx.accounts.claim.collection_idx == ctx.accounts.chip.collection_idx
            && ctx.accounts.claim.collection_idx == ctx.accounts.collection.idx,
        MarketError::CompressedClaimNotTradable
    );
    let seeds: &[&[u8]] = &[b"market_auth", &[ctx.bumps.market_auth]];
    chip_core::cpi::set_compressed_claim_listed(
        CpiContext::new_with_signer(
            ctx.accounts.chip_core.to_account_info(),
            SetCompressedClaimListed {
                caller: ctx.accounts.market_auth.to_account_info(),
                claim: ctx.accounts.claim.to_account_info(),
            },
            &[seeds],
        ),
        ctx.accounts.seller.key(),
        true,
    )?;
    let listing = &mut ctx.accounts.listing;
    listing.asset = ctx.accounts.asset.key();
    listing.claim = ctx.accounts.claim.key();
    listing.seller = ctx.accounts.seller.key();
    listing.merkle_tree = ctx.accounts.chip.merkle_tree;
    // TreeConfig is derived from the tree and is re-derived again at settlement.
    listing.tree_config = Pubkey::find_program_address(
        &[ctx.accounts.chip.merkle_tree.as_ref()],
        &chip_core::BUBBLEGUM_V2_ID,
    )
    .0;
    listing.core_collection = ctx.accounts.collection.core_collection;
    listing.collection_idx = ctx.accounts.chip.collection_idx;
    listing.price = price;
    listing.currency = currency;
    listing.created_at = Clock::get()?.unix_timestamp;
    listing.bump = ctx.bumps.listing;
    emit!(CompressedAssetListed {
        asset: listing.asset,
        claim: listing.claim,
        seller: listing.seller,
        price,
        currency: currency as u8,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CancelCompressedAsset<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(
        mut,
        close = seller,
        seeds = [b"compressed_asset_listing", listing.asset.as_ref()],
        bump = listing.bump,
    )]
    pub listing: Account<'info, CompressedAssetListing>,
    #[account(mut, address = listing.claim)]
    pub claim: Account<'info, CompressedMintClaim>,
    // sentio-ignore-next-line SW013
    /// CHECK: PDA signer recognized by chip_core for the claim transition.
    #[account(seeds = [b"market_auth"], bump)]
    pub market_auth: UncheckedAccount<'info>,
    pub chip_core: Program<'info, ChipCore>,
    pub system_program: Program<'info, System>,
}

pub fn cancel_compressed_asset_handler(ctx: Context<CancelCompressedAsset>) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.listing.seller,
        ctx.accounts.seller.key(),
        MarketError::NotSeller
    );
    require!(
        ctx.accounts.claim.buyer == ctx.accounts.seller.key() && ctx.accounts.claim.listed,
        MarketError::CompressedClaimNotTradable
    );
    let seeds: &[&[u8]] = &[b"market_auth", &[ctx.bumps.market_auth]];
    chip_core::cpi::set_compressed_claim_listed(
        CpiContext::new_with_signer(
            ctx.accounts.chip_core.to_account_info(),
            SetCompressedClaimListed {
                caller: ctx.accounts.market_auth.to_account_info(),
                claim: ctx.accounts.claim.to_account_info(),
            },
            &[seeds],
        ),
        ctx.accounts.seller.key(),
        false,
    )?;
    Ok(())
}

#[derive(Accounts)]
#[instruction(delegate: Pubkey)]
// The four `Box<Account<..>>` below are load-bearing. `Account<'info, T>` owns its `T` BY VALUE, so
// every deserialized state account sits in the SBF stack frame — and this context deserializes four
// of them plus fifteen `UncheckedAccount`s, which is ~2.6 KB of a 4096-byte frame before a single
// validation temporary. Under `opt-level = "z"` that overflowed, and `buy_compressed_asset` aborted
// with `Access violation in stack frame 5` on EVERY call — found by
// tests/localnet/32-market-compressed.spec.ts, the first thing ever to execute this handler in
// LiteSVM. Boxing moves the owned state to the heap and takes the frame to ~1.4 KB. The account
// list, the discriminators and the IDL are untouched, so no client sees a difference; this is the
// same remedy `AcceptOffer` already uses for its `GameConfig`.
pub struct BuyCompressedAsset<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(
        mut,
        close = seller,
        seeds = [b"compressed_asset_listing", listing.asset.as_ref()],
        bump = listing.bump,
    )]
    pub listing: Box<Account<'info, CompressedAssetListing>>,
    #[account(mut, address = listing.claim)]
    pub claim: Box<Account<'info, CompressedMintClaim>>,
    #[account(
        mut,
        seeds = [b"compressed_chip", listing.asset.as_ref()],
        bump = chip.bump,
        seeds::program = chip_core::ID,
    )]
    pub chip: Box<Account<'info, CompressedChipState>>,
    #[account(seeds = [b"config"], bump = config.bump, seeds::program = chip_core::ID)]
    pub config: Box<Account<'info, GameConfig>>,
    /// CHECK: treasury address is constrained to the immutable game configuration.
    #[account(mut, address = config.treasury @ MarketError::InvalidTreasury)]
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: buyback address is constrained to the immutable game configuration.
    #[account(mut, address = config.buyback_wallet @ MarketError::InvalidBuyback)]
    pub buyback: UncheckedAccount<'info>,
    /// CHECK: seller address is constrained to the listing seller.
    #[account(mut, address = listing.seller)]
    pub seller: UncheckedAccount<'info>,
    /// CHECK: current owner of the leaf, bound to the stored listing seller.
    #[account(address = listing.seller)]
    pub leaf_owner: UncheckedAccount<'info>,
    /// CHECK: current delegate, bound to the explicit DAS proof input.
    #[account(address = delegate)]
    pub leaf_delegate: UncheckedAccount<'info>,
    /// CHECK: tree config is constrained to the tree binding stored in the listing.
    #[account(mut, address = listing.tree_config)]
    pub tree_config: UncheckedAccount<'info>,
    /// CHECK: merkle tree is constrained to the tree binding stored in the listing.
    #[account(mut, address = listing.merkle_tree)]
    pub merkle_tree: UncheckedAccount<'info>,
    /// CHECK: collection address stored in the listing and validated by the leaf projection.
    #[account(address = listing.core_collection)]
    pub core_collection: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW013
    /// CHECK: collection PDA permanent transfer delegate.
    #[account(seeds = [b"market_auth"], bump)]
    pub market_auth: UncheckedAccount<'info>,
    /// CHECK: Bubblegum V2.
    #[account(address = chip_core::BUBBLEGUM_V2_ID)]
    pub bubblegum_program: UncheckedAccount<'info>,
    /// CHECK: Bubblegum V2 noop wrapper.
    #[account(address = MPL_NOOP_ID)]
    pub log_wrapper: UncheckedAccount<'info>,
    /// CHECK: Bubblegum V2 Account Compression fork.
    #[account(address = MPL_ACCOUNT_COMPRESSION_ID)]
    pub compression_program: UncheckedAccount<'info>,
    pub chip_core: Program<'info, ChipCore>,
    pub system_program: Program<'info, System>,
}

// sentio-ignore-fn SW023
pub fn buy_compressed_asset_handler<'info>(
    ctx: Context<'_, '_, '_, 'info, Box<BuyCompressedAsset<'info>>>,
    _delegate: Pubkey,
    proof: LeafProofArgs,
    expected_price: u64,
) -> Result<()> {
    let listing = &ctx.accounts.listing;
    // Defense in depth (SEC-B28) — see `require_sol_claim_market`.
    require!(
        listing.currency == Currency::Sol,
        MarketError::CompressedCurrencyMismatch
    );
    // SEC-F5 (2026-09-25) front-running guard, same rule as the legacy `buy`: without it the
    // seller could cancel + relist the claim at a higher price in one transaction landing ahead of
    // the buyer's (or bundle it), and the buyer paid whatever the listing said at execution time.
    require!(
        listing.price == expected_price,
        MarketError::ListingPriceChanged
    );
    require!(
        ctx.accounts.buyer.key() != listing.seller,
        MarketError::SelfTrade
    );
    require!(
        ctx.accounts.claim.buyer == listing.seller
            && ctx.accounts.claim.minted
            && ctx.accounts.claim.registered
            && ctx.accounts.claim.listed
            && !ctx.accounts.claim.consumed
            && !ctx.accounts.claim.staked,
        MarketError::CompressedClaimNotTradable
    );
    require!(
        ctx.accounts.chip.asset == listing.asset
            && ctx.accounts.chip.claim == ctx.accounts.claim.key()
            && ctx.accounts.chip.merkle_tree == listing.merkle_tree,
        MarketError::CompressedClaimNotTradable
    );
    require_keys_eq!(
        leaf_asset_id(&listing.merkle_tree, proof.index),
        listing.asset,
        MarketError::CompressedClaimNotTradable
    );
    require!(
        proof.index == ctx.accounts.chip.leaf_index
            && proof.nonce == ctx.accounts.chip.leaf_nonce
            && proof.data_hash == ctx.accounts.chip.data_hash
            && proof.creator_hash == ctx.accounts.chip.creator_hash
            && proof.collection_hash == ctx.accounts.chip.collection_hash
            && proof.asset_data_hash == ctx.accounts.chip.asset_data_hash
            && proof.flags == ctx.accounts.chip.leaf_flags,
        MarketError::CompressedClaimNotTradable
    );
    require_keys_eq!(
        Pubkey::find_program_address(&[listing.merkle_tree.as_ref()], &chip_core::BUBBLEGUM_V2_ID)
            .0,
        listing.tree_config,
        MarketError::CompressedClaimNotTradable
    );
    let expected_collection_hash =
        mpl_bubblegum::hash::hash_collection_option(Some(listing.core_collection))
            .map_err(|_| error!(MarketError::CompressedClaimNotTradable))?;
    require!(
        proof.collection_hash == expected_collection_hash,
        MarketError::CompressedClaimNotTradable
    );

    let (seller_amount, buyback_amount, treasury_fee, royalty) =
        split(listing.price, ctx.accounts.config.market_fee_bps)?;
    let buyer_info = ctx.accounts.buyer.to_account_info();
    let system_info = ctx.accounts.system_program.to_account_info();
    for (to, amount) in [
        (ctx.accounts.seller.to_account_info(), seller_amount),
        (ctx.accounts.buyback.to_account_info(), buyback_amount),
        (
            ctx.accounts.treasury.to_account_info(),
            treasury_fee + royalty,
        ),
    ] {
        if amount > 0 {
            system_program::transfer(
                CpiContext::new(
                    system_info.clone(),
                    system_program::Transfer {
                        from: buyer_info.clone(),
                        to,
                    },
                ),
                amount,
            )?;
        }
    }

    let seeds: &[&[u8]] = &[b"market_auth", &[ctx.bumps.market_auth]];
    // Keep every AccountInfo backing the generated CPI builder alive until the
    // invoke. Storing references to `to_account_info()` temporaries in a local
    // builder would otherwise trigger E0716 and, more importantly, make the
    // lifetime of the proof delivery path dependent on statement boundaries.
    let bubblegum_program = ctx.accounts.bubblegum_program.to_account_info();
    let tree_config = ctx.accounts.tree_config.to_account_info();
    let payer = ctx.accounts.buyer.to_account_info();
    let market_auth = ctx.accounts.market_auth.to_account_info();
    let leaf_owner = ctx.accounts.leaf_owner.to_account_info();
    let leaf_delegate = ctx.accounts.leaf_delegate.to_account_info();
    let new_leaf_owner = ctx.accounts.buyer.to_account_info();
    let merkle_tree = ctx.accounts.merkle_tree.to_account_info();
    let core_collection = ctx.accounts.core_collection.to_account_info();
    let log_wrapper = ctx.accounts.log_wrapper.to_account_info();
    let compression_program = ctx.accounts.compression_program.to_account_info();
    let system_program = ctx.accounts.system_program.to_account_info();
    let mut transfer = TransferV2CpiBuilder::new(&bubblegum_program);
    transfer
        .tree_config(&tree_config)
        .payer(&payer)
        .authority(Some(&market_auth))
        .leaf_owner(&leaf_owner)
        .leaf_delegate(Some(&leaf_delegate))
        .new_leaf_owner(&new_leaf_owner)
        .merkle_tree(&merkle_tree)
        .core_collection(Some(&core_collection))
        .log_wrapper(&log_wrapper)
        .compression_program(&compression_program)
        .system_program(&system_program)
        .root(proof.root)
        .data_hash(proof.data_hash)
        .creator_hash(proof.creator_hash)
        .asset_data_hash(proof.asset_data_hash)
        .flags(proof.flags)
        .nonce(proof.nonce)
        .index(proof.index);
    let proof_accounts = ctx
        .remaining_accounts
        .iter()
        .map(|account| (account, false, false))
        .collect::<Vec<_>>();
    transfer.add_remaining_accounts(&proof_accounts);
    transfer.invoke_signed(&[seeds])?;

    chip_core::cpi::transfer_compressed_claim(
        CpiContext::new_with_signer(
            ctx.accounts.chip_core.to_account_info(),
            TransferCompressedClaim {
                caller: ctx.accounts.market_auth.to_account_info(),
                claim: ctx.accounts.claim.to_account_info(),
            },
            &[seeds],
        ),
        listing.seller,
        ctx.accounts.buyer.key(),
    )?;
    emit!(CompressedAssetSold {
        asset: listing.asset,
        claim: listing.claim,
        seller: listing.seller,
        buyer: ctx.accounts.buyer.key(),
        price: listing.price,
        fee: buyback_amount + treasury_fee,
        royalty,
    });
    Ok(())
}

#[program]
pub mod market {
    use super::*;
    pub fn update_price(ctx: Context<UpdatePrice>, price: u64) -> Result<()> {
        update_price_handler(ctx, price)
    }
    pub fn accept_offer(ctx: Context<AcceptOffer>) -> Result<()> {
        accept_offer_handler(ctx)
    }
    pub fn list_compressed(
        ctx: Context<ListCompressed>,
        price: u64,
        currency: Currency,
    ) -> Result<()> {
        list_compressed_handler(ctx, price, currency)
    }
    pub fn buy_compressed(ctx: Context<BuyCompressed>, expected_price: u64) -> Result<()> {
        buy_compressed_handler(ctx, expected_price)
    }
    pub fn cancel_compressed(ctx: Context<CancelCompressed>) -> Result<()> {
        cancel_compressed_handler(ctx)
    }
    pub fn list_compressed_asset(
        ctx: Context<ListCompressedAsset>,
        price: u64,
        currency: Currency,
    ) -> Result<()> {
        list_compressed_asset_handler(ctx, price, currency)
    }
    // `Box` on the context is load-bearing, not decoration. This instruction names 20 accounts,
    // almost all of them `UncheckedAccount` (each an `AccountInfo` by value), so the whole struct
    // lives in the SBF stack frame. Under `opt-level = "z"` it overflowed that frame and the
    // program aborted with `Access violation in stack frame 5` on EVERY call — found by
    // tests/localnet/32-market-compressed.spec.ts, which is the first thing ever to execute this
    // handler in LiteSVM. Boxing moves the accounts to the heap; the discriminator, the account
    // list and the IDL are all unchanged, so no client sees a difference.
    pub fn buy_compressed_asset<'info>(
        ctx: Context<'_, '_, '_, 'info, Box<BuyCompressedAsset<'info>>>,
        delegate: Pubkey,
        proof: LeafProofArgs,
        expected_price: u64,
    ) -> Result<()> {
        buy_compressed_asset_handler(ctx, delegate, proof, expected_price)
    }
    pub fn cancel_compressed_asset(ctx: Context<CancelCompressedAsset>) -> Result<()> {
        cancel_compressed_asset_handler(ctx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `fee_bps` is a GameConfig field, so `split` has no fee of its own: the vectors below are written at
    /// the value `initialize_config` installs (`chip_core::economy::DEFAULT_MARKET_FEE_BPS`), which is the
    /// state a freshly deployed market settles into. Numbers are derived from the three constants by hand —
    /// at price 10 000 the arithmetic is the definition: fee = 750 (bps over BPS), buyback = 750·3333/10 000
    /// = 249, treasury = 750-249 = 501, royalty = 250, seller = everything left = 9 000.
    #[test]
    fn split_sums_to_price() {
        for p in [1_000_000u64, 12_345_678, u32::MAX as u64, u64::MAX, 1] {
            let (s, b, t, r) = split(p, chip_core::economy::DEFAULT_MARKET_FEE_BPS).unwrap();
            assert_eq!(s + b + t + r, p);
            assert!(b <= t);
        }
        let (s, b, t, r) = split(10_000, chip_core::economy::DEFAULT_MARKET_FEE_BPS).unwrap();
        assert_eq!((s, b, t, r), (9_000, 249, 501, 250));
    }

    /// The clamp is the only thing between an owner's typo in `set_config` and a market that takes half of
    /// every sale, and it lives in `split` rather than in the admin handler — so it needs its own test, at a
    /// requested fee above `MAX_MARKET_FEE_BPS` where the sum invariant would still hold if the clamp were
    /// deleted (that is what makes `b + t == 1 000` the assertion instead of `s + b + t + r == p`).
    #[test]
    fn split_clamps_a_fee_above_the_cap() {
        let (s, b, t, r) = split(10_000, 5_000).unwrap();
        assert_eq!((s, b, t, r), (8_750, 333, 667, 250));
        assert_eq!(b + t, chip_core::economy::MAX_MARKET_FEE_BPS as u64);
    }

    /// SEC-B28. Both directions are asserted: the claim market can only settle SOL, so `Usdc` and `Skr`
    /// must be refused — and `Sol` must pass, which is what catches a guard whose comparison was inverted
    /// (an `is_err()`-only test would pass for a `currency != Currency::Sol` typo in the other direction).
    /// The localnet suite pins the code the caller sees (`CompressedCurrencyMismatch` = 6011), since the
    /// error value is produced by `error!` and not compared here.
    #[test]
    fn claim_market_lists_only_in_sol() {
        assert!(require_sol_claim_market(Currency::Sol).is_ok());
        assert!(require_sol_claim_market(Currency::Usdc).is_err());
        assert!(require_sol_claim_market(Currency::Skr).is_err());
    }
}
