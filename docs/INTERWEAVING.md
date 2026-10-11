# Gutter Caps Ecosystem Interweaving Specification (Wave W3)

Status on 2026-10-06: rewritten to match the tree. The previous version described hub endpoints
(`/watchtower/*`), event names (`CapShot`, `ChipMinted`) and a cross-game `studio_profile` PDA that do
not exist in this repository; those claims were removed instead of re-verified. Source of truth for the
hub-facing data contract is now `WATCHTOWER_HANDOFF.md` + `watchtower/events/event-catalog.json`.

---

## 1. i-01: Shared Identity

- The only player identity the game actually produces is the **Solana wallet pubkey** (SIWS sign-in,
  `backend/src/auth.ts`; first contact recorded as `wallets.first_seen`). It is stable across sessions
  and can be the hub `playerKey` without transformation.
- Onboarding stages in the client (guest → embedded wallet → native wallet) are client state, and the
  identity is the wallet pubkey — there is **no on-chain cross-game PDA program**: nothing derives or
  stores such an account.
- Hub export of the join fact (`PlayerJoined`) requires the off-chain event contract first
  (`WATCHTOWER_HANDOFF.md` blocker B3).

## 2. i-03 & i-04: Asset Inventory & Portability

- Every chip carries a stable asset id (MPL-Core pubkey for the legacy path, Bubblegum V2 leaf/claim for
  the live compressed path) and the ECS owner component tags it `source_game = "guttercaps"`
  (`godot/scripts/ecs_world.gd:31`), plus `rarity` 0..4 and fusion `level`.
- **There is no cross-game transfer mechanism.** No bridge, no linking program, no
  `BridgeIn/BridgeOut/CrossGameLinked/CrossGameAssetGranted` events. Ownership moves only through the
  in-game market (`CompressedClaimTransferred`, see the catalog). Portability contracts with adjacent
  games do not exist yet and must not be reported to the hub as if they did.

## 3. i-05: Economic Budget & Treasury Solvency

Real, test-pinned rules (unchanged from before):

1. $CG minting is capped by the emission guard (`programs/staking`): ≤ 1.25× the 7-day average burn,
   floored at 30% of the scheduled emission (`packages/economy`, `npm run economy:check`).
2. Arena wager escrows hold both stakes in a PDA-owned token account before resolution
   (`programs/arena/src/lib.rs`).
3. SKR prize pool invariant: `funded >= paid + reserved + withdrawn`
   (`tests/localnet/70-property-invariants.spec.ts`).

Treasury balances are read from the cluster (`GET /stats`, `GET /admin/kpi` of a running backend); no
treasury snapshot is committed to the repo.

## 4. i-06: Unified Events

- The event taxonomy is whatever the four programs emit — **63 events**, all declared and decoded by
  `backend/src/events.ts` (`EVENT_SPECS`), listed with meanings and proposed hub mappings in
  `watchtower/events/event-catalog.json`. Names invented for earlier drafts of this document
  (`CapShot`, `ChipMinted`) have no emitter and were dropped.
- First-action mapping: the hub expects `PackOpened`; the live event is `CompressedClaimsCreated`
  (the legacy `PackOpened` struct is declared but emitted nowhere). The same transaction also
  emits `CompressedPackOpened` (32-byte SlotHashes seed + rarities) for `/verify` — that is a
  companion payload, not a second first-action. Pending hub sign-off — see
  `WATCHTOWER_HANDOFF.md` blocker B2.
- **Deduplication** matches the hub contract: `cluster:slot:signature:instructionIndex:innerIndex`
  (backend uniqueness key `(signature, ix_index, event_index)`, `backend/src/db.ts`).

## 5. i-07: Profile & Progression

- The backend computes level-adjacent facts (chips owned, battles, quest progress) from indexed events
  (`GET /me`, `GET /me/activity`), and an internal admin KPI set (`GET /admin/kpi`). There is no
  hub-facing progress export; Operator Game progress (`hours/rank/updatedAt`) is not measured —
  `WATCHTOWER_HANDOFF.md` §F.

## 6. i-10: Severity Dictionary & Alert Catalog

- Alert definitions and runbooks live in `docs/ALERT_CATALOG.md` and are cross-checked against
  `package.json` by `tests/security/indexer-gaps.test.ts`. Prometheus rules: `ops/monitoring/alerts.yml`
  (28 rules); severity ladder P1 page / P2 high / P3 medium as defined there.
- Delivery note (audit AUDIT-2026-10-02 H-1): `ops/monitoring/prometheus.yml` still has empty
  Alertmanager targets — until a receiver is configured, P1 rules fire into the void. This is a
  production blocker tracked in `WATCHTOWER_HANDOFF.md`.

## 7. i-11: Hub Control & Governance Boundaries

- Hub interaction with this game is read-only by construction: the hub reads events; it cannot propose
  state changes. Program pause/admin changes require the on-chain governance paths (two-step admin
  transfer, pauser key, Squads multisig + timelock per `docs/09` §2) — never automatic.
- Anti-fraud actions are proposal-only flags (`rewardsPaused`, shadow flags via
  `npm run backend:antifraud -- resolve …`); balances are never modified by moderation.
