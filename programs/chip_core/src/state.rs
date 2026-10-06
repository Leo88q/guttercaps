use crate::economy::{PackDef, Rarity, MATERIALS_PER_FUSION, MAX_CHIPS_PER_PACK, RARITY_COUNT};
use crate::errors::ChipError;
use anchor_lang::prelude::*;

/// Global config. Single PDA `["config"]`. Admin is expected to be a Squads
/// multisig; every tunable is validated by `set_params` against the
/// guard-rails in `economy.rs` so a compromised admin key can't turn a pack
/// into a Legend faucet or set a 90 % fee.
#[account]
#[derive(InitSpace)]
pub struct GameConfig {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,  // 2-step admin transfer
    pub treasury: Pubkey,       // SOL/USDC destination (Squads vault)
    pub buyback_wallet: Pubkey, // receives the "burn" half of SOL/USDC fees → weekly $CG buyback+burn
    pub cg_mint: Pubkey,
    pub usdc_mint: Pubkey,
    pub skr_mint: Pubkey, // Seeker (Solana Mobile) — SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3 on mainnet
    pub staking_program: Pubkey, // for report_burn CPI
    pub pyth_sol_usd_feed: Pubkey,
    pub pyth_skr_usd_feed: Pubkey,
    pub featured_collection: u8, // for Limited packs
    pub paused: bool,
    pub packs: [PackDef; 4],
    pub market_fee_bps: u16,
    pub skr_discount_bps: u16, // promo discount for packs paid in SKR (≤ MAX_SKR_DISCOUNT_BPS)
    pub collections_created: u8,
    // (#12) refund liabilities and the $CG burn total moved to the sharded `VaultLedger` PDAs so
    // that no player instruction ever takes a write lock on this account.
    pub params_version: u32,
    pub vault_bump: u8,
    pub bump: u8,
    /// SEC-H2: hot key (Squads 1/3, no timelock) allowed to call `pause` only — it can stop the
    /// game within minutes of an alert; lifting the pause stays with `admin` (`set_paused(false)`).
    /// `Pubkey::default()` = no pauser (admin still can). Appended last: layout-compatible with
    /// decoders that stop at `bump` (backend/src/chain.ts) — the client decoder reads it.
    pub pauser: Pubkey,
}

/// Number of `VaultLedger` shards (#12). Player instructions write exactly one shard
/// (`wallet[0] % LEDGER_SHARDS`), `sweep_vault` reads all of them. Mirrored in
/// client/src/chain/pdas.ts and backend/src/chain.ts (`LEDGER_SHARDS`, pinned by sync-check).
pub const LEDGER_SHARDS: u8 = 4;

/// Refund liabilities + $CG burn total, sharded (docs/06 §4.2 conclusion 1, backlog #12).
///
/// Before: `buy_pack`, `open_pack`, `cancel_stale_pack`, `fuse*`, `pay_service` all declared
/// `config` as `mut` for these five counters, so every purchase/reveal on the cluster serialised
/// on one account (≈ 96 % of the 12 M CU per-account budget at the P2 spike). Now `config` is
/// read-only in every player instruction and the counters live in `LEDGER_SHARDS` tiny PDAs
/// `["ledger", shard]`, shard = first byte of the paying wallet mod `LEDGER_SHARDS` — the same
/// wallet always hits the same shard, so a purchase's `add` and its later `release` (open /
/// refund) balance within one account. Packs 1…N−1 of a bundle pass the shard read-only.
/// Created once per shard by the permissionless `init_ledger` (setup step `ledgers`).
#[account]
#[derive(InitSpace)]
pub struct VaultLedger {
    pub shard: u8,
    /// outstanding refund liabilities held in the vault: unrevealed packs (all currencies) and
    /// escrowed fusion fees (`liab_cg`, SEC-M3)
    pub liab_lamports: u64,
    pub liab_usdc: u64,
    pub liab_cg: u64,
    pub liab_skr: u64,
    /// running total of $CG burned through this shard (packs + fusion + paid services) — analytics/guards
    pub burned_total: u64,
    pub bump: u8,
}

impl VaultLedger {
    pub const SEED: &'static [u8] = b"ledger";
    /// Shard of a wallet: first byte of the key mod `LEDGER_SHARDS` (uniform for ed25519 keys and PDAs).
    pub fn shard_of(wallet: &Pubkey) -> u8 {
        wallet.to_bytes()[0] % LEDGER_SHARDS
    }
    /// A purchase / escrow was taken into the vault.
    pub fn add(&mut self, lamports: u64, usdc: u64, cg: u64, skr: u64) -> Result<()> {
        self.liab_lamports = self
            .liab_lamports
            .checked_add(lamports)
            .ok_or(ChipError::Overflow)?;
        self.liab_usdc = self
            .liab_usdc
            .checked_add(usdc)
            .ok_or(ChipError::Overflow)?;
        self.liab_cg = self.liab_cg.checked_add(cg).ok_or(ChipError::Overflow)?;
        self.liab_skr = self.liab_skr.checked_add(skr).ok_or(ChipError::Overflow)?;
        Ok(())
    }
    /// The purchase settled (opened / burned) or was refunded.
    pub fn release(&mut self, lamports: u64, usdc: u64, cg: u64, skr: u64) -> Result<()> {
        self.liab_lamports = self
            .liab_lamports
            .checked_sub(lamports)
            .ok_or(ChipError::Overflow)?;
        self.liab_usdc = self
            .liab_usdc
            .checked_sub(usdc)
            .ok_or(ChipError::Overflow)?;
        self.liab_cg = self.liab_cg.checked_sub(cg).ok_or(ChipError::Overflow)?;
        self.liab_skr = self.liab_skr.checked_sub(skr).ok_or(ChipError::Overflow)?;
        Ok(())
    }
    pub fn burned(&mut self, cg: u64) {
        self.burned_total = self.burned_total.saturating_add(cg);
    }
    /// Accounts declared without `mut` (the shard in `open_pack`, the vault in `buy_pack`) must
    /// still arrive writable on the path that modifies them — checked here so the failure is a
    /// clear program error, not a runtime `ReadonlyLamportChange` / `ReadonlyDataModified`.
    pub fn require_writable(ai: &AccountInfo) -> Result<()> {
        require!(ai.is_writable, ChipError::AccountNotWritable);
        Ok(())
    }
    /// Sum over all shards. `accounts` must be exactly the `LEDGER_SHARDS` shard PDAs in order
    /// 0…N−1 — verified by owner + discriminator (`Account::try_from`), the stored `shard` and the
    /// seeds; a missing or foreign account is rejected, never treated as zero.
    // `AccountInfo<'info>` with the lifetime *named*: `Account::try_from(ai)` yields
    // `Account<'info, VaultLedger>`, and with both lifetimes left elided (`&[AccountInfo]`) the inner one
    // is a fresh inference variable that the returned `Account` cannot be tied to — the compiler's
    // "lifetime may not live long enough" on the `for` line, where nothing in the source mentions a borrow.
    // Naming the inner one is not enough on its own: the first compile run answered with
    // `error[E0621]: explicit lifetime required in the type of accounts` and wrote the shape it wanted —
    // `&'info [AccountInfo<'info>]` — because `Account::try_from` returns an `Account<'info, _>` that keeps
    // the handle, so the borrow of the slice has to last as long as the accounts it points into.
    // `ctx.remaining_accounts` is already exactly that type, so no caller moves; the tempting alternative
    // (clone the handle per shard) is an allocation inside a sum that runs on every pack buy.
    pub fn totals<'info>(
        accounts: &'info [AccountInfo<'info>],
        program_id: &Pubkey,
    ) -> Result<LedgerTotals> {
        require!(
            accounts.len() == LEDGER_SHARDS as usize,
            ChipError::InvalidShard
        );
        let mut t = LedgerTotals::default();
        for (i, ai) in accounts.iter().enumerate() {
            let l: Account<VaultLedger> = Account::try_from(ai)?;
            require!(l.shard == i as u8, ChipError::InvalidShard);
            // SW026: enforce the canonical bump — derive with find_program_address
            // and reject any non-canonical bump stored in the ledger shard.
            let (exp, canonical_bump) =
                Pubkey::find_program_address(&[Self::SEED, &[i as u8]], program_id);
            require!(l.bump == canonical_bump, ChipError::InvalidShard);
            require_keys_eq!(exp, ai.key(), ChipError::InvalidShard);
            t.liab_lamports = t
                .liab_lamports
                .checked_add(l.liab_lamports)
                .ok_or(ChipError::Overflow)?;
            t.liab_usdc = t
                .liab_usdc
                .checked_add(l.liab_usdc)
                .ok_or(ChipError::Overflow)?;
            t.liab_cg = t
                .liab_cg
                .checked_add(l.liab_cg)
                .ok_or(ChipError::Overflow)?;
            t.liab_skr = t
                .liab_skr
                .checked_add(l.liab_skr)
                .ok_or(ChipError::Overflow)?;
            t.burned_total = t.burned_total.saturating_add(l.burned_total);
        }
        Ok(t)
    }
}

/// Sum of the ledger shards (`VaultLedger::totals`).
#[derive(Default, Clone, Copy, Debug)]
pub struct LedgerTotals {
    pub liab_lamports: u64,
    pub liab_usdc: u64,
    pub liab_cg: u64,
    pub liab_skr: u64,
    pub burned_total: u64,
}

/// One per collection (district). Points at the Metaplex Core Collection
/// account whose update authority is this PDA — so all plugin operations on
/// chips (freeze/burn/attribute update) are signed by the program.
#[account]
#[derive(InitSpace)]
pub struct CollectionMeta {
    pub idx: u8,
    pub core_collection: Pubkey,
    #[max_len(16)]
    pub symbol: String,
    pub element: u8, // 0 paint, 1 steel, 2 wheels, 3 noise, 4 shadow
    pub minted: u64, // running #index
    pub minted_by_rarity: [u64; RARITY_COUNT],
    pub bump: u8,
}

/// Admin-owned registry for one Bubblegum V2 Merkle tree. The actual
/// `tree_config` account is owned by Bubblegum and is deliberately kept as a
/// pubkey here; this account only binds the configured tree to our Core
/// collection and authority policy. Seeds ["bubblegum_tree", collection_idx].
#[account]
#[derive(InitSpace)]
pub struct BubblegumTreeMeta {
    pub collection_idx: u8,
    pub core_collection: Pubkey,
    pub merkle_tree: Pubkey,
    pub tree_config: Pubkey,
    pub tree_authority: Pubkey,
    pub max_depth: u8,
    pub canopy: u8,
    pub active: bool,
    pub bump: u8,
}

/// Core-owned projection of one Bubblegum V2 leaf. The compressed asset and
/// Merkle tree remain authoritative; this PDA stores only game state and the
/// immutable commitments needed to reconstruct the leaf for later proofs.
/// Seeds ["compressed_chip", asset].
#[account]
#[derive(InitSpace)]
pub struct CompressedChipState {
    pub asset: Pubkey,
    /// Persistent economic receipt for this registered leaf. It is deliberately
    /// separate from the asset id so the V2 leaf may change owner without
    /// changing the claim PDA or game identity.
    pub claim: Pubkey,
    pub collection_idx: u8,
    pub merkle_tree: Pubkey,
    pub leaf_index: u32,
    pub leaf_nonce: u64,
    pub data_hash: [u8; 32],
    pub creator_hash: [u8; 32],
    pub collection_hash: [u8; 32],
    pub asset_data_hash: [u8; 32],
    pub leaf_flags: u8,
    pub rarity: Rarity,
    pub level: u8,
    pub index: u64,
    /// bit 0 staked, bit 1 listed, bit 2 in-fusion, bit 3 soulbound
    pub flags: u8,
    pub lock_until: i64,
    pub minted_at: i64,
    pub bump: u8,
}

impl CompressedChipState {
    pub const F_STAKED: u8 = 1 << 0;
    pub const F_LISTED: u8 = 1 << 1;
    pub const F_FUSING: u8 = 1 << 2;
    pub const F_SOULBOUND: u8 = 1 << 3;
    /// Mainnet pre-sale origin — permanent founder frame (docs/preorder-beta.md).
    pub const F_FOUNDER: u8 = 1 << 4;

    pub fn is_free(&self, now: i64) -> bool {
        self.flags & (Self::F_STAKED | Self::F_LISTED | Self::F_FUSING) == 0
            && self.leaf_flags & 0b11 == 0
            && now >= self.lock_until
    }
}

/// One-time Core authorization for registering a leaf minted for a pack slot.
/// It binds the economically relevant fields before the permissionless DAS
/// registration crank runs. Seeds ["compressed_claim", origin, claim_nonce].
/// `origin` is immutable so the claim PDA remains stable after ownership transfer.
#[account]
#[derive(InitSpace)]
pub struct CompressedMintClaim {
    pub buyer: Pubkey,
    pub collection_idx: u8,
    pub rarity: Rarity,
    pub level: u8,
    pub game_index: u64,
    pub expires_at: i64,
    /// Settlement PDA for a permissionless compressed pack. The default key
    /// denotes the legacy/admin staging path, which has no pending payment.
    pub settlement: Pubkey,
    /// Set when the collection index was reserved while opening a compressed
    /// pack. Reserved claims must not increment CollectionMeta again at DAS
    /// registration time.
    pub index_reserved: bool,
    /// Set after the Bubblegum mint CPI and consumed by proof-backed registration.
    pub minted: bool,
    /// Set after the first successful DAS proof registration. The receipt stays
    /// open for the lifetime of the cNFT so market/staking/fusion can retain a
    /// canonical origin without manufacturing a second ownership source.
    pub registered: bool,
    /// Set when this claim is consumed as a compressed-fusion material.
    pub consumed: bool,
    /// Set while the custom compressed marketplace has custody of the claim.
    pub listed: bool,
    pub bump: u8,
    /// Set while the claim is committed to the compressed staking pool.
    pub staked: bool,
    /// Immutable origin used for canonical claim-PDA derivation. It never
    /// changes when `buyer` is transferred through the custom market.
    pub origin: Pubkey,
    /// Soulbound / fusion-result time lock (unix seconds, 0 = free to trade).
    /// Set from `PendingPack.soulbound_days` by `open_compressed_pack` and from
    /// the recipe by fusion; enforced at listing time by the market program and
    /// by `set_compressed_claim_listed`, and copied to `CompressedChipState` at
    /// registration. Appended last (layout-compatible with older decoders).
    pub lock_until: i64,
    /// Mainnet pre-sale origin (docs/preorder-beta.md): copied from `PendingPack.preorder`
    /// at open time; the registered chip gets `CompressedChipState::F_FOUNDER`.
    pub founder: bool,
}

/// Settlement state for a paid compressed pack. The pending purchase remains
/// open until every claim is registered or an unminted expired claim is
/// cancelled through the recovery path.
/// Seeds ["compressed_settlement", buyer, nonce].
#[account]
#[derive(InitSpace)]
pub struct CompressedPackSettlement {
    pub buyer: Pubkey,
    pub pending: Pubkey,
    pub nonce: u64,
    pub total_claims: u16,
    pub registered_claims: u16,
    pub cancelled_claims: u16,
    pub bump: u8,
}

/// Mutable game state of one chip. Seeds ["chip", compressed_asset_id].
#[account]
#[derive(InitSpace)]
pub struct ChipState {
    pub asset: Pubkey,
    pub collection_idx: u8,
    pub rarity: Rarity,
    pub level: u8,
    pub index: u64,
    /// bit 0 staked, bit 1 listed, bit 2 in-fusion, bit 3 soulbound
    pub flags: u8,
    /// unix ts until which the chip cannot be transferred/listed/fused
    pub lock_until: i64,
    pub minted_at: i64,
    pub bump: u8,
}

impl ChipState {
    pub const F_STAKED: u8 = 1 << 0;
    pub const F_LISTED: u8 = 1 << 1;
    pub const F_FUSING: u8 = 1 << 2;
    pub const F_SOULBOUND: u8 = 1 << 3;
    /// Mainnet pre-sale origin — permanent founder frame (docs/preorder-beta.md).
    pub const F_FOUNDER: u8 = 1 << 4;

    pub fn is_free(&self, now: i64) -> bool {
        self.flags & (Self::F_STAKED | Self::F_LISTED | Self::F_FUSING) == 0
            && now >= self.lock_until
    }
}

/// Per-wallet pity counters + rolling daily purchase caps.
#[account]
#[derive(InitSpace)]
pub struct PlayerPity {
    pub owner: Pubkey,
    pub counters: [u16; 4], // per SKU
    pub day_start: i64,
    pub bought_today: [u8; 4],
    pub starter_claimed: bool,
    pub bump: u8,
}

/// In-flight pack purchase awaiting Switchboard reveal.
#[account]
#[derive(InitSpace)]
pub struct PendingPack {
    pub buyer: Pubkey,
    pub sku: u8,
    pub qty: u8,    // packs in this purchase (bundle)
    pub opened: u8, // packs already opened (sequential)
    pub randomness: Pubkey,
    pub commit_slot: u64,
    pub paid_lamports: u64, // held in vault until reveal; refundable 100 % if stale
    pub paid_usdc: u64,
    pub paid_cg: u64,
    pub paid_skr: u64,
    pub pity_snapshot: u16,
    pub nonce: u64,
    pub bump: u8,
    /// Oracle value copied in by the first `open_pack` (SEC-C2): packs 2…N of a bundle derive
    /// their sub-seeds from here and never read the randomness account again.
    pub revealed: bool,
    pub value: [u8; 32],
    /// Quest chip voucher (#28): created by `open_voucher` (CPI from staking `claim_chip_root`)
    /// instead of `buy_pack` — nothing was paid (`paid_* = 0`), `sku = 0` only indexes the pity
    /// arrays (never a Starter: no `starter_claimed`, no daily cap, no pity), ONE chip rolled with
    /// `voucher_odds` and frozen for `soulbound_days`. Appended last (layout-compatible decoders).
    pub voucher: bool,
    pub voucher_odds: [u16; RARITY_COUNT],
    pub soulbound_days: u8,
    /// Mainnet pre-sale (docs/preorder-beta.md): created by `grant_preorder_pack` instead of
    /// `buy_pack`. Chips minted from this pack carry `ChipState::F_FOUNDER` — the permanent
    /// founder frame. Appended after `soulbound_days` (layout-compatible decoders).
    pub preorder: bool,
}

/// In-flight fusion (recipes with < 100 % success).
#[account]
#[derive(InitSpace)]
pub struct PendingFusion {
    pub owner: Pubkey,
    pub recipe: u8,
    pub materials: [Pubkey; MATERIALS_PER_FUSION],
    pub result_collection_idx: u8,
    pub boosted: bool,
    pub randomness: Pubkey,
    pub commit_slot: u64,
    pub nonce: u64,
    pub bump: u8,
    /// SEC-M3: the recipe fee ($CG micro) held in the vault's $CG ATA between commit and settlement —
    /// burned by `fuse_reveal`, returned by `cancel_stale_fusion`. Counted in `VaultLedger.liab_cg`
    /// so `sweep_vault` can never touch it. Appended last (layout-compatible with older decoders).
    pub fee_escrowed: u64,
}

/// `["claim_fusion", owner, nonce]` — randomized fusion of three compressed
/// claims (recipes with < 100 % success, i.e. Epic and above). Mirrors
/// `PendingFusion`, but the materials are claim PDAs (marked `consumed` at
/// commit, refunded by key order on failure) instead of Core assets.
#[account]
#[derive(InitSpace)]
pub struct PendingClaimFusion {
    pub owner: Pubkey,
    /// Input rarity index (`recipe_for` input).
    pub recipe: u8,
    /// The three consumed claim PDAs, in caller order.
    pub materials: [Pubkey; MATERIALS_PER_FUSION],
    pub result_collection_idx: u8,
    pub boosted: bool,
    pub randomness: Pubkey,
    pub commit_slot: u64,
    pub nonce: u64,
    pub bump: u8,
    /// SEC-M3, same as `PendingFusion.fee_escrowed`: burned by
    /// `fuse_claims_reveal`, returned by `cancel_stale_claim_fusion`.
    pub fee_escrowed: u64,
}

/// Player-owned consumables (boosters). Kept as a tiny PDA instead of an
/// SPL token: they're never tradeable by design.
#[account]
#[derive(InitSpace)]
pub struct PlayerItems {
    pub owner: Pubkey,
    pub boosters: u16,
    pub bump: u8,
}

/// Beta pre-sale delivery window for one pack SKU (`["drop", sku]`): the admin opens it with a
/// hard `total` and `grant_preorder_pack` converts paid off-chain preorders into real packs,
/// incrementing `granted`. The program refuses the `total + 1`-th pack; the off-chain registry
/// (backend/src/preorders.ts) is convenience, this account is the gate. `max_per_wallet` caps the
/// per-wallet count enforced through `PreorderGrant` (0 = uncapped).
#[account]
#[derive(InitSpace)]
pub struct PreorderDrop {
    pub admin: Pubkey,
    pub sku: u8,
    pub bump: u8,
    pub max_per_wallet: u8,
    pub total: u32,
    pub granted: u32,
    pub opened_at: i64,
    pub closed: bool,
}

/// Per-wallet preorder tally for one drop (`["pregrant", drop, beneficiary]`) — the per-wallet
/// cap check and the on-chain audit trail of the grant (who received how many packs).
#[account]
#[derive(InitSpace)]
pub struct PreorderGrant {
    pub drop: Pubkey,
    pub beneficiary: Pubkey,
    pub count: u32,
    pub bump: u8,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Currency {
    Sol = 0,
    Usdc = 1,
    Cg = 2,
    Skr = 3,
}

/// Paid service (handle, cosmetics, boosters, season pass…) settled on-chain.
/// `kind` is a small enum shared with the indexer (see economy::ServiceKind);
/// `ref_hash` = keccak(canonical payload) so the backend can bind the payment
/// to e.g. a specific handle string without storing strings on-chain.
#[event]
pub struct ServicePaid {
    pub buyer: Pubkey,
    pub kind: u8,
    pub currency: u8,
    pub amount: u64,
    pub burned: u64,
    pub ref_hash: [u8; 32],
}

#[event]
pub struct PackBought {
    pub buyer: Pubkey,
    pub sku: u8,
    pub qty: u8,
    pub currency: u8,
    pub amount: u64,
    pub nonce: u64,
    pub randomness: Pubkey,
}

#[event]
pub struct PackOpened {
    pub buyer: Pubkey,
    pub sku: u8,
    pub nonce: u64,
    pub assets: [Pubkey; MAX_CHIPS_PER_PACK],
    pub rarities: [u8; MAX_CHIPS_PER_PACK],
    pub collections: [u8; MAX_CHIPS_PER_PACK],
    pub count: u8,
    pub roll: [u8; 32],
    pub pity_before: u16,
    pub pity_after: u16,
}

#[event]
pub struct PackCancelled {
    pub buyer: Pubkey,
    pub nonce: u64,
    pub refunded: u64,
}

/// The admin opened a beta pre-sale drop for one SKU (`init_preorder_drop`).
#[event]
pub struct PreorderDropOpened {
    pub admin: Pubkey,
    pub drop: Pubkey,
    pub sku: u8,
    pub total: u32,
    pub max_per_wallet: u8,
}

/// The admin converted a paid off-chain preorder into a pack owned by the beneficiary
/// (`grant_preorder_pack`). `preorder_ref` is the backend registry id that joins the on-chain
/// grant to the payment (memo `GC-PRE|<ref>` → registry row → this event).
#[event]
pub struct PackGranted {
    pub admin: Pubkey,
    pub beneficiary: Pubkey,
    pub sku: u8,
    pub qty: u8,
    pub nonce: u64,
    pub preorder_ref: u64,
    pub randomness: Pubkey,
}

/// The admin retired a fully delivered drop (`close_preorder_drop`). Emitted before the rent
/// reclaim so the governance trail keeps the closing statement: `granted == total` at close time.
#[event]
pub struct PreorderDropClosed {
    pub admin: Pubkey,
    pub drop: Pubkey,
    pub sku: u8,
    pub total: u32,
}

/// Quest chip voucher issued (#28): a free 1-chip PendingPack for `wallet` — opened by the regular
/// `open_pack` crank, which then emits `PackOpened { sku: 0 }` for the same (wallet, nonce).
#[event]
pub struct VoucherIssued {
    pub wallet: Pubkey,
    pub nonce: u64,
    pub template: u8,
    pub randomness: Pubkey,
}

#[event]
pub struct ChipFused {
    pub owner: Pubkey,
    pub recipe: u8,
    pub materials: [Pubkey; MATERIALS_PER_FUSION],
    pub result: Pubkey, // default if failed
    pub success: bool,
    pub roll_bps: u16,
    pub threshold_bps: u16,
    pub fee_burned: u64,
}

#[event]
pub struct ChipFlagsChanged {
    pub asset: Pubkey,
    pub flags: u8,
    pub lock_until: i64,
}

#[event]
pub struct ParamsChanged {
    pub admin: Pubkey,
    pub version: u32,
}

/// SEC-B22: what `set_params` actually changed — `ParamsChanged` only carries the new `version`, which
/// is enough to see *that* something moved and useless for seeing *what* moved. Addresses that redirect
/// money (`treasury`, `buyback_wallet`), the Pyth feeds and the SKR mint are separated out here.
///
/// `changed` is a bitmask of `PARAMS_FIELD_*` (admin.rs); fields whose bit is clear carry the default
/// value and mean "untouched". The shape is scalars only on purpose: the backend event codec decodes it
/// without an Option type, and the wire layer already exposes unknown events as a scalar map, so this
/// event is visible in `events_raw` and in the admin panel without a new API surface.
#[event]
pub struct ParamsPatched {
    pub admin: Pubkey,
    pub version: u32,
    pub changed: u16,
    pub treasury: Pubkey,
    pub buyback_wallet: Pubkey,
    pub pyth_sol_usd_feed: Pubkey,
    pub pyth_skr_usd_feed: Pubkey,
    pub skr_mint: Pubkey,
    pub market_fee_bps: u16,
    pub skr_discount_bps: u16,
    pub featured_collection: u8,
    pub packs: bool,
}
/// `by` = the signer that flipped the switch (pauser or admin). Indexed for the admin audit log.
#[event]
pub struct PauseChanged {
    pub by: Pubkey,
    pub paused: bool,
}
/// SEC-G05 (Watchtower SW027) governance audit trail: every change to a key that can pause,
/// re-parameterise or take over the program is emitted, so the indexer/alerts see a hostile or
/// mistaken rotation the moment it lands instead of at the next manual `/admin` glance.
/// `set_pauser` — `pauser == default` clears the hot key.
#[event]
pub struct PauserChanged {
    pub by: Pubkey,
    pub pauser: Pubkey,
}
/// `propose_admin` (step 1 of the 2-step transfer; `new_admin == default` withdraws a proposal).
#[event]
pub struct AdminProposed {
    pub by: Pubkey,
    pub new_admin: Pubkey,
}
/// `accept_admin` (step 2): `old_admin` handed over to `new_admin`.
#[event]
pub struct AdminAccepted {
    pub old_admin: Pubkey,
    pub new_admin: Pubkey,
}
/// `create_collection`: collection `idx` is backed by MPL-Core collection `core_collection`.
#[event]
pub struct CollectionCreated {
    pub by: Pubkey,
    pub idx: u8,
    pub core_collection: Pubkey,
}

/// source: 0 pack-in-$CG, 1 fusion fee, 2 (reserved: penalties live in staking), 3 paid service in $CG
#[event]
pub struct BurnReported {
    pub source: u8,
    pub amount: u64,
}

// ── SW027: observability events for external indexers (Helika/GameSight/Game Signals) ──
// The CPI-only claim transitions below are also reported by the calling program (market
// `CompressedClaimListed`/`CompressedClaimSold`, staking `Staked`/`Unstaked`); these mirror the
// chip_core-side flag flips for indexers that only follow this program. Names are distinct from the
// market's events on purpose: Anchor event discriminators are `sha256("event:<Name>")` regardless of
// the program, so a chip_core `CompressedClaimListed` would collide with the market's (different
// payload, same 8 bytes) for any log parser that is not program-scoped (e.g. the client's `findEvent`).

/// `set_compressed_claim_listed` (CPI from the market): the `listed` flag of `claim`, owned by `buyer`.
#[event]
pub struct CompressedClaimListedSet {
    pub claim: Pubkey,
    pub buyer: Pubkey,
    pub listed: bool,
}

/// `transfer_compressed_claim` (CPI from the market): `claim` moved `from` → `to`.
#[event]
pub struct CompressedClaimTransferred {
    pub claim: Pubkey,
    pub from: Pubkey,
    pub to: Pubkey,
}

/// `set_compressed_claim_staked` (CPI from staking): the `staked` flag of `claim`, owned by `buyer`.
#[event]
pub struct CompressedClaimStakedSet {
    pub claim: Pubkey,
    pub buyer: Pubkey,
    pub staked: bool,
}

/// SEC-G04: mirror of `ChipFused` for the claim-based fusion path (`fuse_compressed_claims`): the
/// three material claims are consumed (`consumed = true`, accounts stay open) and `result_claim` is
/// a fresh settlement-free claim of `result_rarity` in `result_collection_idx`. `fee_burned` $CG
/// went to the burn ledger. Always a success (claim recipes are 100 %), hence no roll fields.
/// SEC-F4 (2026-09-25, governance audit trail): `stage_compressed_chip` is the one admin path that
/// creates a settlement-free claim of ANY rarity out of thin air (fusable, listable, stakeable), and
/// it emitted nothing — a compromised or mistaken admin key left no trace for the indexer.
#[event]
pub struct CompressedChipStaged {
    pub admin: Pubkey,
    pub buyer: Pubkey,
    pub claim: Pubkey,
    pub collection_idx: u8,
    pub rarity: u8,
    pub level: u8,
    pub game_index: u64,
    pub expires_at: i64,
}
#[event]
pub struct CompressedClaimsFused {
    pub owner: Pubkey,
    pub recipe: u8,
    pub materials: [Pubkey; MATERIALS_PER_FUSION],
    pub result_claim: Pubkey,
    pub result_claim_nonce: u64,
    pub result_collection_idx: u8,
    pub result_rarity: u8,
    pub fee_burned: u64,
}
