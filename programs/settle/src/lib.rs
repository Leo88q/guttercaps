//! GUTTERCAPS — phase-V thin settlement program (docs/PHASED-ONCHAIN-PLAN.md §3).
//!
//! One program instead of four. It owns only what must be undisputable:
//! escrowed pack payments, oracle-authorized mints (Ed25519 MINT_ORACLE),
//! Merkle reward claims and a cNFT escrow market. Recipes, odds, pity, quests
//! and XP stay in the backend; the program verifies signatures, nonces and
//! caps. The phase-G tree is reused: at activation the tree creator delegates
//! minting to this program's `tree_auth` PDA (Bubblegum `set_tree_delegate`),
//! and the 8 MPL Core collections move their update authority to the same
//! PDA, so one PDA signature covers tree-delegate and collection-authority
//! roles in the mint CPI. Deactivation reverses both — the switch is a
//! config flip, not a migration.
//!
//! Program id is a dev-derived placeholder until the mainnet id ceremony
//! (same status as the other four programs, `npm run program-ids`).

#![allow(clippy::result_large_err)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    hash::hashv,
    instruction::Instruction,
    sysvar::instructions::{
        load_current_index_checked, load_instruction_at_checked, ID as INSTRUCTIONS_SYSVAR_ID,
    },
};
use anchor_spl::{
    associated_token::{get_associated_token_address, AssociatedToken},
    token::{self, Mint, Token, TokenAccount, Transfer},
};
use mpl_bubblegum::{
    instructions::{MintV2CpiBuilder, TransferV2CpiBuilder},
    types::{Creator, MetadataArgsV2, TokenStandard},
};

declare_id!("B9ousNDpe29G45KFHyndvHXpLigBtxCh9xbboWuCeXyP");

// ---------------------------------------------------------------------------
// Constants (program ids pinned like chip_core::bubblegum)

pub const BUBBLEGUM_V2_ID: Pubkey = pubkey!("BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY");
pub const MPL_CORE_ID: Pubkey = pubkey!("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
pub const MPL_ACCOUNT_COMPRESSION_ID: Pubkey =
    pubkey!("mcmt6YrQEMKw8Mw43FmpRLmf7BqRnFMKmAcbxE3xkAW");
pub const MPL_NOOP_ID: Pubkey = pubkey!("mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3");

/// The Bubblegum V2 CPI signer PDA (signs the MPL Core collection CPI).
pub fn mpl_core_cpi_signer() -> Pubkey {
    Pubkey::find_program_address(&[b"mpl_core_cpi_signer"], &BUBBLEGUM_V2_ID).0
}
pub const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

/// Same royalty the backend metadata and chip_core collections carry.
pub const ROYALTY_BPS: u16 = 250;
/// An unpaid-refund window: ~24h at 400 ms slots. After it, `refund_pack`
/// returns the escrow to the buyer (the oracle simply never signed).
pub const REFUND_AFTER_SLOTS: u64 = 216_000;
/// Leaves per settle are bounded by transaction size long before this.
pub const MAX_SPECS: usize = 10;
/// MintAuth message domain prefix; the TS twin lives in backend/src/phasev.ts.
pub const MINT_AUTH_PREFIX: &[u8] = b"GUTCAP/MINTAUTH/V1";

pub const CURRENCY_SOL: u8 = 0;
pub const CURRENCY_USDC: u8 = 1;
pub const CURRENCY_CG: u8 = 2;

pub const STATUS_PAID: u8 = 0;
pub const STATUS_SETTLED: u8 = 1;
pub const STATUS_REFUNDED: u8 = 2;

// ---------------------------------------------------------------------------
// Shared arg types

/// Bubblegum V2 leaf proof transport — same shape as chip_core::LeafProofArgs.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Eq, PartialEq)]
pub struct LeafProofArgs {
    pub root: [u8; 32],
    pub data_hash: [u8; 32],
    pub creator_hash: [u8; 32],
    pub collection_hash: [u8; 32],
    pub asset_data_hash: [u8; 32],
    pub flags: u8,
    pub nonce: u64,
    pub index: u32,
}

/// What the MINT_ORACLE signs. Byte layout of the signed message:
/// prefix ‖ wallet ‖ order_id(le) ‖ specs_hash ‖ nonce(le) ‖ expires_at_slot(le).
/// `nonce` is pinned to the order id: an order settles exactly once, so a
/// signature can never be replayed against another order.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Eq, PartialEq)]
pub struct MintAuth {
    pub wallet: Pubkey,
    pub order_id: u64,
    pub specs_hash: [u8; 32],
    pub nonce: u64,
    pub expires_at_slot: u64,
}

/// One leaf to mint. `collection` is the MPL Core collection pubkey, or the
/// zero key for a collection-less leaf (its account is then not required).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct LeafSpec {
    pub collection: Pubkey,
    pub name: String,
    pub symbol: String,
    pub uri: String,
}

pub fn specs_hash(specs: &[LeafSpec]) -> [u8; 32] {
    // Serialization pinned with backend/src/phasev.ts (specsHash):
    // per spec: collection ‖ len+name ‖ len+symbol ‖ len+uri (u32 LE lengths).
    let mut buf = Vec::with_capacity(specs.len() * 128);
    for s in specs {
        buf.extend_from_slice(s.collection.as_ref());
        for v in [&s.name, &s.symbol, &s.uri] {
            buf.extend_from_slice(&(v.len() as u32).to_le_bytes());
            buf.extend_from_slice(v.as_bytes());
        }
    }
    hashv(&[&buf]).to_bytes()
}

pub fn mint_auth_message(auth: &MintAuth) -> Vec<u8> {
    let mut m = Vec::with_capacity(MINT_AUTH_PREFIX.len() + 32 + 8 + 32 + 8 + 8);
    m.extend_from_slice(MINT_AUTH_PREFIX);
    m.extend_from_slice(auth.wallet.as_ref());
    m.extend_from_slice(&auth.order_id.to_le_bytes());
    m.extend_from_slice(&auth.specs_hash);
    m.extend_from_slice(&auth.nonce.to_le_bytes());
    m.extend_from_slice(&auth.expires_at_slot.to_le_bytes());
    m
}

pub fn tree_config_pda(merkle_tree: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[merkle_tree.as_ref()], &BUBBLEGUM_V2_ID).0
}

pub fn leaf_asset_id(merkle_tree: &Pubkey, index: u32) -> Pubkey {
    Pubkey::find_program_address(
        &[b"asset", merkle_tree.as_ref(), &(index as u64).to_le_bytes()],
        &BUBBLEGUM_V2_ID,
    )
    .0
}

fn config_seeds(bump: u8) -> Vec<Vec<u8>> {
    vec![b"config".to_vec(), vec![bump]]
}

// ---------------------------------------------------------------------------
// State

#[account]
#[derive(InitSpace)]
pub struct SettleConfig {
    pub admin: Pubkey,
    pub mint_oracle: Pubkey,
    pub root_oracle: Pubkey,
    pub treasury: Pubkey,
    pub cg_mint: Pubkey,
    pub usdc_mint: Pubkey,
    pub emission_minted: u64,
    pub emission_cap: u64,
    pub market_fee_bps: u16,
    pub packs_paused: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct PackOrder {
    pub buyer: Pubkey,
    pub order_id: u64,
    pub currency: u8,
    pub amount: u64,
    pub status: u8,
    pub created_slot: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct AnchoredRoot {
    pub kind: u8,
    pub epoch: u64,
    pub root: [u8; 32],
    pub total_claimed: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct RewardClaimReceipt {
    pub bump: u8,
}

/// One-time receipt for an oracle-authorized grant mint (fusion results,
/// quest chips). The PDA existing at all is the replay protection: a grant
/// id can be minted exactly once, whoever relays it.
#[account]
#[derive(InitSpace)]
pub struct GrantReceipt {
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct EscrowListing {
    pub seller: Pubkey,
    pub asset: Pubkey,
    pub merkle_tree: Pubkey,
    /// Zero when the leaf has no MPL Core collection.
    pub core_collection: Pubkey,
    pub price: u64,
    pub bump: u8,
}

// ---------------------------------------------------------------------------
// Errors

#[error_code]
pub enum SettleError {
    #[msg("packs are paused")]
    Paused,
    #[msg("unknown currency")]
    BadCurrency,
    #[msg("amount must be positive")]
    BadAmount,
    #[msg("order is not in the paid state")]
    BadOrderStatus,
    #[msg("refund window has not opened yet")]
    RefundTooEarly,
    #[msg("ed25519 oracle instruction missing or malformed")]
    BadOracleInstruction,
    #[msg("oracle signature does not authorize this settle")]
    BadOracleSignature,
    #[msg("oracle authorization expired")]
    AuthExpired,
    #[msg("specs do not match the signed commitment")]
    SpecsMismatch,
    #[msg("emission cap reached")]
    EmissionCap,
    #[msg("too many leaves in one settle")]
    TooManySpecs,
    #[msg("merkle proof does not verify")]
    BadProof,
    #[msg("tree config does not belong to the merkle tree")]
    BadTreeConfig,
    #[msg("unexpected account")]
    BadAccount,
    #[msg("arithmetic overflow")]
    Overflow,
}

// ---------------------------------------------------------------------------
// Events

#[event]
pub struct ConfigInitialized {
    pub admin: Pubkey,
    pub mint_oracle: Pubkey,
    pub treasury: Pubkey,
}
#[event]
pub struct PackEscrowed {
    pub buyer: Pubkey,
    pub order_id: u64,
    pub currency: u8,
    pub amount: u64,
}
#[event]
pub struct PackSettled {
    pub buyer: Pubkey,
    pub order_id: u64,
    pub leaves: u8,
}
#[event]
pub struct PackRefunded {
    pub buyer: Pubkey,
    pub order_id: u64,
    pub amount: u64,
}
#[event]
pub struct RootAnchored {
    pub kind: u8,
    pub epoch: u64,
    pub root: [u8; 32],
}
#[event]
pub struct RewardClaimed {
    pub claimant: Pubkey,
    pub kind: u8,
    pub epoch: u64,
    pub amount: u64,
}
#[event]
pub struct EscrowListed {
    pub seller: Pubkey,
    pub asset: Pubkey,
    pub price: u64,
}
#[event]
pub struct EscrowSold {
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub asset: Pubkey,
    pub price: u64,
    pub fee: u64,
}
#[event]
pub struct OraclesUpdated {
    pub admin: Pubkey,
    pub mint_oracle: Pubkey,
    pub root_oracle: Pubkey,
    pub treasury: Pubkey,
}

#[event]
pub struct LimitsUpdated {
    pub admin: Pubkey,
    pub emission_cap: u64,
    pub market_fee_bps: u16,
    pub packs_paused: bool,
}

#[event]
pub struct EscrowCancelled {
    pub seller: Pubkey,
    pub asset: Pubkey,
}

// ---------------------------------------------------------------------------
// Oracle signature introspection
//
// The transaction must carry an Ed25519Program instruction immediately
// before settle_pack. The Ed25519 program itself rejects a bad signature
// (the whole transaction fails), so here we only bind the instruction to
// our oracle key and to the exact MintAuth message we expect.

fn verify_oracle_signature(instructions: &AccountInfo, oracle: &Pubkey, expected_msg: &[u8]) -> Result<()> {
    let current = load_current_index_checked(instructions)? as usize;
    require!(current >= 1, SettleError::BadOracleInstruction);
    let ix: Instruction = load_instruction_at_checked(current - 1, instructions)?;
    require!(ix.program_id == ED25519_PROGRAM_ID, SettleError::BadOracleInstruction);
    let d = &ix.data;
    // Header: num_signatures u8, padding u8, then 14-byte offset records.
    require!(d.len() >= 2 + 14 && d[0] == 1, SettleError::BadOracleInstruction);
    let u16le = |o: usize| -> u16 { u16::from_le_bytes([d[o], d[o + 1]]) };
    let sig_ix = u16le(4);
    let pk_off = u16le(6) as usize;
    let pk_ix = u16le(8);
    let msg_off = u16le(10) as usize;
    let msg_len = u16le(12) as usize;
    let msg_ix = u16le(14);
    // All parts must live inside the ed25519 instruction itself (0xffff =
    // "this instruction", the only form createEd25519Instruction emits).
    require!(sig_ix == u16::MAX && pk_ix == u16::MAX && msg_ix == u16::MAX, SettleError::BadOracleInstruction);
    require!(pk_off + 32 <= d.len() && msg_off + msg_len <= d.len(), SettleError::BadOracleInstruction);
    require!(d[pk_off..pk_off + 32] == oracle.to_bytes(), SettleError::BadOracleSignature);
    require!(&d[msg_off..msg_off + msg_len] == expected_msg, SettleError::BadOracleSignature);
    Ok(())
}

/// Merkle verification in the repo-wide reward-root convention (byte-for-byte
/// programs/staking emission.rs `verify_proof`, backend/src/merkle.ts):
///   leaf = keccak(0x00 ‖ wallet ‖ amount_le_u64 ‖ kind_u8 ‖ epoch_le_u32)
///   node = keccak(0x01 ‖ min(a, b) ‖ max(a, b))   (sorted pair)
/// epoch is u64 in this program's accounts; roots published for claims must
/// use epochs that fit the u32 leaf field (the backend builder enforces it).
pub fn reward_leaf(wallet: &Pubkey, amount: u64, kind: u8, epoch: u64) -> [u8; 32] {
    use anchor_lang::solana_program::keccak::hashv as khashv;
    khashv(&[
        &[0u8],
        wallet.as_ref(),
        &amount.to_le_bytes(),
        &[kind],
        &(epoch as u32).to_le_bytes(),
    ])
    .to_bytes()
}

pub fn verify_merkle_proof(root: &[u8; 32], leaf: [u8; 32], proof: &[[u8; 32]]) -> bool {
    use anchor_lang::solana_program::keccak::hashv as khashv;
    let mut node = leaf;
    for sibling in proof {
        let (a, b): (&[u8; 32], &[u8; 32]) = if node <= *sibling { (&node, sibling) } else { (sibling, &node) };
        node = khashv(&[&[1u8], a.as_ref(), b.as_ref()]).to_bytes();
    }
    &node == root
}

// ---------------------------------------------------------------------------
// Instruction accounts

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init, payer = admin, space = 8 + SettleConfig::INIT_SPACE,
        seeds = [b"config"], bump
    )]
    pub config: Account<'info, SettleConfig>,
    pub cg_mint: Account<'info, Mint>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        init, payer = admin,
        associated_token::mint = usdc_mint, associated_token::authority = config,
    )]
    pub escrow_usdc: Account<'info, TokenAccount>,
    #[account(
        init, payer = admin,
        associated_token::mint = cg_mint, associated_token::authority = config,
    )]
    pub escrow_cg: Account<'info, TokenAccount>,
    /// Reward funds live apart from pack escrow: a program-owned token PDA,
    /// funded deliberately before any reward root is anchored.
    #[account(
        init, payer = admin,
        token::mint = cg_mint, token::authority = config,
        seeds = [b"rewards_vault"], bump,
    )]
    pub rewards_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(order_id: u64)]
pub struct BuyPack<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, SettleConfig>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(
        init, payer = buyer, space = 8 + PackOrder::INIT_SPACE,
        seeds = [b"order", buyer.key().as_ref(), &order_id.to_le_bytes()], bump
    )]
    pub order: Account<'info, PackOrder>,
    /// Buyer's token account for SPL rails (required unless currency = SOL).
    #[account(mut)]
    pub buyer_token: Option<Account<'info, TokenAccount>>,
    /// Program escrow ATA matching the currency (required unless SOL).
    #[account(mut)]
    pub escrow_token: Option<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(order_id: u64, args: SettleArgs)]
pub struct SettlePack<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, SettleConfig>,
    #[account(
        mut,
        seeds = [b"order", order.buyer.as_ref(), &order_id.to_le_bytes()], bump = order.bump,
        constraint = order.order_id == order_id @ SettleError::BadOrderStatus,
    )]
    pub order: Account<'info, PackOrder>,
    /// The buyer — receives the leaves. Not a signer: the oracle signature
    /// plus the order PDA bind the mint to them; anyone may relay.
    /// CHECK: compared against order.buyer in the handler.
    pub buyer: UncheckedAccount<'info>,
    /// Pays this transaction's fees.
    #[account(mut)]
    pub relayer: Signer<'info>,
    /// Program PDA the tree creator delegated minting to at activation.
    /// CHECK: derived and compared in the handler (also a CPI signer).
    #[account(seeds = [b"tree_auth"], bump)]
    pub tree_auth: UncheckedAccount<'info>,
    /// CHECK: validated against the tree in the handler.
    #[account(mut)]
    pub tree_config: UncheckedAccount<'info>,
    /// CHECK: the shared phase-G tree; leaves are appended here.
    #[account(mut)]
    pub merkle_tree: UncheckedAccount<'info>,
    /// Treasury wallet for the SOL rail.
    /// CHECK: compared against config.treasury in the handler.
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    /// Escrow ATA releasing the SPL rails (required unless currency = SOL).
    #[account(mut)]
    pub escrow_token: Option<Account<'info, TokenAccount>>,
    /// Treasury ATA receiving the SPL rails (required unless currency = SOL).
    #[account(mut)]
    pub treasury_token: Option<Account<'info, TokenAccount>>,
    #[account(address = mpl_core_cpi_signer() @ SettleError::BadAccount)]
    pub mpl_core_cpi_signer: UncheckedAccount<'info>,
    #[account(address = MPL_NOOP_ID @ SettleError::BadAccount)]
    pub log_wrapper: UncheckedAccount<'info>,
    #[account(address = MPL_ACCOUNT_COMPRESSION_ID @ SettleError::BadAccount)]
    pub compression_program: UncheckedAccount<'info>,
    #[account(address = BUBBLEGUM_V2_ID @ SettleError::BadAccount)]
    pub bubblegum_program: UncheckedAccount<'info>,
    #[account(address = MPL_CORE_ID @ SettleError::BadAccount)]
    pub mpl_core_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    /// Instructions sysvar — the oracle's Ed25519 instruction is read from it.
    /// CHECK: address pinned in the handler.
    #[account(address = INSTRUCTIONS_SYSVAR_ID @ SettleError::BadAccount)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct SettleArgs {
    pub auth: MintAuth,
    pub specs: Vec<LeafSpec>,
}

#[derive(Accounts)]
#[instruction(order_id: u64)]
pub struct RefundPack<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, SettleConfig>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(
        mut, close = buyer, has_one = buyer @ SettleError::BadOrderStatus,
        seeds = [b"order", buyer.key().as_ref(), &order_id.to_le_bytes()], bump = order.bump,
    )]
    pub order: Account<'info, PackOrder>,
    /// Escrow ATA for SPL refunds (required unless currency = SOL).
    #[account(mut)]
    pub escrow_token: Option<Account<'info, TokenAccount>>,
    /// Buyer's ATA receiving the refund (required unless currency = SOL).
    #[account(mut)]
    pub buyer_token: Option<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(kind: u8, epoch: u64, root: [u8; 32])]
pub struct AnchorRoot<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, SettleConfig>,
    #[account(mut, constraint = root_oracle.key() == config.root_oracle @ SettleError::BadAccount)]
    pub root_oracle: Signer<'info>,
    #[account(
        init, payer = root_oracle, space = 8 + AnchoredRoot::INIT_SPACE,
        seeds = [b"root", &[kind], &epoch.to_le_bytes()], bump
    )]
    pub root: Account<'info, AnchoredRoot>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(kind: u8, epoch: u64)]
pub struct ClaimReward<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, SettleConfig>,
    #[account(
        mut,
        seeds = [b"root", &[kind], &epoch.to_le_bytes()], bump = root.bump,
        constraint = root.kind == kind && root.epoch == epoch @ SettleError::BadAccount,
    )]
    pub root: Account<'info, AnchoredRoot>,
    #[account(
        init, payer = claimant, space = 8 + RewardClaimReceipt::INIT_SPACE,
        seeds = [b"claim", root.key().as_ref(), claimant.key().as_ref()], bump
    )]
    pub receipt: Account<'info, RewardClaimReceipt>,
    #[account(mut)]
    pub claimant: Signer<'info>,
    #[account(
        init_if_needed, payer = claimant,
        associated_token::mint = cg_mint, associated_token::authority = claimant,
    )]
    pub claimant_cg: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"rewards_vault"], bump)]
    pub rewards_vault: Account<'info, TokenAccount>,
    #[account(address = config.cg_mint @ SettleError::BadAccount)]
    pub cg_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(asset: Pubkey, price: u64, proof: LeafProofArgs)]
pub struct EscrowList<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, SettleConfig>,
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(
        init, payer = seller, space = 8 + EscrowListing::INIT_SPACE,
        seeds = [b"listing", asset.as_ref()], bump
    )]
    pub listing: Account<'info, EscrowListing>,
    /// CHECK: validated against the tree in the handler.
    #[account(mut)]
    pub tree_config: UncheckedAccount<'info>,
    /// CHECK: the shared tree; ownership is proven by the transfer CPI itself.
    #[account(mut)]
    pub merkle_tree: UncheckedAccount<'info>,
    /// CHECK: MPL Core collection of the leaf, or the Bubblegum program id
    /// as sentinel for a collection-less leaf (mirrors the market program).
    pub core_collection: UncheckedAccount<'info>,
    #[account(address = MPL_NOOP_ID @ SettleError::BadAccount)]
    pub log_wrapper: UncheckedAccount<'info>,
    #[account(address = MPL_ACCOUNT_COMPRESSION_ID @ SettleError::BadAccount)]
    pub compression_program: UncheckedAccount<'info>,
    #[account(address = BUBBLEGUM_V2_ID @ SettleError::BadAccount)]
    pub bubblegum_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct EscrowBuy<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, SettleConfig>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(
        mut, close = seller,
        seeds = [b"listing", listing.asset.as_ref()], bump = listing.bump,
    )]
    pub listing: Account<'info, EscrowListing>,
    /// The seller receives the payment and the listing rent.
    #[account(mut, address = listing.seller @ SettleError::BadAccount)]
    pub seller: UncheckedAccount<'info>,
    /// CHECK: compared against config.treasury in the handler.
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: validated against listing.merkle_tree in the handler.
    #[account(mut)]
    pub tree_config: UncheckedAccount<'info>,
    /// CHECK: must equal listing.merkle_tree (checked in the handler).
    #[account(mut)]
    pub merkle_tree: UncheckedAccount<'info>,
    /// CHECK: MPL Core collection of the leaf, or sentinel (see EscrowList).
    pub core_collection: UncheckedAccount<'info>,
    #[account(address = MPL_NOOP_ID @ SettleError::BadAccount)]
    pub log_wrapper: UncheckedAccount<'info>,
    #[account(address = MPL_ACCOUNT_COMPRESSION_ID @ SettleError::BadAccount)]
    pub compression_program: UncheckedAccount<'info>,
    #[account(address = BUBBLEGUM_V2_ID @ SettleError::BadAccount)]
    pub bubblegum_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct EscrowCancel<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, SettleConfig>,
    #[account(mut, constraint = seller.key() == listing.seller @ SettleError::BadAccount)]
    pub seller: Signer<'info>,
    #[account(
        mut, close = seller, has_one = seller @ SettleError::BadAccount,
        seeds = [b"listing", listing.asset.as_ref()], bump = listing.bump,
    )]
    pub listing: Account<'info, EscrowListing>,
    /// CHECK: validated against listing.merkle_tree in the handler.
    #[account(mut)]
    pub tree_config: UncheckedAccount<'info>,
    /// CHECK: must equal listing.merkle_tree (checked in the handler).
    #[account(mut)]
    pub merkle_tree: UncheckedAccount<'info>,
    /// CHECK: MPL Core collection of the leaf, or sentinel (see EscrowList).
    pub core_collection: UncheckedAccount<'info>,
    #[account(address = MPL_NOOP_ID @ SettleError::BadAccount)]
    pub log_wrapper: UncheckedAccount<'info>,
    #[account(address = MPL_ACCOUNT_COMPRESSION_ID @ SettleError::BadAccount)]
    pub compression_program: UncheckedAccount<'info>,
    #[account(address = BUBBLEGUM_V2_ID @ SettleError::BadAccount)]
    pub bubblegum_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: SettleArgs)]
pub struct GrantMint<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, SettleConfig>,
    #[account(
        init, payer = relayer, space = 8 + GrantReceipt::INIT_SPACE,
        seeds = [b"grant", &args.auth.order_id.to_le_bytes()], bump
    )]
    pub receipt: Account<'info, GrantReceipt>,
    /// Grant recipient; bound by the oracle signature (auth.wallet).
    /// CHECK: compared against args.auth.wallet in the handler.
    pub buyer: UncheckedAccount<'info>,
    #[account(mut)]
    pub relayer: Signer<'info>,
    /// CHECK: derived PDA, also the mint CPI signer.
    #[account(seeds = [b"tree_auth"], bump)]
    pub tree_auth: UncheckedAccount<'info>,
    /// CHECK: validated against the tree in the handler.
    #[account(mut)]
    pub tree_config: UncheckedAccount<'info>,
    /// CHECK: the shared phase-G tree.
    #[account(mut)]
    pub merkle_tree: UncheckedAccount<'info>,
    #[account(address = mpl_core_cpi_signer() @ SettleError::BadAccount)]
    pub mpl_core_cpi_signer: UncheckedAccount<'info>,
    #[account(address = MPL_NOOP_ID @ SettleError::BadAccount)]
    pub log_wrapper: UncheckedAccount<'info>,
    #[account(address = MPL_ACCOUNT_COMPRESSION_ID @ SettleError::BadAccount)]
    pub compression_program: UncheckedAccount<'info>,
    #[account(address = BUBBLEGUM_V2_ID @ SettleError::BadAccount)]
    pub bubblegum_program: UncheckedAccount<'info>,
    #[account(address = MPL_CORE_ID @ SettleError::BadAccount)]
    pub mpl_core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: address pinned in the handler.
    #[account(address = INSTRUCTIONS_SYSVAR_ID @ SettleError::BadAccount)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Admin<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin @ SettleError::BadAccount)]
    pub config: Account<'info, SettleConfig>,
    pub admin: Signer<'info>,
}

// ---------------------------------------------------------------------------
// Handlers

pub fn init_config_handler(
    ctx: Context<InitConfig>,
    mint_oracle: Pubkey,
    root_oracle: Pubkey,
    treasury: Pubkey,
    emission_cap: u64,
    market_fee_bps: u16,
) -> Result<()> {
    let c = &mut ctx.accounts.config;
    c.admin = ctx.accounts.admin.key();
    c.mint_oracle = mint_oracle;
    c.root_oracle = root_oracle;
    c.treasury = treasury;
    c.cg_mint = ctx.accounts.cg_mint.key();
    c.usdc_mint = ctx.accounts.usdc_mint.key();
    c.emission_minted = 0;
    c.emission_cap = emission_cap;
    c.market_fee_bps = market_fee_bps;
    c.packs_paused = false;
    c.bump = ctx.bumps.config;
    emit!(ConfigInitialized { admin: c.admin, mint_oracle, treasury });
    Ok(())
}

pub fn buy_pack_handler<'info>(ctx: Context<'_, '_, '_, 'info, BuyPack<'info>>, order_id: u64, currency: u8, amount: u64) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.packs_paused, SettleError::Paused);
    require!(currency <= CURRENCY_CG, SettleError::BadCurrency);
    require!(amount > 0, SettleError::BadAmount);
    let buyer = ctx.accounts.buyer.key();
    if currency == CURRENCY_SOL {
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to: ctx.accounts.order.to_account_info(),
                },
            ),
            amount,
        )?;
    } else {
        let buyer_token = ctx.accounts.buyer_token.as_ref().ok_or(SettleError::BadAccount)?;
        let escrow_token = ctx.accounts.escrow_token.as_ref().ok_or(SettleError::BadAccount)?;
        let mint = if currency == CURRENCY_USDC { cfg.usdc_mint } else { cfg.cg_mint };
        require!(buyer_token.mint == mint && buyer_token.owner == buyer, SettleError::BadAccount);
        require!(
            escrow_token.mint == mint
                && escrow_token.key() == get_associated_token_address(&cfg.key(), &mint),
            SettleError::BadAccount
        );
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer { from: buyer_token.to_account_info(), to: escrow_token.to_account_info(), authority: ctx.accounts.buyer.to_account_info() },
            ),
            amount,
        )?;
    }
    let o = &mut ctx.accounts.order;
    o.buyer = buyer;
    o.order_id = order_id;
    o.currency = currency;
    o.amount = amount;
    o.status = STATUS_PAID;
    o.created_slot = Clock::get()?.slot;
    o.bump = ctx.bumps.order;
    emit!(PackEscrowed { buyer, order_id, currency, amount });
    Ok(())
}

pub fn settle_pack_handler<'info>(ctx: Context<'_, '_, '_, 'info, SettlePack<'info>>, order_id: u64, args: SettleArgs) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.packs_paused, SettleError::Paused);
    let order = &ctx.accounts.order;
    require!(order.status == STATUS_PAID, SettleError::BadOrderStatus);
    require!(ctx.accounts.buyer.key() == order.buyer, SettleError::BadAccount);
    require!(args.specs.len() <= MAX_SPECS && !args.specs.is_empty(), SettleError::TooManySpecs);

    // Oracle authorization binds: wallet, order, the exact leaf specs, expiry.
    let auth = &args.auth;
    require!(auth.wallet == order.buyer && auth.order_id == order_id && auth.nonce == order_id, SettleError::BadOracleSignature);
    require!(Clock::get()?.slot <= auth.expires_at_slot, SettleError::AuthExpired);
    require!(specs_hash(&args.specs) == auth.specs_hash, SettleError::SpecsMismatch);
    verify_oracle_signature(
        &ctx.accounts.instructions.to_account_info(),
        &cfg.mint_oracle,
        &mint_auth_message(auth),
    )?;

    // Tree plumbing pins (same checks as the canonical mint_v2 layout).
    require!(ctx.accounts.tree_config.key() == tree_config_pda(&ctx.accounts.merkle_tree.key()), SettleError::BadTreeConfig);
    require!(ctx.accounts.mpl_core_cpi_signer.key() == mpl_core_cpi_signer(), SettleError::BadAccount);
    require!(ctx.accounts.log_wrapper.key() == MPL_NOOP_ID, SettleError::BadAccount);
    require!(ctx.accounts.compression_program.key() == MPL_ACCOUNT_COMPRESSION_ID, SettleError::BadAccount);
    require!(ctx.accounts.bubblegum_program.key() == BUBBLEGUM_V2_ID, SettleError::BadAccount);
    require!(ctx.accounts.mpl_core_program.key() == MPL_CORE_ID, SettleError::BadAccount);
    require!(ctx.accounts.treasury.key() == cfg.treasury, SettleError::BadAccount);

    let new_emission = cfg
        .emission_minted
        .checked_add(args.specs.len() as u64)
        .ok_or(SettleError::Overflow)?;
    require!(new_emission <= cfg.emission_cap, SettleError::EmissionCap);

    // Release the escrowed payment to the treasury.
    let amount = order.amount;
    let currency = order.currency;
    let config_key = cfg.key();
    let config_bump = cfg.bump;
    match currency {
        CURRENCY_SOL => {
            **ctx.accounts.order.to_account_info().try_borrow_mut_lamports()? -= amount;
            **ctx.accounts.treasury.try_borrow_mut_lamports()? += amount;
        }
        _ => {
            let mint = if currency == CURRENCY_USDC { cfg.usdc_mint } else { cfg.cg_mint };
            let escrow_token = ctx.accounts.escrow_token.as_ref().ok_or(SettleError::BadAccount)?;
            let treasury_token = ctx.accounts.treasury_token.as_ref().ok_or(SettleError::BadAccount)?;
            require!(escrow_token.key() == get_associated_token_address(&config_key, &mint), SettleError::BadAccount);
            require_keys_eq!(escrow_token.mint, mint, SettleError::BadAccount);
            require_keys_eq!(treasury_token.mint, mint, SettleError::BadAccount);
            require_keys_eq!(treasury_token.owner, cfg.treasury, SettleError::BadAccount);
            let seeds = config_seeds(config_bump);
            let signer_seeds: Vec<&[u8]> = seeds.iter().map(|s| s.as_slice()).collect();
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer { from: escrow_token.to_account_info(), to: treasury_token.to_account_info(), authority: ctx.accounts.config.to_account_info() },
                    &[&signer_seeds],
                ),
                amount,
            )?;
        }
    }

    // Mint every leaf to the buyer. The tree_auth PDA signs as tree delegate
    // and, after activation, as collection update authority.
    mint_specs(
        &ctx.accounts.bubblegum_program.to_account_info(),
        &ctx.accounts.tree_config.to_account_info(),
        &ctx.accounts.relayer.to_account_info(),
        &ctx.accounts.tree_auth.to_account_info(),
        ctx.bumps.tree_auth,
        &ctx.accounts.buyer.to_account_info(),
        &ctx.accounts.merkle_tree.to_account_info(),
        &ctx.accounts.mpl_core_cpi_signer.to_account_info(),
        &ctx.accounts.log_wrapper.to_account_info(),
        &ctx.accounts.compression_program.to_account_info(),
        &ctx.accounts.mpl_core_program.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        &args.specs,
        ctx.remaining_accounts,
    )?;

    let cfg = &mut ctx.accounts.config;
    cfg.emission_minted = new_emission;
    let order = &mut ctx.accounts.order;
    order.status = STATUS_SETTLED;
    emit!(PackSettled { buyer: order.buyer, order_id, leaves: args.specs.len() as u8 });
    Ok(())
}

/// Mint every spec to `leaf_owner` — shared by settle_pack and grant_mint.
/// `remaining` carries the MPL Core collection accounts referenced by specs.
#[allow(clippy::too_many_arguments)]
pub fn mint_specs<'info>(
    bubblegum_program: &AccountInfo<'info>,
    tree_config: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    tree_auth: &AccountInfo<'info>,
    tree_auth_bump: u8,
    leaf_owner: &AccountInfo<'info>,
    merkle_tree: &AccountInfo<'info>,
    cpi_signer: &AccountInfo<'info>,
    log_wrapper: &AccountInfo<'info>,
    compression_program: &AccountInfo<'info>,
    mpl_core_program: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    specs: &[LeafSpec],
    remaining: &[AccountInfo<'info>],
) -> Result<()> {
    let auth_seeds: Vec<Vec<u8>> = vec![b"tree_auth".to_vec(), vec![tree_auth_bump]];
    let auth_signer: Vec<&[u8]> = auth_seeds.iter().map(|s| s.as_slice()).collect();
    for spec in specs {
        let collection_info: Option<AccountInfo<'info>> = if spec.collection == Pubkey::default() {
            None
        } else {
            let found = remaining
                .iter()
                .find(|a| a.key() == spec.collection)
                .ok_or(SettleError::BadAccount)?;
            require!(found.is_writable, SettleError::BadAccount);
            Some(found.clone())
        };
        let metadata = MetadataArgsV2 {
            name: spec.name.clone(),
            symbol: spec.symbol.clone(),
            uri: spec.uri.clone(),
            seller_fee_basis_points: ROYALTY_BPS,
            primary_sale_happened: false,
            is_mutable: false,
            token_standard: Some(TokenStandard::NonFungible),
            creators: vec![Creator { address: tree_auth.key(), verified: true, share: 100 }],
            collection: if spec.collection == Pubkey::default() { None } else { Some(spec.collection) },
        };
        let mut mint = MintV2CpiBuilder::new(bubblegum_program);
        mint.tree_config(tree_config)
            .payer(payer)
            .tree_creator_or_delegate(Some(tree_auth))
            .collection_authority(collection_info.as_ref().map(|_| tree_auth))
            .leaf_owner(leaf_owner)
            .leaf_delegate(Some(leaf_owner))
            .merkle_tree(merkle_tree)
            .core_collection(collection_info.as_ref())
            .mpl_core_cpi_signer(collection_info.as_ref().map(|_| cpi_signer))
            .log_wrapper(log_wrapper)
            .compression_program(compression_program)
            .mpl_core_program(mpl_core_program)
            .system_program(system_program)
            .metadata(metadata);
        mint.invoke_signed(&[&auth_signer])?;
    }
    Ok(())
}

pub fn grant_mint_handler<'info>(ctx: Context<'_, '_, '_, 'info, GrantMint<'info>>, args: SettleArgs) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.packs_paused, SettleError::Paused);
    require!(args.specs.len() <= MAX_SPECS && !args.specs.is_empty(), SettleError::TooManySpecs);
    let auth = &args.auth;
    require!(auth.wallet == ctx.accounts.buyer.key() && auth.nonce == auth.order_id, SettleError::BadOracleSignature);
    require!(Clock::get()?.slot <= auth.expires_at_slot, SettleError::AuthExpired);
    require!(specs_hash(&args.specs) == auth.specs_hash, SettleError::SpecsMismatch);
    verify_oracle_signature(&ctx.accounts.instructions.to_account_info(), &cfg.mint_oracle, &mint_auth_message(auth))?;
    require!(ctx.accounts.tree_config.key() == tree_config_pda(&ctx.accounts.merkle_tree.key()), SettleError::BadTreeConfig);
    require!(ctx.accounts.mpl_core_cpi_signer.key() == mpl_core_cpi_signer(), SettleError::BadAccount);
    require!(ctx.accounts.log_wrapper.key() == MPL_NOOP_ID, SettleError::BadAccount);
    require!(ctx.accounts.compression_program.key() == MPL_ACCOUNT_COMPRESSION_ID, SettleError::BadAccount);
    require!(ctx.accounts.bubblegum_program.key() == BUBBLEGUM_V2_ID, SettleError::BadAccount);
    require!(ctx.accounts.mpl_core_program.key() == MPL_CORE_ID, SettleError::BadAccount);
    let new_emission = cfg.emission_minted.checked_add(args.specs.len() as u64).ok_or(SettleError::Overflow)?;
    require!(new_emission <= cfg.emission_cap, SettleError::EmissionCap);
    mint_specs(
        &ctx.accounts.bubblegum_program.to_account_info(),
        &ctx.accounts.tree_config.to_account_info(),
        &ctx.accounts.relayer.to_account_info(),
        &ctx.accounts.tree_auth.to_account_info(),
        ctx.bumps.tree_auth,
        &ctx.accounts.buyer.to_account_info(),
        &ctx.accounts.merkle_tree.to_account_info(),
        &ctx.accounts.mpl_core_cpi_signer.to_account_info(),
        &ctx.accounts.log_wrapper.to_account_info(),
        &ctx.accounts.compression_program.to_account_info(),
        &ctx.accounts.mpl_core_program.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        &args.specs,
        ctx.remaining_accounts,
    )?;
    ctx.accounts.config.emission_minted = new_emission;
    ctx.accounts.receipt.bump = ctx.bumps.receipt;
    emit!(PackSettled { buyer: auth.wallet, order_id: auth.order_id, leaves: args.specs.len() as u8 });
    Ok(())
}

pub fn refund_pack_handler<'info>(ctx: Context<'_, '_, '_, 'info, RefundPack<'info>>, order_id: u64) -> Result<()> {
    let order = &ctx.accounts.order;
    require!(order.status == STATUS_PAID, SettleError::BadOrderStatus);
    require!(
        Clock::get()?.slot >= order.created_slot.saturating_add(REFUND_AFTER_SLOTS),
        SettleError::RefundTooEarly
    );
    let amount = order.amount;
    match order.currency {
        CURRENCY_SOL => {
            **ctx.accounts.order.to_account_info().try_borrow_mut_lamports()? -= amount;
            **ctx.accounts.buyer.to_account_info().try_borrow_mut_lamports()? += amount;
        }
        _ => {
            let cfg = &ctx.accounts.config;
            let mint = if order.currency == CURRENCY_USDC { cfg.usdc_mint } else { cfg.cg_mint };
            let escrow_token = ctx.accounts.escrow_token.as_ref().ok_or(SettleError::BadAccount)?;
            let buyer_token = ctx.accounts.buyer_token.as_ref().ok_or(SettleError::BadAccount)?;
            require!(escrow_token.key() == get_associated_token_address(&cfg.key(), &mint), SettleError::BadAccount);
            require_keys_eq!(escrow_token.mint, mint, SettleError::BadAccount);
            require_keys_eq!(buyer_token.mint, mint, SettleError::BadAccount);
            require_keys_eq!(buyer_token.owner, ctx.accounts.buyer.key(), SettleError::BadAccount);
            let seeds = config_seeds(cfg.bump);
            let signer_seeds: Vec<&[u8]> = seeds.iter().map(|s| s.as_slice()).collect();
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer { from: escrow_token.to_account_info(), to: buyer_token.to_account_info(), authority: ctx.accounts.config.to_account_info() },
                    &[&signer_seeds],
                ),
                amount,
            )?;
        }
    }
    ctx.accounts.order.status = STATUS_REFUNDED;
    emit!(PackRefunded { buyer: ctx.accounts.buyer.key(), order_id, amount });
    Ok(())
}

pub fn anchor_root_handler(ctx: Context<AnchorRoot>, kind: u8, epoch: u64, root: [u8; 32]) -> Result<()> {
    let r = &mut ctx.accounts.root;
    r.kind = kind;
    r.epoch = epoch;
    r.root = root;
    r.total_claimed = 0;
    r.bump = ctx.bumps.root;
    emit!(RootAnchored { kind, epoch, root });
    Ok(())
}

pub fn claim_reward_handler<'info>(ctx: Context<'_, '_, '_, 'info, ClaimReward<'info>>, kind: u8, epoch: u64, amount: u64, proof: Vec<[u8; 32]>) -> Result<()> {
    require!(amount > 0, SettleError::BadAmount);
    let claimant = ctx.accounts.claimant.key();
    // A6: the init_if_needed ATA is adopted only as the claimant's own $CG
    // account — an uninitialised or foreign account at this address is refused.
    let claimant_cg = &ctx.accounts.claimant_cg;
    require!(claimant_cg.owner == claimant || claimant_cg.owner == Pubkey::default(), SettleError::BadAccount);
    require_keys_eq!(claimant_cg.owner, claimant, SettleError::BadAccount);
    require_keys_eq!(claimant_cg.mint, ctx.accounts.config.cg_mint, SettleError::BadAccount);
    require_keys_eq!(ctx.accounts.rewards_vault.mint, ctx.accounts.config.cg_mint, SettleError::BadAccount);
    let leaf = reward_leaf(&claimant, amount, kind, epoch);
    require!(verify_merkle_proof(&ctx.accounts.root.root, leaf, &proof), SettleError::BadProof);
    let seeds = config_seeds(ctx.accounts.config.bump);
    let signer_seeds: Vec<&[u8]> = seeds.iter().map(|s| s.as_slice()).collect();
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.rewards_vault.to_account_info(),
                to: ctx.accounts.claimant_cg.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            &[&signer_seeds],
        ),
        amount,
    )?;
    ctx.accounts.root.total_claimed = ctx
        .accounts
        .root
        .total_claimed
        .checked_add(amount)
        .ok_or(SettleError::Overflow)?;
    ctx.accounts.receipt.bump = ctx.bumps.receipt;
    emit!(RewardClaimed { claimant, kind, epoch, amount });
    Ok(())
}

fn transfer_leaf<'info>(
    ctx_accounts: (
        &AccountInfo<'info>, // bubblegum_program
        &AccountInfo<'info>, // tree_config
        &AccountInfo<'info>, // payer
        &AccountInfo<'info>, // authority
        &AccountInfo<'info>, // leaf_owner
        &AccountInfo<'info>, // new_leaf_owner
        &AccountInfo<'info>, // merkle_tree
        &AccountInfo<'info>, // core_collection
        &AccountInfo<'info>, // log_wrapper
        &AccountInfo<'info>, // compression_program
        &AccountInfo<'info>, // system_program
    ),
    collection: Pubkey,
    proof: &LeafProofArgs,
    proof_accounts: &[AccountInfo<'info>],
    signer_seeds: Option<&[&[u8]]>,
) -> Result<()> {
    let (bg, tree_config, payer, authority, leaf_owner, new_leaf_owner, merkle_tree, core_collection, log_wrapper, compression_program, system_program) = ctx_accounts;
    let mut transfer = TransferV2CpiBuilder::new(bg);
    transfer
        .tree_config(tree_config)
        .payer(payer)
        .authority(Some(authority))
        .leaf_owner(leaf_owner)
        .leaf_delegate(Some(leaf_owner))
        .new_leaf_owner(new_leaf_owner)
        .merkle_tree(merkle_tree)
        .core_collection(if collection == Pubkey::default() { None } else { Some(core_collection) })
        .log_wrapper(log_wrapper)
        .compression_program(compression_program)
        .system_program(system_program)
        .root(proof.root)
        .data_hash(proof.data_hash)
        .creator_hash(proof.creator_hash)
        .asset_data_hash(proof.asset_data_hash)
        .flags(proof.flags)
        .nonce(proof.nonce)
        .index(proof.index);
    let metas: Vec<(&AccountInfo<'info>, bool, bool)> =
        proof_accounts.iter().map(|a| (a, false, false)).collect();
    transfer.add_remaining_accounts(&metas);
    match signer_seeds {
        Some(seeds) => transfer.invoke_signed(&[seeds]),
        None => transfer.invoke(),
    }
}

fn require_tree_plumbing(tree_config: &Pubkey, merkle_tree: &Pubkey, log_wrapper: &Pubkey, compression: &Pubkey, bubblegum: &Pubkey) -> Result<()> {
    require!(*tree_config == tree_config_pda(merkle_tree), SettleError::BadTreeConfig);
    require!(*log_wrapper == MPL_NOOP_ID, SettleError::BadAccount);
    require!(*compression == MPL_ACCOUNT_COMPRESSION_ID, SettleError::BadAccount);
    require!(*bubblegum == BUBBLEGUM_V2_ID, SettleError::BadAccount);
    Ok(())
}

pub fn escrow_list_handler<'info>(ctx: Context<'_, '_, '_, 'info, EscrowList<'info>>, asset: Pubkey, price: u64, proof: LeafProofArgs) -> Result<()> {
    require!(price > 0, SettleError::BadAmount);
    require_tree_plumbing(
        &ctx.accounts.tree_config.key(),
        &ctx.accounts.merkle_tree.key(),
        &ctx.accounts.log_wrapper.key(),
        &ctx.accounts.compression_program.key(),
        &ctx.accounts.bubblegum_program.key(),
    )?;
    require!(leaf_asset_id(&ctx.accounts.merkle_tree.key(), proof.index) == asset, SettleError::BadAccount);
    let collection = if ctx.accounts.core_collection.key() == BUBBLEGUM_V2_ID {
        Pubkey::default()
    } else {
        ctx.accounts.core_collection.key()
    };
    let seller = ctx.accounts.seller.to_account_info();
    transfer_leaf(
        (
            &ctx.accounts.bubblegum_program.to_account_info(),
            &ctx.accounts.tree_config.to_account_info(),
            &seller,
            &seller,
            &seller,
            &ctx.accounts.listing.to_account_info(),
            &ctx.accounts.merkle_tree.to_account_info(),
            &ctx.accounts.core_collection.to_account_info(),
            &ctx.accounts.log_wrapper.to_account_info(),
            &ctx.accounts.compression_program.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
        ),
        collection,
        &proof,
        ctx.remaining_accounts,
        None,
    )?;
    let l = &mut ctx.accounts.listing;
    l.seller = ctx.accounts.seller.key();
    l.asset = asset;
    l.merkle_tree = ctx.accounts.merkle_tree.key();
    l.core_collection = collection;
    l.price = price;
    l.bump = ctx.bumps.listing;
    emit!(EscrowListed { seller: l.seller, asset, price });
    Ok(())
}

pub fn escrow_buy_handler<'info>(ctx: Context<'_, '_, '_, 'info, EscrowBuy<'info>>, proof: LeafProofArgs) -> Result<()> {
    let listing = &ctx.accounts.listing;
    require!(ctx.accounts.seller.key() == listing.seller, SettleError::BadAccount);
    require!(ctx.accounts.treasury.key() == ctx.accounts.config.treasury, SettleError::BadAccount);
    require!(ctx.accounts.merkle_tree.key() == listing.merkle_tree, SettleError::BadAccount);
    require_tree_plumbing(
        &ctx.accounts.tree_config.key(),
        &ctx.accounts.merkle_tree.key(),
        &ctx.accounts.log_wrapper.key(),
        &ctx.accounts.compression_program.key(),
        &ctx.accounts.bubblegum_program.key(),
    )?;
    let price = listing.price;
    let fee = (price as u128 * ctx.accounts.config.market_fee_bps as u128 / 10_000) as u64;
    let seller_amount = price.checked_sub(fee).ok_or(SettleError::Overflow)?;
    let buyer = ctx.accounts.buyer.to_account_info();
    let system = ctx.accounts.system_program.to_account_info();
    if seller_amount > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new(system.clone(), anchor_lang::system_program::Transfer { from: buyer.clone(), to: ctx.accounts.seller.to_account_info() }),
            seller_amount,
        )?;
    }
    if fee > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new(system, anchor_lang::system_program::Transfer { from: buyer.clone(), to: ctx.accounts.treasury.to_account_info() }),
            fee,
        )?;
    }
    let asset = listing.asset;
    let seeds: Vec<Vec<u8>> = vec![b"listing".to_vec(), asset.to_bytes().to_vec(), vec![listing.bump]];
    let signer: Vec<&[u8]> = seeds.iter().map(|s| s.as_slice()).collect();
    let listing_info = ctx.accounts.listing.to_account_info();
    transfer_leaf(
        (
            &ctx.accounts.bubblegum_program.to_account_info(),
            &ctx.accounts.tree_config.to_account_info(),
            &buyer,
            &listing_info,
            &listing_info,
            &buyer,
            &ctx.accounts.merkle_tree.to_account_info(),
            &ctx.accounts.core_collection.to_account_info(),
            &ctx.accounts.log_wrapper.to_account_info(),
            &ctx.accounts.compression_program.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
        ),
        listing.core_collection,
        &proof,
        ctx.remaining_accounts,
        Some(&signer),
    )?;
    emit!(EscrowSold { seller: listing.seller, buyer: ctx.accounts.buyer.key(), asset, price, fee });
    Ok(())
}

pub fn escrow_cancel_handler<'info>(ctx: Context<'_, '_, '_, 'info, EscrowCancel<'info>>, proof: LeafProofArgs) -> Result<()> {
    let listing = &ctx.accounts.listing;
    require!(ctx.accounts.merkle_tree.key() == listing.merkle_tree, SettleError::BadAccount);
    require_tree_plumbing(
        &ctx.accounts.tree_config.key(),
        &ctx.accounts.merkle_tree.key(),
        &ctx.accounts.log_wrapper.key(),
        &ctx.accounts.compression_program.key(),
        &ctx.accounts.bubblegum_program.key(),
    )?;
    let asset = listing.asset;
    let seeds: Vec<Vec<u8>> = vec![b"listing".to_vec(), asset.to_bytes().to_vec(), vec![listing.bump]];
    let signer: Vec<&[u8]> = seeds.iter().map(|s| s.as_slice()).collect();
    let listing_info = ctx.accounts.listing.to_account_info();
    let seller = ctx.accounts.seller.to_account_info();
    transfer_leaf(
        (
            &ctx.accounts.bubblegum_program.to_account_info(),
            &ctx.accounts.tree_config.to_account_info(),
            &seller,
            &listing_info,
            &listing_info,
            &seller,
            &ctx.accounts.merkle_tree.to_account_info(),
            &ctx.accounts.core_collection.to_account_info(),
            &ctx.accounts.log_wrapper.to_account_info(),
            &ctx.accounts.compression_program.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
        ),
        listing.core_collection,
        &proof,
        ctx.remaining_accounts,
        Some(&signer),
    )?;
    emit!(EscrowCancelled { seller: ctx.accounts.seller.key(), asset });
    Ok(())
}

pub fn set_oracles_handler(
    ctx: Context<Admin>,
    mint_oracle: Option<Pubkey>,
    root_oracle: Option<Pubkey>,
    treasury: Option<Pubkey>,
    new_admin: Option<Pubkey>,
) -> Result<()> {
    let c = &mut ctx.accounts.config;
    if let Some(v) = mint_oracle { c.mint_oracle = v; }
    if let Some(v) = root_oracle { c.root_oracle = v; }
    if let Some(v) = treasury { c.treasury = v; }
    if let Some(v) = new_admin { c.admin = v; }
    emit!(OraclesUpdated { admin: c.admin, mint_oracle: c.mint_oracle, root_oracle: c.root_oracle, treasury: c.treasury });
    Ok(())
}

pub fn set_limits_handler(
    ctx: Context<Admin>,
    emission_cap: Option<u64>,
    market_fee_bps: Option<u16>,
    packs_paused: Option<bool>,
) -> Result<()> {
    let c = &mut ctx.accounts.config;
    if let Some(v) = emission_cap { c.emission_cap = v; }
    if let Some(v) = market_fee_bps {
        require!(v <= 1_000, SettleError::BadAmount);
        c.market_fee_bps = v;
    }
    if let Some(v) = packs_paused { c.packs_paused = v; }
    emit!(LimitsUpdated { admin: c.admin, emission_cap: c.emission_cap, market_fee_bps: c.market_fee_bps, packs_paused: c.packs_paused });
    Ok(())
}

// ---------------------------------------------------------------------------
// Program

#[program]
pub mod settle {
    use super::*;

    pub fn init_config(
        ctx: Context<InitConfig>,
        mint_oracle: Pubkey,
        root_oracle: Pubkey,
        treasury: Pubkey,
        emission_cap: u64,
        market_fee_bps: u16,
    ) -> Result<()> {
        init_config_handler(ctx, mint_oracle, root_oracle, treasury, emission_cap, market_fee_bps)
    }

    pub fn escrow_buy_pack(ctx: Context<BuyPack>, order_id: u64, currency: u8, amount: u64) -> Result<()> {
        buy_pack_handler(ctx, order_id, currency, amount)
    }

    pub fn settle_pack(ctx: Context<SettlePack>, order_id: u64, args: SettleArgs) -> Result<()> {
        settle_pack_handler(ctx, order_id, args)
    }

    pub fn grant_mint(ctx: Context<GrantMint>, args: SettleArgs) -> Result<()> {
        grant_mint_handler(ctx, args)
    }

    pub fn refund_pack(ctx: Context<RefundPack>, order_id: u64) -> Result<()> {
        refund_pack_handler(ctx, order_id)
    }

    pub fn anchor_root(ctx: Context<AnchorRoot>, kind: u8, epoch: u64, root: [u8; 32]) -> Result<()> {
        anchor_root_handler(ctx, kind, epoch, root)
    }

    pub fn claim_reward(ctx: Context<ClaimReward>, kind: u8, epoch: u64, amount: u64, proof: Vec<[u8; 32]>) -> Result<()> {
        claim_reward_handler(ctx, kind, epoch, amount, proof)
    }

    pub fn escrow_list(ctx: Context<EscrowList>, asset: Pubkey, price: u64, proof: LeafProofArgs) -> Result<()> {
        escrow_list_handler(ctx, asset, price, proof)
    }

    pub fn escrow_buy(ctx: Context<EscrowBuy>, proof: LeafProofArgs) -> Result<()> {
        escrow_buy_handler(ctx, proof)
    }

    pub fn escrow_cancel(ctx: Context<EscrowCancel>, proof: LeafProofArgs) -> Result<()> {
        escrow_cancel_handler(ctx, proof)
    }

    pub fn set_mint_oracles(
        ctx: Context<Admin>,
        mint_oracle: Option<Pubkey>,
        root_oracle: Option<Pubkey>,
        treasury: Option<Pubkey>,
        new_admin: Option<Pubkey>,
    ) -> Result<()> {
        set_oracles_handler(ctx, mint_oracle, root_oracle, treasury, new_admin)
    }

    pub fn set_limits(
        ctx: Context<Admin>,
        emission_cap: Option<u64>,
        market_fee_bps: Option<u16>,
        packs_paused: Option<bool>,
    ) -> Result<()> {
        set_limits_handler(ctx, emission_cap, market_fee_bps, packs_paused)
    }
}
