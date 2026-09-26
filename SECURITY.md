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
