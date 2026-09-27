# Bubblegum V2 migration plan — full closed marketplace

**Status:** architecture locked; phases 1–2 proof primitives are implemented. This document is a release gate, not a claim that the migration is complete.

Phases 1–2 currently include the admin-owned `BubblegumTreeMeta` binding, the client/backend PDA and decoder mirrors, the pinned `mpl-bubblegum 2.1.1` dependency, canonical V2 leaf reconstruction, a direct Account Compression `verify_leaf` CPI, one-time staged compressed-mint claims, strict V2 DAS hash/flags/proof normalization, negative transport checks, a claim-bound `MintV2` CPI, and a draft custom Bubblegum `TransferV2` market path. The transfer path is not a release claim: generated-CPI compilation, localnet execution, settlement recovery, and freeze/thaw/burn CPIs remain gated. The historical MPL-Core `open_pack` mint path now fails closed with `CompressedMigrationRequired`; it is retained only as migration-reference code, not as a fallback.

## Scope decision

The project will migrate every chip to Metaplex Bubblegum V2 compressed NFTs. The application will operate a **closed/custom marketplace** until external wallet and marketplace transfer support is verified. The project must not be advertised as production-ready while any migration gate below is open.

The current Core asset model is not retained as a second ownership source. `ChipState.asset` remains the logical cNFT asset identifier, but ownership is authoritative only when the current Bubblegum V2 leaf and proof are verified.

## Compatibility baseline

- The workspace currently targets Anchor `0.31.1` and the Solana 2.x dependency family. The Bubblegum crate must therefore be pinned to the last compatible V2 line (`mpl-bubblegum 2.1.1`) until the whole workspace is deliberately upgraded. Do not silently select the latest `3.x`: it requires Anchor 1.x and `solana-program 3.x`.
- All V2 trees use `LeafSchemaV2`, `createTreeV2`, and MPL-Core collections. V1 trees and legacy Core assets are not accepted by the new paths.
- Every operation that replaces a leaf obtains a fresh DAS asset and proof. A proof is single-use from the application's perspective: after transfer, freeze, thaw, delegate, burn, or update the indexer must refetch it.
- The deployed DAS provider is part of the trust and availability boundary. Its URL, commitment, timeout, response schema, and fail-closed behavior are configuration and release evidence.

## Tree and collection layout

The first production topology is one V2 tree per collection. This avoids mixing collection authorities, keeps proof/account lists bounded, and lets a collection pause independently. `create_bubblegum_tree` initializes each Bubblegum V2 TreeConfig through the chip_core CPI with the collection metadata PDA as both tree creator and delegate; the operations transaction only preallocates the Merkle storage account with Account Compression as owner. Initial parameters are:

| Parameter | Initial value | Rationale |
|---|---:|---|
| max depth | 20 | capacity of about 1,048,576 chips per collection |
| canopy | 13 | leaves room for proof accounts while keeping leaf replacement composable |
| collection | existing MPL-Core collection | Bubblegum V2 collection integration and permanent delegates |
| tree authority | collection administration PDA | only the controlled mint pipeline can mint |
| leaf owner | player wallet | the program never becomes the cNFT owner |
| leaf delegate | player wallet unless a deliberate delegate is configured | no implicit backend custody |

The exact depth/canopy pair is not final until the localnet transaction-size and CU benchmark is recorded. Smaller trees are valid for a staging tree. Tree rent is an upfront treasury liability and is reported separately from per-mint cost.

`CollectionMeta` will gain the tree config, merkle tree, tree authority, max depth, and canopy references. Existing `core_collection` remains the V2 collection reference; it is not an NFT account.

## On-chain state and proof contract

The new `CompressedChipState` projection carries the immutable location tuple (the legacy `ChipState` layout is not silently decoded as a compressed account):

- `asset` — Bubblegum asset id, used as the logical chip key and PDA seed;
- `merkle_tree` — the V2 tree account;
- `leaf_index` — the leaf index returned by DAS;
- `leaf_nonce` — the current leaf nonce;
- `data_hash`, `creator_hash`, `collection_hash`, `asset_data_hash`, `leaf_flags` — the commitments needed to reconstruct and authorize a V2 leaf replacement.

A `CompressedMintClaim` binds buyer, collection, rarity, level, and game index before registration. After proof verification it remains as the persistent economic receipt and ownership-transition anchor; it is only closed by the existing explicit terminal claim lifecycle. It also stores an immutable `origin` key used for canonical claim-PDA derivation; `buyer` is the mutable current owner used by authenticated market/staking transitions. A transfer therefore changes ownership without changing the claim account address. This prevents a permissionless cranker from registering an arbitrary valid cNFT as a high-rarity game item.

**Tradability invariant (SEC-F01):** a claim that is still bound to a live `CompressedPackSettlement` (`claim.settlement != Pubkey::default()`) may be listed/sold **only after it is minted AND registered**; the rule is enforced in `set_compressed_claim_listed` and `transfer_compressed_claim`. Selling it earlier is forbidden because it would brick the settlement permanently: `register_compressed_chip` requires `settlement.buyer == claim.buyer`, and `cancel_compressed_claim` derives the settlement/pending/claim PDAs from one signer with `has_one = buyer` — after a transfer, nobody satisfies either. Staged claims (`settlement == default`) are exempt and tradeable pre-mint. Regression tests: `tests/localnet/60-cross.spec.ts` X08–X10.

Current leaf owner/delegate are **not cached as authority**. They are read from the DAS response supplied by the transaction builder and checked against the signed owner/delegate and the Bubblegum CPI. A stale owner or stale root must fail closed.

Every replacement instruction carries:

1. the tree config and merkle tree accounts;
2. the current root, leaf index, nonce, data hash, creator hash, collection hash, and asset data hash;
3. the reconstructed V2 metadata args;
4. proof node accounts as remaining accounts, in the exact order expected by Bubblegum;
5. the owner/delegate signer or an explicitly configured permanent collection delegate.

The CPI, not a locally invented ownership parser, is the final proof check. The program additionally checks that the supplied tree, asset id, collection, and stored location match `ChipState`.

## Mint pipeline

Minting cannot assume that a CPI returns an asset account or a stable asset id. The migration uses a staged claim pipeline:

1. Operations preallocate the Merkle storage account; the admin calls `create_bubblegum_tree`, which initializes the Bubblegum V2 TreeConfig and records the tree binding while signing as the collection PDA.
2. The migration foundation stages one `CompressedMintClaim` binding buyer, collection, rarity, level, and game index. The claim is bounded to seven days and has a one-time `minted` bit.
3. `mint_compressed_chip` validates the claim, configured tree/collection, Bubblegum TreeConfig PDA, fixed CPI program IDs, and collection/tree-delegate PDA policy, then invokes Bubblegum V2 `MintV2` with a collection CPI signer. The leaf owner and delegate are the buyer.
4. DAS indexing resolves the new asset id, leaf index, nonce, hashes, owner, and proof. DAS remains asynchronous: the mint CPI does not pretend to know the finalized leaf coordinates.
5. `register_compressed_chip` verifies the DAS-derived V2 leaf with Account Compression, checks the claim and player owner, creates `CompressedChipState`, and marks the claim registered without closing it; the persistent claim is required for later market/staking/fusion transitions. The claim's soulbound window becomes the chip's (`chip.lock_until = claim.lock_until`), and `CompressedChipRegistered` carries that `lock_until` (H1) — the indexer cannot derive it from any other event, and without it a locked chip would read as `free`.
6. The old MPL-Core `open_pack` route is explicitly disabled. `open_compressed_pack` now moves the roll/pending-pack settlement into a Bubblegum-aware asynchronous state machine; `CompressedPackSettlement` and its recovery protocol are described below. No release may use the gated route as a fallback.

A registration delay leaves a minted claim recoverable and retryable but does not mint another chip. An unminted claim can be cancelled only after its deadline. Replay protection is the `(pending, pack_no, slot)` claim PDA plus the asset id. This is intentionally not an optimistic “event says it minted” path.

## Lifecycle flows

- **Ownership / arena:** use the leaf proof and current leaf owner; never parse `BaseAssetV1` or read a nonexistent cNFT account.
- **Freeze / thaw:** call Bubblegum V2 freeze/thaw with the permanent collection delegate. Because this mutates the leaf, listing/staking/fusion transitions use a fresh proof on each transaction.
- **Transfer:** custom market settlement uses Bubblegum `transferV2` under the configured permanent transfer delegate. The buyer receives the leaf; the indexer waits for DAS convergence before marking ownership final.
- **Market:** the claim and asset listings settle in **SOL only** until the settlement path grows SPL legs: `buy_compressed` / `buy_compressed_asset` pay the seller with lamport transfers and answer `CompressedCurrencyMismatch` for any other currency, and both `list_compressed*` handlers refuse a non-SOL currency before the listing exists (SEC-B28 — a listing the buyer can never fill would still flag the claim `listed` and close its mint/fusion paths in chip_core). The old one-transaction Core unfreeze + transfer flow is removed. Settlement becomes a two-phase state machine: reserve payment, perform Bubblegum transfer, then finalize only after the new owner/proof is observed. Expired or failed transfers are refundable by an explicit timeout policy.
- **Staking:** compressed stake now carries the registered leaf location, owner/delegate, current V2 leaf commitments, and Account Compression proof nodes; reward accounting never trusts a stale owner supplied by the client. Unstake remains claim-bound because the market and stake flags block leaf ownership changes while staked.
- **Fusion:** material proofs are fetched immediately before burn. A failed or stale proof aborts without consuming the material. Results are minted through the same register pipeline. Multiple-tree fusion is supported only after the proof/CU benchmark passes.
  **Claim-path invariant (SEC-G03):** `fuse_compressed_claims` (three claim PDAs in, one result claim out, no proofs) accepts only *settlement-free* materials — `claim.settlement == Pubkey::default()`, i.e. admin-staged claims and earlier fusion results. A pack claim still bound to a live `CompressedPackSettlement` is refused with `InvalidChipState`: the instruction consumes a material without closing it and never sees its settlement, so a consumed pack claim would have stayed cancellable after `expires_at` (`cancel_compressed_claim` now also requires `!consumed`) and `finalize_compressed_pack` would have refunded the pack's pro-rata price while the fusion result stayed with the buyer. Pack chips fuse only through mint + register and the proof-based path above. The instruction emits `CompressedClaimsFused` (SEC-G04) so quests, the activity feed and the websocket see claim-path fusions exactly like `ChipFused`. Regression test: `tests/localnet/60-cross.spec.ts` X11.
  **Randomized claim fusion (H3):** recipes below 100 % go through `fuse_claims_commit` (randomness kind 3, fee escrowed, materials consumed at commit) → `fuse_claims_reveal` (real roll, `refund_on_fail` survivors un-consumed, result claim created on success, fee burned either way). The commit emits `ClaimFusionCommitted` (no projection row — the wallet touch only); the reveal emits `ClaimFusionRevealed`, which lands in the `fusions` table with the real roll/threshold (`result` NULL on failure) and ships on the websocket as `chip_fused`, so quests, the fusion board, the feed and the toast treat it exactly like `ChipFused`. Regression tests: the H3 scenarios in `tests/localnet/20-fusion.spec.ts` (success / failure-survivor / commit gates / stale refund / expired-shell close).
- **Arena:** compressed squad membership is validated from each registered leaf's owner/delegate, location commitments, and Account Compression proof nodes; a client cannot substitute a claim or asset id for an owned leaf. Legacy Core squads retain their separate path until the closed migration gate is complete.
- **Burn:** all burns are explicit Bubblegum V2 burns and the projection waits for the DAS state transition before deleting ownership data.

## Backend and client

`backend/src/das.ts` is the only DAS transport surface. It must:

- issue `getAsset` and `getAssetProof` through the configured provider;
- validate owner, delegate, tree, root, hashes, leaf id, proof length, and base58 byte lengths;
- reject uncompressed responses and require the V2-only collection/asset-data hashes and exact flags byte;
- ensure the asset tree matches the proof tree;
- return normalized proof inputs to transaction builders;
- expose provider latency/errors without treating an unavailable indexer as “asset not owned”.

The client and backend transaction builders will use the same normalized proof schema. Account decoders will remove `decodeCoreAssetHeader`; Core fixtures and `mpl_core.so` are removed from the cNFT test path. The UI displays DAS content but never uses display JSON as an authority decision.

## Release gates

The migration is not complete until all of these are checked:

- Bubblegum V2 crate and IDL compile with the workspace toolchain;
- one localnet tree fixture and one collection fixture reproduce V2 mint/transfer/freeze/thaw/burn;
- adversarial tests reject foreign trees, foreign collections, stale roots, mismatched leaf indices/nonces/hashes, wrong owners/delegates, reused registration claims, forged DAS JSON, and proof truncation;
- market payment cannot be permanently captured by a failed or delayed transfer;
- fusion, staking, and arena use current proof data and cannot bypass frozen/listed/soulbound flags;
- DAS outage and reorg/reconciliation behavior is documented and tested;
- transaction-size/CU/rent benchmark is recorded for each tree topology;
- client decoder, backend projection, localnet fixtures, and devnet smoke test all use V2;
- security tests pass, oracle/randomness evidence is refreshed, and the external Solana/Metaplex audit is complete.

Until then, the previous Core implementation is not silently considered migrated, and the production gate remains red.

## Async pack settlement and recovery

A compressed pack is not settled in the `open_compressed_pack` transaction. The
handler creates one `CompressedMintClaim` per rolled chip and binds all claims
to `CompressedPackSettlement`. Bubblegum minting and DAS proof registration are
permissionless follow-up operations. `finalize_compressed_pack` may close the
purchase only when `registered_claims + cancelled_claims == total_claims`.

An unminted claim can be cancelled by the buyer after its claim deadline. A
minted claim is never refundable: its registration remains retryable after the
DAS SLA so the application cannot refund a buyer who already owns a compressed
leaf. Mixed outcomes settle pro-rata by claim count: the registered share keeps
normal revenue and `$CG` burn economics, while the cancelled share is refunded.
This is intentionally custom settlement behavior, not a claim of compatibility
with external marketplace transfer/trade flows.

The backend now stores `compressed_settlements` and `compressed_claims` as
rebuildable projections. They track claim-created, mint, registration,
cancellation, and final-settlement events without treating DAS display data as
authority.

SEC-B31 widened that to the claim's *own* state: `compressed_claims.claim` holds
the claim PDA (seeded `["compressed_claim", origin, nonce_le]`, so it resolves for
a leaf registered later), and `owner` / `listed` / `staked` / `price` / `currency`
carry what `CompressedClaimListedSet`, `CompressedClaimStakedSet`,
`CompressedClaimTransferred` and the claim market's `CompressedClaimListed` /
`CompressedClaimSold` say — the only source of that state, since a claim has no
Core `ChipFlagsChanged`. The V2 asset market (`CompressedAssetListed` /
`CompressedAssetSold`) writes the asset-keyed `listings` / `sales` rows the
registered leaf trades through, and `Staked{kind:1}` — whose `key` is the claim
PDA — is resolved to the chip its flag lives on. A pre-mint claim listing is the
one thing that is not in `listings`: that table is asset-keyed and every read of it
joins `chips`, so it lives on the claim row until the leaf exists.

SEC-B34 added `claim: Pubkey` to `CompressedChipMinted` and `CompressedChipRegistered`
(appended last — borsh is positional, so every earlier offset is unchanged). Those
two events name the claim's *current holder*, and `buy_compressed_claim` changes it:
a claim bought before its mint is minted and registered by the buyer, so with no PDA
in the event the indexer had no join key back to its row (keyed by the immutable
origin) and produced no `chips` row at all. `projections.ts` resolves the row through
`resolveClaimPda` — PDA first, holder-keyed fallback for a log from an older build —
and keeps the program's own owner guard (`register_compressed_chip` requires
`claim.buyer == owner`). SEC-B35 wired both compressed markets and the claim's own
flag flips onto the client's invalidation keys (`listing_changed` / `sale` /
`stake_changed`); before that they shipped under their snake_case names, which the
client's `INVALIDATE` table does not know, so a compressed trade refreshed nothing.

Operational requirements before release:

- monitor claims nearing expiry and submit cancellation/finalization transactions;
- retry proof registration for minted claims after indexer delays;
- test SOL, USDC, SKR, and `$CG` refund paths, including mixed registered /
  cancelled claims;
- verify counters, liability release, account closure, and duplicate-cancel
  resistance on localnet.
