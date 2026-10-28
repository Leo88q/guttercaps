#!/usr/bin/env bash
# Phase-V activation run (docs/PHASEV-ACTIVATION.md) — assumes phase G is
# already live on the target cluster (setup-minimal done: tree, $CG, 8 Core
# collections) and the phase-G env file exists. Steps:
#   1. settle program keypair (reuse or generate) + program-ids apply
#   2. anchor build -p settle, deploy (~1 SOL program-data rent on mainnet)
#   3. MINT_ORACLE keypair (backend-only; generated locally, never committed)
#   4. phasev-activate --execute: init_config, tree delegate -> tree_auth PDA,
#      collection authorities -> tree_auth PDA
#   5. prints the env switch (LAUNCH_PHASE=v / VITE_LAUNCH_PHASE=v)
# Usage:  bash scripts/mac-phasev.sh
# Env:    SOLANA_RPC_URL (default devnet), ANCHOR_WALLET (mint authority),
#         PHASEG_ENV (default scripts/.phaseg-devnet.env),
#         ORACLE_FILE (default ~/.config/guttercaps/mint-oracle.json),
#         KEYS_DIR (default ~/.config/guttercaps/program-keys)
set -euo pipefail
cd "$(dirname "$0")/.."

RPC="${SOLANA_RPC_URL:-https://api.devnet.solana.com}"
WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
PHASEG_ENV="${PHASEG_ENV:-scripts/.phaseg-devnet.env}"
ORACLE_FILE="${ORACLE_FILE:-$HOME/.config/guttercaps/mint-oracle.json}"
KEYS_DIR="${KEYS_DIR:-$HOME/.config/guttercaps/program-keys}"
SETTLE_KP="$KEYS_DIR/settle-keypair.json"

command -v anchor >/dev/null || { echo "anchor CLI not found — install Anchor 0.31.1 first"; exit 1; }
command -v solana >/dev/null || { echo "solana CLI not found"; exit 1; }
[ -f "$WALLET" ] || { echo "wallet not found: $WALLET"; exit 1; }
[ -f "$PHASEG_ENV" ] || { echo "phase-G env file not found: $PHASEG_ENV (run scripts/mac-phaseg-devnet.sh first)"; exit 1; }

echo "== 1. settle keypair + program ids =="
mkdir -p "$KEYS_DIR" && chmod 700 "$KEYS_DIR"
if [ -f "$SETTLE_KP" ]; then
  echo "reusing $SETTLE_KP"
else
  npm run --silent program-ids -- new --out "$KEYS_DIR"
fi
npm run --silent program-ids -- apply --from "$KEYS_DIR"
echo "note: program-ids apply rewrote the id sites locally — for a devnet test do NOT commit that rewrite."

echo "== 2. build + deploy settle =="
anchor build -p settle
solana program deploy target/deploy/settle.so --program-id "$SETTLE_KP" -u "$RPC" -k "$WALLET" --use-rpc --max-sign-attempts 100

echo "== 3. MINT_ORACLE keypair =="
if [ -f "$ORACLE_FILE" ]; then
  echo "reusing $ORACLE_FILE"
else
  mkdir -p "$(dirname "$ORACLE_FILE")"
  ORACLE_FILE="$ORACLE_FILE" node -e "const fs=require('fs');const {Keypair}=require('@solana/web3.js');fs.writeFileSync(process.env.ORACLE_FILE, JSON.stringify(Array.from(Keypair.generate().secretKey)));console.log('oracle pubkey:', Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.ORACLE_FILE,'utf8')))).publicKey.toBase58())"
  chmod 600 "$ORACLE_FILE"
fi

echo "== 4. activate (init_config + delegate + collection authorities) =="
set -a; . "$PHASEG_ENV"; set +a
SOLANA_RPC_URL="$RPC" ANCHOR_WALLET="$WALLET" PHASEV_ORACLE_KEYPAIR="$ORACLE_FILE" \
  npm run --silent phasev:activate -- --execute

echo "== 5. switch the phase (edit your production env, then restart) =="
echo "backend: LAUNCH_PHASE=v"
echo "backend: PHASEV_ORACLE_KEYPAIR=$ORACLE_FILE   (or the JSON array; backend-only, never commit)"
echo "backend: PROGRAM_SETTLE=$(node -e "const {Keypair}=require('@solana/web3.js');const fs=require('fs');console.log(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync('$SETTLE_KP','utf8')))).publicKey.toBase58())")"
echo "client:  VITE_LAUNCH_PHASE=v and VITE_PROGRAM_SETTLE=<same id>"
echo "then buy a pack end-to-end and check the chips register (crank logs 'registered settled')."
