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
#   bash scripts/mac-devnet.sh run                 # opt-in: backend + client against devnet, browser opens
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
#   run        (opt-in) start backend + client dev server
#
# Environment:
#   BRANCH=main             branch to sync (default main)           REMOTE=origin
#   WALLET=~/.config/solana/id.json   deployer = upgrade authority = setup admin
#   DEVNET_RPC_URL=https://api.devnet.solana.com   use your own devnet RPC if the public one throttles
#   PROGRAM_KEYS_DIR=DIR    directory holding the 4 <program>-keypair.json you deploy with
#   REPO_DIR=DIR            repository root (default: detected)
#
# Portable on purpose: macOS ships bash 3.2 — no associative arrays, mapfile, ${var,,}, `sed -i`.
# No `set -u`/`set -e`: every step checks its own result so the failure names the stage and the fix.

set -o pipefail

ALL_STAGES="update doctor toolchain verify rust localnet ids build deploy setup env"
OPTIN_STAGES="run"
PROGRAMS="chip_core market staking arena"
DEVNET_GENESIS="EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"

REMOTE=${REMOTE:-origin}
BRANCH=${BRANCH:-main}
RPC_URL=${DEVNET_RPC_URL:-https://api.devnet.solana.com}
WALLET=${WALLET:-$HOME/.config/solana/id.json}
KEYS_DIR=${KEYS_DIR:-$HOME/.config/solana/guttercaps}

FROM=""; ONLY=""; SKIP=""; ASSUME_YES=0; DO_UPDATE=1
ORIG_ARGS=("$@")

usage() {
  sed -n '2,36p' "${BASH_SOURCE[0]:-$0}" 2>/dev/null | sed 's/^# \{0,1\}//' || true
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
}

sha256_of() { if have shasum; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi; }
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
    run) echo "запуск бэкенда и клиента" ;;
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

# ------------------------------------------------------------------ log (every line also goes to a file)
if [ -z "${MAC_DEVNET_LOG:-}" ]; then
  mkdir -p "$REPO/target/mac-devnet/logs"
  MAC_DEVNET_LOG="$REPO/target/mac-devnet/logs/run-$(date +%Y%m%d-%H%M%S).log"
  export MAC_DEVNET_LOG
  exec > >(tee -a "$MAC_DEVNET_LOG") 2>&1
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
  sleep 0.3
}
trap on_exit EXIT

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
    run git checkout -b "$BRANCH" --track "$REMOTE/$BRANCH"
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
  local need=$1 bal tries=0
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
  info "публичный airdrop ограничен по частоте. Пополните адрес вручную: https://faucet.solana.com (сеть Devnet)"
  info "адрес: $WALLET_PUB"
  if [ -t 0 ] && [ "$ASSUME_YES" = 0 ]; then
    local a=""
    read -r -p "  Пополнили? Нажмите Enter для проверки баланса (или q + Enter, чтобы выйти) " a || true
    [ "$a" = q ] && die "остановлено: нужно пополнить кошелёк"
    bal=$(balance_lamports "$WALLET_PUB"); bal=${bal:-0}
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
  local p kp id len show cap need=0 peak=0 fee=50000000 prog_rent data_rent buf_rent dir
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
  say "  нужно на кошельке для деплоя: $(sol "$need") SOL (новые программы + самый большой буфер, он возвращается, + запас на комиссии)"
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

# ================================================================== stage: run (opt-in)
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
  trap 'stop_backend; on_exit' EXIT
  trap 'exit 130' INT TERM
  sleep 6
  kill -0 "$BACKEND_PID" 2>/dev/null || { tail -20 "$blog"; die "бэкенд не запустился (лог выше)"; }
  ok "бэкенд запущен (pid $BACKEND_PID), http://127.0.0.1:8787"
  ( sleep 6; is_macos && open "http://localhost:5173" ) >/dev/null 2>&1 &
  say "  клиент: http://localhost:5173 (Ctrl+C остановит всё). Кошелёк в браузере переключите на Devnet."
  npm --prefix client run dev -- --host 127.0.0.1 --port 5173
}

# ================================================================== main
summary() {
  step "Готово"
  local p
  for p in $PROGRAMS; do printf '  %-10s %s\n' "$p" "https://explorer.solana.com/address/$(declared_id "$p")?cluster=devnet"; done
  [ -n "$(state_get CG_MINT)" ] && info "\$CG mint: $(state_get CG_MINT)   lookup table: $(state_get LOOKUP_TABLE)"
  info "кошелёк деплоя / upgrade authority: $WALLET"
  info "ключи программ (храните копию!): $(keypair_dir)"
  info "запустить приложение: bash scripts/mac-devnet.sh run"
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
case ",$ONLY," in ",,"|*",deploy,"*|*",setup,"*|*",env,"*) summary ;; esac
exit 0
