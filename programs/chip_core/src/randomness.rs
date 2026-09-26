//! Commit-reveal guards **and** the Switchboard On-Demand CPIs shared by packs,
//! fusions and (through the `cpi` crate feature) the arena, so the three flows
//! can never drift apart.
//!
//! Threat model (docs/06 SEC-C1…C3):
//!  * **C1 owner check** — `RandomnessAccountData::parse` only validates the
//!    8-byte discriminator and the size; without `owner == Switchboard` anyone
//!    could pass a look-alike account carrying a chosen `value`. Every read in
//!    every program goes through [`parse_checked`].
//!  * **C2 persisted value** — `get_value(slot)` is `Ok` only in the reveal slot
//!    itself, so a 25-pack bundle opened over many slots could never finish.
//!    Settlement reads [`revealed_value`] once and the caller stores the bytes
//!    in its pending account; later packs never touch the oracle account.
//!  * **C3 no free re-rolls** — (part 1) a refund is only possible after the
//!    oracle's reveal window has expired (`STALE_PACK_SLOTS`) *and* the account
//!    was never revealed. (part 2) the randomness account belongs to the
//!    **program**, not the player: it is a PDA `["rng", kind, owner, nonce]`
//!    created by `init_randomness` with `authority = ["rng_auth"]`, committed
//!    by CPI *inside* the paid action ([`commit_owned`]) and revealed by the
//!    permissionless `reveal_randomness` ([`reveal_owned`], CPI with the PDA
//!    signature). Switchboard requires the authority's signature on
//!    `randomness_init` / `randomness_commit` / `randomness_reveal` /
//!    `randomness_close` (IDL: `authority: signer`), so once the authority is a
//!    PDA the player can neither re-commit (move `seed_slot`) nor veto the
//!    reveal after peeking at the value through the oracle gateway — anyone,
//!    in practice our crank, can land the reveal before the refund window.
//!
//! Switchboard's Rust crate (0.13.0) only ships a `randomness_commit` CPI
//! helper, so these instructions are built by hand from the program IDL
//! (`sb_on_demand`, discriminators = `sha256("global:<name>")[..8]`, pinned
//! by `tests::discriminators_match_anchor_convention`).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::system_program;
use switchboard_on_demand::accounts::RandomnessAccountData;

use crate::economy::STALE_PACK_SLOTS;
use crate::errors::ChipError;

/// Switchboard On-Demand program that must OWN every randomness account we read.
/// The id differs per cluster, hence the cargo features
/// (`anchor build -- --features devnet` / `--features localnet`; mainnet is the default).
#[cfg(feature = "localnet")]
pub const SB_PROGRAM_ID: Pubkey = pubkey!("ApDh35vcLCxXc5ivaRGFhayn1HduJ9b2nXbfR6WMpVKH"); // programs/sb_mock (tests/localnet/fixtures/sb_mock-keypair.json)
#[cfg(all(feature = "devnet", not(feature = "localnet")))]
pub const SB_PROGRAM_ID: Pubkey = pubkey!("Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2");
#[cfg(not(any(feature = "devnet", feature = "localnet")))]
pub const SB_PROGRAM_ID: Pubkey = pubkey!("SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv");

/// The ONE oracle queue we accept, pinned per cluster (an attacker-controlled queue could
/// otherwise front its own "oracle"). Mirrors `client/src/chain/ids.ts::SWITCHBOARD_QUEUE`.
#[cfg(feature = "localnet")]
pub const SB_QUEUE: Pubkey = pubkey!("EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7"); // sb_mock ignores the queue; any key works
#[cfg(all(feature = "devnet", not(feature = "localnet")))]
pub const SB_QUEUE: Pubkey = pubkey!("EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7");
#[cfg(not(any(feature = "devnet", feature = "localnet")))]
pub const SB_QUEUE: Pubkey = pubkey!("A43DyUGA7s8eXPxqEjJY6EBu1KKbNgfxF8h17VAHn13w");

/// PDA that is the Switchboard `authority` of every randomness account a program uses
/// (one per program: chip_core and arena each derive their own).
pub const RNG_AUTH_SEED: &[u8] = b"rng_auth";
/// Randomness accounts are PDAs `["rng", kind, owner, nonce]` of the program that will commit
/// them, so an account is bound to exactly one purchase / fusion / battle of `owner` and can
/// neither be hijacked by a third party nor reused.
pub const RNG_SEED: &[u8] = b"rng";
pub const RNG_KIND_PACK: u8 = 0;
pub const RNG_KIND_FUSION: u8 = 1;
pub const RNG_KIND_BATTLE: u8 = 2;
/// Randomized fusion of compressed claims (`fuse_claims_commit`): a separate
/// kind from Core `fuse` so the two pending PDAs (`["fusion", …]` vs
/// `["claim_fusion", …]`) and crank job keys can never collide on one nonce.
pub const RNG_KIND_CLAIM_FUSION: u8 = 3;

pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
pub const SLOT_HASHES_ID: Pubkey = pubkey!("SysvarS1otHashes111111111111111111111111111");
pub const ADDRESS_LOOKUP_TABLE_PROGRAM_ID: Pubkey =
    pubkey!("AddressLookupTab1e1111111111111111111111111");

/// Who must OWN a lookup table before we hand it to Switchboard to close (backlog #23). Same id as
/// above everywhere a real ALT program exists; under `--features localnet` the sb_mock stands in for
/// it, exactly as it stands in for Switchboard itself: the harness cannot deploy the ALT program, and
/// a program that does not own an account may neither debit its lamports nor reassign it, so the
/// "close the table and pay the player" step has to be performed by the account's owner. Test-only:
/// the id is only overridden when the localnet feature is on, and `tests/security/rent-lut.test.ts`
/// fails if the check disappears.
#[cfg(feature = "localnet")]
pub const LUT_OWNER_PROGRAM_ID: Pubkey = SB_PROGRAM_ID;
#[cfg(not(feature = "localnet"))]
pub const LUT_OWNER_PROGRAM_ID: Pubkey = ADDRESS_LOOKUP_TABLE_PROGRAM_ID;

/// `sha256("global:randomness_init")[..8]` — params `{ recent_slot: u64 }`.
pub const SB_IX_RANDOMNESS_INIT: [u8; 8] = [9, 9, 204, 33, 50, 116, 113, 15];
/// `sha256("global:randomness_commit")[..8]` — no params.
pub const SB_IX_RANDOMNESS_COMMIT: [u8; 8] = [52, 170, 152, 201, 179, 133, 242, 141];
/// `sha256("global:randomness_reveal")[..8]` — params `{ signature: [u8; 64], recovery_id: u8, value: [u8; 32] }`.
pub const SB_IX_RANDOMNESS_REVEAL: [u8; 8] = [197, 181, 187, 10, 30, 58, 20, 73];
/// `sha256("global:randomness_close")[..8]` — no params; rent (account + wSOL escrow) goes to `authority`.
pub const SB_IX_RANDOMNESS_CLOSE: [u8; 8] = [146, 101, 14, 74, 225, 246, 0, 156];
/// `sha256("global:randomness_close_lut")[..8]` — params `{ lut_slot: u64 }`; closes the lookup table
/// of a closed randomness account and pays its rent to `recipient` (backlog #23).
///
/// Account order and the `lut_slot` param are mirrored from the Switchboard On-Demand client we
/// vendor (`node_modules/@switchboard-xyz/on-demand` → `Randomness.closeLutIx` /
/// `utils/lookupTable.ts`): `randomness` (signer — the calling program signs its `["rng", …]` PDA),
/// `lut`, `lut_signer`, `recipient`, `address_lookup_table_program`. The SDK builds it "without
/// loading randomness data", i.e. after `randomness_close` has already removed the account — which
/// is exactly when the ALT cooldown starts and this becomes callable.
pub const SB_IX_RANDOMNESS_CLOSE_LUT: [u8; 8] = [234, 5, 133, 204, 55, 37, 85, 222];
/// `["LutSigner", randomness]` under Switchboard: authority of the randomness' lookup table.
pub const SB_LUT_SIGNER_SEED: &[u8] = b"LutSigner";

/// The lookup-table signer PDA of `randomness` (Switchboard's own PDA — Switchboard signs for it
/// inside `randomness_close_lut`; we only derive it to pin the account the caller passed).
pub fn lut_signer_of(randomness: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[SB_LUT_SIGNER_SEED, randomness.as_ref()], &SB_PROGRAM_ID).0
}

/// `AddressLookupTableProgram.createLookupTable({ authority: lut_signer, recentSlot: lut_slot })`
/// — the ALT address is `[authority, recent_slot]` of the ALT program, and `lut_slot` is what
/// Switchboard stored in the randomness account at init.
pub fn lut_of(lut_signer: &Pubkey, lut_slot: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[lut_signer.as_ref(), &lut_slot.to_le_bytes()],
        &ADDRESS_LOOKUP_TABLE_PROGRAM_ID,
    )
    .0
}

/// Snapshot of the fields we act on (copied out so callers don't hold a `Ref` across CPIs).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Randomness {
    pub authority: Pubkey,
    pub seed_slot: u64,
    pub reveal_slot: u64,
    pub value: [u8; 32],
}

/// Parse + owner check (SEC-C1). Returns `RandomnessMismatch` for a foreign owner or a
/// malformed account.
pub fn parse_checked(ai: &AccountInfo<'_>) -> Result<Randomness> {
    require_keys_eq!(*ai.owner, SB_PROGRAM_ID, ChipError::RandomnessMismatch);
    let rnd = RandomnessAccountData::parse(ai.data.borrow())
        .map_err(|_| error!(ChipError::RandomnessMismatch))?;
    Ok(Randomness {
        authority: rnd.authority,
        seed_slot: rnd.seed_slot,
        reveal_slot: rnd.reveal_slot,
        value: rnd.value,
    })
}

/// COMMIT-time rule: committed in the *previous* slot (seed slothash unknown to everyone) and
/// never revealed. A recycled account (`reveal_slot > 0`) is rejected outright —
/// `get_value(slot).is_err()` is NOT a substitute: it is also true for accounts revealed in an
/// earlier slot, i.e. for a value the buyer already knows.
pub fn assert_fresh_commit(rnd: &Randomness, clock_slot: u64) -> Result<()> {
    require!(
        rnd.seed_slot == clock_slot.saturating_sub(1),
        ChipError::RandomnessExpired
    );
    require!(rnd.reveal_slot == 0, ChipError::RandomnessAlreadyRevealed);
    Ok(())
}

/// SETTLE-time rule: pinned to the commit we paid for and revealed (in any slot). The caller
/// persists the bytes and never reads the oracle account again (SEC-C2).
pub fn revealed_value(rnd: &Randomness, commit_slot: u64) -> Result<[u8; 32]> {
    require!(rnd.seed_slot == commit_slot, ChipError::RandomnessExpired);
    require!(rnd.reveal_slot > 0, ChipError::RandomnessNotResolved);
    Ok(rnd.value)
}

/// REFUND-time rule (SEC-C3): only an un-revealed request whose oracle window has expired.
pub fn assert_refundable(rnd: &Randomness, commit_slot: u64, clock_slot: u64) -> Result<()> {
    require!(
        clock_slot > commit_slot.saturating_add(STALE_PACK_SLOTS),
        ChipError::NotStale
    );
    require!(rnd.seed_slot == commit_slot, ChipError::RandomnessExpired);
    require!(rnd.reveal_slot == 0, ChipError::RandomnessAlreadyRevealed);
    Ok(())
}

/// The account must belong to the program (`authority == rng_auth`, SEC-C3 part 2).
pub fn assert_authority(rnd: &Randomness, rng_auth: &Pubkey) -> Result<()> {
    require_keys_eq!(rnd.authority, *rng_auth, ChipError::RandomnessAuthority);
    Ok(())
}

/// Never committed: exactly the state `randomness_init` leaves behind. Guarantees one commit
/// per account, so a pinned `commit_slot` can never be moved from under a pending pack.
pub fn assert_unused(rnd: &Randomness) -> Result<()> {
    require!(
        rnd.seed_slot == 0 && rnd.reveal_slot == 0,
        ChipError::RandomnessUsed
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Switchboard CPIs (metas in IDL order; see docs/06 SEC-C3 for the account table)
// ---------------------------------------------------------------------------

/// Accounts of Switchboard `randomness_init`. `randomness` and `authority` are PDAs of the
/// calling program and sign through `seeds`; `payer` is the outer signer (rent + LUT + escrow).
pub struct SbInitAccounts<'info> {
    pub randomness: AccountInfo<'info>,
    pub reward_escrow: AccountInfo<'info>,
    pub authority: AccountInfo<'info>,
    pub queue: AccountInfo<'info>,
    pub payer: AccountInfo<'info>,
    pub system_program: AccountInfo<'info>,
    pub token_program: AccountInfo<'info>,
    pub associated_token_program: AccountInfo<'info>,
    pub wrapped_sol_mint: AccountInfo<'info>,
    pub program_state: AccountInfo<'info>,
    pub lut_signer: AccountInfo<'info>,
    pub lut: AccountInfo<'info>,
    pub address_lookup_table_program: AccountInfo<'info>,
}

/// CPI `randomness_init` and verify the result: owned by Switchboard, `authority == rng_auth`,
/// never committed. `recent_slot` must be in SlotHashes (the client passes `getSlot('finalized')`)
/// because the lookup table address is derived from it.
pub fn init_owned<'info>(
    switchboard: &AccountInfo<'info>,
    a: &SbInitAccounts<'info>,
    recent_slot: u64,
    seeds: &[&[&[u8]]],
) -> Result<Randomness> {
    require_keys_eq!(
        *switchboard.key,
        SB_PROGRAM_ID,
        ChipError::RandomnessMismatch
    );
    require_keys_eq!(*a.queue.key, SB_QUEUE, ChipError::RandomnessMismatch);
    require!(a.randomness.data_is_empty(), ChipError::RandomnessUsed);
    let mut data = Vec::with_capacity(16);
    data.extend_from_slice(&SB_IX_RANDOMNESS_INIT);
    data.extend_from_slice(&recent_slot.to_le_bytes());
    let ix = Instruction {
        program_id: SB_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*a.randomness.key, true),
            AccountMeta::new(*a.reward_escrow.key, false),
            AccountMeta::new_readonly(*a.authority.key, true),
            AccountMeta::new(*a.queue.key, false),
            AccountMeta::new(*a.payer.key, true),
            AccountMeta::new_readonly(*a.system_program.key, false),
            AccountMeta::new_readonly(*a.token_program.key, false),
            AccountMeta::new_readonly(*a.associated_token_program.key, false),
            AccountMeta::new_readonly(*a.wrapped_sol_mint.key, false),
            AccountMeta::new_readonly(*a.program_state.key, false),
            AccountMeta::new_readonly(*a.lut_signer.key, false),
            AccountMeta::new(*a.lut.key, false),
            AccountMeta::new_readonly(*a.address_lookup_table_program.key, false),
        ],
        data,
    };
    invoke_signed(
        &ix,
        &[
            a.randomness.clone(),
            a.reward_escrow.clone(),
            a.authority.clone(),
            a.queue.clone(),
            a.payer.clone(),
            a.system_program.clone(),
            a.token_program.clone(),
            a.associated_token_program.clone(),
            a.wrapped_sol_mint.clone(),
            a.program_state.clone(),
            a.lut_signer.clone(),
            a.lut.clone(),
            a.address_lookup_table_program.clone(),
            switchboard.clone(),
        ],
        seeds,
    )?;
    let rnd = parse_checked(&a.randomness)?;
    assert_authority(&rnd, a.authority.key)?;
    assert_unused(&rnd)?;
    Ok(rnd)
}

/// CPI `randomness_commit` on an account the program owns, then apply the commit rules.
/// Order matters: authority + never-used are checked BEFORE the CPI (a used account must never
/// be re-committed — that would move the `seed_slot` pinned by another pending action),
/// freshness (`seed_slot == slot − 1`, unrevealed) AFTER it.
#[allow(clippy::too_many_arguments)]
pub fn commit_owned<'info>(
    switchboard: &AccountInfo<'info>,
    randomness: &AccountInfo<'info>,
    queue: &AccountInfo<'info>,
    oracle: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    recent_slothashes: &AccountInfo<'info>,
    seeds: &[&[&[u8]]],
    clock_slot: u64,
) -> Result<Randomness> {
    require_keys_eq!(
        *switchboard.key,
        SB_PROGRAM_ID,
        ChipError::RandomnessMismatch
    );
    require_keys_eq!(*queue.key, SB_QUEUE, ChipError::RandomnessMismatch);
    require_keys_eq!(
        *recent_slothashes.key,
        SLOT_HASHES_ID,
        ChipError::RandomnessMismatch
    );
    let before = parse_checked(randomness)?;
    assert_authority(&before, authority.key)?;
    assert_unused(&before)?;
    let ix = Instruction {
        program_id: SB_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*randomness.key, false),
            AccountMeta::new_readonly(*queue.key, false),
            AccountMeta::new(*oracle.key, false),
            AccountMeta::new_readonly(*recent_slothashes.key, false),
            AccountMeta::new_readonly(*authority.key, true),
        ],
        data: SB_IX_RANDOMNESS_COMMIT.to_vec(),
    };
    invoke_signed(
        &ix,
        &[
            randomness.clone(),
            queue.clone(),
            oracle.clone(),
            recent_slothashes.clone(),
            authority.clone(),
            switchboard.clone(),
        ],
        seeds,
    )?;
    let after = parse_checked(randomness)?;
    assert_fresh_commit(&after, clock_slot)?;
    Ok(after)
}

/// Accounts of Switchboard `randomness_reveal` (`stats` = `["OracleRandomnessStats", oracle]`,
/// `reward_escrow` = wSOL ATA of the randomness account, `program_state` = `["STATE"]`).
pub struct SbRevealAccounts<'info> {
    pub randomness: AccountInfo<'info>,
    pub oracle: AccountInfo<'info>,
    pub queue: AccountInfo<'info>,
    pub stats: AccountInfo<'info>,
    pub authority: AccountInfo<'info>,
    pub payer: AccountInfo<'info>,
    pub recent_slothashes: AccountInfo<'info>,
    pub system_program: AccountInfo<'info>,
    pub reward_escrow: AccountInfo<'info>,
    pub token_program: AccountInfo<'info>,
    pub wrapped_sol_mint: AccountInfo<'info>,
    pub program_state: AccountInfo<'info>,
}

/// CPI `randomness_reveal` with the program's PDA signature. Permissionless by design: the
/// oracle signature (fetched from the gateway by whoever cranks) is verified by Switchboard,
/// so the worst a stranger can do is settle the request earlier — which is the point (SEC-C3).
pub fn reveal_owned<'info>(
    switchboard: &AccountInfo<'info>,
    a: &SbRevealAccounts<'info>,
    signature: &[u8; 64],
    recovery_id: u8,
    value: &[u8; 32],
    seeds: &[&[&[u8]]],
) -> Result<Randomness> {
    require_keys_eq!(
        *switchboard.key,
        SB_PROGRAM_ID,
        ChipError::RandomnessMismatch
    );
    require_keys_eq!(*a.queue.key, SB_QUEUE, ChipError::RandomnessMismatch);
    require_keys_eq!(
        *a.recent_slothashes.key,
        SLOT_HASHES_ID,
        ChipError::RandomnessMismatch
    );
    let before = parse_checked(&a.randomness)?;
    assert_authority(&before, a.authority.key)?;
    require!(before.seed_slot > 0, ChipError::RandomnessExpired);
    require!(
        before.reveal_slot == 0,
        ChipError::RandomnessAlreadyRevealed
    );
    let mut data = Vec::with_capacity(8 + 64 + 1 + 32);
    data.extend_from_slice(&SB_IX_RANDOMNESS_REVEAL);
    data.extend_from_slice(signature);
    data.push(recovery_id);
    data.extend_from_slice(value);
    let ix = Instruction {
        program_id: SB_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*a.randomness.key, false),
            AccountMeta::new_readonly(*a.oracle.key, false),
            AccountMeta::new_readonly(*a.queue.key, false),
            AccountMeta::new(*a.stats.key, false),
            AccountMeta::new_readonly(*a.authority.key, true),
            AccountMeta::new(*a.payer.key, true),
            AccountMeta::new_readonly(*a.recent_slothashes.key, false),
            AccountMeta::new_readonly(*a.system_program.key, false),
            AccountMeta::new(*a.reward_escrow.key, false),
            AccountMeta::new_readonly(*a.token_program.key, false),
            AccountMeta::new_readonly(*a.wrapped_sol_mint.key, false),
            AccountMeta::new_readonly(*a.program_state.key, false),
        ],
        data,
    };
    invoke_signed(
        &ix,
        &[
            a.randomness.clone(),
            a.oracle.clone(),
            a.queue.clone(),
            a.stats.clone(),
            a.authority.clone(),
            a.payer.clone(),
            a.recent_slothashes.clone(),
            a.system_program.clone(),
            a.reward_escrow.clone(),
            a.token_program.clone(),
            a.wrapped_sol_mint.clone(),
            a.program_state.clone(),
            switchboard.clone(),
        ],
        seeds,
    )?;
    let after = parse_checked(&a.randomness)?;
    require!(
        after.reveal_slot > 0 && after.seed_slot == before.seed_slot,
        ChipError::RandomnessNotResolved
    );
    Ok(after)
}

/// Accounts of Switchboard `randomness_close` (rent → `authority`, which is our PDA; the caller
/// forwards it to the player — see `instructions::rng::close_randomness`).
pub struct SbCloseAccounts<'info> {
    pub randomness: AccountInfo<'info>,
    pub reward_escrow: AccountInfo<'info>,
    pub authority: AccountInfo<'info>,
    pub program_state: AccountInfo<'info>,
    pub system_program: AccountInfo<'info>,
    pub token_program: AccountInfo<'info>,
    pub wrapped_sol_mint: AccountInfo<'info>,
    pub lut: AccountInfo<'info>,
    pub lut_signer: AccountInfo<'info>,
    pub address_lookup_table_program: AccountInfo<'info>,
}

/// CPI `randomness_close` with the PDA signature; returns the lamports that landed on `authority`
/// (SEC-M7: the caller must forward them to the player in the same instruction). The caller is
/// responsible for making sure nothing still pins this account (pending pack / fusion / battle).
pub fn close_owned<'info>(
    switchboard: &AccountInfo<'info>,
    a: &SbCloseAccounts<'info>,
    seeds: &[&[&[u8]]],
) -> Result<u64> {
    require_keys_eq!(
        *switchboard.key,
        SB_PROGRAM_ID,
        ChipError::RandomnessMismatch
    );
    let before = parse_checked(&a.randomness)?;
    assert_authority(&before, a.authority.key)?;
    let lamports_before = a.authority.lamports();
    let ix = Instruction {
        program_id: SB_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*a.randomness.key, false),
            AccountMeta::new(*a.reward_escrow.key, false),
            AccountMeta::new(*a.authority.key, true),
            AccountMeta::new_readonly(*a.program_state.key, false),
            AccountMeta::new_readonly(*a.system_program.key, false),
            AccountMeta::new_readonly(*a.token_program.key, false),
            AccountMeta::new_readonly(*a.wrapped_sol_mint.key, false),
            AccountMeta::new(*a.lut.key, false),
            AccountMeta::new_readonly(*a.lut_signer.key, false),
            AccountMeta::new_readonly(*a.address_lookup_table_program.key, false),
        ],
        data: SB_IX_RANDOMNESS_CLOSE.to_vec(),
    };
    invoke_signed(
        &ix,
        &[
            a.randomness.clone(),
            a.reward_escrow.clone(),
            a.authority.clone(),
            a.program_state.clone(),
            a.system_program.clone(),
            a.token_program.clone(),
            a.wrapped_sol_mint.clone(),
            a.lut.clone(),
            a.lut_signer.clone(),
            a.address_lookup_table_program.clone(),
            switchboard.clone(),
        ],
        seeds,
    )?;
    Ok(a.authority.lamports().saturating_sub(lamports_before))
}

/// Accounts of Switchboard `randomness_close_lut`. `recipient` is the only account that receives
/// lamports, and every caller of this helper passes the player there — never the crank that relays
/// the instruction (SEC-F07: the party paying the fee must not be the party collecting the rent).
pub struct SbCloseLutAccounts<'info> {
    pub randomness: AccountInfo<'info>,
    pub lut: AccountInfo<'info>,
    pub lut_signer: AccountInfo<'info>,
    pub recipient: AccountInfo<'info>,
    pub address_lookup_table_program: AccountInfo<'info>,
}

/// CPI `randomness_close_lut(lut_slot)`, signed by the (already closed) `["rng", …]` PDA and by
/// our `["rng_auth"]` when the seeds carry it. Pins, before the CPI:
///
///  * `lut_signer == ["LutSigner", randomness]` of Switchboard and `lut == [lut_signer, lut_slot]`
///    of the ALT program — so `lut_slot` is not a trusted parameter, it *selects* a table whose
///    authority is this randomness, and a caller cannot point the CPI at somebody else's table;
///  * `lut` is owned by the ALT program (a system account with the same address would be a no-op
///    that still burned the fee);
///  * the randomness account is gone: no data and system-owned (SEC-F8 — the same "gone" test the
///    open/close paths use, deliberately without the lamport check, since anyone can donate SOL to
///    a closed PDA address). Switchboard cannot read a departed account, so a table that is still
///    in use can never be reached through this instruction.
pub fn close_lut_owned<'info>(
    switchboard: &AccountInfo<'info>,
    a: &SbCloseLutAccounts<'info>,
    lut_slot: u64,
    seeds: &[&[&[u8]]],
) -> Result<()> {
    require_keys_eq!(
        *switchboard.key,
        SB_PROGRAM_ID,
        ChipError::RandomnessMismatch
    );
    require!(
        a.randomness.data_is_empty() && *a.randomness.owner == system_program::ID,
        ChipError::RandomnessUsed
    );
    require_keys_eq!(
        *a.lut_signer.key,
        lut_signer_of(a.randomness.key),
        ChipError::RandomnessMismatch
    );
    require_keys_eq!(
        *a.lut.key,
        lut_of(a.lut_signer.key, lut_slot),
        ChipError::RandomnessMismatch
    );
    require_keys_eq!(
        *a.lut.owner,
        LUT_OWNER_PROGRAM_ID,
        ChipError::RandomnessMismatch
    );
    let mut data = Vec::with_capacity(16);
    data.extend_from_slice(&SB_IX_RANDOMNESS_CLOSE_LUT);
    data.extend_from_slice(&lut_slot.to_le_bytes());
    let ix = Instruction {
        program_id: SB_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*a.randomness.key, true),
            AccountMeta::new(*a.lut.key, false),
            AccountMeta::new_readonly(*a.lut_signer.key, false),
            AccountMeta::new(*a.recipient.key, false),
            AccountMeta::new_readonly(*a.address_lookup_table_program.key, false),
        ],
        data,
    };
    invoke_signed(
        &ix,
        &[
            a.randomness.clone(),
            a.lut.clone(),
            a.lut_signer.clone(),
            a.recipient.clone(),
            a.address_lookup_table_program.clone(),
            switchboard.clone(),
        ],
        seeds,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rnd(seed_slot: u64, reveal_slot: u64) -> Randomness {
        Randomness {
            authority: Pubkey::default(),
            seed_slot,
            reveal_slot,
            value: [7u8; 32],
        }
    }

    #[test]
    fn commit_requires_previous_slot_and_no_reveal() {
        assert!(assert_fresh_commit(&rnd(99, 0), 100).is_ok());
        assert!(assert_fresh_commit(&rnd(98, 0), 100).is_err()); // too old
        assert!(assert_fresh_commit(&rnd(100, 0), 100).is_err()); // same slot
        assert!(assert_fresh_commit(&rnd(99, 100), 100).is_err()); // already revealed (any slot)
        assert!(assert_fresh_commit(&rnd(99, 5), 100).is_err()); // recycled account
    }

    #[test]
    fn settle_reads_persisted_reveal_in_any_later_slot() {
        // reveal at slot 105, settle at 105 / 106 / 10 000 — all fine (C2)
        assert_eq!(revealed_value(&rnd(99, 105), 99).unwrap(), [7u8; 32]);
        assert!(revealed_value(&rnd(99, 0), 99).is_err()); // not yet
        assert!(revealed_value(&rnd(98, 105), 99).is_err()); // different commit
    }

    #[test]
    fn refund_only_after_window_and_only_if_never_revealed() {
        let commit = 1_000;
        assert!(assert_refundable(&rnd(commit, 0), commit, commit + STALE_PACK_SLOTS).is_err()); // not stale yet
        assert!(assert_refundable(&rnd(commit, 0), commit, commit + STALE_PACK_SLOTS + 1).is_ok());
        assert!(assert_refundable(
            &rnd(commit, commit + 3),
            commit,
            commit + STALE_PACK_SLOTS + 1
        )
        .is_err()); // revealed → must open
        assert!(
            assert_refundable(&rnd(commit + 1, 0), commit, commit + STALE_PACK_SLOTS + 1).is_err()
        ); // re-committed account
        assert_eq!(STALE_PACK_SLOTS, 10_800);
    }

    #[test]
    fn ownership_rules() {
        let auth = Pubkey::new_unique();
        let mut r = rnd(0, 0);
        assert!(assert_authority(&r, &auth).is_err()); // authority = default ≠ PDA
        r.authority = auth;
        assert!(assert_authority(&r, &auth).is_ok());
        assert!(assert_unused(&r).is_ok()); // straight out of init
        assert!(assert_unused(&rnd(99, 0)).is_err()); // committed once → never again
        assert!(assert_unused(&rnd(99, 105)).is_err()); // revealed → never again
    }

    #[test]
    fn discriminators_match_anchor_convention() {
        use anchor_lang::solana_program::hash::hash;
        let d = |name: &str| {
            let h = hash(format!("global:{name}").as_bytes()).to_bytes();
            let mut o = [0u8; 8];
            o.copy_from_slice(&h[..8]);
            o
        };
        assert_eq!(d("randomness_init"), SB_IX_RANDOMNESS_INIT);
        assert_eq!(d("randomness_commit"), SB_IX_RANDOMNESS_COMMIT);
        assert_eq!(d("randomness_reveal"), SB_IX_RANDOMNESS_REVEAL);
        assert_eq!(d("randomness_close"), SB_IX_RANDOMNESS_CLOSE);
        assert_eq!(d("randomness_close_lut"), SB_IX_RANDOMNESS_CLOSE_LUT);
    }
}
