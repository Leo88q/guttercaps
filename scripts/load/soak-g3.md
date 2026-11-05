# G-3 Devnet Soak Bot

**14-day continuous test bot for G-3 launch gate validation**

> **Status**: all seven gate KPIs are measured — four by the bot itself, three from the deployment under
> test (`SOAK_API_BASE` → `/v1/health`, `/metrics`). No simulated numbers (находка 92).
> **Node Requirement**: 24+ (SEC-B50)
> **Last Updated**: 2026-11-06

---

## 🎯 G-3 Requirements (docs/06 §1.4)

| Metric | Target | Current Implementation |
|---|---|---|
| **Packs purchased** | ≥ 10,000 | ✅ Concurrent workers with weighted distribution |
| **Packs opened** | ≥ 10,000 | ⚠️  Opened **by the crank**, not by the bot — the bot only sends `buy_pack` and counts opens locally |
| **Fusions completed** | ≥ 500 | ✅ 20% probability per operation |
| **Risky fusions** | ≥ 100 | ✅ 20% of fusions marked as risky |
| **Wager matches** | ≥ 200 | ✅ 15% probability per operation |
| **Abandoned pending** | 0 | ✅ Peak of `/v1/health.crank.abandoned` over the run |
| **Stale pending** | 0 | ✅ Peak of `/v1/health.crank.stale` + `stalePacks` + `arena.staleBattles` |
| **Crank p95** | ≤ 20,000ms | ✅ Bucket quantile of `crank_settle_latency_ms` from `/metrics` |

The gate fails unless **all** of the following hold (docs/06 §1.4):

- **≥ 10,000 packs** purchased (10,000 packs minimum)
- **≥ 500 fusions** completed (500 fusions minimum), of which **≥ 100 risky** (100 risky minimum)
- **≥ 200 wager matches** (200 wager matches minimum)
- **0 abandoned pending** packs/fusions/battles
- **0 stale pending** packs/fusions/battles
- **crank p95 ≤ 20 seconds** (20,000 ms)

---

## 🚀 Quick Start

### Prerequisites

1. **Node 24+** (required by SEC-B50)
2. **Funded devnet wallet** (150-200 SOL recommended for 10,000 packs)
3. **RPC endpoint** with WebSocket support

No `anchor build` and no IDL files are needed — the bot builds every instruction
by hand (see "Build Programs (Not Needed)" below).

### Run the Soak Bot

```bash
# Set environment variables
export DEVNET_RPC_URL=https://api.devnet.solana.com
# PRIVATE_KEY = base64 of the RAW 64-byte secret key (NOT base64 of the solana-cli
# JSON file — that encodes the JSON text and Keypair.fromSecretKey rejects it):
export PRIVATE_KEY=$(node -e "console.log(Buffer.from(require(process.argv[1])).toString('base64'))" ~/.config/solana/id.json)

# Run with defaults (14 days, 10,000 packs, 5 workers)
npm run load:soak-g3
```

### Custom Configuration

```bash
# 1 day test with 100 packs and 2 workers
SOAK_DURATION_DAYS=1 SOAK_TARGET_PACKS=100 SOAK_CONCURRENCY=2 \
  DEVNET_RPC_URL=https://api.devnet.solana.com \
  PRIVATE_KEY=$(base64 -w0 ~/.config/solana/id.json) \
  npm run load:soak-g3
```

---

## 📋 Configuration Reference

| Variable | Default | Description |
|---|---|---|
| `DEVNET_RPC_URL` | `https://api.devnet.solana.com` | Solana devnet RPC endpoint (must support WS) |
| `PRIVATE_KEY` | *(required)* | Base58-encoded private key (64-byte array) |
| `SOAK_DURATION_DAYS` | `14` | Test duration in days; fractions allowed (`0.0417` ≈ 1 hour) |
| `SOAK_TARGET_PACKS` | `10000` | Target packs to purchase |
| `SOAK_CONCURRENCY` | `5` | Number of concurrent worker threads |
| `SOAK_INTERVAL_MS` | `1000` | Minimum ms between operations per worker |
| `SOAK_LOG_INTERVAL_MS` | `60000` | Metrics logging interval (ms) |
| `SOAK_WEIGHTS` | `0.65:0.20:0.15` | Operation weights as `buy:fuse:battle` |
| `SOAK_API_BASE` | `http://127.0.0.1:8787` | Backend under test; the pending and latency KPIs are read from it |
| `SOAK_METRICS_URL` | `${SOAK_API_BASE}/metrics` | Prometheus scrape of the same backend |
| `SOAK_SAMPLE_INTERVAL_MS` | `60000` | How often the bot reads health + metrics |
| `SOAK_ALLOW_BLIND` | unset | `1` = start even when the backend is unreachable; the gate then reports UNMEASURED and **fails** |

---

## 🔧 Setup Guide

### 1. Create a Devnet Wallet

```bash
# Create a new keypair
solana-keygen new --out-file ~/.config/solana/soak-key.json

# Get the private key as base64 of the RAW 64-byte secret key.
# NOTE: `base64 -w0 ~/.config/solana/soak-key.json` is WRONG — it encodes the
# JSON text "[12,34,...]", not the 64 bytes, and Keypair.fromSecretKey rejects it.
export PRIVATE_KEY=$(node -e "console.log(Buffer.from(require(process.argv[1])).toString('base64'))" ~/.config/solana/soak-key.json)

# Get the public key
export SOAK_PUBLIC_KEY=$(solana address -k ~/.config/solana/soak-key.json)

# Request airdrop
solana airdrop 10 --url devnet $SOAK_PUBLIC_KEY
```

### 2. Build Programs (Not Needed)

The bot hand-builds every instruction (Borsh discriminators + PDAs, program IDs
from `Anchor.toml`) and reads **no IDL files** — `anchor build` is not a
prerequisite for the soak. Build the programs only if you also want to verify
they compile (`npm run programs:build`).

### 3. Choose RPC Provider

**Public (rate-limited)**:
```bash
export DEVNET_RPC_URL=https://api.devnet.solana.com
```

**Recommended (private)**:
- QuickNode: `https://your-devnet-endpoint.quiknode.pro/your-token/`
- Helius: `https://devnet.helius-rpc.com/?api-key=your-key`
- Triton: `https://devnet.triton.one`

---

## 📊 Metrics Output

The bot outputs metrics every 60 seconds (configurable):

```
============================================================
  G-3 SOAK METRICS
============================================================
  Elapsed: 120.5 min (1.674 days)
  Progress: 35.0% (3500/10000 packs)

  Packs: 3500 purchased, 3500 opened
  Fusions: 120 total, 24 risky
  Wager Matches: 45

  Throughput: 175.0 packs/hour, 280.0 tx/hour
  Errors: 2 total

  Pending (peak of 40 sample(s) from http://127.0.0.1:8787): 0 abandoned, 0 stale, 0 stale packs, 0 stale battles
  Crank: p95 <= 20000 ms, p99 <= 30000 ms over 1250 settled job(s)
============================================================
```

---

## ✅ Metrics Honesty — where each number comes from

Every KPI in the gate is either counted by the bot or read from the deployment it is hammering. There is
no third kind of number in the report (this section used to explain three placeholders — see находка 92).

| KPI | Source | How it is read |
|---|---|---|
| Packs, fusions, risky fusions, wager matches | the bot | incremented when the transaction confirmed |
| Abandoned crank jobs | `/v1/health` | `crank.abandoned`, **peak** over all samples — one abandoned job in hour 3 must not be washed out by a clean hour 12 |
| Stale crank jobs | `/v1/health` | `crank.stale` (missed reveal window → the player is refunded), plus `stalePacks` (paid and unopened past `STALE_PACK_SLOTS`) and `arena.staleBattles` |
| Crank p95 | `/metrics` | histogram `crank_settle_latency_ms` (commit → settled, observed by the crank), bucket-quantile at 0.95 |

Three properties of those reads that the report relies on:

* **Peaks, not last values.** The gate says "0 abandoned", so any nonzero sample fails it, whenever it happened.
* **Bucket bound, not interpolation.** `p95 ≤ 20 000 ms` answers exactly: the covering bucket is `le=20000`,
  so at least 95 % of settled jobs really were inside the budget. An interpolated number would look more
  precise and be wrong in exactly the case the gate exists for.
* **UNMEASURED is not zero.** If the API was unreachable, the histogram was empty or the backend never
  reported a field, those rows print `not measured` and the gate **fails**. A soak that watched nothing did
  not prove "0 abandoned jobs", and this is precisely how the previous version of this report was wrong.

Two related notes:

* The bot sends `buy_pack` but never opens packs — opening is the crank's job, which is why the pending KPIs
  come from the deployment and not from the bot's own counters.
* `npm run load:soak-g3:validate` remains the independent, after-the-fact check: it walks `PendingPack` /
  `PendingFusion` / `WagerBattle` **on chain** with `getProgramAccounts` and fails on anything older than
  `STALE_PACK_SLOTS`. Run it once after the soak; it does not need the backend to be alive.

---

## 🏁 Final Validation

At the end of the soak period, the bot outputs G-3 gate validation:

```
============================================================
  G-3 GATE VALIDATION
============================================================
  PASS       Packs (>= 10,000): 10000
  PASS       Fusions (>= 500): 520
  PASS       Risky fusions (>= 100): 115
  PASS       Wager matches (>= 200): 210
  PASS       No abandoned crank jobs: 0 (peak of 4032 samples, /health.crank.abandoned)
  PASS       No stale crank jobs: 0 (peak of 4032 samples, /health.crank.stale)
  PASS       No stale unopened packs: 0 (peak of 4032 samples, /health.stalePacks)
  PASS       No stale battles: 0 (peak of 4032 samples, /health.arena.staleBattles)
  PASS       Crank p95 (<= 20 s): <= 20000 ms (bucket bound, 9987 settled jobs)

  G-3 Gate: PASS
============================================================
```

**Exit Code**: 0 = PASS, 1 = FAIL (and `UNMEASURED` rows fail the gate — see "Metrics Honesty").

---

## 🏗️ Implementation Details

### Operation Distribution

The bot uses weighted random selection for operations:

| Operation | Probability | Notes |
|---|---|---|
| Buy Pack | 65% | All 4 SKUs (starter, standard, premium, ultimate); the pack is opened later by the crank |
| Fusion | 20% | 20% of fusions are sent with `use_booster` ("risky") — the counter tracks the real instruction |
| Wager Match | 15% | `create_battle` in the arena program |

The split is configurable via `SOAK_WEIGHTS=buy:fuse:battle` (default `0.65:0.20:0.15`).

### Worker Behavior

Each worker:
1. Checks wallet balance
2. Requests airdrop if balance < 0.5 SOL
3. Selects a random operation based on weights
4. Executes the operation with retry on failure
5. Respects minimum interval between operations
6. Tracks its own error count

### Error Handling

- **Network errors**: Automatic retry after 1 second
- **Insufficient funds**: Automatic airdrop request
- **Program errors**: Logged but worker continues
- **Fatal errors**: Worker stops, main process continues

### Monitoring

Background monitors run every `SOAK_SAMPLE_INTERVAL_MS` (default 60 s):
- **Pending state**: `GET /v1/health` → crank pending/stale/abandoned, stale unopened packs, stale battles
- **Crank latency**: `GET /metrics` → `crank_settle_latency_ms` (p95/p99) and how many jobs it covers
- **Inventory**: refresh of the chip PDAs the bot owns

The first sample happens **before** the workers start: a run that cannot read the deployment refuses to
begin (`SOAK_ALLOW_BLIND=1` is the deliberate opt-out, and it makes the gate fail — see above).

---

## ⚠️ Current Limitations & TODO

### ✅ Implemented
- [x] Concurrent worker system
- [x] Real `init_randomness` + `buy_pack` instructions (chip_core, hand-built Borsh — no IDL), account order mirroring `client/src/chain/ix/`
- [x] Real `fuse` instructions with recipes from `@guttercaps/economy`; `use_booster` drives the risky-fusion counter
- [x] Real `init_battle_randomness` + `create_battle` instructions (arena)
- [x] Mints and Pyth feeds read from the on-chain **GameConfig** at startup (never hardcoded)
- [x] PDA derivation matching `client/src/chain/pdas.ts` (kind-aware: arena owns battle randomness)
- [x] Healthy-oracle selection via the Switchboard SDK (same as `client/src/chain/switchboard.ts`)
- [x] Chip inventory tracking via deterministic asset PDAs — fuse/battle are **gated** on ≥3 free chips and enough $CG, and skip honestly otherwise (`ops skipped` counter)
- [x] Metrics collection and logging
- [x] G-3 gate validation (exit code 0 = PASS, 1 = FAIL)
- [x] Graceful shutdown (SIGINT/SIGTERM)
- [x] Automatic airdrop on low balance (devnet faucet — a top-up mechanism, **not** a funding strategy for 10K packs)

### ✅ Measured, not simulated (since находка 92)
- [x] **Pending state** from `/v1/health` (`crank.abandoned`, `crank.stale`, `stalePacks`, `arena.staleBattles`), peaks over the run
- [x] **Crank p95** from the `crank_settle_latency_ms` histogram in `/metrics` (bucket quantile, SLA 20 s)
- [x] An unreachable deployment stops the run at start-up instead of producing a report nobody measured

### ⚠️ Still open (not part of the gate)
- [ ] **`open_pack` from the bot** — packs are opened by the crank; the bot counts a pack as opened when its chip PDAs appear on-chain
- [ ] **`accept_battle`** — battles are created but never accepted or resolved by the bot
- [ ] **$CG funding** — fuse fees and battle wagers need $CG; on devnet the deploy wallet (mint authority per `scripts/setup.ts`) must mint $CG to the soak wallet — see [docs/G3-DEVNET-BETA-LAUNCH.md](../../docs/G3-DEVNET-BETA-LAUNCH.md)

### 📝 What a trustworthy PASS still requires

* The backend under test must be the one the crank actually runs in (`WORKERS=crank`): its `/metrics` is
  where `crank_settle_latency_ms` is produced.
* A backend restart resets the histogram. The bot notices (`_count` going down) and the report says the p95
  covers only the time since the restart — it does not silently present a partial number as the whole run.
* `npm run load:soak-g3:validate` after the run: an independent on-chain read of the same KPI.

---

## 🔌 Integration with CI

### GitHub Actions

The real workflow is
[`.github/workflows/g3-soak.yml`](../../.github/workflows/g3-soak.yml). It runs
on the **self-hosted runner** (`runs-on: [self-hosted, g3-soak]` — a 14-day soak
cannot fit in a GitHub-hosted job), takes the wallet from the `SOAK_PRIVATE_KEY`
repository secret, and never creates or airdrops a wallet:

```bash
# the deployment under test: where /v1/health and /metrics are read from
gh secret set SOAK_API_BASE --body "https://backend.<devnet-host>"

# 1-hour smoke test (100 packs, 2 workers)
gh workflow run g3-soak.yml -f duration_hours=1 -f target_packs=100 -f concurrency=2

# Production G-3 soak (14 days, 10,000 packs, 10 workers)
gh workflow run g3-soak.yml -f duration_hours=336 -f target_packs=10000 -f concurrency=10
```

Before the bot starts, the workflow checks two things and refuses to run if either fails: `/v1/health`
answers from the runner, and `/metrics` exposes `crank_settle_latency_ms`. Both are the difference between a
run that measures and a 14-day run that ends in `UNMEASURED`. The base URL comes from the `api_base`
workflow input or the `SOAK_API_BASE` secret.

A short nightly smoke (1 hour, ephemeral wallet, GitHub-hosted runner) lives in
[`.github/workflows/g3-soak-nightly.yml`](../../.github/workflows/g3-soak-nightly.yml); it skips itself with a
notice when `SOAK_API_BASE` is not configured, rather than starting a blind run.
The full launch sequence — runner check, RPC, funded wallet, secrets, test runs,
KPI validation — is in [docs/G3-DEVNET-BETA-LAUNCH.md](../../docs/G3-DEVNET-BETA-LAUNCH.md).

---

## 🐳 Docker Deployment

### Build Image

```bash
# From project root
docker build -t guttercaps-soak -f ops/deploy/Dockerfile.api .
```

### Run Container

```bash
docker run --rm -it \
  --name g3-soak \
  -e DEVNET_RPC_URL=https://api.devnet.solana.com \
  -e PRIVATE_KEY=$(node -e "console.log(Buffer.from(require(process.argv[1])).toString('base64'))" ~/.config/solana/soak-key.json) \
  -e SOAK_DURATION_DAYS=14 \
  -e SOAK_TARGET_PACKS=10000 \
  -e SOAK_CONCURRENCY=10 \
  guttercaps-soak \
  node scripts/load/soak-g3.js
```

### Docker Compose

```yaml
# docker-compose.soak.yml
version: '3.8'
services:
  soak:
    build:
      context: .
      dockerfile: ops/deploy/Dockerfile.api
    environment:
      DEVNET_RPC_URL: ${DEVNET_RPC_URL}
      PRIVATE_KEY: ${SOAK_PRIVATE_KEY}
      SOAK_DURATION_DAYS: 14
      SOAK_TARGET_PACKS: 10000
      SOAK_CONCURRENCY: 10
    command: node scripts/load/soak-g3.js
    restart: unless-stopped
```

---

## 🔍 Troubleshooting

### "ERROR: PRIVATE_KEY environment variable is required"

**Solution**: `PRIVATE_KEY` must be the base64 of the **raw 64-byte secret key**.
`base64 -w0 ~/.config/solana/id.json` encodes the JSON *text* and is rejected by
`Keypair.fromSecretKey`:

```bash
export PRIVATE_KEY=$(node -e "console.log(Buffer.from(require(process.argv[1])).toString('base64'))" ~/.config/solana/id.json)
```

Or create a new key:
```bash
solana-keygen new --out-file soak-key.json
export PRIVATE_KEY=$(node -e "console.log(Buffer.from(require(process.argv[1])).toString('base64'))" soak-key.json)
```

### "the deployment under test is not readable"

The bot exits at start-up when `SOAK_API_BASE` (default `http://127.0.0.1:8787`) does not answer, because
two of the seven gate KPIs come from there. Point it at the backend whose crank is opening the packs:

```bash
SOAK_API_BASE=https://dev-api.example ./scripts/... # or: bash scripts/mac-devnet.sh run, then the default works
curl -s $SOAK_API_BASE/v1/health | head -c 300      # sanity check
```

`SOAK_ALLOW_BLIND=1` starts anyway — the report will then list those KPIs as `UNMEASURED` and the gate will
fail. That switch exists for debugging the bot, not for producing a G-3 report.

### "Failed to connect to RPC"

**Solution**: Check your RPC URL:
```bash
# Test connection
curl -s -X POST $DEVNET_RPC_URL -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getVersion"}'

# Try public devnet
DEVNET_RPC_URL=https://api.devnet.solana.com npm run load:soak-g3
```

### "Insufficient funds"

**Solution**: Request airdrop or use a funded wallet:
```bash
# Request airdrop
solana airdrop 10 --url devnet YOUR_WALLET_ADDRESS

# Or increase airdrop threshold
SOAK_AIRDROP_THRESHOLD=5 npm run load:soak-g3
```

### "Do I need to run `anchor build` / where are the IDL files?"

**No.** The soak bot builds instructions by hand and reads no IDL files, so
there is no IDL prerequisite. If you see IDL errors, you are running a
different script — the soak bot's errors are prefixed `[Worker N]`.

### Rate Limiting

**Solution**: Use a private RPC endpoint:
```bash
# QuickNode example
DEVNET_RPC_URL=https://your-endpoint.quiknode.pro/your-token/ npm run load:soak-g3
```

---

## 📚 References

- [G-3 Definition](docs/06-acceptance-security-testing.md#14-launch-gates)
- [Production Readiness](docs/09-production-readiness.md)
- [MAC-DEVNET Setup](docs/MAC-DEVNET.md)
- [Devnet Beta Launch Plan](docs/G3-DEVNET-BETA-LAUNCH.md)
- [Program IDs](scripts/program-ids.ts)
- [Switchboard Integration](programs/chip_core/src/randomness.rs)

---

## 💡 Tips

1. **Start small**: Test with `SOAK_DURATION_DAYS=1 SOAK_TARGET_PACKS=100` first
2. **Monitor balance**: The bot auto-requests airdrop, but public faucet has limits
3. **Use private RPC**: Public devnet RPC will rate-limit under load
4. **Check logs**: Metrics are logged every 60 seconds by default
5. **Graceful shutdown**: Press Ctrl+C to stop and see final metrics
