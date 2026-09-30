#!/usr/bin/env bash
# selftest-mac-devnet.sh — fixtures for the parts of scripts/mac-devnet.sh that can hurt if they are wrong and that
# nothing else exercises: the GitHub update (it must never lose the user's work, and it must drop only what is
# regenerable), the devnet guard (a mainnet RPC must stop the deploy before a single transaction) and the Pyth price
# pusher (the API key must never leak into a log, a mainnet RPC must never reach the container, Ctrl+C-free exits must
# not leave it running, and every way of not having SOL/SKR prices must be said out loud). Runs with no Solana/Rust
# toolchain, no Docker and no network — a bare repo on disk plays GitHub, small fakes play solana / docker / Hermes —
# so it belongs in `npm run verify` (`selftest:macdevnet`); the real toolchain stages are only observable on a Mac.
#
# Asserted: what the script says and what the tree looks like afterwards, not just exit codes. A refusal that
# exits 1 for the wrong reason would keep an exit-code test green while sending the user to the wrong fix.
set -u

self=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo=$(CDPATH='' cd -- "$self/.." && pwd) || exit 1
script="$repo/scripts/mac-devnet.sh"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/selftest-mac-devnet.XXXXXX") || exit 1
trap 'rm -rf "$tmp"' EXIT
fails=0; oks=0
g() { git -c user.name=selftest -c user.email=selftest@example.invalid "$@"; }

pass() { oks=$((oks + 1)); printf 'ok   [%s] %s\n' "$1" "$2"; }
fail() { fails=$((fails + 1)); printf 'FAIL [%s] %s\n' "$1" "$2" >&2; }
expect() { # <scenario> <needle> <log>
  if grep -qF -- "$2" "$3"; then pass "$1" "$2"; else fail "$1" "в выводе нет: $2"; sed 's/^/    /' "$3" >&2; fi
}
expect_not() {
  if grep -qF -- "$2" "$3"; then fail "$1" "в выводе не должно быть: $2"; sed 's/^/    /' "$3" >&2; else pass "$1" "нет: $2"; fi
}
check() { # <scenario> <description> <command...>
  local s=$1 d=$2; shift 2
  if "$@"; then pass "$s" "$d"; else fail "$s" "$d"; fi
}

bash -n "$script" || { echo "FAIL: синтаксис $script" >&2; exit 1; }

# ---------------------------------------------------------------- a fake GitHub and a fake checkout
OLD_ID=GCRhrg6mc7zH1VdXG5rX3tQEpgu8Gptf27vdsJGV7G8q
NEW_ID=Fr3shKeyFr3shKeyFr3shKeyFr3shKeyFr3sh1234567
seed="$tmp/seed"; origin="$tmp/origin.git"; work="$tmp/work"
mkdir -p "$seed/scripts" "$tmp/home"
git init -q "$seed" && git -C "$seed" symbolic-ref HEAD refs/heads/main
{
  printf '[toolchain]\nanchor_version = "0.31.1"\nsolana_version = "2.1.0"\n\n[programs.devnet]\nchip_core = "%s"\n' "$OLD_ID"
} > "$seed/Anchor.toml"
printf '[toolchain]\nchannel = "1.89.0"\n' > "$seed/rust-toolchain.toml"
printf '22\n' > "$seed/.nvmrc"
printf '{"lockfileVersion":3}\n' > "$seed/package-lock.json"
printf 'readme\n' > "$seed/README.md"
cp "$script" "$seed/scripts/mac-devnet.sh"
mkdir -p "$seed/ops/pyth-pusher"
cp "$repo/ops/pyth-pusher/.env.example" "$repo/ops/pyth-pusher/price-config.yaml" "$seed/ops/pyth-pusher/"
g -C "$seed" add -A && g -C "$seed" commit -q -m "base"
git clone -q --bare "$seed" "$origin"
git clone -q "$origin" "$work"

# a new commit on GitHub: the updater has something to fast-forward to
push_remote_commit() {
  [ -d "$tmp/dev" ] || git clone -q "$origin" "$tmp/dev"
  printf '%s\n' "$1" >> "$tmp/dev/CHANGELOG.md"
  g -C "$tmp/dev" add -A && g -C "$tmp/dev" commit -q -m "remote: $1" && g -C "$tmp/dev" push -q origin main
}

update() { # run the stage in the fake checkout; output -> $log
  log="$tmp/out.log"
  ( cd "$work" && HOME="$tmp/home" REPO_DIR="$work" BRANCH=main bash scripts/mac-devnet.sh --only update,doctor ) > "$log" 2>&1
  rc=$?
}

# ---------------------------------------------------------------- 1. fast-forward + regenerable edits are dropped, real ones stashed
push_remote_commit one
printf '\n' >> "$work/package-lock.json"                                 # what a bare `npm install` does
sed -i.bak "s/$OLD_ID/$NEW_ID/" "$work/Anchor.toml" && rm -f "$work/Anchor.toml.bak"   # locally applied program id
printf 'my notes\n' >> "$work/README.md"                                   # a real edit of the user's
printf 'scratch\n' > "$work/untracked.txt"
update
check update-ff "exit 0" test "$rc" -eq 0
check update-ff "HEAD == origin/main" test "$(git -C "$work" rev-parse HEAD)" = "$(git -C "$work" rev-parse origin/main)"
expect update-ff "сброшен package-lock.json" "$log"
expect update-ff "сброшен Anchor.toml" "$log"
check update-ff "Anchor.toml is back to the committed id" grep -q "$OLD_ID" "$work/Anchor.toml"
check update-ff "the user's README edit went to a stash, not into the void" test "$(git -C "$work" stash list | wc -l | tr -d ' ')" = 1
check update-ff "…and README.md in the tree is clean" test "$(git -C "$work" diff --name-only | wc -l | tr -d ' ')" = 0
check update-ff "an untracked file is left alone" test -f "$work/untracked.txt"
expect update-ff "продолжаю свежей копией скрипта" "$log"
expect update-ff "этап doctor" "$log"            # the re-exec'd copy ran the next stage

# ---------------------------------------------------------------- 2. an id-site edit that is NOT only ids must not be discarded
printf '# my own comment\n' >> "$work/Anchor.toml"
update
check update-real-edit "exit 0" test "$rc" -eq 0
expect update-real-edit "убираю их в stash" "$log"
check update-real-edit "two stashes now (nothing was dropped)" test "$(git -C "$work" stash list | wc -l | tr -d ' ')" = 2

# ---------------------------------------------------------------- 3. local commits that GitHub does not have
g -C "$work" config user.name selftest; g -C "$work" config user.email selftest@example.invalid
printf 'mine\n' > "$work/local.txt"; g -C "$work" add local.txt && g -C "$work" commit -q -m "local only"
update
expect update-ahead "впереди GitHub" "$log"
check update-ahead "the local commit is still HEAD" test "$(git -C "$work" log -1 --format=%s)" = "local only"

# ---------------------------------------------------------------- 4. diverged: the old tip survives in a backup branch
push_remote_commit two
update
expect update-diverged "разошлась с GitHub" "$log"
check update-diverged "a backup branch holds the local commit" test "$(git -C "$work" branch --list 'backup/before-update-*' | wc -l | tr -d ' ')" = 1
check update-diverged "main now equals origin/main" test "$(git -C "$work" rev-parse HEAD)" = "$(git -C "$work" rev-parse origin/main)"
check update-diverged "the backup still has the commit" test "$(git -C "$work" log -1 --format=%s "$(git -C "$work" branch --list 'backup/before-update-*' | tr -d ' *')")" = "local only"

# ---------------------------------------------------------------- 4b. a single-branch clone that has never seen the branch
# (what `git clone --depth 1` / `--single-branch` leaves: the fetch refspec covers one branch, and `checkout --track`
# on anything else fails with "starting point is not a branch" — found against the real GitHub, not by a fake one)
g -C "$tmp/dev" checkout -q -b feature-x && printf 'x\n' > "$tmp/dev/feature.txt" && g -C "$tmp/dev" add -A \
  && g -C "$tmp/dev" commit -q -m "feature tip" && g -C "$tmp/dev" push -q origin feature-x
git clone -q --single-branch --branch main "$origin" "$tmp/single"
log="$tmp/single.log"
( cd "$tmp/single" && HOME="$tmp/home" REPO_DIR="$tmp/single" BRANCH=feature-x bash scripts/mac-devnet.sh --only update,doctor ) > "$log" 2>&1; rc=$?
check update-single-branch "exit 0" test "$rc" -eq 0
check update-single-branch "switched to the new branch at the fetched tip" test "$(git -C "$tmp/single" rev-parse --abbrev-ref HEAD)" = feature-x
check update-single-branch "…whose HEAD is the GitHub tip" test "$(git -C "$tmp/single" rev-parse HEAD)" = "$(git -C "$tmp/single" rev-parse refs/remotes/origin/feature-x)"
check update-single-branch "upstream is recorded" test "$(git -C "$tmp/single" config branch.feature-x.merge)" = refs/heads/feature-x
expect update-single-branch "этап doctor" "$log"

# ---------------------------------------------------------------- 5. argument validation
log="$tmp/args.log"
( cd "$work" && HOME="$tmp/home" REPO_DIR="$work" bash scripts/mac-devnet.sh --only nonsense ) > "$log" 2>&1; rc=$?
check args "unknown stage -> non-zero" test "$rc" -ne 0
expect args "неизвестный этап 'nonsense'" "$log"

# `sh scripts/mac-devnet.sh` (dash here, bash-in-posix-mode on a Mac) must hand over to bash instead of dying on the first array
log="$tmp/sh.log"
( cd "$work" && HOME="$tmp/home" REPO_DIR="$work" sh scripts/mac-devnet.sh --help ) > "$log" 2>&1; rc=$?
check args "run through sh -> exit 0" test "$rc" -eq 0
expect args "Stages (the order is load-bearing" "$log"

# ---------------------------------------------------------------- 6. the devnet guard: a mainnet RPC stops the deploy before any transaction
bin="$tmp/bin"; mkdir -p "$bin" "$work/target/deploy"
printf 'fake elf\n' > "$work/target/deploy/chip_core.so"
printf '[1,2,3]\n' > "$tmp/wallet.json"
cat > "$bin/solana-keygen" <<'EOF'
#!/bin/sh
[ "$1" = pubkey ] && { echo 4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi; exit 0; }
exit 2
EOF
cat > "$bin/solana" <<'EOF'
#!/bin/sh
echo "solana $*" >> "$FAKE_CALLS"
case "$1" in
  genesis-hash) echo "${FAKE_GENESIS:-EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG}" ;;
  --version) echo "solana-cli 2.1.0 (src:fake)" ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$bin/solana" "$bin/solana-keygen"
deploy() { # <extra env assignments...>; output -> $log
  log="$tmp/deploy.log"; : > "$tmp/calls.log"
  ( cd "$work" && env PATH="$bin:$PATH" HOME="$tmp/home" REPO_DIR="$work" WALLET="$tmp/wallet.json" FAKE_CALLS="$tmp/calls.log" "$@" \
      bash scripts/mac-devnet.sh --no-update --yes --only deploy ) > "$log" 2>&1
  rc=$?
}
deploy DEVNET_RPC_URL=https://api.mainnet-beta.solana.com
check guard-url "refused (non-zero)" test "$rc" -ne 0
expect guard-url "похож на mainnet" "$log"
expect_not guard-url "program deploy" "$tmp/calls.log"
deploy FAKE_GENESIS=5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d
check guard-genesis "refused (non-zero)" test "$rc" -ne 0
expect guard-genesis "НЕ devnet" "$log"
expect_not guard-genesis "program deploy" "$tmp/calls.log"
deploy FAKE_GENESIS=EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG
expect guard-ok "— devnet" "$log"                          # the real devnet hash passes the guard…
expect guard-ok "нет ключа программы" "$log"               # …and stops at the next precondition (no program keypairs here)
expect_not guard-ok "program deploy" "$tmp/calls.log"

# ---------------------------------------------------------------- 6b. the deploy budget: rent from the cluster, deposit != peak
# A wrong budget is the one failure mode the rest of the script cannot catch: it either stops a deploy that
# would have fit, or lets one start and run out of SOL half-way through a 1.5 MB buffer upload. These fixtures
# pin the three things that used to be wrong — a hard-coded rent rate, a 2x ProgramData allocation nobody
# accounted for, and a single "need" number that mixed permanent money with money that comes back.
bud="$tmp/budget"; mkdir -p "$bud/bin" "$work/target/deploy" "$work/keys" "$work/buffers"
# Four .so files at the sizes the user measured (chip_core 1459024, market 604272, staking 937320,
# arena 567632) — real numbers, not round ones, because the budget is a sum over them.
head -c 1459024 /dev/zero > "$work/target/deploy/chip_core.so"
head -c 604272  /dev/zero > "$work/target/deploy/market.so"
head -c 937320  /dev/zero > "$work/target/deploy/staking.so"
head -c 567632  /dev/zero > "$work/target/deploy/arena.so"
for prog in chip_core market staking arena; do cp "$tmp/wallet.json" "$work/keys/$prog-keypair.json"; done
# declared_id() reads programs/<p>/src/lib.rs, so the fake checkout needs them to name the same four ids.
mkdir -p "$work/programs/chip_core/src" "$work/programs/market/src" "$work/programs/staking/src" "$work/programs/arena/src"
printf 'declare_id!("GCRhrg6mc7zH1VdXG5rX3tQEpgu8Gptf27vdsJGV7G8q");\n' > "$work/programs/chip_core/src/lib.rs"
printf 'declare_id!("GCA2aUeX7ZFbGz3zvjqvsbjD1G3QjWxLhBpK5jwwPdcz");\n' > "$work/programs/market/src/lib.rs"
printf 'declare_id!("GCuGx7fnLcKnw1NWU4dLzQvnJWggMVniQ4u7EuMaQevA");\n' > "$work/programs/staking/src/lib.rs"
printf 'declare_id!("GCfERiohebYDJLtNwAZpGxudwbXRqnxmuTT413fkTYrM");\n' > "$work/programs/arena/src/lib.rs"
cat > "$bud/bin/solana-keygen" <<'EOF'
#!/bin/sh
if [ "$1" = pubkey ]; then
  # `*buffers/*` first: a buffer keypair lives at .../buffers/chip_core-<hash>.json, which also contains the
  # program's name — the more specific pattern has to win, exactly as it must for the real keygen.
  case "$2" in
    *buffers/*)  echo BufFerAddr111111111111111111111111111111111 ;;
    *chip_core*) echo GCRhrg6mc7zH1VdXG5rX3tQEpgu8Gptf27vdsJGV7G8q ;;
    *market*)    echo GCA2aUeX7ZFbGz3zvjqvsbjD1G3QjWxLhBpK5jwwPdcz ;;
    *staking*)   echo GCuGx7fnLcKnw1NWU4dLzQvnJWggMVniQ4u7EuMaQevA ;;
    *arena*)     echo GCfERiohebYDJLtNwAZpGxudwbXRqnxmuTT413fkTYrM ;;
    *)           echo 4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi ;;
  esac
  exit 0
fi
if [ "$1" = new ]; then
  out=""; while [ $# -gt 0 ]; do [ "$1" = --outfile ] && out=$2; shift; done
  printf '[1,2,3]\n' > "$out"; exit 0
fi
exit 2
EOF
# `solana rent` answers with the cluster's own parameters — 128 B of account overhead, 2540
# lamports/byte-year x the 2-year exemption threshold = 5080 lamports per byte (the rate the user measured).
# The script must ask, not assume: nothing here knows a "6960".
cat > "$bud/bin/solana" <<'FAKE'
#!/bin/sh
echo "solana $*" >> "$FAKE_CALLS"
case "$1" in
  rent)
    bytes=$(printf '%s' "$2" | tr -dc '0-9')
    awk -v b="$bytes" 'BEGIN { printf "Rent-exempt minimum: %.8f SOL\n", (b + 128) * 5080 / 1000000000 }'
    exit 0 ;;
  program)
    sub=$2; shift 2
    id=$(printf '%s' "$*" | tr ' ' '\n' | grep -E '^[1-9A-HJ-NP-Za-km-z]{32,44}$' | head -1)
    if [ "$sub" = show ] && [ "${1:-}" = "--buffers" ]; then
      [ -n "$FAKE_BUFFERS" ] && printf '%s\n' "$FAKE_BUFFERS"
      exit 0
    fi
    if [ "$sub" = deploy ]; then
      printf '        --max-len <max_len>\n            Maximum length of the upgradeable program [default: twice the length of the original deployed program]\n'
      exit 0
    fi
    if [ "$sub" = show ] && [ "${FAKE_RPC_DOWN:-0}" = 1 ]; then
      echo "Error: RPC request error: error trying to connect: Connection refused" >&2
      exit 1
    fi
    if [ "$sub" = show ]; then
      case ",$FAKE_DEPLOYED," in
        *",$id,"*)
          printf 'Program Id: %s\nOwner: BPFLoaderUpgradeab1e11111111111111111111111\nProgramData Address: 11111111111111111111111111111111\nAuthority: %s\nLast Deployed In Slot: 1\nData Length: %s (0x1) bytes\nBalance: 1 SOL\n' "$id" "$FAKE_AUTH" "$FAKE_CAP"
          exit 0 ;;
      esac
      echo "Error: RPC request error: Unable to find program $id" >&2
      exit 1
    fi
    exit 0 ;;
  --version) echo "solana-cli 2.1.0 (src:fake)" ;;
  genesis-hash) echo "${FAKE_GENESIS:-EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG}" ;;
esac
exit 0
FAKE
chmod +x "$bud/bin/solana" "$bud/bin/solana-keygen"
has()   { grep -qF -- "$1" "$2"; }   # `check … bash -c 'grep "$log"'` cannot see the outer variable
lacks() { ! grep -qF -- "$1" "$2"; }
budget() { # <env assignments...>; output -> $log, exit code -> $rc
  log="$tmp/budget.log"; : > "$tmp/calls.log"
  ( cd "$work" && env PATH="$bud/bin:$PATH" HOME="$tmp/home" REPO_DIR="$work" WALLET="$tmp/wallet.json" \
      FAKE_CALLS="$tmp/calls.log" PROGRAM_KEYS_DIR="$work/keys" KEYS_DIR="$tmp/home/.config/solana/guttercaps" "$@" \
      bash scripts/mac-devnet.sh --no-update --yes --only deploy ) < /dev/null > "$log" 2>&1
  rc=$?
}

budget FAKE_X=1
# The wallet has 0 SOL in this fixture, so the stage correctly stops at ensure_funds — after printing the plan.
check budget-absent "exit 0 is impossible without funds" test "$rc" -ne 0
expect budget-absent "бюджет деплоя (rent-ставка кластера: ~5080 лампортов" "$log"
expect budget-absent "арендный залог (постоянный: Program + ProgramData)" "$log"
expect budget-absent "временный пик (самый большой буфер, возвращается)" "$log"
expect budget-absent "сетевые комиссии (оценка по байтам загрузки)" "$log"
expect budget-absent "резерв на setup / lookup table / crank / pusher" "$log"
expect budget-absent "ИТОГО нужно на кошельке" "$log"
# The whole point of --max-len: ProgramData is 45+len, not 45+2*len (2918093 is what the old default bought).
expect budget-absent "ProgramData 1459069 байт (--max-len 1459024)" "$log"
expect budget-absent "буфер загрузки 1459061 байт (временный, вернётся после деплоя)" "$log"
check budget-absent "no 2x ProgramData anywhere in the plan" lacks 2918093 "$log"
expect budget-absent "арендный залог (постоянный: Program + ProgramData) : 18.13 SOL" "$log"
expect budget-absent "временный пик (самый большой буфер, возвращается)  : 7.41 SOL" "$log"
expect budget-absent "сетевые комиссии (оценка по байтам загрузки)       : 0.04 SOL" "$log"
expect budget-absent "резерв на setup / lookup table / crank / pusher    : 3.00 SOL" "$log"
expect budget-absent "ИТОГО нужно на кошельке 4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi: 28.59 SOL" "$log"
expect_not budget-absent "program deploy" "$tmp/calls.log"   # nothing is uploaded before the funds exist

# Already on chain with a smaller Data Length: only the difference is budgeted, and it is an extend, not a
# re-deposit of the whole account. 13.05 = 2.33 (the chip_core difference) + 10.72 (the three new programs).
budget FAKE_X=1 FAKE_DEPLOYED=GCRhrg6mc7zH1VdXG5rX3tQEpgu8Gptf27vdsJGV7G8q FAKE_AUTH=4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi FAKE_CAP=1000000
expect budget-extend "ProgramData расширяется 1000000 -> 1459024 байт — доплата 2.33 SOL" "$log"
expect budget-extend "арендный залог (постоянный: Program + ProgramData) : 13.05 SOL" "$log"
check budget-extend "the peak buffer is unchanged" has "временный пик (самый большой буфер, возвращается)  : 7.41 SOL" "$log"
# Already on chain and already big enough: no deposit at all, only the upload buffer and the fees.
budget FAKE_X=1 FAKE_DEPLOYED=GCRhrg6mc7zH1VdXG5rX3tQEpgu8Gptf27vdsJGV7G8q FAKE_AUTH=4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi FAKE_CAP=2000000
expect budget-cap "уже на цепи (Data Length 2000000 байт >= 1459024) — постоянный залог не растёт" "$log"
check budget-cap "chip_core adds nothing to the deposit" has "арендный залог (постоянный: Program + ProgramData) : 10.72 SOL" "$log"

# A foreign upgrade authority is still a hard stop, before anything is deployed.
budget FAKE_X=1 FAKE_DEPLOYED=GCRhrg6mc7zH1VdXG5rX3tQEpgu8Gptf27vdsJGV7G8q FAKE_AUTH=SomeoneElse1111111111111111111111111111111 FAKE_CAP=1000000
check budget-authority "refused (non-zero)" test "$rc" -ne 0
expect budget-authority "уже задеплоен с другим upgrade authority" "$log"
expect_not budget-authority "program deploy" "$tmp/calls.log"

# An RPC that will not answer is NOT an absent program: the stage stops instead of guessing a number.
budget FAKE_X=1 FAKE_RPC_DOWN=1
check budget-rpc "refused (non-zero)" test "$rc" -ne 0
expect budget-rpc "RPC https://api.devnet.solana.com не ответил про программу" "$log"
expect budget-rpc "бюджет не посчитан" "$log"
expect_not budget-rpc "program deploy" "$tmp/calls.log"

# A reusable upload buffer is money already on chain: only the difference is budgeted, and the peak drops.
# The keypair is what a previous, interrupted run left behind — its name is derived from the .so hash, which is
# why the budget phase looks for it instead of creating a second buffer and paying for it twice.
KEYS="$tmp/home/.config/solana/guttercaps/buffers"; mkdir -p "$KEYS"
# macOS ships shasum, Linux sha256sum — and an empty `$(command-that-does-not-exist)` still yields a valid
# filename, so the presence of the tool is tested, not the exit code of cp.
if have shasum; then sha12() { shasum -a 256 "$1" | cut -c1-12; }; else sha12() { sha256sum "$1" | cut -c1-12; }; fi
for prog in chip_core market staking arena; do
  cp "$tmp/wallet.json" "$KEYS/$prog-$(sha12 "$work/target/deploy/$prog.so").json"
done
budget FAKE_X=1 FAKE_BUFFERS="BufFerAddr111111111111111111111111111111111  4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi  0.05 SOL  1000000  123"
expect budget-buffer "буфер загрузки уже есть (1000000 байт) — добираю 2.33 SOL" "$log"
expect budget-buffer "временный пик (самый большой буфер, возвращается)  : 2.33 SOL" "$log"

# ---------------------------------------------------------------- 7. Pyth price pusher (SOL / SKR payments) and the faucet
bin2="$tmp/bin2"; mkdir -p "$bin2"
cat > "$bin2/solana-keygen" <<'EOF'
#!/bin/sh
case "$1" in
  pubkey) echo 4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi ;;
  new) out=""; while [ $# -gt 0 ]; do [ "$1" = --outfile ] && out=$2; shift; done; printf '[1,2,3]\n' > "$out" ;;
  *) exit 2 ;;
esac
EOF
cat > "$bin2/solana" <<'EOF'
#!/bin/sh
echo "solana $*" >> "$FAKE_CALLS"
case "$1" in
  genesis-hash) echo "${FAKE_GENESIS:-EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG}" ;;
  --version) echo "solana-cli 2.1.0 (src:fake)" ;;
  balance) echo "${FAKE_BALANCE:-9000000000} lamports" ;;
  transfer|airdrop) echo "Signature: fake" ;;
  *) exit 2 ;;
esac
EOF
# a fake Hermes: the key decides the answer, the header comes from a file (`-H @file`), the body goes to `-o`
cat > "$bin2/curl" <<'EOF'
#!/bin/sh
out=/dev/null; hdr=""
while [ $# -gt 0 ]; do
  case "$1" in -o) out=$2; shift ;; -H) hdr=${2#@}; shift ;; -w|-m) shift ;; esac
  shift
done
key=$(sed -n 's/^Authorization: Bearer //p' "$hdr" 2>/dev/null)
echo "hermes key=$(printf '%s' "$key" | cut -c1-4)…" >> "$FAKE_CALLS"
case "$key" in
  bad*) printf '{"error":"unauthorized"}' > "$out"; printf 401 ;;
  *) printf '{"parsed":[{"id": "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d"},{"id": "38846ec4d0dbe808091817f5c0d6ab8058e25422348ddf97db52b6c378a93bf9"}]}' > "$out"; printf 200 ;;
esac
EOF
cat > "$bin2/docker" <<'EOF'
#!/bin/sh
echo "docker $*" >> "$FAKE_CALLS"
case "$1" in
  info) [ "${FAKE_DOCKER_DOWN:-0}" = 1 ] && exit 1; echo ok ;;
  run) echo "$*" > "$FAKE_CALLS.run"; if [ "${FAKE_CONTAINER_DIES:-0}" = 1 ]; then rm -f "$FAKE_CALLS.up"; else : > "$FAKE_CALLS.up"; fi; echo 0123456789abcdef ;;
  ps) [ -f "$FAKE_CALLS.up" ] && echo 0123456789ab; exit 0 ;;
  logs) k=$(sed -n 's/.*--hermes-access-token \([^ ]*\).*/\1/p' "$FAKE_CALLS.run" 2>/dev/null); echo "{\"msg\":\"Hermes said 401 for token $k\"}" ;;
  rm) rm -f "$FAKE_CALLS.up" ;;
esac
EOF
cat > "$bin2/npm" <<'EOF'
#!/bin/sh
echo "npm $*" >> "$FAKE_CALLS"
case "$*" in
  "run --silent pyth-pusher -- check "*)
    echo "✓ SOL/USD          ELp9x5sFxGJ7zTurykU2p6A9nKDx72b3xzPxfsB5S8GB  \$150.12 ± 0.01 %  age 7 s  full"
    echo "✓ SKR/USD          9bCSdQVWckgKipe4G3G66aYU9yq2ZdDn8kRPZB9Nihbc  \$0.01761 ± ${FAKE_SKR_CONF:-0.45} %  age 7 s  full"
    echo; echo "all feeds healthy" ;;
  "run --silent pyth-pusher -- quote "*) echo "quote for \$4.99 (shard 0xCA75):" ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$bin2"/*
GOOD_KEY=goodkey-SECRET-7f3a
pyth() { # <mode flags…> -- <env assignments…>; output -> $log, exit code -> $rc
  local flags="$1"; shift
  log="$tmp/pyth.log"; : > "$tmp/calls.log"; rm -f "$tmp/calls.log.up" "$tmp/calls.log.run"
  # shellcheck disable=SC2086  # $flags is a list of words on purpose
  ( cd "$work" && env PATH="$bin2:$PATH" HOME="$tmp/home" REPO_DIR="$work" WALLET="$tmp/wallet.json" FAKE_CALLS="$tmp/calls.log" \
      HERMES_URL=http://hermes.invalid PYTH_WAIT_S=10 "$@" bash scripts/mac-devnet.sh --no-update --yes $flags ) < /dev/null > "$log" 2>&1
  rc=$?
}
rm -rf "$tmp/home/.config/solana/guttercaps"

pyth "--only pyth" FAKE_X=1
check pyth-nokey "explicit --only pyth without a key fails" test "$rc" -ne 0
expect pyth-nokey "нет ключа Pyth API" "$log"
expect_not pyth-nokey "docker run" "$tmp/calls.log"
pyth "--from pyth" FAKE_X=1
check pyth-nokey "the default flow goes on (exit 0)…" test "$rc" -eq 0
expect pyth-nokey "SOL- и SKR-оплата не заработает" "$log"          # …but says it out loud
expect pyth-nokey "оплата SOL и SKR (цены Pyth): выключено" "$log"    # …and again in the summary

pyth "--only pyth" PYTH_API_KEY=$GOOD_KEY
check pyth-ok "exit 0" test "$rc" -eq 0
expect pyth-ok "Hermes принял ключ" "$log"
expect pyth-ok "цены Pyth публикуются" "$log"
run_args=$(cat "$tmp/calls.log.run" 2>/dev/null)
for needle in "xc-price-pusher:v13" "-- npm run start -- solana" "--endpoint https://api.devnet.solana.com" "--shard-id 51829" \
              "--hermes-access-token $GOOD_KEY" "--pyth-contract-address pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT"; do
  case "$run_args" in *"$needle"*) pass pyth-ok "docker run has: $needle" ;; *) fail pyth-ok "docker run lacks: $needle"; echo "    $run_args" >&2 ;; esac
done
expect pyth-ok "docker rm -f guttercaps-pyth-pusher" "$tmp/calls.log"   # nothing is left running
check pyth-ok "the container is gone at the end" test ! -f "$tmp/calls.log.up"
expect_not pyth-ok "$GOOD_KEY" "$log"                                    # the key never reaches the terminal log…
check pyth-ok "…nor the pusher log file" test "$(grep -c "$GOOD_KEY" "$work/target/mac-devnet/logs/pyth-pusher.log" 2>/dev/null)" = 0
check pyth-ok "the key is saved, readable only by the user" test "$(cat "$tmp/home/.config/solana/guttercaps/pyth-api-key")" = "$GOOD_KEY"
check pyth-ok "…mode 600" test -n "$(find "$tmp/home/.config/solana/guttercaps/pyth-api-key" -perm 600 2>/dev/null)"

pyth "--only pyth" PYTH_API_KEY=bad-key
check pyth-denied "a rejected key fails" test "$rc" -ne 0
expect pyth-denied "Hermes отклонил ключ" "$log"
expect_not pyth-denied "docker run" "$tmp/calls.log"

pyth "--only pyth" PYTH_API_KEY=$GOOD_KEY FAKE_DOCKER_DOWN=1
check pyth-nodocker "no Docker fails" test "$rc" -ne 0
expect pyth-nodocker "нет работающего Docker" "$log"
expect_not pyth-nodocker "docker run" "$tmp/calls.log"

pyth "--only pyth" PYTH_API_KEY=$GOOD_KEY DEVNET_RPC_URL=https://api.mainnet-beta.solana.com
check pyth-mainnet "a mainnet RPC is refused" test "$rc" -ne 0
expect pyth-mainnet "похож на mainnet" "$log"
expect_not pyth-mainnet "docker run" "$tmp/calls.log"     # the container never gets a mainnet endpoint
pyth "--only pyth" PYTH_API_KEY=$GOOD_KEY FAKE_GENESIS=5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d
check pyth-mainnet "…also when only the genesis hash gives it away" test "$rc" -ne 0
expect_not pyth-mainnet "docker run" "$tmp/calls.log"

pyth "--only pyth" PYTH_API_KEY=$GOOD_KEY FAKE_CONTAINER_DIES=1
check pyth-died "a container that dies fails the stage" test "$rc" -ne 0
expect pyth-died "контейнер pusher остановился сам" "$log"
expect pyth-died "<PYTH_API_KEY>" "$log"                    # the container's own log is shown, with the key redacted
expect_not pyth-died "$GOOD_KEY" "$log"
check pyth-died "…and nothing is left running" test ! -f "$tmp/calls.log.up"

pyth "--only pyth" PYTH_API_KEY=$GOOD_KEY FAKE_SKR_CONF=3.1
expect pyth-conf "доверительный интервал 3.1 % > 2 %" "$log"   # SEC-M2: the program would refuse a payment at this width

# faucet: test funds for a browser wallet
TESTER=HeGzkwXYAtmuCv58TKDXLdPAjsYAoFbHVeLDQq1wivpd
mkdir -p "$work/target/mac-devnet"; printf 'SKR_MINT=EiE8kkup12LC8ygtKskvkjwFh62VadrrqPAY9F5YjE29\n' > "$work/target/mac-devnet/state.env"
pyth "faucet not-an-address-0OIl" FAKE_X=1
check faucet "a malformed address is refused" test "$rc" -ne 0
expect faucet "не похоже на адрес" "$log"
pyth "faucet $TESTER --sol 1 --skr 500" FAKE_X=1
check faucet "a good call succeeds" test "$rc" -eq 0
expect faucet "solana transfer $TESTER 1 --allow-unfunded-recipient" "$tmp/calls.log"
expect faucet "npm run --silent skr-pool -- mint-to $TESTER 500" "$tmp/calls.log"
pyth "faucet $TESTER" FAKE_BALANCE=500000000
expect faucet "не хватает на перевод" "$log"                  # short of SOL: says so, does not try
expect_not faucet "solana transfer" "$tmp/calls.log"

if [ "$fails" -gt 0 ]; then printf '\nselftest-mac-devnet: %s passed, %s FAILED\n' "$oks" "$fails" >&2; exit 1; fi
printf '\nselftest-mac-devnet: %s checks passed\n' "$oks"
