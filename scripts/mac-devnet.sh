#!/usr/bin/env bash
#
# scripts/mac-devnet.sh — MacBook: update from GitHub -> toolchain -> tests -> build -> Solana DEVNET deploy,
# in that order, resumable. Never touches mainnet (see ensure_devnet). Walkthrough: docs/MAC-DEVNET.md.
#
#   bash scripts/mac-devnet.sh                     # every stage below, in order
#   bash scripts/mac-devnet.sh --from build        # continue from a stage (after fixing a failure)
#   bash scripts/mac-devnet.sh --only doctor       # one stage (or a comma list: --only verify,rust)
#   bash scripts/mac-devnet.sh --skip rust         # everything except these
#   bash scripts/mac-devnet.sh --yes               # do not ask before installing tools / creating a wallet
#   bash scripts/mac-devnet.sh run                 # opt-in: backend + Pyth pusher + client against devnet, browser opens
#   bash scripts/mac-devnet.sh faucet <wallet>     # opt-in: test SOL + SKR for the browser wallet (--sol N --skr N)
#
# Stages (the order is load-bearing, see the notes at each stage):
#   update     git fetch + fast-forward to $BRANCH; regenerable local edits are dropped, yours are stashed
#   doctor     what is installed, what is missing (changes nothing)
#   toolchain  Node / Rust / Agave (solana CLI) / Anchor at the versions the repo pins, then `npm ci`
#   verify     `npm run verify`  (the 28 Node/Python gates, same as CI)
#   rust       `npm run programs:gate`  (cargo fmt + clippy -D warnings + cargo test)
#   localnet   `--features localnet` build + the 92-scenario LiteSVM suite (needs sb_mock, never devnet)
#   ids        program keypairs <-> declare_id!  (the repo ids are placeholders nobody holds keys for)
#   build      `--features devnet` build + verify-deploy artifact (devnet Switchboard pins, no sb_mock)
#   deploy     the 4 programs to devnet, resumable buffers, then verify-deploy onchain
#   setup      `npm run setup` (mints, config, collections, emission, arena) + lookup table
#   env        client/.env.local + backend/.env for this deployment
#   pyth       SOL/SKR payments: Pyth API key, pusher wallet, the pusher in Docker, proof that fresh prices are on chain
#   run        (opt-in) start backend + pusher + client dev server
#   faucet     (opt-in) `faucet <wallet>`: devnet SOL + stand-in SKR for a wallet that will play in the browser
#
# Environment:
#   BRANCH=main             branch to sync (default main)           REMOTE=origin
#   WALLET=~/.config/solana/id.json   deployer = upgrade authority = setup admin
#   DEVNET_RPC_URL=https://api.devnet.solana.com   use your own devnet RPC if the public one throttles
#   PROGRAM_KEYS_DIR=DIR    directory holding the 4 <program>-keypair.json you deploy with
#   REPO_DIR=DIR            repository root (default: detected)
#   PYTH_API_KEY=KEY        Pyth API key for Hermes (else the saved one, else asked once); https://pythdata.app/signup
#
# Portable on purpose: macOS ships bash 3.2 — no associative arrays, mapfile, ${var,,}, `sed -i`.
# No `set -u`/`set -e`: every step checks its own result so the failure names the stage and the fix.

# `sh scripts/mac-devnet.sh` / `zsh scripts/mac-devnet.sh` would die on the first array: hand over to bash, which macOS has.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"

set -o pipefail

ALL_STAGES="update doctor toolchain verify rust localnet ids build deploy setup env pyth"
OPTIN_STAGES="run faucet"
PROGRAMS="chip_core market staking arena"
DEVNET_GENESIS="EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"

REMOTE=${REMOTE:-origin}
BRANCH=${BRANCH:-main}
RPC_URL=${DEVNET_RPC_URL:-https://api.devnet.solana.com}
WALLET=${WALLET:-$HOME/.config/solana/id.json}
KEYS_DIR=${KEYS_DIR:-$HOME/.config/solana/guttercaps}
HERMES_URL=${HERMES_URL:-https://hermes.pyth.network}
PYTH_KEY_FILE="$KEYS_DIR/pyth-api-key"
PYTH_PAYER="$KEYS_DIR/pyth-payer.json"

FROM=""; ONLY=""; SKIP=""; ASSUME_YES=0; DO_UPDATE=1
FAUCET_TARGET=""; FAUCET_SOL=2; FAUCET_SKR=1000
ORIG_ARGS=("$@")

usage() { # the leading comment block, whatever its length
  local f="${BASH_SOURCE[0]:-$0}"
  if [ -f "$f" ] && [ -r "$f" ]; then
    awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$f"
  else # started as `bash <(git show …)`: the script text is a consumed pipe, there is nothing to re-read
    echo "Справка: docs/MAC-DEVNET.md, или из папки репозитория: bash scripts/mac-devnet.sh --help"
  fi
}

# ------------------------------------------------------------------ small helpers
say()  { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
ok()   { printf '  [ok] %s\n' "$*"; }
info() { printf '       %s\n' "$*"; }
warn() { printf '  [!]  %s\n' "$*"; }
bad()  { printf '  [x]  %s\n' "$*"; }
die()  { bad "$*"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
now()  { date +%s; }

show_cmd() { printf '  $'; printf ' %q' "$@"; printf '\n'; }
run() { show_cmd "$@"; "$@" || die "команда завершилась с ошибкой: $*"; }

confirm() { # confirm "question" -> 0 = yes
  if [ "$ASSUME_YES" = 1 ]; then say "  $1 [y/N] y (--yes)"; return 0; fi
  if [ ! -t 0 ]; then say "  $1 -> нет (нет терминала; добавьте --yes, если согласны)"; return 1; fi
  local a=""
  read -r -p "  $1 [y/N] " a || return 1
  case "$a" in y|Y|yes|YES|д|Д|да|Да|ДА) return 0 ;; *) return 1 ;; esac
}

path_add() { [ -d "$1" ] || return 0; case ":$PATH:" in *":$1:"*) ;; *) PATH="$1:$PATH" ;; esac; export PATH; }
init_path() {
  path_add /usr/local/bin; path_add /opt/homebrew/bin
  path_add "$HOME/.local/share/solana/install/active_release/bin"
  path_add "$HOME/.avm/bin"; path_add "$HOME/.cargo/bin"
  path_add /Applications/Docker.app/Contents/Resources/bin
}

sha256_stdin() { if have shasum; then shasum -a 256 | cut -d' ' -f1; else sha256sum | cut -d' ' -f1; fi; }
sha256_of() { sha256_stdin < "$1"; }
file_len()  { wc -c < "$1" | tr -d ' '; }

STATE="" # set once REPO is known
state_get() { [ -f "$STATE" ] || return 0; sed -n "s/^$1=//p" "$STATE" | tail -1; }
state_set() {
  mkdir -p "$(dirname "$STATE")"; touch "$STATE"
  grep -v "^$1=" "$STATE" > "$STATE.tmp" 2>/dev/null || true
  printf '%s=%s\n' "$1" "$2" >> "$STATE.tmp"; mv "$STATE.tmp" "$STATE"
}

stage_title() {
  case "$1" in
    update) echo "обновление из GitHub" ;;
    doctor) echo "проверка машины" ;;
    toolchain) echo "инструменты: Node, Rust, Solana, Anchor, npm ci" ;;
    verify) echo "npm run verify (28 проверок)" ;;
    rust) echo "cargo fmt + clippy + cargo test" ;;
    localnet) echo "localnet-сборка + 92 сценария LiteSVM" ;;
    ids) echo "ключи и id программ" ;;
    build) echo "сборка для devnet + проверка артефакта" ;;
    deploy) echo "деплой 4 программ в devnet" ;;
    setup) echo "инициализация on-chain (mints, config, коллекции…)" ;;
    env) echo ".env для клиента и бэкенда" ;;
    pyth) echo "цены Pyth для оплаты SOL и SKR" ;;
    run) echo "запуск бэкенда, pusher'а цен и клиента" ;;
    faucet) echo "тестовые SOL и SKR для кошелька" ;;
  esac
}

others_selected() { local t; for t in $ALL_STAGES $OPTIN_STAGES; do [ "$t" = update ] && continue; stage_selected "$t" && return 0; done; return 1; }
valid_stage() { case " $ALL_STAGES $OPTIN_STAGES " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
check_stage_list() { local s; for s in $(echo "$2" | tr ',' ' '); do valid_stage "$s" || die "неизвестный этап '$s' в $1. Этапы: $ALL_STAGES $OPTIN_STAGES"; done; }

stage_selected() { # name
  local s=$1 t seen=0
  if [ "$s" = update ] && [ "$DO_UPDATE" = 0 ]; then return 1; fi
  if [ -n "$ONLY" ]; then case ",$ONLY," in *",$s,"*) return 0 ;; *) return 1 ;; esac; fi
  case " $OPTIN_STAGES " in *" $s "*) return 1 ;; esac
  case ",$SKIP," in *",$s,"*) return 1 ;; esac
  if [ -n "$FROM" ]; then
    for t in $ALL_STAGES; do
      [ "$t" = "$FROM" ] && seen=1
      if [ "$t" = "$s" ]; then [ "$seen" = 1 ] && return 0 || return 1; fi
    done
  fi
  return 0
}

# ------------------------------------------------------------------ arguments
while [ $# -gt 0 ]; do
  case "$1" in
    --from)  [ $# -ge 2 ] || die "--from требует имя этапа"; FROM=$2; shift 2 ;;
    --only)  [ $# -ge 2 ] || die "--only требует имя этапа"; ONLY=$2; shift 2 ;;
    --skip)  [ $# -ge 2 ] || die "--skip требует имя этапа"; SKIP=$2; shift 2 ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    --no-update) DO_UPDATE=0; shift ;;
    -h|--help) usage; exit 0 ;;
    run) ONLY="run"; shift ;;
    faucet) ONLY="faucet"; shift; if [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; then FAUCET_TARGET=$1; shift; fi ;;
    --sol) [ $# -ge 2 ] || die "--sol требует число"; FAUCET_SOL=$2; shift 2 ;;
    --skr) [ $# -ge 2 ] || die "--skr требует число"; FAUCET_SKR=$2; shift 2 ;;
    *) printf 'неизвестный аргумент: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done
[ -n "$FROM" ] && check_stage_list --from "$FROM"
[ -n "$ONLY" ] && check_stage_list --only "$ONLY"
[ -n "$SKIP" ] && check_stage_list --skip "$SKIP"

# ------------------------------------------------------------------ repository root
REPO=${REPO_DIR:-}
if [ -z "$REPO" ]; then
  case "$0" in
    /dev/fd/*|/proc/*|bash|-bash|sh) REPO=$(git rev-parse --show-toplevel 2>/dev/null) ;;
    *) d=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd); [ -f "$d/Anchor.toml" ] && REPO=$d ;;
  esac
  [ -n "$REPO" ] || REPO=$(git rev-parse --show-toplevel 2>/dev/null)
fi
if [ -z "$REPO" ] || [ ! -f "$REPO/Anchor.toml" ]; then
  echo "Не нашёл корень репозитория guttercaps. Запустите из его папки (cd …/guttercaps) или задайте REPO_DIR=…" >&2
  exit 2
fi
cd "$REPO" || exit 2
STATE="$REPO/target/mac-devnet/state.env"
PYTH_DIR="$REPO/target/mac-devnet/pyth"
PYTH_LOG="$REPO/target/mac-devnet/logs/pyth-pusher.log"

# ------------------------------------------------------------------ log (every line also goes to a file)
if [ -z "${MAC_DEVNET_LOG:-}" ]; then
  mkdir -p "$REPO/target/mac-devnet/logs"
  MAC_DEVNET_LOG="$REPO/target/mac-devnet/logs/run-$(date +%Y%m%d-%H%M%S).log"
  export MAC_DEVNET_LOG
  # tee ignores SIGINT: Ctrl+C goes to the whole foreground group, and a dead tee would make the script's next
  # write a SIGPIPE, killing it before the EXIT trap could stop what it started (the pusher container).
  exec > >(trap '' INT; exec tee -a "$MAC_DEVNET_LOG") 2>&1
fi

CURRENT_STAGE=""
on_exit() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ -n "$CURRENT_STAGE" ] && [ "$CURRENT_STAGE" != run ]; then # Ctrl+C in `run` is the normal way out
    printf '\n[x] Остановился на этапе "%s" (код %s).\n' "$CURRENT_STAGE" "$rc"
    printf '    Лог: %s\n' "$MAC_DEVNET_LOG"
    printf '    Исправьте причину (текст ошибки выше) и продолжите с этого места:\n'
    printf '      bash scripts/mac-devnet.sh --from %s\n' "$CURRENT_STAGE"
  fi
  [ "${PYTH_STARTED:-0}" = 1 ] && pyth_stop
  sleep 0.3
}
trap on_exit EXIT
trap 'exit 130' INT   # exit -> EXIT trap: a Ctrl+C stops the pusher container and says where to resume
trap 'exit 143' TERM
trap 'exit 129' HUP

init_path
export NPM_CONFIG_UPDATE_NOTIFIER=false

# Pins come from the repo, not from this file — one source of truth.
pin_solana=$(sed -n 's/^solana_version *= *"\([^"]*\)".*/\1/p' Anchor.toml | head -1)
pin_anchor=$(sed -n 's/^anchor_version *= *"\([^"]*\)".*/\1/p' Anchor.toml | head -1)
pin_rust=$(sed -n 's/^channel *= *"\([^"]*\)".*/\1/p' rust-toolchain.toml | head -1)
pin_node=$(tr -d 'v \r\n' < .nvmrc 2>/dev/null)
: "${pin_solana:=2.1.0}" "${pin_anchor:=0.31.1}" "${pin_rust:=1.89.0}" "${pin_node:=22}"

# The 13 files `npm run program-ids -- apply` rewrites (scripts/program-ids.ts ID_SITES). Edits that only
# change public keys in these files are regenerable from the keypairs, so the updater may drop them.
ID_SITES="programs/chip_core/src/lib.rs programs/market/src/lib.rs programs/staking/src/lib.rs programs/arena/src/lib.rs
programs/chip_core/src/instructions/chip.rs Anchor.toml client/src/app/config.ts client/.env.example backend/src/config.ts
.github/workflows/ci.yml scripts/setup.ts scripts/create-lut.ts docs/08-audit-handoff.md"

solana_ver() { solana --version 2>/dev/null | sed -n 's/^solana-cli \([0-9][0-9.]*\).*/\1/p' | head -1; }
anchor_ver() { anchor --version 2>/dev/null | sed -n 's/^anchor-cli \([0-9][0-9.]*\).*/\1/p' | head -1; }
declared_id() { sed -n 's/.*declare_id!("\([1-9A-HJ-NP-Za-km-z]*\)").*/\1/p' "programs/$1/src/lib.rs" | head -1; }
keypair_file() { echo "$1/$2-keypair.json"; }
is_macos() { [ "$(uname -s)" = Darwin ]; }

# ================================================================== stage: update
is_id_site() { local x; for x in $ID_SITES; do [ "$x" = "$1" ] && return 0; done; return 1; }
ids_only_change() { # $1 = file: does it differ from HEAD only in base58 public keys?
  local a b
  a=$(git show "HEAD:$1" 2>/dev/null | LC_ALL=C sed -E 's/[1-9A-HJ-NP-Za-km-z]{32,44}/<ID>/g') || return 1
  b=$(LC_ALL=C sed -E 's/[1-9A-HJ-NP-Za-km-z]{32,44}/<ID>/g' "$1" 2>/dev/null) || return 1
  [ "$a" = "$b" ]
}
drop_regenerable_edits() {
  local f
  for f in $(git diff --name-only HEAD 2>/dev/null); do
    if [ "$f" = package-lock.json ]; then
      git checkout HEAD -- "$f" && info "сброшен $f (его правит голый 'npm install'; у нас 'npm ci')"
    elif is_id_site "$f" && ids_only_change "$f"; then
      git checkout HEAD -- "$f" && info "сброшен $f (там были только локально применённые id программ; этап ids применит их заново)"
    fi
  done
}

restore_pristine_ids() { # tests must run on the committed ids, exactly like CI
  local f n=0
  for f in $ID_SITES; do
    if ! git diff --quiet HEAD -- "$f" 2>/dev/null && ids_only_change "$f"; then git checkout HEAD -- "$f" && n=$((n+1)); fi
  done
  [ "$n" -gt 0 ] && info "для тестов возвращены закоммиченные id программ ($n файлов); этап ids применит ваши заново"
  return 0
}

stage_update() {
  git rev-parse --git-dir >/dev/null 2>&1 || die "$REPO — не git-репозиторий"
  step "GitHub: fetch $REMOTE/$BRANCH"
  git fetch --prune "$REMOTE" "+refs/heads/$BRANCH:refs/remotes/$REMOTE/$BRANCH" \
    || die "git fetch не удался (интернет? доступ к репозиторию? такая ветка есть: $BRANCH?)"
  local tip="refs/remotes/$REMOTE/$BRANCH" cur dirty stamp
  cur=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)

  drop_regenerable_edits
  dirty=$(git status --porcelain --untracked-files=no)
  if [ -n "$dirty" ]; then
    stamp=$(date +%Y%m%d-%H%M%S)
    warn "в папке есть ваши незакоммиченные правки — убираю их в stash, чтобы обновиться без конфликтов:"
    printf '%s\n' "$dirty" | sed 's/^/         /'
    git stash push -m "mac-devnet auto-stash $stamp" >/dev/null || die "не удалось сделать git stash — сохраните правки вручную"
    info "вернуть: git stash list  ->  git stash pop"
  fi

  if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    [ "$cur" = "$BRANCH" ] || run git checkout "$BRANCH"
    if git merge-base --is-ancestor HEAD "$tip"; then
      run git merge --ff-only "$tip"
    elif git merge-base --is-ancestor "$tip" HEAD; then
      warn "локальная $BRANCH впереди GitHub (есть ваши незапушенные коммиты) — оставляю как есть"
    else
      stamp=$(date +%Y%m%d-%H%M%S)
      warn "локальная $BRANCH разошлась с GitHub; старая версия сохранена в ветке backup/before-update-$stamp"
      run git branch "backup/before-update-$stamp" HEAD
      run git reset --hard "$tip"
    fi
  else
    # No `--track`: in a single-branch / shallow clone (fetch refspec covers only one branch) git refuses it with
    # "starting point is not a branch". Create the branch at the fetched tip and record the upstream by hand.
    run git checkout -b "$BRANCH" "$tip"
    git config "branch.$BRANCH.remote" "$REMOTE"
    git config "branch.$BRANCH.merge" "refs/heads/$BRANCH"
  fi
  ok "$(git log -1 --format='%h %s' | cut -c1-100)"

  # From here on run the freshly pulled copy of this script (the one that started may be older).
  others_selected || return 0
  [ -f "$REPO/scripts/mac-devnet.sh" ] || die "в ветке $BRANCH нет scripts/mac-devnet.sh"
  say "  продолжаю свежей копией скрипта из репозитория…"
  exec bash "$REPO/scripts/mac-devnet.sh" --no-update "${ORIG_ARGS[@]}"
}

# ================================================================== stage: doctor
stage_doctor() {
  local v arch t
  arch=$(uname -m)
  if is_macos; then
    ok "macOS $(sw_vers -productVersion 2>/dev/null) / $arch"
    [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ] && warn "терминал работает под Rosetta — сборка будет заметно медленнее; лучше нативный arm64-терминал"
    if xcode-select -p >/dev/null 2>&1; then ok "Xcode Command Line Tools: $(xcode-select -p)"; else bad "нет Xcode Command Line Tools (их поставит этап toolchain)"; fi
  else
    warn "скрипт рассчитан на macOS, у вас $(uname -s) — продолжаю, но так не проверялось"
  fi
  for t in git curl python3 node npm brew rustup cargo solana solana-keygen anchor avm; do
    if have "$t"; then
      case "$t" in
        node) v=$(node -v) ;; npm) v=$(npm -v) ;; git) v=$(git --version | sed 's/git version //') ;;
        cargo) v=$(cargo --version 2>/dev/null | cut -d' ' -f2) ;;
        solana) v=$(solana_ver) ;; anchor) v=$(anchor_ver) ;;
        *) v="есть" ;;
      esac
      printf '  %-14s %s\n' "$t" "$v"
    else
      printf '  %-14s %s\n' "$t" "нет"
    fi
  done
  info "нужно: node $pin_node.x (>= $pin_node.13), rust $pin_rust, solana $pin_solana, anchor $pin_anchor"
  local free_kb
  free_kb=$(df -k "$REPO" 2>/dev/null | awk 'NR==2 {print $4}')
  if [ -n "$free_kb" ]; then
    if [ "$free_kb" -lt 15000000 ]; then warn "свободно $((free_kb / 1024 / 1024)) ГБ — для сборки Rust нужно ~15 ГБ"; else ok "свободно $((free_kb / 1024 / 1024)) ГБ"; fi
  fi
  have git || die "нет git"
  have curl || die "нет curl"
  return 0
}

# ================================================================== stage: toolchain
node_version_ok() { # exact pinned major and >= .13 (type-stripping)
  have node || return 1
  local v major minor
  v=$(node -p 'process.versions.node' 2>/dev/null) || return 1
  major=${v%%.*}; minor=${v#*.}; minor=${minor%%.*}
  [ "$major" = "$pin_node" ] && [ "$minor" -ge 13 ]
}
node_usable() { # newer majors: not what CI runs, but the scripts only need type-stripping
  have node || return 1
  local v major minor
  v=$(node -p 'process.versions.node' 2>/dev/null) || return 1
  major=${v%%.*}; minor=${v#*.}; minor=${minor%%.*}
  [ "$major" -gt "$pin_node" ] || { [ "$major" = "$pin_node" ] && [ "$minor" -ge 13 ]; }
}
brew_node_path() { local p; for p in "/opt/homebrew/opt/node@$pin_node/bin" "/usr/local/opt/node@$pin_node/bin"; do [ -x "$p/node" ] && { echo "$p"; return 0; }; done; return 1; }

ensure_xcode_clt() {
  is_macos || return 0
  xcode-select -p >/dev/null 2>&1 && return 0
  bad "нет Xcode Command Line Tools (нужны git и компилятор C для Rust)"
  info "Запускаю установку: появится окно macOS — нажмите «Установить», дождитесь конца и запустите команду заново."
  xcode-select --install >/dev/null 2>&1 || true
  exit 1
}

ensure_node() {
  if node_version_ok; then ok "Node $(node -v)"; return 0; fi
  local p
  if p=$(brew_node_path); then path_add "$p"; node_version_ok && { ok "Node $(node -v) ($p)"; return 0; }; fi
  warn "Node: репозиторий закреплён на $pin_node.x (>= $pin_node.13); сейчас: $(have node && node -v || echo 'нет')"
  if have brew && confirm "Установить node@$pin_node через Homebrew?"; then
    run brew install "node@$pin_node"
    p=$(brew_node_path) && path_add "$p"
    node_version_ok || die "после установки node@$pin_node всё ещё не тот Node ($(have node && node -v || echo нет))"
    warn "чтобы node@$pin_node был постоянным: echo 'export PATH=\"$p:\$PATH\"' >> ~/.zshrc"
    ok "Node $(node -v)"; return 0
  fi
  if node_usable; then warn "продолжаю с Node $(node -v): CI гоняет $pin_node, на другой мажорной версии не проверялось"; return 0; fi
  die "нужен Node $pin_node.x (>= $pin_node.13): brew install node@$pin_node   или   https://nodejs.org"
}

ensure_rust() {
  if ! have rustup; then
    warn "нет rustup (установщик Rust)"
    confirm "Установить Rust через rustup (https://sh.rustup.rs)?" || die "без Rust не собрать программы"
    show_cmd sh -c 'curl --proto =https --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none'
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none || die "установка rustup не удалась"
    # shellcheck disable=SC1091
    [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
    init_path
  fi
  have rustup || die "rustup не найден в PATH после установки"
  # rustup >= 1.28 no longer installs the toolchain named in rust-toolchain.toml on its own
  run rustup toolchain install "$pin_rust" --profile minimal --component rustfmt --component clippy
  ok "rustc $(rustc --version 2>/dev/null | cut -d' ' -f2) (в папке репозитория, по rust-toolchain.toml)"
}

ensure_agave() {
  if [ "$(solana_ver)" = "$pin_solana" ]; then ok "solana-cli $pin_solana"; return 0; fi
  warn "solana CLI: нужен $pin_solana, сейчас: $(solana_ver || true)"
  info "Anchor.toml закрепляет solana $pin_solana. Установка переключит АКТИВНУЮ версию CLI (вернуть прежнюю: agave-install init <версия>)."
  confirm "Установить Agave/solana $pin_solana?" || die "без solana $pin_solana сборка и деплой невозможны"
  if have agave-install; then
    run agave-install init "$pin_solana"
  elif have solana-install; then
    run solana-install init "$pin_solana"
  else
    local installer
    show_cmd curl -sSfL "https://release.anza.xyz/v$pin_solana/install"
    installer=$(curl -sSfL "https://release.anza.xyz/v$pin_solana/install") || die "не скачался установщик https://release.anza.xyz/v$pin_solana/install (интернет?)"
    [ -n "$installer" ] || die "установщик Agave пустой"
    sh -c "$installer" || die "установка Agave $pin_solana не удалась"
  fi
  init_path; hash -r 2>/dev/null
  if [ "$(solana_ver)" != "$pin_solana" ] && have avm; then
    run avm solana install "$pin_solana"; hash -r 2>/dev/null
  fi
  [ "$(solana_ver)" = "$pin_solana" ] || die "после установки solana --version = '$(solana_ver)', ожидалось $pin_solana (проверьте PATH: which -a solana)"
  ok "solana-cli $(solana_ver)"
  info "чтобы PATH не терялся в новых окнах: export PATH=\"\$HOME/.local/share/solana/install/active_release/bin:\$PATH\"  (в ~/.zshrc)"
}

ensure_anchor() {
  if [ "$(anchor_ver)" = "$pin_anchor" ]; then ok "anchor-cli $pin_anchor"; return 0; fi
  warn "Anchor CLI: нужен $pin_anchor, сейчас: $(anchor_ver || true)"
  confirm "Установить Anchor $pin_anchor?" || die "без Anchor $pin_anchor сборка невозможна"
  if have avm; then
    # `avm use` succeeds when the version is already installed; otherwise install it first
    if ! avm use "$pin_anchor" >/dev/null 2>&1; then
      run avm install "$pin_anchor"
      run avm use "$pin_anchor"
    fi
  else
    local triple bin url
    case "$(uname -m)" in arm64|aarch64) triple=aarch64-apple-darwin ;; *) triple=x86_64-apple-darwin ;; esac
    is_macos || triple=x86_64-unknown-linux-gnu
    mkdir -p "$HOME/.cargo/bin"; bin="$HOME/.cargo/bin/anchor"
    url="https://github.com/otter-sec/anchor/releases/download/v$pin_anchor/anchor-$pin_anchor-$triple"
    say "  готовый бинарник релиза (без 10-минутной компиляции): $url"
    if curl -fL --retry 3 -o "$bin.tmp" "$url" && chmod +x "$bin.tmp" && mv "$bin.tmp" "$bin"; then
      hash -r 2>/dev/null
    else
      rm -f "$bin.tmp"
      warn "не скачался; собираю anchor-cli из исходников (~10 минут)"
      run cargo install --git https://github.com/otter-sec/anchor --tag "v$pin_anchor" anchor-cli --locked --force
    fi
  fi
  hash -r 2>/dev/null
  [ "$(anchor_ver)" = "$pin_anchor" ] || die "после установки anchor --version = '$(anchor_ver)', ожидалось $pin_anchor (which -a anchor)"
  ok "anchor-cli $(anchor_ver)"
}

ensure_node_deps() {
  if [ -d node_modules ] && [ node_modules/.package-lock.json -nt package-lock.json ]; then ok "node_modules актуальны"; return 0; fi
  run npm ci --no-audit --no-fund
}

wallet_preflight() { # informational only
  have solana-keygen || return 0
  local pub bal
  if [ ! -f "$WALLET" ]; then
    if confirm "Создать кошелёк деплоя ($WALLET) сейчас, чтобы пополнить его на faucet, пока идут тесты и сборка?"; then
      mkdir -p "$(dirname "$WALLET")"
      run solana-keygen new --no-bip39-passphrase --silent --outfile "$WALLET"
    else
      info "кошелька $WALLET ещё нет — этап deploy спросит ещё раз"; return 0
    fi
  fi
  pub=$(solana-keygen pubkey "$WALLET" 2>/dev/null) || return 0
  bal=$(solana balance "$pub" -u "$RPC_URL" 2>/dev/null | head -1)
  ok "кошелёк деплоя: $pub  (devnet: ${bal:-баланс недоступен})"
  info "для деплоя 4 программ понадобится порядка 15-30 SOL devnet (ориентир по размеру бинарников CI) — точную цифру скрипт посчитает после сборки."
  info "пока идёт сборка, можно пополнить кошелёк: https://faucet.solana.com (сеть Devnet)."
}

stage_toolchain() {
  ensure_xcode_clt
  ensure_node
  ensure_rust
  ensure_agave
  ensure_anchor
  ensure_node_deps
  wallet_preflight
  pyth_preflight
}

# ================================================================== stages: verify / rust / localnet
stage_verify() {
  restore_pristine_ids
  run npm run verify
}

stage_rust() {
  restore_pristine_ids
  have cargo || die "нет cargo (этап toolchain)"
  run npm run programs:gate
}

stage_localnet() {
  restore_pristine_ids
  # The suite loads sb_mock (Switchboard stand-in) — a --features localnet build. That .so must never reach
  # devnet: the `build` stage below overwrites target/deploy with the devnet-featured binaries.
  run sh scripts/anchor-build-localnet.sh
  run npm run verify-deploy -- artifact --cluster localnet
  # fetch-fixtures reads RPC_URL / ANCHOR_PROVIDER_URL (mainnet by default) for its optional Pyth dump: keep devnet out of it
  run env -u RPC_URL -u ANCHOR_PROVIDER_URL npm run localnet:fixtures
  rm -f target/localnet-junit.xml
  # CI=1: missing binaries then FAIL instead of being skipped (without it the suite exits 0 having run 11 of 121)
  run env CI=1 npm test
  local tests
  tests=$(grep -oE 'tests="[0-9]+"' target/localnet-junit.xml 2>/dev/null | head -1 | grep -oE '[0-9]+')
  [ "${tests:-0}" -ge 92 ] || die "localnet: выполнено ${tests:-0} тестов, ожидалось >= 92 — набор не отработал целиком (то же условие, что в CI)"
  ok "localnet: $tests тестов выполнено, ошибок нет"
}

# ================================================================== stage: ids
has_all_keypairs() { local p; for p in $PROGRAMS; do [ -f "$(keypair_file "$1" "$p")" ] || return 1; done; return 0; }
ids_match_dir() { npm run --silent program-ids -- check --from "$1" >/dev/null 2>&1; }

stage_ids() {
  # The four ids in the repo are placeholders (Anchor.toml says so) and their keypairs are not in the repo. A plain
  # `anchor build` would invent random keypairs, and the deployed address would then differ from declare_id!.
  # So: use keypairs that match the declared ids, else the ones already generated for this machine, else
  # generate fresh ones and let the repo's own tool rewrite every id site (`program-ids apply`).
  local dir="" found="" gen="$KEYS_DIR/programs" p
  for dir in "${PROGRAM_KEYS_DIR:-}" "$gen" "$KEYS_DIR"; do
    [ -n "$dir" ] && has_all_keypairs "$dir" && { found=$dir; break; }
  done
  if [ -z "$found" ] && ids_match_dir target/deploy; then
    mkdir -p "$gen"; chmod 700 "$gen"
    for p in $PROGRAMS; do cp "$(keypair_file target/deploy "$p")" "$gen/"; chmod 600 "$gen/$p-keypair.json"; done
    found=$gen
    ok "ключи из target/deploy совпали с declare_id! — сохранил копию в $gen (target/ стирается при cargo clean)"
  fi
  if [ -z "$found" ]; then
    warn "ключей программ для этих id нет ни в PROGRAM_KEYS_DIR, ни в $KEYS_DIR — id в репозитории это заглушки"
    info "создаю новые ключи программ в $gen и переписываю id во всех 13 местах (локально, НЕ коммитить)"
    local made
    show_cmd npm run --silent program-ids -- new --out "$gen"
    made=$(npm run --silent program-ids -- new --out "$gen") || { printf '%s\n' "$made"; die "program-ids new не удался"; }
    printf '%s\n' "$made" | sed '/^Next steps/,$d' | sed '/^$/d' | sed 's/^/  /'
    info "(для devnet-теста хранить ключи на этой машине нормально; совет про мультисиг-церемонию относится к mainnet)"
    found=$gen
  fi
  if ids_match_dir "$found"; then
    ok "declare_id! уже совпадает с ключами в $found"
  else
    run npm run --silent program-ids -- apply --from "$found"
    ids_match_dir "$found" || die "после apply id не сошлись (npm run program-ids -- check --from $found покажет где)"
    warn "id программ переписаны в 13 файлах репозитория. Это локальная правка под ваши ключи — не коммитьте её (вернуть заглушки: git checkout -- .)"
  fi
  run npm run --silent economy:check
  mkdir -p target/deploy
  for p in $PROGRAMS; do cp "$(keypair_file "$found" "$p")" target/deploy/; chmod 600 "target/deploy/$p-keypair.json"; done
  state_set PROGRAM_KEYS_DIR_USED "$found"
  for p in $PROGRAMS; do printf '  %-10s %s\n' "$p" "$(declared_id "$p")"; done
  info "ключи программ: $found  (храните копию: без них не обновить программы на этих адресах)"
}

# ================================================================== stage: build
stage_build() {
  run env ANCHOR_FEATURES=devnet sh scripts/anchor-build-localnet.sh
  # chip_core.so / arena.so must carry the devnet Switchboard pins and neither sb_mock's nor mainnet's id (SEC-F19)
  run npm run verify-deploy -- artifact --cluster devnet
  local p
  for p in $PROGRAMS; do
    [ -f "target/deploy/$p.so" ] || die "нет target/deploy/$p.so после сборки"
    printf '  %-10s %10s bytes\n' "$p" "$(file_len "target/deploy/$p.so")"
  done
}

# ================================================================== stage: deploy
ensure_devnet() {
  case "$RPC_URL" in *mainnet*) die "RPC_URL похож на mainnet ($RPC_URL): скрипт работает только с devnet" ;; esac
  local g
  g=$(solana genesis-hash -u "$RPC_URL" 2>/dev/null | tail -1)
  [ -n "$g" ] || die "RPC $RPC_URL не отвечает (нет интернета или публичный devnet ограничил запросы). Свой devnet RPC: DEVNET_RPC_URL=https://…"
  [ "$g" = "$DEVNET_GENESIS" ] || die "RPC $RPC_URL — НЕ devnet (genesis-hash $g). Деплой остановлен."
  ok "RPC $RPC_URL — devnet"
}

ensure_wallet() {
  if [ ! -f "$WALLET" ]; then
    warn "нет кошелька $WALLET"
    confirm "Создать новый кошелёк для devnet (он станет upgrade-authority программ и админом setup)?" || die "без кошелька деплой невозможен (WALLET=…)"
    mkdir -p "$(dirname "$WALLET")"
    run solana-keygen new --no-bip39-passphrase --silent --outfile "$WALLET"
  fi
  WALLET_PUB=$(solana-keygen pubkey "$WALLET") || die "не читается кошелёк $WALLET"
  ok "кошелёк: $WALLET_PUB"
}

sol() { awk -v l="${1:-0}" 'BEGIN { printf "%.2f", l / 1000000000 }'; }
balance_lamports() { solana balance --lamports "$1" -u "$RPC_URL" 2>/dev/null | awk '{print $1}' | head -1; }
rent_for() { echo $(( ($1 + 128) * 6960 )); } # (128 B account overhead + data) x 3480 lamports/B-year x 2 years

program_show_field() { # $1 = show output, $2 = field
  printf '%s\n' "$1" | sed -n "s/^$2: *//p" | head -1
}

keypair_dir() { local d; d=$(state_get PROGRAM_KEYS_DIR_USED); [ -n "$d" ] || d="${PROGRAM_KEYS_DIR:-$KEYS_DIR/programs}"; echo "$d"; }

ensure_funds() { # $1 = lamports needed
  local need=$1 bal tries=0 a=""
  bal=$(balance_lamports "$WALLET_PUB"); bal=${bal:-0}
  while [ "$bal" -lt "$need" ] && [ "$tries" -lt 3 ]; do
    tries=$((tries + 1))
    say "  баланс $(sol "$bal") SOL < нужно $(sol "$need") SOL — пробую airdrop 2 SOL ($tries/3)…"
    solana airdrop 2 "$WALLET_PUB" -u "$RPC_URL" || true
    sleep 3
    bal=$(balance_lamports "$WALLET_PUB"); bal=${bal:-0}
  done
  [ "$bal" -ge "$need" ] && return 0
  bad "на кошельке $WALLET_PUB не хватает SOL: есть $(sol "$bal"), нужно $(sol "$need")"
  info "публичный airdrop ограничен по частоте. Пополните адрес вручную: https://faucet.solana.com (сеть Devnet; за один заход выдают немного, заходов может понадобиться несколько)"
  info "адрес: $WALLET_PUB"
  if [ -t 0 ] && [ "$ASSUME_YES" = 0 ]; then
    while [ "$bal" -lt "$need" ]; do
      read -r -p "  Пополнили? Enter — проверить баланс, q + Enter — выйти " a || break
      [ "$a" = q ] && break
      bal=$(balance_lamports "$WALLET_PUB"); bal=${bal:-0}
      [ "$bal" -lt "$need" ] && say "  пока $(sol "$bal") SOL из $(sol "$need")"
    done
    [ "$bal" -ge "$need" ] && return 0
  fi
  die "SOL не хватает. Пополните кошелёк и продолжите: bash scripts/mac-devnet.sh --from deploy"
}

deploy_program() { # $1 = program
  local p=$1 so="target/deploy/$1.so" kp id len sha buf show authority cap attempt=1 grow
  kp=$(keypair_file "$(keypair_dir)" "$p"); id=$(declared_id "$p"); len=$(file_len "$so")
  step "деплой $p  ($id, $len байт)"
  if show=$(solana program show "$id" -u "$RPC_URL" 2>/dev/null); then
    authority=$(program_show_field "$show" "Authority")
    [ "$authority" = "$WALLET_PUB" ] || die "$p уже задеплоен с другим upgrade authority ($authority), а кошелёк — $WALLET_PUB. Возьмите кошелёк-владелец (WALLET=…) или новые ключи программ."
    cap=$(program_show_field "$show" "Data Length" | awk '{print $1}')
    if [ -n "$cap" ] && [ "$len" -gt "$cap" ]; then
      grow=$((len - cap))
      say "  новая версия больше ($len > $cap): расширяю программу на $grow байт"
      run solana program extend "$id" "$grow" -u "$RPC_URL" -k "$WALLET"
    fi
    # identical bytes already on chain (a re-run, or a program this change did not touch): nothing to upload
    local dump
    dump=$(mktemp "${TMPDIR:-/tmp}/mac-devnet-dump.XXXXXX")
    if solana program dump "$id" "$dump" -u "$RPC_URL" >/dev/null 2>&1 && [ "$(file_len "$dump")" -ge "$len" ] \
       && [ "$(head -c "$len" "$dump" | sha256_stdin)" = "$(sha256_of "$so")" ]; then  # BSD cmp (macOS) has no -n
      rm -f "$dump"
      ok "$p: в devnet уже лежат ровно эти байты — деплой пропускаю (https://explorer.solana.com/address/$id?cluster=devnet)"
      return 0
    fi
    rm -f "$dump"
    say "  программа уже есть на devnet — обновляю (upgrade)"
  fi
  # A resumable buffer: the keypair file is named after the binary's hash, so a retry (or a re-run) continues
  # the same upload instead of paying for a new one.
  sha=$(sha256_of "$so" | cut -c1-12)
  mkdir -p "$KEYS_DIR/buffers"; chmod 700 "$KEYS_DIR" "$KEYS_DIR/buffers" 2>/dev/null
  buf="$KEYS_DIR/buffers/$p-$sha.json"
  [ -f "$buf" ] || solana-keygen new --no-bip39-passphrase --silent --outfile "$buf" >/dev/null || die "не создался ключ буфера"
  while :; do
    show_cmd solana program deploy "$so" --program-id "$kp" --buffer "$buf" -u "$RPC_URL" -k "$WALLET" --use-rpc --max-sign-attempts 100
    if solana program deploy "$so" --program-id "$kp" --buffer "$buf" -u "$RPC_URL" -k "$WALLET" --use-rpc --max-sign-attempts 100; then break; fi
    if [ "$attempt" -ge 3 ]; then
      info "буфер сохранён ($buf): повторный запуск продолжит загрузку, SOL не пропадут."
      info "вернуть SOL из брошенных буферов: solana program show --buffers -u $RPC_URL -k $WALLET  ->  solana program close --buffers …"
      die "деплой $p не прошёл за 3 попытки (публичный devnet часто теряет транзакции — попробуйте свой RPC: DEVNET_RPC_URL=…)"
    fi
    attempt=$((attempt + 1)); warn "повтор $attempt/3 через 10 с — загрузка продолжится с буфера"; sleep 10
  done
  ok "$p: https://explorer.solana.com/address/$id?cluster=devnet"
}

stage_deploy() {
  have solana || die "нет solana CLI (этап toolchain)"
  [ -f target/deploy/chip_core.so ] || die "нет target/deploy/*.so — сначала этап build"
  ensure_wallet
  ensure_devnet
  local p kp id len show cap need=0 peak=0 fee=3000000000 prog_rent data_rent buf_rent dir
  dir=$(keypair_dir)
  # Safety: every keypair must derive the id that is compiled into the binary (declare_id!), else the deployed address is not the one the client uses.
  for p in $PROGRAMS; do
    kp=$(keypair_file "$dir" "$p")
    [ -f "$kp" ] || die "нет ключа программы $kp — этап ids"
    [ "$(solana-keygen pubkey "$kp")" = "$(declared_id "$p")" ] || die "ключ $kp даёт другой адрес, чем declare_id! для $p — выполните этап ids"
    len=$(file_len "target/deploy/$p.so")
    prog_rent=$(rent_for 36); data_rent=$(rent_for $((45 + len))); buf_rent=$(rent_for $((37 + len)))
    if show=$(solana program show "$(declared_id "$p")" -u "$RPC_URL" 2>/dev/null); then
      [ "$(program_show_field "$show" "Authority")" = "$WALLET_PUB" ] \
        || die "$p уже задеплоен с другим upgrade authority ($(program_show_field "$show" "Authority")), а кошелёк — $WALLET_PUB. Возьмите кошелёк-владелец (WALLET=…) или новые ключи программ. Ничего ещё не задеплоено."
      cap=$(program_show_field "$show" "Data Length" | awk '{print $1}')
      [ -n "$cap" ] && [ "$len" -gt "$cap" ] && need=$((need + (len - cap) * 6960))
    else
      need=$((need + prog_rent + data_rent))
    fi
    [ "$buf_rent" -gt "$peak" ] && peak=$buf_rent
  done
  need=$((need + peak + fee))
  say "  нужно на кошельке для деплоя: $(sol "$need") SOL (новые программы + самый большой буфер, он возвращается, + 3 SOL на setup, lookup table, crank и pusher цен Pyth)"
  ensure_funds "$need"
  for p in $PROGRAMS; do deploy_program "$p"; done
  step "проверка on-chain: байты == локальный .so, upgrade authority, пины Switchboard"
  run env PROGRAM_CHIP_CORE="$(declared_id chip_core)" PROGRAM_ARENA="$(declared_id arena)" \
    npm run verify-deploy -- onchain --cluster devnet --rpc "$RPC_URL" --authority "$WALLET_PUB"
}

# ================================================================== stage: setup
stage_setup() {
  have solana-keygen || die "нет solana CLI"
  WALLET_PUB=$(solana-keygen pubkey "$WALLET") || die "не читается кошелёк $WALLET"
  ensure_devnet
  local out cg skr usdc lut
  export ANCHOR_WALLET="$WALLET" ANCHOR_PROVIDER_URL="$RPC_URL"
  export PROGRAM_CHIP_CORE PROGRAM_MARKET PROGRAM_STAKING PROGRAM_ARENA
  PROGRAM_CHIP_CORE=$(declared_id chip_core); PROGRAM_MARKET=$(declared_id market)
  PROGRAM_STAKING=$(declared_id staking); PROGRAM_ARENA=$(declared_id arena)
  # Keep the same mints across re-runs: a failure before `initialize` would otherwise orphan freshly created ones.
  cg=$(state_get CG_MINT); skr=$(state_get SKR_MINT)
  [ -n "$cg" ] && export CG_MINT="$cg"
  [ -n "$skr" ] && export SKR_MINT="$skr"
  out=$(mktemp "${TMPDIR:-/tmp}/mac-devnet-setup.XXXXXX")
  show_cmd npm run setup
  npm run setup 2>&1 | tee "$out"
  local rc=${PIPESTATUS[0]}
  # setup prints the mints as it creates them and again at the end; remember them even if a later step failed
  # shellcheck disable=SC2016  # the \$ is a literal dollar for sed, not a shell expansion
  cg=$(sed -n 's/.*create \$CG mint \([1-9A-HJ-NP-Za-km-z]\{32,44\}\).*/\1/p' "$out" | tail -1)
  skr=$(sed -n 's/.*create SKR (devnet stand-in) mint \([1-9A-HJ-NP-Za-km-z]\{32,44\}\).*/\1/p' "$out" | tail -1)
  [ -n "$cg" ] && state_set CG_MINT "$cg"
  [ -n "$skr" ] && state_set SKR_MINT "$skr"
  if [ "$rc" -ne 0 ]; then rm -f "$out"; die "npm run setup завершился с ошибкой (он идемпотентный: после исправления просто запустите --from setup)"; fi
  cg=$(sed -n 's/^ *VITE_CG_MINT=\([1-9A-HJ-NP-Za-km-z]\{32,44\}\).*/\1/p' "$out" | tail -1)
  usdc=$(sed -n 's/^ *VITE_USDC_MINT=\([1-9A-HJ-NP-Za-km-z]\{32,44\}\).*/\1/p' "$out" | tail -1)
  skr=$(sed -n 's/^ *VITE_SKR_MINT=\([1-9A-HJ-NP-Za-km-z]\{32,44\}\).*/\1/p' "$out" | tail -1)
  rm -f "$out"
  [ -n "$cg" ] && [ -n "$usdc" ] && [ -n "$skr" ] || die "не смог прочитать адреса mint из вывода setup (строки VITE_CG_MINT=… в конце)"
  state_set CG_MINT "$cg"; state_set USDC_MINT "$usdc"; state_set SKR_MINT "$skr"
  ok "mints: CG $cg  USDC $usdc  SKR $skr"

  lut=$(state_get LOOKUP_TABLE)
  if [ -n "$lut" ] && npm run --silent create-lut -- show "$lut" >/dev/null 2>&1; then
    ok "lookup table уже есть: $lut"
    run npm run --silent create-lut -- extend "$lut"
  else
    out=$(mktemp "${TMPDIR:-/tmp}/mac-devnet-lut.XXXXXX")
    show_cmd npm run create-lut -- create
    npm run create-lut -- create 2>&1 | tee "$out"
    rc=${PIPESTATUS[0]}
    lut=$(sed -n 's/^LOOKUP_TABLE=\([1-9A-HJ-NP-Za-km-z]\{32,44\}\).*/\1/p' "$out" | tail -1)
    rm -f "$out"
    [ "$rc" -eq 0 ] && [ -n "$lut" ] || die "create-lut не отработал (адрес таблицы не получен)"
    state_set LOOKUP_TABLE "$lut"
    ok "lookup table: $lut"
  fi
}

# ================================================================== stage: env
write_generated() { # $1 = path, content on stdin. Never overwrites a file the user wrote.
  local path=$1 tmp
  tmp=$(mktemp "${TMPDIR:-/tmp}/mac-devnet-env.XXXXXX")
  cat > "$tmp"
  if [ -f "$path" ] && ! head -1 "$path" | grep -q '^# generated by scripts/mac-devnet.sh'; then
    cp "$tmp" "$path.mac-devnet"; rm -f "$tmp"
    warn "$path уже существует и написан не этим скриптом — не трогаю. Новый вариант: $path.mac-devnet"
  else
    mv "$tmp" "$path"; ok "записан $path"
  fi
}

stage_env() {
  local cg usdc skr lut secret crank
  cg=$(state_get CG_MINT); usdc=$(state_get USDC_MINT); skr=$(state_get SKR_MINT); lut=$(state_get LOOKUP_TABLE)
  [ -n "$cg" ] && [ -n "$lut" ] || die "нет адресов mint/lookup table — сначала этап setup"
  secret=$(sed -n 's/^SESSION_SECRET=//p' backend/.env 2>/dev/null | head -1)
  [ -n "$secret" ] || secret=$(node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))")
  crank="$KEYS_DIR/crank.json"
  if [ ! -f "$crank" ]; then
    mkdir -p "$KEYS_DIR"; chmod 700 "$KEYS_DIR" 2>/dev/null
    run solana-keygen new --no-bip39-passphrase --silent --outfile "$crank"
  fi
  write_generated client/.env.local <<EOF
# generated by scripts/mac-devnet.sh — devnet deployment; safe to delete (the next run rewrites it)
VITE_CLUSTER=devnet
VITE_RPC_URL=$RPC_URL
VITE_API_BASE=/v1
VITE_WS_BASE=/ws
VITE_DEV_API_TARGET=http://127.0.0.1:8787
VITE_PROGRAM_CHIP_CORE=$(declared_id chip_core)
VITE_PROGRAM_MARKET=$(declared_id market)
VITE_PROGRAM_STAKING=$(declared_id staking)
VITE_PROGRAM_ARENA=$(declared_id arena)
VITE_CG_MINT=$cg
VITE_USDC_MINT=$usdc
VITE_SKR_MINT=$skr
VITE_LOOKUP_TABLE=$lut
EOF
  write_generated backend/.env <<EOF
# generated by scripts/mac-devnet.sh — local devnet testing only (not a production config)
SESSION_SECRET=$secret
SIWS_DOMAINS=localhost:5173,127.0.0.1:5173
HUMAN_CHECK=0
SOLANA_RPC_URL=$RPC_URL
PROGRAM_CHIP_CORE=$(declared_id chip_core)
PROGRAM_MARKET=$(declared_id market)
PROGRAM_STAKING=$(declared_id staking)
PROGRAM_ARENA=$(declared_id arena)
LOOKUP_TABLE=$lut
CRANK_KEYPAIR=$crank
EOF
  # the crank signs reveal/open transactions: give it a little devnet SOL from the deployer
  local cpub cbal dbal
  cpub=$(solana-keygen pubkey "$crank"); cbal=$(balance_lamports "$cpub"); cbal=${cbal:-0}
  dbal=$(balance_lamports "$(solana-keygen pubkey "$WALLET")"); dbal=${dbal:-0}
  if [ "$cbal" -lt 1000000000 ] && [ "$dbal" -gt 3000000000 ]; then
    run solana transfer "$cpub" 1 --allow-unfunded-recipient -u "$RPC_URL" -k "$WALLET"
  elif [ "$cbal" -lt 1000000000 ]; then
    warn "crank-кошельку $cpub нужен ~1 SOL devnet (переведите с деплой-кошелька или faucet.solana.com): без него паки не будут открываться"
  fi
  ok "crank: $cpub"
}

# ================================================================== Pyth price pusher (SOL / SKR payments)
# chip_core converts a SOL or SKR payment from a Pyth PriceUpdateV2 account that must be <= 60 s old, and nobody
# posts SKR/USD for us (it is not a sponsored feed), so the studio runs Pyth's own price_pusher (ops/pyth-pusher/,
# owner decision Q7). Two facts that postdate that folder:
#   * since 2026-08-26 every Hermes request needs a Pyth API key (https://pythdata.app/signup, free trial);
#   * the pusher flag for it, --hermes-access-token, exists from v10.5.0 on (the folder used to pin v9.3.0).
# The pusher is the pinned official Docker image: the npm package of the same name does not even start on a fresh
# install (its Injective dependencies drift). It runs while `run` needs it, and briefly in `pyth` to prove the chain.
PYTH_CONTAINER="guttercaps-pyth-pusher"
PYTH_KEY_READY=0
PYTH_KEY_WHY=missing   # missing | denied
PYTH_SERVED=2          # feeds Hermes serves for this key (2 = both; fewer = the pusher will skip the rest)
PYTH_STATUS="не проверялось"
PYTH_WATCH_PID=""
PYTH_STARTED=0

pyth_conf() { sed -n "s/^$1=//p" ops/pyth-pusher/.env.example 2>/dev/null | head -1; }
pyth_feed_ids() { sed -n 's/^ *id: *\([0-9a-fA-F]\{64\}\).*/\1/p' ops/pyth-pusher/price-config.yaml 2>/dev/null; }

pyth_key_get() { # env wins over the saved file
  if [ -n "${PYTH_API_KEY:-}" ]; then printf '%s' "$PYTH_API_KEY" | tr -d ' \r\n'; return 0; fi
  [ -f "$PYTH_KEY_FILE" ] && tr -d ' \r\n' < "$PYTH_KEY_FILE"
  return 0
}
pyth_key_save() {
  mkdir -p "$KEYS_DIR"; chmod 700 "$KEYS_DIR" 2>/dev/null
  ( umask 077; printf '%s\n' "$1" > "$PYTH_KEY_FILE" ); chmod 600 "$PYTH_KEY_FILE"
}
# The key is an argument of exactly one docker call; it never goes through show_cmd, and whatever the container logs
# is passed through this filter before it reaches the terminal or a file.
pyth_redact() {
  awk 'BEGIN { k = ENVIRON["PYTH_API_KEY"] } { if (k != "") { while ((i = index($0, k)) > 0) $0 = substr($0, 1, i - 1) "<PYTH_API_KEY>" substr($0, i + length(k)) } print; fflush() }'
}

pyth_probe_hermes() { # $1 = key. Prints: ok | partial:<served>/<wanted> | denied | unreachable | http:<code>
  local key=$1 hdr out code c ids id url="" want=0 got
  hdr=$(mktemp "${TMPDIR:-/tmp}/mac-devnet-hdr.XXXXXX"); out=$(mktemp "${TMPDIR:-/tmp}/mac-devnet-hermes.XXXXXX")
  chmod 600 "$hdr"; printf 'Authorization: Bearer %s\n' "$key" > "$hdr" # a header file, so the key is not in `ps`
  ids=$(pyth_feed_ids)
  for id in $ids; do url="${url}ids[]=0x$id&"; want=$((want + 1)); done
  code=$(curl -g -sS -m 20 -o "$out" -w '%{http_code}' -H @"$hdr" "$HERMES_URL/v2/updates/price/latest?${url}encoding=hex" 2>/dev/null) || code=""
  case "$code" in
    200)
      got=$(grep -o '"id": *"[0-9a-fA-F]\{64\}"' "$out" | sort -u | wc -l | tr -d ' ')
      if [ "$got" -ge "$want" ]; then echo ok; else echo "partial:$got/$want"; fi ;;
    401|403) echo denied ;;
    404) # a feed id Hermes does not know: ask one by one, so that the answer says how many are served
      got=0
      for id in $ids; do
        c=$(curl -g -sS -m 20 -o /dev/null -w '%{http_code}' -H @"$hdr" "$HERMES_URL/v2/updates/price/latest?ids[]=0x$id&encoding=hex" 2>/dev/null) || c=""
        [ "$c" = 200 ] && got=$((got + 1))
      done
      echo "partial:$got/$want" ;;
    "") echo unreachable ;;
    *) echo "http:$code" ;;
  esac
  rm -f "$hdr" "$out"
}

pyth_obtain_key() { # [noask] -> 0 = a key exists (env / saved file / typed now) and Hermes did not reject it
  [ "$PYTH_KEY_READY" = 1 ] && return 0
  local key tries=0 probe
  key=$(pyth_key_get)
  while :; do
    if [ -z "$key" ]; then
      if [ "${1:-}" = noask ] || [ "$ASSUME_YES" = 1 ] || [ ! -t 0 ]; then return 1; fi
      if [ "$tries" = 0 ]; then
        say "  SOL- и SKR-оплата работает, только если на devnet кто-то публикует цены Pyth. Это делает pusher, а Hermes"
        say "  (источник цен Pyth) с 26.08.2026 требует ключ API:"
        say "    1) https://pythdata.app/signup — регистрация (есть бесплатный пробный период)"
        say "    2) вставьте ключ сюда (ввод скрыт). Enter — пропустить: USDC и \$CG-оплата работают и без него."
      fi
      read -r -s -p "  Pyth API key: " key || return 1
      echo
      key=$(printf '%s' "$key" | tr -d ' \r\n')
      [ -n "$key" ] || return 1
    fi
    probe=$(pyth_probe_hermes "$key")
    case "$probe" in
      ok) ok "Hermes принял ключ: цены SOL/USD и SKR/USD отдаются"; PYTH_SERVED=2 ;;
      partial:*)
        PYTH_SERVED=${probe#partial:}; PYTH_SERVED=${PYTH_SERVED%%/*}
        warn "Hermes отдаёт не все цены (${probe#partial:}): pusher пропустит недоступные, оплата в этой валюте не заработает" ;;
      denied)
        bad "Hermes отклонил ключ (401/403): он скопирован целиком? не закончился пробный период?"
        PYTH_KEY_WHY=denied
        tries=$((tries + 1)); key=""
        if [ "${1:-}" != noask ] && [ "$ASSUME_YES" = 0 ] && [ -t 0 ] && [ "$tries" -lt 3 ]; then continue; fi
        return 1 ;;
      unreachable) warn "Hermes сейчас недоступен (нет сети?) — ключ сохраняю без проверки" ;;
      *) warn "Hermes ответил неожиданно ($probe) — ключ сохраняю без проверки" ;;
    esac
    break
  done
  pyth_key_save "$key"
  PYTH_KEY_READY=1
  return 0
}

pyth_docker_ready() { # 0 = the docker CLI talks to a daemon (starts Docker Desktop if it is installed but not running)
  have docker || return 1
  docker info >/dev/null 2>&1 && return 0
  if is_macos && [ -d /Applications/Docker.app ]; then
    say "  Docker Desktop установлен, но не запущен — запускаю (жду до 2 минут)…"
    open -a Docker >/dev/null 2>&1 || true
    local i=0
    while [ "$i" -lt 40 ]; do docker info >/dev/null 2>&1 && return 0; sleep 3; i=$((i + 1)); done
  fi
  return 1
}

pyth_preflight() { # stage toolchain: ask for the key up front, so that the long stages below run unattended
  if pyth_obtain_key; then
    if ! have docker; then
      warn "pusher цен Pyth запускается в Docker, а Docker не найден: установите Docker Desktop (https://www.docker.com/products/docker-desktop/ или brew install --cask docker); этап pyth запустит его сам"
    elif docker info >/dev/null 2>&1; then
      ok "Docker готов (в нём будет работать pusher цен Pyth)"
    else
      info "Docker установлен, но не запущен — этап pyth запустит Docker Desktop"
    fi
  else
    info "Pyth: ключа нет — SOL/SKR-оплата будет выключена (USDC и \$CG работают). Позже: bash scripts/mac-devnet.sh --only pyth"
  fi
}

pyth_unavailable() { # $1 = reason. Default flow: say it loudly and go on; an explicit `--only pyth` is a failure
  PYTH_STATUS="выключено ($1)"
  warn "SOL- и SKR-оплата не заработает: $1"
  [ -z "$ONLY" ] || exit 1
  return 0
}

pyth_prepare() { # the pusher's payer wallet (funded) and the files the container mounts
  local pub bal dep dbal
  if [ ! -f "$PYTH_PAYER" ]; then
    mkdir -p "$KEYS_DIR"; chmod 700 "$KEYS_DIR" 2>/dev/null
    run solana-keygen new --no-bip39-passphrase --silent --outfile "$PYTH_PAYER"
  fi
  pub=$(solana-keygen pubkey "$PYTH_PAYER") || die "не читается $PYTH_PAYER"
  bal=$(balance_lamports "$pub"); bal=${bal:-0}
  if [ "$bal" -lt 300000000 ]; then # ~1 SOL lasts weeks of pushing (~0.07 SOL a day), accounts rent 2 x 0.002
    dep=$(solana-keygen pubkey "$WALLET" 2>/dev/null); dbal=$(balance_lamports "$dep"); dbal=${dbal:-0}
    if [ -n "$dep" ] && [ "$dbal" -ge 1500000000 ]; then
      run solana transfer "$pub" 1 --allow-unfunded-recipient -u "$RPC_URL" -k "$WALLET"
    else
      solana airdrop 1 "$pub" -u "$RPC_URL" || true
    fi
    bal=$(balance_lamports "$pub"); bal=${bal:-0}
  fi
  [ "$bal" -ge 100000000 ] || warn "у кошелька pusher'а $pub только $(sol "$bal") SOL — пополните (faucet.solana.com, Devnet), иначе цены не будут публиковаться"
  ok "кошелёк pusher'а: $pub ($(sol "$bal") SOL)"
  mkdir -p "$PYTH_DIR"
  cp ops/pyth-pusher/price-config.yaml "$PYTH_DIR/price-config.yaml"
  cp "$PYTH_PAYER" "$PYTH_DIR/payer.json"; chmod 644 "$PYTH_DIR/payer.json" # a devnet hot key with ~1 SOL; the container user must be able to read it
}

pyth_stop() {
  [ -n "$PYTH_WATCH_PID" ] && { kill "$PYTH_WATCH_PID" 2>/dev/null; PYTH_WATCH_PID=""; }
  have docker && docker rm -f "$PYTH_CONTAINER" >/dev/null 2>&1
  PYTH_STARTED=0
  return 0
}

pyth_start() {
  local key tag shard oracle plat=""
  key=$(pyth_key_get)
  tag=$(pyth_conf PUSHER_VERSION); shard=$(pyth_conf PYTH_SHARD_ID); oracle=$(pyth_conf PYTH_PUSH_ORACLE)
  : "${tag:=v13.0.0}" "${shard:=51829}" "${oracle:=pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT}"
  case "$RPC_URL" in *mainnet*) die "RPC_URL похож на mainnet ($RPC_URL): pusher платит комиссии с кошелька, а цены нужны devnet" ;; esac
  pyth_stop
  # the image may have no arm64 build; amd64 runs under Docker Desktop's emulation on Apple Silicon
  case "$(uname -m)" in arm64|aarch64) plat="--platform ${PYTH_DOCKER_PLATFORM:-linux/amd64}" ;; esac
  say "  запускаю pusher (образ xc-price-pusher:$tag, шард $shard; первый раз образ скачивается — 1-3 минуты)…"
  # shellcheck disable=SC2086
  docker run -d --name "$PYTH_CONTAINER" $plat \
    -v "$PYTH_DIR/price-config.yaml:/config/price-config.yaml:ro" \
    -v "$PYTH_DIR/payer.json:/config/payer.json:ro" \
    "public.ecr.aws/pyth-network/xc-price-pusher:$tag" -- npm run start -- solana \
    --endpoint "$RPC_URL" --keypair-file /config/payer.json --shard-id "$shard" \
    --price-config-file /config/price-config.yaml \
    --price-service-endpoint "$HERMES_URL" --hermes-access-token "$key" \
    --pyth-contract-address "$oracle" \
    --pushing-frequency 10 --polling-frequency 5 --compute-unit-price-micro-lamports 200 \
    --metrics-port 9090 --log-level info > /dev/null || return 1
  PYTH_STARTED=1
  mkdir -p "$(dirname "$PYTH_LOG")"; : > "$PYTH_LOG"
  ( docker logs -f "$PYTH_CONTAINER" 2>&1 | PYTH_API_KEY="$key" pyth_redact >> "$PYTH_LOG" ) > /dev/null 2>&1 &
  return 0
}

pyth_container_running() { [ -n "$(docker ps -q --filter "name=^${PYTH_CONTAINER}\$" --filter status=running 2>/dev/null)" ]; }

pyth_wait_healthy() { # $1 = seconds. 0 = both feeds fresh (output of `check` in $PYTH_DIR/last-check.txt), 1 = timeout, 2 = container died
  local deadline out rc good
  deadline=$(( $(now) + $1 ))
  : > "$PYTH_DIR/last-check.txt" # nothing stale from an earlier run
  while [ "$(now)" -lt "$deadline" ]; do
    pyth_container_running || { return 2; }
    out=$(npm run --silent pyth-pusher -- check "$RPC_URL" 2>&1); rc=$?
    printf '%s\n' "$out" > "$PYTH_DIR/last-check.txt"
    [ "$rc" -eq 0 ] && return 0
    # `check` fails while any feed is bad; when Hermes serves only some feeds, the served ones are enough
    good=$(printf '%s\n' "$out" | grep -c '✓')
    [ "$good" -ge 1 ] && [ "$good" -ge "$PYTH_SERVED" ] && return 0
    sleep 6
  done
  return 1
}

pyth_diagnose() { # $1 = result of pyth_wait_healthy
  bad "цены Pyth так и не появились в devnet"
  [ -s "$PYTH_DIR/last-check.txt" ] && sed 's/^/       /' "$PYTH_DIR/last-check.txt"
  if [ "$1" = 2 ]; then warn "контейнер pusher остановился сам; последние строки его лога:"; else warn "pusher работает, но цены не доходят; последние строки его лога:"; fi
  docker logs --tail 25 "$PYTH_CONTAINER" 2>&1 | PYTH_API_KEY=$(pyth_key_get) pyth_redact | cut -c1-260 | sed 's/^/       /'
  info "обычные причины: ключ Pyth (401 / закончился пробный период) · у кошелька pusher'а нет SOL · публичный devnet RPC теряет"
  info "транзакции (свой: DEVNET_RPC_URL=…) · devnet-receiver Pyth не принимает формат данных обновлённого Hermes."
  info "лог: $PYTH_LOG"
}

pyth_report() { # $1 = text of a healthy `check`: the prices, what a $4.99 pack costs, and the confidence guard
  local q
  printf '%s\n' "$1" | grep -E '(SOL|SKR)/USD' | sed 's/^/  /'
  q=$(npm run --silent pyth-pusher -- quote 499 "$RPC_URL" 2>&1) && printf '%s\n' "$q" | sed 's/^/  /'
  # chip_core refuses a price whose confidence interval is wider than 2 % (SEC-M2)
  printf '%s\n' "$1" | sed -nE 's/.*(SOL|SKR)\/USD.*± ([0-9.]+) %.*/\1 \2/p' | awk '$2 + 0 > 2 { print $1 " " $2 }' | while read -r sym w; do
    warn "$sym/USD: доверительный интервал $w % > 2 % — программа откажет в оплате этой валютой, пока рынок не успокоится (SEC-M2)"
  done
}

stage_pyth() {
  have solana || die "нет solana CLI (этап toolchain)"
  if ! pyth_obtain_key; then
    if [ "$PYTH_KEY_WHY" = denied ]; then pyth_unavailable "Hermes отклонил ключ Pyth API (проверьте ключ и пробный период: https://pythdata.app)"
    else pyth_unavailable "нет ключа Pyth API (https://pythdata.app/signup): задайте PYTH_API_KEY=… или запустите в терминале — скрипт спросит"; fi
    return 0
  fi
  pyth_docker_ready || { pyth_unavailable "нет работающего Docker (Docker Desktop: https://www.docker.com/products/docker-desktop/ или brew install --cask docker)"; return 0; }
  ensure_devnet
  pyth_prepare
  pyth_start || { pyth_unavailable "контейнер pusher не запустился (сообщение docker выше)"; return 0; }
  local wait_s=${PYTH_WAIT_S:-150}
  if [ "$wait_s" -ge 60 ]; then say "  жду первую публикацию цен в devnet (до $((wait_s / 60)) мин $((wait_s % 60)) с)…"; else say "  жду первую публикацию цен в devnet (до $wait_s с)…"; fi
  local rc=0
  pyth_wait_healthy "$wait_s" || rc=$?
  if [ "$rc" -eq 0 ]; then
    local chk sol_ok=0 skr_ok=0
    chk=$(cat "$PYTH_DIR/last-check.txt")
    pyth_report "$chk"
    printf '%s\n' "$chk" | grep '✓' | grep -q 'SOL/USD' && sol_ok=1
    printf '%s\n' "$chk" | grep '✓' | grep -q 'SKR/USD' && skr_ok=1
    if [ "$sol_ok" = 1 ] && [ "$skr_ok" = 1 ]; then
      PYTH_STATUS="работает: SOL/USD и SKR/USD на чейне свежие (pusher запускает этап run)"
      ok "цены Pyth публикуются — оплата SOL и SKR заработает"
    else
      PYTH_STATUS="частично: работает $([ "$sol_ok" = 1 ] && echo SOL || echo SKR), вторая валюта недоступна в Hermes"
      warn "цены опубликованы только для одной валюты (Hermes не отдаёт вторую): оплата второй не заработает"
    fi
  else
    pyth_diagnose "$rc"
    PYTH_STATUS="не заработало (диагностика выше)"
    pyth_stop
    [ -z "$ONLY" ] || exit 1
    return 0
  fi
  pyth_stop # nothing is left running: the pusher belongs to `run` (it costs ~0.07 SOL a day while it works)
}

# ================================================================== stage: faucet (opt-in)
stage_faucet() { # test funds for a wallet that will play in the browser: devnet SOL + stand-in SKR
  have solana || die "нет solana CLI (этап toolchain)"
  [ -n "$FAUCET_TARGET" ] || die "укажите адрес кошелька из браузера: bash scripts/mac-devnet.sh faucet <адрес> [--sol 2] [--skr 1000]"
  printf '%s' "$FAUCET_TARGET" | grep -Eq '^[1-9A-HJ-NP-Za-km-z]{32,44}$' || die "'$FAUCET_TARGET' не похоже на адрес кошелька Solana"
  ensure_devnet
  WALLET_PUB=$(solana-keygen pubkey "$WALLET") || die "не читается кошелёк деплоя $WALLET"
  local need dbal skr_mint
  need=$(awk -v s="$FAUCET_SOL" 'BEGIN { printf "%d", (s + 0.5) * 1000000000 }')
  dbal=$(balance_lamports "$WALLET_PUB"); dbal=${dbal:-0}
  if [ "$dbal" -ge "$need" ]; then
    run solana transfer "$FAUCET_TARGET" "$FAUCET_SOL" --allow-unfunded-recipient -u "$RPC_URL" -k "$WALLET"
  else
    warn "на кошельке деплоя $(sol "$dbal") SOL — не хватает на перевод $FAUCET_SOL SOL. Возьмите devnet-SOL на https://faucet.solana.com (адрес: $FAUCET_TARGET)"
  fi
  skr_mint=$(state_get SKR_MINT)
  if [ -z "$skr_mint" ]; then
    warn "нет адреса SKR-минта (он создаётся на этапе setup) — SKR не выдан"
  else
    run env ANCHOR_WALLET="$WALLET" ANCHOR_PROVIDER_URL="$RPC_URL" SKR_MINT="$skr_mint" STAKING_PROGRAM_ID="$(declared_id staking)" \
      npm run --silent skr-pool -- mint-to "$FAUCET_TARGET" "$FAUCET_SKR"
  fi
  info "USDC на devnet (оплата USDC): https://faucet.circle.com (Solana Devnet). \$CG выдаётся игрой, отдельного faucet у него нет."
}

# ================================================================== stage: run (opt-in)
pyth_watch() { # background: say once when fresh prices are on chain (or that they are not coming)
  local i=0
  while [ "$i" -lt 50 ]; do
    sleep 8
    pyth_container_running || { warn "pusher цен Pyth остановился; лог: $PYTH_LOG"; return 0; }
    if npm run --silent pyth-pusher -- check "$RPC_URL" > /dev/null 2>&1; then ok "цены Pyth свежие — оплата SOL и SKR доступна"; return 0; fi
    i=$((i + 1))
  done
  warn "цены Pyth не появились за ~7 минут: лог $PYTH_LOG (или docker logs $PYTH_CONTAINER)"
}

pyth_for_run() { # the pusher belongs to the session: fresh prices while the app is open, stopped together with it
  if ! pyth_obtain_key noask; then
    if [ "$PYTH_KEY_WHY" = denied ]; then warn "Pyth: Hermes отклонил сохранённый ключ — SOL/SKR-оплата выключена. Новый ключ: bash scripts/mac-devnet.sh --only pyth"
    else info "Pyth: ключа нет — SOL/SKR-оплата выключена (USDC и \$CG работают). Включить: bash scripts/mac-devnet.sh --only pyth"; fi
    return 0
  fi
  if ! pyth_docker_ready; then warn "Pyth: Docker не запущен — SOL/SKR-оплата выключена"; return 0; fi
  have solana || return 0
  ensure_devnet
  pyth_prepare
  pyth_start || { warn "Pyth: pusher не запустился (сообщение docker выше) — SOL/SKR-оплата выключена"; return 0; }
  ok "pusher цен Pyth запущен (лог: $PYTH_LOG); первые цены появятся примерно через минуту"
  pyth_watch &
  PYTH_WATCH_PID=$!
}

BACKEND_PID=""
stop_backend() { local rc=$?; [ -n "$BACKEND_PID" ] && { kill -- "-$BACKEND_PID" 2>/dev/null || kill "$BACKEND_PID" 2>/dev/null; BACKEND_PID=""; }; return "$rc"; }

stage_run() {
  [ -f backend/.env ] && [ -f client/.env.local ] || die "нет backend/.env и client/.env.local — сначала: bash scripts/mac-devnet.sh --only env"
  mkdir -p target/mac-devnet/logs
  local blog="target/mac-devnet/logs/backend.log"
  say "  бэкенд (API + индексатор + crank) -> лог $blog"
  # own process group (set -m), so stopping the backend also stops the node child that npm spawned
  set -m
  # shellcheck disable=SC1091
  ( set -a; . backend/.env; set +a; exec npm run backend:start ) > "$blog" 2>&1 &
  BACKEND_PID=$!
  set +m
  # the trap strings are single-quoted on purpose: they must see the variable at exit time, not now
  trap 'stop_backend; pyth_stop; on_exit' EXIT
  trap 'exit 130' INT TERM
  sleep 6
  kill -0 "$BACKEND_PID" 2>/dev/null || { tail -20 "$blog"; die "бэкенд не запустился (лог выше)"; }
  ok "бэкенд запущен (pid $BACKEND_PID), http://127.0.0.1:8787"
  pyth_for_run
  ( sleep 6; is_macos && open "http://localhost:5173" ) >/dev/null 2>&1 &
  say "  клиент: http://localhost:5173 (Ctrl+C остановит всё). Кошелёк в браузере переключите на Devnet."
  say "  чтобы платить SOL и SKR, кошельку из браузера нужны devnet-SOL и стенд-ин SKR: bash scripts/mac-devnet.sh faucet <адрес кошелька>"
  # the client's own `dev` script already passes --host; do not repeat it (two different values become an array).
  # --strictPort: SIWS_DOMAINS in backend/.env names :5173, so a silent hop to :5174 would break sign-in.
  npm --prefix client run dev -- --port 5173 --strictPort
}

# ================================================================== main
summary() {
  step "Готово"
  local p
  for p in $PROGRAMS; do printf '  %-10s %s\n' "$p" "https://explorer.solana.com/address/$(declared_id "$p")?cluster=devnet"; done
  [ -n "$(state_get CG_MINT)" ] && info "\$CG mint: $(state_get CG_MINT)   lookup table: $(state_get LOOKUP_TABLE)"
  info "кошелёк деплоя / upgrade authority: $WALLET"
  info "ключи программ (храните копию!): $(keypair_dir)"
  info "оплата SOL и SKR (цены Pyth): $PYTH_STATUS"
  info "запустить приложение (вместе с pusher'ом цен): bash scripts/mac-devnet.sh run"
  info "тестовые SOL и SKR кошельку из браузера: bash scripts/mac-devnet.sh faucet <адрес>"
  info "лог этого запуска: $MAC_DEVNET_LOG"
  if ! git diff --quiet HEAD -- Anchor.toml 2>/dev/null; then
    warn "id программ в репозитории переписаны под ваши ключи — не коммитьте их (git checkout -- . вернёт заглушки)"
  fi
}

TOTAL=0; for s in $ALL_STAGES $OPTIN_STAGES; do stage_selected "$s" && TOTAL=$((TOTAL + 1)); done
[ "$TOTAL" -gt 0 ] || die "нечего запускать: проверьте --from/--only/--skip"
say "GUTTERCAPS · devnet · ветка $BRANCH · RPC $RPC_URL"
say "Лог: $MAC_DEVNET_LOG"
N=0
for s in $ALL_STAGES $OPTIN_STAGES; do
  stage_selected "$s" || continue
  N=$((N + 1)); CURRENT_STAGE=$s; T0=$(now)
  step "[$N/$TOTAL] $s — $(stage_title "$s")"
  "stage_$s"
  ok "этап $s: $(( $(now) - T0 )) с"
done
CURRENT_STAGE=""
case ",$ONLY," in ",,"|*",deploy,"*|*",setup,"*|*",env,"*|*",pyth,"*) summary ;; esac
exit 0
