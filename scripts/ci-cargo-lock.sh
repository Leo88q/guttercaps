#!/bin/sh
# ci-cargo-lock.sh — resolve, pin, and *prove* a Cargo.lock for the programs workspace. Called by
# .github/workflows/lockfile.yml, inside the same image the build gate uses.
#
# Why a workflow does this instead of a developer: a lockfile is the only place a version can be chosen for
# a *transitive* dependency, and here that choice is the difference between a red tree and a green one. The
# third-party crates that touch anchor-lang declare ranges our manifests cannot tighten (read from the
# registry index on 2026-09-18, not guessed):
#
#   switchboard-on-demand 0.13.0   anchor-lang >=0.31.0   (optional; the `anchor` feature turns it on)
#   pythnet-sdk 2.3.1              anchor-lang >=0.28.0   (optional; `solana-program` turns it on)
#   mpl-core 0.12.1                anchor-lang ^0.31.1 + kaigan/anchor → anchor-lang ^0.32.1
#
# A lower bound with no upper bound is satisfied by the newest major, so an unlocked resolve puts two or
# three copies of anchor-lang in the graph and every copy brings its own `borsh`. That is what
# `error[E0277]: the trait bound PriceFeedMessage: BorshSerialize is not satisfied`, with the note "there
# are multiple different versions of crate `borsh`", actually means: pyth's type derives the trait through
# one copy of anchor-lang while our `#[account]` bounds ask for another. The program source is not wrong;
# the graph is. So the pin below is not a taste for an old version — it is "the copy Anchor.toml's CLI
# matches", which is the only one whose derives our bounds can see.
#
# The script refuses to hand over an unverified lock: `cargo check --workspace --all-targets` has to pass,
# because a lockfile committed by a bot that cannot compile is how a build gate becomes a rumour.
set -u

# Progress bars are control characters; a redirected log full of them is not evidence (the first version of
# this file's output ended in 800 bytes of what looked like corrupted CP437 and no error line at all).
CARGO_TERM_COLOR=never
CARGO_TERM_PROGRESS_WHEN=never
export CARGO_TERM_COLOR CARGO_TERM_PROGRESS_WHEN

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) || exit 1
cd "$root" || exit 1

want=$(sed -n 's/^anchor_version *= *"\([^"]*\)".*/\1/p' Anchor.toml | head -1)
if [ -z "$want" ]; then
  echo "::error::Anchor.toml has no [toolchain] anchor_version — the pin has nothing to pin to"
  exit 1
fi
echo "pin: anchor-lang $want (read from Anchor.toml [toolchain], not hardcoded here)"

if ! cargo generate-lockfile; then
  echo "::error::cargo generate-lockfile failed — nothing to pin, nothing to commit"
  exit 1
fi

copies_of() { cargo tree -e normal,build --prefix none 2>/dev/null | grep -oE "^$1 v[0-9][^ ]*" | sed 's/^[^ ]* v//' | sort -u; }

# `cargo update -p anchor-lang --precise …` is not one command here, it is a *set*: once the graph holds
# several copies of a crate the bare name is ambiguous, and cargo says so ("multiple `anchor-lang` packages
# … re-run with one of: anchor-lang@0.31.2, anchor-lang@0.32.2, …"). So each copy is addressed by version
# and offered the wanted one; cargo moves it only if the dependent's requirement can accept it. That
# distinction is the finding: `>=0.31.0` and `>=0.28.0` accept $want, kaigan's hard `^0.32.1` does not, and
# no manifest edit on our side changes that.
#
# Repeated to a fixpoint (max 3), because the two crates are coupled: anchor-spl 0.31.2 requires
# `anchor-lang ^0.31.2`, so pass 1 cannot move anchor-lang to 0.31.1 — it has to move anchor-spl first.
# One pass leaves the graph half-pinned, which is exactly what run 2 did: "ok: anchor-spl 0.31.2 -> 0.31.1"
# beside a refused anchor-lang, and a lock that nobody can read as "the pinned toolchain".
refused=""
pass=1
while [ "$pass" -le 3 ]; do
  changed=0
  for c in anchor-lang anchor-spl; do
    for v in $(copies_of "$c"); do
      [ "$v" = "$want" ] && continue
      if cargo update -p "$c@$v" --precise "$want" >/dev/null 2>&1; then
        echo "pass $pass: $c $v -> $want"
        changed=1
        # a copy refused on pass 1 that moves on pass 2 is not "kept by its dependents" — leaving it in the
        # list would describe a pin that worked as one that did not
        refused=$(printf '%s' "$refused" | sed "s| $c@$v ||g")
      else
        case "$refused" in *" $c@$v "*) : ;; *) refused="$refused $c@$v " ;; esac
      fi
    done
  done

  # The second, sharper move: which copy a *specific dependent* resolved to. Unifying by version is
  # impossible here — chip_core needs ^0.31.1, kaigan (mpl-core's anchor feature) needs ^0.32.1, so two
  # copies exist by construction and stay. What decides whether the tree compiles is which of them
  # pythnet-sdk and switchboard-on-demand sit on: their ranges are unbounded (`>=0.28.0`, `>=0.31.0`), so
  # cargo happily answers them with 0.32, and then `PriceUpdateV2`'s borsh derive is the 1.x one while
  # `#[account]` asks for the 0.10 one — E0277 with "multiple different versions of crate borsh". A lockfile
  # can express the assignment that no manifest on our side can: the `-p <dependent>/<dep>` spec edits one
  # dependent's edge and leaves the other copy for kaigan. Both spellings are tried because the accepted
  # spec grammar has moved across cargo versions and this runs on the image's 1.79.
  for off in pythnet-sdk switchboard-on-demand; do
    offv=$(cargo tree -e normal,build -p "$off" 2>/dev/null | head -1 | grep -oE 'v[0-9][^ ]*' | cut -c2- || true)
    for v in $(copies_of anchor-lang); do
      [ "$v" = "$want" ] && continue
      # Is $off actually resolving to $v? Its own subtree is the only honest answer: `cargo tree -p` prints
      # the dependencies of that one package, so a hit means "this dependent chose this copy". A package
      # that is not in the graph at all (switchboard's `anchor` feature off, say) prints nothing and is
      # skipped — the absence of a match is not a failure to pin.
      cargo tree -e normal,build -p "$off" --prefix none 2>/dev/null |
        grep -qE "^[[:space:]]*anchor-lang v$v( |$)" || continue
      moved=""
      for spec in "$off/anchor-lang" "$off@$offv/anchor-lang"; do
        case "$spec" in *"@/"*) continue ;; esac
        if cargo update -p "$spec" --precise "$want" >/dev/null 2>&1; then
          moved="$spec"
          break
        fi
      done
      if [ -n "$moved" ]; then
        echo "pass $pass: edge $moved -> anchor-lang $want (was $v)"
        changed=1
      else
        echo "pass $pass: $off stays on anchor-lang $v — no edge spec cargo accepted; the check below decides"
      fi
    done
  done

  [ "$changed" = 0 ] && break
  pass=$((pass + 1))
done
if [ -n "$refused" ]; then
  # Named, and not fatal: these are the copies the graph is allowed to keep, and the compile below decides
  # whether keeping them is survivable. Silently leaving them out is how a pin looks like it worked.
  printf '::notice::kept by their dependents (structural, not a failure):%s\n' "$refused"
fi

# --- the other half of a usable lock: cargo has to be able to *read* it ---------------------------------
# The pin above answers "which copy of anchor-lang"; this answers "can the toolchain that builds the .so
# parse these manifests at all". `anchor build` runs `cargo build-sbf`, which puts the cargo bundled in the
# Agave release (2.1.0 -> cargo 1.79.0) before the image's own, and a manifest declaring `edition = "2024"`
# is then fatal four minutes into a build, with a message that names a crate and not a fix.
#
# getrandom 0.4 is reachable here only through dev-dependencies (proptest -> rusty-fork -> tempfile 3.27,
# whose own range is `>=0.3.0, <0.5`), so the graph can drop the entire 0.4 line with a version choice and
# nothing in our manifests changes. Entries: <crate> <forbidden line> <pin to>. If cargo refuses (a
# dependent with a narrower bound), the error names the crate — the answer is a second entry for *that*
# dependent, never a wider `Cargo.lock` hand-edit, which the next resolve would undo silently.
# Two primitives the SBF-readability pass below needs. Both are here rather than inline because the pass is
# a loop over *whatever* cargo 1.79 chokes on, and that list is not knowable in advance (getrandom in the
# first week, zeroize in the second: both were reached through ordinary `1.x` bumps, neither through a
# manifest we control).
#
# The index is queried over the network rather than from `$CARGO_HOME/registry/index/*/.cache`, which is
# cargo's own blake3-hashed binary format — unreadable without reimplementing half of cargo, and the whole
# point of this pass is that it must keep working when nobody has time to read cargo.
http_get() {
  if command -v curl >/dev/null 2>&1; then curl -sSfL --max-time 90 "$1"
  elif command -v wget >/dev/null 2>&1; then wget -q -O - "$1"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys,urllib.request; sys.stdout.write(urllib.request.urlopen(sys.argv[1], timeout=90).read().decode())' "$1"
  else
    return 127
  fi
}

# crates.io's index path rule, spelled out because the 1/2/3-char cases are the ones that silently 404.
idx_path() {
  n=$1
  case ${#n} in
    1) printf '1/%s' "$n" ;;
    2) printf '2/%s' "$n" ;;
    3) printf '3/%s/%s' "$(printf '%s' "$n" | cut -c1)" "$n" ;;
    *) printf '%s/%s/%s' "$(printf '%s' "$n" | cut -c1-2)" "$(printf '%s' "$n" | cut -c3-4)" "$n" ;;
  esac
}

# The newest version of $1 that (a) is in the same major, (b) sorts strictly below $3, (c) is not yanked,
# not a prerelease, and (d) declares a `rust_version` at or below $2 — the SBF cargo's own version. A record
# without `rust_version` is kept: those are old crates, and `sort -V` puts them where they belong. If a
# pre-2024 crate ever omits the field, the loop just runs once more against the next offender.
# Exit tells the caller *why* it got nothing: 1 = the index answered and there is genuinely no candidate (so a
# human has to choose a version outside the same-major rule), 2 = the index could not be read at all (so the
# right advice is to re-run or pin by hand, not "the registry has nothing"). Collapsing the two would print
# "no such version exists" on a network timeout, which is how a tool earns a reader who no longer believes it.
# Who requires $1 ($crate@$version), direct edges only. `cargo tree -i` is run by the repo's cargo because it
# is the one that can read every manifest in this graph — and the answer is a *list of edges*, which is the
# only thing a lockfile-level fix can act on.
#
# Excluded by name, with a reason: anchor-lang/anchor-spl are pinned by the pass above (moving them would undo
# the toolchain pin a few lines away), `solana-*` is the SDK — a program graph cannot be made readable by
# downgrading the platform it targets — and our own workspace members are not movable in a lock at all
# (`cargo update --precise` on a workspace member is a refusal, and each one would burn a node of the budget).
# That set is the policy of the search: utility crates and their direct consumers are ours to move, the
# chain's roots are not.
holders_of() { # <crate> <version> -> "name v<version>" на stdout; заметки — в stderr
  # Three states used to collapse into one: "nobody in this graph holds it", "every holder is outside the
  # policy" and "`cargo tree` refused to answer". Run 25 proved the difference matters — its escalation read
  # "и для держателей ( )" with an empty list, which sends a reader to look for holders the script had itself
  # filtered away by name. So the raw edges, the excluded ones and the cargo error are recorded separately.
  #
  # Notes go to stderr on purpose. The caller captures this function's *stdout* as the next queue level, so a
  # note printed to stdout becomes a dependency named "sbf-autopin:" — and the fixture then faithfully reported
  # "индекс не прочитан" about that, which is what a log line that doubles as data costs you.
  _ho_err=$(mktemp)
  _ho_raw=$(cargo tree -i "$1@$2" --depth 1 -e normal,build --prefix none 2>"$_ho_err"); _ho_rc=$?
  # `cargo tree -i X` prints X itself among the lines. It is not a holder of itself, and counting it as one
  # made the fixture say "2 держ. найдено, вне политики: block-buffer" about the crate we just asked about —
  # a number that is wrong is worse than no number, because the next reader trusts it.
  _ho_all=$(printf '%s\n' "$_ho_raw" | grep -oE '^[a-z0-9._-]+ v[0-9][^ ]*' | grep -vE "^$1 v" | awk '!s[$0]++')
  _ho_pat="^($ho_exc|$name) v"
  _ho_ok=$(printf '%s\n' "$_ho_all" | grep -vE "$_ho_pat" | head -8)
  if [ "$_ho_rc" -ne 0 ]; then
    printf '%s\n' "$1@$2" >> "$treerr"
    echo "sbf-autopin:     cargo tree -i $1@$2 не ответила (rc $_ho_rc): $(grep -m1 -E '^(error|warning)' "$_ho_err" | cut -c1-200 || head -1 "$_ho_err" | cut -c1-200)" >&2
  fi
  _ho_nall=$(printf '%s\n' "$_ho_all" | grep -c . || true)
  _ho_nok=$(printf '%s\n' "$_ho_ok" | grep -c . || true)
  if [ "${_ho_nall:-0}" -gt "${_ho_nok:-0}" ]; then
    _ho_skipped=$(printf '%s\n' "$_ho_all" | grep -E "$_ho_pat" | cut -d' ' -f1 | awk '!s[$0]++' | tr '\n' ' ')
    echo "sbf-autopin:     $_ho_nall держ. найдено, вне политики поиска (не трогаем): $_ho_skipped" >&2
    printf '%s\n' $_ho_skipped >> "$sawexc"
  fi
  # `touch` would be wrong for both markers: mktemp leaves them at zero bytes, so `-s` keeps reading "nothing",
  # and the script would announce an absence it had just seen evidence against.
  if [ "${_ho_nall:-0}" -gt 0 ]; then printf '%s\n' "$1@$2" >> "$sawraw"; fi
  rm -f "$_ho_err"
  printf '%s\n' "$_ho_ok"
}

idx_cache=$(mktemp -d)
# One fetch per crate, not per question about it. The audit below asks the index about every package in the
# lock and then again about each package's dependents, which without a cache is three requests per crate for
# ~440 crates on the failure path — the difference between a step that finishes and one that looks hung.
# A crate whose file 404s is cached as an empty file and reported as "nothing known": the fetch failing must
# never be readable as "no MSRV declared", which would be an absence invented out of a network error.
idx_body() { # <crate> -> sparse-index JSONL; rc 1 = nothing known about this crate
  _ib_f="$idx_cache/$1"
  if [ ! -f "$_ib_f" ]; then
    http_get "https://index.crates.io/$(idx_path "$1")" >"$_ib_f" 2>/dev/null || : >"$_ib_f"
  fi
  [ -s "$_ib_f" ] || return 1
  cat "$_ib_f"
}

# rust_version of one exact version, empty when the crate declares none (the same rule newest_readable uses —
# two definitions of "readable" in one script would disagree about whether the graph is fine).
msrv_of() { # <crate> <version> -> "1.85" | "" ; rc 1 = index unreadable
  _mo_body=$(idx_body "$1") || return 1
  # The patterns are assembled by concatenation rather than backslash-escaped: this is a JSON field name with
  # quotes inside a shell string inside a `$( )`, and every level of that wants its own escape rule. Written
  # that way it read as a broken grep and matched nothing — the audit then reported a fully readable graph
  # about a lock whose first offender it could not see. A pattern you cannot read is a pattern you cannot
  # trust to be doing anything, so: '"vers":"<v>"' assembled from pieces, and no escaping at all.
  _mo_pat='"vers":"'"$2"'"'
  _mo_line=$(printf '%s\n' "$_mo_body" | grep -F "$_mo_pat" | head -1)
  # A version with no index record is not a version with no MSRV. The lock's pairs always come from the index,
  # so this is a "we are being asked about something we cannot see" case — and answering it as "readable" would
  # make the audit's green mean nothing, which is the exact failure this file keeps being written against.
  [ -n "$_mo_line" ] || return 1
  printf '%s' "$_mo_line" | grep -o '"rust_version":"[0-9][^"]*"' | head -1 | cut -d'"' -f4
}

# The range a holder declares for a dependency — the thing that makes a refusal explicable. It is in the
# holder's index record, so it costs nothing once the cache exists.
req_of() { # <holder> <holder-version> <dep> -> "^0.6" ; rc 1 = unknown
  _ro_body=$(idx_body "$1") || return 1
  _ro_v='"vers":"'"$2"'"'
  _ro_d='"name":"'"$3"'"'
  printf '%s\n' "$_ro_body" | grep -F "$_ro_v" | head -1 \
    | grep -o "$_ro_d[^}]*" | head -1 | grep -o '"req":"[^"]*"' | head -1 | cut -d'"' -f4
}

ver_gt() { # <a> <b> -> 0 if dotted a > b (MSRVs are two components; empty a is never greater)
  [ -n "$1" ] || return 1
  awk -v a="$1" -v b="$2" 'BEGIN{ split(a,x,"."); split(b,y,".");
    if (x[1]+0 > y[1]+0) exit 0; if (x[1]+0 < y[1]+0) exit 1; exit !(x[2]+0 > y[2]+0) }'
}

newest_readable() { # <crate> <cargo "1.79"> <offender "1.9.0">  -> 0 pick | 1 no candidate | 2 index unreadable
  cr=$1; bound=$2; below=$3
  body=$(idx_body "$cr") || return 2
  [ -n "$body" ] || return 2
  # The line `cargo update --precise` may move inside without asking anyone. For a 0.x crate that line is
  # major.minor, not major: semver treats 0.2 and 0.3 as different crates, so a "same-major" rule offered
  # cpufeatures 0.2.17 as a downgrade of 0.3.1, and cargo refused it — correctly, since the dependents holding
  # `^0.3` cannot accept 0.2.x (run 22's log is that refusal, printed as if the pin were at fault).
  # The line `cargo update --precise` may move inside without asking anyone: for a 0.x crate it is
  # major.minor, for everything else it is the major. Both halves matter. Getting the first wrong offered
  # cpufeatures 0.2.17 as a "downgrade" of 0.3.1, which cargo refused because the dependents hold `^0.3`
  # (run 22's log printed that refusal as if the pin were at fault). Getting the second wrong would bury
  # zeroize: 1.8.2 and 1.9.0 share the *major*, and the first version of this rule compared `1.9` to `1.8`
  # and answered "nothing exists" about a pin that had just worked in CI.
  bmaj=$(printf '%s' "$below" | cut -d. -f1)
  if [ "$bmaj" = "0" ]; then
    bline=$(printf '%s' "$below" | cut -d. -f1,2)
    if [ "$bline" = "0.0" ]; then bmajor="0"; bf=1; else bmajor=$bline; bf=2; fi
  else
    bmajor=$bmaj; bf=1
  fi
  bm1=$(printf '%s' "$bound" | cut -d. -f1)
  bm2=$(printf '%s' "$bound" | sed 's/^[0-9]*\.//' | cut -d. -f1)
  cf=$(mktemp); af=$(mktemp); wf=$(mktemp)
  # Fresh temp files per call, not fixed names: this function runs once per round of the pass below, and a
  # `/tmp/sbf-cands` left by an earlier round would be concatenated with this round's list — which reads as
  # "the pin found a candidate" when what it found was its own stale output.
  printf '%s\n' "$body" | while IFS= read -r line; do
    case "$line" in *'"yanked":true'*) continue ;; esac
    v=$(printf '%s' "$line" | sed -n 's/.*"vers":"\([^"]*\)".*/\1/p')
    [ -n "$v" ] || continue
    case "$v" in *-*) continue ;; esac
    [ "$(printf '%s' "$v" | cut -d. -f1,"$bf")" = "$bmajor" ] || continue
    rv=$(printf '%s' "$line" | sed -n 's/.*"rust_version":"\([^"]*\)".*/\1/p')
    if [ -n "$rv" ]; then
      r1=$(printf '%s' "$rv" | cut -d. -f1); r2=$(printf '%s' "$rv" | sed 's/^[0-9]*\.//' | cut -d. -f1)
      if [ "$r1" -gt "$bm1" ] 2>/dev/null || { [ "$r1" = "$bm1" ] && [ "$r2" -gt "$bm2" ] 2>/dev/null; }; then
        continue
      fi
    fi
    printf '%s c\n' "$v"
  done > "$cf"
  # A second tier, deliberately: the same-line rule is what cargo would call "semver compatible without
  # asking", but the line is *narrower* than the graph's real freedom — tempfile asks for
  # `getrandom >=0.3.0, <0.5`, so 0.4.3 -> 0.3.4 is a legal move across lines, and it is exactly the pin that
  # removed E0277 from this repo. So: prefer same-line, and fall back to the newest readable version in the
  # same major, marked `w`. cargo is the arbiter either way (it refuses what a dependent's requirement
  # excludes), so the fallback cannot silently widen anything — it can only be refused, and a refusal hands
  # the decision to the dependent walk below.
  printf '%s\n' "$body" | while IFS= read -r line; do
    case "$line" in *'"yanked":true'*) continue ;; esac
    v=$(printf '%s' "$line" | sed -n 's/.*"vers":"\([^"]*\)".*/\1/p')
    [ -n "$v" ] || continue
    case "$v" in *-*) continue ;; esac
    [ "$(printf '%s' "$v" | cut -d. -f1)" = "$bmaj" ] || continue
    rv=$(printf '%s' "$line" | sed -n 's/.*"rust_version":"\([^"]*\)".*/\1/p')
    if [ -n "$rv" ]; then
      r1=$(printf '%s' "$rv" | cut -d. -f1); r2=$(printf '%s' "$rv" | sed 's/^[0-9]*\.//' | cut -d. -f1)
      if [ "$r1" -gt "$bm1" ] 2>/dev/null || { [ "$r1" = "$bm1" ] && [ "$r2" -gt "$bm2" ]; } 2>/dev/null; then
        continue
      fi
    fi
    printf '%s w\n' "$v"
  done > "$wf"
  printf '%s\n' "$body" | while IFS= read -r line; do
    v=$(printf '%s' "$line" | sed -n 's/.*"vers":"\([^"]*\)".*/\1/p')
    [ -n "$v" ] || continue
    case "$v" in *-*) continue ;; esac
    [ "$(printf '%s' "$v" | cut -d. -f1,"$bf")" = "$bmajor" ] || continue
    printf '%s a\n' "$v"
  done > "$af"
  # The offender is injected into its own sort stream, so "strictly below" is decided by order rather than by a
  # semver comparison: if the index no longer lists the offending version (yanked and pruned, or a renumber),
  # the alternative — never seeing `$1 == below` — would let every candidate through and return one *above*
  # what we are trying to escape. `&& $1 != below` closes the mirror case where a candidate ties the offender.
  { cat "$af"; printf '%s b\n' "$below"; cat "$cf"; } | sort -V -k1,1 | awk -v below="$below" '
    { if ($1 == below) stop = 1; if (!stop && $2 == "c" && $1 != below) best = $1 }
    END { if (best == "") exit 1; print best }' || {
    { cat "$af"; printf '%s b\n' "$below"; cat "$wf"; } | sort -V -k1,1 | awk -v below="$below" '
      { if ($1 == below) stop = 1; if (!stop && $2 == "w" && $1 != below) best = $1 }
      END { if (best == "") exit 1; print best " wide" }'
    rc=$?
    rm -f "$cf" "$af" "$wf"
    return $rc
  }
  rc=$?
  rm -f "$cf" "$af" "$wf"
  return $rc
}

# The capture is taken before the loop, not after: the loop has to know whether a forbidden line is present at
# all, and `versions()` below re-uses the same string. With `set -u` on, reading an unset `$tree` is an exit
# rather than an empty string, and the first draft of this block had the assignment after the loop — which is
# a pin that quietly never ran, the one failure mode a pin script is not allowed to have.
# The list is applied to a fixed point, over at most three passes, and it reads the graph *including* dev
# edges. Both details come from run 28, where each was a silent failure of the mechanism rather than of the
# graph:
#
#   · Order-dependence. `indexmap` was refused on its pass because the crate whose range blocked it
#     (`toml_edit 0.25`, via `proc-macro-crate 3.5`) was only moved by a *later* line in the same list. A list
#     whose meaning depends on line order is a trap: the next person re-sorts it and it silently stops working.
#   · Dev-dependencies. `cargo tree -e normal,build` does not contain them, so `proptest 1.11.0` — an offender
#     the audit had just named — was reported as a *dead pin line*, when the truth is that the loop could not
#     see it. `-e normal,build,dev` is the same graph the SBF cargo resolves and `cargo check --all-targets`
#     compiles; anything less makes the list blind to half of what the gate asks about.
tree=$(cargo tree -e normal,build,dev --prefix none 2>/dev/null || true)
sbf_refused=""
sbf_applied=""
# The list itself: `<crate> <version-line> <pin>`, one per line. SBFPINS_FILE exists so the fixtures can prove
# a line fires and that a dead one is reported; the heredoc below is the curated content, and it stays the
# only source of truth in CI.
pins=$(mktemp)
if [ -n "${SBFPINS_FILE:-}" ] && [ -f "$SBFPINS_FILE" ]; then
  cp "$SBFPINS_FILE" "$pins"
else
  cat >"$pins" <<'SBFPINS'
# Each line: <crate> <version-line> <pin>, applied as `cargo update -p <crate>@<found> --precise <pin>`.
# The *line* is what the graph currently resolved to (major.minor for 0.x, major otherwise); the pin is where
# it has to go so that the platform toolchain's own cargo (1.79 in solana 2.1.0) can read every manifest it
# will parse. A pin is only needed for a choice cargo cannot make for itself: cargo prefers newest-compatible,
# and an open range (`>=1.13.6`, `^1.5.0`, `<1.8`) is satisfied by a release that requires a newer rustc.
# Order does not matter — the list is applied until it stops changing anything — but roots read better first.
#
# Every pick below is taken from a registry answer, not from a changelog: either the audit of the produced lock
# (which prints these lines as suggestions, computed from `rust_version` in the sparse index) or the published
# dependency list of the version being moved to, checked so that the holder's own range admits it. Two of them
# were removed once and put back: run 29 (one pass per run) refused `indexmap` and `zeroize_derive`, run 30
# (fixed point) shows why the refusal said nothing about the lines themselves — what blocked each was a range
# that another line in the same list relaxes. Evidence gathered against an old mechanism has to be re-read
# after the mechanism changes, in both directions.
#
# mpl-core 0.12 requires solana-program ^3, and every manifest in that subtree declares rust_version 1.81+.
# programs/*/Cargo.toml widened their range to `>=0.11.1, <0.12` and root Cargo.toml patches `mpl-core` to
# `vendor/mpl-core` (`0.11.2`, asking for solana-program 2.2.1 and kaigan 0.3.0). Keeping 0.11.2 here prevents
# `cargo update --precise 0.11.1` from un-patching the vendored path dependency back to the registry release.
mpl-core 0.11 0.11.2
# mpl-bubblegum 2.1.1 declares `kaigan >=0.1` with no upper bound, so an unlocked resolve picks 0.5.0 (which
# pulls a second kaigan copy alongside vendor/mpl-core's 0.3.0). 0.3.0 satisfies >=0.1 and unifies the graph.
kaigan 0.5 0.3.0
# switchboard-on-demand 0.13.0 requires `faster-hex ^0.10.0`; 0.10.1 (rust_version 1.61.0) backports the
# AVX2 bounds check for RUSTSEC-2026-0306 (`hex_decode_unchecked` reading past `src`).
faster-hex 0.10 0.10.1
# pythnet-sdk 2.3.1 asks for solana-program >=1.13.6 with no upper bound, so the resolve rides to the 5.x SDK
# (rust_version 1.89; 5.1.0 also pulls wincode 0.6 / solana-* 3.x-5.x). Line is `5` (major, not `5.0`), so
# 5.1+ matches too; 2.3.0 satisfies >=1.13.6 and unifies with the copy the rest of the tree agreed on.
solana-program 5 2.3.0
# wasm-bindgen 0.2.129 and js-sys/web-sys 0.3.106 (published 2026-09-25) raised rust_version to 1.81.
# web-sys 0.3.105 pins `js-sys =0.3.105` and `wasm-bindgen =0.2.128` (rust_version 1.77), moving the whole
# family on pass 1; the explicit js-sys/wasm-bindgen lines guard the case where web-sys leaves the graph.
web-sys 0.3 0.3.105
js-sys 0.3 0.3.105
wasm-bindgen 0.2 0.2.128
# blake3's own manifest is readable; what 1.8.x drags in is the RustCrypto 0.11/0.12 wave (digest 0.11,
# crypto-common 0.2, block-buffer 0.12, hybrid-array 0.4 — all 1.85). 1.5.5 asks for digest ^0.10.1 and no
# cpufeatures at all, and solana-program's `blake3 = "1.5.0"` range admits it.
blake3 1.8 1.5.5
# 3.4.0 is already a downgrade (3.5.0 pulls toml_edit 0.25 → toml_parser/toml_datetime at 1.85), but 0.23 is
# itself the problem: every toml_edit 0.23.x needs toml_parser ^1.0.5, and no 1.0.5+ is readable. 3.2.0 asks
# for toml_edit ^0.22.20 (its published dependency list, checked), which has no toml_parser at all — and
# num_enum_derive's `>=1, <=3` admits it.
proc-macro-crate 3 3.2.0
# indexmap 2.12+ declares rust_version 1.82; 2.11.4 is the last readable on the line and every holder range in
# the graph (`petgraph ^2.5.0`, `toml_edit 0.22 ^2.3.0`) admits it. This also drops hashbrown 0.17, which
# arrives only through 2.14 — one line, two offenders, which is the argument for pinning the moving part.
indexmap 2 2.11.4
# Ordinary `^1`/`^0.8` drift, each taken from the audit's residue. base64ct: switchboard-on-demand 0.13.0 asks
# for `<1.8`, and the newest inside that is 1.7.3 at rust_version 1.81 — 1.6.0 is readable and allowed.
# zeroize 1.9.0 (1.85) requires zeroize_derive ^1.5 (1.85); moving zeroize to 1.8.2 (1.60) first relaxes the
# bound to `^1.3` so zeroize_derive 1.4.3 lands on pass 1.
unicode-segmentation 1 1.12.0
base64ct 1 1.6.0
zeroize 1 1.8.2
zeroize_derive 1 1.4.3
rmp 0.8 0.8.14
rmp-serde 1 1.3.0
# Dev trees are on the same terms: the same cargo resolves them and `cargo check --workspace --all-targets`
# compiles them, so an unreadable dev-only manifest is exactly as fatal as a normal one. proptest 1.11 needs
# 1.85; tempfile is the crate that introduced `getrandom >=0.3`, and 3.23.0 predates that edge.
proptest 1 1.8.0
tempfile 3 3.23.0
# wasip2 1.0.4 (1.87) and wit-bindgen 0.57.1 (1.85) have nothing readable on their lines at all, so the move
# is at their holder: getrandom 0.3.0 depends on `wasi ^0.13` for wasip2 targets instead of on `wasip2 ^1`
# (both checked against the published dependency lists). This is what "pin the edge, not the crate" means when
# the crate cannot move: `rust_decimal → rand 0.9 → rand_core 0.9 → getrandom 0.3` is the chain that keeps a
# 0.3.x copy alive, and `^0.3` admits 0.3.0.
getrandom 0.3 0.3.0
SBFPINS
fi
pins_dead=""
pass=1
pins_changed=yes
while [ "$pass" -le 3 ] && [ "$pins_changed" = yes ]; do
  pins_changed=""   # dedup happens per pass, not across passes: run 28's whole lesson is that a line refused early becomes
  # applicable once a later line has moved the range that blocked it, and a "seen this already" set that
  # outlives the pass turns the fixed point into a single pass with extra steps.
  while read -r s_c s_line s_pin; do
    # `#` skips: a pin list whose lines carry no reason is a list nobody dares to delete from and nobody can
    # re-derive. The comment costs one line per entry and is what lets the next reader tell a live pin from a
    # fossil — and fossils are reported anyway, so they cannot accumulate unnoticed.
    case "$s_c" in ''|\#*) continue ;; esac
    found=$(printf '%s\n' "$tree" | grep -oE "^$s_c v$s_line\\.[0-9][^ ]*" | sed 's/^[^ ]* v//' | head -1)
    if [ -z "$found" ]; then
      # Only worth saying on the first pass: later passes see a deliberately smaller graph, and repeating the
      # sentence three times would read as three problems.
      if [ "$pass" = 1 ]; then pins_dead="$pins_dead \"$s_c $s_line $s_pin\""; fi
      continue
    fi
    [ "$found" != "$s_pin" ] || continue        # already sitting where the pin wants it
    if cargo update -p "$s_c@$found" --precise "$s_pin" >/tmp/sbf-pin-$s_c.log 2>&1; then
      echo "sbf-readability: $s_c $found -> $s_pin (so the SBF cargo 1.79 can read every manifest in the lock)"
      sbf_applied="$sbf_applied $s_c@$found"
      pins_changed=yes
      tree=$(cargo tree -e normal,build,dev --prefix none 2>/dev/null || true)
    else
      echo "sbf-readability: $s_c@$found -> $s_pin отклонено: $(grep -m1 -E '^(error|warning)' /tmp/sbf-pin-$s_c.log | cut -c1-200 || true)"
      sbf_refused="$sbf_refused $s_c@$found"
    fi
  done <"$pins"
  pass=$((pass+1))
done
[ -z "$pins_dead" ] || echo "::notice title=sbf-readability::ни одной версии из графа не тронули строки:$pins_dead — это не ошибка, но мёртвый пин не защищает ничего: проверьте, что крат ещё в резолве (иначе строку надо убрать), и что она не задваивает то, что уже делает обход ниже"
rm -f "$pins"
# Refusals are no longer fatal here. They were: run 28 exited on `indexmap` before the walk got to the edge
# that fixes it, i.e. the script's own first mechanism stopped the second one from answering. The gate at the
# end of this file is what decides whether the lock may be committed, and it asks the SBF cargo directly, so a
# pin that cargo refuses is information, not a verdict — while "unreadable" stays fatal exactly where it has to
# be. Anything still refused *and* unfixed is what the gate's own error will name.
for r in $sbf_refused; do
  # About the list's own passes, not the walk's: if a later pass applied the same crate, the refusal was an
  # ordering artifact and the line is worth keeping — but a reader should be able to see that it took two tries.
  case "$sbf_applied" in *"${r%@*}"*) echo "sbf-readability: $r отклонено на раннем проходе и принято на позднем — порядок строк в списке намеренно ничего не решает" ;; esac
done

versions() { printf '%s\n' "$tree" | grep -oE "^$1 v[0-9][^ ]*" | sort -u; }
# lines, not words: each version is one `<crate> v<x.y.z>` pair, and `wc -w` on it said "2" for a single
# copy — a count that gates a commit has to count copies, not tokens.
count() { versions "$1" | sed '/^$/d' | wc -l | tr -d ' '; }
echo "== copies in the resolved graph"
for c in anchor-lang anchor-spl borsh solana-program; do
  printf '   %-16s %s version(s): %s\n' "$c" "$(count "$c")" "$(versions "$c" | tr '\n' ' ')"
done

# The invariant decidable from the version list: no anchor-lang outside the pinned line and kaigan's 0.32.
# "Exactly one copy" is not achievable here (mpl-core reaches kaigan, kaigan hard-requires ^0.32.1), and
# asserting the impossible turns a passing build into a red gate — the failure mode this file exists to
# avoid, which is how run 2 came to refuse a lock that was in fact fine.
line=$(printf '%s' "$want" | cut -d. -f1-2)   # "0.31"
copies=$(count anchor-lang)
stray=$(versions anchor-lang | sed '/^$/d' | grep -cEv "^anchor-lang v($line|0\\.32)\\." || true)
printf 'anchor-lang: %s copy/copies; %s outside the allowed lines (%s and 0.32)\n' "$copies" "${stray:-0}" "$line"
if [ "${stray:-1}" != "0" ]; then
  printf '::error::anchor-lang still resolves to a copy outside %s/0.32 — an unbounded `>=` found another major, which is the E0277 returning, so this lock is not worth committing\n' "$line"
  exit 1
fi
# Which copy the two crates that broke sit on — reported, not enforced. pythnet-sdk's `>=0.28.0` is
# legitimately satisfied by kaigan's 0.32 copy, and 0.32's borsh wiring is the same 0.10 release, so such a
# graph compiles even though a stricter assertion than the compiler's own would reject it. `cargo tree -i`
# draws a tree, so the box-drawing characters become newlines before matching: an anchored grep over that
# output finds nothing, and "nothing" here would have to be read as "the pin failed".
for c in pythnet-sdk switchboard-on-demand; do
  on=$(cargo tree -e normal,build -i "anchor-lang@$want" 2>/dev/null | tr -c 'a-zA-Z0-9 ._-' '\n' | grep -oE "$c v[0-9][^ ]*" | head -1 || true)
  printf '   %s: %s\n' "$c" "${on:-not under anchor-lang@$want (another copy satisfies its range — the check below decides)}"
done

echo "== proof: cargo check --workspace --all-targets"
# ── 3.5 The graph must be readable by the cargo that builds the .so ────────────────────
#
# Why this lives here and not only in the `programs` job: an unpinned edition-2024 dependency is a defect in
# the committed lockfile, and a green lock job next to a red `programs` leaves main carrying a lock that
# cannot build. `programs` cannot repair it — it does not write the lock — so the writer repairs it and the
# job keeps checking it (the same script, run again, is what goes red there when this pass could not).
#
# Why a pass rather than only the curated list above: `getrandom 0.3.4` was found by hand at 20:46 and
# `zeroize 1.9.0` sat in the same lockfile at the same moment — two members of one class, discovered one CI
# round apart. A list costs a round per member; the walk costs one run for the class. It also pins *up*
# instead of down: working from memory I wrote `zeroize 1.8.1`, while the registry's own `rust_version` field
# says 1.8.2 is the newest 1.8.x an SBF cargo 1.79 can read.
#
# Deliberately narrow: only a manifest this cargo cannot *parse* triggers a downgrade. A refusal to agree with
# `--locked` is not evidence about the on-chain build, and treating it as such would have this job edit the
# graph to satisfy a version check that does not decide the build (run 60 proved 1.79 refuses a 1.89-written
# lock for reasons that have nothing to do with the .so).
#
# Bounded at eight rounds: `cargo update --precise` can pull in a newer transitive child that is itself
# edition 2024, and an unbounded repair loop is how a CI job becomes a generator. Each round prints one
# `sbf-autopin:` line — that is the audit trail, and the summary line counts the steps.
sbf_cargo=""; sbf_ver=""
if [ -f scripts/ci-sbf-toolchain-check.sh ]; then
  probe=$(sh scripts/ci-sbf-toolchain-check.sh --probe "$root" 2>/dev/null | grep '^sbf-')
  sbf_cargo=$(printf '%s\n' "$probe" | sed -n 's/^sbf-cargo //p')
  sbf_ver=$(printf '%s\n' "$probe" | sed -n 's/^sbf-cargo-version //p')
fi
autopin_steps=0
if [ ! -f Cargo.lock ]; then
  echo "sbf-autopin: Cargo.lock ещё нет — спрашиваем после Materialize"
elif [ -z "$sbf_cargo" ] || [ -z "$sbf_ver" ]; then
  echo "sbf-autopin: SBF-cargo не найден — вопрос о читаемости манифестов здесь не задаётся"
else
  bound=${sbf_ver%.*}   # cargo 1.79.0 -> крайний rust_version, который он ещё читает: 1.79
  retries=8             # сколько раз за прогон разрешено трогать держателей рёбер, а не сам offender —
                        # 8, а не 3: run 24 showed the edition2024 problem is a *wave* (block-buffer 0.12
                        # <- digest 0.11 <- sha2 0.11, and the same for crypto-common/generic-array), so a
                        # budget of 3 was a guarantee of escalating mid-wave; rounds cap the work, this
                        # caps only the intrusive kind of move (someone else's range), and the re-check
                        # after each one is the oracle for whether it helped
  tried=""              # узлы, которым уже сказали «нет»: повторить отказ — это цикл, а не поиск
  # One pattern, used by holders_of both to skip and to *say what it skipped*: duplicated in two places it
  # would drift, and the second copy is the one that produces the log line people read.
  ho_exc="anchor-lang|anchor-spl|solana-[a-z0-9_-]*|chip_core|market|arena|staking|sb_mock"
  sawraw=$(mktemp)      # written iff some level ever saw raw holder edges — the "nobody holds it" claim needs it
  sawexc=$(mktemp)      # holders that exist but the policy forbids moving: named, not silently dropped
  treerr=$(mktemp)      # `cargo tree` failed — "not being able to ask" is not an answer about the graph
  echo "== SBF-readable-manifest pass (cargo $sbf_ver, крайний rust_version $bound)"
  round=1
  while [ "$round" -le 8 ]; do
    # Both streams into a file: cargo reports on stderr, but a capture that drops stdout (`$(cmd 2>&1
    # >/dev/null)`, the shape this line had) means a tool that ever prints its error on stdout is read as
    # "refused for an unknown reason" — and this loop's whole decision hangs on that text.
    err=$(mktemp)
    "$sbf_cargo" metadata --format-version 1 >"$err" 2>&1; rc=$?
    if [ $rc -eq 0 ]; then
      rm -f "$err"
      if [ "$autopin_steps" -gt 0 ]; then
        echo "sbf-autopin: граф читается SBF-тулчейном после $autopin_steps шаг(ов) вниз"
      else
        echo "sbf-autopin: граф уже читается SBF-тулчейном — не трогаем"
      fi
      break
    fi
    # Cargo names the offending manifest as .../registry/src/<hash>/<crate>-<version>/Cargo.toml — its own
    # wording is the anchor, because "we could not read it" without the name is not a thing a log can act on.
    bad=$(sed -n 's|.*/\([A-Za-z0-9._-]*\)-\([0-9][0-9a-zA-Z.+-]*\)/Cargo.toml.*|\1 \2|p' "$err" | head -1)
    if [ -z "$bad" ]; then
      echo "sbf-autopin: cargo $sbf_ver отказал, но не на разборе манифеста — ничего не пиним; начало отказа:"
      # $err is a *file*, and the first draft quoted "$err" itself, so the log printed the temp filename where
      # cargo's message belonged — a two-line note that tells the reader nothing and costs a round to notice.
      # Prefer cargo's own error lines; fall back to the head of the output when even those are absent.
      grep -E 'error|Caused by' "$err" | head -4 | sed 's/^/  /'
      grep -qE 'error|Caused by' "$err" || head -4 "$err" | sed 's/^/  /'
      rm -f "$err"
      break
    fi
    set -- $bad
    name=$1; over=$2
    # SBFPINS lines are `<crate> <version-line> <pin>` — the *line*, e.g. `zeroize 1.9 1.8.2`, matched as
    # `^$crate v$line\.[0-9]`. Quoting the offender's full version back into that advice would produce
    # `zeroize 1.9.0 1.8.2`, a line the list's own grep cannot see: the instruction would read as followed
    # and do nothing.
    line=$(printf '%s' "$over" | cut -d. -f1,2)
    [ "$(printf '%s' "$over" | cut -d. -f1)" = "0" ] || line=$(printf '%s' "$over" | cut -d. -f1)
    moved=""; holders=""
    pick=$(newest_readable "$name" "$bound" "$over"); prc=$?
    tier=strict; case "$pick" in *\ wide) pick=${pick% wide}; tier=wide ;; esac
    if [ "$prc" -eq 2 ]; then
      # The distinction the whole block is built on: an unreadable index is not evidence about the crate.
      # ${upd:-}, not $upd: this branch runs before the offender's temp file is created, and under
      # `set -u` an unset parameter here would abort the script with a shell error instead of printing
      # the one sentence this branch exists to print.
      rm -f "$err" "${upd:-}"
      echo "::error title=sbf-autopin::индекс crates.io не прочитан для $name (сеть/404) — шаг не может выбрать версию, и это не значит, что её нет. Если $over реально нужна в графе, зафиксируйте строкой \"$name $line <подходящая>\" в SBFPINS; иначе — перезапустите lockfile.yml"
      break
    fi
    # The repo's cargo, never the SBF one, does the writing — for both tiers of the move. Asking a cargo that
    # cannot read part of this graph to re-resolve it produces a refusal meaning "I could not read the answer",
    # indistinguishable from "the graph forbids it", and every branch below keys on that difference. The SBF
    # cargo's role is one-directional: it is the oracle that says whether the result is readable, nothing more.
    # (The lockfile's format is not a concern: main already carried a `version = 4` lock written by 1.89, and
    # run 61 shows the image's 1.79 getting past it to the manifests — the only thing it has to do.)
    upd=$(mktemp)
    if [ -n "$pick" ]; then
      echo "sbf-autopin: $name $over -> $pick (rust_version <= $bound, строка $line, ярус $tier)"
      if cargo update -p "$name@$over" --precise "$pick" >"$upd" 2>&1; then
        moved=yes
      else
        # cargo's own first error line, quoted: "the requirement is narrower than the version we offered" and
        # "the package does not exist" read identically after the fact, and only one of them is a hint to go
        # looking at the dependents.
        echo "sbf-autopin:   отказ: $(grep -m1 -E '^(error|warning)' "$upd" | cut -c1-220 || true)"
      fi
    fi
    # Nothing readable exists in the offender's own line, or the move was refused: some dependent is holding
    # the requirement. Ask the repo's cargo who pulls this crate in (it can read every manifest here, which is
    # the point of asking it instead of the SBF one) and try moving each holder down its own line. This is the
    # trick that fixed the anchor-lang graph — `cargo update -p pythnet-sdk/anchor-lang --precise`, an edge
    # rather than a crate. The loop's own re-check is the judge: if the move does not remove the offender, the
    # next round says so and the next holder gets its turn; every attempt is a strict downgrade, so progress
    # is monotone and `retries` is a belt, not a brake.
    if [ -z "$moved" ] && [ "$retries" -gt 0 ]; then
      echo "sbf-autopin: у $name $over не чинится изнутри строки — иду по рёбрам вверх"
      # Bounded breadth-first over the inverted tree, two levels past the offender. Run 23 proved one level is
      # not enough and told us why: block-buffer 0.12 is required by digest 0.11, which is required by sha2
      # 0.11, and each of those *can* accept an older version while the level above it forbids it. A search
      # that stops at the first holder answers "no move exists" about a graph where a move exists two edges up
      # — the same class of wrong-but-confident report this file has been fixing all evening.
      #
      # The budget is what makes it safe rather than exploratory: 24 nodes, depth 2, one accepted move per
      # round, and after it the whole graph is re-checked by the SBF cargo (the loop's own oracle), so a move
      # that fixes nothing is caught by the next round and the next refusal is quoted. Nodes are never retried
      # across levels, because `tried` outlives the round: the same refusal twice is a loop, not a search.
      queue=$(holders_of "$name" "$over")
      level=0
      nodes=0
      while [ "$level" -le 2 ] && [ -n "$queue" ] && [ -z "$moved" ]; do
        nxt=""
        while IFS= read -r h; do
          hn=$(printf '%s' "$h" | cut -d' ' -f1); hv=$(printf '%s' "$h" | sed 's/^[^ ]* v//')
          [ -n "$hn" ] || continue
          nodes=$((nodes+1))
          [ "$nodes" -le 24 ] || break
          case " $tried " in *" $hn "*) continue ;; esac
          tried="$tried $hn"
          hpick=$(newest_readable "$hn" "$bound" "$hv"); hrc=$?
          hpick=${hpick% wide}
          if [ -z "$hpick" ]; then
            [ "$hrc" = 2 ] && echo "sbf-autopin:     $hn: индекс не прочитан — пропускаю"
            continue
          fi
          echo "sbf-autopin:   [$level] пробую: $hn $hv -> $hpick"
          if cargo update -p "$hn@$hv" --precise "$hpick" >"$upd" 2>&1; then
            retries=$((retries-1)); moved=yes
            echo "sbf-autopin: $hn понижен до $hpick — перепроверяю граф"
            break
          fi
          echo "sbf-autopin:     отказ: $(grep -m1 -E '^(error|warning)' "$upd" | cut -c1-220 || true)"
          nh=$(holders_of "$hn" "$hv" | grep -v "^$name v")
          [ -n "$nh" ] && nxt="$nxt
$nh"
        done <<QUEUE
$(printf '%s\n' "$queue")
QUEUE
        queue=$(printf '%s\n' "$nxt" | sed '/^$/d' | awk '!s[$0]++' | head -12)
        level=$((level+1))
      done
    fi
    if [ -z "$moved" ]; then
      rm -f "$err"
      # Three endings, three different pieces of work, and one sentence must not stand in for another. Run 23
      # taught the first split (a readable version exists and cargo refused the move vs none exists, so the
      # work is at the dependents); run 25 taught the second: an empty holder list means nothing by itself —
      # it has to say whether the graph had no edges here at all, or edges this search is not allowed to move.
      if [ -z "$pick" ]; then
        echo "::error title=sbf-autopin::cargo $sbf_ver (SBF-тулчейн образа) не читает манифест $name $over, и в реестре нет ни одной версии строки $line ниже $over с rust_version <= $bound — значит понижать надо не $name, а того, кто требует $over; держатели и то, кого поиск не трогает, перечислены строками выше"
      elif [ -s "$treerr" ]; then
        echo "::error title=sbf-autopin::$name@$over не читается cargo $sbf_ver, а кто её требует — неизвестно: \`cargo tree -i\` ответила ошибкой (строки выше). пока граф держателей не виден, понижение выбирать нечем; посмотри \`cargo tree -i $name@$over\` вручную"
      elif [ -s "$sawexc" ]; then
        echo "::error title=sbf-autopin::читаемая версия $name существует ($pick, rust_version <= $bound), но требуют её только $(awk '!s[$0]++' "$sawexc" | tr '\n' ' ' | sed 's/ $//') — те, кого этот поиск понижать не вправе (платформа, фреймворк, наши кра́ты). значит решать человеку: строка \"<держатель> <строка> <пин>\" в SBFPINS или диапазон в наших Cargo.toml"
      elif [ ! -s "$sawraw" ]; then
        echo "::error title=sbf-autopin::у $name@$over нет ни одного normal/build держателя в графе, поэтому понижать нечего — либо это dev/optional-ребро (смотри \`cargo tree -i $name@$over --target all\`), либо $name стоит прявой зависимостью в наших манифестах, и тогда править надо их, а не лок"
      else
        echo "::error title=sbf-autopin::читаемая версия $name существует ($pick, rust_version <= $bound), но cargo отказалась принять её и для $name@$over, и для держателей, которые поиску трогать разрешено (${tried# } ) — блокируют их диапазоны в манифестах; либо понижайте держателя через SBFPINS строкой \"<держатель> <строка> <пин>\" так, чтобы его требование допускало $pick, либо поднимайте SBF-cargo (Anchor.toml: solana_version)"
      fi
      rm -f "$upd" "$sawraw" "$sawexc" "$treerr"
      break
    fi
    rm -f "$upd"
    rm -f "$err"
    autopin_steps=$((autopin_steps+1))
    round=$((round+1))
  done
  if [ "$round" -gt 8 ]; then
    echo "::error title=sbf-autopin::восемь шагов вниз не сделали граф читаемым для cargo $sbf_ver — см. строки sbf-autopin выше и список SBFPINS"
  fi
fi

if ! cargo check --workspace --all-targets; then
  echo "::error::the pinned graph does not compile — refusing to commit this Cargo.lock. The log says which crate; if it is the pyth/mpl borsh bound again, the fix is a version choice in this script or in programs/*/Cargo.toml, not an annotation in the programs."
  exit 1
fi


# The full picture, asked of the lock instead of of cargo. `cargo metadata` stops at the first manifest it
# cannot parse, so the round loop above can only ever see one offender at a time — fine while it fixes what it
# finds, expensive the moment it cannot: with a wave (run 24: block-buffer, digest, sha2; run 25: wincode and
# whoever holds it) one CI round-trip per crate is days of them, and the repo's chosen answer to this class is
# a curated pin list, which cannot be written from a one-item-at-a-time oracle.
#
# So the audit reads what is already on disk — Cargo.lock lists every (name, version) pair in the graph — and
# asks the index for each crate's declared rust_version. No cargo is consulted: the SBF cargo is precisely the
# one that cannot read these manifests, and the repo cargo's opinion is not the question. Holders come from
# the lock's own dependency edges, and the range each one declares from its index record, which is what turns
# "cargo refused" into "solana-address 2.7.0 requires ^0.6, so the pin has to move solana-address".
#
# Cost is one index fetch per crate, cached; it runs only on the path that is already about to fail, so a
# green lock costs nothing extra.
audit_unreadable() { # <lock> <bound>
  _au_pairs=$(awk '
    /^name = /    { n=$0; gsub(/^[^"]*"/,"",n); gsub(/".*/,"",n) }
    /^version = / { v=$0; gsub(/^[^"]*"/,"",v); gsub(/".*/,"",v); if (n != "") { print n " " v; n="" } }
  ' "$1")
  _au_n=0; _au_unknown=0
  _au_report=""
  while read -r a_n a_v; do
    [ -n "$a_n" ] || continue
    _au_msrv=$(msrv_of "$a_n" "$a_v"); _au_rc=$?
    if [ "$_au_rc" -ne 0 ]; then
      # Nothing known is not nothing wrong: this crate stays out of the offender list and into a counter, and
      # the log says the count, so a reader can tell "the graph is readable" from "we could not look".
      _au_unknown=$((_au_unknown+1))
      continue
    fi
    ver_gt "$_au_msrv" "$2" || continue
    _au_n=$((_au_n+1))
    _au_line=$(printf '%s' "$a_v" | cut -d. -f1,2)
    [ "$(printf '%s' "$a_v" | cut -d. -f1)" = "0" ] || _au_line=$(printf '%s' "$a_v" | cut -d. -f1)
    _au_holders=$(awk -v want="$a_n" -v wv="$a_v" '
      /^\[\[package\]\]/ { if (bn != "" && hit) print bn " " bv; bn=""; bv=""; hit=0; next }
      /^name = /    { s=$0; gsub(/^[^"]*"/,"",s); gsub(/".*/,"",s); bn=s }
      /^version = / { s=$0; gsub(/^[^"]*"/,"",s); gsub(/".*/,"",s); bv=s }
      /^ "/          { l=$0; gsub(/^ *"/,"",l); gsub(/",?$/,"",l); split(l,x," ");
                       if (x[1] == want && (x[2] == wv || x[2] == "")) hit=1 }
      END { if (bn != "" && hit) print bn " " bv }
    ' "$1")
    _au_pick=$(newest_readable "$a_n" "$2" "$a_v"); _au_prc=$?
    _au_tier=within-line; case "$_au_pick" in *\ wide) _au_pick=${_au_pick% wide}; _au_tier=cross-line ;; esac
    printf 'audit: %s %s требует rust_version %s (> %s)\n' "$a_n" "$a_v" "$_au_msrv" "$2"
    if [ -n "$_au_holders" ]; then
      while read -r h_n h_v; do
        [ -n "$h_n" ] || continue
        printf '       ← %s %s (требует "%s")\n' "$h_n" "$h_v" "$(req_of "$h_n" "$h_v" "$a_n" || true)"
      done <<EOF
$_au_holders
EOF
    else
      printf '       ← держателей в локе нет: крат стоит прявым требованием в наших манифестах\n'
    fi
    if [ "$_au_prc" -eq 0 ] && [ -n "$_au_pick" ]; then
      # A cross-line pick is a real option and a different risk from a within-line one: it only lands if no
      # dependent holds the line, which is exactly what the holder lines above say. Marking the difference is
      # what keeps the suggestion from being pasted into SBFPINS and reported as "the script ignored it".
      printf '       пин в SBFPINS (%s): "%s %s %s"\n' "$_au_tier" "$a_n" "$_au_line" "$_au_pick"
    else
      printf '       в строке %s понижать нечем — двигать держателя: "<держатель> <строка> <версия>"\n' "$_au_line"
    fi
  done <<EOF
$_au_pairs
EOF
  if [ "$_au_n" -eq 0 ] && [ "$_au_unknown" -eq 0 ]; then
    echo "::notice title=sbf-audit::в локе нет ни одного манифеста с rust_version > $2 — отказ cargo выше про что-то другое (не про edition)"
  else
    printf '::error title=sbf-audit::%s нечитаемых манифеста(ов) для cargo %s, ещё %s крат(ов) — индекс не прочитан, про них ничего не известно. Ниже каждый с держателями и готовыми строками в SBFPINS — это полная картина за один прогон, а не по одному на круг.\n' "$_au_n" "$2" "$_au_unknown"
  fi
  return 0
}

# Then the gate `programs` runs, on the graph this pass just produced (its own `--locked` reading, so a stale
# lock cannot be committed). A green `cargo check` above is cargo 1.89's opinion; the opinion that has to live
# with this lockfile is the SBF toolchain's, so both are required before the commit.
if [ -f scripts/ci-sbf-toolchain-check.sh ]; then
  sbf_out=$(sh scripts/ci-sbf-toolchain-check.sh "$root" 2>&1); sbf_rc=$?
  printf '%s\n' "$sbf_out"
  case "$sbf_rc" in
    0) ;;
    # Not being able to ask is not the same as being told no: a workstation run has no solana on PATH, and
    # that must not read as a broken graph. `programs` asks the same question in the image that builds.
    2) echo "::warning::the SBF cargo is not in this environment, so the lock is committed unproven against it" ;;
    *) echo "::error::refusing to commit a Cargo.lock the SBF cargo cannot read — SBFPINS and the pass above are where that is fixed"
       # The gate's own error names one crate, because cargo's parser stops at the first unreadable manifest.
       # The audit turns that into the list the pin policy is actually written from.
       if [ -f Cargo.lock ]; then
           # The bound is the walk's if it ran; when it did not (no SBF cargo found, or an empty lock), take it
         # from the version banner the check printed — and if neither is available, say nothing rather than
         # auditing against an invented number.
         audit_bound=${bound:-}
         [ -n "$audit_bound" ] || audit_bound=$(printf '%s' "${sbf_ver:-}" | grep -oE '[0-9]+\.[0-9]+' | head -1)
         if [ -n "$audit_bound" ]; then audit_unreadable Cargo.lock "$audit_bound"; fi
       fi
       exit 1 ;;
  esac
fi

if ! grep -q '^name = "anchor-lang"' Cargo.lock; then
  echo "::error::no Cargo.lock with an anchor-lang entry — generate-lockfile wrote something unexpected"
  exit 1
fi

bytes=$(wc -c < Cargo.lock | tr -d ' ')
packages=$(grep -c '^name = ' Cargo.lock | tr -d ' ')
echo "ready: Cargo.lock ($bytes bytes, $packages packages, anchor-lang $want)"
# The workflow step emits the outputs from its own lines; this file is how it learns what was decided, and
# the fallback in the step is what makes "the script died before writing it" a different answer from
# "the script decided there is nothing to say".
summary="anchor-lang $want, $packages packages, $bytes bytes"
[ "$autopin_steps" -eq 0 ] || summary="$summary, sbf-autopin $autopin_steps"
printf '%s\n' "$summary" > "${LOCK_SUMMARY:-/tmp/cargo-lock.summary}"
