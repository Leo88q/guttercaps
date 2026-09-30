#!/usr/bin/env bash
# selftest-mac-devnet.sh — fixtures for the two parts of scripts/mac-devnet.sh that can hurt if they are wrong and
# that nothing else exercises: the GitHub update (it must never lose the user's work, and it must drop only what is
# regenerable) and the devnet guard (a mainnet RPC must stop the deploy before a single transaction). Runs with no
# Solana/Rust toolchain and no network — a bare repo on disk plays GitHub, three tiny fakes play solana — so it
# belongs in `npm run verify` (`selftest:macdevnet`); the real toolchain stages are only observable on a Mac.
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

if [ "$fails" -gt 0 ]; then printf '\nselftest-mac-devnet: %s passed, %s FAILED\n' "$oks" "$fails" >&2; exit 1; fi
printf '\nselftest-mac-devnet: %s checks passed\n' "$oks"
