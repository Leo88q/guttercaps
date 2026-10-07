# G-3 Devnet Soak Bot

**14-day continuous test bot for G-3 launch gate validation**

> **Status**: Functional implementation (requires devnet RPC access)
> **Node Requirement**: 24+ (SEC-B50)
> **Last Updated**: 2026-10-07

---

## 🎯 G-3 Requirements (docs/06 §1.4)

| Metric | Target | Current Implementation |
|---|---|---|
| **Packs purchased** | ≥ 10,000 | ✅ Concurrent workers with weighted distribution |
| **Packs opened** | ≥ 10,000 | ⚠️  Opened **by the crank**, not by the bot — the bot only sends `buy_pack` and counts opens locally |
| **Fusions completed** | ≥ 500 | ✅ 20% probability per operation |
| **Risky fusions** | ≥ 100 | ✅ 20% of fusions marked as risky |
| **Wager matches** | ≥ 200 | ✅ 15% probability per operation |
| **Abandoned pending** | 0 | ⚠️  Placeholder (needs on-chain query) |
| **Stale pending** | 0 | ⚠️  Placeholder (needs on-chain query) |
| **Crank p95** | ≤ 20,000ms | ⚠️  Simulated (needs /metrics endpoint) |

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

  Pending: 0 abandoned, 0 stale
  Crank: p95=1500ms, p99=2500ms, 1250 jobs
============================================================
```

---

## ⚠️ Metrics Honesty — Read Before Trusting a PASS

Three of the seven G-3 gate checks are **placeholders** and are labelled
`SIMULATED` in the bot's output:

| Metric | Status | What it would take to make it real |
|---|---|---|
| Abandoned pending = 0 | ⚠️ Simulated in the bot — **measured for real by [soak-validate.ts](soak-validate.ts)** | `npm run load:soak-g3:validate` queries `PendingPack` / `PendingFusion` / `WagerBattle` on-chain and counts stale/abandoned (exit 0 = KPI met) |
| Stale pending = 0 | ⚠️ Simulated in the bot — **measured for real by [soak-validate.ts](soak-validate.ts)** | same script, staleness window = `STALE_PACK_SLOTS` (10 800 slots ≈ 72 min) |
| Crank p95 ≤ 20s | ⚠️ Simulated — random 1.5–6.5s | Scrape the crank's Prometheus `/metrics` (job-duration histogram), or time each pending item from creation to on-chain resolution |

Until the crank p95 is wired to a real source, `G-3 Gate: PASS` only proves the four
transaction-count KPIs (packs, fusions, risky fusions, wager matches) — validate
"0 abandoned/stale pending" with `soak-validate.ts` and "crank p95" with the crank's
own metrics. Related caveat: the bot sends `buy_pack` but never `open_pack` — opening
is the crank's job, which is exactly what the "0 abandoned pending" KPI exists to observe.

---

## 🏁 Final Validation

At the end of the soak period, the bot outputs G-3 gate validation:

```
============================================================
  G-3 GATE VALIDATION
============================================================
  ✅ PASS Packs (≥10,000): 10000
  ✅ PASS Fusions (≥500): 520
  ✅ PASS Risky Fusions (≥100): 115
  ✅ PASS Wager Matches (≥200): 210
  ✅ PASS No Abandoned Pending: 0
  ✅ PASS No Stale Pending: 0
  ✅ PASS Crank p95 (≤20s): 15000ms

  G-3 Gate: ✅ PASS
============================================================
```

**Exit Code**: 0 = PASS, 1 = FAIL

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

Background monitors run every 30 seconds:
- **Pending state check**: Scans for abandoned/stale operations
- **Crank metrics**: Collects p95/p99 latency and job count

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

### ⚠️ Placeholder (Needs Real Implementation)
- [ ] **Pending state monitoring** via on-chain account queries — currently simulated, see "Metrics Honesty"
- [ ] **Crank metrics** via the crank's `/metrics` endpoint — currently simulated
- [ ] **`open_pack` from the bot** — packs are opened by the crank; the bot counts a pack as opened when its chip PDAs appear on-chain
- [ ] **`accept_battle`** — battles are created but never accepted or resolved by the bot
- [ ] **$CG funding** — fuse fees and battle wagers need $CG; on devnet the deploy wallet (mint authority per `scripts/setup.ts`) must mint $CG to the soak wallet — see [docs/G3-DEVNET-BETA-LAUNCH.md](../../docs/G3-DEVNET-BETA-LAUNCH.md)

### 📝 Required for a Trustworthy Gate

Implement the on-chain pending-state query and the crank `/metrics` scrape
described in "Metrics Honesty", then remove the `SIMULATED` labels from the
gate in `scripts/load/soak-g3.ts`. Until then, treat the pending/crank rows of
a PASS report as unmeasured.

---

## 🔌 Integration with CI

### GitHub Actions

The real workflow is
[`.github/workflows/g3-soak.yml`](../../.github/workflows/g3-soak.yml). It runs
on the **self-hosted runner** (`runs-on: [self-hosted, g3-soak]` — a 14-day soak
cannot fit in a GitHub-hosted job), takes the wallet from the `SOAK_PRIVATE_KEY`
repository secret, and never creates or airdrops a wallet:

```bash
# 1-hour smoke test (100 packs, 2 workers)
gh workflow run g3-soak.yml -f duration_hours=1 -f target_packs=100 -f concurrency=2

# Production G-3 soak (14 days, 10,000 packs, 10 workers)
gh workflow run g3-soak.yml -f duration_hours=336 -f target_packs=10000 -f concurrency=10
```

A short nightly smoke (1 hour, ephemeral wallet, GitHub-hosted runner) lives in
[`.github/workflows/g3-soak-nightly.yml`](../../.github/workflows/g3-soak-nightly.yml).
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
