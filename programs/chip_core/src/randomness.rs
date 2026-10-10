//! Commit-reveal guards shared by packs, fusions and (through the `cpi` crate
//! feature) the arena. Switchboard On-Demand is dead (shutdown 2026-09-25);
//! the program now owns the randomness PDA and mixes a **future SlotHashes**
//! entry so neither the team nor the player can pick the bytes.
//!
//! Threat model (docs/06 SEC-C1…C3):
//!  * **C1 owner check** — every read goes through [`parse_checked`]: the
//!    account must be owned by the calling program (chip_core / arena), never
//!    System, never a look-alike.
//!  * **C2 persisted value** — settlement reads [`revealed_value`] once and
//!    the caller stores the bytes in its pending account.
//!  * **C3 no free re-rolls** — refund only after `STALE_PACK_SLOTS` *and*
//!    never revealed. The account is a PDA `["rng", kind, owner, nonce]`
//!    created by `init_randomness`, committed **inside** the paid action
//!    ([`commit_owned`], `seed_slot = Clock::slot`) and revealed by the
//!    permissionless `reveal_randomness` ([`reveal_owned`]) after
//!    [`RNG_DELAY_SLOTS`]. The mix is `sha256("gc-rng-v1" ‖ pda ‖ seed_slot ‖
//!    target_slot ‖ slothash(target))` with `target = seed_slot + DELAY`, so
//!    the crank cannot shop for a later slot. A localnet-only non-zero
//!    `value` argument still injects golden-test rolls (`--features localnet`);
//!    production ignores the argument.
//!
//! Instruction account lists still pin the historical Switchboard program /
//! queue pubkeys so `verify-deploy` cluster pins stay in the ELF; those
//! accounts are **not** CPI targets any more.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::system_instruction;
use anchor_lang::system_program;

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

/// Slots after commit before the target SlotHashes entry exists. ~3.2 s at 400 ms.
/// Localnet is 0 so golden tests can reveal in the same slot (they inject `value`).
#[cfg(feature = "localnet")]
pub const RNG_DELAY_SLOTS: u64 = 0;
#[cfg(not(feature = "localnet"))]
pub const RNG_DELAY_SLOTS: u64 = 8;
/// `gc-rng01` — our account tag (not Switchboard's RandomnessAccountData).
pub const RNG_DISC: [u8; 8] = *b"gc-rng01";
/// disc(8) + authority(32) + seed_slot(8) + reveal_slot(8) + value(32).
pub const RNG_ACCOUNT_SIZE: usize = 88;

/// Snapshot of the fields we act on (copied out so callers don't hold a `Ref` across CPIs).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Randomness {
    pub authority: Pubkey,
    pub seed_slot: u64,
    pub reveal_slot: u64,
    pub value: [u8; 32],
}

fn unpack(data: &[u8]) -> Result<Randomness> {
    require!(data.len() >= RNG_ACCOUNT_SIZE, ChipError::RandomnessMismatch);
    require!(data[..8] == RNG_DISC, ChipError::RandomnessMismatch);
    Ok(Randomness {
        authority: Pubkey::try_from(&data[8..40]).map_err(|_| error!(ChipError::RandomnessMismatch))?,
        seed_slot: u64::from_le_bytes(data[40..48].try_into().unwrap()),
        reveal_slot: u64::from_le_bytes(data[48..56].try_into().unwrap()),
        value: data[56..88].try_into().unwrap(),
    })
}

fn pack_into(data: &mut [u8], rnd: &Randomness) -> Result<()> {
    require!(data.len() >= RNG_ACCOUNT_SIZE, ChipError::RandomnessMismatch);
    data[..8].copy_from_slice(&RNG_DISC);
    data[8..40].copy_from_slice(rnd.authority.as_ref());
    data[40..48].copy_from_slice(&rnd.seed_slot.to_le_bytes());
    data[48..56].copy_from_slice(&rnd.reveal_slot.to_le_bytes());
    data[56..88].copy_from_slice(&rnd.value);
    Ok(())
}

/// Parse + owner check (SEC-C1). `program_id` is the calling program (chip_core or arena).
pub fn parse_checked(ai: &AccountInfo<'_>, program_id: &Pubkey) -> Result<Randomness> {
    require_keys_eq!(*ai.owner, *program_id, ChipError::RandomnessMismatch);
    unpack(&ai.data.borrow())
}

/// COMMIT-time rule: committed **this** slot (future slothashes unknown) and never revealed.
pub fn assert_fresh_commit(rnd: &Randomness, clock_slot: u64) -> Result<()> {
    require!(rnd.seed_slot == clock_slot, ChipError::RandomnessExpired);
    require!(rnd.reveal_slot == 0, ChipError::RandomnessAlreadyRevealed);
    Ok(())
}

/// SlotHashes sysvar: u64 count, then `(slot: u64, hash: [u8; 32])` newest-first.
pub fn slothash_at(slothashes: &AccountInfo<'_>, slot: u64) -> Result<[u8; 32]> {
    require_keys_eq!(
        *slothashes.key,
        SLOT_HASHES_ID,
        ChipError::RandomnessMismatch
    );
    let data = slothashes.data.borrow();
    require!(data.len() >= 8, ChipError::RandomnessExpired);
    let n = u64::from_le_bytes(data[0..8].try_into().unwrap());
    let mut off = 8usize;
    for _ in 0..n {
        require!(off + 40 <= data.len(), ChipError::RandomnessExpired);
        let s = u64::from_le_bytes(data[off..off + 8].try_into().unwrap());
        // Newest first. Exact match, or the newest produced slot ≤ target (skipped slots).
        if s <= slot {
            let mut h = [0u8; 32];
            h.copy_from_slice(&data[off + 8..off + 40]);
            return Ok(h);
        }
        off += 40;
    }
    err!(ChipError::RandomnessExpired)
}

pub fn derive_value(pda: &Pubkey, seed_slot: u64, slothash: &[u8; 32]) -> [u8; 32] {
    let target = seed_slot.saturating_add(RNG_DELAY_SLOTS);
    hashv(&[
        b"gc-rng-v1",
        pda.as_ref(),
        &seed_slot.to_le_bytes(),
        &target.to_le_bytes(),
        slothash,
    ])
    .to_bytes()
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

/// Create the program-owned RNG PDA. Historical Switchboard program/queue pubkeys are still
/// address-checked so cluster pins stay in the ELF; they are not CPI targets.
pub fn init_owned<'info>(
    program_id: &Pubkey,
    switchboard: &AccountInfo<'info>,
    a: &SbInitAccounts<'info>,
    _recent_slot: u64,
    seeds: &[&[&[u8]]],
) -> Result<Randomness> {
    require_keys_eq!(
        *switchboard.key,
        SB_PROGRAM_ID,
        ChipError::RandomnessMismatch
    );
    require_keys_eq!(*a.queue.key, SB_QUEUE, ChipError::RandomnessMismatch);
    require!(a.randomness.data_is_empty(), ChipError::RandomnessUsed);
    let lamports = Rent::get()?.minimum_balance(RNG_ACCOUNT_SIZE);
    invoke_signed(
        &system_instruction::create_account(
            a.payer.key,
            a.randomness.key,
            lamports,
            RNG_ACCOUNT_SIZE as u64,
            program_id,
        ),
        &[
            a.payer.clone(),
            a.randomness.clone(),
            a.system_program.clone(),
        ],
        seeds,
    )?;
    let rnd = Randomness {
        authority: *a.authority.key,
        seed_slot: 0,
        reveal_slot: 0,
        value: [0u8; 32],
    };
    pack_into(&mut a.randomness.try_borrow_mut_data()?, &rnd)?;
    Ok(rnd)
}


/// Commit this slot. Switchboard queue/program keys are still checked (ELF pins) but not CPI'd.
#[allow(clippy::too_many_arguments)]
pub fn commit_owned<'info>(
    program_id: &Pubkey,
    switchboard: &AccountInfo<'info>,
    randomness: &AccountInfo<'info>,
    queue: &AccountInfo<'info>,
    _oracle: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    recent_slothashes: &AccountInfo<'info>,
    _seeds: &[&[&[u8]]],
    clock_slot: u64,
) -> Result<Randomness> {
    require_keys_eq!(*switchboard.key, SB_PROGRAM_ID, ChipError::RandomnessMismatch);
    require_keys_eq!(*queue.key, SB_QUEUE, ChipError::RandomnessMismatch);
    require_keys_eq!(*recent_slothashes.key, SLOT_HASHES_ID, ChipError::RandomnessMismatch);
    let before = parse_checked(randomness, program_id)?;
    assert_authority(&before, authority.key)?;
    assert_unused(&before)?;
    let after = Randomness { seed_slot: clock_slot, ..before };
    pack_into(&mut randomness.try_borrow_mut_data()?, &after)?;
    assert_fresh_commit(&after, clock_slot)?;
    Ok(after)
}

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

/// Permissionless reveal: mix the committed PDA with SlotHashes[seed_slot + DELAY].
/// Production ignores `value`. Localnet uses a non-zero `value` for golden tests.
pub fn reveal_owned<'info>(
    program_id: &Pubkey,
    _switchboard: &AccountInfo<'info>,
    a: &SbRevealAccounts<'info>,
    _signature: &[u8; 64],
    _recovery_id: u8,
    value: &[u8; 32],
    _seeds: &[&[&[u8]]],
) -> Result<Randomness> {
    require_keys_eq!(*a.queue.key, SB_QUEUE, ChipError::RandomnessMismatch);
    require_keys_eq!(*a.recent_slothashes.key, SLOT_HASHES_ID, ChipError::RandomnessMismatch);
    let before = parse_checked(&a.randomness, program_id)?;
    assert_authority(&before, a.authority.key)?;
    require!(before.seed_slot > 0, ChipError::RandomnessExpired);
    require!(before.reveal_slot == 0, ChipError::RandomnessAlreadyRevealed);
    let clock_slot = Clock::get()?.slot;
    let target = before.seed_slot.saturating_add(RNG_DELAY_SLOTS);
    #[cfg(feature = "localnet")]
    require!(clock_slot >= target, ChipError::RandomnessNotResolved);
    #[cfg(not(feature = "localnet"))]
    require!(clock_slot > target, ChipError::RandomnessNotResolved);
    let derived = {
        #[cfg(feature = "localnet")]
        {
            if *value != [0u8; 32] {
                *value
            } else {
                let h = slothash_at(&a.recent_slothashes, target)?;
                derive_value(a.randomness.key, before.seed_slot, &h)
            }
        }
        #[cfg(not(feature = "localnet"))]
        {
            let _ = value;
            let h = slothash_at(&a.recent_slothashes, target)?;
            derive_value(a.randomness.key, before.seed_slot, &h)
        }
    };
    let after = Randomness { reveal_slot: clock_slot, value: derived, ..before };
    pack_into(&mut a.randomness.try_borrow_mut_data()?, &after)?;
    Ok(after)
}

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

/// Close the RNG PDA and send its lamports to `recipient` (the player). Returns 0 because
/// the caller used to forward Switchboard rent from rng_auth; that hop is gone.
pub fn close_owned<'info>(
    program_id: &Pubkey,
    _switchboard: &AccountInfo<'info>,
    a: &SbCloseAccounts<'info>,
    recipient: &AccountInfo<'info>,
    _seeds: &[&[&[u8]]],
) -> Result<u64> {
    let before = parse_checked(&a.randomness, program_id)?;
    assert_authority(&before, a.authority.key)?;
    let amount = a.randomness.lamports();
    **a.randomness.try_borrow_mut_lamports()? = 0;
    **recipient.try_borrow_mut_lamports()? += amount;
    // resize while we still own it; `realloc` is denied (solana-account-info 2.3 / rust-lints).
    a.randomness.resize(0)?;
    a.randomness.assign(&system_program::ID);
    Ok(0)
}

pub struct SbCloseLutAccounts<'info> {
    pub randomness: AccountInfo<'info>,
    pub lut: AccountInfo<'info>,
    pub lut_signer: AccountInfo<'info>,
    pub recipient: AccountInfo<'info>,
    pub address_lookup_table_program: AccountInfo<'info>,
}

/// No Switchboard LUT is created any more. Succeeds when the RNG PDA is already gone.
pub fn close_lut_owned<'info>(
    switchboard: &AccountInfo<'info>,
    a: &SbCloseLutAccounts<'info>,
    _lut_slot: u64,
    _seeds: &[&[&[u8]]],
) -> Result<()> {
    require_keys_eq!(*switchboard.key, SB_PROGRAM_ID, ChipError::RandomnessMismatch);
    require!(
        a.randomness.data_is_empty() && *a.randomness.owner == system_program::ID,
        ChipError::RandomnessUsed
    );
    Ok(())
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
    fn commit_requires_this_slot_and_no_reveal() {
        assert!(assert_fresh_commit(&rnd(100, 0), 100).is_ok());
        assert!(assert_fresh_commit(&rnd(99, 0), 100).is_err()); // too old
        assert!(assert_fresh_commit(&rnd(101, 0), 100).is_err()); // future
        assert!(assert_fresh_commit(&rnd(100, 100), 100).is_err()); // already revealed
        assert!(assert_fresh_commit(&rnd(100, 5), 100).is_err()); // recycled account
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
    fn pack_roundtrip_and_mix_is_domain_separated() {
        let auth = Pubkey::new_unique();
        let src = Randomness { authority: auth, seed_slot: 9, reveal_slot: 17, value: [3u8; 32] };
        let mut buf = [0u8; RNG_ACCOUNT_SIZE];
        pack_into(&mut buf, &src).unwrap();
        assert_eq!(&buf[..8], &RNG_DISC);
        let got = unpack(&buf).unwrap();
        assert_eq!(got, src);
        let pda = Pubkey::new_unique();
        let h = [9u8; 32];
        let a = derive_value(&pda, 10, &h);
        let b = derive_value(&pda, 11, &h);
        assert_ne!(a, b);
        assert_ne!(a, h);
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
