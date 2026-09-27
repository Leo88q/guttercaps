// Backup freshness, read from the file the backup sidecar writes (ops/backup/sqlite-backup.sh, SEC-B49).
//
// The sidecar's only other output is a line in `docker logs backup` — the exact shape this repo calls a
// dead alert: a service that is running, healthy and silent while taking nothing, until the day a
// snapshot is needed. So the script writes `last_attempt_ts`, `last_success_ts`, `last_result` and
// `consecutive_failures` next to the snapshots (atomically — temp file + rename, because `/metrics` reads
// it three times per scrape), and this module turns that into the three series `alerts.yml` queries.
//
// The file is *not* a security boundary: it lives on the host in the deploy's own directory, is mounted
// read-only into the API, and carries no secret. It is parsed defensively anyway — a truncated or
// hand-edited file must produce a wrong number, never an exception inside a scrape (the metrics layer
// would turn that into `metrics_scrape_error`, which hides the very staleness we are watching for).
import { readFileSync } from 'node:fs';

/** One parsed status file. `unknown` = configured but no attempt has been recorded yet. */
export interface BackupStatus {
  /** Epoch seconds of the last attempt of any kind; 0 when no attempt is recorded. */
  lastAttempt: number;
  /** Epoch seconds of the last *successful* snapshot; 0 when none is recorded (the alert reads this). */
  lastSuccess: number;
  /** Consecutive failed attempts; 0 on success and on an unreadable file. */
  consecutiveFailures: number;
  /** `ok` | `backup_failed` | `integrity_failed` | `unknown` (nothing recorded yet). */
  lastResult: 'ok' | 'backup_failed' | 'integrity_failed' | 'unknown';
}

const ZERO: BackupStatus = { lastAttempt: 0, lastSuccess: 0, consecutiveFailures: 0, lastResult: 'unknown' };

const RESULTS = new Set(['ok', 'backup_failed', 'integrity_failed']);
/** A timestamp that is not a plausible epoch second (typo, a truncated write, `NaN`) is reported as 0. */
const epoch = (raw: string | undefined): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n < 4_102_444_800 ? Math.floor(n) : 0; // < 2100-01-01
};
const count = (raw: string | undefined): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/** `key=value` lines, the only shape `write_status` in the script emits. */
export function parseBackupStatus(text: string): BackupStatus {
  const kv = new Map<string, string>();
  for (const line of text.split('\n')) {
    const at = line.indexOf('=');
    if (at <= 0) continue;
    kv.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  const result = kv.get('last_result') ?? '';
  return {
    lastAttempt: epoch(kv.get('last_attempt_ts')),
    lastSuccess: epoch(kv.get('last_success_ts')),
    consecutiveFailures: count(kv.get('consecutive_failures')),
    lastResult: RESULTS.has(result) ? (result as BackupStatus['lastResult']) : 'unknown',
  };
}

/**
 * `undefined` when `BACKUP_STATUS_FILE` is unset — i.e. a deployment without the backup sidecar exports no
 * `backup_*` series at all (the same "only where configured" rule `event_bus_redis` follows, so an alert
 * cannot fire on a topology that never claimed to have backups). A configured path whose file is missing
 * or unreadable yields zeroes: "configured, nothing has ever succeeded" is a state the alert must see.
 */
export function readBackupStatus(file = process.env.BACKUP_STATUS_FILE): BackupStatus | undefined {
  if (!file) return undefined;
  try {
    return parseBackupStatus(readFileSync(file, 'utf8'));
  } catch {
    return { ...ZERO };
  }
}
