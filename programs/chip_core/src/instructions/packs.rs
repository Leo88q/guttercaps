//! Pack purchase and opening with Switchboard On-Demand randomness.
//!
//! Security model (docs/03-architecture.md §2.5):
//!  * Payment is taken at COMMIT time into a program-owned vault. Taking it
//!    at reveal would allow selective revelation (only "open" winners).
//!  * The randomness account is a chip_core PDA whose Switchboard authority is
//!    `["rng_auth"]`: `buy_pack` commits it by CPI, so the buyer can neither
//!    re-commit nor block the reveal (SEC-C3 part 2); after the CPI it must
//!    have `seed_slot == slot − 1` and be unrevealed; its key is pinned in
//!    PendingPack.
//!  * The historical `open_pack` implementation below is retained for audit
//!    comparison only and is fail-closed while the full Bubblegum V2 path is
//!    deployed. The live replacement must keep outcome authorization separate
//!    from asynchronous DAS registration.
//!  * Legacy Core assets were PDAs derived from the PendingPack; the V2 path
//!    uses claim PDAs and Bubblegum leaf coordinates instead.
//!  * $CG paid for packs sits in the vault until the reveal; the 75 % burn and
//!    25 % treasury split happen on the last `open_pack`. Hence
//!    `cancel_stale_pack` refunds 100 % in every currency straight from the
//!    vault (no off-chain keeper, no admin key in the loop).
//!  * `sweep_vault` can never take the vault below outstanding liabilities.
//!  * (#12) Liabilities live in `LEDGER_SHARDS` `VaultLedger` PDAs, not in `GameConfig`: no player
//!    instruction takes a write lock on `config`, and the `vault` PDA is written only by SOL
//!    purchases / refunds. Packs 1…N−1 of a bundle pass the buyer's shard read-only; the settling
//!    pack must pass it writable (`AccountNotWritable` otherwise — never a silent runtime error).
//!  * (#28) Quest chip vouchers still create a `PendingPack`, but their former
//!    Core mint handoff is also blocked by the migration gate. They require the
//!    same Bubblegum claim/mint/registration settlement before release.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Mint, Token, TokenAccount};
// 2026-10-01: `open_pack` was the only Core-minting instruction in this file, and its body is now
// the fail-closed migration gate, so the whole `mpl_core` plugin/delegate import set is gone.
// `open_voucher` still checks a Core program address, which is why `ID` alone survives.
use mpl_core::ID as MPL_CORE_ID;
use pyth_solana_receiver_sdk::price_update::{get_feed_id_from_hex, PriceUpdateV2};

// `price_update` below is a `/// CHECK:` account decoded by `crate::pyth::load` rather than an
// `Account<'info, PriceUpdateV2>`: the SDK type has no `IdlBuild` impl and the orphan rule forbids
// adding one here, which would break `anchor build` (docs/09 §1.1). Owner is pinned by the account
// constraint, discriminator + borsh by the loader; feed id / age / confidence stay in `oracle_price`.

use crate::economy::*;
use crate::errors::ChipError;
use crate::randomness;
use crate::state::*;

pub const DAY: i64 = 86_400;
/// Pyth SOL/USD price feed id (pull oracle).
pub const SOL_USD_FEED_HEX: &str =
    "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
/// Pyth SKR/USD (Seeker) price feed id.
pub const SKR_USD_FEED_HEX: &str =
    "38846ec4d0dbe808091817f5c0d6ab8058e25422348ddf97db52b6c378a93bf9";

/// SEC-M2: the price the program charges at, from a verified Pyth update.
///   * age / feed / verification level — `get_price_no_older_than` (unchanged),
///   * `conf × 10_000 > price × PYTH_MAX_CONF_BPS` ⇒ `PriceUncertain` (publishers disagree),
///   * returns `price − conf`: the protocol-favouring edge of the interval, so a buyer never pays
///     with a token valued at the optimistic end of a wide band. At a normal 0.05 % conf this
///     costs the buyer 0.05 % — inside the 1 % slippage guard the quote already carries.
///
/// Mirrored bit-for-bit in packages/economy `effectivePythPrice` (backend quote + client).
pub fn oracle_price(pu: &PriceUpdateV2, clock: &Clock, feed_hex: &str) -> Result<(i64, i32)> {
    let feed = get_feed_id_from_hex(feed_hex).map_err(|_| error!(ChipError::StalePrice))?;
    let p = pu
        .get_price_no_older_than(clock, SOL_PRICE_MAX_AGE_SECS, &feed)
        .map_err(|_| error!(ChipError::StalePrice))?;
    require!(p.price > 0, ChipError::StalePrice);
    require!(
        (p.conf as u128) * 10_000 <= (p.price as u128) * PYTH_MAX_CONF_BPS as u128,
        ChipError::PriceUncertain
    );
    let effective =
        p.price - i64::try_from(p.conf).map_err(|_| error!(ChipError::PriceUncertain))?;
    require!(effective > 0, ChipError::PriceUncertain);
    Ok((effective, p.exponent))
}

/// Token units for `usd_cents` at a Pyth price: units = cents × 10^decimals × 10^|expo| / 100 / price.
pub fn units_for_cents(usd_cents: u64, price: i64, exponent: i32, decimals: u32) -> Result<u64> {
    require!(price > 0, ChipError::StalePrice);
    let scale = 10u128.pow(exponent.unsigned_abs());
    let v = (usd_cents as u128)
        .checked_mul(10u128.pow(decimals))
        .ok_or(ChipError::Overflow)?
        .checked_mul(scale)
        .ok_or(ChipError::Overflow)?
        .checked_div(100)
        .ok_or(ChipError::Overflow)?
        .checked_div(price as u128)
        .ok_or(ChipError::Overflow)?;
    u64::try_from(v).map_err(|_| error!(ChipError::Overflow))
}
/// Rent the buyer pre-funds per chip so any cranker can mint for free:
/// Core base asset with 3 lifecycle plugins (~0.0027–0.0029 SOL) + ChipState (~0.0014 SOL) + Core protocol
/// fee (0.0015 SOL) is materially smaller than the old redundant Attributes plugin. SEC-L3: reserve 0.008 SOL — the margin covers longer symbols /
/// URIs and a Core fee bump; whatever `open_pack` does not spend flows back to the buyer when the
/// last pack closes `PendingPack`, so the extra 0.002 SOL per chip is parked for seconds, not lost.
pub const RENT_RESERVE_PER_CHIP: u64 = 8_000_000;

// ---------------------------------------------------------------------------
// buy_pack
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(sku: u8, qty: u8, currency: u8, nonce: u64)]
pub struct BuyPack<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump, constraint = !config.paused @ ChipError::Paused)]
    pub config: Box<Account<'info, GameConfig>>,
    /// Liability shard of the buyer (#12): `["ledger", buyer[0] % LEDGER_SHARDS]`.
    #[account(mut, seeds = [VaultLedger::SEED, &[VaultLedger::shard_of(&buyer.key())]], bump = ledger.bump)]
    pub ledger: Box<Account<'info, VaultLedger>>,

    // Note: PDA cannot be closed; Anchor discriminator prevents re-init
    // sentio-ignore-next-line SW016
    #[account(
        init_if_needed, payer = buyer, space = 8 + PlayerPity::INIT_SPACE,
        seeds = [b"pity", buyer.key().as_ref()], bump
    )]
    pub pity: Box<Account<'info, PlayerPity>>,

    #[account(
        init, payer = buyer, space = 8 + PendingPack::INIT_SPACE,
        seeds = [b"pending", buyer.key().as_ref(), &nonce.to_le_bytes()], bump
    )]
    pub pending: Box<Account<'info, PendingPack>>,

    /// CHECK: program-owned Switchboard randomness account `["rng", 0, buyer, nonce]` created by
    /// `init_randomness` in this tx (owner = SB_PROGRAM_ID, SEC-C1); committed HERE by CPI with the
    /// `rng_auth` signature and pinned in PendingPack (SEC-C3 part 2).
    #[account(
        mut, owner = randomness::SB_PROGRAM_ID @ ChipError::RandomnessMismatch,
        seeds = [randomness::RNG_SEED, &[randomness::RNG_KIND_PACK], buyer.key().as_ref(), &nonce.to_le_bytes()], bump,
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
    /// CHECK: oracle from the queue chosen by the client (Switchboard verifies queue membership / health).
    #[account(mut)]
    pub oracle: UncheckedAccount<'info>,
    /// CHECK: SlotHashes sysvar.
    #[account(address = randomness::SLOT_HASHES_ID)]
    pub recent_slothashes: UncheckedAccount<'info>,

    // sentio-ignore-next-line SW013
    /// CHECK: program vault PDA (holds SOL, authority of vault token accounts). Written only by
    /// SOL purchases — the handler requires it writable on that path (#12); SPL purchases pass it
    /// read-only so USDC/$CG/SKR checkouts never queue behind each other on the vault.
    #[account(seeds = [b"vault"], bump = config.vault_bump)]
    pub vault: UncheckedAccount<'info>,

    // --- SOL / SKR path: Pyth price update (SOL/USD or SKR/USD, feed id checked in the handler) ---
    /// CHECK: see the note on `oracle_price` — owner-pinned here, discriminator + borsh in `pyth::load`.
    #[account(owner = crate::pyth::PYTH_RECEIVER @ ChipError::StalePrice)]
    pub price_update: Option<UncheckedAccount<'info>>,

    // --- SPL path (USDC, $CG or SKR — mint checked in the handler against `currency`) ---
    #[account(mut, token::authority = buyer)]
    pub buyer_token: Option<Account<'info, TokenAccount>>,
    #[account(mut, token::authority = vault)]
    pub vault_token: Option<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn buy_pack(
    ctx: Context<BuyPack>,
    sku: u8,
    qty: u8,
    currency: u8,
    nonce: u64,
    max_lamports: u64,
) -> Result<()> {
    require!(
        (1..=MAX_PACK_QTY).contains(&qty),
        ChipError::InvalidQuantity
    );
    let sku_e = PackSku::from_u8(sku).ok_or(ChipError::InvalidSku)?;
    let def = ctx.accounts.config.packs[sku as usize];
    require!(def.enabled, ChipError::SkuDisabled);
    // A valid Pyth update is not enough: accept only the account selected by
    // the multisig in GameConfig. This keeps quote, client and on-chain
    // settlement on one authoritative push-oracle shard.
    if currency == 0 || currency == 3 {
        let expected = if currency == 0 {
            ctx.accounts.config.pyth_sol_usd_feed
        } else {
            ctx.accounts.config.pyth_skr_usd_feed
        };
        let supplied = ctx
            .accounts
            .price_update
            .as_ref()
            .ok_or(ChipError::StalePrice)?;
        require_keys_eq!(supplied.key(), expected, ChipError::StalePrice);
    }
    let clock = Clock::get()?;

    // --- commit the program-owned randomness account by CPI (SEC-C3 part 2): authority = rng_auth,
    // never committed before, and after the CPI `seed_slot == slot − 1` / unrevealed (randomness.rs) ---
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

    // --- per-wallet caps ---
    let pity = &mut ctx.accounts.pity;
    if pity.owner == Pubkey::default() {
        pity.owner = ctx.accounts.buyer.key();
        pity.bump = ctx.bumps.pity;
    }
    require_keys_eq!(
        pity.owner,
        ctx.accounts.buyer.key(),
        ChipError::Unauthorized
    );
    if clock.unix_timestamp - pity.day_start >= DAY {
        pity.day_start = clock.unix_timestamp;
        pity.bought_today = [0; 4];
    }
    if sku_e == PackSku::Starter {
        require!(
            !pity.starter_claimed && qty == 1,
            ChipError::StarterAlreadyClaimed
        );
        pity.starter_claimed = true;
    }
    if def.daily_cap > 0 {
        let after = pity.bought_today[sku as usize]
            .checked_add(qty)
            .ok_or(ChipError::Overflow)?;
        require!(after <= def.daily_cap, ChipError::DailyCapReached);
        pity.bought_today[sku as usize] = after;
    }

    // --- price ---
    let mut discount = if matches!(sku_e, PackSku::Limited | PackSku::Starter) {
        0
    } else {
        bundle_discount_bps(qty)
    };
    // SKR promo: stacks additively with bundle discounts, total capped at 30 %
    if currency == 3 {
        discount = (discount + ctx.accounts.config.skr_discount_bps).min(3_000);
    }
    let usd_cents = (def.price_usd_cents as u64)
        .checked_mul(qty as u64)
        .ok_or(ChipError::Overflow)?
        .checked_mul((BPS_DENOM as u16 - discount) as u64)
        .ok_or(ChipError::Overflow)?
        .checked_div(BPS_DENOM as u64)
        .ok_or(ChipError::Overflow)?;

    // --- rent reserve so any cranker can open the pack ---
    let rent_reserve = RENT_RESERVE_PER_CHIP
        .checked_mul(def.chips as u64)
        .ok_or(ChipError::Overflow)?
        .checked_mul(qty as u64)
        .ok_or(ChipError::Overflow)?;
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.buyer.to_account_info(),
                to: ctx.accounts.pending.to_account_info(),
            },
        ),
        rent_reserve,
    )?;

    let spl_pay = |mint: Pubkey, amount: u64| -> Result<()> {
        let from = ctx
            .accounts
            .buyer_token
            .as_ref()
            .ok_or(ChipError::CurrencyNotAccepted)?;
        let to = ctx
            .accounts
            .vault_token
            .as_ref()
            .ok_or(ChipError::CurrencyNotAccepted)?;
        require_keys_eq!(from.mint, mint, ChipError::CurrencyNotAccepted);
        require_keys_eq!(to.mint, mint, ChipError::CurrencyNotAccepted);
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: from.to_account_info(),
                    to: to.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            amount,
        )
    };

    let (paid_lamports, paid_usdc, paid_cg, paid_skr) = match currency {
        0 => {
            let pu = crate::pyth::load(
                ctx.accounts
                    .price_update
                    .as_ref()
                    .ok_or(ChipError::StalePrice)?
                    .as_ref(),
            )?;
            let (price, exponent) = oracle_price(&pu, &clock, SOL_USD_FEED_HEX)?;
            let lamports = units_for_cents(usd_cents, price, exponent, 9)?;
            require!(lamports <= max_lamports, ChipError::Slippage);
            VaultLedger::require_writable(&ctx.accounts.vault.to_account_info())?;
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.buyer.to_account_info(),
                        to: ctx.accounts.vault.to_account_info(),
                    },
                ),
                lamports,
            )?;
            (lamports, 0, 0, 0)
        }
        1 => {
            let amount = usd_cents.checked_mul(10_000).ok_or(ChipError::Overflow)?; // cents → micro-USDC
            spl_pay(ctx.accounts.config.usdc_mint, amount)?;
            (0, amount, 0, 0)
        }
        2 => {
            require!(def.price_cg_micro > 0, ChipError::CurrencyNotAccepted);
            let amount = def
                .price_cg_micro
                .checked_mul(qty as u64)
                .ok_or(ChipError::Overflow)?
                .checked_mul((BPS_DENOM as u16 - discount) as u64)
                .ok_or(ChipError::Overflow)?
                .checked_div(BPS_DENOM as u64)
                .ok_or(ChipError::Overflow)?;
            spl_pay(ctx.accounts.config.cg_mint, amount)?;
            (0, 0, amount, 0)
        }
        3 => {
            // Seeker: volatile → priced through Pyth SKR/USD; `max_lamports` doubles as the max-SKR slippage guard
            require!(
                ctx.accounts.config.skr_mint != Pubkey::default(),
                ChipError::CurrencyNotAccepted
            );
            let pu = crate::pyth::load(
                ctx.accounts
                    .price_update
                    .as_ref()
                    .ok_or(ChipError::StalePrice)?
                    .as_ref(),
            )?;
            let (price, exponent) = oracle_price(&pu, &clock, SKR_USD_FEED_HEX)?;
            let amount = units_for_cents(usd_cents, price, exponent, 6)?;
            require!(amount <= max_lamports, ChipError::Slippage);
            spl_pay(ctx.accounts.config.skr_mint, amount)?;
            (0, 0, 0, amount)
        }
        _ => return err!(ChipError::CurrencyNotAccepted),
    };

    // liabilities: what the vault owes if every pending pack were cancelled (buyer's shard, #12)
    ctx.accounts
        .ledger
        .add(paid_lamports, paid_usdc, paid_cg, paid_skr)?;

    let pending = &mut ctx.accounts.pending;
    pending.buyer = ctx.accounts.buyer.key();
    pending.sku = sku;
    pending.qty = qty;
    pending.opened = 0;
    pending.randomness = ctx.accounts.randomness.key();
    pending.commit_slot = rnd.seed_slot;
    pending.paid_lamports = paid_lamports;
    pending.paid_usdc = paid_usdc;
    pending.paid_cg = paid_cg;
    pending.paid_skr = paid_skr;
    pending.pity_snapshot = pity.counters[sku as usize];
    pending.nonce = nonce;
    pending.bump = ctx.bumps.pending;
    pending.revealed = false;
    pending.value = [0u8; 32];
    pending.voucher = false;
    pending.preorder = false;
    pending.voucher_odds = [0u16; RARITY_COUNT];
    // Starter is the only paid SKU with a soulbound window (7 d). Other SKUs are tradeable at
    // once; quest vouchers set `soulbound_days` from the template in `open_voucher`. Leaving this
    // at 0 made `open_compressed_pack` write `lock_until = 0`, so the staking ChipNotFree guard
    // (SEC-A1) never saw a Starter lock.
    pending.soulbound_days = if sku_e == PackSku::Starter {
        STARTER_SOULBOUND_DAYS
    } else {
        0
    };

    emit!(PackBought {
        buyer: pending.buyer,
        sku,
        qty,
        currency,
        amount: paid_lamports.max(paid_usdc).max(paid_cg).max(paid_skr),
        nonce,
        randomness: pending.randomness,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// open_voucher (#28) — a free 1-chip PendingPack for a quest reward. Only the
// staking program's `["rewarder"]` PDA may issue one (it does so inside
// `claim_chip_root` after verifying the Merkle proof), so the number of vouchers
// is bounded by the published kind-9 roots (≤ MAX_CHIP_ROOT_BUDGET per root,
// one leaf per wallet per epoch) — never by a hot key.
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(nonce: u64, template: u8)]
pub struct OpenVoucher<'info> {
    /// Staking program's `["rewarder"]` PDA (`GameConfig.staking_program`) — checked in the handler.
    pub authority: Signer<'info>,
    /// The rewarded wallet: signs (it is the tx fee payer of the claim) and pays the rent reserve,
    /// the pending rent and the Switchboard request — all of which flow back when the chip is minted
    /// (`open_pack` closes the pending to `buyer`) or on `cancel_stale_pack`.
    #[account(mut)]
    pub beneficiary: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump, constraint = !config.paused @ ChipError::Paused)]
    pub config: Box<Account<'info, GameConfig>>,

    // Note: PDA cannot be closed; Anchor discriminator prevents re-init
    // sentio-ignore-next-line SW016
    #[account(
        init_if_needed, payer = beneficiary, space = 8 + PlayerPity::INIT_SPACE,
        seeds = [b"pity", beneficiary.key().as_ref()], bump
    )]
    pub pity: Box<Account<'info, PlayerPity>>,

    #[account(
        init, payer = beneficiary, space = 8 + PendingPack::INIT_SPACE,
        seeds = [b"pending", beneficiary.key().as_ref(), &nonce.to_le_bytes()], bump
    )]
    pub pending: Box<Account<'info, PendingPack>>,

    /// CHECK: program-owned Switchboard randomness account `["rng", 0, beneficiary, nonce]` created
    /// by `init_randomness` in this tx (same kind as a purchase so `close_randomness` reclaims it).
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

pub fn open_voucher(ctx: Context<OpenVoucher>, nonce: u64, template: u8) -> Result<()> {
    let c = &ctx.accounts.config;
    // authority = the staking program's reward-signer PDA ["rewarder"] (quest claims only — no admin path:
    // support cases go through a published root like everyone else, so every free chip has a Merkle trail)
    let (rewarder, _) = Pubkey::find_program_address(&[b"rewarder"], &c.staking_program);
    require_keys_eq!(
        ctx.accounts.authority.key(),
        rewarder,
        ChipError::Unauthorized
    );
    let def = *VOUCHER_DEFS
        .get(template as usize)
        .ok_or(ChipError::InvalidVoucher)?;
    let clock = Clock::get()?;

    // commit the program-owned randomness account by CPI — identical to buy_pack (SEC-C3 part 2)
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

    // the pity account only needs to exist for `open_pack` (it reads / writes `counters[0]` — a no-op
    // for vouchers since `pity_tier = 0`); no Starter flag, no daily cap, no counters touched here
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

    // rent reserve for ONE chip so any cranker can mint it (leftover → beneficiary on close)
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.beneficiary.to_account_info(),
                to: ctx.accounts.pending.to_account_info(),
            },
        ),
        RENT_RESERVE_PER_CHIP,
    )?;

    let pending = &mut ctx.accounts.pending;
    pending.buyer = ctx.accounts.beneficiary.key();
    pending.sku = 0;
    pending.qty = 1;
    pending.opened = 0;
    pending.randomness = ctx.accounts.randomness.key();
    pending.commit_slot = rnd.seed_slot;
    pending.paid_lamports = 0;
    pending.paid_usdc = 0;
    pending.paid_cg = 0;
    pending.paid_skr = 0;
    pending.pity_snapshot = 0;
    pending.nonce = nonce;
    pending.bump = ctx.bumps.pending;
    pending.revealed = false;
    pending.value = [0u8; 32];
    pending.voucher = true;
    pending.preorder = false;
    pending.voucher_odds = def.odds_bps;
    pending.soulbound_days = def.soulbound_days;

    emit!(VoucherIssued {
        wallet: pending.buyer,
        nonce,
        template,
        randomness: pending.randomness
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// open_pack — one pack (≤ 5 chips) per call; a bundle of N is N sequential
// calls (pack_no must equal `pending.opened`). Each pack derives its own
// 32-byte sub-seed from the single oracle value.
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(nonce: u64, pack_no: u8)]
pub struct OpenPack<'info> {
    /// Anyone may crank. Rent for new accounts is fronted by the cranker and
    /// reimbursed from the PendingPack's pre-funded reserve in the same ix.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, GameConfig>>,
    /// Liability shard of the buyer (#12). Deliberately NOT `mut`: packs 1…N−1 of a bundle pass it
    /// read-only (no write lock); the pack that settles the purchase (`opened == qty`) must pass
    /// it writable — checked in the handler, persisted with an explicit `exit`.
    #[account(seeds = [VaultLedger::SEED, &[VaultLedger::shard_of(&pending.buyer)]], bump = ledger.bump)]
    pub ledger: Box<Account<'info, VaultLedger>>,

    #[account(
        mut,
        seeds = [b"pending", pending.buyer.as_ref(), &nonce.to_le_bytes()], bump = pending.bump,
        constraint = pending.randomness == randomness.key() @ ChipError::RandomnessMismatch,
        constraint = pack_no == pending.opened && pack_no < pending.qty @ ChipError::InvalidQuantity,
    )]
    pub pending: Box<Account<'info, PendingPack>>,

    /// CHECK: pinned by the constraint above; owner-checked + parsed in `randomness::parse_checked`
    /// (only read by the first open of a bundle — afterwards `pending.value` is used).
    #[account(address = pending.randomness @ ChipError::RandomnessMismatch)]
    pub randomness: UncheckedAccount<'info>,

    #[account(mut, seeds = [b"pity", pending.buyer.as_ref()], bump = pity.bump)]
    pub pity: Box<Account<'info, PlayerPity>>,

    /// CHECK: receives the minted assets.
    #[account(mut, address = pending.buyer)]
    pub buyer: UncheckedAccount<'info>,

    // sentio-ignore-next-line SW013
    /// CHECK: vault PDA — only SIGNS the $CG burn/split on the final pack (its lamports never
    /// change here), so it is read-only: opening never queues behind SOL checkouts (#12).
    #[account(seeds = [b"vault"], bump = config.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, address = config.cg_mint)]
    pub cg_mint: Option<Account<'info, Mint>>,
    #[account(mut, token::mint = config.cg_mint, token::authority = vault)]
    pub vault_cg: Option<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = config.cg_mint, token::authority = config.treasury)]
    pub treasury_cg: Option<Account<'info, TokenAccount>>,

    /// CHECK: Metaplex Core program.
    #[account(address = MPL_CORE_ID)]
    pub mpl_core: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    // The account list is kept exactly as it was: `open_pack` is a fail-closed
    // stub (see the handler), and shrinking the context here would change the
    // instruction's account encoding for every client that still builds it.
    // The Core-mint `remaining_accounts` the old body consumed (4 per chip:
    // asset_i, chip_state_i, collection_meta, core_collection) are therefore
    // still accepted and simply never read.
}

// sentio-ignore-fn SW023
pub fn open_pack<'info>(
    ctx: Context<'_, '_, 'info, 'info, OpenPack<'info>>,
    nonce: u64,
    pack_no: u8,
) -> Result<()> {
    // Fail closed. This instruction minted MPL-Core chips and created the
    // ["chip", asset] ChipState that the whole Core surface (Core market, Core
    // staking, Core fusion, deliver_sold / thaw_chip) is built on. On a
    // full-closed Bubblegum V2 deployment it must never run again, and the
    // replacement flow is stage_compressed_chip -> mint_compressed_chip ->
    // DAS/proof registration.
    //
    // `params_version == 0` is reserved: `initialize` starts it at 1 and every
    // subsequent update uses a checked increment, so no valid live config can
    // enable this branch. That is the one-way migration gate, and it is asserted
    // by tests/localnet/00-admin.spec.ts G03.
    //
    // The historical body was deleted rather than kept as reference: it was
    // ~300 lines of unreachable code that still had to compile, still had to be
    // audited, and still shipped in the .so. The gate above is the whole
    // instruction now.
    require!(
        ctx.accounts.config.params_version == 0,
        ChipError::CompressedMigrationRequired
    );

    // `nonce` / `pack_no` stay in the signature so the instruction encoding is
    // byte-identical; nothing below can run, so they are read only to keep the
    // compiler honest about them.
    let _ = (nonce, pack_no);
    Ok(())
}

// ---------------------------------------------------------------------------
// cancel_stale_pack — oracle never revealed → 100 % refund from the vault.
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CancelStalePack<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, GameConfig>>,
    /// Liability shard of the buyer (#12) — the refund releases what `buy_pack` added.
    #[account(mut, seeds = [VaultLedger::SEED, &[VaultLedger::shard_of(&buyer.key())]], bump = ledger.bump)]
    pub ledger: Box<Account<'info, VaultLedger>>,
    /// SEC-F18: vouchers (`pending.voucher`, opened by `open_voucher` on behalf of a quest reward)
    /// are cancellable too. They carry no purchase (`paid_* == 0`, so the refund legs below are
    /// no-ops), but the beneficiary pre-paid the pending rent, the 1-chip rent reserve and the
    /// Switchboard request; if the oracle never reveals, this is the only path that returns them
    /// (`close_randomness` requires the pending to be gone first). The former
    /// `constraint = !pending.voucher` locked all of that forever.
    #[account(
        mut, close = buyer,
        seeds = [b"pending", buyer.key().as_ref(), &nonce.to_le_bytes()], bump = pending.bump,
        has_one = buyer @ ChipError::Unauthorized,
        constraint = pending.opened == 0 @ ChipError::InvalidChipState,
    )]
    pub pending: Box<Account<'info, PendingPack>>,
    /// CHECK: pinned in pending; owner-checked + parsed in `randomness::parse_checked`
    #[account(address = pending.randomness)]
    pub randomness: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW013
    /// CHECK: vault PDA
    #[account(mut, seeds = [b"vault"], bump = config.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, token::authority = vault)]
    pub vault_token: Option<Account<'info, TokenAccount>>,
    #[account(mut, token::authority = buyer)]
    pub buyer_token: Option<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    /// SOL refund leg: the vault PDA signs the system transfer (system-owned — never debited directly)
    pub system_program: Program<'info, System>,
}

pub fn cancel_stale_pack(ctx: Context<CancelStalePack>, _nonce: u64) -> Result<()> {
    let clock = Clock::get()?;
    let pending = &ctx.accounts.pending;
    // SEC-C3: refund only after the oracle window expired AND the request was never revealed —
    // a revealed pack must be opened (the crank does it), never refunded.
    require!(!pending.revealed, ChipError::RandomnessAlreadyRevealed);
    let rnd = randomness::parse_checked(&ctx.accounts.randomness)?;
    randomness::assert_refundable(&rnd, pending.commit_slot, clock.slot)?;

    let (pl, pu, pc, ps) = (
        pending.paid_lamports,
        pending.paid_usdc,
        pending.paid_cg,
        pending.paid_skr,
    );
    let vault_seeds: &[&[u8]] = &[b"vault", &[ctx.accounts.config.vault_bump]];

    if pl > 0 {
        // The vault is a SYSTEM-owned PDA (it only ever holds SOL — see `initialize`), so the program
        // may CREDIT it directly but may never DEBIT it: the runtime rejects that with
        // ExternalAccountLamportSpend (C13's failure — the debit executed, the event was even emitted,
        // and the instruction-end owner check killed the tx). The canonical way a program spends SOL
        // from its PDA is a system transfer signed with the PDA's seeds.
        anchor_lang::system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.buyer.to_account_info(),
                },
                &[vault_seeds],
            ),
            pl,
        )?;
    }
    let spl_amount = pu.max(pc).max(ps);
    if spl_amount > 0 {
        let from = ctx
            .accounts
            .vault_token
            .as_ref()
            .ok_or(ChipError::CurrencyNotAccepted)?;
        let to = ctx
            .accounts
            .buyer_token
            .as_ref()
            .ok_or(ChipError::CurrencyNotAccepted)?;
        let expected_mint = if pu > 0 {
            ctx.accounts.config.usdc_mint
        } else if ps > 0 {
            ctx.accounts.config.skr_mint
        } else {
            ctx.accounts.config.cg_mint
        };
        require_keys_eq!(from.mint, expected_mint, ChipError::CurrencyNotAccepted);
        require_keys_eq!(to.mint, expected_mint, ChipError::CurrencyNotAccepted);
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: from.to_account_info(),
                    to: to.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[vault_seeds],
            ),
            spl_amount,
        )?;
    }
    ctx.accounts.ledger.release(pl, pu, pc, ps)?;

    emit!(PackCancelled {
        buyer: pending.buyer,
        nonce: pending.nonce,
        refunded: pl.max(spl_amount)
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// sweep_vault — admin moves settled revenue to the treasury, never below
// outstanding liabilities (pending-pack refunds + escrowed fusion fees), summed
// over all `LEDGER_SHARDS` ledger shards (remaining_accounts, in order).
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct SweepVault<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin @ ChipError::Unauthorized, has_one = treasury)]
    pub config: Box<Account<'info, GameConfig>>,
    // sentio-ignore-next-line SW013
    /// CHECK: vault PDA
    #[account(mut, seeds = [b"vault"], bump = config.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: treasury (Squads vault)
    #[account(mut, address = config.treasury @ ChipError::Unauthorized)]
    pub treasury: UncheckedAccount<'info>,
    /// Optional SPL leg: USDC or SKR vault ATA (mint decides which liability applies).
    #[account(mut, token::authority = vault)]
    pub vault_token: Option<Account<'info, TokenAccount>>,
    #[account(mut, token::authority = treasury)]
    pub treasury_token: Option<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    /// SOL leg: the vault PDA signs the system transfer
    pub system_program: Program<'info, System>,
    // remaining_accounts: the LEDGER_SHARDS `VaultLedger` PDAs `["ledger", 0..N]` in order (read-only)
}

// sentio-ignore-fn SW023
pub fn sweep_vault<'info>(ctx: Context<'_, '_, 'info, 'info, SweepVault<'info>>) -> Result<()> {
    let cfg = &ctx.accounts.config;
    let liab = VaultLedger::totals(ctx.remaining_accounts, ctx.program_id)?;
    let rent_floor = Rent::get()?.minimum_balance(0);
    let free_lamports = ctx
        .accounts
        .vault
        .lamports()
        .saturating_sub(liab.liab_lamports)
        .saturating_sub(rent_floor);
    // vault PDA seeds — shared by the SOL leg and the SPL leg below
    let seeds: &[&[u8]] = &[b"vault", &[cfg.vault_bump]];
    if free_lamports > 0 {
        // Same rule as cancel_stale_pack: the vault PDA is system-owned, so SOL leaves it only via a
        // PDA-signed system transfer — never a direct debit (ExternalAccountLamportSpend otherwise).
        anchor_lang::system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                },
                &[seeds],
            ),
            free_lamports,
        )?;
    }
    if let (Some(from), Some(to)) = (
        ctx.accounts.vault_token.as_ref(),
        ctx.accounts.treasury_token.as_ref(),
    ) {
        require_keys_eq!(from.mint, to.mint, ChipError::CurrencyNotAccepted);
        let owed = if from.mint == cfg.usdc_mint {
            liab.liab_usdc
        } else if from.mint == cfg.skr_mint {
            liab.liab_skr
        } else {
            return err!(ChipError::CurrencyNotAccepted);
        };
        let free = from.amount.saturating_sub(owed);
        if free > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    token::Transfer {
                        from: from.to_account_info(),
                        to: to.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    &[seeds],
                ),
                free,
            )?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// init_ledger — creates one `VaultLedger` shard (#12). Permissionless and idempotent by
// construction (`init` fails once the PDA exists; contents are zero + shard + bump). Run once
// per shard at deploy (`scripts/setup.ts --step ledgers`).
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(shard: u8)]
pub struct InitLedger<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + VaultLedger::INIT_SPACE, seeds = [VaultLedger::SEED, &[shard]], bump)]
    pub ledger: Account<'info, VaultLedger>,
    pub system_program: Program<'info, System>,
}

pub fn init_ledger(ctx: Context<InitLedger>, shard: u8) -> Result<()> {
    require!(shard < LEDGER_SHARDS, ChipError::InvalidShard);
    let l = &mut ctx.accounts.ledger;
    l.shard = shard;
    l.liab_lamports = 0;
    l.liab_usdc = 0;
    l.liab_cg = 0;
    l.liab_skr = 0;
    l.burned_total = 0;
    l.bump = ctx.bumps.ledger;
    Ok(())
}
