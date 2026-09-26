# GUTTERCAPS on-chain programs

Four Anchor 0.31.1 programs (+ a test-only mock). Design rationale and threat model: [`docs/03-architecture.md`](../docs/03-architecture.md).
Economy numbers are mirrored from [`packages/economy`](../packages/economy) and checked by `npm run economy:check` (textual diff of every constant + 64 golden VRF-expansion vectors replayed by `cargo test -p chip_core --test golden`).

| Program | Path | Holds | Upgrade authority |
|---|---|---|---|
| `chip_core` | `programs/chip_core` | 10 MPL-Core collections + Bubblegum V2 trees, pack sales vault, pity, claim-fusion, `ChipState`/claims (legacy Core-asset paths retained; pack Core-mint fail-closed) | Squads 3/5 + 48 h timelock |
| `market` | `programs/market` | claim + cNFT listings (TransferV2 settlement, draft — docs/11; legacy Core freeze-in-place), USDC offer escrows | Squads 2/5 |
| `staking` | `programs/staking` | **$CG mint authority** (`["emission"]`), token/chip pools, Merkle reward roots ($CG kinds 2–4), **SKR prize pool** (`["skr_pool"]`, SKR kinds 5–7, treasury-funded — never minted) | Squads 3/5 + 48 h timelock |
| `arena` | `programs/arena` | $CG wager escrows, oracle daily-cap breaker | Squads 2/5 |
| `sb_mock` | `programs/sb_mock` | **localnet only** — Switchboard On-Demand stand-in (same discriminators / metas / 480 B `RandomnessAccountData`; `randomness_reveal` accepts any signature; extra `set_raw` for negative tests). Built from `tests/localnet/fixtures/sb_mock-keypair.json`; its id `ApDh35…` is what `chip_core::randomness::SB_PROGRAM_ID` resolves to under `--features localnet`. Never deployed to devnet/mainnet. | — |

`legacy/chip-game` (outside this directory, on purpose) is the v0.1 monolith, kept for reference only. It
must not be moved back under `programs/`: the Anchor CLI decides what to build by scanning `programs/*`, not
by reading `[workspace]`, and the monolith's dependency set is unresolvable on its own — see `Cargo.toml`.

## Status — read this first

**Written without a compiler; compiling green in CI since run 79 (2026-09-18).** The `programs` job runs
`cargo fmt --check` + `anchor build` (including `--features localnet`) and uploads the SBF `.so` + IDL as
artifacts; the `rust-lints` job runs `cargo clippy -- -D warnings` + `cargo test --workspace` (31 `#[test]` +
`tests/golden.rs`); the `localnet · 92 scenarios` job runs the acceptance suite on those artifacts — all green,
most recently on run 36011382496 (2026-09-24). The authoring environment had no Rust/Solana toolchain and no
network access to crates.io, so the code was written against the documented APIs of:

- `anchor-lang 0.31.1`, `anchor-spl 0.31.1`
- `mpl-core >=0.11.1, <0.12` (`default-features = false, features = ["anchor"]`) — 0.12.1 is what this was
  written against, and 0.11.2 is what the SBF toolchain actually resolves (pinned in `Cargo.lock`): 0.12 pulls `solana-program ^3`
  and an edition-2024 manifest that the image's cargo 1.79 cannot parse (`docs/09` §1.4) — `CreateV2CpiBuilder`, `CreateCollectionV2CpiBuilder`, `UpdatePluginV1CpiBuilder`, `BurnV1CpiBuilder`, `TransferV1CpiBuilder`, `BaseAssetV1::from_bytes`
- `switchboard-on-demand 0.13.0` (`features = ["anchor"]`, chip_core only) — `RandomnessAccountData::parse` wrapped by `chip_core::randomness` (owner check + `seed_slot`/`reveal_slot`/`value` rules shared with arena via the cpi dependency; never `get_value(slot)`)
- `pyth-solana-receiver-sdk =1.0.1` — `PriceUpdateV2::get_price_no_older_than`

**Phase 6 security review (`docs/06-acceptance-security-testing.md` §2) found three critical issues in the commit-reveal path that must be fixed before the first devnet deploy — do not test-drive the flow as-is:**

- **SEC-C1** — *fixed, compiled, covered (T-L-C10/F06/A05)*: every randomness read goes through `chip_core::randomness::{parse_checked, assert_fresh_commit, revealed_value, assert_refundable}`; `SB_PROGRAM_ID` is selected by cargo feature — build with `anchor build` (mainnet `SBond…`), `anchor build -- --features devnet` (`Aio4…`) or `anchor build -- --features localnet` (`sb_mock` `ApDh35vcLCxXc5ivaRGFhayn1HduJ9b2nXbfR6WMpVKH`). Never deploy a mainnet-feature build to devnet: the owner check would reject every real randomness account.
- **SEC-C2** — *fixed, compiled, covered (T-L-C08/C09/C12)*: `PendingPack` persists `revealed`/`value` (179 bytes since #28 — `voucher`/`voucher_odds`/`soulbound_days`; decoders accept the legacy 159 B layout) at the first `open_pack`; packs 2…N never read the oracle account.
- **SEC-C3** — a buyer could peek at the reveal off-chain and take a 100 % refund instead → free re-rolls. **Fixed (parts 1–2), compiled, covered (T-L-C17..C20):** (1) `STALE_PACK_SLOTS = 10 800` (≈ 72 min, after the oracle's 1 h reveal window) and `cancel_stale_*` require `reveal_slot == 0` + `seed_slot == commit_slot`; (2) randomness accounts are **program-owned**: PDA `["rng", kind, owner, nonce]` with Switchboard `authority = ["rng_auth"]`, created by `init_randomness` / `init_battle_randomness` (CPI `randomness_init`), committed **inside** `buy_pack` / `fuse` / `create_battle` (CPI `randomness_commit`, one commit per account — `RandomnessUsed`), revealed by the permissionless `reveal_randomness` / `reveal_battle_randomness` (CPI `randomness_reveal`, PDA-signed) and closed by `close_randomness` / `close_battle_randomness` (rent back to the player, SEC-M7). The buyer can neither re-commit nor withhold the reveal. **Still to do:** the devnet run T-D-04 (part 3, the backend crank, is `backend/src/crank.ts`).

Post-G-0 build notes: the expected first-compile defects (mpl-core builder drift, `remaining_accounts` lifetimes, `InitSpace` on `[PackDef; 4]`) were worked through in runs 76–79; a local `anchor build` today should be clean — if not, the drift is in the local toolchain, not the code. Then run the golden test and the localnet suite (`tests/localnet/`, see its README — Switchboard is mocked by `programs/sb_mock`, not cloned).

## Build

```bash
rustup toolchain install 1.89.0            # pinned in rust-toolchain.toml
cargo install --git https://github.com/solana-foundation/anchor avm --locked && avm install 0.31.1 && avm use 0.31.1
sh -c "$(curl -sSfL https://release.anza.xyz/v2.1.0/install)"

anchor build
anchor keys sync                            # rewrites declare_id! + Anchor.toml
# then update the three constants in programs/chip_core/src/instructions/chip.rs
# (MARKET_PROGRAM_ID / STAKING_PROGRAM_ID / ARENA_PROGRAM_ID) and rebuild.

cargo test --workspace                      # host unit tests incl. tests/golden.rs and sb_mock's layout tests

# localnet acceptance suite (tests/localnet/README.md): 92 scenarios on the real client builders
npm run localnet:build                      # = scripts/anchor-build-localnet.sh: --features localnet, the pinned
                                            # sb_mock keypair, the solana-install → agave-install shim and the
                                            # solana_version check (a bare `anchor build` trips on all three)
npm run localnet:fixtures                   # mpl_core.so dump for the in-process back-end
npm test                                    # LiteSVM (slot/clock control, forged accounts) — default
anchor test                                 # = npm run test:validator: solana-test-validator + clones + Pyth genesis fixtures
```

## Cross-program contracts

```
market ──set_chip_flag(F_LISTED)──▶ chip_core ──UpdatePluginV1(PermanentFreeze)──▶ mpl-core
market ──deliver_sold()───────────▶ chip_core ──unfreeze + TransferV1(PermanentTransfer)──▶ mpl-core
staking ─set_chip_flag(F_STAKED)──▶ chip_core
market ──set_compressed_claim_listed / transfer_compressed_claim──▶ chip_core   (V2 claim listings; docs/11)
staking ─set_compressed_claim_staked──▶ chip_core                          (V2 claim staking; docs/11)
arena ───level_up()───────────────▶ chip_core            (arena_auth PDA; XP from season roots)
chip_core / market / arena ──report_burn()──▶ staking    (burn_reporter PDAs; feeds the emission guard)
staking ─grant_booster()──────────▶ chip_core            (rewarder PDA; quest claims)
chip_core / arena ──randomness_{init,commit,reveal,close}──▶ Switchboard On-Demand   (rng_auth PDA = account authority; SEC-C3 part 2)
```

Callers are authenticated by PDA seeds (`["market_auth"]`, `["stake_auth"]`, `["arena_auth"]`, `["burn_reporter"]`, `["rewarder"]`) derived from the hard-coded program IDs — no config-driven allowlists that an admin key could widen.

## Emergency pause (SEC-H2)

Each pausable program (`chip_core` → `GameConfig`, `staking` → `EmissionState`, `arena` → `ArenaConfig`) has two admin-side roles:

| Instruction | Signer | Effect |
|---|---|---|
| `set_pauser(pauser)` | admin | designate the hot key (`Pubkey::default()` clears it) |
| `pause()` | **pauser or admin** | `paused = true` only, idempotent, emits `PauseChanged{by, paused: true}` |
| `set_paused(bool)` / `set_arena(paused: Some(_))` | admin | the only way to lift a pause |

The pauser is meant to be a Squads 1/3 of on-call phones with no timelock, so the runbook target (≤ 10 min from alert to pause) is achievable while the admin stays behind the 48 h timelock. What a pause blocks / keeps open is unchanged: `buy_pack`, `fuse`, `stake_*`, `tick_day`, `publish_root`, `claim_root`, `create_battle`, `accept_battle` stop, and so do their compressed twins that carry the same `!paused` checks (`fuse_compressed_claims`, `fuse_claims_commit`, `mint_compressed_chip` — `compressed.rs`); `open_pack`, `open_compressed_pack`, `cancel_stale_*`, `unstake_*`, `resolve_battle`, `cancel_stale_battle`, `close_*_randomness` and the whole market keep working so nobody's funds are trapped by the switch. The indexer records every `PauseChanged` in `pause_changes`; `GET /v1/health` shows the latest state per program.

## Pack flow (commit → reveal), one purchase

1. Client: `chip_core.init_randomness(0, nonce, finalized_slot)` + `chip_core.buy_pack(sku, qty, currency, nonce, max_lamports)` in **one** tx (one signature; no client-side keypair).
   - `init_randomness` CPIs Switchboard `randomness_init` for the PDA `["rng", 0, buyer, nonce]` with `authority = ["rng_auth"]`; the buyer pays the rent (account + wSOL escrow + LUT).
   - `buy_pack` CPIs `randomness_commit` with the PDA signature (queue pinned to `randomness::SB_QUEUE`, oracle chosen client-side via `Queue.selectRandomnessOracle()`), then enforces `seed_slot == slot-1` and not-yet-revealed; the randomness key + `commit_slot` are pinned in `PendingPack`.
   - Payment + rent reserve go to the `["vault"]` PDA / `PendingPack`; `VaultLedger[buyer[0] % 4].liab_*` increases (#12 — `GameConfig` is read-only on every player path; the four ledger shards are created once by `init_ledger`, `npm run setup -- --step ledgers`).
2. Crank (ours or anyone): fetch the oracle reveal from its gateway (SDK `revealIx` payload) → `chip_core.reveal_randomness(signature, recovery_id, value)` (permissionless, CPI `randomness_reveal` signed by `rng_auth`) + `open_pack(nonce, pack_no)` per pack in the bundle (V2 path: `open_compressed_pack` settles each pack to claim-bound records first, `mint_compressed_chip` follows — see `docs/11`).
   - The crank pre-simulates `expand()` with the revealed bytes to know which `CollectionMeta` accounts to pass; the program re-derives and rejects mismatches.
   - Assets are PDAs `["asset", pending, pack_no, i]` → retries can't double-mint.
   - Rent is reimbursed from the reserve; last pack settles $CG burn/split and closes `PendingPack`.
3. If the oracle never reveals: after `STALE_PACK_SLOTS = 10 800` (≈ 72 min — the oracle's 1 h reveal window plus margin) `cancel_stale_pack` refunds 100 % from the vault (any currency, no admin), and only if `reveal_slot == 0` (SEC-C3 part 1, owner decision Q3).
4. Once `PendingPack` is closed (opened or refunded), anyone — the player from the UI ("Reclaim rent") or the crank — calls `close_randomness(0, nonce)`: CPI `randomness_close` returns the account + escrow rent to `rng_auth`, which forwards it to the buyer in the same instruction (SEC-M7). Still open from SEC-C3: the LUT rent (#23) — the backend crank (backlog #15) is `backend/src/crank.ts`.

## Fusion flow

- Recipes 0–3 (100 %): `fuse` burns 3, mints 1 atomically (`PendingFusion` closed in the same ix).
- Recipes 4–7: `init_randomness(1, nonce, slot)` + `fuse` in one tx — `fuse` freezes materials (`F_FUSING`), **escrows the fee** in the vault's $CG ATA (`PendingFusion.fee_escrowed`, counted in `VaultLedger[owner[0] % 4].liab_cg` so `sweep_vault` cannot touch it — SEC-M3, #12), commits the program-owned randomness by CPI and pins it → `reveal_randomness` (anyone) → `fuse_reveal` burns/mints (or refunds 1 material deterministically: lowest asset key) **and burns the escrowed fee** (`ChipFused.fee_burned`, `BurnReported`). `cancel_stale_fusion` (oracle silent past the window) unfreezes the materials **and returns the fee 100 %**. Atomic recipes pass `None` for the five randomness accounts and burn the fee immediately.
- Booster: `PlayerItems.boosters` (non-transferable), +15 pp, cap 95 %.
- V2 claim twins: `fuse_claims_commit` / `fuse_claims_reveal` / `cancel_stale_claim_fusion` mirror the randomized recipes on claims (see `docs/11`).

## Emission guard (staking)

**Burn feed (SEC-M1).** In v1 none of chip_core / market / arena CPI `report_burn` (their burns are only
events), so the indexer's keeper (`backend/src/burn-oracle.ts`, key = `EmissionState.burn_oracle`, set via
`set_oracles`) sums `BurnReported` + listing fees + `BattleResolved.rake_burn` and calls `report_burn(delta)`
hourly. The program clamps `burn_today` to `BURN_SANITY_MULT (3) × daily_schedule_cap`, so the oracle can only
move the guard between the 30 % floor and 100 % of the schedule — it never mints and never exceeds the cap.
Unstake penalties are recorded in-program (`record_internal_burn`) and are not reported again.

Daily `tick_day` (permissionless): `budget = min(schedule(year), 0.30·schedule + 1.25·avg(burn_ring[7]))`, further capped by the year's remaining allowance. Pools receive `budget_per_sec` for the next 24 h; quests/PvP/events slices accumulate in `slice_budget` and are only released through `publish_root` (oracle-specific, ≤ slice budget, 1 h timelock, admin-revocable) → `claim_root` (Merkle leaf = `keccak(0x00‖wallet‖amount‖kind‖epoch)`). **All minting goes through `mint_to_user`, which enforces both the yearly cap and the cumulative cap.**

## SKR prize pool (staking, `instructions/skr.rs`)

SKR (Seeker) is the second reward currency. Its mint authority is Solana Mobile's Squads vault, so the game can neither mint nor burn it; rewards are paid from a **treasury-funded pool** instead of an emission schedule:

- `SkrPool` (`["skr_pool"]`): `skr_mint`, `vault` (token account owned by the PDA), `budget`, `reserved`, `funded_total`, `paid_total`, `max_root_budget` (default 100 000 SKR), `paused`. Invariant: **`vault.amount ≥ budget + reserved`**.
- `init_skr_pool` (admin, once) · `fund_skr` (anyone; the treasury wallet `HPMr5r9sS5ApWsPNJytZRLbm2jz1veFxTn1wepjAhtho` runs it weekly with 15 % of realised SKR pack revenue, 10 % of the treasury part of SKR market fees, 5 % of SKR services revenue — owner policy, `packages/economy/src/skrRewards.ts`; `npm run skr-pool -- plan` computes the amount) · `sync_skr_pool` (absorb direct transfers) · `withdraw_skr` / `set_skr_pool` (admin; only unreserved `budget` can leave).
- `publish_skr_root(kind 5|6|7, epoch, root, budget)` — quest oracle for 5, season oracle for 6/7; `budget ≤ min(pool.budget, max_root_budget)`; moves `budget → reserved`. Same `["root", kind, epoch]` PDA family and the same leaf format as $CG roots (the `kind` byte in the leaf prevents cross-currency replay). `revoke_skr_root` returns the unclaimed remainder to `budget`.
- `claim_skr_root(amount, proof)` — after the shared 1 h `ROOT_TIMELOCK`; `token::transfer` from the vault signed by the pool PDA; `reserved −= amount`. `claim_root` rejects kinds ≥ 5 and `claim_skr_root` rejects kinds < 5 (`WrongRootCurrency`), so neither path can ever reach the other currency.
- Events: `SkrFunded{funder, amount, budget, reserved}`, `SkrWithdrawn{to, amount, budget}`, `SkrPoolChanged{max_root_budget, paused}`; `RootPublished/RootRevoked/RootClaimed` are shared (kind 5..7 ⇒ SKR, kind 8 ⇒ items). The backend exposes the ledger at `GET /v1/rewards/skr-pool`.

Item roots (kind 8, backlog #27) deliver quest **fusion boosters** through the same Merkle machinery (`programs/staking/src/instructions/items.rs`):

- `publish_item_root(kind 8, epoch, root, budget)` — quest oracle only; the leaf amount is a booster COUNT, `0 < budget ≤ MAX_ITEM_ROOT_BUDGET` (1 000). No slice or pool is debited — the per-root cap is the whole blast radius of a leaked oracle key inside the revoke window.
- `claim_item_root(amount, proof)` — same proof / timelock / `ClaimReceipt` as the token claims, `amount ≤ MAX_ITEM_CLAIM` (10); delivery is a CPI `chip_core::grant_booster(amount)` signed by staking's `["rewarder"]` PDA — the authority chip_core already accepts next to its admin (`GameConfig.staking_program`) — into `PlayerItems` `["items", wallet]` (created on first claim, payer = wallet). `revoke_item_root` only flips the flag. Kind mismatches on every path → `WrongRootCurrency`; caps → `ItemBudgetExceeded`.

Chip voucher roots (kind 9, backlog #28) deliver quest **chips** through the pack VRF pipeline (`programs/staking/src/instructions/vouchers.rs` + chip_core `open_voucher` in `instructions/packs.rs`):

- `publish_chip_root(kind 9, epoch, root, budget)` — quest oracle only; the leaf amount is the voucher TEMPLATE id (0..3, `VOUCHER_DEFS` = economy `QUEST_CHIP_TEMPLATES`, pinned by sync-check), `budget` is the number of leaves, `0 < budget ≤ MAX_CHIP_ROOT_BUDGET` (500). Nothing is debited.
- `claim_chip_root(amount, proof, nonce)` — same proof / timelock / `ClaimReceipt`; `amount ≤ MAX_CHIP_TEMPLATE` (3) else `ChipBudgetExceeded`; `root.claimed` counts vouchers. Delivery is a CPI `chip_core::open_voucher(nonce, template)` signed by `["rewarder"]`: chip_core creates `PendingPack["pending", wallet, nonce]` with `voucher = true`, `sku 0 / qty 1 / paid_* = 0`, the template odds and `soulbound_days`, takes the 1-chip rent reserve from the wallet and commits the wallet's `["rng", 0, wallet, nonce]` account (so the tx must carry `init_randomness(0, nonce)` first — the `buy_pack` shape) and emits `VoucherIssued`. Then the permissionless `open_pack` mints ONE chip with `PackDef::voucher(odds)` — no floor, no pity (the counter is untouched), `lock_until = now + soulbound_days`; `cancel_stale_pack` refunds only the reserve. `revoke_chip_root` only flips the flag. Kind mismatches → `WrongRootCurrency`; unknown template inside chip_core → `InvalidVoucher`.
- `PendingPack` grew to 179 B (`voucher`, `voucher_odds[9]`, `soulbound_days`); decoders accept the legacy 159 B layout as `voucher = false`.
- Ops: `npm run skr-pool -- init | fund <skr> | sync | status | test-mint` (`scripts/skr-pool.ts`, IDL-free, `DRY_RUN=1` prints the instruction). `init` runs after `init_emission` (pool admin = `emission.admin`); `test-mint` refuses to run on mainnet.


## Price oracle (chip_core, `instructions/packs.rs` + `services.rs`)

**Confidence guard (SEC-M2).** `oracle_price()` is the only reader: after the SDK's age / feed / Full
checks it refuses `conf / price > PYTH_MAX_CONF_BPS` (2 %, `PriceUncertain`) and returns `price − conf`,
so SOL/SKR buyers always pay at the protocol-favouring edge of the interval. Mirrored in
`packages/economy` (`effectivePythPrice`), the API quote (`503 price_unavailable`) and the client.

SOL and SKR payments are converted from USD cents inside the instruction via a Pyth `PriceUpdateV2`
account (`price_update`). The program checks **owner = Pyth receiver** (`Account<PriceUpdateV2>`),
**feed id** (`SOL_USD_FEED_HEX` / `SKR_USD_FEED_HEX`), **Full verification + age ≤ `SOL_PRICE_MAX_AGE_SECS` (60 s)**
via `get_price_no_older_than`, then `units_for_cents()` (floor) and `amount ≤ max_lamports` (client passes quote × 1.01).
It deliberately does **not** check which push-oracle shard the account belongs to.

Owner decision Q7: the studio posts both feeds itself (`ops/pyth-pusher/`, shard **0xCA75**), because the
Pyth-sponsored SOL/USD heartbeat is 55 s (too close to the window) and SKR/USD is not sponsored at all.
`GameConfig.pyth_sol_usd_feed / pyth_skr_usd_feed` are informational defaults for clients without API access —
`init` / `set_params` should carry our accounts:

| Feed | Account (shard 0xCA75, mainnet-beta = devnet) |
|---|---|
| SOL/USD `ef0d8b6f…b56d` | `ELp9x5sFxGJ7zTurykU2p6A9nKDx72b3xzPxfsB5S8GB` |
| SKR/USD `38846ec4…3bf9` | `9bCSdQVWckgKipe4G3G66aYU9yq2ZdDn8kRPZB9Nihbc` |

`npm run pyth-pusher -- set-params-args` prints the `ParamsPatch` layout; `npm run pyth-pusher -- check <rpc>`
verifies both accounts the way the program will (owner / feed / verification / age). Localnet: no pusher — the
suite loads `PriceUpdateV2` fixtures and rewrites `publish_time` per test (backlog #14). Constants are pinned
against `packages/economy/src/oracle.ts` by `npm run economy:check`.

## Phase 4 review notes (client integration)

While writing the TypeScript instruction builders two issues in `chip_core` were fixed:

* `open_pack` — `PermanentTransferDelegate` plugin was pushed **twice** into the asset's plugin list (a Core `CreateV2` with duplicate plugin types fails). Now once.
* `OpenPack.buyer` was not `mut` although `open_pack` credits it with the leftover rent reserve when the last pack of a bundle closes `PendingPack` (`try_borrow_mut_lamports` on a read-only account fails at runtime). Now `#[account(mut, address = pending.buyer)]`.

Client account order (`client/src/chain/ix/*.ts`) mirrors the `#[derive(Accounts)]` structs 1:1; if you reorder fields here, update the builders and `client/src/chain/chain.test.ts`.
