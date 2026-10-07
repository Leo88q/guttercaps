# G-3 Devnet Soak Bot

14-day continuous test bot for G-3 launch gate validation.

## Requirements (docs/06 §1.4 G-3)

| Metric | Target | Purpose |
|---|---|---|
| Packs purchased | ≥ 10,000 | Volume validation |
| Packs opened | ≥ 10,000 | Commit-reveal pipeline |
| Fusions completed | ≥ 500 | Fusion system stress |
| Risky fusions | ≥ 100 | Rare chip handling |
| Wager matches | ≥ 200 | PvP arena validation |
| Abandoned pending | 0 | No stuck operations |
| Stale pending | 0 | No timed-out operations |
| Crank p95 latency | ≤ 20 seconds | Background job performance |

## Quick Start

```bash
# Set required environment variables
PRIVATE_KEY=$(base64 -w0 ~/.config/solana/id.json) \
  DEVNET_RPC_URL=https://api.devnet.solana.com \
  npm run load:soak-g3
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `DEVNET_RPC_URL` | `https://api.devnet.solana.com` | Solana devnet RPC endpoint |
| `PRIVATE_KEY` | *(required)* | Base58-encoded private key (funded with SOL) |
| `SOAK_DURATION_DAYS` | `14` | Test duration in days |
| `SOAK_TARGET_PACKS` | `10000` | Target packs to purchase |
| `SOAK_CONCURRENCY` | `5` | Concurrent worker threads |
| `SOAK_INTERVAL_MS` | `1000` | Minimum ms between operations |
| `SOAK_LOG_INTERVAL_MS` | `60000` | Metrics logging interval (ms) |

## Prerequisites

1. **Funded devnet wallet** with sufficient SOL:
   - Pack purchase: ~0.01 SOL per pack (rent + fees)
   - Fusion operations: ~0.001 SOL per fusion
   - Wager matches: ~0.1 SOL per match
   - **Total estimate for 10,000 packs**: ~150-200 SOL

2. **RPC endpoint** with WebSocket support:
   - Public devnet may rate-limit
   - Recommended: Private RPC (QuickNode, Helius, Triton)

3. **Node 24+** (SEC-B50 compliance)

## Running the Soak Test

### Local Development

```bash
# Install dependencies
npm ci

# Run with custom configuration
SOAK_DURATION_DAYS=1 SOAK_TARGET_PACKS=100 \
  PRIVATE_KEY=$(cat my-key.json | jq -r '.secretKey' | base64 -w0) \
  DEVNET_RPC_URL=https://api.devnet.solana.com \
  npm run load:soak-g3
```

### Docker (Recommended for Production)

```bash
# Build image
docker build -t guttercaps-soak -f ops/deploy/Dockerfile.api .

# Run soak test
docker run --rm -it \
  -e PRIVATE_KEY=$(base64 -w0 ~/.config/solana/id.json) \
  -e DEVNET_RPC_URL=https://api.devnet.solana.com \
  -e SOAK_DURATION_DAYS=14 \
  -e SOAK_TARGET_PACKS=10000 \
  guttercaps-soak \
  node scripts/load/soak-g3.js
```

## Monitoring

The bot outputs metrics every 60 seconds (configurable via `SOAK_LOG_INTERVAL_MS`):

```
=== Soak Metrics ===
Elapsed: 120.5 minutes (1.67 days)
Packs: 3500/10000 (35.0%)
Opened: 3500
Fusions: 120 (risky: 24)
Wager Matches: 45
Errors: 2
Abandoned Pending: 0
Stale Pending: 0
Crank p95: 1500ms
==================
```

## Implementation Notes

### Current Status

This is a **skeleton implementation**. The actual soak bot requires:

1. **Real program interaction**: Current implementation uses placeholders. Need to:
   - Load program IDL from `target/idl/*.json`
   - Build proper instructions for each operation
   - Handle Switchboard VRF for pack opening
   - Handle Pyth price feeds for SOL/SKR/USDC

2. **Crank monitoring**: Need to connect to the crank worker's metrics endpoint
   - Current: Placeholder counter
   - Required: Query `/metrics` for `crank_job_duration_seconds` p95

3. **Pending state monitoring**: Need to query on-chain accounts
   - `PendingPack`, `PendingFusion`, `WagerBattle` accounts
   - Check `phase` field for abandoned/stale states

4. **Concurrency control**: Current simple approach may not scale to 10,000 packs
   - Consider: Rate limiting, retry logic, circuit breakers

### Files to Implement

| File | Status | Notes |
|---|---|---|
| `scripts/load/soak-g3.ts` | ✅ Skeleton | Base structure ready |
| `scripts/load/soak-g3.md` | ✅ Documentation | This file |
| Program IDL loading | ❌ TODO | From `target/idl/` |
| Crank metrics client | ❌ TODO | Query `/metrics` endpoint |
| On-chain state queries | ❌ TODO | Check pending accounts |

## G-3 Gate Validation

At the end of the soak period, the bot outputs:

```
=== G-3 Gate Status ===
✓ Packs (≥10000): PASS (10000)
✓ Fusions (≥500, ≥100 risky): PASS (520, 115 risky)
✓ Wager Matches (≥200): PASS (210)
✓ No Abandoned/Stale Pending: PASS (abandoned: 0, stale: 0)
✓ Crank p95 (≤20s): PASS (15000ms)

G-3 Gate: ✅ PASS
```

All criteria must PASS for G-3 to be considered complete.

## Integration with CI

The soak bot is designed to run as a long-running service, not as a CI job.
However, a short validation can be added to CI:

```yaml
# .github/workflows/soak-validation.yml
name: G-3 Soak Validation
on:
  workflow_dispatch:
jobs:
  validate:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - run: npm ci
      - run: npm run load:soak-g3 -- --validate-only
        env:
          DEVNET_RPC_URL: ${{ secrets.DEVNET_RPC_URL }}
          PRIVATE_KEY: ${{ secrets.SOAK_PRIVATE_KEY }}
```

## Troubleshooting

### "ERROR: PRIVATE_KEY environment variable is required"

The soak bot needs a funded wallet. Create one:

```bash
solana-keygen new --out-file ~/.config/solana/soak-key.json
solana airdrop 10 --url devnet --keypair ~/.config/solana/soak-key.json
```

Then export:

```bash
export PRIVATE_KEY=$(base64 -w0 ~/.config/solana/soak-key.json)
```

### RPC rate limiting

Use a private RPC endpoint:

```bash
export DEVNET_RPC_URL=https://your-private-rpc.devnet.solana.com
```

### Insufficient funds

Monitor balance:

```bash
solana balance --url devnet <WALLET_ADDRESS>
```

Request more airdrop or fund from faucet.

## References

- [G-3 Definition](docs/06-acceptance-security-testing.md#14-launch-gates)
- [Production Readiness](docs/09-production-readiness.md)
- [MAC-DEVNET Setup](docs/MAC-DEVNET.md)
