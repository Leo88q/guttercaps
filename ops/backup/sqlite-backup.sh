#!/bin/sh
# Hourly SQLite backup for the compose deploy (docs/09 §4.3, runbook.md §4).
#
# Why not litestream: litestream streams Postgres WAL. The read-model is SQLite, so the correct
# primitive is `sqlite3 .backup`, which reads through the connection and therefore cannot copy a
# half-written database (a naive `cp` of a WAL-mode db can). We also run `PRAGMA integrity_check` on
# the copy: a backup that fails to open is not a backup, and finding that out during an incident is
# the most expensive way to learn it.
#
# SEC-B49: "the ALERT line is in the container log" is not monitoring. This script now writes a status
# file next to the snapshots (`BACKUP_STATUS_FILE`, atomically, on every attempt, success or failure),
# the API scrapes it into `backup_last_success_timestamp_seconds` / `backup_consecutive_failures` /
# `backup_last_result_ok`, and `ops/monitoring/alerts.yml` alerts on it (`BackupStale`, `BackupFailing`).
# The failure paths below also stopped lying to each other: a `.backup` that never produced a file used
# to be reported as `integrity_check FAILED` (the one line an operator greps for, pointing at corruption
# that is not there), and the same failure under `RUN_ONCE=1` produced no ALERT line at all, because
# `one || echo …` suppresses `set -e` inside the function. Both paths now say what happened.
#
# SEC-B47: the output directory is inside the repository working tree (compose bind-mounts `./backup`),
# so `.gitignore` has to ignore it — `.sqlite` does not match `.sqlite.gz`. See the ignore block in
# `.gitignore` and the rule in `tests/security/deploy-artifacts.test.ts`.
#
# S3 upload is optional (BACKUP_S3_URI=s3://bucket/prefix). It uses `aws` if present and otherwise
# logs one WARN and keeps writing locally, so a missing credential never stops the local snapshot.
set -eu
# SEC-B49: the copy is a full dump of production data (wallets, IP networks, device hashes, payment
# rows). Without this it is created with the image's default umask (022 → world-readable) and only
# chmod-ed *after* gzip, i.e. the raw database sits readable in the host directory for the whole
# snapshot window — and `.CORRUPT` files, which are kept for forensics, were never chmod-ed at all.
umask 077

DB_PATH="${DB_PATH:-/data/guttercaps.sqlite}"
OUT_DIR="${OUT_DIR:-/backup/out}"
KEEP="${BACKUP_KEEP:-72}"                                   # 72 × hourly = 3 days on-host
KEEP_CORRUPT="${BACKUP_KEEP_CORRUPT:-3}"                    # bounded: forensic copies, not a graveyard
INTERVAL="${BACKUP_INTERVAL_S:-3600}"
S3_URI="${BACKUP_S3_URI:-}"
STATUS_FILE="${BACKUP_STATUS_FILE:-$OUT_DIR/status}"

mkdir -p "$OUT_DIR"
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "ALERT sqlite3 not installed in the backup image — no snapshot is being taken" >&2
  exit 1
fi

# Previous state, so a failure does not erase the last time a snapshot *did* work (the alert reads that
# timestamp; resetting it to 0 on every restart would make the alert fire on a healthy deployment).
prev_success=0
prev_failures=0
if [ -f "$STATUS_FILE" ]; then
  prev_success=$(sed -n 's/^last_success_ts=//p' "$STATUS_FILE" | head -1)
  prev_failures=$(sed -n 's/^consecutive_failures=//p' "$STATUS_FILE" | head -1)
  case "$prev_success" in ''|*[!0-9]*) prev_success=0 ;; esac
  case "$prev_failures" in ''|*[!0-9]*) prev_failures=0 ;; esac
fi

# `last_attempt_ts`, `last_success_ts`, `last_result`, `consecutive_failures`. Written to a temp file and
# renamed, so a scrape can never read a half-written line (the API reads it three times per /metrics).
write_status() {
  _result=$1
  _success=$2
  _failures=$3
  _tmp="$STATUS_FILE.tmp.$$"
  {
    echo "last_attempt_ts=$(date -u +%s)"
    echo "last_success_ts=$_success"
    echo "last_result=$_result"
    echo "consecutive_failures=$_failures"
  } > "$_tmp"
  mv "$_tmp" "$STATUS_FILE"
}

# Newest-first pruning of one glob, keeping `$1` files. Plain `ls -t` is enough here: the names are
# ours (`guttercaps-<ts>.sqlite[.gz|.CORRUPT]`), one per run, and `-1` keeps it one-per-line.
prune() {
  keep=$1
  pattern=$2
  [ "$keep" -gt 0 ] 2>/dev/null || keep=0
  # `ls | sort -r | tail` rather than `find -maxdepth`: busybox (alpine) find and GNU find agree on `-name`,
  # not on everything else, and the names are ours and one per run, so a glob sorted newest-first is exact.
  ls -1 "$OUT_DIR"/$pattern 2>/dev/null | sort -r | tail -n "+$((keep + 1))" | while read -r f; do rm -f "$f"; done
}

one() {
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  # SEC-B48: the name carries the pid *unconditionally*. Two snapshots inside one second are not a
  # theoretical case — `npm run ops:backup-now` runs `exec` inside the same container as the hourly loop,
  # so the tick can fire while the operator's manual snapshot is in flight. With a shared timestamped name
  # the two runs overwrite each other's temp file, and the losers report the wrong thing: the slower run
  # `gzip`s a file the faster one already removed (`ALERT backup compression failed`), or runs
  # `PRAGMA integrity_check` on a missing file and reports `integrity_check FAILED` plus a `.CORRUPT` that
  # never existed — the same "blame corruption" failure as above, one layer down. A name per process means
  # neither run can disturb the other: two snapshots in the same second are a duplicated snapshot, not a
  # fault, and the retention keeps both. (Guessing uniqueness from `[ -e "$tmp" ]` is a TOCTOU check — both
  # runs test before either creates the file, which is exactly how this was reproduced.)
  tmp="$OUT_DIR/guttercaps-$ts-$$.sqlite"
  # `.backup` on a source URL: consistent even while the API is writing. Failure is handled here rather
  # than left to `set -e`: this function is called as `one || echo …` from the loop, which disables
  # errexit inside it (POSIX), so an unchecked failure used to fall through to the integrity check.
  if ! sqlite3 "file:$DB_PATH?mode=ro&immutable=0" ".backup '$tmp'"; then
    echo "ALERT backup snapshot failed: sqlite3 .backup could not read $DB_PATH" >&2
    write_status backup_failed "$prev_success" "$((prev_failures + 1))"
    return 1
  fi
  if [ ! -s "$tmp" ]; then
    # A zero-byte or missing destination is a failed snapshot, not a corrupt database — and an empty
    # `.CORRUPT` file in the retention list is noise an operator has to triage.
    echo "ALERT backup snapshot failed: $tmp was not written" >&2
    rm -f "$tmp"
    write_status backup_failed "$prev_success" "$((prev_failures + 1))"
    return 1
  fi
  ok=$(sqlite3 "$tmp" "PRAGMA integrity_check;" 2>&1 | head -1)
  if [ "$ok" != "ok" ]; then
    echo "ALERT backup integrity_check FAILED for $tmp: $ok" >&2
    mv "$tmp" "$tmp.CORRUPT"
    chmod 0640 "$tmp.CORRUPT" 2>/dev/null || true
    write_status integrity_failed "$prev_success" "$((prev_failures + 1))"
    prune "$KEEP_CORRUPT" '*.sqlite.CORRUPT'
    return 1
  fi
  if ! gzip -9 "$tmp"; then
    echo "ALERT backup compression failed for $tmp" >&2
    rm -f "$tmp"
    write_status backup_failed "$prev_success" "$((prev_failures + 1))"
    return 1
  fi
  chmod 0640 "$tmp.gz"
  size=$(wc -c < "$tmp.gz")
  echo "backup $(basename "$tmp.gz") ok ($size bytes)"
  write_status ok "$(date -u +%s)" 0
  prev_success=$(date -u +%s)
  prev_failures=0
  if [ -n "$S3_URI" ] && command -v aws >/dev/null 2>&1; then
    if aws s3 cp "$tmp.gz" "$S3_URI/guttercaps-$ts.sqlite.gz" --only-show-errors >/dev/null 2>&1; then
      echo "uploaded to $S3_URI"
    else
      # The local snapshot is the backup; this line is about the off-host copy.
      echo "ALERT s3 upload failed (local copy kept)" >&2
    fi
  elif [ -n "$S3_URI" ]; then
    echo "WARN BACKUP_S3_URI set but aws-cli is missing — local-only backups" >&2
  fi
  # Retention applies to the local dir only; the S3 lifecycle is the bucket's business (documented).
  prune "$KEEP" '*.sqlite.gz'
  return 0
}

# `--once` exists so the script can be invoked directly (`sh sqlite-backup.sh --once`); the compose
# command uses `RUN_ONCE=1` because `docker compose exec` cannot pass arguments to an ENTRYPOINT.
if [ "${RUN_ONCE:-0}" = "1" ] || [ "${1:-}" = "--once" ]; then one; exit $?; fi

echo "backup loop: every ${INTERVAL}s, keeping $KEEP snapshots (+$KEEP_CORRUPT corrupt) in $OUT_DIR (db $DB_PATH, status $STATUS_FILE)"
while :; do
  # A failed snapshot must not kill the loop; the next hour tries again, the status file is what the
  # alert reads, and the ALERT line is what the human reads.
  one || echo "WARN backup attempt failed; retrying in ${INTERVAL}s" >&2
  sleep "$INTERVAL"
done
