//! GUTTERCAPS — chip_core
//!
//! Registry of the 10 district collections (Metaplex Core), VRF pack sales
//! with pity, fusion, and the ChipState PDA that market/staking/arena rely
//! on. See docs/03-architecture.md §2 for the design and threat model.
//!
//! Program IDs are committed, not placeholders: every `declare_id!`, both `Anchor.toml` sections and the
//! client/backend/scripts/CI copies agree — `npm run program-ids -- check` (part of `npm run verify`) and
//! `packages/economy/scripts/sync-check.ts` fail on any drift. They are dev-derived keypairs, so the
//! mainnet freeze is a single rewrite through `npm run program-ids -- apply --from <cold-dir>`
//! (docs/09 §2), never a hand edit.

#![allow(clippy::result_large_err)]
// Anchor's generated instruction ABI wrappers mirror every handler argument, so the
// normal function-argument count lint is not actionable for this program crate.
#![allow(clippy::too_many_arguments)]

use anchor_lang::prelude::*;

pub mod bubblegum;
pub mod deploy_guard;
pub mod economy;
pub mod errors;
pub mod instructions;
pub mod pyth;
pub mod randomness;
pub mod state;

use bubblegum::LeafProofArgs;
use instructions::*;

declare_id!("GCRhrg6mc7zH1VdXG5rX3tQEpgu8Gptf27vdsJGV7G8q");

/// Metaplex Bubblegum V2 program id. Kept explicit instead of accepting an
/// arbitrary CPI target; all tree configuration and later leaf mutations use
/// this address.
pub const BUBBLEGUM_V2_ID: Pubkey = pubkey!("BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY");

#[program]
pub mod chip_core {
    use super::*;

    // ----- admin -----
    pub fn initialize(ctx: Context<Initialize>, args: InitArgs) -> Result<()> {
        instructions::initialize(ctx, args)
    }
    pub fn create_collection(
        ctx: Context<CreateCollection>,
        idx: u8,
        symbol: String,
        name: String,
        uri: String,
        element: u8,
    ) -> Result<()> {
        instructions::create_collection(ctx, idx, symbol, name, uri, element)
    }
    /// Create a Bubblegum V2 tree config with the collection PDA as the tree
    /// creator/delegate and store the immutable deployment binding.
    pub fn create_bubblegum_tree(
        ctx: Context<CreateBubblegumTree>,
        idx: u8,
        max_depth: u8,
        canopy: u8,
        max_buffer_size: u32,
    ) -> Result<()> {
        instructions::create_bubblegum_tree(ctx, idx, max_depth, canopy, max_buffer_size)
    }
    /// Bind an externally-created Bubblegum V2 tree and its Bubblegum-owned
    /// tree config to a registered MPL-Core collection.
    pub fn configure_bubblegum_tree(
        ctx: Context<ConfigureBubblegumTree>,
        idx: u8,
        max_depth: u8,
        canopy: u8,
    ) -> Result<()> {
        instructions::configure_bubblegum_tree(ctx, idx, max_depth, canopy)
    }
    pub fn set_params(ctx: Context<AdminOnly>, patch: ParamsPatch) -> Result<()> {
        instructions::set_params(ctx, patch)
    }
    /// Admin-authorized staging record for one compressed mint result. The
    /// production pack path will create this claim atomically with its roll.
    pub fn set_compressed_claim_listed(
        ctx: Context<SetCompressedClaimListed>,
        expected_owner: Pubkey,
        listed: bool,
    ) -> Result<()> {
        instructions::set_compressed_claim_listed(ctx, expected_owner, listed)
    }
    pub fn transfer_compressed_claim(
        ctx: Context<TransferCompressedClaim>,
        expected_seller: Pubkey,
        new_owner: Pubkey,
    ) -> Result<()> {
        instructions::transfer_compressed_claim(ctx, expected_seller, new_owner)
    }
    pub fn set_compressed_claim_staked(
        ctx: Context<SetCompressedClaimStaked>,
        expected_owner: Pubkey,
        staked: bool,
    ) -> Result<()> {
        instructions::set_compressed_claim_staked(ctx, expected_owner, staked)
    }
    pub fn stage_compressed_chip(
        ctx: Context<StageCompressedChip>,
        buyer: Pubkey,
        collection_idx: u8,
        claim_nonce: u64,
        rarity: u8,
        level: u8,
        game_index: u64,
        expires_at: i64,
    ) -> Result<()> {
        instructions::stage_compressed_chip(
            ctx,
            buyer,
            collection_idx,
            claim_nonce,
            rarity,
            level,
            game_index,
            expires_at,
        )
    }
    pub fn cancel_compressed_claim(
        ctx: Context<CancelCompressedClaim>,
        claim_nonce: u64,
        nonce: u64,
    ) -> Result<()> {
        instructions::cancel_compressed_claim(ctx, claim_nonce, nonce)
    }
    pub fn finalize_compressed_pack(
        ctx: Context<FinalizeCompressedPack>,
        nonce: u64,
    ) -> Result<()> {
        instructions::finalize_compressed_pack(ctx, nonce)
    }
    /// Resolve one pending pack into Bubblegum claims without creating legacy
    /// MPL-Core assets. Minting and DAS registration are separate async steps.
    pub fn open_compressed_pack<'info>(
        ctx: Context<'_, '_, 'info, 'info, OpenCompressedPack<'info>>,
        nonce: u64,
        pack_no: u8,
    ) -> Result<()> {
        instructions::open_compressed_pack(ctx, nonce, pack_no)
    }
    /// Fuse three claim-bound compressed chips into a new claim-bound result.
    pub fn fuse_compressed_claims<'info>(
        ctx: Context<'_, '_, 'info, 'info, FuseCompressedClaims<'info>>,
        result_claim_nonce: u64,
        result_collection_idx: u8,
    ) -> Result<()> {
        instructions::fuse_compressed_claims(ctx, result_claim_nonce, result_collection_idx)
    }
    /// Commit a randomized fusion of three compressed claims (Epic+ recipes).
    pub fn fuse_claims_commit<'info>(
        ctx: Context<'_, '_, 'info, 'info, FuseClaimsCommit<'info>>,
        nonce: u64,
        use_booster: bool,
    ) -> Result<()> {
        instructions::fuse_claims_commit(ctx, nonce, use_booster)
    }
    /// Reveal a committed claim fusion (permissionless).
    pub fn fuse_claims_reveal<'info>(
        ctx: Context<'_, '_, 'info, 'info, FuseClaimsReveal<'info>>,
        nonce: u64,
        result_claim_nonce: u64,
    ) -> Result<()> {
        instructions::fuse_claims_reveal(ctx, nonce, result_claim_nonce)
    }
    /// Cancel a claim fusion whose oracle window expired (fee refunded).
    pub fn cancel_stale_claim_fusion<'info>(
        ctx: Context<'_, '_, 'info, 'info, CancelStaleClaimFusion<'info>>,
        nonce: u64,
    ) -> Result<()> {
        instructions::cancel_stale_claim_fusion(ctx, nonce)
    }
    /// Reclaim the rent of an expired settlement-free claim shell.
    pub fn close_expired_claim(ctx: Context<CloseExpiredClaim>, claim_nonce: u64) -> Result<()> {
        instructions::close_expired_claim(ctx, claim_nonce)
    }
    /// Bubblegum V2 mint CPI for a staged claim. The leaf index is intentionally
    /// resolved from the finalized DAS event after this instruction.
    pub fn mint_compressed_chip(
        ctx: Context<MintCompressedChip>,
        buyer: Pubkey,
        collection_idx: u8,
        claim_nonce: u64,
    ) -> Result<()> {
        instructions::mint_compressed_chip(ctx, buyer, collection_idx, claim_nonce)
    }
    /// Permissionless, proof-backed registration of a Bubblegum V2 leaf into
    /// Core's game-state projection. The remaining accounts are the bounded
    /// Account Compression proof nodes; successful verification marks the
    /// persistent claim registered for later ownership transitions.
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
        instructions::register_compressed_chip(
            ctx,
            asset_id,
            collection_idx,
            owner,
            delegate,
            buyer,
            claim_nonce,
            proof,
            rarity,
            level,
            game_index,
        )
    }
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        instructions::set_paused(ctx, paused)
    }
    pub fn set_pauser(ctx: Context<AdminOnly>, pauser: Pubkey) -> Result<()> {
        instructions::set_pauser(ctx, pauser)
    }
    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        instructions::pause(ctx)
    }
    pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        instructions::propose_admin(ctx, new_admin)
    }
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        instructions::accept_admin(ctx)
    }
    /// remaining_accounts = the LEDGER_SHARDS `VaultLedger` PDAs in order (#12)
    pub fn sweep_vault<'info>(ctx: Context<'_, '_, 'info, 'info, SweepVault<'info>>) -> Result<()> {
        instructions::sweep_vault(ctx)
    }
    /// Permissionless: creates ledger shard `shard` (< LEDGER_SHARDS) once (#12).
    pub fn init_ledger(ctx: Context<InitLedger>, shard: u8) -> Result<()> {
        instructions::init_ledger(ctx, shard)
    }
    pub fn grant_booster(ctx: Context<GrantBooster>, count: u16) -> Result<()> {
        instructions::grant_booster(ctx, count)
    }

    // ----- packs -----
    /// currency: 0 SOL (needs price_update SOL/USD), 1 USDC, 2 $CG, 3 SKR (needs price_update SKR/USD).
    /// `max_lamports` = slippage guard for volatile currencies (max lamports / max micro-SKR).
    pub fn buy_pack(
        ctx: Context<BuyPack>,
        sku: u8,
        qty: u8,
        currency: u8,
        nonce: u64,
        max_lamports: u64,
    ) -> Result<()> {
        instructions::buy_pack(ctx, sku, qty, currency, nonce, max_lamports)
    }
    pub fn open_pack<'info>(
        ctx: Context<'_, '_, 'info, 'info, OpenPack<'info>>,
        nonce: u64,
        pack_no: u8,
    ) -> Result<()> {
        instructions::open_pack(ctx, nonce, pack_no)
    }
    pub fn cancel_stale_pack(ctx: Context<CancelStalePack>, nonce: u64) -> Result<()> {
        instructions::cancel_stale_pack(ctx, nonce)
    }
    /// (#28) Quest chip voucher: a free 1-chip PendingPack (`template` = economy::VOUCHER_DEFS index) for
    /// `beneficiary`, issued only by the staking program's `["rewarder"]` PDA (CPI from `claim_chip_root`).
    /// Same tx as `init_randomness(0, nonce)`; opened by the regular `open_pack` crank.
    pub fn open_voucher(ctx: Context<OpenVoucher>, nonce: u64, template: u8) -> Result<()> {
        instructions::open_voucher(ctx, nonce, template)
    }

    // ----- program-owned Switchboard randomness (SEC-C3 part 2) -----
    /// kind: 0 pack, 1 fusion. Creates PDA `["rng", kind, owner, nonce]` with authority `["rng_auth"]`
    /// via CPI `randomness_init`; must be in the same tx as `buy_pack` / `fuse` (they commit).
    pub fn init_randomness(
        ctx: Context<InitRandomness>,
        kind: u8,
        nonce: u64,
        recent_slot: u64,
    ) -> Result<()> {
        instructions::init_randomness(ctx, kind, nonce, recent_slot)
    }
    /// Permissionless relay of the oracle's reveal (gateway response) — CPI `randomness_reveal` signed by `rng_auth`.
    pub fn reveal_randomness(
        ctx: Context<RevealRandomness>,
        signature: [u8; 64],
        recovery_id: u8,
        value: [u8; 32],
    ) -> Result<()> {
        instructions::reveal_randomness(ctx, signature, recovery_id, value)
    }
    /// Permissionless; only after the pending pack/fusion is gone. Rent → player (SEC-M7).
    pub fn close_randomness(ctx: Context<CloseRandomness>, kind: u8, nonce: u64) -> Result<()> {
        instructions::close_randomness(ctx, kind, nonce)
    }
    /// Permissionless, after the randomness account is closed and the ALT cooldown has passed:
    /// the lookup table's rent (~0.0015 SOL/bundle, backlog #23) → player, never the caller.
    pub fn close_randomness_lut(
        ctx: Context<CloseRandomnessLut>,
        kind: u8,
        nonce: u64,
        lut_slot: u64,
    ) -> Result<()> {
        instructions::close_randomness_lut(ctx, kind, nonce, lut_slot)
    }

    // ----- paid services (handles, cosmetics, boosters, season pass) -----
    /// kind: economy::ServiceKind; currency as in buy_pack; $CG is burned, everything else → treasury.
    pub fn pay_service(
        ctx: Context<PayService>,
        kind: u8,
        currency: u8,
        max_units: u64,
        ref_hash: [u8; 32],
    ) -> Result<()> {
        instructions::pay_service(ctx, kind, currency, max_units, ref_hash)
    }

    // ----- fusion -----
    pub fn fuse<'info>(
        ctx: Context<'_, '_, 'info, 'info, Fuse<'info>>,
        nonce: u64,
        use_booster: bool,
    ) -> Result<()> {
        instructions::fuse(ctx, nonce, use_booster)
    }
    pub fn fuse_reveal<'info>(
        ctx: Context<'_, '_, 'info, 'info, FuseReveal<'info>>,
        nonce: u64,
    ) -> Result<()> {
        instructions::fuse_reveal(ctx, nonce)
    }
    pub fn cancel_stale_fusion<'info>(
        ctx: Context<'_, '_, 'info, 'info, CancelStaleFusion<'info>>,
        nonce: u64,
    ) -> Result<()> {
        instructions::cancel_stale_fusion(ctx, nonce)
    }

    // ----- chip state (CPI from market/staking + player thaw) -----
    pub fn set_chip_flag(
        ctx: Context<SetChipFlag>,
        flag: u8,
        set: bool,
        expected_owner: Pubkey,
    ) -> Result<()> {
        instructions::set_chip_flag(ctx, flag, set, expected_owner)
    }
    pub fn deliver_sold(ctx: Context<DeliverSold>, expected_seller: Pubkey) -> Result<()> {
        instructions::deliver_sold(ctx, expected_seller)
    }
    pub fn thaw_chip(ctx: Context<ThawChip>) -> Result<()> {
        instructions::thaw_chip(ctx)
    }
}
