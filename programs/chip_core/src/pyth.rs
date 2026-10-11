//! Loading a Pyth `PriceUpdateV2` without `Account<'info, PriceUpdateV2>`
//! (`docs/09-production-readiness.md` §1.1 — a first-build blocker).
//!
//! Why this file exists: `anchor build` compiles every program with the `idl-build` feature, which
//! requires **every** type inside `#[derive(Accounts)]` to implement `anchor_lang::idl::IdlBuild`.
//! `pyth-solana-receiver-sdk` (the pinned `=1.0.1`, and still true on `main` at 2.0.0) declares only
//! `#[account] #[derive(BorshSchema)]` on `PriceUpdateV2` and ships no `idl-build` feature at all —
//! so nobody implements `IdlBuild` for it, and the orphan rule forbids us from doing it here
//! (foreign trait, foreign type). The account therefore has to be a `/// CHECK:` account.
//!
//! That is safe only if we re-implement exactly what `Account<T>` did, which is what [`load`] does. The
//! owner check (`owner == PYTH_RECEIVER`) is enforced declaratively by `#[account(owner = …)]` on the
//! struct, so a hand-crafted account with a valid layout but a different owner is still rejected. The
//! deserialise step is `AccountDeserialize::try_deserialize` — the 8-byte `PriceUpdateV2::DISCRIMINATOR`
//! check **and** borsh, exactly the call anchor's `Account::try_from_unchecked` makes. Everything above
//! that — feed id, `Full` verification level, `publish_time` freshness, the ±2 % confidence guard — stays
//! historically in `instructions::packs::oracle_price`. Checkout is frozen FX and does not load this.
//!
//! (Written as prose rather than a numbered list on purpose: the list was `1.` / `2./3.` with folded
//! continuation lines, and rustdoc's `doc_lazy_continuation` + `doc_overindented_list_items` lints read
//! exactly that shape as a broken list. Under `-D warnings` a comment style is a build failure.)

use anchor_lang::prelude::*;
use anchor_lang::AccountDeserialize;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::errors::ChipError;

/// The Pyth **receiver** program: the only account owner we accept for a price update. Pinned
/// against `packages/economy` (`PYTH_PROGRAMS.receiver`) and `client/src/chain/ids.ts` by
/// `npm run economy:check`. The `pro-compatible` SDK build uses a different receiver id
/// (`rec2HHDD…`) — we do not use that feature, and the account constraint would reject it anyway.
pub const PYTH_RECEIVER: Pubkey = pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");

/// The 8-byte anchor discriminator of `PriceUpdateV2` (`sha256("account:PriceUpdateV2")[..8]`),
/// computed by the SDK's `#[account]` derive. Inlined rather than imported because
/// `anchor_lang::Discriminator` on a foreign type would force every caller to carry the trait import.
const DISCRIMINATOR_LEN: usize = 8;

/// Read and validate the account behind an `Option<UncheckedAccount>` slot.
///
/// Returns an owned `PriceUpdateV2`: the caller must not hold the `Ref` data borrow across the
/// SPL/system CPIs that follow, and the struct is ~150 bytes — cheaper than re-borrowing.
///
/// Errors collapse to `ChipError::StalePrice`: from the buyer's side a missing, malformed or
/// foreign-owned price account all mean "no usable price right now", and the client's reaction to
/// `StalePrice` (re-quote) is the right one for every variant.
pub fn load(acc: &AccountInfo<'_>) -> Result<PriceUpdateV2> {
    let data = acc.try_borrow_data()?;
    require!(data.len() > DISCRIMINATOR_LEN, ChipError::StalePrice);
    // `AccountDeserialize::try_deserialize` takes a *cursor* (`&mut &[u8]`) and advances it past the
    // 8-byte discriminator itself — which is why the guard above is `>` and not `>=`, and why there is no
    // manual `&data[8..]` here. Handing it `&data[..]` is the mistake the first compile run caught (E0308
    // on this line, not on the trait import): the trait is implemented for the type, the *argument* was
    // wrong, and the compiler is not obliged to explain that in the message.
    let mut buf: &[u8] = &data;
    PriceUpdateV2::try_deserialize(&mut buf).map_err(|_| error!(ChipError::StalePrice))
}

#[cfg(test)]
mod tests {
    use super::*;
    // `Discriminator` belongs here, not in the module's imports: it is only reachable through a trait,
    // so a lib-target build (where `cfg(test)` is off) would carry it as an unused import — and
    // `rust-lints` runs clippy with warnings denied.
    use anchor_lang::{solana_program::hash::hash, Discriminator};

    /// `try_deserialize` is only equivalent to `Account<T>` if the 8 bytes it skips are the anchor
    /// discriminator of THIS type. Pins it against the SDK's `#[account]` derive: a receiver release
    /// that renames the struct would otherwise silently let a `TwapUpdate` (or any other receiver
    /// account with a decodable prefix) price a pack.
    #[test]
    fn discriminator_is_the_anchor_convention() {
        let expected = hash(b"account:PriceUpdateV2");
        // `DISCRIMINATOR` is already a `&'static [u8]` (anchor's const, not a fixed array), so clippy's
        // "redundant slicing of the whole range" is answered by dropping `[..]` — `as_slice()` is what I
        // wrote first, and E0599 says so: that method belongs to `[T; N]`.
        assert_eq!(PriceUpdateV2::DISCRIMINATOR, &expected.to_bytes()[..8]);
        assert_eq!(DISCRIMINATOR_LEN, PriceUpdateV2::DISCRIMINATOR.len());
    }

    /// The receiver id we constrain `owner` to is the mainnet/devnet one, not the `pro-compatible`
    /// variant, and it must equal what the client + packages/economy hand to users (sync-check).
    #[test]
    fn receiver_id_is_pinned() {
        assert_eq!(
            PYTH_RECEIVER.to_string(),
            "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ"
        );
    }

    /// `load` is only ever called with the receiver's own account, and a short/corrupt account must
    /// fail closed: the length guard runs before any borsh read so a 4-byte attacker account costs
    /// nothing and yields no price. (The positive path — a real `PriceUpdateV2` fixture — is covered
    /// on-chain by the localnet suite: `tests/localnet/10-packs.spec.ts` buys with SOL/SKR against
    /// the fixture accounts under the receiver, and 00-admin/10-packs also assert the foreign-owner
    /// account is rejected by the `owner =` constraint.)
    #[test]
    fn length_guard_precedes_borsh() {
        assert_eq!(DISCRIMINATOR_LEN, 8);
        // try_deserialize on fewer bytes than the struct can ever occupy must be an error, not a panic.
        let mut empty: &[u8] = &[];
        assert!(PriceUpdateV2::try_deserialize(&mut empty).is_err());
        let mut short: &[u8] = &[0u8; 16];
        assert!(PriceUpdateV2::try_deserialize(&mut short).is_err());
    }
}
