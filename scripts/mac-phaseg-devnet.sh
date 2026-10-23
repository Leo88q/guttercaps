#!/usr/bin/env bash
# Phase-G devnet run (docs/MINIMAL-LAUNCH-CHECKLIST.md 1.4) — the minimal
# launch path, NOT the 4-program pipeline (that's mac-devnet.sh):
#   1. setup-minimal --execute on devnet: $CG mint, shared tree, 8 Core collections
#   2. backend (LAUNCH_PHASE=g) on a throwaway sqlite DB, crank enabled
#   3. phaseg-smoke: SIWS → order → pay → confirm → minted → Verify
# Usage:  bash scripts/mac-phaseg-devnet.sh [--only setup|backend|smoke]
# Env:    ANCHOR_WALLET (default ~/.config/solana/id.json),
#         METAPLEX_DAS_RPC_URL (optional; only fusion/burn need DAS on devnet)
set -euo pipefail
cd "$(dirname "$0")/.."

WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
RPC="https://api.devnet.solana.com"
ENV_FILE="scripts/.phaseg-devnet.env"
PORT="${PHASEG_PORT:-8799}"
ONLY="${1:-all}"
[ "${1:-}" = "--only" ] && ONLY="${2:-all}"

run_setup() {
  echo "== setup-minimal --execute (devnet) =="
  SOLANA_RPC_URL="$RPC" ANCHOR_WALLET="$WALLET" npm run setup:minimal -- --execute | tee /tmp/phaseg-setup.out
  {
    echo "LAUNCH_PHASE=g"
    grep -E '^(CG_MINT|SHARED_MERKLE_TREE|SHARED_TREE_CONFIG|CORE_COLLECTION_[0-7])=' /tmp/phaseg-setup.out
    echo "TREASURY_WALLET=$(ANCHOR_WALLET="$WALLET" node -e "const fs=require('fs');const {Keypair}=require('@solana/web3.js');console.log(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.ANCHOR_WALLET,'utf8')))).publicKey.toBase58())")"
    echo "MINT_AUTHORITY_KEYPAIR=$WALLET"
    echo "SOLANA_RPC_URL=$RPC"
    echo "METAPLEX_DAS_RPC_URL=${METAPLEX_DAS_RPC_URL:-https://api.devnet.solana.com}"
    echo "SESSION_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    echo "DB_PATH=${TMPDIR:-/tmp}/guttercaps-phaseg-devnet.db"
    echo "PORT=$PORT"
  } > "$ENV_FILE"
  echo "env written: $ENV_FILE"
}

BACKEND_PID=""
run_backend() {
  echo "== backend (LAUNCH_PHASE=g) on :$PORT =="
  rm -f "${TMPDIR:-/tmp}/guttercaps-phaseg-devnet.db"
  ( set -a; . "$ENV_FILE"; set +a; cd backend && npm run start ) > /tmp/phaseg-backend.log 2>&1 &
  BACKEND_PID=$!
  for i in $(seq 1 60); do
    curl -sf "http://127.0.0.1:$PORT/v1/health" > /dev/null && return 0
    sleep 1
  done
  echo "backend did not come up — /tmp/phaseg-backend.log:"; tail -20 /tmp/phaseg-backend.log; exit 1
}

run_smoke() {
  echo "== phase-G smoke (order → pay → mint → verify) =="
  API_BASE="http://127.0.0.1:$PORT/v1" ANCHOR_WALLET="$WALLET" SOLANA_RPC_URL="$RPC" \
    node --experimental-strip-types scripts/phaseg-smoke.ts
}

case "$ONLY" in
  setup) run_setup ;;
  backend) run_backend; echo "backend running (pid $BACKEND_PID); stop with: kill $BACKEND_PID" ;;
  smoke) run_smoke ;;
  all)
    [ -f "$ENV_FILE" ] || run_setup
    run_backend
    trap 'kill $BACKEND_PID 2>/dev/null || true' EXIT
    run_smoke
    echo "== done. Paste the asset id + explorer link into checklist 1.4. =="
    ;;
  *) echo "usage: bash scripts/mac-phaseg-devnet.sh [--only setup|backend|smoke]"; exit 1 ;;
esac
