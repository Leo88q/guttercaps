# Pyth price posting — self-run pusher (owner decision Q7)

GUTTERCAPS prices everything in USD cents; SOL and SKR payments are converted
**inside the transaction** from a Pyth `PriceUpdateV2` account. `chip_core`
accepts an account only if it is owned by the Pyth receiver, carries the exact
SOL/USD or SKR/USD feed id, and its `publish_time` is **≤ 60 s** old
(`SOL_PRICE_MAX_AGE_SECS`). Which shard posted it does not matter.

The owner decided to **post the prices ourselves** rather than depend on the
Pyth-sponsored feeds. Why:

| | Pyth-sponsored shard 0 | Own pusher (this folder) |
|---|---|---|
| SOL/USD | 55 s heartbeat / 0.5 % deviation → routinely 50–60 s old ⇒ `StalePrice` at checkout | ≤ 45 s worst case, 30 s typical |
| SKR/USD | **not sponsored** (thin, non-blue-chip feed) — nobody pushes it | pushed every 30 s |
| Availability | outside our control; no SLA | our RPC, our alerts, 2 replicas |
| Cost | free | ≈ 2 SOL / month — base fees, not priority fees (`npm run pyth-pusher -- cost`) |

Everything about the policy lives in **`packages/economy/src/oracle.ts`** and is
pinned by `npm run economy:check`: feed ids, shard `0xCA75`, trigger thresholds,
worst-case age, alert age. This folder is the deployable that follows it.

## Accounts

Push-oracle PDA = `[shard u16 LE, feed_id]` under `pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT`
(same program ids on mainnet-beta and devnet):

| Feed | Shard 0 (Pyth-sponsored) | **Shard 0xCA75 (ours)** |
|---|---|---|
| SOL/USD `ef0d8b6f…b56d` | `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE` | `ELp9x5sFxGJ7zTurykU2p6A9nKDx72b3xzPxfsB5S8GB` |
| SKR/USD `38846ec4…3bf9` | `AFrJWhfWt3vDtGPdcwTyLyHz8ZQ4M9L2z1YHThY5Vbj5` | `9bCSdQVWckgKipe4G3G66aYU9yq2ZdDn8kRPZB9Nihbc` |

`npm run pyth-pusher -- accounts` prints the same table (any shard: `-- accounts 0x1234`).
The accounts are created by the **first push** (rent ≈ 0.0019 SOL each, paid by the pusher payer).

## Bring-up (once per cluster)

```bash
# 0. Pyth API key (mandatory for Hermes since the 2026-08-26 Core upgrade) — https://pythdata.app/signup
#    The image must be >= v10.5.0: that release added `--hermes-access-token`, the only way to hand the key to the
#    pusher. `.env.example` pins v13.0.0 (the old v9.3.0 has no such flag and would get 401 from Hermes).
# 1. payer keypair — dedicated hot wallet, SOL only, no authority over anything else
solana-keygen new -o ops/pyth-pusher/payer.json --no-bip39-passphrase
solana transfer <payer> 6 --allow-unfunded-recipient          # ≈ 3 months (≈ 2 SOL / month)

# 2. configure + start (two replicas on two RPCs = Pyth's reliability recommendation)
cd ops/pyth-pusher && cp .env.example .env && $EDITOR .env
docker compose --profile ha up -d
curl -s localhost:9091/metrics | grep -E 'pyth_price_last_published_time|pyth_wallet_balance'

# 3. verify from the outside (RPC only; exit 1 if any feed is older than 45 s)
npm run pyth-pusher -- check https://api.mainnet-beta.solana.com

# 4. point GameConfig at our accounts (admin / Squads): set_params { pyth_sol_usd_feed, pyth_skr_usd_feed }
npm run pyth-pusher -- set-params-args     # prints the two pubkeys + the ParamsPatch layout
```

The backend `npm run pyth-cache` worker reads the **same two accounts** every 10 s
into `oracle_prices` (USD display prices for `/services`, `/market/floor`,
`/packs/quote`), so the API can never quote a price the chain would reject.

## Devnet

Same image, same shard, `SOLANA_RPC_URL=https://api.devnet.solana.com`, a devnet
payer (on a MacBook all of this is automated: `bash scripts/mac-devnet.sh --only pyth`, then `run` keeps the pusher up
while the app is open — `docs/MAC-DEVNET.md`). Hermes serves the same feed ids for devnet (`hermes.pyth.network`, not
`hermes-beta`, because the Solana devnet receiver verifies mainnet Wormhole
guardians for Pyth stable feeds).

## Operating

* **Metrics:** `pyth_price_last_published_time{alias}`, `pyth_wallet_balance`,
  `pyth_price_update_attempts_total{status}` on `:9091` / `:9092`.
  Rules in `alerts.yml` — warning at 45 s age, **critical at 60 s** (buyers start
  failing), wallet < 0.5 SOL (≈ 1 week left).
* **Priority fee:** our accounts are uncontended, so 200 µlamports/CU lands during
  normal load. If `PythPriceAgeWarning` fires while the RPC is healthy, raise
  `CU_PRICE_MICRO_LAMPORTS` (1 000 ⇒ ≈ 1.2 SOL/month).
* **Cost:** `npm run pyth-pusher -- cost [cuPrice]` — one push with full verification
  ≈ 3 tx / 4 signatures / ≈ 600 k CU (post + verify the VAA, 2 × update_price_feed,
  close); ≈ 35 s cadence + ~15 % deviation pushes ⇒ **≈ 2 SOL / month**, almost all
  of it base fees. Bumping the priority fee to 1 000 µlamports adds < 0.1 SOL.
* **Key hygiene:** the payer can only spend its own SOL. Rotating it = new
  keypair, top-up, restart. The PDAs do not depend on the payer.

### Incident: price stale

Symptoms: `PythPriceStale`, checkout shows "quote unavailable", `StalePrice (6012)`
in failed SOL/SKR transactions.

1. `npm run pyth-pusher -- check` — which feed, how old, does Hermes answer
   (`curl -H "Authorization: Bearer $PYTH_API_KEY" "$HERMES_URL/v2/updates/price/latest?ids[]=0xef0d8b…"`).
2. `docker compose logs --tail 200 pusher-a` — typical causes: RPC 429 / blockhash
   expired (switch to `SOLANA_RPC_URL_B`), Hermes 401 (key), wallet empty.
3. Meanwhile the client **falls back automatically**: `/packs/quote` answers
   `503 price_unavailable`, the shop hides SOL/SKR and keeps USDC/$CG live
   (`quoteUnavailable` copy). Nothing on-chain needs to change.
4. If the pusher cannot be restored within ~30 min, temporarily switch
   `GameConfig.pyth_*_feed` to the sponsored SOL/USD account
   (`7UVimff…jLiE`) via `set_params` — SOL checkout keeps working (with a higher
   stale rate); SKR stays USDC/$CG-only until the pusher is back.

## Localnet / CI

The Anchor suite does not run a pusher: `tests/localnet/fixtures/pyth_*.json`
are `PriceUpdateV2` dumps whose `publish_time` the harness rewrites per test
(`[[test.validator.account]]` in `Anchor.toml`, backlog #14).
