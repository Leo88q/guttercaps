//! Bubblegum V2 proof primitives shared by chip_core instructions.
//!
//! The tree itself remains owned by MPL Account Compression. Every V2 leaf
//! write must go through Bubblegum and every registration/ownership read must
//! first prove the leaf against the current tree root.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction},
    program::invoke,
};

use crate::{errors::ChipError, BUBBLEGUM_V2_ID};

/// MPL Account Compression fork used by Bubblegum V2.
pub const MPL_ACCOUNT_COMPRESSION_ID: Pubkey =
    pubkey!("mcmt6YrQEMKw8Mw43FmpRLmf7BqRnFMKmAcbxE3xkAW");
/// MPL Noop log wrapper used by Bubblegum leaf writes.
pub const MPL_NOOP_ID: Pubkey = pubkey!("mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3");

/// The arguments shared by Bubblegum V2 leaf-replacing instructions and DAS
/// proof transport. `collection_hash`, `asset_data_hash`, and `flags` are
/// mandatory for the V2 leaf hash even though some Bubblegum instructions use
/// optional arguments when reconstructing the replacement leaf.
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

impl LeafProofArgs {
    pub fn validate_coordinates(&self, stored_nonce: u64, stored_index: u32) -> Result<()> {
        require!(self.nonce == stored_nonce, ChipError::InvalidBubblegumProof);
        require!(self.index == stored_index, ChipError::InvalidBubblegumProof);
        Ok(())
    }
}

/// Bubblegum V2 derives TreeConfigV2 from the Merkle tree address. Keeping this
/// derivation on chain prevents a client from pairing a valid proof with a
/// foreign config account.
pub fn tree_config_pda(merkle_tree: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[merkle_tree.as_ref()], &BUBBLEGUM_V2_ID).0
}

/// Leaf Asset ID PDA used by Bubblegum/DAS for a tree leaf (`mpl_bubblegum::utils::get_asset_id`).
pub fn leaf_asset_id(merkle_tree: &Pubkey, index: u32) -> Pubkey {
    Pubkey::find_program_address(
        &[b"asset", merkle_tree.as_ref(), &(index as u64).to_le_bytes()],
        &BUBBLEGUM_V2_ID,
    )
    .0
}

/// Bubblegum's signer PDA used when it invokes MPL Core for V2 collection
/// verification. It is a Bubblegum-owned signer, not a project authority.
pub fn mpl_core_cpi_signer() -> Pubkey {
    Pubkey::find_program_address(&[b"mpl_core_cpi_signer"], &BUBBLEGUM_V2_ID).0
}

pub fn require_bubblegum_program(program: &AccountInfo<'_>) -> Result<()> {
    // `mpl_bubblegum::ID` is the SDK's canonical constant. The project-level
    // constant is checked as well so a future dependency upgrade cannot silently
    // point CPI at a different program.
    require_keys_eq!(
        mpl_bubblegum::ID,
        BUBBLEGUM_V2_ID,
        ChipError::InvalidBubblegumTree
    );
    require_keys_eq!(
        *program.key,
        BUBBLEGUM_V2_ID,
        ChipError::InvalidBubblegumTree
    );
    Ok(())
}

/// Reconstruct the exact V2 leaf node used by Bubblegum. This deliberately
/// calls the SDK implementation rather than duplicating the version byte and
/// keccak field ordering in application code.
pub fn leaf_hash_v2(
    asset_id: Pubkey,
    owner: Pubkey,
    delegate: Pubkey,
    args: &LeafProofArgs,
) -> [u8; 32] {
    mpl_bubblegum::types::LeafSchema::V2 {
        id: asset_id,
        owner,
        delegate,
        nonce: args.nonce,
        data_hash: args.data_hash,
        creator_hash: args.creator_hash,
        collection_hash: args.collection_hash,
        asset_data_hash: args.asset_data_hash,
        flags: args.flags,
    }
    .hash()
}

/// CPI into MPL Account Compression's read-only `verify_leaf` instruction.
/// Bubblegum uses the same verifier for V2 leaf mutations; registration uses it
/// directly so a DAS response cannot create a ChipState without a live proof.
pub fn verify_leaf<'info>(
    compression_program: &AccountInfo<'info>,
    merkle_tree: &AccountInfo<'info>,
    root: [u8; 32],
    leaf: [u8; 32],
    index: u32,
    proof: &[AccountInfo<'info>],
) -> Result<()> {
    require_keys_eq!(
        *compression_program.key,
        MPL_ACCOUNT_COMPRESSION_ID,
        ChipError::InvalidBubblegumTree
    );
    require!(
        merkle_tree.owner == &MPL_ACCOUNT_COMPRESSION_ID,
        ChipError::InvalidBubblegumTree
    );
    require!(proof.len() <= 30, ChipError::InvalidBubblegumProof);
    for node in proof {
        require!(!node.is_writable, ChipError::InvalidBubblegumProof);
    }

    // Anchor's instruction discriminator is sha256("global:verify_leaf")[..8].
    // VerifyLeaf has exactly root, leaf, index as Borsh arguments after it.
    let discriminator = anchor_lang::solana_program::hash::hash(b"global:verify_leaf");
    let mut data = Vec::with_capacity(8 + 32 + 32 + 4);
    data.extend_from_slice(&discriminator.to_bytes()[..8]);
    data.extend_from_slice(&root);
    data.extend_from_slice(&leaf);
    data.extend_from_slice(&index.to_le_bytes());

    let mut accounts = Vec::with_capacity(1 + proof.len());
    accounts.push(AccountMeta::new_readonly(*merkle_tree.key, false));
    accounts.extend(
        proof
            .iter()
            .map(|node| AccountMeta::new_readonly(*node.key, false)),
    );
    let ix = Instruction {
        program_id: MPL_ACCOUNT_COMPRESSION_ID,
        accounts,
        data,
    };
    let mut infos = Vec::with_capacity(1 + proof.len());
    infos.push(merkle_tree.clone());
    infos.extend(proof.iter().cloned());
    // The runtime needs the executable program account in the AccountInfo
    // slice even though it is not an instruction AccountMeta.
    infos.push(compression_program.clone());
    invoke(&ix, &infos).map_err(Into::into)
}

pub fn verify_v2_leaf<'info>(
    compression_program: &AccountInfo<'info>,
    merkle_tree: &AccountInfo<'info>,
    asset_id: Pubkey,
    owner: Pubkey,
    delegate: Pubkey,
    args: &LeafProofArgs,
    proof: &[AccountInfo<'info>],
) -> Result<()> {
    let leaf = leaf_hash_v2(asset_id, owner, delegate, args);
    verify_leaf(
        compression_program,
        merkle_tree,
        args.root,
        leaf,
        args.index,
        proof,
    )
}
