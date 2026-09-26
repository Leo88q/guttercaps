//! GUTTERCAPS — sb_mock
//!
//! Localnet stand-in for the Switchboard On-Demand program (`sb_on_demand`).
//! There is no TEE oracle on a local validator, so a real `randomness_reveal`
//! would never land; this program lets `tests/localnet` drive the whole
//! commit → reveal → settle loop deterministically while our programs keep
//! talking to "Switchboard" exactly the way they do on devnet/mainnet:
//!
//!  * same **program-derived instruction discriminators** (`sha256("global:<name>")[..8]`
//!    — Anchor derives them from the handler names below, which are the real names),
//!  * same **account metas** in the same order (see
//!    `chip_core::randomness::{init_owned, commit_owned, reveal_owned, close_owned}`),
//!  * same **account layout**: `RandomnessAccountData`, 480 bytes, discriminator
//!    `[10,66,229,135,220,239,217,114]`, fields at the same offsets
//!    (authority 8, queue 40, seed_slothash 72, seed_slot 104, oracle 112,
//!    reveal_slot 144, value 152, lut_slot 184, ebuf 192..480),
//!  * same **authority rule**: `authority` must sign init / commit / reveal / close
//!    (with a PDA authority that only works through CPI — SEC-C3 part 2).
//!
//! What it deliberately does NOT do: verify the oracle's secp256k1 signature
//! (`reveal` stores whatever `value` the caller passes — that is the whole point
//! of a mock: tests pick the value), create the wSOL reward escrow / lookup
//! table, or check queue membership. `set_raw` (test-only, no authority) lets
//! negative tests forge any state, e.g. SEC-C1/C10 "look-alike account under a
//! foreign owner" (the *owner* is forged with `setAccount` on the harness side,
//! the *bytes* with `set_raw`).
//!
//! Built and loaded only with `anchor build -- --features localnet` +
//! `[[test.genesis]]` in Anchor.toml. Program id = `chip_core::randomness::SB_PROGRAM_ID`
//! under the `localnet` feature (keypair: tests/localnet/fixtures/sb_mock-keypair.json).

#![allow(clippy::result_large_err)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::system_instruction;

declare_id!("ApDh35vcLCxXc5ivaRGFhayn1HduJ9b2nXbfR6WMpVKH");

/// Total account size of the real `RandomnessAccountData` (8-byte discriminator included).
pub const RANDOMNESS_ACCOUNT_SIZE: usize = 480;
/// `sha256("account:RandomnessAccountData")[..8]` — what `switchboard_on_demand::RandomnessAccountData::parse` checks.
pub const RANDOMNESS_DISCRIMINATOR: [u8; 8] = [10, 66, 229, 135, 220, 239, 217, 114];

pub const OFF_AUTHORITY: usize = 8;
pub const OFF_QUEUE: usize = 40;
pub const OFF_SEED_SLOTHASH: usize = 72;
pub const OFF_SEED_SLOT: usize = 104;
pub const OFF_ORACLE: usize = 112;
pub const OFF_REVEAL_SLOT: usize = 144;
pub const OFF_VALUE: usize = 152;
pub const OFF_LUT_SLOT: usize = 184;

/// The mock's last field has to fit in the account it hands out. That is an invariant of *every* build,
/// not of the test binary, so it is asserted in the type checker rather than in `tests` — and as a const
/// assert rather than `assert!`, because clippy is right that a runtime `assert!` over constants is
/// optimized away: it could only ever be green, in both directions.
const _: () = assert!(OFF_LUT_SLOT + 8 <= RANDOMNESS_ACCOUNT_SIZE);

#[error_code]
pub enum MockError {
    #[msg("authority signer does not match RandomnessAccountData.authority")]
    InvalidAuthority,
    #[msg("randomness account is not 480 bytes / wrong discriminator")]
    InvalidAccount,
    #[msg("randomness was never committed")]
    RandomnessNotRequested,
    #[msg("randomness already revealed")]
    AlreadyRevealed,
    #[msg("set_raw payload must be at most 472 bytes")]
    PayloadTooLong,
    #[msg("the randomness account is still open — it must be closed before its lookup table")]
    RandomnessNotClosed,
}

// ---------------------------------------------------------------------------
// Raw field helpers (bytemuck-free: keeps the crate dependency-light and the
// layout explicit).
// ---------------------------------------------------------------------------

fn check_layout(ai: &AccountInfo) -> Result<()> {
    let data = ai.try_borrow_data()?;
    require!(
        data.len() == RANDOMNESS_ACCOUNT_SIZE,
        MockError::InvalidAccount
    );
    require!(
        data[..8] == RANDOMNESS_DISCRIMINATOR,
        MockError::InvalidAccount
    );
    Ok(())
}

fn read_pubkey(ai: &AccountInfo, off: usize) -> Result<Pubkey> {
    let data = ai.try_borrow_data()?;
    let slice: [u8; 32] = data[off..off + 32]
        .try_into()
        .map_err(|_| error!(MockError::InvalidAccount))?;
    Ok(Pubkey::new_from_array(slice))
}

fn read_u64(ai: &AccountInfo, off: usize) -> Result<u64> {
    let data = ai.try_borrow_data()?;
    let slice: [u8; 8] = data[off..off + 8]
        .try_into()
        .map_err(|_| error!(MockError::InvalidAccount))?;
    Ok(u64::from_le_bytes(slice))
}

fn write_bytes(ai: &AccountInfo, off: usize, bytes: &[u8]) -> Result<()> {
    let mut data = ai.try_borrow_mut_data()?;
    data[off..off + bytes.len()].copy_from_slice(bytes);
    Ok(())
}

fn write_u64(ai: &AccountInfo, off: usize, v: u64) -> Result<()> {
    write_bytes(ai, off, &v.to_le_bytes())
}

fn require_authority(randomness: &AccountInfo, authority: &Signer) -> Result<()> {
    check_layout(randomness)?;
    require_keys_eq!(
        read_pubkey(randomness, OFF_AUTHORITY)?,
        authority.key(),
        MockError::InvalidAuthority
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Accounts — metas in `sb_on_demand` IDL order (see chip_core::randomness).
// Everything Switchboard would touch but the mock ignores is an `UncheckedAccount`
// so that any key the caller passes is accepted.
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct RandomnessInit<'info> {
    /// CHECK: created here (system-owned & empty before) — a PDA of the caller signing via CPI seeds, or a keypair.
    #[account(mut)]
    pub randomness: Signer<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: wSOL reward escrow — ignored by the mock (never created).
    #[account(mut)]
    pub reward_escrow: UncheckedAccount<'info>,
    /// Stored as `RandomnessAccountData.authority`; must sign every later instruction.
    pub authority: Signer<'info>,
    /// CHECK: queue key — stored verbatim, not validated.
    #[account(mut)]
    pub queue: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: token program — ignored.
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: associated token program — ignored.
    pub associated_token_program: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: wSOL mint — ignored.
    pub wrapped_sol_mint: UncheckedAccount<'info>,
    /// CHECK: Switchboard `["STATE"]` — ignored.
    pub program_state: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: `["LutSigner", randomness]` — ignored.
    pub lut_signer: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: lookup table — ignored (never created).
    #[account(mut)]
    pub lut: UncheckedAccount<'info>,
    /// CHECK: Address Lookup Table program — ignored.
    pub address_lookup_table_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RandomnessCommit<'info> {
    /// CHECK: layout + authority checked in the handler.
    #[account(mut, owner = crate::ID @ MockError::InvalidAccount)]
    pub randomness: UncheckedAccount<'info>,
    /// CHECK: queue — ignored.
    pub queue: UncheckedAccount<'info>,
    /// CHECK: oracle — stored verbatim (the real program checks queue membership / heartbeat).
    #[account(mut)]
    pub oracle: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: SlotHashes sysvar — the mock derives `seed_slothash` from Clock instead.
    pub recent_slothashes: UncheckedAccount<'info>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct RandomnessReveal<'info> {
    /// CHECK: layout + authority checked in the handler.
    #[account(mut, owner = crate::ID @ MockError::InvalidAccount)]
    pub randomness: UncheckedAccount<'info>,
    /// CHECK: oracle — ignored (no secp256k1 verification in the mock).
    pub oracle: UncheckedAccount<'info>,
    /// CHECK: queue — ignored.
    pub queue: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: `["OracleRandomnessStats", oracle]` — ignored.
    #[account(mut)]
    pub stats: UncheckedAccount<'info>,
    pub authority: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: SlotHashes sysvar — ignored.
    pub recent_slothashes: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    // sentio-ignore-next-line SW002
    /// CHECK: reward escrow — ignored.
    #[account(mut)]
    pub reward_escrow: UncheckedAccount<'info>,
    /// CHECK: token program — ignored.
    pub token_program: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: wSOL mint — ignored.
    pub wrapped_sol_mint: UncheckedAccount<'info>,
    /// CHECK: `["STATE"]` — ignored.
    pub program_state: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RandomnessClose<'info> {
    /// CHECK: layout + authority checked in the handler; drained and reassigned to System.
    #[account(mut, owner = crate::ID @ MockError::InvalidAccount)]
    pub randomness: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: reward escrow — ignored (the mock never created it).
    #[account(mut)]
    pub reward_escrow: UncheckedAccount<'info>,
    /// Receives the account's lamports (the real program also closes the wSOL escrow into it).
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: `["STATE"]` — ignored.
    pub program_state: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: token program — ignored.
    pub token_program: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: wSOL mint — ignored.
    pub wrapped_sol_mint: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: lookup table — ignored.
    #[account(mut)]
    pub lut: UncheckedAccount<'info>,
    // sentio-ignore-next-line SW002
    /// CHECK: `["LutSigner", randomness]` — ignored.
    pub lut_signer: UncheckedAccount<'info>,
    /// CHECK: Address Lookup Table program — ignored.
    pub address_lookup_table_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RandomnessCloseLut<'info> {
    /// CHECK: must be closed already (drained + reassigned to System by `randomness_close`); the mock
    /// re-checks that below — a request that is still live must never reach a table payout.
    #[account(mut)]
    pub randomness: UncheckedAccount<'info>,
    /// The lookup-table stand-in. In the localnet build `LUT_OWNER_PROGRAM_ID` IS this program (the
    /// harness cannot deploy the Address Lookup Table program, and only an account's owner may debit
    /// its lamports), so this program plays the ALT program's part: it pays the table's whole balance
    /// to `recipient` and hands the account back to the System program — same effect as closing a
    /// deactivated table, which the real ALT program performs because it owns the table.
    /// CHECK: must be owned by this program; that ownership is the runtime-enforced right to debit it.
    #[account(mut, owner = crate::ID @ MockError::InvalidAccount)]
    pub lut: UncheckedAccount<'info>,
    /// CHECK: `["LutSigner", randomness]` in the real program — the mock ignores it.
    pub lut_signer: UncheckedAccount<'info>,
    /// Receives the table's rent in the real program (Switchboard's `recipient`).
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
    /// CHECK: Address Lookup Table program — ignored.
    pub address_lookup_table_program: UncheckedAccount<'info>,
}

/// Test-only escape hatch: overwrite the payload of any mock-owned randomness account
/// (no authority check — this program never runs outside a local validator).
#[derive(Accounts)]
pub struct SetRaw<'info> {
    /// CHECK: any account owned by this program.
    #[account(mut, owner = crate::ID @ MockError::InvalidAccount)]
    pub randomness: UncheckedAccount<'info>,
    pub payer: Signer<'info>,
}

// ---------------------------------------------------------------------------

#[program]
pub mod sb_mock {
    use super::*;

    /// Mirrors `sb_on_demand::randomness_init(recent_slot)`: creates the 480-byte account
    /// (rent paid by `payer`, `randomness` must sign — through CPI seeds when it is a PDA),
    /// writes discriminator + authority + queue + `lut_slot = recent_slot`; everything else zero.
    pub fn randomness_init(ctx: Context<RandomnessInit>, recent_slot: u64) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.system_program.key(),
            anchor_lang::system_program::ID
        );
        let rnd = ctx.accounts.randomness.to_account_info();
        require!(rnd.data_is_empty(), MockError::InvalidAccount);
        let lamports = Rent::get()?.minimum_balance(RANDOMNESS_ACCOUNT_SIZE);
        // The signer set of this instruction already contains `randomness` (outer tx signature or
        // CPI seeds propagate through `invoke_signed` with empty seeds), so a plain invoke works.
        invoke_signed(
            &system_instruction::create_account(
                &ctx.accounts.payer.key(),
                &rnd.key(),
                lamports,
                RANDOMNESS_ACCOUNT_SIZE as u64,
                &crate::ID,
            ),
            &[
                ctx.accounts.payer.to_account_info(),
                rnd.clone(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[],
        )?;
        write_bytes(&rnd, 0, &RANDOMNESS_DISCRIMINATOR)?;
        write_bytes(&rnd, OFF_AUTHORITY, ctx.accounts.authority.key().as_ref())?;
        write_bytes(&rnd, OFF_QUEUE, ctx.accounts.queue.key().as_ref())?;
        write_u64(&rnd, OFF_LUT_SLOT, recent_slot)?;
        Ok(())
    }

    /// Mirrors `sb_on_demand::randomness_commit`: `seed_slot = slot − 1`, `seed_slothash` =
    /// keccak-free stand-in (the previous slot number hashed into 32 bytes), `oracle` = passed key.
    /// Rejects a re-commit of an already revealed account like the real program does.
    pub fn randomness_commit(ctx: Context<RandomnessCommit>) -> Result<()> {
        let rnd = ctx.accounts.randomness.to_account_info();
        require_authority(&rnd, &ctx.accounts.authority)?;
        require!(
            read_u64(&rnd, OFF_REVEAL_SLOT)? == 0,
            MockError::AlreadyRevealed
        );
        let slot = Clock::get()?.slot;
        let seed_slot = slot.saturating_sub(1);
        let mut slothash = [0u8; 32];
        slothash[..8].copy_from_slice(&seed_slot.to_le_bytes());
        slothash[8..16].copy_from_slice(&slot.to_le_bytes());
        write_bytes(&rnd, OFF_SEED_SLOTHASH, &slothash)?;
        write_u64(&rnd, OFF_SEED_SLOT, seed_slot)?;
        write_bytes(&rnd, OFF_ORACLE, ctx.accounts.oracle.key().as_ref())?;
        Ok(())
    }

    /// Mirrors `sb_on_demand::randomness_reveal(signature, recovery_id, value)` minus the
    /// secp256k1 check: stores `value`, `reveal_slot = slot`. Requires a prior commit and no
    /// earlier reveal (so "reveal twice" surfaces as an error, like on the real program).
    pub fn randomness_reveal(
        ctx: Context<RandomnessReveal>,
        _signature: [u8; 64],
        _recovery_id: u8,
        value: [u8; 32],
    ) -> Result<()> {
        let rnd = ctx.accounts.randomness.to_account_info();
        require_authority(&rnd, &ctx.accounts.authority)?;
        require!(
            read_u64(&rnd, OFF_SEED_SLOT)? > 0,
            MockError::RandomnessNotRequested
        );
        require!(
            read_u64(&rnd, OFF_REVEAL_SLOT)? == 0,
            MockError::AlreadyRevealed
        );
        write_bytes(&rnd, OFF_VALUE, &value)?;
        write_u64(&rnd, OFF_REVEAL_SLOT, Clock::get()?.slot)?;
        Ok(())
    }

    /// Mirrors `sb_on_demand::randomness_close`: lamports → `authority`, data zeroed, account
    /// handed back to the System program.
    // sentio-ignore-fn SW022
    pub fn randomness_close(ctx: Context<RandomnessClose>) -> Result<()> {
        let rnd = ctx.accounts.randomness.to_account_info();
        require_authority(&rnd, &ctx.accounts.authority)?;
        let lamports = rnd.lamports();
        // SW027: make the close observable to indexers (mock of sb_on_demand::randomness_close).
        msg!(
            "randomness_close: drained {} lamports from {}",
            lamports,
            rnd.key()
        );
        **rnd.try_borrow_mut_lamports()? = 0;
        **ctx
            .accounts
            .authority
            .to_account_info()
            .try_borrow_mut_lamports()? += lamports;
        {
            let mut data = rnd.try_borrow_mut_data()?;
            data.fill(0);
        }
        rnd.assign(&anchor_lang::system_program::ID);
        rnd.resize(0)?; // `realloc` is deprecated in solana-program 2.x; note that `resize` takes no zero_init (chip_core's close_state)
        Ok(())
    }

    /// Mirrors `sb_on_demand::randomness_close_lut(lut_slot)`: closes the (already deactivated)
    /// lookup table of a closed randomness account and pays its rent to `recipient`.
    pub fn randomness_close_lut(ctx: Context<RandomnessCloseLut>, _lut_slot: u64) -> Result<()> {
        let lut = ctx.accounts.lut.to_account_info();
        let lamports = lut.lamports();
        // the real program only pays out a table that belongs to the (closed) randomness account: for
        // the mock, "the account is gone" is the stand-in for that check.
        let randomness = ctx.accounts.randomness.to_account_info();
        require!(
            randomness.data_is_empty() && *randomness.owner != crate::ID,
            MockError::RandomnessNotClosed
        );
        **lut.try_borrow_mut_lamports()? = 0;
        **ctx.accounts.recipient.try_borrow_mut_lamports()? += lamports;
        {
            let mut data = lut.try_borrow_mut_data()?;
            data.fill(0);
        }
        lut.assign(&anchor_lang::system_program::ID);
        lut.resize(0)?;
        Ok(())
    }

    /// Test-only: overwrite bytes `[8, 8 + payload.len())` of a mock-owned randomness account
    /// (discriminator stays intact; pass 472 bytes to rewrite every field).
    pub fn set_raw(ctx: Context<SetRaw>, payload: Vec<u8>) -> Result<()> {
        require!(
            payload.len() <= RANDOMNESS_ACCOUNT_SIZE - 8,
            MockError::PayloadTooLong
        );
        let rnd = ctx.accounts.randomness.to_account_info();
        check_layout(&rnd)?;
        write_bytes(&rnd, 8, &payload)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::hash::hash;

    fn disc(name: &str) -> [u8; 8] {
        let b = hash(format!("global:{name}").as_bytes()).to_bytes();
        let mut out = [0u8; 8];
        out.copy_from_slice(&b[..8]);
        out
    }

    /// The handler names above are what Anchor hashes into instruction discriminators; they
    /// must equal the constants chip_core hard-codes for the real Switchboard program.
    #[test]
    fn discriminators_match_switchboard() {
        assert_eq!(disc("randomness_init"), [9, 9, 204, 33, 50, 116, 113, 15]);
        assert_eq!(
            disc("randomness_commit"),
            [52, 170, 152, 201, 179, 133, 242, 141]
        );
        assert_eq!(
            disc("randomness_reveal"),
            [197, 181, 187, 10, 30, 58, 20, 73]
        );
        assert_eq!(
            disc("randomness_close"),
            [146, 101, 14, 74, 225, 246, 0, 156]
        );
        assert_eq!(disc("set_raw"), [217, 218, 121, 135, 159, 109, 133, 237]);
        let acc: [u8; 8] = hash(b"account:RandomnessAccountData").to_bytes()[..8]
            .try_into()
            .unwrap();
        assert_eq!(acc, RANDOMNESS_DISCRIMINATOR);
    }

    #[test]
    fn layout_offsets_match_switchboard() {
        // authority 8, queue 40, seed_slothash 72, seed_slot 104, oracle 112, reveal_slot 144, value 152, lut_slot 184
        assert_eq!(OFF_QUEUE, OFF_AUTHORITY + 32);
        assert_eq!(OFF_SEED_SLOTHASH, OFF_QUEUE + 32);
        assert_eq!(OFF_SEED_SLOT, OFF_SEED_SLOTHASH + 32);
        assert_eq!(OFF_ORACLE, OFF_SEED_SLOT + 8);
        assert_eq!(OFF_REVEAL_SLOT, OFF_ORACLE + 32);
        assert_eq!(OFF_VALUE, OFF_REVEAL_SLOT + 8);
        assert_eq!(OFF_LUT_SLOT, OFF_VALUE + 32);
        // "…and it still fits in the account" lives next to the offsets as a const assertion (see above):
        // a runtime assert on constant operands is what clippy calls out, and it was never the real check.
    }
}
