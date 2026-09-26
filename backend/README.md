# @guttercaps/backend

The off-chain half of GUTTERCAPS. It replaces the legacy `indexer/` (single
program, Anchor IDL, better-sqlite3) with one package that understands all
four programs and serves the client API described in `openapi.yaml`.

```
backend/
├─ openapi.yaml            # API contract (client/src/api/schema.d.ts is generated from it)
├─ prisma/schema.prisma    # production Postgres schema (same shapes as db.ts)
├─ src/
│  ├─ config.ts            # program ids, RPC, DB path, cookie/handle rules (env-driven)
│  ├─ events.ts            # Anchor-free event codec: 47 events × 4 programs (`EVENT_SPECS`), decode + encode + log walker
│  ├─ borsh.ts             # tiny Borsh reader/writer
│  ├─ db.ts                # node:sqlite store (events_raw + projections + api state)
│  ├─ projections.ts       # event → chips / listings / sales / battles / stakes / burns / service_payments
│  ├─ ingest.ts            # tx logs → events_raw → projections, cursors, bounded-concurrency fetch
│  ├─ backfill.ts          # historical walk (getSignaturesForAddress) per program
│  ├─ listen.ts            # onLogs websocket per program + periodic gap healer
│  ├─ rebuild.ts           # truncate projections and replay events_raw
│  ├─ auth.ts              # SIWS nonce/verify, HttpOnly session cookie + CSRF
│  ├─ services.ts          # paid services: ref_hash verification, handle claim, entitlements
│  ├─ pyth.ts              # PriceUpdateV2 decoder + push-oracle PDAs (our shard 0xCA75), validation 1:1 with the program
│  ├─ pyth-cache.ts        # worker: mirrors our two Pyth accounts into oracle_prices every 10 s
│  ├─ quote.ts             # POST /packs/quote — integer pricing (units_for_cents), slippage guard, pity/caps
│  ├─ chain.ts             # PDAs, account decoders (PendingPack/Fusion, WagerBattle, GameConfig, raw Switchboard) + ix builders for the crank
│  ├─ tx.ts                # keypair tx pipeline: CU budget, priority-fee policy, LUT, size check, decoded program errors
│  ├─ crank.ts             # worker: oracle reveal → open_pack / fuse_reveal / battle reveal → Switchboard rent reclaim (SEC-C3 part 3)
│  ├─ queries.ts           # read models behind the routes (+ crankStatus for /health)
│  ├─ fusion.ts            # /fusion/* — pre-flight of chip_core fuse rules, PDAs, set-safe suggestions
│  ├─ staking.ts           # /staking/* — pools / APY / pending estimates from DayClosed + Staked projections
│  ├─ arena.ts             # /arena/* — server-authoritative ranked PvP: queue, commit–reveal, seasons, ratings, rewards
│  ├─ quests.ts            # /quests/* — progress from indexed events, eligibility, caps, streak, Merkle claims
│  ├─ merkle.ts            # reward-root tree, byte-identical to staking::verify_proof (golden vector shared with client + Rust)
│  ├─ reward-oracle.ts     # keeper: quest (kind 2) + PvP (kind 3) + referral (kind 4) batches → publish_root with the oracle keys
│  ├─ referrals.ts         # referral accrual (5 % of a referee's real-revenue pack spend, welcome bonus) → referral_rewards → kind 4
│  ├─ battle-resolver.ts   # keeper: arena battle_oracle — fight from the revealed VRF value → resolve_battle
│  ├─ server.ts            # express app (createApp)
│  └─ serve.ts             # entry point
└─ test/                   # vitest: codec round-trips, projections, HTTP API (SIWS + services + game flow), Pyth reader + /packs/quote, crank (fake chain + fake oracle gateway), game (fusion / staking / arena / quests / reward oracle / battle resolver)
```

## Run

```bash
# from the repo root (workspace install; no native modules → no --ignore-scripts needed)
npm install

cd backend
export SOLANA_RPC_URL=https://api.devnet.solana.com   # default
npm run backfill          # catch up on history for all 4 programs (or: npm run backfill -- market)
npm run dev               # listener (backfills on start, then live) + API on :8787 + pyth-cache
CRANK_KEYPAIR=~/.config/solana/crank.json npm run crank   # separate process: the crank (needs a funded hot key)
BURN_ORACLE_KEYPAIR=~/.config/solana/burn-oracle.json npm run burn-oracle   # SEC-M1: hourly staking.report_burn from indexed burns
QUEST_ORACLE_KEYPAIR=… SEASON_ORACLE_KEYPAIR=… npm run reward-oracle          # quests (kind 2) + PvP (kind 3) + referrals (kind 4) Merkle roots every 6 h
BATTLE_ORACLE_KEYPAIR=~/.config/solana/battle-oracle.json npm run battle-resolver   # settles accepted wager battles (resolve_battle)
```

The four keeper keys (`CRANK`, `BURN_ORACLE`, `QUEST_ORACLE` / `SEASON_ORACLE`, `BATTLE_ORACLE`) are
the pubkeys the admin passes to `init_emission` / `set_oracles` / `init_arena` / `set_arena`
(`scripts/setup.ts`); keep them distinct, funded for fees only, and rotate through the admin
instructions — none of them can move value outside its own instruction's checks.

### The crank (`src/crank.ts`, docs/06 §4.3)

Every randomised action in the programs is two-phase: the player's transaction *commits* a
program-owned Switchboard randomness account, and a **permissionless** second instruction
(`open_pack`, `fuse_reveal`, `resolve_battle` after `reveal_battle_randomness`) settles it. The
app does the second half itself; the crank does it for everyone who closed the app, so that a
paid pack is opened within seconds, a losing fusion can never be withheld (SEC-C3), and
Switchboard rent goes back to the player (SEC-M7).

* **Discovery** — two tiers: `pack_purchases` with `status = 'pending'` (≈ 1 s after the buy is
  indexed) and every `CRANK_SWEEP_MS` a `getProgramAccounts` sweep by Anchor discriminator over
  `PendingPack`, `PendingFusion`, `WagerBattle` (fusions have no commit event; the DB may lag).
  Jobs live in `crank_jobs` keyed `kind:owner:nonce` — several workers on one DB and restarts
  are safe.
* **Chip numbers (SEC-B3 / shape #27)** — the same sweep also drains the market's index back-fill
  queue (`chips.game_index IS NULL AND burned_at IS NULL AND index_attempts < CRANK_INDEX_ATTEMPTS`):
  one batched `getMultipleAccountsInfo` of `CRANK_INDEX_BATCH` `ChipState` PDAs per pass, writing each
  `index` (the per-collection mint number the API renders as `Name #N` and sorts/filters by). Read-only
  and idempotent: a chip that already has a number is never in the queue, a burned one is skipped (the
  fusion closed its `ChipState`), and an unreadable asset is parked after the attempt ceiling instead of
  being retried forever. A chip whose number is still unknown is reported as `index: null` — never `#0`,
  which is a real chip of that district.
* **Reveal** — `POST {oracle.gateway_uri}/gateway/api/v1/randomness_reveal` (the same call the
  Switchboard SDK makes; the URI is read from the oracle account named in the randomness
  account) → signed payload → *our* `reveal_randomness` instruction (the account's authority is
  the program PDA, so the reveal must go through the program CPI). Value source order:
  `PendingPack.value` (bundles, SEC-C2) → `RandomnessAccountData.value` when `reveal_slot > 0`
  → gateway.
* **Settle** — `open_pack` per `pack_no` with the pre-simulated collection accounts
  (`expandRandomness(packSeed(value, qty, pack_no), livePackDef, pity, pool)` — the pity counter
  is re-read between packs), `$CG` treasury ATA on the last pack; `fuse_reveal` with the
  materials' collections read from their `ChipState`s; wagers get the reveal only (the battle
  oracle resolves). Reveal and settle share one transaction when they fit (our static lookup
  table, `LOOKUP_TABLE`); otherwise the reveal lands first on its own.
* **Idempotency / races** — the pinned account is re-read before every send; a lost race
  (`InvalidQuantity`, `opened > pack_no`, reveal already there) resumes from chain state, never
  counts as an error. The crank **never** calls `cancel_stale_*` — refunds are the player's
  decision; past the refund window (10 800 slots) with the oracle still silent the job goes
  `stale` and is re-checked every `CRANK_STALE_RECHECK_MS` so the rent reclaim still happens.
* **Close** — once the pinned account is gone (battle `Resolved`/`Cancelled`),
  `close_randomness` / `close_battle_randomness` returns the Switchboard rent (randomness
  account, wSOL escrow, LUT) to the owner.
* **Backoff / alerts** — 1 s → 60 s exponential, `CRANK_MAX_ATTEMPTS` (60) → `abandoned` + ALERT
  line (retried hourly). `/health.crank` reports queue depth, head age, abandoned count and
  `healthy` (≤ 200 pending, head ≤ 60 s, 0 abandoned). Every minute a summary line is logged.
* **Fees / key hygiene** — priority fee = median recent fee on the writable accounts, floor
  `CRANK_CU_PRICE_FLOOR`, cap `CRANK_CU_PRICE_CAP` and ≤ `CRANK_MAX_FEE_LAMPORTS` per tx
  (0.001 SOL). The hot key only pays fees and fronts rent that the programs reimburse; keep it
  between `CRANK_MIN_BALANCE_SOL` (alert) and `CRANK_MAX_BALANCE_SOL` (warning), refill from a
  cold wallet. Below `CRANK_HARD_FLOOR_SOL` nothing is sent.

Env: `CRANK_KEYPAIR` (required), `CRANK_POLL_MS` 2000, `CRANK_SWEEP_MS` 30000,
`CRANK_CONCURRENCY` 4, `CRANK_MIN_BALANCE_SOL` 0.5, `CRANK_HARD_FLOOR_SOL` 0.05,
`CRANK_MAX_BALANCE_SOL` 2, `CRANK_GATEWAY_TIMEOUT_MS` 10000, `CRANK_MAX_ATTEMPTS` 60,
`CRANK_CU_PRICE_FLOOR` 1000, `CRANK_CU_PRICE_CAP` 200000, `CRANK_MAX_FEE_LAMPORTS` 1000000,
`CRANK_STALE_RECHECK_MS` 600000, `CRANK_INDEX_BATCH` 100, `CRANK_INDEX_ATTEMPTS` 3, `CRANK_GATEWAY_RPC` (public RPC of the cluster — it is sent
to the oracle, never our keyed endpoint), `SWITCHBOARD_PROGRAM_ID` / `SWITCHBOARD_QUEUE`
(per cluster; `sb_mock` id on localnet), `LOOKUP_TABLE` (from `npm run create-lut`).

Prices for the SOL/SKR rails come from the studio's own Pyth push-oracle accounts (owner
decision Q7 — `ops/pyth-pusher/` runs the pusher; this service only *reads*):
`PYTH_SHARD_ID` (default `51829` = 0xCA75) or explicit `PYTH_SOL_ACCOUNT` / `PYTH_SKR_ACCOUNT`,
`PYTH_CACHE_EVERY_MS` (10 000), `QUOTE_CACHE_MS` (2 000), `SWITCHBOARD_QUEUE` (per cluster).
`GET /prices` shows what the pusher last posted and how old it is.

The Vite dev server proxies `/v1` to `http://127.0.0.1:8787`, so the client
uses the real API whenever it is up and falls back to its in-browser mock
when it is not. There are no `501` stubs left: `/admin/*` is served by
`src/admin.ts` (below) and answers `401/403` to non-admins.

Environment: `SOLANA_RPC_URL`, `SOLANA_WS_URL`, `PROGRAM_{CHIP_CORE,MARKET,STAKING,ARENA}`,
`DB_PATH` (default `backend/guttercaps.sqlite`), `PORT` (8787), `CORS_ORIGINS`,
`SESSION_SECRET`, `COOKIE_SECURE=1` behind https, `SOL_USD_FALLBACK`, `SKR_USD_FALLBACK`,
`ADMIN_WALLETS` (comma-separated base58 — the only wallets `/v1/admin/*` accepts; empty = admin off),
`ANTIFRAUD_WINDOW_DAYS` (7).

Proof of human + device dedupe (`src/human.ts`, T-B-49): `TURNSTILE_SECRET` turns the Cloudflare
Turnstile gate on (`POST /me/human` → siteverify → 7-day pass; quest / SKR settlement waits for it,
nothing is zeroed), `TURNSTILE_SITE_KEY` is handed to the client through `/me.human.siteKey`,
`HUMAN_CHECK_TTL_S` (604800), `HUMAN_CHECK=0` is the explicit opt-out (production refuses to start
without a secret or the opt-out), `DEVICE_MAX_WALLETS` (3) wallets per device may earn rewards
(the 4th+ gets `device_limit`: plays and ranks, earns no quest / PvP / season rewards),
`DEVICE_SALT` (defaults to `SESSION_SECRET`) salts the stored device hashes — the raw client
fingerprint is never persisted. Support lifts both gates per wallet with the admin resolution
`trust` (`npm run antifraud -- resolve <wallet> trust "shared family tablet"`).

Security knobs (docs/06 SEC-H3 / SEC-M4): `SIWS_DOMAINS` — hosts a sign-in message may name
(defaults to the hosts of `CORS_ORIGINS`; unrestricted only while CORS is `*` in dev);
`SIWS_MAX_DRIFT_S` (300) for `Issued At`; `RATE_LIMIT=0` disables the limiter for local load
scripts. Policies live in `src/ratelimit.ts` (nonce 10/min/IP + 30/h/wallet, reads 600/min/IP,
mutations 60/min/session, quotes 30/min, claims 10/min + 40/min per IP /24 on `/services/claim`,
`PUT /me/handle`, `/arena/queue`, human checks 6/min/session + 30/h per IP /24; `429` +
`Retry-After` + `RateLimit-*`; bodies ≤ 16 KB). With `NODE_ENV=production` the API refuses to start unless `CORS_ORIGINS` is an
explicit list, `COOKIE_SECURE=1`, `SESSION_SECRET` is ≥ 32 chars and a SIWS domain is known.

### The burn oracle (`src/burn-oracle.ts`, docs/06 SEC-M1)

The staking emission guard mints per day at most `min(cap, 0.30·cap + 1.25·burn7d)`, but the
programs that burn $CG (packs in $CG, fusion fees, services, listing fees, arena rake) only emit
events in v1. This keeper sums the `burns` table since its durable cursor (`burn_oracle_cursor`,
keyed by `events_raw` rowid; staking's own early-exit rows are skipped because the program already
counted them) and sends `staking.report_burn(delta)` signed by `BURN_ORACLE_KEYPAIR` — the key the
admin designated with `set_oracles { burn_oracle }` (`npm run setup -- --step burn-oracle`). The
cursor advances only after confirmation; a crash re-reports at most one interval and the on-chain
clamp (`burn_today ≤ 3 × daily cap`) bounds any double count. Deltas under
`BURN_ORACLE_MIN_REPORT_MICRO` (1 $CG) are carried over; anything above
`BURN_ORACLE_MAX_REPORT_MICRO` (5 M $CG) is refused with an `ALERT` (indexer bug, not a tx).
`GET /v1/health.burnOracle` shows the last report, its age, what is pending and `healthy`
(reported within 3 × `BURN_ORACLE_INTERVAL_MS`, default 1 h, or nothing material waiting).

### Finality (`src/finality.ts`, docs/06 SEC-M5)

Projections are applied at `confirmed` (live UI), but nothing of value is handed out until the
transaction is **finalized**. The reconciler (runs inside `listen`, or standalone `npm run finality`)
stamps `events_raw.finalized_at` via `getSignatureStatuses` for signatures older than
`FINALITY_MIN_SLOTS` (150), and when the cluster no longer knows a signature (fork) or reports it
failed, deletes its raw events and rebuilds every projection from the remaining log — the ghost chip
or sale simply disappears. Paid-service claims (`PUT /me/handle`, `POST /services/claim`) answer
`409 payment_pending` until the payment is finalized; the client retries for up to ~2.5 min
(`claimWithRetry`). If a dropped transaction had already been consumed, the log carries an
`[finality] ALERT … manual review` line. `GET /v1/health.finality` shows the lag.
`FINALITY_ASSUME=1` skips the gate for local development only (refused in production).

Settlement uses the same rule through `finalizedHorizon(db)` — the slot just below the oldest
unfinalized event. `quests.settleWallet` (and the streak's `quest_days`), `eligibility`, `myGrid`
(sets), `arena.settleSeason` (the `DayClosed` pool) and the reward oracle's `runOnce` (one horizon
snapshot per cycle, reported as `/health.rewardOracle.finalizedHorizonSlot`) only count on-chain rows
with `slot <= horizon`; `/quests` still shows live confirmed progress. A quest finished after the
last oracle pass of its day/week is credited on the next pass (settlement looks one period back);
the daily/weekly caps are attributed to the period's day (`quest_completions.day`). A stuck RPC
freezes the horizon, which is the safe direction: nothing gets paid until finality is proven again.

### Admin service (`src/admin.ts`, docs/03 §3.5, T-B-46)

`/v1/admin/*` is the API of the internal live-ops panel. Gate: a normal SIWS session whose wallet is
in `ADMIN_WALLETS`, CSRF on mutations, and an `admin_audit` row for every call (denied ones too,
`denied:<method> <path>`). **The process holds no admin key.** Every on-chain change is only
*validated and encoded*:

| Endpoint | What it does |
|---|---|
| `GET /admin/params` | decodes the live `GameConfig` + `EmissionState`, `params_changes` history, the guard-rail table |
| `POST /admin/params` | validates a `ParamsProposal` against the exact `set_params` / `set_split` `require!`s (odds sum, Common ≥ 5 %, Legend+ + Diamond ≤ 2 % / 4 % per slot, price $0.50–$500, pity shape, fee ≤ 10 %, SKR discount ≤ 15 %, featured < collections; split sum, ±1000 bps, 7-day interval) plus economy warnings (EV/price band, Legend faucet), returns the Borsh-exact instructions for Squads or `422` with `details.violations` |
| `POST /admin/kill-switch` | encodes `pause` for the hot pauser (needs a reason) or the admin-only un-pause (`set_paused(false)` / `set_arena(paused = Some(false))`) |
| `POST /admin/simulate` | `dailyFlows` from `packages/economy` with overridden assumptions and a hypothetical split |
| `GET /admin/kpi` | PRD KPIs from the projections: D1/D7/D30 cohorts (login or match on day N), conversion, ARPPU, 7-day sink ratio, floor index (USD per Common-eq), market / arena / fraud / finality health |
| `GET /admin/fraud`, `POST /admin/fraud/{wallet}` | the anti-fraud queue and its resolutions (next section) |
| `GET /admin/audit` | the audit log |

The UI is `client/src/features/admin/Admin.tsx` (route `/admin`, docs/04 §4); `GET /me` carries
`isAdmin` so the client can show the entry point, while this gate stays authoritative. The client's
mock (`client/src/api/mock`) mirrors the guard-rails for offline UI work; `backend/test/admin.test.ts`
pins the instruction bytes against the program layouts.

### Anti-fraud (`src/antifraud.ts`, docs/03 §3.4)

Read-only detectors over the projections write `fraud_signals` (one open row per wallet × kind ×
subject): **win_trading** (pairs ≥ 6 matches / 7 d with one side ≥ 80 % and a rating gap ≤ 150;
farm rings ≥ 60 % of ≥ 12 matches vs ≤ 3 opponents), **wash_trade** (the same chip A→B→A ≥ 2×, or
repeated sales ≥ 3× floor between one pair), **quest_bot** (≥ 25 logins at the same minute, no other
activity), **multi_account** (≥ 5 starter-only wallets under one referrer), **device_ring** (more
than `DEVICE_MAX_WALLETS` wallets on one device hash — the late ones are already `device_limit`
automatically, the signal points at the early ones). They run at the start
of every reward-oracle cycle and via `npm run antifraud -- scan | queue | resolve <wallet>
<ignore|shadow_ban|rewards_pause|ban|unflag|trust> [note]`. Nothing is banned automatically; the only
automatic effect is the arena's daily gate — a pair that looks like win-trading in the last 24 h
earns no match rewards for the rest of the day. Ops decisions land in `wallets.flags`:
`rewardsPaused` (no quest $CG, no match rewards, no season payout) and `shadowBanned` (hidden from
every public board and from the season brackets). `GET /v1/health.antifraud` summarises the queue.

### The arena (`src/arena.ts`, docs/02 §4, docs/03 §3.1)

Ranked Cap Slam runs inside the API process (a sweep every `ARENA_SWEEP_MS` = 3 000 ms pairs
waiting players, fills with bots after 45 s, forfeits matches whose reveal timed out and publishes
finished seasons' secrets). The protocol is commit–reveal:

1. `POST /arena/queue { squad[3], commit = sha256(nonce) }` — the squad is checked like
   `arena::validate_squad` (owned, not listed / fusing, distinct, power ≥ 400) and the league is the
   on-chain power band, so three Diamonds never meet three Commons; the rating window starts at
   ±100 and widens 5 pts/s to ±300.
2. Once paired both sides `POST /arena/matches/{id}/reveal { nonce }` (the client does this
   automatically from `sessionStorage`); `seed = sha256(matchId ‖ nonceA ‖ nonceB ‖ serverSecret)`,
   `roll(lane, side) = u32le(sha256(seed ‖ lane ‖ side)) / 2³²`, and `resolveFight` from
   `packages/economy/src/fight.ts` produces the rounds. Nobody can steer the pairing towards a
   favourable seed (the server only knows commits) or change a nonce after seeing the opponent.
3. A side that never reveals forfeits after `ARENA_REVEAL_TIMEOUT_S` (120) — the honest side wins
   (no rewards); if nobody reveals the match is cancelled.
4. Rewards (2 / 0.5 $CG) go to `pvp_rewards` under the anti-farm caps (8 rewarded matches per day,
   ≤ 3 rewarded vs the same wallet, bots pay participation only) and are paid through kind-3 Merkle
   roots by the reward oracle — the arena never mints.
5. Seasons last 6 weeks: `server_secret_hash` is public from day one, the secret itself appears in
   `/arena/seasons/current.previous.serverSecret` after the season ends, so every match record
   (`GET /arena/matches/{id}` — commits, nonces, seed, rounds) can be re-run by anyone.
   Set `ARENA_SEASON_GENESIS` (unix s) in production so season ids are stable across deploys.

Wager battles never touch this queue: they are escrowed on chain (`create_battle` / `accept_battle`),
the crank reveals their Switchboard randomness and **`src/battle-resolver.ts`** (the program's
`battle_oracle`, `BATTLE_ORACLE_KEYPAIR`, `npm run battle-resolver`) runs the same engine seeded by
the revealed VRF value and settles with `resolve_battle(winner, result_hash)`; the program re-checks
the winner, the ATA owner, the VRF, the daily oracle cap and splits the rake itself. Resolved battles
are stored as matches keyed by the battle PDA so the replay screen works for both kinds.

### The reward oracle (`src/reward-oracle.ts`, docs/02 §9)

Every `REWARD_ORACLE_INTERVAL_MS` (6 h): settle quests for every recently active wallet
(`quests.settleWallet` — progress from indexed events, eligibility = paid pack **or** 24 h + 10
matches, `rewardsPaused` flag, 15 $CG/day + 120 $CG/week caps), then per kind (2 quests, 3 PvP)
sum the unrooted amounts per wallet, build the Merkle tree (`src/merkle.ts`, same bytes as
`staking::verify_proof`), store leaves + proofs (`reward_batches`, `reward_leaves`) and send
`publish_root(kind, epoch, root, budget)` signed by `QUEST_ORACLE_KEYPAIR` / `SEASON_ORACLE_KEYPAIR`.
The program only lets a root reserve budget that `tick_day` already accrued into that slice, so the
oracle can never mint beyond the schedule; the admin can `revoke_root` inside the 1 h timelock.
`/quests/claims` lists the wallet's leaves — `claimableAt` is null until the indexer sees
`RootPublished`, then `published_at + 1 h`; the client claims with `claim_root`. Batches below
`REWARD_ORACLE_MIN_BATCH_MICRO` (5 $CG) wait for the next epoch; above
`REWARD_ORACLE_MAX_BATCH_MICRO` (2 M $CG) the cycle refuses (bug, not a tx).
`GET /v1/health.rewardOracle` shows pending batches, unrooted totals, `unfundedRake` and the SKR periods.

SKR prize pool (docs/02 §7.7, kinds 5 / 6): the same cycle reads the on-chain `SkrPool` and, when the
emission's oracle keys match ours, builds **Seeker week** (kind 5, quest key): every wallet that
completed all four $CG weeklies of the last finished week (`w_all`) and passes `skrEligibility`
(paid pack + 7 d age, no flags) shares `min(pool.budget × 25 %, max_root_budget)` equally, capped at
25 SKR each; and the **season ladder** (kind 6, season key): once a season has settled on the $CG
side, `min(pool.budget × 55 %, max_root_budget)` is split with the same brackets among the
qualified + eligible wallets, capped at 2 000 SKR / wallet / season. `skr_allotments` keeps one row
per week / season (never paid twice); a thin (< `SKR_MIN_BATCH_MICRO`, 10 SKR) or paused pool
leaves the period open for the next cycle. Publishing goes through `publish_skr_root`
(`budget → reserved` on chain, nothing minted) and `/quests/claims` routes the leaf to
`claim_skr_root`.

Season rake (SEC-L5): `arena::resolve_battle` sends 20 % of every wager rake to the on-chain season
pool (a $CG ATA under staking's `["season_pool"]` PDA). When a season settles, `arena.settleSeason`
freezes that share next to the emission share (`seasons.rake_micro`, finalized battles only) and the
next oracle cycle sends `staking::fund_slice(3, Σ rake_micro − EmissionState.recycled_total)` with
the season key before building the kind-3 batch: the pool is burned into `slice_budget[3]` and the
claim re-mints it outside the yearly schedule (`recycled_*`), so the rake is paid out without
inflation. `fundSettledRake` is idempotent against the chain state and clamps to the pool balance.

Booster quest rewards (`w_stake`, `p_set1`) are delivered on-chain through **item roots** (kind 8,
backlog #27): `buildItemBatch` sums `quest_completions.reward_booster` per wallet into a Merkle leaf
whose amount is the booster COUNT (≤ 10 per wallet per root — chip_core's `grant_booster` cap — and
≤ 1 000 per root; the remainder carries over to the next epoch, and only the rows actually leafed get
`item_root_kind/epoch`), the quest oracle publishes it with `publish_item_root`, and the player's
`claim_item_root` verifies the proof and CPIs `chip_core::grant_booster` signed by staking's
`["rewarder"]` PDA — the boosters land in `PlayerItems` in the claim transaction, no ops key involved.
`/quests/claims` lists these leaves with `currency: ITEM`; `/health.rewardOracle.unrootedBoosters`
shows what is still owed.

Chip quest rewards (7-day streak roll, weekly roll, milestone Epic, 5 referrals) go through **chip
voucher roots** (kind 9, backlog #28). `quest_completions.reward_chip` stores the voucher template
(`{template, odds, soulboundDays}` = `QUEST_CHIP_TEMPLATES`, NULL when the wallet was ineligible);
`buildChipBatch` turns unrooted rows into leaves whose amount is the TEMPLATE id — one voucher per
wallet per epoch, at most `ANTI_FARM.freeChipsPerWalletPerWeek` (2) per wallet per week counting the
vouchers already rooted this week, ≤ 500 leaves per root (`budget` = leaf count), remainder carried
over; rows whose odds match no template stay pending and are surfaced as
`/health.rewardOracle.unrootedVouchers.unknownTemplate`. The quest oracle publishes with
`publish_chip_root`; the player's `claim_chip_root(template, proof, nonce)` (sent together with
chip_core `init_randomness(0, nonce)`, exactly like a purchase) CPIs `chip_core::open_voucher` signed by
`["rewarder"]`, which creates a free 1-chip `PendingPack` committed to Switchboard and emits
`VoucherIssued` — indexed into the `vouchers` table (`pending → opened | cancelled`). The **same crank**
discovers vouchers next to purchases (`discoverFromDb` UNION) and opens them with `voucherEconPack`
(one chip, the template odds, no floor / pity); the resulting chip has `origin = 'voucher'` and is
soulbound for the template's days. `/me/pending` lists the voucher pending with a `voucher` block,
`/packs/opens/:sig` and `/packs/verify` report the template odds as `effectiveOddsBps`.

## How indexing works

1. **Decode without an IDL.** Anchor logs `Program data: base64(sha256("event:Name")[..8] ‖ borsh)`.
   `events.ts` declares each event's fields in Rust order and derives the
   discriminator table; the log walker keeps an invoke/success stack so an event
   emitted by `chip_core` during a `market` CPI is attributed to `chip_core` with
   the outer instruction index. Failed transactions are skipped entirely.
2. **`events_raw` is the truth.** Unique on `(signature, ix_index, event_index)`.
   Backfill and the live listener both insert with `ON CONFLICT DO NOTHING`; a
   projection is applied only when the insert actually happened, inside the same
   SQLite transaction. Rows first seen over websocket have `block_time = NULL`
   until the healer/backfill fills it.
3. **Projections are rebuildable.** `chips`, `listings`, `sales`, `battles`,
   `stakes`, `burns`, `service_payments`, … are pure functions of the log.
   `npm run rebuild` truncates and replays. `wallets` (handles, referrer, risk)
   is *not* derived from chain and is kept.
4. **Gaps heal themselves.** `listen.ts` re-scans the newest 200 signatures per
   program every minute; because ingestion is idempotent this is cheap and
   closes any websocket drop without an operator.

Cursor per program lives in `indexer_cursor`; backfill stops when it meets
`newest_signature` and only advances it after a complete walk.

## Paid services (handles, skins, passes)

Payment is proven on-chain by `chip_core::pay_service` → `ServicePaid { buyer, kind, currency, amount, burned, ref_hash }`.
The backend proves *what* was bought by recomputing

```
ref_hash = keccak256(0x00 ‖ kind:u8 ‖ wallet:32 ‖ payload)
payload  = lowercase(handle)          for kinds 0/1
         = canonical JSON (sorted keys, no whitespace) otherwise
```

* `GET /me/handle/check?handle=` — validity, blocklist, case-insensitive uniqueness,
  90-day quarantine of released handles, 30-day change cooldown; reserves the
  name 120 s for the caller and returns the `refHash` to commit.
* `PUT /me/handle {handle, signature}` — finds the unconsumed `ServicePaid` of the
  right `kind` from the caller in that transaction, checks `ref_hash`, assigns the
  handle and marks the payment consumed — atomically. Old handle → `handle_history`.
* `POST /services/claim {signature, kind, payload}` — same for cosmetics; cap skins
  additionally require current ownership of the cap. Season pass expires after 42 days.
* `GET /me/services` — entitlements + `dailyLeft` per kind (mirrors the on-chain
  `ServiceLedger` caps: 1/day handles, 3/day boosters, 10/day others).

Every receipt is single-use (`service_payments.consumed_by`); mismatches return
`402 {code: payment_not_found | payment_kind_mismatch | payment_consumed | ref_hash_mismatch}`.

## Auth

SIWS: `POST /auth/siws/nonce` → sign → `POST /auth/siws/verify` (ed25519 over the
exact message; nonce single-use, 5 min). Session id is an HttpOnly cookie
(`gc_session`, HMAC-signed); mutating requests must echo `X-CSRF-Token`.

## Endpoints served here

`/health`, `/stats`, `/wallet/:address/events` (legacy, also at the root for the landing page),
`/auth/siws/*`, `/me`, `/me/chips`, `/me/grid`, `/me/activity`, `/me/pending`, `/me/handle/check`,
`/me/handle`, `/me/services`, `/services`, `/services/claim`, `/packs`, `/packs/opens/:sig`,
`/packs/verify`, `/collections`, `/chips/:asset`, `/market/listings|floor|history|offers`,
`/leaderboard/:board` (rating = arena season ladder, `?season=` | wins = chain wager wins | collection | staking | fusion), `/prices`,
`POST /packs/quote` (auth; SOL/SKR priced from our Pyth accounts with the program's integer
formula, `maxLamports` = ×1.01, `priceUpdateAccount`, `expiresAt`; **503 price_unavailable**
when the on-chain update is older than 45 s or missing — the client then hides that rail).

Game endpoints (see the sections above): `/fusion/recipes`, `POST /fusion/plan` (auth; 422 with
the chain's reason), `/fusion/suggest` (auth), `/staking/overview`, `/staking/me` (auth),
`POST /staking/estimate`, `/arena/seasons/current`, `POST /arena/simulate`, `/arena/me` (auth),
`POST|DELETE /arena/queue` (auth), `POST /arena/matches/:id/reveal` (auth), `/arena/matches/:id`,
`/quests` (auth; records today's login), `/quests/claims` (auth), `/quests/streak` (auth),
`POST /quests/login` (auth).

`501 not_implemented`: `/admin/*` only — the Squads-gated admin service (docs/06 backlog #18).

## Production notes

* Swap `db.ts` for Postgres (`prisma/schema.prisma` — `EventRaw`, `IndexerCursor`,
  `Wallet`, `ServicePayment`, `Entitlement`, …). Keep the `(signature, ix_index, event_index)`
  uniqueness and the "apply projection only when inserted" rule.
* Feed Helius enhanced webhooks into `ingestTx` (same `TxLike` shape) and keep
  `listen.ts` as the fallback path.
* Prices: `pyth-cache` writes `oracle_prices` (SOL, SKR) from **our on-chain Pyth accounts**
  every 10 s (the pusher in `ops/pyth-pusher/` posts them); the `*_USD_FALLBACK` env values
  only cover a fresh dev database and are used for USD display, never for on-chain amounts —
  `/packs/quote` refuses (503) instead of guessing.
* Crank: run **two** replicas against the same DB (jobs are keyed and every send re-reads the
  chain, so duplicates only cost a failed simulation); one of them may live in another region.
  Alert on `/health.crank.healthy == false`, on the `ALERT` log lines (payer balance, abandoned
  job, SLA), and on `stale > 0` for more than an hour (oracle outage). Create the lookup table
  (`npm run create-lut -- create`) before enabling 5-chip SKUs — without it a 5-chip `$CG` open
  does not fit in one transaction and the crank parks the job with a `configure LOOKUP_TABLE`
  error instead of guessing.

## Tests

```bash
npm test          # vitest: 111 tests — codec round-trips for all 30 events, CPI attribution,
                  # idempotent ingest, rebuild equivalence, failed-fusion refunds, floors,
                  # SIWS (bad signature, nonce reuse, CSRF), handle lifecycle, service claims,
                  # Pyth PriceUpdateV2 decode/validate (owner, feed, verification, age),
                  # /packs/quote (integer pricing, 503 on stale, starter/daily caps, pity → odds)
                  # and the crank against a fake chain + fake oracle gateway (instruction
                  # layouts, gateway payload, reveal→open→close, bundles, resume from
                  # PendingPack.value, backoff, stale, lost races, abandoned, low balance,
                  # sweep discovery, fusions, wagers, LUT fit vs. split), the burn oracle,
                  # finality, and the game layer (fusion planner vs. fuse rules, staking
                  # estimates, arena queue → reveal → deterministic resolution → ratings /
                  # rewards / forfeits / bots / seasons, quests from events + caps + streak,
                  # reward oracle batches → publish_root, battle resolver)
npm run typecheck
```
