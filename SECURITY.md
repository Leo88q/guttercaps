# Security policy

GUTTERCAPS holds user funds (pack vault, market escrows, wager escrow, staking). Treat anything
touching those paths as a security issue.

## Reporting

Open a **private GitHub Security Advisory** in `Leo88q/caps`
(Security → Report a vulnerability). Never post an exploit in a public issue.
Format we would like (but any working PoC is fine):

`ID · Severity · Program/file:line · PoC (tx log or a tests/localnet spec) · Impact · Recommendation`

## Response SLA (same numbers the external auditor works to — `docs/08-audit-handoff.md` §6)

| Severity | Acknowledged | Triage + plan | Fix + test |
|---|---|---|---|
| Critical / High | ≤ 1 business day | ≤ 2 business days | ≤ 5 business days, then a patched deploy |
| Medium | ≤ 1 business day | ≤ 2 business days | before the next gate (G-2) |
| Low / Info | ≤ 3 business days | — | fixed or accepted in writing |

Every accepted finding gets: a commit with the fix, a test (`tests/localnet/*` or a `#[test]`), and a
row in `docs/06-acceptance-security-testing.md` §2.2 and `docs/08-audit-handoff.md` §3.1.

## Bug bounty

Runs from mainnet launch (Immunefi-style, up to 10 % of the value at risk, capped at $50 k) — the
number the auditor's report is scoped against: total value at risk = pack vault + market/wager
escrows + staking budget.

## Known accepted risks (read before filing)

Recorded decisions, not oversights — see `docs/06` §2.2 and `docs/08` §4.4:

- Arena does not freeze chips during a wager battle (`SEC-L2`); squads are snapshotted.
- Pyth SKR/USD feed is thin: ±2 % confidence guard, 1 % slippage, charge at `price − conf`; no EMA yet.
- The treasury SKR wallet is currently a single-signer hardware key (migration to Squads before launch).
- **SEC-M8: closed (2026-09-27, backlog #23).** `randomness_close_lut` / `close_battle_randomness_lut` now
  reclaim the request's Address Lookup Table rent (~0.0015 SOL per pack / fusion / battle) in both
  programs. The instruction is permissionless but the rent is pinned to the player — Switchboard's
  `recipient` is the owner (the challenger for a battle), the payer only pays the fee — and the table is
  *derived* (`["LutSigner", randomness]` → the ALT address from the slot) and required to be ALT-owned, so
  a caller cannot redirect somebody else's table into their own payout; the table of a live request is
  unreachable because the randomness account must already be closed (no data, system-owned). The
  ~1-epoch ALT cooldown is what makes this a separate, retryable step: the crank sweeps it
  (`Crank.reclaimLuts`, `crank_jobs.lut_slot`/`lut_closed_at`), the player's "Reclaim rent" button tries
  it after the first close, and `tests/security/rent-lut.test.ts` (with mutations) plus localnet C13b
  (refused while pending → rent to the player → a forged slot fails → idempotent) hold the line.
- **SEC-B4: closed (2026-09-26, self-host follow-up).** The landing and the app now render the same
  vendored woff2 files (`client/public/fonts`, 27 files / 503 KB, OFL-1.1 + Apache-2.0 with the licence
  text next to the bytes) and **no font is fetched from a third-party origin at all**: the app imports the
  generated `client/src/shared/ui/fonts.css` (served from `/fonts/` with `?v=<sha8>` and an `immutable`
  cache, `ops/deploy/nginx.conf`), the landing inlines its 13 landing-surface subsets as data URIs. The
  landing's `default-src 'none'` meta-CSP now allows no external `style-src`/`font-src` either, and
  `npm run landing:check`, `npm run fonts:check` and `client/src/shared/ui/fonts.test.ts` fail if a
  font host, a third-party origin or an un-ranged `@font-face` (the bug that silently pushed Russian text
  to a system font) comes back. No residual exposure: the remaining third-party origin on the landing is
  `api.guttercaps.gg`, which is ours.
- **SEC-B8 (2026-09-26): classic SPL Token only, and that is a product constraint.** The programs accept
  only `Program<'info, Token>` and classic token layouts, so a Token-2022 mint (transfer hooks, permanent
  delegate, default-frozen, `decimals` drift) cannot be used as `cg_mint`/`usdc_mint`/`skr_mint` — it fails
  at read rather than misbehaving, which also means **switching to a Token-2022 mint would require a program
  upgrade** (new account layouts + every value flow re-reviewed). `tests/security/token-posture.test.ts`
  fails the build if that posture changes; if a T22 mint is ever wanted, that test is where the decision has
  to be recorded.
- **SEC-B7 (2026-09-26): accounts carry no layout version.** `reports/state-layout.json` freezes the field
  list of all 29 `#[account]` structs and `npm run state:layout` fails when one moves, so a layout change
  cannot land unnoticed — but nothing lets an *existing* account be reinterpreted: if a struct truly has to
  change, the migration is a new account (extra PDA seed or a new type) plus an instruction that copies the
  old bytes across, and it has to be written into `docs/06` §2.2 before `--write` accepts the new baseline.
  `GameConfig.params_version` versions the *economy parameters*, not the layout — do not read it as a
  compatibility guarantee.
- **SEC-B6 (2026-09-26): the API verifier checks rarities, not districts.** `POST /packs/verify`
  recomputes the rarity sequence from the emitted randomness and compares it with the mint, but it cannot
  recompute *which district* a chip landed in: the pool (`collections_created`, the featured district) is
  live chain state that the read model deliberately does not mirror. The response says so (`onChain[i].collection`
  is reported as-is, `assumed`/`note` explain the basis) and the in-browser verifier reads `GameConfig`
  from the chain and does compare districts. Closing the gap fully would mean mirroring the config account
  (an extra RPC dependency for a validation-only endpoint) — not worth it while the client path exists.
- **SEC-B5 (2026-09-26): proof-of-human stays an off-chain heuristic.** The hostname/action/timestamp
  checks close the "solve the challenge on someone else's page" hole (see the audit report), but the pass
  is still a Cloudflare answer plus a client-supplied device fingerprint: an attacker who customises a
  browser can look like a fresh device up to `DEVICE_MAX_WALLETS` wallets, and `flags.trusted` (ops
  decision, audited) bypasses both gates. The economic caps (daily/weekly quest caps, SKR_ANTI_FARM,
  per-IP budgets) are what bound the damage — this is recorded, not forgotten.
- **SEC-B3 (2026-09-26): closed — the marketplace now has a game index.** `chips.game_index` is projected
  (compressed chips from `CompressedChipRegistered`; a core `open_pack` / fused chip from its `ChipState`
  account in batches by `Crank.resolveChipIndexes`). `indexMin`/`indexMax`/`sort=index_asc` are back in the
  contract, the client types and the UI ("Low #"), and a chip whose number is not resolved yet reports
  `index: null` — it sorts last and is excluded by a range filter, never rendered as a placeholder `#0`
  (`#0` is a real chip of that district). Behaviour is pinned by `backend/test/chip-index.test.ts`
  (14 tests, including the in-place upgrade of an indexer DB written before the column existed and a wrong-owner account) and by the
  static gate in `tests/security/api-input.test.ts`.
- **SEC-B12 (2026-09-27): closed — the lockfile now pins the bytes, not just the versions.** 705 of the
  1 097 registry packages in `package-lock.json` carried neither `resolved` nor `integrity`, so `npm ci`
  asked the registry for `name@version` and installed whatever tarball came back — the shape of the
  `@solana/web3.js` 1.95.6/1.95.7 incident, and `@solana/web3.js` was one of the 705. All 1 097 nodes now
  pin `https://registry.npmjs.org/...` plus a sha512 (hashes taken from the tarballs npm actually
  installed and cross-checked against the registry's own packument metadata for that version); the
  declared range was raised to `^1.99.0` because `^1.95.3` still admitted both withdrawn versions.
  `tests/security/supply-chain.test.ts` (8 rules, mutation-tested) keeps it that way: unpinned node,
  foreign/mirror host, sha1 instead of sha512, a withdrawn version in tree *or* inside a declared range,
  a new install script, or a lock/manifest spec drift all fail `npm run security:static`. Verification is
  `rm -rf node_modules && npm ci`: npm checks every hash, so a wrong pin fails the install. Residual,
  recorded: the hashes were bootstrapped from this workspace's npm cache (cross-checked against the
  registry metadata) rather than from an independent third-party mirror, and `npm audit` still covers the
  production tree only — the build/test tree is guarded by the install-script allow-list in that test.

- **SEC-B13 (2026-09-27): closed — "no block time yet" no longer means 1970.** The websocket subscription
  delivers transaction logs without a block time, and the only pass that filled them re-scanned the last
  `LISTEN_HEAL_DEPTH` (200) signatures per program — so anything a longer outage left behind stayed
  undated for good. Every day-bucketed read then disagreed with a rebuild: revenue/spend metrics and the
  daily/weekly quest windows dropped the events entirely, and `staking`'s pending estimate read an undated
  `Claimed` as "claimed at the epoch", i.e. it ignored the newest claim and accrued from an older one —
  showing the player more than they are owed. Three parts close it: a bounded heal pass
  (`INGEST.healEventTimes`) that drains the NULL queue oldest-first through `ingestTx` (so `patchLateTimes`
  re-dates the projection rows too), falling back to `getBlockTime(slot)` when the transaction has left the
  RPC's retention window, with per-row attempt counting (`events_raw.time_heal_attempts`, cap
  `LISTEN_HEAL_TIMES_MAX_ATTEMPTS`) so a permanently unservable signature is parked instead of blocking
  every batch; `/health.untimedEvents` = `{pending, stuck, oldestSlot}` so a stuck row is visible rather
  than silent; and `accrualFrom` now stops the accrual window at an undated claim instead of restarting it
  at the stake's opening. Pinned by `tests/security/time-heal.test.ts` (5 rules, 6 mutations) plus
  behavioural tests in `backend/test/projections.test.ts` and `backend/test/game.test.ts`.

- **SEC-B14 (2026-09-27): closed — the right payment is spent, and it is spent once.** `findPayment`
  returned the first *unconsumed* `ServicePaid` row of the requested kind, so a transaction carrying two
  purchases of the same kind (two cap skins — each with its own `ref_hash`) made the second one
  unclaimable for ever: the caller's `ref_hash` compare rejected the wrong row and the right one was never
  read. It now takes the ref hash the caller is about to grant and prefers the matching row (fallback
  order kept, so a genuine payload mismatch still answers `ref_hash_mismatch`), and both callers
  (`claimHandle`, `claimService`) compute it before the lookup. `consume` was a plain UPDATE whose
  "already used" check lived in the preceding SELECT — a check, not a lock — so two API replicas could
  both read the row as free and grant two entitlements for one payment; it is now a single conditional
  `UPDATE ... AND consumed_by IS NULL` that has to change exactly one row, otherwise `409 payment_consumed`.
  Pinned by `tests/security/paid-claims.test.ts` (4 rules, 4 mutations) and two behavioural tests in
  `backend/test/cosmetics.test.ts` (two same-kind purchases in one tx claimed in reverse order).

- **SEC-B15 (2026-09-27): closed — the load profile is checked against the contract.** LT-1 (the nightly
  load smoke, the only p95 evidence for the public reads) asked for
  `/market/listings?limit=24&sort=price`; `sort` is an enum in the API, so `price` is answered with
  `400 bad_sort` — every iteration of that path measured an error, and the harness's own `read is 200`
  check failed for it. Nothing tied the profile to the spec, so tightening parameter validation could
  always turn the stand into an error generator. Fixed (`sort=price_asc`) and gated: `npm run api:check`
  (the same check that pins spec ⇄ routes) now also requires every path in `scripts/load/lt1.js` to match a
  documented GET, every query parameter to be documented for that operation, and enum-valued parameters to
  use a documented value — mutation-verified by restoring `sort=price`.

- **SEC-B16 (2026-09-27): closed — a finished quest is always settled, whoever finished it.** The oracle
  settles the wallets `quests.activeWallets` names, built from logins, arena matches, fusions, sales and
  chip stakes. Two kinds of wallet with a payout right appeared in none of those sources: a **referrer**
  (its `referrals_paid` metric counts other people's purchases, and it may have no activity of its own at
  all) and a **pack buyer** that completes a district set (`sets_done`) without ever playing. Their quest
  completed in the UI but no `quest_completions` row was ever written — the only route to a Merkle root —
  and for the permanent milestones (`p_referral5`, `p_set1`) that loss was final. `activeWallets` now also
  names buyers of paid packs inside the activity window and the referrers of those buyers; what a wallet
  actually completed is still decided inside `settleWallet` (metrics, period windows, finalized horizon,
  caps). Pinned by the new test in `backend/test/game.test.ts`, mutation-verified by removing both sources.

- **SEC-B17 (2026-09-27): closed — a JSON key is an identifier by construction.** `jsonAt`/`jsonFlagEq`
  bind values but inline the *key* into the statement text, so their safety rested entirely on all call
  sites passing a literal (hidden coupling that one `jsonAt('data', req.query.key)` would break), and the
  two dialect branches disagreed on the security property itself: the Postgres branch escaped a quote in
  the key, the SQLite branch did not, with the old test pinning the raw SQLite output as "escaping". Both
  builders now accept only `^[A-Za-z_][A-Za-z0-9_]{0,63}$` keys and throw otherwise, in both dialects;
  the now-unreachable Postgres escape was removed so it cannot mask a loosened rule. Pinned by the rewritten
  test in `backend/test/sql.test.ts`.

- **SEC-B18 (2026-09-27): closed — handle holds are bounded per wallet, and the check has its own budget.**
  `GET /me/handle/check` is a write-on-read: it takes a 120 s hold that makes the handle read as
  `reserved` for everyone else (that hold is what protects a buyer from paying for a handle someone else
  claims first). Nothing bounded how many holds one wallet could take, and the only limiter was on the
  wrong axis — the read budget is per IP while the hold is per wallet — so one bot could hold hundreds of
  handles for free, refreshing every 2 minutes, and grow `handle_reservations` (rows are deleted only once
  expired) while paying nothing. `HANDLE_MAX_RESERVATIONS = 5` now caps the live holds: beyond it the check
  still answers honestly but takes no hold, and the handle stays free for others; claiming never needed the
  hold to exist. The route also carries its own session policy (`handle-check`, 30/min), and the spec's
  `reason` enum now includes `invalid`, which the code always returned — and that type change exposed the client half of the same drift: the modal labels the reason as `profile.handle.reason.${reason}` and the `invalid` key was missing from every locale (a user typing a bad handle saw the raw key). All seven bundles now carry it. Behavioural and static gates added;
  both mutations (drop the cap, drop the route limiter) fail exactly the expected test.

- **SEC-B19 (2026-09-27): closed — the compressed claim nonce is injective by construction.** A pack claim
  is a PDA over `nonce * STRIDE + pack_no * MAX_CHIPS_PER_PACK + chip_index` with `STRIDE = 128`, and the
  largest bundle a purchase may open keeps that offset at 124 — four short of the stride. Nothing tied the
  three numbers together (128 in `compressed.rs`, 5 in `economy.rs`, a literal 25 in `packs.rs`), so a sixth
  chip per pack or a 26-pack bundle would make two different `(nonce, pack_no, chip)` triples derive the same
  claim PDA. The failure mode is not a double mint: `open_compressed_pack` refuses an account that already
  exists, so one paid pack becomes permanently unopenable, its settlement never reaches `total_claims`, and
  `finalize_compressed_pack` — the only path that releases the vault liability and refunds a cancelled share —
  can never run. Now `MAX_PACK_QTY` lives in `economy.rs`, `buy_pack` bounds `qty` by it, and `compressed.rs`
  carries `const _: () = assert!(MAX_CHIPS_PER_PACK * (MAX_PACK_QTY as usize) <= COMPRESSED_CLAIM_PACK_STRIDE
  as usize);` — a build failure instead of a silent one-in-128 bricked pack. Pinned in both directions by the
  new `SEC-B19` static rule (which also fails if the `assert!` is deleted or the stride shrinks).

- **SEC-B20 (2026-09-27): accepted risk — a DNS/registrar hijack is the one class code cannot close.**
  `ops/deploy/runbook.md` §1.3 fixes the TLS boundary only ("the certificate lives where the DNS lives");
  registrar transfer-lock, DNSSEC and CAA appear nowhere in the repository and cannot be automated from it.
  The Parcl precedent is the shape: take the apex record, serve your own front end from *our* origin, ask for a
  signature. What is already in place is not a defence against that and should not be read as one: the landing
  CSP (`default-src 'none'`, our own fonts — SEC-B4) and the app CSP without third-party script origins
  (SEC-B9) describe the document *we* ship, not the one an attacker serves from our domain, and "the client
  never signs a server-supplied transaction" (SEC-B6/B10) only means a hijacked bundle has to build the drain
  itself. Owner: ops, before G-2 — registrar lock + 2FA, DNSSEC, CAA, short apex TTL, change monitoring, with
  a `dig` transcript in the release checklist as the evidence.
- **SEC-B21 (2026-09-27): accepted risk — Trident fuzzing is not run.** There is no fuzz target and no CI job
  in the tree, which makes this the only part-1 checklist item with no artifact. The class it would cover is
  held today by `cargo test` (golden economy + unit/invariant tests, the `rust-lints` job), the 92 LiteSVM
  scenarios (`localnet`), the 89 static gates with mutation self-tests (`security:static`) and the structural
  invariants in `tests/security/anchor-invariants.test.ts` (SEC-B19 is one of them). Owner: programs, before
  mainnet — targets on `buy_pack` / `fuse` / `market settle` asserting the same "Σ liabilities ≤ vault balance"
  rule the ledgers enforce on chain; until then a new constant or account layout is closed by a compile-time
  `assert!` or a gate, not by hope.

- **Части 1–2 чеклиста (31–70) разобраны по темам — `SECURITY-AUDIT-2026-09-27-checklist.md`.** Отдельный
  файл, потому что строки там идут по темам, а не по номерам: у каждого пункта указано, какой символ
  или гейт его закрывает, а пять пунктов, которые кодом не закрываются (SEC-B20, SEC-B21, порог
  Squads, инсайдер-процесс, ℹ️-неприменимые), вынесены в сводку принятых рисков с владельцами.

- **SEC-B22 (2026-09-27): closed — an admin parameter change now says what it changed, and cannot zero a
  money path.** `set_params` is the single mutation surface for `treasury`, `buyback_wallet`, both Pyth
  feeds, the SKR mint, the pack table, the market fee and the SKR discount, and it emitted
  `ParamsChanged { admin, version }` — a counter. The 48 h Squads timelock and the public diff live
  off-chain, so the on-chain half of "auditable" was missing exactly where it matters: a version bump
  proves *that* something moved, never *what*. An indexer, a watchtower or a user reading the log could
  not tell a fee tweak from a treasury replacement. Two holes, one fix each: every address field is now
  rejected when it is `Pubkey::default()` (the system-program address — a whole revenue path would go
  somewhere unreachable), and `set_params` emits `ParamsPatched` next to `ParamsChanged` with the new
  values plus a bitmask of which fields the patch actually touched (`PARAMS_FIELD_*`, absent fields carry
  the previous value). `ParamsChanged` keeps its shape and its consumers — the admin audit log, the
  `params_changes` projections and the fairness note in `queries.ts` all still read it. The event uses
  scalars only, so the backend codec and the wire layer carry it with no new API type (it maps to the
  existing `params_changed`), and the new `SEC-B22` static rule fails on an unguarded branch, on a missing
  emission, on a bitmask that no longer covers every patch field, or on a codec that drifted from the Rust
  field order — with its own mutation self-test.

- **SEC-B23 (2026-09-27): closed — the admin panel enforces exactly the guard-rails the program does.**
  `backend/src/admin.ts` only *encodes* a Squads transaction, so every rail of `set_params` is mirrored
  by hand in TypeScript — and the mirror had drifted in three places. The five address fields accepted the
  zero key (valid base58, the system program's address): the panel answered `ok`, a human approved the
  multisig, and the transaction could only revert — the tool that exists to validate a treasury silently
  "validated" one that cannot receive a lamport. `priceCgMicro` had no check at all: a negative `BigInt`
  reached the Borsh `u64` writer (two's complement — a wildly different price, and a 500 instead of a
  422), and the SEC-F13 band (the 1 000 000 $CG fat-finger cap and the one-shot ×½–2× move limit) was not
  mirrored. The `params_version` `u16` ceiling (`ChipError::Overflow`) was missing too. Fixed:
  `pubkeyOrBad` returns the `InvalidConfigAddress` violation, `checkPackGuardRails` takes the live row and
  applies the u64 range, the hard cap and the ×½–2× band (integer division, as in Rust), and
  `proposeParams` refuses at `paramsVersion >= 65_535`. The BigInt comparisons live in `CG_PRICE_GUARD`;
  `GUARD` itself stays JSON-safe because `GET /admin/params` returns it verbatim — a BigInt there is a 500,
  a bug this fix would otherwise have introduced. The new `SEC-B23` static rule pins the `ChipError`
  vocabulary of `set_params` (+ `require_non_default`), cross-checks six `economy.rs` constants and five
  inline literals against `GUARD`, requires the live-row comparison, the zero-key check and the version
  ceiling, and forbids a BigInt in `GUARD`; the same rule covers the staking mirror — the panel encodes
  `set_split` by hand too, so `GUARD.split` is checked against the program (`SPLIT_COUNT`, the 10 000 sum,
  `MAX_SPLIT_DELTA_BPS`, `MIN_SPLIT_INTERVAL = 7 × DAY`) and against `backend/src/chain.ts`; its self-test fails on a dropped rule, a drifted constant, a
  new `ChipError` in the program and a BigInt payload. `backend/test/admin.test.ts` covers all three rails
  behaviourally (10/10).

- **SEC-B24 (2026-09-27): closed — the kill switch signs each program with that program's own authority.**
  `POST /admin/kill-switch` encoded `pause` for all three programs but took the admin/pauser pair from
  chip_core's `GameConfig` unless the target was staking: an arena pause went out signed by chip_core's
  hot pauser, while the arena's `Pause` constraint checks `ArenaConfig.admin || ArenaConfig.pauser` —
  so the transaction the operator approved during an incident could only revert, and the un-pause
  (`set_arena`, `has_one = admin`) needed an arena admin the panel never read. No funds were at risk;
  the emergency path was. Fixed: `fetchChainParams` reads and decodes `ArenaConfig`, `ChainParams.arena`
  carries its admin/pauser/paused, the route picks the pair per program and answers `503 arena_missing`
  when the account is absent (instead of silently signing with a key the program does not know), and
  `GET /admin/params` publishes both pairs. The diff now reports the live `paused` value instead of a
  fabricated `!paused`, and an already-satisfied request is flagged ("this transaction changes
  nothing"). The new `SEC-B24` static rule binds each program's `Pause` struct (its seeds and its own
  admin/pauser) to the PDA the panel writes and to the pair it signs with, pins "pauser for pause,
  admin for un-pause", the `ArenaAdmin` `has_one = admin` rail and the arena-missing guard, and fails on
  a swapped pair, a wrong PDA, a dropped decode or a pauser-signed un-pause; `backend/test/admin.test.ts`
  drives the real HTTP route with deliberately different arena keys.

- **SEC-B25 (2026-09-27): closed — the session cookie no longer defaults to `SameSite=None`.**
  `setSessionCookie` attached `SameSite=None; Secure` whenever `COOKIE_SECURE=1`, i.e. in every
  production deploy — and the deploy this repository ships is same-origin (nginx serves the client and
  proxies `/v1/`). `None` is the *widest* setting there: any cross-site subresource request to the API
  may carry the session cookie, and two GET routes write ( `/me/handle/check` takes a 120 s namespace
  hold, `/quests` records the day's login), so a hostile page could reserve handles — or skip the
  buy-to-settle gate behind `/quests/claims` (`eligibility` counts `quest_logins`) — with the victim's
  own session and a plain `fetch`. No funds at risk, but it is exactly the "we're same-origin, why is the
  cookie cross-site?" gap. Fixed: `COOKIE_SAMESITE` (lax | strict | none, default **lax**) is validated
  at boot, the attribute builder forces `Secure` for `none` (a browser drops `SameSite=None` without it,
  so the failure mode would be silent logout loops), and production refuses `none` unless the operator
  also sets `CROSS_SITE_CLIENT=1` — the cross-site topology stays available, but as a decision. The
  runbook explains which deployment needs which value, `.env.example` documents both keys, and the new
  SEC-B25 rule in `tests/security/csp.test.ts` (the browser-facing half of the same file) pins the
  default, the `Secure` tie, `HttpOnly`/`Path=/`, the production guard and the docs — with a mutation
  self-test — while `backend/test/security.test.ts` asserts the real `Set-Cookie` header over HTTP.

## Current exposure of this repository (from `docs/09-production-readiness.md`)

`npm audit --omit=dev` reports one advisory chain in the production tree: `bigint-buffer`
(GHSA-3gc7-fjrx-p6mg, high, no upstream fix) through `@solana/buffer-layout-utils` → `@solana/spl-token`
→ `@switchboard-xyz/on-demand`. It is accepted with a reason and an expiry date in
`scripts/audit-gate.ts` (the only caller passes fixed-length layout blobs, and the vulnerable code is the
optional native addon our images do not build). The other 19 advisories that used to be here were
transitive through `jayson` (`uuid`, `stream-json`) and `toml` and are gone via `overrides` in the root
`package.json` (`jayson ^5`, `toml ^5`). The `security` CI job runs `npm run audit:gate`, which **fails**
on any high/critical advisory outside that dated list — acceptance is re-decided when the entry expires,
not forgotten.

