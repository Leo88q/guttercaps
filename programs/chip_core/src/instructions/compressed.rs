//! Bubblegum V2 compressed-chip registration.
//!
//! Registration is deliberately proof-backed. DAS may supply transport data,
//! but only Account Compression's `verify_leaf` CPI can authorize creation of
//! a Core-owned game projection. The economically relevant roll is authorized
//! first by a one-time `CompressedMintClaim`; a cranker cannot choose rarity or
//! collection while submitting the proof.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_lang::AccountDeserialize;
use anchor_spl::token::{self, Mint, Token, TokenAccount};
use mpl_bubblegum::{
    instructions::MintV2CpiBuilder,
    types::{Creator, MetadataArgsV2, TokenStandard},
};
use mpl_core::ID as MPL_CORE_ID;

use crate::{
    bubblegum::{
        leaf_asset_id, require_bubblegum_program, tree_config_pda, verify_v2_leaf, LeafProofArgs,
        MPL_ACCOUNT_COMPRESSION_ID, MPL_NOOP_ID,
    },
    economy::{
        expand, recipe_for, success_threshold, uniform_bps, PackDef, Rarity, BPS_DENOM,
        CG_PACK_BURN_BPS, MATERIALS_PER_FUSION, MAX_CHIPS_PER_PACK, MAX_PACK_QTY,
    },
    errors::ChipError,
    instructions::packs::{DAY, RENT_RESERVE_PER_CHIP},
    randomness,
    state::{
        BubblegumTreeMeta, CollectionMeta, CompressedChipStaged, CompressedChipState,
        CompressedClaimListedSet, CompressedClaimStakedSet, CompressedClaimTransferred,
        CompressedClaimsFused, CompressedMintClaim, CompressedPackSettlement, GameConfig,
        PendingClaimFusion, PendingPack, PlayerItems, PlayerPity, VaultLedger,
    },
    BUBBLEGUM_V2_ID,
};

#[derive(Accounts)]
#[instruction(buyer_key: Pubkey, collection_idx: u8, claim_nonce: u64)]
pub struct StageCompressedChip<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin @ ChipError::Unauthorized)]
    pub config: Box<Account<'info, GameConfig>>,
    #[account(
        seeds = [b"collection".as_ref(), &[collection_idx][..]],
        bump = collection.bump,
        constraint = collection.idx == collection_idx @ ChipError::InvalidCollection,
    )]
    pub collection: Box<Account<'info, CollectionMeta>>,
    #[account(
        seeds = [b"bubblegum_tree", &[collection_idx]],
        bump = tree_meta.bump,
        constraint = tree_meta.active @ ChipError::InvalidBubblegumTree,
        constraint = tree_meta.collection_idx == collection_idx @ ChipError::InvalidBubblegumTree,
        constraint = tree_meta.core_collection == collection.core_collection @ ChipError::InvalidBubblegumTree,
        constraint = tree_meta.tree_authority == collection.key() @ ChipError::InvalidBubblegumTree,
    )]
    pub tree_meta: Box<Account<'info, BubblegumTreeMeta>>,
    #[account(
        init,
        payer = admin,
        space = 8 + CompressedMintClaim::INIT_SPACE,
        seeds = [b"compressed_claim", buyer_key.as_ref(), &claim_nonce.to_le_bytes()],
        bump,
    )]
    pub claim: Box<Account<'info, CompressedMintClaim>>,
    /// CHECK: the buyer is bound into the claim PDA and the later registration.
    #[account(address = buyer_key)]
    pub buyer: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// The market program cannot serialize a claim it does not own. These two
/// narrow CPI transitions keep the claim state authoritative in chip_core
/// while authenticating the market PDA in the same way as the Core-chip hooks.
#[derive(Accounts)]
pub struct SetCompressedClaimListed<'info> {
    pub caller: Signer<'info>,
    #[account(mut)]
    pub claim: Box<Account<'info, CompressedMintClaim>>,
}

pub fn set_compressed_claim_listed(
    ctx: Context<SetCompressedClaimListed>,
    expected_owner: Pubkey,
    listed: bool,
) -> Result<()> {
    let (market_auth, _) = Pubkey::find_program_address(
        &[b"market_auth"],
        &crate::instructions::chip::MARKET_PROGRAM_ID,
    );
    require_keys_eq!(
        ctx.accounts.caller.key(),
        market_auth,
        ChipError::NotProgramCaller
    );
    require_keys_eq!(
        ctx.accounts.claim.buyer,
        expected_owner,
        ChipError::NotAssetOwner
    );
    if listed {
        require!(
            (!ctx.accounts.claim.minted || ctx.accounts.claim.registered)
                && !ctx.accounts.claim.consumed
                && !ctx.accounts.claim.listed
                && !ctx.accounts.claim.staked
                // Soulbound / fusion-locked claims cannot be listed (mirrors the
                // Core `F_SOULBOUND` gate in the market program). Un-listing stays
                // open so a lock can never trap a live listing.
                && Clock::get()?.unix_timestamp >= ctx.accounts.claim.lock_until,
            ChipError::InvalidChipState
        );
        // SEC-F01: a pack claim still bound to a live CompressedPackSettlement may only trade
        // after it is minted AND registered. Selling it earlier bricks the settlement forever:
        // register_compressed_chip requires settlement.buyer == claim.buyer and
        // cancel_compressed_claim derives its PDAs from a single signer (has_one = buyer) — both
        // are unsatisfiable for everyone after a transfer, so the purchase liability would lock
        // in the vault permanently. Legacy/admin-staged claims carry settlement == default and
        // are exempt: they have no settlement to brick.
        if ctx.accounts.claim.settlement != Pubkey::default() {
            require!(
                ctx.accounts.claim.minted && ctx.accounts.claim.registered,
                ChipError::InvalidChipState
            );
        }
    } else {
        require!(ctx.accounts.claim.listed, ChipError::InvalidChipState);
    }
    ctx.accounts.claim.listed = listed;
    emit!(CompressedClaimListedSet {
        claim: ctx.accounts.claim.key(),
        buyer: ctx.accounts.claim.buyer,
        listed
    });
    Ok(())
}

#[derive(Accounts)]
pub struct TransferCompressedClaim<'info> {
    pub caller: Signer<'info>,
    #[account(mut)]
    pub claim: Box<Account<'info, CompressedMintClaim>>,
}

pub fn transfer_compressed_claim(
    ctx: Context<TransferCompressedClaim>,
    expected_seller: Pubkey,
    new_owner: Pubkey,
) -> Result<()> {
    let (market_auth, _) = Pubkey::find_program_address(
        &[b"market_auth"],
        &crate::instructions::chip::MARKET_PROGRAM_ID,
    );
    require_keys_eq!(
        ctx.accounts.caller.key(),
        market_auth,
        ChipError::NotProgramCaller
    );
    require_keys_eq!(
        ctx.accounts.claim.buyer,
        expected_seller,
        ChipError::NotAssetOwner
    );
    require!(
        ctx.accounts.claim.listed
            && (!ctx.accounts.claim.minted || ctx.accounts.claim.registered)
            && !ctx.accounts.claim.consumed
            && !ctx.accounts.claim.staked,
        ChipError::InvalidChipState
    );
    // SEC-F01: same settlement gate as set_compressed_claim_listed — defense in depth against a
    // listing created before the gate existed (or by a future caller that skips the list path).
    if ctx.accounts.claim.settlement != Pubkey::default() {
        require!(
            ctx.accounts.claim.minted && ctx.accounts.claim.registered,
            ChipError::InvalidChipState
        );
    }
    ctx.accounts.claim.buyer = new_owner;
    ctx.accounts.claim.listed = false;
    emit!(CompressedClaimTransferred {
        claim: ctx.accounts.claim.key(),
        from: expected_seller,
        to: new_owner
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SetCompressedClaimStaked<'info> {
    pub caller: Signer<'info>,
    #[account(mut)]
    pub claim: Box<Account<'info, CompressedMintClaim>>,
}

pub fn set_compressed_claim_staked(
    ctx: Context<SetCompressedClaimStaked>,
    expected_owner: Pubkey,
    staked: bool,
) -> Result<()> {
    let (stake_auth, _) = Pubkey::find_program_address(
        &[b"stake_auth"],
        &crate::instructions::chip::STAKING_PROGRAM_ID,
    );
    require_keys_eq!(
        ctx.accounts.caller.key(),
        stake_auth,
        ChipError::NotProgramCaller
    );
    require_keys_eq!(
        ctx.accounts.claim.buyer,
        expected_owner,
        ChipError::NotAssetOwner
    );
    if staked {
        require!(
            !ctx.accounts.claim.listed
                && !ctx.accounts.claim.consumed
                && !ctx.accounts.claim.staked,
            ChipError::InvalidChipState
        );
    } else {
        require!(ctx.accounts.claim.staked, ChipError::InvalidChipState);
    }
    ctx.accounts.claim.staked = staked;
    emit!(CompressedClaimStakedSet {
        claim: ctx.accounts.claim.key(),
        buyer: ctx.accounts.claim.buyer,
        staked
    });
    Ok(())
}

/// Authorize one expected economic result before the Bubblegum mint and DAS
/// indexing steps. This is currently admin-called; integrating it directly
/// into `open_pack` is the next migration step, so no release should treat
/// this staging entrypoint as a replacement for the old Core pipeline yet.
#[allow(clippy::too_many_arguments)]
pub fn stage_compressed_chip(
    ctx: Context<StageCompressedChip>,
    buyer: Pubkey,
    collection_idx: u8,
    _claim_nonce: u64,
    rarity: u8,
    level: u8,
    game_index: u64,
    expires_at: i64,
) -> Result<()> {
    let rarity = Rarity::from_index(rarity).ok_or(error!(ChipError::InvalidCollection))?;
    require!(
        level >= 1 && level <= rarity.max_level(),
        ChipError::InvalidChipState
    );
    let now = Clock::get()?.unix_timestamp;
    require!(expires_at > now, ChipError::InvalidBubblegumProof);
    require!(
        expires_at <= now.checked_add(7 * 86_400).ok_or(ChipError::Overflow)?,
        ChipError::InvalidBubblegumProof
    );

    let claim = &mut ctx.accounts.claim;
    claim.buyer = buyer;
    claim.collection_idx = collection_idx;
    claim.rarity = rarity;
    claim.level = level;
    claim.game_index = game_index;
    claim.expires_at = expires_at;
    claim.settlement = Pubkey::default();
    claim.index_reserved = false;
    claim.minted = false;
    claim.registered = false;
    claim.consumed = false;
    claim.listed = false;
    claim.bump = ctx.bumps.claim;
    claim.staked = false;
    claim.origin = buyer;
    // Admin-staged claims carry no purchase, hence no soulbound window and no founder origin.
    claim.lock_until = 0;
    claim.founder = false;
    emit!(CompressedChipStaged {
        admin: ctx.accounts.admin.key(),
        buyer,
        claim: claim.key(),
        collection_idx,
        rarity: rarity.index(),
        level,
        game_index,
        expires_at,
    });
    Ok(())
}

/// Anchor 0.31 does not reject the same account passed twice (the `dup` constraint only
/// arrives in 1.0), and `remaining_accounts` are never deduplicated. Every loop that
/// consumes materials from `remaining_accounts` must call this before accepting `key`.
pub(crate) fn ensure_distinct_material(previous: &[Pubkey], key: &Pubkey) -> Result<()> {
    require!(!previous.contains(key), ChipError::DuplicateMaterial);
    Ok(())
}

/// Multiplier between pack nonces in the derived claim nonce:
/// `claim_nonce = nonce * STRIDE + pack_no * MAX_CHIPS_PER_PACK + chip_index`.
///
/// Two different triples must never land on the same claim PDA. `open_compressed_pack` refuses an
/// existing claim account, so a collision is not a double-mint — it is worse for the buyer: the pack
/// can never be opened, the settlement never reaches `total_claims`, and `finalize_compressed_pack`
/// (the only path that releases the vault liability and refunds a cancelled share) can never run.
/// The requirement is `MAX_PACK_QTY * MAX_CHIPS_PER_PACK <= STRIDE`, and it is checked by the compiler
/// rather than by this comment: bumping `MAX_CHIPS_PER_PACK` to 6, or `MAX_PACK_QTY` past 25, fails
/// the build instead of silently making one paid pack in every 128 nonces unopenable.
const COMPRESSED_CLAIM_PACK_STRIDE: u64 = 128;
const _: () =
    assert!(MAX_CHIPS_PER_PACK * (MAX_PACK_QTY as usize) <= COMPRESSED_CLAIM_PACK_STRIDE as usize);

/// Refund the cancelled share of a pack without losing value to integer
/// truncation. Rounding is upward for the buyer and the registered side gets
/// the complementary remainder.
fn pro_rata_refund(amount: u64, cancelled_claims: u16, total_claims: u16) -> Result<u64> {
    if total_claims == 0 || cancelled_claims > total_claims {
        return Err(error!(ChipError::InvalidChipState));
    }
    let total = u64::from(total_claims);
    let cancelled = u64::from(cancelled_claims);
    let numerator = amount
        .checked_mul(cancelled)
        .ok_or(ChipError::Overflow)?
        .checked_add(total.checked_sub(1).ok_or(ChipError::Overflow)?)
        .ok_or(ChipError::Overflow)?;
    numerator
        .checked_div(total)
        .ok_or(ChipError::Overflow.into())
}

#[derive(Accounts)]
#[instruction(nonce: u64, pack_no: u8)]
pub struct OpenCompressedPack<'info> {
    /// Anyone may crank the deterministic roll and pay claim/settlement rent.
    #[account(mut)]
    pub payer: Signer<'info>,
    // Pausing blocks new purchases and minting, but does not strand an already
    // paid pack. Existing claims must remain openable so a circuit breaker
    // cannot turn an in-flight settlement into a permanent liability.
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, GameConfig>>,
    #[account(
        mut,
        seeds = [b"pending", pending.buyer.as_ref(), &nonce.to_le_bytes()],
        bump = pending.bump,
        constraint = pending.randomness == randomness.key() @ ChipError::RandomnessMismatch,
        constraint = pack_no == pending.opened && pack_no < pending.qty @ ChipError::InvalidQuantity,
    )]
    pub pending: Box<Account<'info, PendingPack>>,
    /// CHECK: parsed by the randomness helper and pinned in PendingPack.
    #[account(address = pending.randomness @ ChipError::RandomnessMismatch)]
    pub randomness: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"pity", pending.buyer.as_ref()], bump = pity.bump)]
    pub pity: Box<Account<'info, PlayerPity>>,
    // Note: PDA cannot be closed; Anchor discriminator prevents re-init
    // sentio-ignore-next-line SW016
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + CompressedPackSettlement::INIT_SPACE,
        seeds = [b"compressed_settlement", pending.buyer.as_ref(), &nonce.to_le_bytes()],
        bump,
    )]
    pub settlement: Box<Account<'info, CompressedPackSettlement>>,
    /// CHECK: the buyer is bound by PendingPack and receives no authority here.
    #[account(address = pending.buyer)]
    pub buyer: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    // Remaining accounts, three per rolled chip:
    //   claim PDA, CollectionMeta PDA, BubblegumTreeMeta PDA.
}

/// Resolve one pending pack into claim-bound Bubblegum mints. No Core asset is
/// created here: the claims are later consumed by `mint_compressed_chip`, and
/// registration remains asynchronous until DAS supplies the finalized leaf.
// sentio-ignore-fn SW023
pub fn open_compressed_pack<'info>(
    ctx: Context<'_, '_, 'info, 'info, OpenCompressedPack<'info>>,
    nonce: u64,
    pack_no: u8,
) -> Result<()> {
    let is_voucher = ctx.accounts.pending.voucher;
    let def = if is_voucher {
        PackDef::voucher(ctx.accounts.pending.voucher_odds)
    } else {
        *ctx.accounts
            .config
            .packs
            .get(ctx.accounts.pending.sku as usize)
            .ok_or(ChipError::InvalidSku)?
    };
    let chips = def.chips as usize;
    require!(
        chips > 0 && chips <= MAX_CHIPS_PER_PACK,
        ChipError::InvalidQuantity
    );
    require!(
        ctx.remaining_accounts.len() == chips * 3,
        ChipError::InvalidQuantity
    );

    let base = if ctx.accounts.pending.revealed {
        ctx.accounts.pending.value
    } else {
        let rnd = randomness::parse_checked(&ctx.accounts.randomness, ctx.program_id)?;
        let value = randomness::revealed_value(&rnd, ctx.accounts.pending.commit_slot)?;
        ctx.accounts.pending.value = value;
        ctx.accounts.pending.revealed = true;
        value
    };
    let bytes = if ctx.accounts.pending.qty == 1 {
        base
    } else {
        anchor_lang::solana_program::keccak::hashv(&[&base, &[pack_no]]).to_bytes()
    };
    let pool: Vec<u8> = if def.featured_only {
        vec![ctx.accounts.config.featured_collection]
    } else {
        (0..ctx.accounts.config.collections_created).collect()
    };
    require!(!pool.is_empty(), ChipError::InvalidCollection);

    let pity_before = ctx.accounts.pity.counters[ctx.accounts.pending.sku as usize];
    let rolled = expand(&bytes, &def, pity_before, &pool);
    let payer_before = ctx.accounts.payer.lamports();
    let settlement_key = ctx.accounts.settlement.key();
    {
        let settlement = &mut ctx.accounts.settlement;
        if settlement.buyer == Pubkey::default() {
            settlement.buyer = ctx.accounts.pending.buyer;
            settlement.pending = ctx.accounts.pending.key();
            settlement.nonce = nonce;
            settlement.total_claims = 0;
            settlement.registered_claims = 0;
            settlement.cancelled_claims = 0;
            settlement.bump = ctx.bumps.settlement;
        } else {
            require_keys_eq!(
                settlement.buyer,
                ctx.accounts.pending.buyer,
                ChipError::InvalidChipState
            );
            require_keys_eq!(
                settlement.pending,
                ctx.accounts.pending.key(),
                ChipError::InvalidChipState
            );
            require!(settlement.nonce == nonce, ChipError::InvalidChipState);
        }
    }

    let buyer = ctx.accounts.pending.buyer;
    let mut claim_nonces = [0u64; MAX_CHIPS_PER_PACK];
    for i in 0..chips {
        let rolled_chip = rolled[i].ok_or(ChipError::Overflow)?;
        let accounts = &ctx.remaining_accounts[i * 3..i * 3 + 3];
        let claim_ai = &accounts[0];
        let collection_ai = &accounts[1];
        let tree_meta_ai = &accounts[2];
        let claim_nonce = nonce
            .checked_mul(COMPRESSED_CLAIM_PACK_STRIDE)
            .and_then(|v| v.checked_add((pack_no as u64) * MAX_CHIPS_PER_PACK as u64))
            .and_then(|v| v.checked_add(i as u64))
            .ok_or(ChipError::Overflow)?;
        claim_nonces[i] = claim_nonce;
        let (expected_claim, claim_bump) = Pubkey::find_program_address(
            &[
                b"compressed_claim",
                buyer.as_ref(),
                &claim_nonce.to_le_bytes(),
            ],
            ctx.program_id,
        );
        require_keys_eq!(expected_claim, claim_ai.key(), ChipError::InvalidChipState);
        require!(claim_ai.data_is_empty(), ChipError::InvalidChipState);

        let (expected_collection, _) = Pubkey::find_program_address(
            &[b"collection", &[rolled_chip.collection_idx]],
            ctx.program_id,
        );
        require_keys_eq!(
            expected_collection,
            collection_ai.key(),
            ChipError::InvalidCollection
        );
        let mut collection: Account<CollectionMeta> = Account::try_from(collection_ai)?;
        require!(
            collection.idx == rolled_chip.collection_idx,
            ChipError::InvalidCollection
        );

        let (expected_tree, _) = Pubkey::find_program_address(
            &[b"bubblegum_tree", &[rolled_chip.collection_idx]],
            ctx.program_id,
        );
        require_keys_eq!(
            expected_tree,
            tree_meta_ai.key(),
            ChipError::InvalidBubblegumTree
        );
        let tree_meta: Account<BubblegumTreeMeta> = Account::try_from(tree_meta_ai)?;
        require!(tree_meta.active, ChipError::InvalidBubblegumTree);
        require!(
            tree_meta.core_collection == collection.core_collection
                && tree_meta.tree_authority == collection.key(),
            ChipError::InvalidBubblegumTree
        );

        collection.minted = collection
            .minted
            .checked_add(1)
            .ok_or(ChipError::Overflow)?;
        let rarity_index = rolled_chip.rarity.index() as usize;
        collection.minted_by_rarity[rarity_index] = collection.minted_by_rarity[rarity_index]
            .checked_add(1)
            .ok_or(ChipError::Overflow)?;
        let game_index = collection.minted;
        // Soulbound window from the purchase (Starter: 7 days; quest vouchers: the
        // template's `soulbound_days`, 0 = tradeable at once) — mirrors the legacy
        // `open_pack` mapping, enforced at listing time on the market program.
        let lock_until = if ctx.accounts.pending.soulbound_days > 0 {
            Clock::get()?
                .unix_timestamp
                .checked_add(ctx.accounts.pending.soulbound_days as i64 * DAY)
                .ok_or(ChipError::Overflow)?
        } else {
            0
        };
        let claim = CompressedMintClaim {
            buyer,
            collection_idx: rolled_chip.collection_idx,
            rarity: rolled_chip.rarity,
            level: 1,
            game_index,
            expires_at: Clock::get()?
                .unix_timestamp
                .checked_add(7 * 86_400)
                .ok_or(ChipError::Overflow)?,
            settlement: settlement_key,
            index_reserved: true,
            minted: false,
            registered: false,
            consumed: false,
            listed: false,
            bump: claim_bump,
            staked: false,
            origin: buyer,
            lock_until,
            founder: ctx.accounts.pending.preorder,
        };
        let space = 8 + CompressedMintClaim::INIT_SPACE;
        system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::CreateAccount {
                    from: ctx.accounts.payer.to_account_info(),
                    to: claim_ai.clone(),
                },
                &[&[
                    b"compressed_claim",
                    buyer.as_ref(),
                    &claim_nonce.to_le_bytes(),
                    &[claim_bump],
                ]],
            ),
            Rent::get()?.minimum_balance(space),
            space as u64,
            ctx.program_id,
        )?;
        {
            let mut data = claim_ai.try_borrow_mut_data()?;
            data[..8].copy_from_slice(CompressedMintClaim::DISCRIMINATOR);
            claim.serialize(&mut &mut data[8..])?;
        }
        collection.exit(ctx.program_id)?;
        ctx.accounts.settlement.total_claims = ctx
            .accounts
            .settlement
            .total_claims
            .checked_add(1)
            .ok_or(ChipError::Overflow)?;
    }

    if def.pity_tier > 0 {
        let sku = ctx.accounts.pending.sku as usize;
        let got_pity_tier = rolled[..chips]
            .iter()
            .flatten()
            .any(|r| r.rarity.index() >= def.pity_tier);
        ctx.accounts.pity.counters[sku] = if got_pity_tier {
            0
        } else {
            ctx.accounts.pity.counters[sku].saturating_add(1)
        };
    }
    let spent = payer_before.saturating_sub(ctx.accounts.payer.lamports());
    let reserve = RENT_RESERVE_PER_CHIP
        .checked_mul(chips as u64)
        .ok_or(ChipError::Overflow)?;
    let reimbursement = spent
        .min(reserve)
        .min(ctx.accounts.pending.to_account_info().lamports());
    if reimbursement > 0 {
        let pending_ai = ctx.accounts.pending.to_account_info();
        let payer_ai = ctx.accounts.payer.to_account_info();
        **pending_ai.try_borrow_mut_lamports()? -= reimbursement;
        **payer_ai.try_borrow_mut_lamports()? += reimbursement;
    }
    ctx.accounts.pending.opened = ctx
        .accounts
        .pending
        .opened
        .checked_add(1)
        .ok_or(ChipError::Overflow)?;
    emit!(CompressedClaimsCreated {
        buyer,
        nonce,
        pack_no,
        claim_nonces,
        count: chips as u8,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(result_claim_nonce: u64, result_collection_idx: u8)]
pub struct FuseCompressedClaims<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, constraint = !config.paused @ ChipError::Paused)]
    pub config: Box<Account<'info, GameConfig>>,
    #[account(mut, seeds = [VaultLedger::SEED, &[VaultLedger::shard_of(&owner.key())]], bump = ledger.bump)]
    pub ledger: Box<Account<'info, VaultLedger>>,
    #[account(
        mut,
        seeds = [b"collection", &[result_collection_idx]],
        bump = result_meta.bump,
        constraint = result_meta.idx == result_collection_idx @ ChipError::InvalidCollection,
    )]
    pub result_meta: Box<Account<'info, CollectionMeta>>,
    #[account(
        init,
        payer = owner,
        space = 8 + CompressedMintClaim::INIT_SPACE,
        seeds = [b"compressed_claim", owner.key().as_ref(), &result_claim_nonce.to_le_bytes()],
        bump,
    )]
    pub result_claim: Box<Account<'info, CompressedMintClaim>>,
    #[account(mut, address = config.cg_mint)]
    pub cg_mint: Account<'info, Mint>,
    #[account(mut, token::mint = config.cg_mint, token::authority = owner)]
    pub owner_cg: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Fuse three proof-backed Bubblegum claims without manufacturing an MPL-Core
/// asset. The claims are consumed atomically and the result is another
/// claim-bound mint authorization; Bubblegum minting and DAS registration stay
/// separate from the economic transition.
///
/// Deterministic recipes only (Common→Rare+, 100 %): recipes with < 100 %
/// success (Epic and above) resolve through `fuse_claims_commit` /
/// `fuse_claims_reveal` below so the roll stays unpredictable.
// sentio-ignore-fn SW023
pub fn fuse_compressed_claims<'info>(
    ctx: Context<'_, '_, 'info, 'info, FuseCompressedClaims<'info>>,
    result_claim_nonce: u64,
    result_collection_idx: u8,
) -> Result<()> {
    require!(
        ctx.remaining_accounts.len() == 3,
        ChipError::InvalidQuantity
    );
    let mut materials = [(Rarity::Common, 0u8); MATERIALS_PER_FUSION];
    let mut material_keys = [Pubkey::default(); MATERIALS_PER_FUSION];
    let mut input_collection = 0u8;
    for (i, claim_ai) in ctx.remaining_accounts.iter().enumerate() {
        require!(claim_ai.is_writable, ChipError::AccountNotWritable);
        let claim: Account<CompressedMintClaim> = Account::try_from(claim_ai)?;
        require!(
            claim.buyer == ctx.accounts.owner.key(),
            ChipError::NotAssetOwner
        );
        require!(
            !claim.consumed && !claim.listed && !claim.staked,
            ChipError::InvalidChipState
        );
        // SEC-G03: a material is consumed here without being closed, and this instruction
        // never sees the material's CompressedPackSettlement. An UNMINTED pack claim still bound
        // to a live settlement therefore stayed cancellable after fusion; once a pack chip is
        // minted and registered (`claim.minted && claim.registered`), `cancel_compressed_claim`
        // is permanently blocked (`!claim.minted && !claim.consumed`).
        require!(
            (claim.minted && claim.registered)
                || (!claim.minted
                    && claim.settlement == Pubkey::default()
                    && Clock::get()?.unix_timestamp < claim.expires_at),
            ChipError::InvalidChipState
        );
        // Soulbound / fusion-locked materials cannot fuse (mirrors the Core
        // `load_materials` soulbound gate).
        require!(
            Clock::get()?.unix_timestamp >= claim.lock_until,
            ChipError::ChipNotFree
        );
        // SEC-F2 (2026-09-25): the same claim passed 2-3x in remaining_accounts used to pass
        // every per-claim check, get marked `consumed` once and still yield a next-rarity
        // result (x3 rarity inflation per step, Common -> Rare+ out of one claim chain).
        // Same guard as `fuse_claims_commit` and the Core `fuse` path.
        ensure_distinct_material(&material_keys[..i], &claim_ai.key())?;
        if i == 0 {
            input_collection = claim.collection_idx;
        }
        materials[i] = (claim.rarity, claim.collection_idx);
        material_keys[i] = claim_ai.key();
    }
    let input = materials[0].0;
    let recipe = recipe_for(input).ok_or(ChipError::NoRecipe)?;
    require!(recipe.success_bps == 10_000, ChipError::RandomnessMismatch);
    for (rarity, _) in materials {
        require!(rarity == input, ChipError::MaterialRarityMismatch);
    }
    if recipe.same_collection {
        for (_, collection) in materials {
            require!(
                collection == input_collection,
                ChipError::MaterialCollectionMismatch
            );
        }
        require!(
            result_collection_idx == input_collection,
            ChipError::MaterialCollectionMismatch
        );
    } else {
        require!(
            materials
                .iter()
                .any(|(_, collection)| *collection == result_collection_idx),
            ChipError::MaterialCollectionMismatch
        );
    }

    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token::Burn {
                mint: ctx.accounts.cg_mint.to_account_info(),
                from: ctx.accounts.owner_cg.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        recipe.fee_cg_micro,
    )?;
    ctx.accounts.ledger.burned_total = ctx
        .accounts
        .ledger
        .burned_total
        .checked_add(recipe.fee_cg_micro)
        .ok_or(ChipError::Overflow)?;

    for claim_ai in ctx.remaining_accounts.iter() {
        let mut data = claim_ai.try_borrow_mut_data()?;
        let mut cursor: &[u8] = &data;
        let mut claim = CompressedMintClaim::try_deserialize(&mut cursor)?;
        claim.consumed = true;
        let _ = cursor;
        claim.serialize(&mut &mut data[8..])?;
    }
    let next_rarity = Rarity::from_index(input.index() + 1).ok_or(ChipError::NoRecipe)?;
    ctx.accounts.result_meta.minted = ctx
        .accounts
        .result_meta
        .minted
        .checked_add(1)
        .ok_or(ChipError::Overflow)?;
    ctx.accounts.result_meta.minted_by_rarity[next_rarity.index() as usize] =
        ctx.accounts.result_meta.minted_by_rarity[next_rarity.index() as usize]
            .checked_add(1)
            .ok_or(ChipError::Overflow)?;
    let result = &mut ctx.accounts.result_claim;
    result.buyer = ctx.accounts.owner.key();
    result.collection_idx = result_collection_idx;
    result.rarity = next_rarity;
    result.level = 1;
    result.game_index = ctx.accounts.result_meta.minted;
    result.expires_at = Clock::get()?
        .unix_timestamp
        .checked_add(7 * 86_400)
        .ok_or(ChipError::Overflow)?;
    result.settlement = Pubkey::default();
    result.index_reserved = false;
    result.minted = false;
    result.consumed = false;
    result.listed = false;
    result.bump = ctx.bumps.result_claim;
    result.staked = false;
    result.origin = ctx.accounts.owner.key();
    // The recipe's fusion-result lock (Rare+ 1 h … Legend+ 72 h) — previously
    // dropped on the compressed path; enforced at listing time.
    result.lock_until = if recipe.result_lock_secs > 0 {
        Clock::get()?
            .unix_timestamp
            .checked_add(recipe.result_lock_secs)
            .ok_or(ChipError::Overflow)?
    } else {
        0
    };
    // SEC-G04 (Watchtower SW027): the only reachable fusion on a Bubblegum V2 deployment had no
    // event, so quests/activity (`fusions` projection, fed by Core `ChipFused`) never saw it.
    emit!(CompressedClaimsFused {
        owner: ctx.accounts.owner.key(),
        recipe: input.index(),
        materials: material_keys,
        result_claim: result.key(),
        result_claim_nonce,
        result_collection_idx,
        result_rarity: next_rarity.index(),
        fee_burned: recipe.fee_cg_micro,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Randomized fusion of compressed claims (Epic and above).
//
// `fuse_compressed_claims` above is deterministic-only, which left the Epic+
// recipes (85/75/70/50 % success) unreachable on a Bubblegum V2 deployment —
// no Core chips exist to feed Core `fuse`. This commit/reveal pair mirrors the
// Core `fuse` / `fuse_reveal` economics on claims: the fee is escrowed in the
// vault (SEC-M3), the materials are marked `consumed` at commit, and the
// reveal un-consumes the `refund_on_fail` survivors (lowest claim keys first)
// or mints the result claim on success.
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct FuseClaimsCommit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, constraint = !config.paused @ ChipError::Paused)]
    pub config: Box<Account<'info, GameConfig>>,
    /// Liability shard of the owner (#12): the escrowed fee lands in `liab_cg`.
    #[account(mut, seeds = [VaultLedger::SEED, &[VaultLedger::shard_of(&owner.key())]], bump = ledger.bump)]
    pub ledger: Box<Account<'info, VaultLedger>>,

    #[account(
        init, payer = owner, space = 8 + PendingClaimFusion::INIT_SPACE,
        seeds = [b"claim_fusion", owner.key().as_ref(), &nonce.to_le_bytes()], bump
    )]
    pub pending: Box<Account<'info, PendingClaimFusion>>,

    /// CHECK: program-owned Switchboard randomness `["rng", 3, owner, nonce]` created by
    /// `init_randomness` in this tx and committed HERE by CPI (SEC-C3 part 2). Kind 3, never
    /// kind 1: a Core fusion and a claim fusion must not share one randomness PDA on any nonce.
    #[account(
        mut, owner = crate::ID @ ChipError::RandomnessMismatch,
        seeds = [randomness::RNG_SEED, &[randomness::RNG_KIND_CLAIM_FUSION], owner.key().as_ref(), &nonce.to_le_bytes()], bump,
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

    // Note: PDA cannot be closed; Anchor discriminator prevents re-init
    // sentio-ignore-next-line SW016
    #[account(
        init_if_needed, payer = owner, space = 8 + PlayerItems::INIT_SPACE,
        seeds = [b"items", owner.key().as_ref()], bump
    )]
    pub items: Box<Account<'info, PlayerItems>>,

    /// Target collection of the result (any material's collection for "any" recipes; the shared one otherwise).
    #[account(mut, seeds = [b"collection", &[result_meta.idx]], bump = result_meta.bump)]
    pub result_meta: Box<Account<'info, CollectionMeta>>,

    #[account(mut, address = config.cg_mint)]
    pub cg_mint: Account<'info, Mint>,
    #[account(mut, token::mint = config.cg_mint, token::authority = owner)]
    pub owner_cg: Account<'info, TokenAccount>,
    // sentio-ignore-next-line SW013
    /// CHECK: program vault PDA — authority of `vault_cg` (SEC-M3 fee escrow).
    #[account(seeds = [b"vault"], bump = config.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// Fee escrow: the same vault $CG ATA `buy_pack` uses.
    #[account(mut, token::mint = config.cg_mint, token::authority = vault)]
    pub vault_cg: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    // remaining_accounts: the 3 material claim accounts (mut).
}

// sentio-ignore-fn SW023
pub fn fuse_claims_commit<'info>(
    ctx: Context<'_, '_, 'info, 'info, FuseClaimsCommit<'info>>,
    nonce: u64,
    use_booster: bool,
) -> Result<()> {
    require!(
        ctx.remaining_accounts.len() == MATERIALS_PER_FUSION,
        ChipError::InvalidQuantity
    );
    let owner_key = ctx.accounts.owner.key();
    let now = Clock::get()?.unix_timestamp;
    let mut materials = [(Rarity::Common, 0u8); MATERIALS_PER_FUSION];
    let mut material_keys = [Pubkey::default(); MATERIALS_PER_FUSION];
    let mut input_collection = 0u8;
    for (i, claim_ai) in ctx.remaining_accounts.iter().enumerate() {
        require!(claim_ai.is_writable, ChipError::AccountNotWritable);
        let claim: Account<CompressedMintClaim> = Account::try_from(claim_ai)?;
        require!(claim.buyer == owner_key, ChipError::NotAssetOwner);
        require!(
            !claim.consumed && !claim.listed && !claim.staked,
            ChipError::InvalidChipState
        );
        // SEC-G03, same as the atomic path: unminted claims must be settlement-free and unexpired;
        // minted + registered chips from settled packs are also eligible.
        require!(
            (claim.minted && claim.registered)
                || (!claim.minted
                    && claim.settlement == Pubkey::default()
                    && now < claim.expires_at),
            ChipError::InvalidChipState
        );
        require!(now >= claim.lock_until, ChipError::ChipNotFree);
        ensure_distinct_material(&material_keys[..i], &claim_ai.key())?;
        if i == 0 {
            input_collection = claim.collection_idx;
        }
        materials[i] = (claim.rarity, claim.collection_idx);
        material_keys[i] = claim_ai.key();
    }
    let input = materials[0].0;
    let recipe = recipe_for(input).ok_or(ChipError::NoRecipe)?;
    // Randomized path only: deterministic recipes resolve atomically in
    // `fuse_compressed_claims` without paying for Switchboard.
    require!(recipe.success_bps < 10_000, ChipError::NoRecipe);
    for (rarity, _) in materials {
        require!(rarity == input, ChipError::MaterialRarityMismatch);
    }
    if recipe.same_collection {
        for (_, collection) in materials {
            require!(
                collection == input_collection,
                ChipError::MaterialCollectionMismatch
            );
        }
        require!(
            ctx.accounts.result_meta.idx == input_collection,
            ChipError::MaterialCollectionMismatch
        );
    } else {
        require!(
            materials
                .iter()
                .any(|(_, collection)| *collection == ctx.accounts.result_meta.idx),
            ChipError::MaterialCollectionMismatch
        );
    }
    if use_booster {
        let items = &mut ctx.accounts.items;
        if items.owner == Pubkey::default() {
            items.owner = owner_key;
            items.bump = ctx.bumps.items;
        }
        require_keys_eq!(items.owner, owner_key, ChipError::Unauthorized);
        require!(items.boosters > 0, ChipError::NoBooster);
        items.boosters -= 1;
    }

    // SEC-M3: escrow the fee in the vault — burned by `fuse_claims_reveal`,
    // refunded by `cancel_stale_claim_fusion` (mirrors Core `fuse`).
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token::Transfer {
                from: ctx.accounts.owner_cg.to_account_info(),
                to: ctx.accounts.vault_cg.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        recipe.fee_cg_micro,
    )?;
    ctx.accounts.ledger.add(0, 0, recipe.fee_cg_micro, 0)?;

    let auth_seeds: &[&[u8]] = &[randomness::RNG_AUTH_SEED, &[ctx.bumps.rng_auth]];
    let rnd = randomness::commit_owned(
        ctx.program_id,
        &ctx.accounts.switchboard_program.to_account_info(),
        &ctx.accounts.randomness.to_account_info(),
        &ctx.accounts.queue.to_account_info(),
        &ctx.accounts.oracle.to_account_info(),
        &ctx.accounts.rng_auth.to_account_info(),
        &ctx.accounts.recent_slothashes.to_account_info(),
        &[auth_seeds],
        Clock::get()?.slot,
    )?;

    // Materials are consumed at commit (a live fusion must not be listable /
    // stakeable / fusable twice); the reveal un-consumes the survivors.
    for claim_ai in ctx.remaining_accounts.iter() {
        let mut data = claim_ai.try_borrow_mut_data()?;
        let mut cursor: &[u8] = &data;
        let mut claim = CompressedMintClaim::try_deserialize(&mut cursor)?;
        claim.consumed = true;
        let _ = cursor;
        claim.serialize(&mut &mut data[8..])?;
    }

    let p = &mut ctx.accounts.pending;
    p.owner = owner_key;
    p.recipe = input.index();
    p.materials = material_keys;
    p.result_collection_idx = ctx.accounts.result_meta.idx;
    p.boosted = use_booster;
    p.randomness = ctx.accounts.randomness.key();
    p.commit_slot = rnd.seed_slot;
    p.nonce = nonce;
    p.bump = ctx.bumps.pending;
    p.fee_escrowed = recipe.fee_cg_micro;
    emit!(ClaimFusionCommitted {
        owner: owner_key,
        nonce,
        recipe: input.index(),
        materials: material_keys,
    });
    Ok(())
}

#[event]
pub struct ClaimFusionCommitted {
    pub owner: Pubkey,
    pub nonce: u64,
    pub recipe: u8,
    pub materials: [Pubkey; MATERIALS_PER_FUSION],
}

#[derive(Accounts)]
#[instruction(nonce: u64, result_claim_nonce: u64)]
pub struct FuseClaimsReveal<'info> {
    /// Permissionless crank; closing PendingClaimFusion to payer covers the rent.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, GameConfig>>,
    /// Liability shard of the owner (#12): the escrowed fee leaves `liab_cg` and lands in `burned_total`.
    #[account(mut, seeds = [VaultLedger::SEED, &[VaultLedger::shard_of(&pending.owner)]], bump = ledger.bump)]
    pub ledger: Box<Account<'info, VaultLedger>>,
    #[account(
        mut,
        seeds = [b"claim_fusion", pending.owner.as_ref(), &nonce.to_le_bytes()], bump = pending.bump,
        constraint = pending.randomness == randomness.key() @ ChipError::RandomnessMismatch,
    )]
    pub pending: Box<Account<'info, PendingClaimFusion>>,
    /// CHECK: pinned; owner-checked + parsed in `randomness::parse_checked`
    #[account(address = pending.randomness @ ChipError::RandomnessMismatch)]
    pub randomness: UncheckedAccount<'info>,
    /// CHECK: owner receives the result / refunds
    #[account(mut, address = pending.owner)]
    pub owner: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"collection", &[pending.result_collection_idx]], bump = result_meta.bump)]
    pub result_meta: Box<Account<'info, CollectionMeta>>,
    // sentio-ignore-next-line SW002
    /// CHECK: `["compressed_claim", owner, result_claim_nonce]` — created by the
    /// handler only on success (an `init` account would burn rent on every
    /// failed roll); PDA + emptiness are re-checked before creation.
    #[account(mut)]
    pub result_claim: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW013
    /// CHECK: program vault PDA — signs the escrowed-fee burn (SEC-M3).
    #[account(mut, seeds = [b"vault"], bump = config.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, address = config.cg_mint)]
    pub cg_mint: Account<'info, Mint>,
    #[account(mut, token::mint = config.cg_mint, token::authority = vault)]
    pub vault_cg: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    // remaining_accounts: the 3 material claim accounts (mut), in pending order.
}

// sentio-ignore-fn SW023
pub fn fuse_claims_reveal<'info>(
    ctx: Context<'_, '_, 'info, 'info, FuseClaimsReveal<'info>>,
    _nonce: u64,
    result_claim_nonce: u64,
) -> Result<()> {
    let recipe =
        recipe_for(Rarity::from_index(ctx.accounts.pending.recipe).ok_or(ChipError::NoRecipe)?)
            .ok_or(ChipError::NoRecipe)?;

    // Reveal is read in any slot after `reveal_slot` (persisted field), so a
    // crank or the player can settle whenever the reveal tx has landed (SEC-C2).
    let rnd = randomness::parse_checked(&ctx.accounts.randomness, ctx.program_id)?;
    let value = randomness::revealed_value(&rnd, ctx.accounts.pending.commit_slot)?;
    let roll = uniform_bps(&value, 0);
    let threshold = success_threshold(recipe, ctx.accounts.pending.boosted);
    let success = roll < threshold;

    require!(
        ctx.remaining_accounts.len() == MATERIALS_PER_FUSION,
        ChipError::InvalidQuantity
    );
    // Which materials survive on failure: deterministic — the lowest
    // `refund_on_fail` by claim key (mirrors Core `fuse_reveal`).
    let mut survivors = [false; MATERIALS_PER_FUSION];
    if !success {
        let mut idx: Vec<usize> = (0..MATERIALS_PER_FUSION).collect();
        idx.sort_by_key(|&i| ctx.accounts.pending.materials[i].to_bytes());
        for i in idx.into_iter().take(recipe.refund_on_fail as usize) {
            survivors[i] = true;
        }
    }
    for (m, claim_ai) in ctx.remaining_accounts.iter().enumerate() {
        require!(claim_ai.is_writable, ChipError::AccountNotWritable);
        require_keys_eq!(
            claim_ai.key(),
            ctx.accounts.pending.materials[m],
            ChipError::InvalidChipState
        );
        let mut data = claim_ai.try_borrow_mut_data()?;
        let mut cursor: &[u8] = &data;
        let mut claim = CompressedMintClaim::try_deserialize(&mut cursor)?;
        require!(
            claim.consumed && (!claim.minted || claim.registered),
            ChipError::InvalidChipState
        );
        let _ = cursor;
        if survivors[m] {
            claim.consumed = false;
        }
        claim.serialize(&mut &mut data[8..])?;
    }

    let mut result_key = Pubkey::default();
    if success {
        let next =
            Rarity::from_index(ctx.accounts.pending.recipe + 1).ok_or(ChipError::NoRecipe)?;
        let now = Clock::get()?.unix_timestamp;
        let owner = ctx.accounts.pending.owner;
        let collection_idx = ctx.accounts.pending.result_collection_idx;
        let result_claim_ai = ctx.accounts.result_claim.to_account_info();
        let (expected_claim, claim_bump) = Pubkey::find_program_address(
            &[
                b"compressed_claim",
                owner.as_ref(),
                &result_claim_nonce.to_le_bytes(),
            ],
            ctx.program_id,
        );
        require_keys_eq!(
            expected_claim,
            result_claim_ai.key(),
            ChipError::InvalidChipState
        );
        require!(result_claim_ai.data_is_empty(), ChipError::InvalidChipState);
        ctx.accounts.result_meta.minted = ctx
            .accounts
            .result_meta
            .minted
            .checked_add(1)
            .ok_or(ChipError::Overflow)?;
        ctx.accounts.result_meta.minted_by_rarity[next.index() as usize] =
            ctx.accounts.result_meta.minted_by_rarity[next.index() as usize]
                .checked_add(1)
                .ok_or(ChipError::Overflow)?;
        let game_index = ctx.accounts.result_meta.minted;
        let lock_until = if recipe.result_lock_secs > 0 {
            now.checked_add(recipe.result_lock_secs)
                .ok_or(ChipError::Overflow)?
        } else {
            0
        };
        let space = 8 + CompressedMintClaim::INIT_SPACE;
        system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::CreateAccount {
                    from: ctx.accounts.payer.to_account_info(),
                    to: result_claim_ai.clone(),
                },
                &[&[
                    b"compressed_claim",
                    owner.as_ref(),
                    &result_claim_nonce.to_le_bytes(),
                    &[claim_bump],
                ]],
            ),
            Rent::get()?.minimum_balance(space),
            space as u64,
            ctx.program_id,
        )?;
        let result_data = CompressedMintClaim {
            buyer: owner,
            collection_idx,
            rarity: next,
            level: 1,
            game_index,
            expires_at: now.checked_add(7 * 86_400).ok_or(ChipError::Overflow)?,
            settlement: Pubkey::default(),
            index_reserved: false,
            minted: false,
            registered: false,
            consumed: false,
            listed: false,
            bump: claim_bump,
            staked: false,
            origin: owner,
            lock_until,
            founder: false,
        };
        {
            let mut data = result_claim_ai.try_borrow_mut_data()?;
            data[..8].copy_from_slice(CompressedMintClaim::DISCRIMINATOR);
            result_data.serialize(&mut &mut data[8..])?;
        }
        result_key = result_claim_ai.key();
    }

    // SEC-M3: burn the escrowed fee now that the roll is settled (win or lose).
    let fee = ctx.accounts.pending.fee_escrowed;
    if fee > 0 {
        let vault_seeds: &[&[u8]] = &[b"vault", &[ctx.accounts.config.vault_bump]];
        token::burn(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Burn {
                    mint: ctx.accounts.cg_mint.to_account_info(),
                    from: ctx.accounts.vault_cg.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[vault_seeds],
            ),
            fee,
        )?;
        ctx.accounts.ledger.release(0, 0, fee, 0)?;
        ctx.accounts.ledger.burned(fee);
    }

    emit!(ClaimFusionRevealed {
        owner: ctx.accounts.pending.owner,
        nonce: ctx.accounts.pending.nonce,
        recipe: ctx.accounts.pending.recipe,
        materials: ctx.accounts.pending.materials,
        result_claim: result_key,
        success,
        roll_bps: roll,
        threshold_bps: threshold,
        fee_burned: fee,
    });

    // Close PendingClaimFusion → payer (direct lamport writes, no CPI left).
    let pending_ai = ctx.accounts.pending.to_account_info();
    let payer_ai = ctx.accounts.payer.to_account_info();
    let lamports = pending_ai.lamports();
    **pending_ai.try_borrow_mut_lamports()? = 0;
    **payer_ai.try_borrow_mut_lamports()? = payer_ai
        .lamports()
        .checked_add(lamports)
        .ok_or(ChipError::Overflow)?;
    pending_ai.resize(0)?;
    pending_ai.assign(&system_program::ID);
    Ok(())
}

#[event]
pub struct ClaimFusionRevealed {
    pub owner: Pubkey,
    pub nonce: u64,
    pub recipe: u8,
    pub materials: [Pubkey; MATERIALS_PER_FUSION],
    pub result_claim: Pubkey,
    pub success: bool,
    pub roll_bps: u16,
    pub threshold_bps: u16,
    pub fee_burned: u64,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CancelStaleClaimFusion<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, GameConfig>>,
    /// Liability shard of the owner (#12) — the fee refund releases what the commit escrowed.
    #[account(mut, seeds = [VaultLedger::SEED, &[VaultLedger::shard_of(&owner.key())]], bump = ledger.bump)]
    pub ledger: Box<Account<'info, VaultLedger>>,
    #[account(
        mut, close = owner,
        seeds = [b"claim_fusion", owner.key().as_ref(), &nonce.to_le_bytes()], bump = pending.bump,
        has_one = owner
    )]
    pub pending: Box<Account<'info, PendingClaimFusion>>,
    /// CHECK: pinned; owner-checked + parsed in `randomness::parse_checked`
    #[account(address = pending.randomness)]
    pub randomness: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW013
    /// CHECK: program vault PDA — signs the fee refund (SEC-M3).
    #[account(mut, seeds = [b"vault"], bump = config.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, token::mint = config.cg_mint, token::authority = vault)]
    pub vault_cg: Account<'info, TokenAccount>,
    #[account(mut, token::mint = config.cg_mint, token::authority = owner)]
    pub owner_cg: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    // remaining_accounts: the 3 material claim accounts (mut), in pending order.
}

// sentio-ignore-fn SW023
pub fn cancel_stale_claim_fusion<'info>(
    ctx: Context<'_, '_, 'info, 'info, CancelStaleClaimFusion<'info>>,
    _nonce: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    // Same rule as cancel_stale_fusion (SEC-C3): only an un-revealed request whose oracle window expired.
    let rnd = randomness::parse_checked(&ctx.accounts.randomness, ctx.program_id)?;
    randomness::assert_refundable(&rnd, ctx.accounts.pending.commit_slot, clock.slot)?;

    // SEC-M3: the oracle never answered → the fee goes back, 100 %
    let fee = ctx.accounts.pending.fee_escrowed;
    if fee > 0 {
        let vault_seeds: &[&[u8]] = &[b"vault", &[ctx.accounts.config.vault_bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.vault_cg.to_account_info(),
                    to: ctx.accounts.owner_cg.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[vault_seeds],
            ),
            fee,
        )?;
        ctx.accounts.ledger.release(0, 0, fee, 0)?;
    }

    require!(
        ctx.remaining_accounts.len() == MATERIALS_PER_FUSION,
        ChipError::InvalidQuantity
    );
    for (m, claim_ai) in ctx.remaining_accounts.iter().enumerate() {
        require!(claim_ai.is_writable, ChipError::AccountNotWritable);
        require_keys_eq!(
            claim_ai.key(),
            ctx.accounts.pending.materials[m],
            ChipError::InvalidChipState
        );
        let mut data = claim_ai.try_borrow_mut_data()?;
        let mut cursor: &[u8] = &data;
        let mut claim = CompressedMintClaim::try_deserialize(&mut cursor)?;
        require!(
            claim.consumed && (!claim.minted || claim.registered),
            ChipError::InvalidChipState
        );
        let _ = cursor;
        claim.consumed = false;
        claim.serialize(&mut &mut data[8..])?;
    }
    Ok(())
}

#[derive(Accounts)]
#[instruction(claim_nonce: u64)]
pub struct CloseExpiredClaim<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(
        mut,
        close = buyer,
        seeds = [b"compressed_claim", buyer.key().as_ref(), &claim_nonce.to_le_bytes()],
        bump = claim.bump,
        has_one = buyer @ ChipError::Unauthorized,
    )]
    pub claim: Box<Account<'info, CompressedMintClaim>>,
    pub system_program: Program<'info, System>,
}

/// Reclaim the rent of an expired settlement-free claim shell (admin-staged or
/// fusion-result claims nobody minted). Pack claims refund through
/// `cancel_compressed_claim` instead, and `consumed` claims may still be
/// referenced by a live `PendingClaimFusion` — closing one would brick its
/// reveal — so both stay out of reach here.
pub fn close_expired_claim(ctx: Context<CloseExpiredClaim>, _claim_nonce: u64) -> Result<()> {
    require!(
        ctx.accounts.claim.settlement == Pubkey::default()
            && !ctx.accounts.claim.minted
            && !ctx.accounts.claim.consumed
            && !ctx.accounts.claim.listed
            && !ctx.accounts.claim.staked
            && Clock::get()?.unix_timestamp > ctx.accounts.claim.expires_at,
        ChipError::InvalidChipState
    );
    Ok(())
}

#[event]
pub struct CompressedClaimsCreated {
    pub buyer: Pubkey,
    pub nonce: u64,
    pub pack_no: u8,
    pub claim_nonces: [u64; MAX_CHIPS_PER_PACK],
    pub count: u8,
}

#[derive(Accounts)]
#[instruction(claim_nonce: u64, nonce: u64)]
pub struct CancelCompressedClaim<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(mut, seeds = [b"compressed_settlement", buyer.key().as_ref(), &nonce.to_le_bytes()], bump = settlement.bump)]
    pub settlement: Box<Account<'info, CompressedPackSettlement>>,
    #[account(seeds = [b"pending", buyer.key().as_ref(), &nonce.to_le_bytes()], bump = pending.bump)]
    pub pending: Box<Account<'info, PendingPack>>,
    #[account(
        mut,
        close = buyer,
        seeds = [b"compressed_claim", buyer.key().as_ref(), &claim_nonce.to_le_bytes()],
        bump = claim.bump,
        has_one = buyer @ ChipError::Unauthorized,
    )]
    pub claim: Box<Account<'info, CompressedMintClaim>>,
    pub system_program: Program<'info, System>,
}

pub fn cancel_compressed_claim(
    ctx: Context<CancelCompressedClaim>,
    _claim_nonce: u64,
    nonce: u64,
) -> Result<()> {
    require!(
        ctx.accounts.claim.settlement == ctx.accounts.settlement.key()
            && ctx.accounts.settlement.buyer == ctx.accounts.buyer.key()
            && ctx.accounts.settlement.pending == ctx.accounts.pending.key()
            && ctx.accounts.settlement.nonce == nonce
            && ctx.accounts.pending.buyer == ctx.accounts.buyer.key()
            && ctx.accounts.pending.nonce == nonce
            && !ctx.accounts.claim.minted
            // SEC-F03: closing the claim while it is staked (or listed) is forbidden — the claim
            // account is the authority the staking/market flags live on. Closing it would orphan
            // the CompressedChipStake weight forever (zombie weight diluting every other staker)
            // while the cancelled share refunds had already been counted into the settlement.
            && !ctx.accounts.claim.staked
            && !ctx.accounts.claim.listed
            // SEC-G03: a consumed material is not a refundable share. Unreachable while
            // `fuse_compressed_claims` only takes settlement-free claims; kept so a future
            // fusion path that consumes pack claims fails closed here instead of double-paying.
            && !ctx.accounts.claim.consumed
            && ctx.accounts.settlement.cancelled_claims < ctx.accounts.settlement.total_claims
            && Clock::get()?.unix_timestamp > ctx.accounts.claim.expires_at,
        ChipError::InvalidChipState
    );
    ctx.accounts.settlement.cancelled_claims = ctx
        .accounts
        .settlement
        .cancelled_claims
        .checked_add(1)
        .ok_or(ChipError::Overflow)?;
    emit!(CompressedClaimCancelled {
        buyer: ctx.accounts.buyer.key(),
        nonce,
        claim_nonce: _claim_nonce,
    });
    Ok(())
}

#[event]
pub struct CompressedClaimCancelled {
    pub buyer: Pubkey,
    pub nonce: u64,
    pub claim_nonce: u64,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct FinalizeCompressedPack<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, GameConfig>>,
    #[account(
        mut,
        seeds = [b"compressed_settlement", pending.buyer.as_ref(), &nonce.to_le_bytes()],
        bump = settlement.bump,
    )]
    pub settlement: Box<Account<'info, CompressedPackSettlement>>,
    #[account(
        mut,
        seeds = [b"pending", pending.buyer.as_ref(), &nonce.to_le_bytes()],
        bump = pending.bump,
    )]
    pub pending: Box<Account<'info, PendingPack>>,
    /// CHECK: buyer is bound by PendingPack and receives the pending reserve.
    #[account(mut, address = pending.buyer)]
    pub buyer: UncheckedAccount<'info>,
    #[account(mut, seeds = [VaultLedger::SEED, &[VaultLedger::shard_of(&pending.buyer)]], bump = ledger.bump)]
    pub ledger: Box<Account<'info, VaultLedger>>,
    // sentio-ignore-next-line SW013
    /// CHECK: vault PDA holding paid SOL/SPL liabilities.
    #[account(mut, seeds = [b"vault"], bump = config.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, address = config.cg_mint)]
    pub cg_mint: Option<Account<'info, Mint>>,
    #[account(mut, token::mint = config.cg_mint, token::authority = vault)]
    pub vault_cg: Option<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = config.cg_mint, token::authority = config.treasury)]
    pub treasury_cg: Option<Account<'info, TokenAccount>>,
    #[account(mut, token::authority = vault)]
    pub vault_token: Option<Account<'info, TokenAccount>>,
    #[account(mut, token::authority = buyer)]
    pub buyer_token: Option<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn finalize_compressed_pack(ctx: Context<FinalizeCompressedPack>, nonce: u64) -> Result<()> {
    require!(
        ctx.accounts.pending.opened == ctx.accounts.pending.qty,
        ChipError::InvalidChipState
    );
    require!(
        ctx.accounts.settlement.buyer == ctx.accounts.buyer.key()
            && ctx.accounts.pending.buyer == ctx.accounts.buyer.key()
            && ctx.accounts.settlement.pending == ctx.accounts.pending.key()
            && ctx.accounts.settlement.nonce == nonce
            && ctx.accounts.settlement.total_claims > 0
            && ctx
                .accounts
                .settlement
                .registered_claims
                .checked_add(ctx.accounts.settlement.cancelled_claims)
                == Some(ctx.accounts.settlement.total_claims),
        ChipError::InvalidChipState
    );

    let (paid_lamports, paid_usdc, paid_cg, paid_skr) = (
        ctx.accounts.pending.paid_lamports,
        ctx.accounts.pending.paid_usdc,
        ctx.accounts.pending.paid_cg,
        ctx.accounts.pending.paid_skr,
    );
    let payment_kinds = (paid_lamports > 0) as u8
        + (paid_usdc > 0) as u8
        + (paid_cg > 0) as u8
        + (paid_skr > 0) as u8;
    require!(payment_kinds <= 1, ChipError::CurrencyNotAccepted);
    let vault_seeds: &[&[u8]] = &[b"vault", &[ctx.accounts.config.vault_bump]];
    let cancelled_claims = ctx.accounts.settlement.cancelled_claims;
    let total_claims = ctx.accounts.settlement.total_claims;
    let refund = cancelled_claims > 0;
    let refunded_lamports = pro_rata_refund(paid_lamports, cancelled_claims, total_claims)?;
    let refunded_usdc = pro_rata_refund(paid_usdc, cancelled_claims, total_claims)?;
    let refunded_cg = pro_rata_refund(paid_cg, cancelled_claims, total_claims)?;
    let refunded_skr = pro_rata_refund(paid_skr, cancelled_claims, total_claims)?;

    if refunded_lamports > 0 {
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.buyer.to_account_info(),
                },
                &[vault_seeds],
            ),
            refunded_lamports,
        )?;
    }

    // USDC and SKR have no settlement-side split. Only the cancelled share is
    // returned; the registered share remains in the vault as revenue.
    let refundable_token_amount = refunded_usdc
        .checked_add(refunded_skr)
        .ok_or(ChipError::Overflow)?;
    if refundable_token_amount > 0 {
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
        let expected_mint = if paid_usdc > 0 {
            ctx.accounts.config.usdc_mint
        } else {
            ctx.accounts.config.skr_mint
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
            refundable_token_amount,
        )?;
    }

    // $CG keeps the existing burn/treasury economics for the successfully
    // registered share, while the cancelled share is returned before the
    // liability is released.
    if refunded_cg > 0 {
        let from = ctx
            .accounts
            .vault_cg
            .as_ref()
            .ok_or(ChipError::CurrencyNotAccepted)?;
        let to = ctx
            .accounts
            .buyer_token
            .as_ref()
            .ok_or(ChipError::CurrencyNotAccepted)?;
        require_keys_eq!(
            to.mint,
            ctx.accounts.config.cg_mint,
            ChipError::CurrencyNotAccepted
        );
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
            refunded_cg,
        )?;
    }
    let cg_for_registered = paid_cg
        .checked_sub(refunded_cg)
        .ok_or(ChipError::Overflow)?;
    if cg_for_registered > 0 {
        let burn = cg_for_registered
            .checked_mul(CG_PACK_BURN_BPS as u64)
            .ok_or(ChipError::Overflow)?
            .checked_div(BPS_DENOM as u64)
            .ok_or(ChipError::Overflow)?;
        let mint = ctx
            .accounts
            .cg_mint
            .as_ref()
            .ok_or(ChipError::CurrencyNotAccepted)?;
        let from = ctx
            .accounts
            .vault_cg
            .as_ref()
            .ok_or(ChipError::CurrencyNotAccepted)?;
        let to = ctx
            .accounts
            .treasury_cg
            .as_ref()
            .ok_or(ChipError::CurrencyNotAccepted)?;
        token::burn(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Burn {
                    mint: mint.to_account_info(),
                    from: from.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[vault_seeds],
            ),
            burn,
        )?;
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
            cg_for_registered
                .checked_sub(burn)
                .ok_or(ChipError::Overflow)?,
        )?;
        ctx.accounts.ledger.burned(burn);
    }
    ctx.accounts
        .ledger
        .release(paid_lamports, paid_usdc, paid_cg, paid_skr)?;
    ctx.accounts.ledger.exit(ctx.program_id)?;

    let pending_ai = ctx.accounts.pending.to_account_info();
    let buyer_ai = ctx.accounts.buyer.to_account_info();
    let pending_lamports = pending_ai.lamports();
    **pending_ai.try_borrow_mut_lamports()? = 0;
    **buyer_ai.try_borrow_mut_lamports()? = buyer_ai
        .lamports()
        .checked_add(pending_lamports)
        .ok_or(ChipError::Overflow)?;
    pending_ai.assign(&system_program::ID);
    pending_ai.resize(0)?;

    let settlement_ai = ctx.accounts.settlement.to_account_info();
    let settlement_lamports = settlement_ai.lamports();
    // SEC-A5 (2026-10-02): the settlement rent goes back to the buyer, exactly like the pending
    // rent two blocks up and like `resolve_battle` (escrow → challenger), `cancel_stale_fusion` and
    // `close_randomness` (rent → the player). The permissionless crank still earns its own
    // transaction fee from elsewhere; paying it out of the player's pack rent was an asymmetry with
    // every other closure path in this repo.
    let buyer_next = buyer_ai
        .lamports()
        .checked_add(settlement_lamports)
        .ok_or(ChipError::Overflow)?;
    **settlement_ai.try_borrow_mut_lamports()? = 0;
    **buyer_ai.try_borrow_mut_lamports()? = buyer_next;
    settlement_ai.assign(&system_program::ID);
    settlement_ai.resize(0)?;

    emit!(CompressedPackSettled {
        buyer: ctx.accounts.buyer.key(),
        nonce,
        refunded: refund
    });
    Ok(())
}

#[event]
pub struct CompressedPackSettled {
    pub buyer: Pubkey,
    pub nonce: u64,
    pub refunded: bool,
}

#[derive(Accounts)]
#[instruction(buyer_key: Pubkey, collection_idx: u8, claim_nonce: u64)]
pub struct MintCompressedChip<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, GameConfig>>,
    #[account(
        seeds = [b"collection".as_ref(), &[collection_idx][..]],
        bump = collection.bump,
        constraint = collection.idx == collection_idx @ ChipError::InvalidCollection,
    )]
    pub collection: Box<Account<'info, CollectionMeta>>,
    #[account(
        seeds = [b"bubblegum_tree", &[collection_idx]],
        bump = tree_meta.bump,
        constraint = tree_meta.active @ ChipError::InvalidBubblegumTree,
        constraint = tree_meta.collection_idx == collection_idx @ ChipError::InvalidBubblegumTree,
        constraint = tree_meta.core_collection == collection.core_collection @ ChipError::InvalidBubblegumTree,
        constraint = tree_meta.tree_authority == collection.key() @ ChipError::InvalidBubblegumTree,
    )]
    pub tree_meta: Box<Account<'info, BubblegumTreeMeta>>,
    #[account(
        mut,
        seeds = [b"compressed_claim", buyer_key.as_ref(), &claim_nonce.to_le_bytes()],
        bump = claim.bump,
        has_one = buyer @ ChipError::InvalidBubblegumProof,
    )]
    pub claim: Box<Account<'info, CompressedMintClaim>>,
    /// CHECK: the leaf owner is the buyer bound into the claim.
    #[account(address = buyer_key)]
    pub buyer: UncheckedAccount<'info>,
    /// CHECK: Bubblegum TreeConfigV2 PDA.
    #[account(mut, address = tree_meta.tree_config)]
    pub tree_config: UncheckedAccount<'info>,
    /// CHECK: Bubblegum V2 Merkle tree.
    #[account(mut, address = tree_meta.merkle_tree)]
    pub merkle_tree: UncheckedAccount<'info>,
    /// CHECK: configured tree creator/delegate. The deployment binding requires
    /// this to be the collection PDA, which signs through `invoke_signed`.
    #[account(address = tree_meta.tree_authority)]
    pub tree_authority: UncheckedAccount<'info>,
    /// CHECK: MPL-Core collection account.
    #[account(mut, address = collection.core_collection)]
    pub core_collection: UncheckedAccount<'info>,
    /// CHECK: Bubblegum's `collection_cpi` signer PDA.
    #[account(address = crate::bubblegum::mpl_core_cpi_signer())]
    pub mpl_core_cpi_signer: UncheckedAccount<'info>,
    /// CHECK: fixed Bubblegum program.
    #[account(address = BUBBLEGUM_V2_ID)]
    pub bubblegum_program: UncheckedAccount<'info>,
    /// CHECK: fixed MPL Noop log wrapper.
    #[account(address = MPL_NOOP_ID)]
    pub log_wrapper: UncheckedAccount<'info>,
    /// CHECK: fixed MPL Account Compression program.
    #[account(address = MPL_ACCOUNT_COMPRESSION_ID)]
    pub compression_program: UncheckedAccount<'info>,
    /// CHECK: fixed MPL Core program.
    #[account(address = MPL_CORE_ID)]
    pub mpl_core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn mint_compressed_chip(
    ctx: Context<MintCompressedChip>,
    buyer: Pubkey,
    collection_idx: u8,
    claim_nonce: u64,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, ChipError::Paused);
    require_bubblegum_program(&ctx.accounts.bubblegum_program.to_account_info())?;
    require!(
        ctx.accounts.bubblegum_program.to_account_info().executable,
        ChipError::InvalidBubblegumTree
    );
    require_keys_eq!(
        ctx.accounts.tree_meta.tree_config,
        tree_config_pda(&ctx.accounts.tree_meta.merkle_tree),
        ChipError::InvalidBubblegumTree
    );
    require_keys_eq!(
        *ctx.accounts.tree_config.to_account_info().owner,
        BUBBLEGUM_V2_ID,
        ChipError::InvalidBubblegumTree
    );
    require_keys_eq!(
        *ctx.accounts.merkle_tree.to_account_info().owner,
        MPL_ACCOUNT_COMPRESSION_ID,
        ChipError::InvalidBubblegumTree
    );
    require_keys_eq!(
        *ctx.accounts.core_collection.to_account_info().owner,
        MPL_CORE_ID,
        ChipError::InvalidCollection
    );
    require!(
        !ctx.accounts.claim.minted
            && !ctx.accounts.claim.consumed
            && !ctx.accounts.claim.listed
            && !ctx.accounts.claim.staked,
        ChipError::InvalidBubblegumProof
    );
    require!(
        Clock::get()?.unix_timestamp <= ctx.accounts.claim.expires_at,
        ChipError::InvalidBubblegumProof
    );
    require!(
        ctx.accounts.claim.collection_idx == collection_idx,
        ChipError::InvalidBubblegumProof
    );
    // The collection PDA is both the Bubblegum tree delegate and the MPL-Core
    // collection update authority. This gives the CPI one auditable signer
    // policy instead of accepting an arbitrary tree delegate account.
    require_keys_eq!(
        ctx.accounts.tree_meta.tree_authority,
        ctx.accounts.collection.key(),
        ChipError::InvalidBubblegumTree
    );

    let has_bubblegum_plugin = {
        let data = ctx.accounts.core_collection.try_borrow_data()?;
        if data.len() >= 49 {
            let name_len = u32::from_le_bytes([data[33], data[34], data[35], data[36]]) as usize;
            if data.len() >= 49 + name_len {
                let uoff = 37 + name_len;
                let uri_len = u32::from_le_bytes([
                    data[uoff],
                    data[uoff + 1],
                    data[uoff + 2],
                    data[uoff + 3],
                ]) as usize;
                let base_len = 49 + name_len + uri_len;
                if data.len() >= base_len + 9 {
                    let roff = base_len + 1;
                    let reg_offset = u64::from_le_bytes([
                        data[roff],
                        data[roff + 1],
                        data[roff + 2],
                        data[roff + 3],
                        data[roff + 4],
                        data[roff + 5],
                        data[roff + 6],
                        data[roff + 7],
                    ]) as usize;
                    if data.len() >= reg_offset + 5 {
                        let poff = reg_offset + 1;
                        let plugin_count = u32::from_le_bytes([
                            data[poff],
                            data[poff + 1],
                            data[poff + 2],
                            data[poff + 3],
                        ]);
                        plugin_count >= 3
                    } else {
                        false
                    }
                } else {
                    false
                }
            } else {
                false
            }
        } else {
            false
        }
    };

    let rarity = ctx.accounts.claim.rarity.index();
    let name = format!(
        "{} #{}",
        ctx.accounts.collection.symbol, ctx.accounts.claim.game_index
    );
    let uri = format!(
        "https://cdn.guttercaps.gg/m/{}/{}.json",
        collection_idx, rarity
    );
    let metadata = MetadataArgsV2 {
        name,
        symbol: ctx.accounts.collection.symbol.clone(),
        uri,
        seller_fee_basis_points: crate::economy::ROYALTY_BPS,
        primary_sale_happened: false,
        is_mutable: false,
        token_standard: Some(TokenStandard::NonFungible),
        creators: vec![Creator {
            address: ctx.accounts.collection.key(),
            verified: true,
            share: 100,
        }],
        collection: if has_bubblegum_plugin {
            Some(ctx.accounts.collection.core_collection)
        } else {
            None
        },
    };
    let collection_seeds: &[&[u8]] = &[
        b"collection",
        &[ctx.accounts.collection.idx],
        &[ctx.accounts.collection.bump],
    ];

    let collection_info = ctx.accounts.collection.to_account_info();
    let core_collection_info = ctx.accounts.core_collection.to_account_info();
    let mpl_core_cpi_signer_info = ctx.accounts.mpl_core_cpi_signer.to_account_info();

    MintV2CpiBuilder::new(&ctx.accounts.bubblegum_program.to_account_info())
        .tree_config(&ctx.accounts.tree_config.to_account_info())
        .payer(&ctx.accounts.payer.to_account_info())
        .tree_creator_or_delegate(Some(&ctx.accounts.tree_authority.to_account_info()))
        .collection_authority(has_bubblegum_plugin.then_some(&collection_info))
        .leaf_owner(&ctx.accounts.buyer.to_account_info())
        .leaf_delegate(Some(&ctx.accounts.buyer.to_account_info()))
        .merkle_tree(&ctx.accounts.merkle_tree.to_account_info())
        .core_collection(has_bubblegum_plugin.then_some(&core_collection_info))
        .mpl_core_cpi_signer(has_bubblegum_plugin.then_some(&mpl_core_cpi_signer_info))
        .log_wrapper(&ctx.accounts.log_wrapper.to_account_info())
        .compression_program(&ctx.accounts.compression_program.to_account_info())
        .mpl_core_program(&ctx.accounts.mpl_core_program.to_account_info())
        .system_program(&ctx.accounts.system_program.to_account_info())
        .metadata(metadata)
        .invoke_signed(&[collection_seeds])?;

    ctx.accounts.claim.minted = true;
    emit!(CompressedChipMinted {
        buyer,
        collection_idx,
        claim_nonce,
        rarity,
        level: ctx.accounts.claim.level,
        game_index: ctx.accounts.claim.game_index,
        claim: ctx.accounts.claim.key(),
    });
    Ok(())
}

#[event]
pub struct CompressedChipMinted {
    pub buyer: Pubkey,
    pub collection_idx: u8,
    pub claim_nonce: u64,
    pub rarity: u8,
    pub level: u8,
    pub game_index: u64,
    /// SEC-B34: the claim PDA itself, not just `(buyer, claim_nonce)`. `buyer` is the claim's *current*
    /// holder, and the claim market (`buy_compressed_claim`) changes it: after A lists a pre-mint claim
    /// and B buys it, this event names B while an indexer keyed by the origin A finds nothing. The PDA is
    /// the identity the claim, the market and the programs all use. Appended last on purpose — borsh is
    /// positional, so every field before it keeps its offset.
    pub claim: Pubkey,
}

#[derive(Accounts)]
#[instruction(asset_id: Pubkey, collection_idx: u8, owner: Pubkey, delegate: Pubkey, buyer_key: Pubkey, claim_nonce: u64)]
pub struct RegisterCompressedChip<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, GameConfig>>,
    #[account(
        mut,
        seeds = [b"collection".as_ref(), &[collection_idx][..]],
        bump = collection.bump,
        constraint = collection.idx == collection_idx @ ChipError::InvalidCollection,
    )]
    pub collection: Box<Account<'info, CollectionMeta>>,
    #[account(
        seeds = [b"bubblegum_tree", &[collection_idx]],
        bump = tree_meta.bump,
        constraint = tree_meta.active @ ChipError::InvalidBubblegumTree,
        constraint = tree_meta.collection_idx == collection_idx @ ChipError::InvalidBubblegumTree,
        constraint = tree_meta.core_collection == collection.core_collection @ ChipError::InvalidBubblegumTree,
        constraint = tree_meta.tree_authority == collection.key() @ ChipError::InvalidBubblegumTree,
    )]
    pub tree_meta: Box<Account<'info, BubblegumTreeMeta>>,
    #[account(
        mut,
        seeds = [b"compressed_claim", buyer_key.as_ref(), &claim_nonce.to_le_bytes()],
        bump = claim.bump,
        has_one = buyer @ ChipError::InvalidBubblegumProof,
    )]
    pub claim: Box<Account<'info, CompressedMintClaim>>,
    // sentio-ignore-next-line SW002
    /// CHECK: compressed-pack settlement PDA, or the system program for the
    /// legacy/admin staging path where the claim has no settlement. The handler
    /// requires it writable only when a settlement is actually used.
    pub settlement: UncheckedAccount<'info>,
    /// CHECK: claim.buyer is the expected leaf owner.
    #[account(address = buyer_key)]
    pub buyer: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + CompressedChipState::INIT_SPACE,
        seeds = [b"compressed_chip", asset_id.as_ref()],
        bump,
    )]
    pub chip: Box<Account<'info, CompressedChipState>>,
    /// CHECK: the expected Bubblegum leaf asset PDA; it need not be initialized.
    #[account(address = asset_id)]
    pub asset: UncheckedAccount<'info>,
    /// CHECK: authenticated by the V2 leaf hash and Account Compression proof.
    #[account(address = owner)]
    pub leaf_owner: UncheckedAccount<'info>,
    /// CHECK: authenticated by the V2 leaf hash.
    #[account(address = delegate)]
    pub leaf_delegate: UncheckedAccount<'info>,
    /// CHECK: Bubblegum tree account; owner is checked before CPI.
    #[account(address = tree_meta.merkle_tree)]
    pub merkle_tree: UncheckedAccount<'info>,
    /// CHECK: Bubblegum-owned TreeConfigV2 binding.
    #[account(address = tree_meta.tree_config)]
    pub tree_config: UncheckedAccount<'info>,
    /// CHECK: fixed Bubblegum program account.
    #[account(address = BUBBLEGUM_V2_ID)]
    pub bubblegum_program: UncheckedAccount<'info>,
    /// CHECK: fixed MPL Account Compression program.
    #[account(address = MPL_ACCOUNT_COMPRESSION_ID)]
    pub compression_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn register_compressed_chip<'info>(
    ctx: Context<'_, '_, 'info, 'info, RegisterCompressedChip<'info>>,
    asset_id: Pubkey,
    collection_idx: u8,
    owner: Pubkey,
    delegate: Pubkey,
    buyer: Pubkey,
    claim_nonce: u64,
    proof: LeafProofArgs,
    rarity: u8,
    level: u8,
    game_index: u64,
) -> Result<()> {
    require_bubblegum_program(&ctx.accounts.bubblegum_program.to_account_info())?;
    require!(
        ctx.accounts.bubblegum_program.to_account_info().executable,
        ChipError::InvalidBubblegumTree
    );
    require_keys_eq!(
        *ctx.accounts.tree_config.to_account_info().owner,
        BUBBLEGUM_V2_ID,
        ChipError::InvalidBubblegumTree
    );
    require_keys_eq!(
        ctx.accounts.config.key(),
        Pubkey::find_program_address(&[b"config"], &crate::ID).0,
        ChipError::InvalidBubblegumTree
    );
    require_keys_eq!(owner, buyer, ChipError::InvalidBubblegumProof);
    require_keys_eq!(delegate, owner, ChipError::InvalidBubblegumProof);
    let rarity = Rarity::from_index(rarity).ok_or(error!(ChipError::InvalidCollection))?;
    require!(
        ctx.accounts.claim.minted
            && !ctx.accounts.claim.registered
            && !ctx.accounts.claim.consumed
            && !ctx.accounts.claim.listed
            && !ctx.accounts.claim.staked
            && ctx.accounts.claim.buyer == buyer
            && ctx.accounts.claim.collection_idx == collection_idx
            && ctx.accounts.claim.rarity == rarity
            && ctx.accounts.claim.level == level
            && ctx.accounts.claim.game_index == game_index,
        ChipError::InvalidBubblegumProof
    );
    // A minted claim remains recoverable after the DAS/indexer SLA expires;
    // only an unminted claim can be cancelled and refunded.
    require!(
        Clock::get()?.unix_timestamp <= ctx.accounts.claim.expires_at || ctx.accounts.claim.minted,
        ChipError::InvalidBubblegumProof
    );
    require_keys_eq!(
        ctx.accounts.tree_meta.tree_config,
        tree_config_pda(&ctx.accounts.tree_meta.merkle_tree),
        ChipError::InvalidBubblegumTree
    );
    require_keys_eq!(
        asset_id,
        leaf_asset_id(&ctx.accounts.tree_meta.merkle_tree, proof.index),
        ChipError::InvalidBubblegumProof
    );
    require!(
        proof.collection_hash
            == mpl_bubblegum::hash::hash_collection_option(Some(
                ctx.accounts.collection.core_collection
            ))?
            || proof.collection_hash == mpl_bubblegum::hash::hash_collection_option(None)?,
        ChipError::InvalidBubblegumProof
    );
    require!(
        ctx.accounts.tree_meta.max_depth < 32,
        ChipError::InvalidBubblegumTree
    );
    require!(
        proof.index < (1u32 << ctx.accounts.tree_meta.max_depth),
        ChipError::InvalidBubblegumProof
    );
    require!(
        ctx.remaining_accounts.len() <= ctx.accounts.tree_meta.max_depth as usize,
        ChipError::InvalidBubblegumProof
    );

    // The proof CPI is the authority boundary. Do not create the state account
    // from DAS JSON or from the caller's claimed owner/metadata alone.
    verify_v2_leaf(
        &ctx.accounts.compression_program.to_account_info(),
        &ctx.accounts.merkle_tree.to_account_info(),
        asset_id,
        owner,
        delegate,
        &proof,
        ctx.remaining_accounts,
    )?;

    if ctx.accounts.claim.settlement != Pubkey::default() {
        require_keys_eq!(
            ctx.accounts.settlement.key(),
            ctx.accounts.claim.settlement,
            ChipError::InvalidChipState
        );
        let settlement_ai = ctx.accounts.settlement.to_account_info();
        require!(settlement_ai.is_writable, ChipError::AccountNotWritable);
        require_keys_eq!(
            *settlement_ai.owner,
            *ctx.program_id,
            ChipError::InvalidChipState
        );
        let mut settlement_data = settlement_ai.try_borrow_mut_data()?;
        let mut settlement_cursor: &[u8] = &settlement_data;
        let mut settlement = CompressedPackSettlement::try_deserialize(&mut settlement_cursor)?;
        require_keys_eq!(settlement.buyer, buyer, ChipError::InvalidChipState);
        require!(
            settlement.registered_claims < settlement.total_claims,
            ChipError::InvalidChipState
        );
        settlement.registered_claims = settlement
            .registered_claims
            .checked_add(1)
            .ok_or(ChipError::Overflow)?;
        settlement.serialize(&mut &mut settlement_data[8..])?;
    }

    let rarity_index = rarity.index() as usize;
    if !ctx.accounts.claim.index_reserved {
        ctx.accounts.collection.minted = ctx
            .accounts
            .collection
            .minted
            .checked_add(1)
            .ok_or(ChipError::Overflow)?;
        ctx.accounts.collection.minted_by_rarity[rarity_index] =
            ctx.accounts.collection.minted_by_rarity[rarity_index]
                .checked_add(1)
                .ok_or(ChipError::Overflow)?;
    }

    let now = Clock::get()?.unix_timestamp;
    ctx.accounts.claim.registered = true;
    let chip = &mut ctx.accounts.chip;
    chip.asset = asset_id;
    chip.claim = ctx.accounts.claim.key();
    chip.collection_idx = collection_idx;
    chip.merkle_tree = ctx.accounts.tree_meta.merkle_tree;
    chip.leaf_index = proof.index;
    chip.leaf_nonce = proof.nonce;
    chip.data_hash = proof.data_hash;
    chip.creator_hash = proof.creator_hash;
    chip.collection_hash = proof.collection_hash;
    chip.asset_data_hash = proof.asset_data_hash;
    chip.leaf_flags = proof.flags;
    chip.rarity = rarity;
    chip.level = level;
    chip.index = game_index;
    // The claim's soulbound window becomes the chip's: the V2 leaf flags bit is
    // kept as an additional signal, the claim lock is the authority.
    let mut chip_flags = if proof.flags & 0b1000 != 0 || ctx.accounts.claim.lock_until > now {
        CompressedChipState::F_SOULBOUND
    } else {
        0
    };
    // Pre-sale origin (docs/preorder-beta.md): the founder frame is permanent and travels
    // with the chip — the claim is the authority, the leaf flag cannot add or remove it.
    if ctx.accounts.claim.founder {
        chip_flags |= CompressedChipState::F_FOUNDER;
    }
    chip.flags = chip_flags;
    chip.lock_until = ctx.accounts.claim.lock_until;
    chip.minted_at = now;
    chip.bump = ctx.bumps.chip;

    emit!(CompressedChipRegistered {
        asset: asset_id,
        claim_nonce,
        collection_idx,
        merkle_tree: chip.merkle_tree,
        leaf_index: proof.index,
        leaf_nonce: proof.nonce,
        owner,
        delegate,
        rarity: rarity.index(),
        level,
        game_index,
        flags: chip.flags,
        // H1: the claim's soulbound window becomes the chip's — the indexer cannot
        // derive it (the claim account is not an event), so the event carries it.
        lock_until: chip.lock_until,
        // SEC-B34: the join key back to the claim the indexer holds a row for.
        claim: ctx.accounts.claim.key(),
    });
    Ok(())
}

#[event]
pub struct CompressedChipRegistered {
    pub asset: Pubkey,
    pub claim_nonce: u64,
    pub collection_idx: u8,
    pub merkle_tree: Pubkey,
    pub leaf_index: u32,
    pub leaf_nonce: u64,
    pub owner: Pubkey,
    pub delegate: Pubkey,
    pub rarity: u8,
    pub level: u8,
    pub game_index: u64,
    pub flags: u8,
    pub lock_until: i64,
    /// SEC-B34, same reason as `CompressedChipMinted`: `owner` is the claim's current holder (and the
    /// registration is only reachable by that holder), while the indexer's row is keyed by the immutable
    /// origin — the claim PDA is what joins them.
    pub claim: Pubkey,
}

#[cfg(test)]
mod tests {
    use super::{ensure_distinct_material, pro_rata_refund};
    use crate::errors::ChipError;
    use anchor_lang::prelude::*;

    #[test]
    fn refund_rounds_up_and_conserves_value() {
        assert_eq!(pro_rata_refund(100, 1, 2).unwrap(), 50);
        assert_eq!(pro_rata_refund(1, 1, 3).unwrap(), 1);
        assert_eq!(pro_rata_refund(100, 0, 3).unwrap(), 0);
        assert_eq!(pro_rata_refund(100, 3, 3).unwrap(), 100);
    }

    #[test]
    fn refund_rejects_invalid_counters_and_overflow() {
        assert!(pro_rata_refund(100, 4, 3).is_err());
        assert!(pro_rata_refund(100, 0, 0).is_err());
        assert!(pro_rata_refund(u64::MAX, 2, 3).is_err());
    }

    fn code(r: Result<()>) -> u32 {
        match r.expect_err("expected an error") {
            anchor_lang::error::Error::AnchorError(e) => e.error_code_number,
            other => panic!("unexpected error {other:?}"),
        }
    }

    /// SEC-F2 regression: every placement of a repeated key among 3 materials is rejected with
    /// DuplicateMaterial; three distinct keys pass.
    #[test]
    fn distinct_material_guard_rejects_every_repeat() {
        let a = Pubkey::new_unique();
        let b = Pubkey::new_unique();
        let c = Pubkey::new_unique();
        for triple in [[a, a, a], [a, a, b], [a, b, a], [b, a, a], [a, b, b]] {
            let mut seen: Vec<Pubkey> = Vec::new();
            let mut rejected = false;
            for k in triple {
                let r = ensure_distinct_material(&seen, &k);
                if r.is_err() {
                    assert_eq!(code(r), u32::from(ChipError::DuplicateMaterial));
                    rejected = true;
                    break;
                }
                seen.push(k);
            }
            assert!(rejected, "{triple:?} must be rejected");
        }
        let mut seen: Vec<Pubkey> = Vec::new();
        for k in [a, b, c] {
            ensure_distinct_material(&seen, &k).unwrap();
            seen.push(k);
        }
        assert!(ensure_distinct_material(&[], &a).is_ok());
    }
}
