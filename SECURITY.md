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
  scenarios (`localnet`), the 106 static gates with mutation self-tests (`security:static`) and the structural
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

- **SEC-B30 (2026-09-27): closed — the wager resolver could settle a battle on a squad the opponent never
  matched.** `resolve_battle` is server-authoritative: the program checks the winner is a party, the winner's
  ATA owner, the revealed VRF and the daily cap, and pins `result_hash` for audits — it never re-simulates the
  fight. The fight is computed off-chain from `chips` rows, which keep moving, while the battle account carries
  the squad assets *and* the power the program computed from them at accept time (`accept_battle` matches the
  opponent by league only). Nothing flags a chip that sits in an accepted battle, and a fusion only ever raises
  a level, so a player could accept, then level a squad chip up and fight a squad stronger than the power that
  was matched; a chip consumed by a fusion had no chip behind it at all. The resolver now refuses unless both
  squads reproduce the recorded `power_a/b` and every squad chip is still live (`burned_at IS NULL`) — a
  refusal is logged as an ALERT, sends nothing, and leaves the battle cancellable (`cancel_stale_battle`
  refunds both wagers after `RESOLVE_TIMEOUT`), so the fail-closed direction costs nobody funds. Pinned by
  `tests/security/battle-squad.test.ts` (four rules over the resolver and the arena commitment, six mutations)
  and by `backend/test/battle-resolver.test.ts` (a levelled-up squad, a consumed chip, an unknown squad and a
  non-accepted battle, all with no transaction sent).
- **SEC-B29 (2026-09-27): closed — the burn oracle reported burns the chain could still take back.**
  `report_burn` is irreversible: it adds to `burn_today` and to the 7-day ring the emission guard reads
  (`0.30·cap + 1.25·burn7d`), and there is no "un-report". The indexer, meanwhile, explicitly accepts that
  a *confirmed* transaction can be dropped by a fork — `finality.ts` deletes its raw events and rebuilds
  the projections. The keeper aggregated every indexed burn since its cursor, so a burn that lived only in
  a dropped fork was already on chain: up to a week of inflated emission allowance (bounded by the 3×
  clamp, and silent). Every other value-bearing reader (quests, arena, referrals, reward-oracle) already
  filtered on `finalizedHorizon`; the keeper now does too, and everything the reconciler may delete is by
  construction *above* that horizon, so a reported burn is final. The durable cursor may also no longer
  step over a burn it did not count: `events_raw.id` follows insertion order while slots do not (the four
  programs are indexed by independent cursors), so a burn indexed out of slot order would have been skipped
  forever — which holds emission at the 30 % floor. What cannot be reported yet is now visible instead of
  silent: `/v1/health.burnOracle.deferredMicro`/`deferredRows` (finalized-pending stays `pendingMicro`) and
  the `burn_oracle_deferred_cg` gauge; `healthy` is 0 when a material set is stuck behind finality and
  nothing was reported for 3 intervals, so `BurnOracleStale` catches a frozen reconciler as well as a dead
  keeper. Pinned by `tests/security/burn-report.test.ts` (four rules over the keeper, the reconciler and
  the contract, seven mutations — including "everything is final" and "the cursor may jump") and by
  `backend/test/burn-oracle.test.ts` (a dropped transaction's burn and an out-of-slot-order burn, against a
  real database).
- **SEC-B31 (2026-09-27): closed — eight events the programs emit had no decoder, and with them the compressed
  claim lost every state transition it has.** A transaction log the codec cannot read is not an error, it is
  silence: `CompressedClaimListedSet`, `CompressedClaimStakedSet`, `CompressedClaimTransferred`,
  `CompressedChipStaged` (chip_core) and `CompressedClaimListed`, `CompressedClaimSold`,
  `CompressedAssetListed`, `CompressedAssetSold` (market) were emitted and dropped. The compressed claim is
  the case where that hurts, because its own events are the *only* source of its state: the Core path's
  `ChipFlagsChanged` does not exist for a claim, so a cancelled compressed listing left the chip `listed` in
  the read model — the client offered a purchase the program answers `InvalidChipState` to — and
  `Staked{kind:1, key}` names the *claim PDA* while every chip table and flag is keyed by the registered
  asset, so a staked compressed chip carried no `staked` flag at all and looked free. The two compressed
  markets (the claim market and the V2 asset market) left no `listings`/`sales` rows either: volume,
  collection stats, the activity feed and the wash-trade heuristics were short by every compressed trade, and
  a transfer or sale never moved `chips.owner`. Fixed by describing all eight events (48 → 56 specs) and
  projecting them: a new `compressed_claims.claim` column maps the claim PDA to the registered asset (with
  `owner`, `listed`, `staked`, `price`, `currency` carrying the claim's live state, all migrated in place for
  an existing database), `chipBehindClaim`/`assetOfStakeKey` resolve a claim to its chip, every update that
  addresses a claim by PDA is owner-guarded so a replayed event cannot move a claim that changed hands, and a
  claim sale with no leaf yet is recorded in `sales` keyed by the claim (its collection is genuinely unknown
  at that point — `list_compressed` is pre-mint by construction). Two deliberate boundaries: `CompressedChipStaged`
  is decoded and touches its wallet but writes no read-model row (an admin authorization has nothing
  product-facing behind it, and `authority_changes` feeds a page alert that a routine staging must not trip),
  and a pre-mint claim listing lives on the claim row rather than in `listings`, which is asset-keyed and
  always joined to `chips`. Pinned by the gate `tests/security/events-coverage.test.ts` (Rust `#[event]` ⇔
  `EVENT_SPECS` parity in the declaring crate, spec ⇔ handler reachability with the one documented wire-only
  event, and the claim mapping/index/migration/owner-guards — three rules, nine mutations) and by
  `backend/test/compressed-market.test.ts` (nine tests: flags on list/cancel/sale/transfer, a claim-keyed
  stake, the pre-mint claim market, and a rebuild that reproduces it all); the LT-3 corpus now emits every one
  of the eight and its staking invariant resolves claim-keyed positions through the new column.
- **SEC-B34 (2026-09-27): closed — a claim bought before its mint registered into no chip at all.**
  `CompressedChipMinted` and `CompressedChipRegistered` name the claim's *current holder*, and the read model
  resolved both by holder (`WHERE buyer = ? AND claim_nonce = ?`, the row's `buyer` being the immutable origin
  the claim PDA is derived from). The two agree only until the claim market moves an un-minted claim:
  `buy_compressed_claim` transfers it (the row's `owner` changes, the origin does not), the buyer mints and
  registers — and both events then named a wallet no row matched by `buyer`, so
  `register_compressed_chip` produced no `chips` row. The consequence is the buyer's inventory: a registered,
  paid-for compressed chip the indexer did not have (no owner, no collection volume, nothing to fight, stake
  or sell), with the claim row stuck at `minted`. It was found by the SEC-B32 test, which needed exactly this
  order — the claim market's own happy path. Both events now carry the claim PDA, *appended last* (borsh is
  positional, so every earlier offset is unchanged — a devnet redeploy, not a data migration), and the
  projection resolves the row through `resolveClaimPda` (PDA first, holder-keyed fallback for a log from an
  older build) and updates it under the owner guard the program itself enforces
  (`register_compressed_chip` requires `claim.buyer == owner`). The settlement counter now follows the row
  that actually moved and counts against its origin — a buyer's registration increments the *seller's*
  settlement, which is the account the claim was created in. Pinned by the `SEC-B34` rule in
  `tests/security/settle-once.test.ts` (the field on both Rust structs, no holder-keyed claim update, both
  handlers resolving through the PDA with the owner guard; three mutations) and by
  `backend/test/compressed-market.test.ts` (the full create → list → sell → mint → register → sell order, and
  a replayed registration from a wallet that no longer holds the claim).
- **SEC-B33 (2026-09-27): closed — a match could be settled twice.** `reveal` reads the match row and then
  writes it, and the writers of that row are not serialised: a client retry, or a second API process behind
  the load balancer, can both hold a still-`revealing` match and both settle it. `pvp_rewards` is idempotent
  by primary key `(match_id, wallet)`, so the reward rows were safe — the ratings were not (two
  `applyRating` calls) and neither was the season-pass XP (`addPassXp` adds to `pass_xp.xp`). The settle-once
  guard makes every write conditional on the state the writer believes it is acting on:
  `… WHERE id = ? AND status = 'revealing' AND seed IS NULL` (the seed is written once and never cleared, so
  it — not the status the reader saw — is the arbiter), every payout write (ratings, XP, rewards) sits behind
  `if (applied === 0) return`, and the function re-reads the row and reports *its* winner and rewards instead
  of the numbers it computed. The forfeit path is guarded the same way, in both branches. Nothing is spent
  twice on chain from here — no transaction is sent — but a second settle silently rewrites the ladder and the
  pass, which is exactly what the reward roots pay against. Pinned by the `SEC-B33` rule in
  `tests/security/settle-once.test.ts` (both writers, the guard, the payouts behind it; two mutations) and by
  `backend/test/game.test.ts` (a second settle with a stale row moves nothing and reports the recorded result).
- **SEC-B32 (2026-09-27): closed — the wash-trade price-spike detector could not see a compressed trade.**
  `detectWashTrades` has two arms: round trips between a pair, and a price ≥ 3 × the archetype floor between
  the same pair twice inside the window. The second arm filtered `s.collection_idx IS NOT NULL` — and a
  compressed claim sold before its leaf exists is recorded with exactly that NULL (SEC-B31: the collection is
  not in the event, and guessing it would file the volume under the wrong district). A trade the first arm
  already counted was therefore invisible to the one that prices it, and the value-transfer move this arm
  exists to catch had no detector at all. The archetype now comes from the chip the claim-keyed row resolves
  to (`compressed_claims.claim → chips`), the sale row's own values still taking precedence; a claim that never
  registers keeps `floor = NULL` and is skipped, which is the honest answer — there is no floor to compare
  against yet. Pinned by the `SEC-B32` rule in `tests/security/settle-once.test.ts` (no collection filter, the
  claim fallback, the join; two mutations) and by `backend/test/game.test.ts` (a Core pair and a claim pair at
  5 × the floor are both flagged with `priceOverFloorX: 5`, a never-registered claim's pair is not).
- **SEC-B46 (2026-09-27): closed — `WS_MAX_CLIENTS` bounded the process, not a caller.** The hub's only admission
control was `open >= maxClients`, and an upgrade never passes through the HTTP layer, so it is neither rate-
limited nor attributed: one host with a loop took all 500 sockets and the players actually playing got 1013 — a
capacity guard that protects the heap (its job) and hands the service to whoever arrives first with a `while
(true)`. `WS_MAX_PER_IP` (default 32, `0` disables) now bounds the sockets *one client* holds, counted on the
socket and given back on close (`terminate` included — a cap that only counts up ratchets down to zero), refused
with the same 1013 the process-wide cap uses and visible as `ws_rejected_total{reason="per_ip"}`. The client IP
comes from `upgradeIp`, which applies *the same* rule Express applies to HTTP (`trust proxy` = `TRUST_PROXY_HOPS`,
now resolved once in `config.ts` and used by both): the socket peer, then `x-forwarded-for` walked right to left
skipping the trusted hops — the upgrade cannot inherit `app.set('trust proxy')`, so the rule has to be written
down somewhere both paths read. With the documented one hop in front, that is the rightmost entry, which nginx
*appends* (`$proxy_add_x_forwarded_for`), so a caller's own header cannot move its bucket. Pinned by
`backend/test/ops.test.ts` (a second socket from the same IP is refused with 1013 while another IP is served, a
spoofed `1.2.3.4, <ip>` chain still lands in the same bucket, the slot comes back after a close) and by a case-by-
case cross-check of `upgradeIp` against Express's own `req.ip` for the same header and hop count.
- **SEC-B45 (2026-09-27): closed — an upgrade is not subject to CORS, and nothing else checked who was asking.**
The REST layer refuses to hand a foreign page our data (CORS allowlist; `assertProductionConfig` rejects `*`), but
a browser does not apply CORS to a socket, and `/ws` carried no `Origin` check: any page could open `wss://…/ws`,
read the market frames cross-origin (data the REST layer would have refused it), subscribe to `?wallet=<anyone>` —
no session required — to watch that wallet's activity in real time (pack opened, chip fused, chip sold), and take
the whole `WS_MAX_CLIENTS` capacity from one tab. The upgrade now enforces the API's own allowlist
(`CORS_ORIGINS`): a request *with* an `Origin` that is not on it gets `403` and no socket,
`ws_rejected_total{reason="origin"}` counts every attempt and a throttled WARN names it — the metric must count
all of them, the log line must not (one page in a loop is not allowed to fill a disk). A *missing* `Origin` is
allowed on purpose: curl, a bot and a native client have none, and a non-browser client can lie about the header
either way, so this is a control on browsers, not authentication. Pinned by `backend/test/ops.test.ts` (a foreign
origin never opens, the allowed origin and a nameless client both do, and a spoofed `x-forwarded-for` does not
smuggle an origin in).
- **SEC-B44 (2026-09-27): closed — no API response said what a cache may do with it.** Four handlers set `Cache-
Control` (`/healthz`, `/readyz`, `/metrics`, `/packs/quote`) and nothing else did, so `/v1/me`, `/v1/session` and
the wallet feeds answered with no header at all. Cookie authentication is not `Authorization`, which is the only
thing RFC 9111 uses to stop a shared cache from *storing* a response: a cache was free to store a session-scoped
answer and apply its own heuristic freshness — the classic way one player's balance ends up in another player's
browser. That is not hypothetical here: this deployment aims at a Cloudflare edge (`GEO_GATE` needs one —
`ops/deploy/docker-compose.yaml`), and nginx has no `proxy_cache`, so the edge is exactly the layer that decides.
The baseline-header middleware now sets `private, no-store` for every response that does not override it, and a
handler with a reason to say something else still wins (`/packs/quote` and `/healthz` keep their own).
Deliberately *not* `public, max-age=…` on the read-only market endpoints: the single-writer SQLite is the load
that matters, the client already carries a per-hook `staleTime`, and a cache in front of a projection an indexer
updates in place is a staleness bug waiting for a money screen. Pinned by `backend/test/security.test.ts` (a
session-scoped 401 and a public 200 both answer `private, no-store`, an explicit handler still overrides it).
- **SEC-B43 (2026-09-27): closed — the fan-out allowlist promised a frame nobody publishes and nobody reads.**
`PUBLIC_TYPES` is the set that skips the wallet filter (`ws.ts`): a member is delivered to every socket, including
anonymous ones. `price_update` was a member while `WIRE_TYPE` maps no event to it and `client/src/api/ws.ts` has
no `INVALIDATE` key for it — a type with no publisher and no reader, i.e. the "looks configured, does nothing"
shape this repo treats as a bug in alerts and metrics too. Removed, and the two-sided promise is now a gate: every
member must be produced by the wire map *and* handled by the client's invalidation table. Pinned by the `SEC-B43`
rule in `tests/security/events-coverage.test.ts` (plus two mutations — a member with no publisher, a member the
client does not handle).
- **SEC-B42 (2026-09-27): closed — the shared-Redis rate limit keyed one client as several.** `createRedisGuard`
built its window key from the *text* of `req.ip` run through a character filter (`.replace(/[^0-9a-fA-F.:-]/g,
'')`), so `::ffff:203.0.113.9` and `203.0.113.9` — one caller arriving over a v4 edge and a v6 one — were two
buckets, and `2001:db8::5` / `2001:db8::6` were two more for a single /64. That is SEC-B38's defect in the layer
that exists *because* per-process budgets do not aggregate across replicas: a caller who could alternate spellings
reset the shared burst budget that the local, correctly keyed bucket had already spent. The guard now uses
`clientIp` (the limiter's own key function): IPv4 as dotted text, a v4-mapped address as its dotted IPv4, IPv6 as
its /64 — one client, one bucket, in both layers. Pinned by `backend/test/ops.test.ts` (the key is the canonical
form; alternating spellings share one count and the third request is blocked) and by the `SEC-B42` half of the
SEC-B38 rule in `tests/security/api-input.test.ts` (no rate-limit key may be built from the raw address text —
with a self-test on the pre-fix line).
- **SEC-B41 (2026-09-27): closed — the per-socket outbox cap could not bind, so a stalled client grew the heap.**
`ws.ts` documents "a bounded per-socket outbox that drops a slow client instead of growing the heap" and tested it
by comparing `socket.bufferedAmount + frame.length` against `WS_MAX_BACKLOG_BYTES`. But `drain()` awaits each
`send` callback, so at most one frame is ever in flight and `bufferedAmount` stays near zero while `queue` grows:
the check could only ever trip when a single frame was larger than the whole cap. Probed with 6000 × ~190 B frames
to a client that read nothing: one send during the loop, `queue` ≈ 5999, `bufferedAmount` 0, `ws_dropped_total`
empty — 1.1 MB held by the process per stalled socket, at 500 sockets per replica (and it drains afterwards, so
nothing else notices). The bound is now the bytes the process is actually holding for that socket
(`ClientState.queued`, incremented on push, released on send/clear/drop) plus `bufferedAmount`, and the single
write path covers the pong reply and the greeting too — a client flooding `{"type":"ping"}` was able to make the
server buffer replies with no cap at all. Pinned by `backend/test/ops.test.ts`: 200 × ~1 KB frames in one
synchronous burst to a socket that has not drained (~1 KB per frame, far *below* the 2 KiB cap in the test, i.e.
the exact shape the old arithmetic could never catch) → 1013/`terminate`, `ws_rejected_total{reason="backlog"}`
moves, the hub drops the client; and a burst that stays under the cap is still delivered whole. The same edit made
a typo'd `WS_MAX_CLIENTS=500x` (NaN — every comparison false, i.e. no cap while looking configured) fall back to
the documented default in dev and refuse to start in production, and moved `ws_max_clients` onto the app so the
saturation alert can divide by the configured cap instead of a hardcoded 480.
- **SEC-B40 (2026-09-27): closed — a Redis that was down stopped the API from ever listening.** `serve.ts` awaits
`installBus()` before `server.listen`, and `bus.ts` has always documented both Redis uses as optional ("a missing
Redis costs the cross-process fan-out, and the client polls"). It was not optional in practice: `new Redis(url)`
does not throw for `ECONNREFUSED` — ioredis retries — so the queued `SUBSCRIBE` never settled and `installBus`
never returned. With `EVENT_BUS=redis` + `REDIS_URL` (the documented 2-replica mode) and Redis down, renamed or
serving something else, the process never bound a port: no REST, no `/readyz`, no `/metrics`, a container in a
restart loop, and a rollback blocked for as long as Redis was unwell. The initial subscribe is now bounded
(`EVENT_BUS_CONNECT_TIMEOUT_MS`, default 3 s; the Redis clients are also closed on that path, so the abandoned
sockets do not keep reconnecting), after which the bus falls back to in-process — the same degradation the
missing-URL case always had, announced instead of hidden. Two side findings came with it: the bus clients had no
`error` listener, so ioredis wrote `[ioredis] Unhandled error event:` straight to stderr outside the structured,
redacted logger, and the `pub.on('error', () => {})` that *was* there made a Redis outage invisible in both logs
and metrics — both clients now count `redis_error_total{purpose="bus"}` and warn once per 30 s. Because a replica
on the in-process bus is invisible from the outside (it serves REST perfectly and simply misses other replicas'
frames), `/metrics` exports `event_bus_redis` *only* where Redis was configured, with the new `EventBusDegraded`
alert (`== 0`, warn) on it. Pinned by `backend/test/bus.test.ts` (a dead port falls back inside the timeout and
the fallback bus still delivers; a peer that accepts and never answers `SUBSCRIBE` falls back and its sockets are
released; the error counter moves instead of stderr; the missing-URL shortcut is unchanged; and the real
`startServe` answers `/healthz` with `EVENT_BUS=redis` + a dead Redis) and by the alert-rule assertions in that
file and in `backend/test/monitoring.test.ts`.
- **SEC-B35 (2026-09-27): closed — a compressed trade reached the client under a name it does not handle.**
  `wire.ts` maps an on-chain event to the client's invalidation key, and its own header says why: a frame the
  client filters out is a cache that never updates, with no error anywhere. The two compressed markets
  (`CompressedClaimListed`/`Sold`, `CompressedAssetListed`/`Sold`) and the claim's own flag flips shipped
  under their snake_case names, which no `INVALIDATE` entry knows — a compressed listing, sale, cancel or
  stake invalidated nothing, so the market page silently degraded to polling. They now map onto the same keys
  the Core path uses (`listing_changed`, `sale`, `stake_changed`) with the payload shape the client already
  reads (seller/buyer/price/`priceUsd`), `asset` only when the leaf exists — a pre-mint claim PDA is not a
  chip route — and `claim` always, so a client can key its own cache by the identity the market uses.
  `CompressedClaimTransferred` stays raw on purpose: an ownership move with no money has no client
  invalidation key to route to. Pinned by the `SEC-B35` rule in `tests/security/events-coverage.test.ts`
  (every mapped wire type is a key the client actually implements; all six compressed events are mapped and
  decoded; two mutations) and by the wire test in `backend/test/ops.test.ts`.
- **SEC-B39 (2026-09-27): closed — production could start with every rate limit switched off.** `RATE_LIMIT=0`
  is the load-test switch (`config.ts`: "only for local load scripts") and it turns *all* budgets off at once:
  per-IP reads, per-session mutations, quotes, claims, the per-/24 claim and per-hour human networks, the
  arena. `assertProductionConfig` knew the other dev shortcuts (`FINALITY_ASSUME=1`, an insecure cookie, a
  short session secret) and not this one, so an environment that inherited the line from a load-test box
  served unbounded traffic — and a limit that is off does not look different in the logs from a limit nobody
  reached. Production now refuses to start. Pinned by `backend/test/security.test.ts` (the hardened env passes
  with `RATE_LIMIT` unset and throws on `RATE_LIMIT=0`).
- **SEC-B38 (2026-09-27): closed — the /64 and /48 limiter keys were not prefixes.** `clientIp` built its key
  by slicing the *text* of the address (`ip.split(':').slice(0, 4)`), which is a /64 only in the fully expanded
  spelling. For an address whose text collapses groups 3–4 (`2001:db8::5`, one /64 with `2001:db8::6`) the key
  came out as the address itself with `::/64` glued on — not a well-formed prefix — so every address inside
  that /64 was its own bucket: one host rotating addresses inside its own /64 collected a fresh budget for
  each, which is the one thing the aggregation exists to stop (the SEC-H3 rule "a home /64 is one client").
  `2001:db8::5` and `2001:0db8:0000:…:0005` were two keys as well, and a v4-mapped `::ffff:203.0.113.9` was a
  third key for a client that also arrives as `203.0.113.9`. The same slicing produced the strings stored in
  `human_checks.ip_net`, i.e. the per-/24 accounting had the same defect. `ipKey`/`ipNet` now parse the address
  to bytes first (`parseIpv6`: `::`, upper case, leading zeros, one dotted-quad tail, zone index) and build the
  key from the parsed groups, converting a v4-mapped address to its dotted IPv4 form; anything unparseable
  stays an opaque key of its own rather than being merged into someone else's bucket. Pinned by
  `backend/test/human.test.ts` (every spelling of one /64 is one key, the neighbouring /64 is not, IPv4 and
  v4-mapped agree, malformed literals stay distinct) and by the `SEC-B38` rule in
  `tests/security/api-input.test.ts` (the key is built from parsed bytes, v4-mapped is recognised, nothing
  slices a key out of the address text).
- **SEC-B37 (2026-09-27): closed — a URL that cannot be percent-decoded was a 500 and an error log line.**
  Express decodes path parameters before any handler runs and marks the resulting `URIError` with
  `status = 400`; the error middleware recognised `ServiceError`, `AuthError`, `bad_pubkey` and the two
  body-parser types, and everything else became 500 `internal`. `GET /v1/wallet/%zz/events` therefore answered
  500, wrote an `unhandled request error` line and moved `http_errors_total{kind="unhandled"}` — the series an
  operator alerts on. One URL was enough to write error-level logs and drive that metric, and a client typo
  looked like a server fault. The middleware now honours a 4xx status Express itself set, and only a 4xx: a
  handler throwing a plain `Error` is still a 500, which is what keeps the metric meaningful. Pinned by
  `backend/test/params.test.ts` (five undecodable paths → 400 `bad_request`, and the unhandled counter does
  not move) and by the `SEC-B37` rule in `tests/security/api-input.test.ts` (the branch exists, reads the
  status, and precedes the unhandled branch).
- **SEC-B36 (2026-09-27): closed — a wallet address was a LIKE pattern, so `%` was the whole event log.**
  `GET /v1/wallet/:address/events` is public (`security: []`) and its only filter is `data LIKE '%' || ? || '%'`
  — a scan of `events_raw`'s JSON blob, the accepted cost of an events feed over a blob (docs/06 §4.1,
  `ops/deploy/data-layer.md`). The path parameter went in unvalidated, so it was not an address but a
  *pattern*: `GET /v1/wallet/%/events` answered 200 with the newest 200 rows of the entire log, `_` made the
  feed a substring oracle over every wallet's events, and junk (`abc`, a 45-character string) was a silent
  empty feed instead of a 400. Nothing secret leaked — an `events_raw` row is a decoded *public* chain event
  and the feed is documented as public — but the endpoint answered a different question than the one it
  documents, and the pattern language is one edit away from the leak that would matter (this blob is the only
  place those bytes are read, and the WS header's "everything here is already public in REST" argument depends
  on the feed behaving like a read, not like a query engine). The route now refuses anything that is not
  exactly a 32-byte base58 key with 400 `bad_pubkey` (`isSolanaAddress` — the rule `new PublicKey` applies to a
  string, pinned against it on the boundary cases), and the query layer escapes `%`, `_` and the escape
  character itself *and declares it* (`likeContains`/`likePattern` in `sql.ts`: SQLite has no default escape
  character while Postgres has one, so an escape that is not declared is a different query per dialect). Pinned
  by `backend/test/params.test.ts` (hostile addresses → 400 `bad_pubkey`; a wildcard returns nothing, `%` and
  `_` alike; alice's feed contains only rows that mention alice), `backend/test/sql.test.ts` (the clause and the
  escaping, character by character) and the `SEC-B36` rule + self-test in `tests/security/api-input.test.ts`.
- **SEC-B28 (2026-09-27): closed — the claim market listed in currencies it can only fail to settle.**
  `buy_compressed` / `buy_compressed_asset` pay the seller with `system_program::transfer` and answer
  `CompressedCurrencyMismatch` for anything else (the SPL legs of the legacy `buy` were never wired into
  this path) — but both `list_compressed*` handlers accepted a USDC or SKR listing. The transaction that
  the buyer could never send was not the damage: the listing carried `init`, the claim was flagged
  `listed` through the CPI, and chip_core then refuses `mint_compressed_chip`, `fuse_*` and staking for
  that claim with `InvalidChipState` until the seller cancels — an unfillable listing on chain plus a
  self-inflicted lockout, reachable from any UI that offered the currencies the docs listed, and paid for
  by the seller. The currency is now checked in both list handlers through one shared
  `require_sol_claim_market` (before the price, so the answer is about the currency), the buy side keeps
  its own check as defense in depth for a listing created before the guard (a failed transaction
  reverts, so a refused listing leaves neither the PDA nor the flag), and the client builders
  (`listCompressedIx`, `listCompressedAssetIx`) refuse a non-SOL currency before the wallet pays a fee.
  Relaxing this is a feature: it needs the SPL legs in `buy_compressed*`, not the removal of a check.
  Pinned by the `SEC-B28` gate in `tests/security/anchor-invariants.test.ts` (one rule over all six points —
  both list handlers, the shared guard's polarity and error code, both buy handlers, both client builders —
  with four mutations), the Rust unit test
  `claim_market_lists_only_in_sol`, the USDC/SKR assertions in the `30-market.spec.ts` listing scenario
  (code 6011, no listing PDA, no `listed` flag) and the client tests for both builders and for the
  API→wire currency translation (`marketCurrencyOfApi(3) === MarketCurrency.SKR === 2`).
- **SEC-B27 (2026-09-27): closed — a transaction the RPC would not serve is recorded, not skipped, and the
  read model no longer claims a history it does not have.** `getSignaturesForAddress` lists signatures; the
  transaction is a second call and `getTransaction` legitimately answers `null` (provider retention, or a
  transient answer). The page walk treated that as "nothing here": no event counted, the walk finished, and
  `indexer_cursor.history_complete` was stamped `1` — so a lost `ServicePaid` showed up as a player who paid
  and is told `payment_not_found`, a lost mint as an inventory the chain disagrees with, with nothing
  anywhere saying a page had been short. The operational half was worse than missing: the
  `docs/DISASTER_RECOVERY.md` invariant 3 (section 2) described a "sequence detector" no code implements, and ALERT-02 told the operator to run
  `npm run backfill -- --from-slot … --to-slot …` — no such root script exists, and the CLI filtered both
  flags away and ran a *full* walk while the reader believed a range had been re-indexed. The fix:
  `ingestSignatures` returns the unfetched signatures (a *throwing* fetch still aborts the page, so the
  cursor stays put — fail-closed, never a partial success); the walk files them in the new `indexer_gaps`
  table and keeps `history_complete = 0` while the set is non-empty; `repairIndexerGaps` re-fetches them
  through the same `ingestTx` (the listener's heal tick drains recent gaps, `npm run backend:backfill --
  --repair-gaps` drains parked ones against an archival RPC, and `INDEXER_GAP_MAX_ATTEMPTS` parks a
  signature the provider will never serve again); `GET /v1/health.indexerGaps` =
  `{pending, parked, oldestSlot}` with the scrapes `indexer_gaps_pending`/`indexer_gaps_parked` and the
  `IndexerGaps` alert read them; the Postgres target carries the table too. The two runbooks were rewritten
  to the mechanism that exists, and the gate now checks every `npm run …` they quote against
  `package.json`. Pinned by `tests/security/indexer-gaps.test.ts` (7 rules, 10 mutations) and
  `backend/test/backfill.test.ts` (9 behavioural tests).
- **SEC-B26 (2026-09-27): closed — credentials can no longer leave the process through the logs.**
  `backend/src/log.ts` had no redaction at all: `safeValue` copied every own property of every object it
  was handed, so a future `log.info('cfg', cfg)` or `log.error('verify failed', { token, secret })` would
  have shipped a live credential to a log index (Loki/CloudWatch/Datadog) — the Slope and DEXX incident
  class, where the key leaves through observability rather than through the chain. Two independent nets,
  because one always has a gap: (1) by field name — a key whose separators-stripped form reads like a
  credential (`TURNSTILE_SECRET`, `apiKey`, `api_key`, `sessionCookie`, `keypair`, `nonce`, `deviceSalt`,
  `fingerprint`) is replaced wholesale, recursively, before its value is walked; (2) by value shape —
  `?api-key=…`, `secret="…"`, `Bearer <token>` inside *free text* (a fetch/RPC error message carries the
  endpoint, and endpoints carry query credentials) are masked, applied to the message and to
  `errFields`, and always before the 2 000-char truncation so a secret cannot survive by sitting past the
  cut. What incident response needs stays readable on purpose: wallet, transaction signature, slot,
  request id, status, route, duration — the control protects the credentials, not the evidence. The new
  gate in `tests/security/logging.test.ts` proves both nets are still wired into `safeValue`, `line` and
  `errFields`, that the Bearer rule still precedes the `key=value` rule (reversed, `authorization: Bearer
  <token>` masks the scheme word and keeps the token), and that the suite covering the behaviour exists —
  with a mutation self-test for each of the four.

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

