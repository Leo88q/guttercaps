#!/bin/sh
# selftest-cargo-lock.sh — fixtures for the pin machinery in scripts/ci-cargo-lock.sh. Runnable with no cargo,
# no network and no Rust toolchain, so it belongs in `npm run verify` (`selftest:cargolock`): everything else
# about this file is only observable in a CI run of lockfile.yml, and a CI run costs a day of round-trips
# precisely when the *report* is wrong.
#
# What is asserted here is the sentences, not the exit codes. The pass exists to tell a reader which of four
# states a refusal is in — fixed it, nothing left on the line to downgrade, the holders are off-limits by
# policy, the tool could not answer — and a test that only looked at `$?` would stay green while pointing a
# human at the wrong work. Every message this file asserts was invented because a real run printed a wrong
# one: run 23 claimed a version was missing when cargo had refused the move, run 25 printed an empty holder
# list, both of which read as "look elsewhere" when the answer was right there.
#
# The fakes are part of the assertion, so they are minimal and each models exactly one thing:
#   <tmp>/bin/cargo   the repo's cargo — writes the lock, answers `tree -i`, decides `--precise` requests
#   <tmp>/bin/curl    the sparse index, served from a directory of JSONL files (a miss is a 404, not an empty
#                     answer: "nothing known" and "no such version" must stay different facts)
#   <tmp>/faux/…      a solana install whose bundled cargo is the SBF one — its `metadata` is the oracle that
#                     decides whether the walk is finished, and it becomes readable only after the *right*
#                     crate was moved, which is what makes the holder search testable at all
set -u

self=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo=$(CDPATH= cd -- "$self/.." && pwd) || exit 1
fails=0
oks=0

note() { printf '%s\n' "$*"; }
expect() { # <scenario> <needle>
  if ! grep -qF -- "$2" "$log"; then
    printf 'FAIL [%s]: в логе нет строки\n  %s\n=== лог целиком:\n' "$1" "$2" >&2
    sed 's/^/    /' "$log" >&2
    fails=$((fails+1))
  else
    oks=$((oks+1)); printf 'ok   [%s] %s\n' "$1" "$2"
  fi
}
expect_not() {
  if grep -qF -- "$2" "$log"; then
    printf 'FAIL [%s]: в логе не должно быть\n  %s\n' "$1" "$2" >&2
    fails=$((fails+1))
  else
    oks=$((oks+1)); printf 'ok   [%s] (нет) %s\n' "$1" "$2"
  fi
}

sbx=$(mktemp -d) || exit 1
trap 'rm -rf "$sbx"' EXIT INT TERM

# ---------------------------------------------------------------- the graph under test
# app 1.0.0 -> mid 0.11.0 -> block-buffer 0.12.1, with anchor-lang and a path-dependency root (LockProbe)
# alongside. Numbers are real-shaped: 0.12.1 and 0.11.0 declare rust_version 1.85, everything below them is
# readable by the 1.79 in the anchor image, and *only* moving `mid` across its line makes block-buffer go away
# — which is the shape run 24 (block-buffer ← digest ← sha2) and run 25 (wincode ← solana-address) had.
rep="$sbx/rep"
mkdir -p "$rep/scripts" "$rep/programs/chip/src" "$sbx/bin" "$sbx/idx" "$sbx/state"
cp "$repo/scripts/ci-cargo-lock.sh" "$repo/scripts/ci-sbf-toolchain-check.sh" "$rep/scripts/" || exit 1
printf '[workspace]\nmembers = ["programs/chip"]\nresolver = "2"\n' > "$rep/Cargo.toml"
printf '[toolchain]\nanchor_version = "0.31.1"\nsolana_version = "2.1.0"\n' > "$rep/Anchor.toml"
printf '[package]\nname = "chip"\nversion = "0.1.0"\nedition = "2021"\n' > "$rep/programs/chip/Cargo.toml"
: > "$rep/programs/chip/src/lib.rs"

printf '{"name":"block-buffer","vers":"0.12.1","deps":[{"name":"mid","req":"^0.11","kind":null}],"yanked":false,"rust_version":"1.85"}\n{"name":"block-buffer","vers":"0.10.4","deps":[],"yanked":false,"rust_version":"1.60"}\n' > "$sbx/idx/block-buffer"
printf '{"name":"mid","vers":"0.11.0","deps":[{"name":"block-buffer","req":"^0.12","kind":null}],"yanked":false,"rust_version":"1.85"}\n{"name":"mid","vers":"0.10.7","deps":[{"name":"block-buffer","req":"^0.10","kind":null}],"yanked":false,"rust_version":"1.56"}\n' > "$sbx/idx/mid"
printf '{"name":"app","vers":"1.0.0","deps":[{"name":"mid","req":"^0.11","kind":null}],"yanked":false,"rust_version":"1.56"}\n' > "$sbx/idx/app"
printf '{"name":"anchor-lang","vers":"0.31.1","deps":[],"yanked":false,"rust_version":"1.60"}\n' > "$sbx/idx/anchor-lang"
printf '{"name":"solana-program","vers":"1.18.26","deps":[],"yanked":false,"rust_version":"1.60"}\n' > "$sbx/idx/solana-program"
printf '{"name":"unused-crate","vers":"1.2.3","deps":[],"yanked":false,"rust_version":"1.90"}\n' > "$sbx/idx/unused-crate"
printf '{"name":"devonly","vers":"1.11.0","deps":[],"yanked":false,"rust_version":"1.85"}\n{"name":"devonly","vers":"1.0.0","deps":[],"yanked":false,"rust_version":"1.60"}\n' > "$sbx/idx/devonly"
printf '{"name":"anchor-spl","vers":"0.31.1","deps":[],"yanked":false,"rust_version":"1.60"}\n' > "$sbx/idx/anchor-spl"
# A 404 (empty body) for anything else. LockProbe — the workspace root — is deliberately left out: it is a
# path dependency with no index record, and it is how the "индекс не прочитан" counter gets exercised.

# ---------------------------------------------------------------- the repo cargo
cat >"$sbx/bin/cargo" <<'FAKE'
#!/bin/sh
# Models the cargo that *can* read every manifest: it writes the lock, answers `cargo tree`, and accepts a
# --precise move only for the one (crate, version) pair the scenario allows. Everything about refusal here is
# deliberate: the walk must reach its conclusions from cargo's answer, not from its own cleverness.
state=${SBX:?}/state
args=$(printf '%s ' "$@")
if [ "$1" = "--version" ]; then echo "cargo 1.89.0 (selftest)"; exit 0; fi
if printf '%s' "$args" | grep -q 'generate-lockfile'; then
  cat >Cargo.lock <<'LOCK'
# This file is automatically @generated by Cargo.
version = 4

[[package]]
name = "LockProbe"
version = "0.1.0"
dependencies = [
 "app",
 "anchor-lang",
]

[[package]]
name = "anchor-lang"
version = "0.31.1"

[[package]]
name = "app"
version = "1.0.0"
dependencies = [
 "mid 0.11.0",
]

[[package]]
name = "mid"
version = "0.11.0"
dependencies = [
 "block-buffer 0.12.1",
]

[[package]]
name = "block-buffer"
version = "0.12.1"

[[package]]
name = "unused-crate"
version = "1.2.3"
LOCK
  echo "    Updating crates.io index (selftest)"; exit 0
fi
if printf '%s' "$args" | grep -q 'tree -i'; then   # careful: `tree` alone would also swallow `tree -e …`
  case "${FAKE_TREE:-ok}" in
    fail) echo 'error: failed to get dependency information for `block-buffer`' >&2; exit 101;;
    empty) exit 0;;
    excluded) echo 'anchor-spl v0.31.1'; echo 'solana-program v1.18.26'; echo 'block-buffer v0.12.1'; exit 0;;
  esac
  for a in "$@"; do
    [ "$a" = "block-buffer@0.12.1" ] && { echo 'mid v0.11.0'; echo 'block-buffer v0.12.1'; }
    [ "$a" = "mid@0.11.0" ] && { echo 'app v1.0.0'; echo 'mid v0.11.0'; }
    [ "$a" = "app@1.0.0" ] && echo 'app v1.0.0'
  done
  exit 0
fi
if printf '%s' "$args" | grep -q 'update -p'; then
  p=""; v=""; prev=""
  for a in "$@"; do
    [ "$prev" = "-p" ] && p=$a
    [ "$prev" = "--precise" ] && v=$a
    prev=$a
  done
  # The offender itself may never move: its line has nothing readable below it, which is what makes the search
  # have to look at the edge instead.
  # Refused *until* the dependent is relaxed — the shape run 28 showed: the range blocking block-buffer's move
  # belongs to `mid`, so a list that pins both must not care which of the two lines comes first.
  if [ "$p" = "block-buffer@0.12.1" ]; then
    if [ -f "$state/mid_moved" ] && [ "$v" = "0.10.4" ]; then
      touch "$state/bb_moved"; echo ' Downgrading block-buffer v0.12.1 -> v0.10.4'; exit 0
    fi
    echo "error: failed to select a version for the requirement \`block-buffer = \"^0.12\"\`" >&2; exit 101
  fi
  if [ "$p" = "devonly@1.11.0" ] && [ "$v" = "1.0.0" ]; then echo ' Downgrading devonly v1.11.0 -> v1.0.0'; exit 0; fi
  if [ "$p" = "mid@0.11.0" ] && [ "$v" = "0.10.7" ] && [ "${FAKE_ALLOW:-1}" = 1 ]; then
    touch "$state/mid_moved"; echo ' Downgrading mid v0.11.0 -> v0.10.7'; exit 0
  fi
  echo "error: failed to select a version for the requirement \`mid = \"^0.11\"\`" >&2; exit 101
fi
if printf '%s' "$args" | grep -q 'tree -e normal,build'; then
  printf 'LockProbe v0.1.0\napp v1.0.0\nmid v0.11.0\nblock-buffer v0.12.1\nanchor-lang v0.31.1\n'
  # `-e normal,build,dev` — same graph plus the dev edges, which is exactly what the pin list must be able to
  # see: run 28 reported a live proptest pin as a dead line because the list's view stopped at dev.
  printf '%s' "$args" | grep -q 'normal,build,dev' && printf 'devonly v1.11.0\n'
  exit 0
fi
if printf '%s' "$args" | grep -q 'check'; then echo '    Finished dev [unoptimized + debuginfo]'; exit 0; fi
printf 'LockProbe v0.1.0\napp v1.0.0\nmid v0.11.0\nblock-buffer v0.12.1\nanchor-lang v0.31.1\n'
exit 0
FAKE

# ---------------------------------------------------------------- the SBF cargo
# Lives under a fake solana install so the *discovery* path (symlinked roots, `find -L`) is exercised too —
# run 62 was a gate that could not find the thing it was checking and said nothing.
faux="$sbx/faux"
mkdir -p "$faux/bin/dist/x86_64-unknown-linux-gnu/solana/rust/bin"
printf '#!/bin/sh\n[ "$1" = "--version" ] && { echo "solana-cli 2.1.0"; exit 0; }\nexit 0\n' >"$faux/bin/solana"
cat >"$faux/bin/dist/x86_64-unknown-linux-gnu/solana/rust/bin/cargo" <<'FAKE'
#!/bin/sh
# Models the cargo that ships with the platform tools: 1.79, which parses everything except the edition2024
# manifests, and stops at the first one. The graph becomes "readable" only when the file the *repo* cargo
# touched exists — so the walk's stop condition is the toolchain's own answer, not a count of steps.
state=${SBX:?}/state
case "$1" in
  --version) echo "cargo 1.79.0 (selftest-sbf)"; exit 0;;
  metadata)
    if [ -f "$state/mid_moved" ]; then echo '{"packages":[],"workspace_members":[]}'; exit 0; fi
    echo 'error: failed to parse manifest at `/root/.cargo/registry/src/index.crates.io-6f17d22bba15001f/block-buffer-0.12.1/Cargo.toml`' >&2
    echo 'Caused by:' >&2; echo '  feature `edition2024` is required' >&2
    exit 101;;
esac
exit 0
FAKE
chmod +x "$sbx/bin/cargo" "$faux/bin/solana" "$faux/bin/dist/x86_64-unknown-linux-gnu/solana/rust/bin/cargo"

# ---------------------------------------------------------------- the index
cat >"$sbx/bin/curl" <<'FAKE'
#!/bin/sh
# The sparse index, from a directory. Exit 22 on a miss, which is what a 404 looks like to http_get — the
# distinction between "this crate has no readable version" and "we could not read the registry" is load-bearing
# in the caller, so the fake must not answer an empty body for a miss.
for a in "$@"; do case "$a" in https://*) url=$a;; esac; done
f="${SBX:?}/idx/$(basename "${url:-none}")"
[ -f "$f" ] || exit 22
cat "$f"
FAKE
chmod +x "$sbx/bin/curl"

# ---------------------------------------------------------------- scenarios
run_with_timeout() { # <seconds> <command> [args...]
  timeout_seconds=$1; shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$timeout_seconds" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$timeout_seconds" "$@"
  else
    # macOS has no GNU `timeout`. Keep the same bound there with Python and a fresh process group so a timed-out
    # shell cannot leave its fake cargo/curl children running in the background.
    python3 - "$timeout_seconds" "$@" <<'PY'
import os
import signal
import subprocess
import sys

seconds = float(sys.argv[1])
command = sys.argv[2:]
try:
    process = subprocess.Popen(command, start_new_session=True)
except OSError as error:
    print(f"could not start {command[0]}: {error}", file=sys.stderr)
    sys.exit(127)

try:
    result = process.wait(timeout=seconds)
except subprocess.TimeoutExpired:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
    print(f"command timed out after {seconds:g}s: {' '.join(command)}", file=sys.stderr)
    sys.exit(124)

sys.exit(result if result >= 0 else 128 - result)
PY
  fi
}

run() { # <scenario-name> [VAR=val ...]
  scen=$1; shift
  rm -f "$rep/Cargo.lock" "$sbx/state/mid_moved"
  : >"$log"
  ( cd "$rep" && run_with_timeout 60 env SBX="$sbx" PATH="$sbx/bin:$faux/bin:$PATH" GITHUB_REF=refs/heads/arena/selftest \
      GITHUB_ENV=/dev/null GITHUB_STEP_SUMMARY="$sbx/summary" "$@" \
      sh "$rep/scripts/ci-cargo-lock.sh" ) >"$log" 2>&1
  rc=$?
  printf '\n=== сценарий %s (rc %s)\n' "$scen" "$rc"
}
log="$sbx/log"

note "== selftest: ci-cargo-lock.sh"

run A FAKE_TREE=ok FAKE_ALLOW=1
expect A "sbf-autopin: block-buffer 0.12.1 -> 0.10.4 (rust_version <= 1.79, строка 0.12, ярус wide)"
expect A "sbf-autopin:   [0] пробую: mid 0.11.0 -> 0.10.7"
expect A "sbf-autopin: mid понижен до 0.10.7 — перепроверяю граф"
expect A "sbf-autopin: граф читается SBF-тулчейном после 1 шаг(ов) вниз"
expect A "ok: cargo 1.79.0 (selftest-sbf) parses every manifest in this lock"
expect_not A "audit:"
expect_not A "sbf-autopin:: индекс не прочитан"

run B FAKE_TREE=excluded FAKE_ALLOW=0
expect B "вне политики поиска (не трогаем): anchor-spl solana-program"
expect B "требуют её только anchor-spl solana-program"
expect_not B "cargo отказалась принять её и для block-buffer@0.12.1, и для держателей, которые поиску"

run C FAKE_TREE=empty FAKE_ALLOW=0
expect C "нет ни одного normal/build держателя в графе"

run D FAKE_TREE=fail FAKE_ALLOW=0
expect D "cargo tree -i block-buffer@0.12.1 не ответила (rc 101)"
expect_not D "нет ни одного normal/build держателя в графе"

# E — the audit. The gate fails here (nothing could be moved), and what the pass owes the reader is the whole
# list at once, with each offender's holders taken from the lock's own edges and the range from the index.
run E FAKE_TREE=empty FAKE_ALLOW=0
expect E "audit: block-buffer 0.12.1 требует rust_version 1.85 (> 1.79)"
expect E "← mid 0.11.0 (требует \"^0.12\")"
expect E "пин в SBFPINS (cross-line): \"block-buffer 0.12 0.10.4\""
expect E "audit: mid 0.11.0 требует rust_version 1.85 (> 1.79)"
expect E "← app 1.0.0 (требует \"^0.11\")"
expect E "audit: unused-crate 1.2.3 требует rust_version 1.90 (> 1.79)"
expect E "держателей в локе нет: крат стоит прявым требованием в наших манифестах"
expect E "индекс не прочитан, про них ничего не известно"
expect_not E "в локе нет ни одного манифеста с rust_version"

# F — a curated pin that matches nothing in the graph. It is not an error (a line can be parked on purpose),
# but it must never be silent: a dead pin reads as care while protecting nothing.
printf '# a comment line, with several words in it: must be skipped, not tried as a crate\ngone-crate 9.9 9.9.0\n' >"$sbx/pins"
run F FAKE_TREE=empty FAKE_ALLOW=0 SBFPINS_FILE="$sbx/pins"
expect F "ни одной версии из графа не тронули строки: \"gone-crate 9.9 9.9.0\""
# The comment must be invisible in both directions: treated as a crate it would be reported as dead (and the
# reader would chase a crate named `#`), and swallowed silently the list would accept typos as prose.
expect_not F "a comment line, with several words"

# G — список применяется до неподвижной точки и видит dev-рёбра. Порядок строк в списке не должен ничего
# решать (run 28: `indexmap` был отклонён, потому что блокирующий его диапазон снимался *следующей* строкой),
# и крат, видимый только через dev-ребро, обязан быть reachable (run 28: живой пин был записан как мёртвый).
printf 'block-buffer 0.12 0.10.4\nmid 0.11 0.10.7\ndevonly 1 1.0.0\n' >"$sbx/pins2"
run G FAKE_TREE=ok FAKE_ALLOW=1 SBFPINS_FILE="$sbx/pins2"
expect G "sbf-readability: mid 0.11.0 -> 0.10.7"
expect G "sbf-readability: block-buffer@0.12.1 -> 0.10.4 отклонено"
expect G "sbf-readability: block-buffer 0.12.1 -> 0.10.4"
expect G "sbf-readability: devonly 1.11.0 -> 1.0.0"
expect G "ready: Cargo.lock"
expect_not G "cargo refused to move"
expect_not G "sbf-autopin: у block-buffer"

printf '\n'
if [ "$fails" -ne 0 ]; then
  printf 'FAIL: %s проверок не прошло (из %s) — лог выше\n' "$fails" "$((fails+oks))" >&2
  exit 1
fi
printf 'selftest ok: ci-cargo-lock.sh — %s проверок по 7 сценариям (поиск по рёбрам, четыре концовки эскалации, аудит лока, мёртвый пин, до неподвижной точки)\n' "$oks"
