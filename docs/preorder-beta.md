# Pre-sale (mainnet limited packs) — funding the devnet beta

**Status:** implemented end to end (program instructions, backend, client, ops script); release gates at the bottom. The program changes are gated by the CI `programs:gate` build — they have not been compiled in this workspace.

## Purpose and scope decision

Development of the devnet beta is funded by a **limited mainnet pre-sale**: buyers pay SOL now for a capped number of Limited Event Packs, and receive the packs **only at mainnet launch**, when they open them themselves through the normal pack-opening flow. Provable fairness is preserved because grants use the same Switchboard randomness pipeline as a purchase (the oracle is pinned into the deployed program bytes — `scripts/verify-deploy.ts` checks the pins).

Hard decisions locked in:

- **No new SKU slot.** `GameConfig.packs` is `[PackDef; 4]`; the pre-sale uses the existing `PackSku::Limited` (slot 3) configured via the `set_params` multisig path. There is deliberately no fifth enum variant.
- **One program instruction pair for delivery** (`init_grant_randomness` + `grant_preorder_pack`), not a mint bypass. Grants skip the daily cap and pay nothing (`paid_*` = 0, currency 255 = preorder) but reuse every other rail: collection pool, odds, reveal.
- **Squads 2/3 multisig treasury.** The backend and the ops script never sign anything — they only *encode* instructions; the multisig is the sole signer, exactly like the rest of admin (docs/03 admin contract).
- **The devnet beta stays free.** Pre-sale money funds it; pre-sale packs are a mainnet entitlement only.
- **The pre-sale can be turned off at any time** without touching the program: `PREORDER_ACTIVE=false` removes the campaign from the API and the client, and the drop itself can be closed on chain.

## Buyer flow

1. `POST /preorder/intent` `{ qty }` (1..`PREORDER_MAX_QTY`, auth required) — reserves a `ref_id` (AUTOINCREMENT), stores the required lamports and the exact memo to attach. `wallet_cap` enforces `PREORDER_MAX_PER_WALLET` per connected wallet.
2. The buyer sends SOL from their connected wallet to the Squads treasury with memo **`GC-PRE|<refId>`** (SPL memo program).
3. `POST /preorder/confirm` `{ refId, signature }` — the backend fetches the transaction **finalized from mainnet** (`MAINNET_RPC_URL`, regardless of the cluster the indexer runs on) and checks: success, a SOL transfer to the treasury ≥ reserved total, the memo, and the payer. On success the row becomes `paid`; the signature is unique, so double-confirmation returns `already_confirmed`.
4. Nothing is minted. At launch, delivery grants each paid reservation its packs; the buyer opens them normally.

Public transparency: `GET /preorder/registry` lists every reservation (refId, qty, status, timestamps, no wallet linkage beyond what the payer already knows) and the campaign state — this is the audit basis for the refund policy shown in the client.

### Payment statuses

`intent` → `paid` → `granted`. Intents expire after `PREORDER_INTENT_TTL_S` (72 h default). Confirmation failures map to `payment_tx_failed` / `payment_no_transfer` / `payment_amount_low` / `payment_memo_mismatch` / `payment_unknown_payer`; a payment with no memo cannot be attributed and is rejected with `payment_unknown_payer` (recovery = manual refund via the multisig).

## On-chain design (`programs/chip_core`)

New accounts (seeds pinned in `state.rs`):

| Account | Seeds | Content |
|---|---|---|
| `PreorderDrop` | `["drop", &[sku]]` | `admin`, `sku`, `total`, `granted`, `max_per_wallet`, `closed` |
| `PreorderGrant` | `["pregrant", drop, beneficiary]` | per-wallet granted counter |

New instructions (`instructions/preorder.rs`):

- `init_preorder_drop { total, max_per_wallet }` — admin only; one drop per SKU; idempotent refusal if it exists.
- `grant_preorder_pack { qty, nonce, preorder_ref }` — admin signer; enforces drop open, `granted + qty <= total` (`PreorderDropExhausted`), per-wallet cap (`PreorderWalletCap`), one grant per nonce. Creates the PendingPack exactly like a purchase (nonce = `ref_id`, so the PDA and the registry join are deterministic) and emits `PackGranted`.
- `close_preorder_drop` — only when `granted == total` (`PreorderNotExhausted` otherwise), making "fully delivered or visibly unfinished" a chain-level invariant.
- `init_grant_randomness` (`rng.rs`) — payer = admin, owner = beneficiary; the grant's randomness account belongs to the buyer, so the reveal is theirs.

New `ChipError` variants (114 → 118 total, mirrored in `client/src/chain/errorCatalog.json`): `PreorderDropClosed`, `PreorderDropExhausted`, `PreorderWalletCap`, `PreorderNotExhausted`.

## Backend

- Config (`backend/src/config.ts`): `PREORDER_ACTIVE` (default on), `PREORDER_TREASURY` (empty = campaign disabled), `PREORDER_PRICE_LAMPORTS` (0.999 SOL default), `PREORDER_SKU=3`, `PREORDER_TOTAL=500`, `PREORDER_MAX_PER_WALLET=5`, `PREORDER_MAX_QTY=5`, `PREORDER_MEMO_PREFIX=GC-PRE`, `PREORDER_INTENT_TTL_S`, `MAINNET_RPC_URL`.
- Routes: `GET /preorder` (campaign), `GET /preorder/registry`, `POST /preorder/intent`, `POST /preorder/confirm`, `GET /preorder/me` (auth), `GET /admin/preorders`, `POST /admin/preorders/drop` (`{action: open|close}`), `POST /admin/preorders/delivery` (all admin routes Squads-gated, audited).
- `PackGranted` from a preorder grant projects into `pack_purchases` with currency 255 and amount `'0'` — portfolio and analytics see the pack without revenue distortion.
- `backend/test/preorders.test.ts` covers intent/cap/expiry, every confirm failure code, idempotency, registry, drop open/close and delivery batching (25 tests; backend suite 555 green).

## Ops runbook (launch day)

```bash
# 1. Open the drop (multisig signs the encoded init_preorder_drop):
curl -X POST $API/v1/admin/preorders/drop -d '{"action":"open","admin":"<ADMIN_PK>","total":500,"maxPerWallet":5}'

# 2. Campaign on: set PREORDER_TREASURY + keep PREORDER_ACTIVE=true in the backend env.

# 3. Delivery, in batches of at most 25 instruction pairs (50 tx instructions):
node --no-warnings=ExperimentalWarning --import tsx scripts/grant-preorders.ts queue --db <DB_PATH>
node --no-warnings=ExperimentalWarning --import tsx scripts/grant-preorders.ts delivery \
    --admin <ADMIN_PK> --oracle <SB_ORACLE_PK> --batch 25 --db <DB_PATH> --out drop-1.json
# then load drop-1.json into Squads. Oracle must come from the pinned Switchboard queue for the
# deployed build; recentSlot is fetched finalized if not given.

# 4. Kill switch, any time, no program change:
PREORDER_ACTIVE=false   # backend env — campaign disappears from API + client
# and/or: POST /admin/preorders/drop {action:"close"} after a full grant.
```

Notes: `grant_preorder_pack` is replay-safe on chain (nonce once, cap, exhaustion), so a duplicated Squads transaction cannot double-deliver. A drop can only be closed when fully granted — refunds before that point are a treasury operation, not a program operation; the public registry is the reconciliation record.

## Trust, legal, keys

- Client copy (all 7 locales) states plainly: payments are **mainnet SOL now**, packs are delivered **at mainnet launch**, and the refund conditions from the registry page apply.
- **Helius API keys previously published must be revoked and replaced** before the backend verifies mainnet payments in production (mainnet RPC access is the trust boundary of `confirm`).
- Upgrade-deadline risk: the presale promises delivery at launch; if the program upgrade window slips, the registry + treasury stay the source of truth for refunds.

## Release gates

| Gate | State |
|---|---|
| Backend suite (555) incl. preorders (25) | green |
| Client suite (450) incl. error-catalog contract (118 variants) | green |
| `npm run api:check` (83 routes) | green |
| Client `/preorder` page, Home banner, 7 locales | done |
| `programs:gate` (Rust compile) — not compilable in this workspace | CI gate |
| `PREORDER_TREASURY` set to the real Squads vault in production env | ops gate |
| Helius key revoke/replace | ops gate |
