// Deploy-surface gate (SEC-B47, SEC-B48, SEC-B50, SECURITY-AUDIT-2026-09-26.md).
//
// The three findings this file exists for are all "the artifact is correct, the thing that consumes it
// is not":
//
//   * SEC-B47 — the backup sidecar writes `ops/backup/out/*.sqlite.gz` into the repository working tree
//     (compose bind-mounts `./backup`), and `.gitignore` ignored `*.sqlite` but not `*.sqlite.gz` or
//     `.CORRUPT`. One `git add -A` during an incident commits a gzip of production data — wallets, IP
//     networks, device hashes, payment rows — to a public repo. The rule below is the first one in the
//     repository that fails when a *runtime-written* path becomes addable: it asks `git check-ignore`
//     itself, so it cannot drift from the real ignore rules the way a second glob list would.
//   * SEC-B48 — the same script reported a failed `.backup` (no file at all) as
//     `ALERT … integrity_check FAILED`, the one line an operator greps for when they suspect corruption,
//     and under `RUN_ONCE=1` (what `npm run ops:backup-now` invokes) the same failure printed nothing at
//     all, because `one || echo …` disables `set -e` inside the function. Both halves are pinned here: the
//     script must record every outcome, and the failure paths must say what failed.
//   * SEC-B50 — every action was referenced by a moving tag (`actions/checkout@v4`), in a repository that
//     pins npm versions by `sha512`, base images by patch tag and Cargo deps to exact versions. A tag is a
//     ref the action's owner can move to any commit they like, including one that reads `GITHUB_TOKEN` and
//     the deploy secrets; that is the shape of the `tj-actions/changed-files` compromise.
//
// Every rule has a mutation at the bottom: a gate nobody has seen fail is a comment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');

const WORKFLOWS = readdirSync(join(REPO, '.github', 'workflows')).filter((f) => f.endsWith('.yml')).sort();
const BACKUP = read('ops/backup/sqlite-backup.sh');
const COMPOSE = read('ops/deploy/docker-compose.yaml');
const GITIGNORE = read('.gitignore');

/**
 * Uniqueness of the snapshot name, as a predicate: per *process* (the pid is in the name) and never guessed
 * with an existence test. `[ -e "$tmp" ]` is a TOCTOU check — two runs in the same second each test before
 * either creates the file, then share it: reproduced by running `--once` twice concurrently, where the
 * slower run `gzip`s a file the faster one already removed (`ALERT backup compression failed`) or runs
 * `PRAGMA integrity_check` on a missing file and reports `integrity_check FAILED` with a `.CORRUPT` that
 * does not exist. `ops:backup-now` runs inside the same container as the hourly loop, so that collision is
 * a manual command racing the tick, not a thought experiment.
 */
const uniqueSnapshotName = (sh: string): boolean =>
  (() => { const code = sh.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    return /tmp="\$OUT_DIR\/guttercaps-\$ts-\$\$\.sqlite"/.test(code) && !/\[ -e "\$tmp" \]/.test(code); })();

/** Would `git add -A` stage this path? The same question git asks, from the real ignore rules. */
const wouldAdd = (path: string): boolean => {
  const r = spawnSync('git', ['check-ignore', '-q', '--no-index', path], { cwd: REPO });
  return r.status !== 0;
};

// --------------------------------------------------------------------------- SEC-B47

test('SEC-B47 the backup output directory is not committable, and it is where the deploy actually writes', () => {
  // The names the script can produce, in the shapes it produces them (timestamp, same-second `-pid`,
  // corrupt, and the status file with its temp sibling).
  const produced = [
    'ops/deploy/backup/out/guttercaps-20260927T101112Z.sqlite.gz',
    'ops/deploy/backup/out/guttercaps-20260927T101112Z-4242.sqlite.gz',
    'ops/deploy/backup/out/guttercaps-20260927T101112Z.sqlite.CORRUPT',
    'ops/deploy/backup/out/status',
    'ops/deploy/backup/out/status.tmp.4242',
    // an operator who set OUT_DIR=/backup (the directory itself, not the default `out/`)
    'ops/deploy/backup/guttercaps-20260927T101112Z.sqlite.gz',
  ];
  for (const p of produced) {
    assert.equal(wouldAdd(p), false, `${p} would be staged by a \`git add -A\` — a production snapshot is one keystroke from the public repo`);
  }
  // …and the rule must not swallow the placeholder that *is* meant to be tracked, or the directory
  // disappears for everyone who clones (compose binds it, and a bind-mount of a missing directory is
  // created root-owned, which then breaks the next `npm run ops:backup-now`).
  assert.equal(wouldAdd('ops/deploy/backup/.gitkeep'), true, '.gitkeep must stay tracked');
  // The gate is only meaningful if the paths it names are the ones the deploy uses.
  assert.match(COMPOSE, /\.\/backup:\/backup-status:ro/, 'compose must bind-mount the snapshot directory');
  assert.match(BACKUP, /OUT_DIR="\$\{OUT_DIR:-\/backup\/out\}"/, 'the script default must be the compose path');
  assert.ok(GITIGNORE.includes('ops/deploy/backup/**'), '.gitignore must cover the whole directory, not only the default `out/`');
  // The one rule that was there (`*.sqlite`) matches neither `.sqlite.gz` nor `.CORRUPT`: recorded here so a
  // future "simplification" cannot quietly return the file to its pre-fix state.
  assert.ok(GITIGNORE.includes('# ── Ops output that lives inside the tree by design (SEC-B47)'), 'the ignore block carries its reason');
});

// --------------------------------------------------------------------------- SEC-B48

test('SEC-B48 a failed snapshot says what failed, and every attempt leaves a status file', () => {
  // (a) a status line for each of the three outcomes — the alert distinguishes "nothing was taken" from
  //     "what was taken is corrupt", and they need different answers
  for (const result of ['ok', 'backup_failed', 'integrity_failed']) {
    assert.ok(BACKUP.includes(`write_status ${result} `), `the script must record \`${result}\``);
  }
  // (b) "no file was produced" is not an integrity failure, and it must not be reported as one
  const snapshotFail = BACKUP.indexOf('ALERT backup snapshot failed');
  const integrity = BACKUP.indexOf('ALERT backup integrity_check FAILED');
  assert.ok(snapshotFail >= 0 && integrity > snapshotFail, 'the snapshot-failure path must exist and be checked first');
  assert.match(BACKUP, /if ! sqlite3 "file:\$DB_PATH\?mode=ro&immutable=0" "\.backup '\$tmp'"; then/, 'the `.backup` exit status must be checked, not left to a `set -e` that `one || echo` disables');
  // (c) the status write is atomic — a scrape reads the file three times, and a half-written line is a wrong
  //     number from a correct deployment
  assert.match(BACKUP, /mv "\$_tmp" "\$STATUS_FILE"/, 'status must be written to a temp file and renamed');
  // (d) the "take a snapshot now" path must report failure through its exit code *and* keep the previous
  //     success timestamp, or a single failed manual run would make the staleness alert fire on a healthy host
  assert.match(BACKUP, /write_status backup_failed "\$prev_success"/, 'a failure must not erase the last success');
  assert.match(BACKUP, /one; exit \$\?/, 'RUN_ONCE must return the attempt\'s exit code');
  assert.ok(BACKUP.includes('RUN_ONCE'), 'the npm script and the loop must agree on how "once" is selected');
  // (e) the copy is production data: the default umask is 022, and `.CORRUPT` files (kept for forensics)
  //     were never chmod-ed at all
  assert.match(BACKUP, /^umask 077$/m, 'the snapshot must not be created world-readable');
  assert.match(BACKUP, /chmod 0640 "\$tmp\.CORRUPT"/, 'corrupt snapshots are kept, so they are protected too');
  // (f) two snapshots inside one second must not share a name — see `uniqueSnapshotName`
  assert.equal(uniqueSnapshotName(BACKUP), true, 'the snapshot name must be unique per process, not per second');
  // (g) corrupt snapshots are bounded: they are not covered by the `.sqlite.gz` retention, and a full disk is
  //     the one failure a single-writer SQLite cannot absorb
  assert.match(BACKUP, /KEEP_CORRUPT/, 'corrupt snapshots need their own retention');
  assert.match(COMPOSE, /BACKUP_KEEP_CORRUPT/, 'and the deploy must be able to set it');
});

test('SEC-B48 the status file is what /metrics reads, and only where the sidecar exists', () => {
  const server = read('backend/src/server.ts');
  const mod = read('backend/src/backup-status.ts');
  for (const series of ['backup_last_success_timestamp_seconds', 'backup_consecutive_failures', 'backup_last_result_ok']) {
    assert.ok(server.includes(`registerScrape('${series}'`), `/metrics must export ${series}`);
  }
  assert.match(COMPOSE, /BACKUP_STATUS_FILE: \/backup-status\/out\/status/, 'the API is given the host path of the status file');
  assert.match(COMPOSE, /\.\/backup:\/backup-status:ro/, 'the API reads it read-only: it reports on snapshots, it must not touch them');
  assert.match(mod, /if \(!file\) return undefined;/, 'no BACKUP_STATUS_FILE means no series (an alert must not fire on a topology that has no backups)');
  assert.match(mod, /return \{ \.\.\.ZERO \};/, 'a configured but missing file is a state the alert must see');
  assert.match(mod, /Number\.isFinite\(n\) && n > 0 && n < 4_102_444_800/, 'implausible timestamps become 0 rather than passing through');

  // Producer ⇄ consumer: every key `write_status` emits must be one the reader asks for, or a field goes
  // missing on one side and the gauge silently reports a default (a "stale" alert nobody can explain).
  const written = new Set([...BACKUP.matchAll(/^\s*echo "([a-z_]+)=/gm)].map((m) => m[1]));
  assert.ok(written.size >= 4, `only ${written.size} status keys parsed from the script`);
  for (const k of written) {
    assert.ok(mod.includes(`kv.get('${k}')`) || mod.includes(`'${k}'`), `backup-status.ts does not read ${k}, which the script writes`);
  }
});

// --------------------------------------------------------------------------- SEC-B50

interface ActionRef { file: string; action: string; ref: string; note: string }

/** Every `uses:` of a remote action under `.github/workflows`, with its inline comment. */
function actionRefs(files = WORKFLOWS.map((f) => join('.github', 'workflows', f))): ActionRef[] {
  const out: ActionRef[] = [];
  for (const file of files) {
    for (const line of read(file).split('\n')) {
      const m = /^\s*(?:-\s+)?uses:\s*([\w.-]+\/[\w.-]+)\s*@\s*(\S+)\s*(?:#\s*(.*))?$/.exec(line);
      if (m) out.push({ file, action: m[1], ref: m[2], note: (m[3] ?? '').trim() });
    }
  }
  return out;
}

/** The complaints a pin can earn: a moving ref, a pin without its version, one action at two commits. */
function pinProblems(refs: ActionRef[]): string[] {
  const problems: string[] = [];
  const byAction = new Map<string, Set<string>>();
  for (const r of refs) {
    if (!/^[0-9a-f]{40}$/.test(r.ref)) {
      problems.push(`${r.file}: ${r.action}@${r.ref} is a moving ref`);
      continue;
    }
    if (!/v\d+(\.\d+\.\d+)?/.test(r.note)) problems.push(`${r.file}: ${r.action}@${r.ref.slice(0, 7)} has no version in its comment`);
    if (!byAction.has(r.action)) byAction.set(r.action, new Set());
    byAction.get(r.action)!.add(r.ref);
  }
  for (const [action, set] of byAction) {
    if (set.size > 1) problems.push(`${action} is pinned to ${set.size} different commits (${[...set].map((s) => s.slice(0, 7)).join(', ')})`);
  }
  return problems;
}

test('SEC-B50 every workflow action is a full SHA, annotated with its version, one SHA per action', () => {
  const refs = actionRefs();
  assert.ok(refs.length >= 45, `only ${refs.length} action references parsed — the pattern or the workflows moved, and this gate is vacuous`);
  assert.deepEqual(pinProblems(refs), []);
  const actions = new Set(refs.map((r) => r.action));
  assert.ok(actions.size >= 6, `expected the six shared actions, found ${actions.size}: ${[...actions].join(', ')}`);

  // The mapping block at the top of each file is the reviewable half of a pin: without it a SHA is an opaque
  // number and "update to the latest vN" becomes archaeology against the registry.
  for (const file of WORKFLOWS) {
    const yml = read(join('.github', 'workflows', file));
    if (!yml.includes('uses:')) continue;
    assert.ok(yml.includes('action pins (SEC-B50)'), `${file} has no pin mapping block`);
    for (const r of actionRefs([join('.github', 'workflows', file)])) {
      assert.ok(yml.includes(r.action), `${file}: ${r.action} is missing from its own mapping`);
      assert.ok(yml.includes(r.ref), `${file}: the SHA for ${r.action} is not in the mapping block either`);
    }
  }
});

// --------------------------------------------------------------------------- mutations

test('each deploy-surface rule fails on a deliberately broken input', () => {
  // 1. SEC-B47 — a path outside the ignored directory is still addable, i.e. the rule is about that
  //    directory and not about the extension; and the real ones are not.
  assert.equal(wouldAdd('ops/deploy/backup/out/guttercaps-20260927T101112Z.sqlite.gz'), false);
  assert.equal(wouldAdd('ops/deploy/backup-mutated/out/guttercaps-20260927T101112Z.sqlite.gz'), true, 'the rule must be specific to the output directory');

  // 2. SEC-B50 — the three shapes the rule exists to reject, and the real workflows produce none of them
  const real = actionRefs();
  assert.deepEqual(pinProblems(real), []);
  const broken: ActionRef[][] = [
    [{ file: 'x.yml', action: 'actions/checkout', ref: 'v4', note: 'v4' }],
    [{ file: 'x.yml', action: 'actions/checkout', ref: 'a'.repeat(40), note: '' }],
    [
      { file: 'x.yml', action: 'actions/checkout', ref: 'a'.repeat(40), note: 'v4.4.0' },
      { file: 'y.yml', action: 'actions/checkout', ref: 'b'.repeat(40), note: 'v4.4.0' },
    ],
  ];
  for (const b of broken) assert.ok(pinProblems(b).length > 0, `the rule must reject ${b[0].ref}`);

  // 3. SEC-B48 — the pre-fix naming: the timestamp alone, with uniqueness guessed from an existence test
  const preName = BACKUP.replace(
    /tmp="\$OUT_DIR\/guttercaps-\$ts-\$\$\.sqlite"/,
    'tmp="$OUT_DIR/guttercaps-$ts.sqlite"\n  if [ -e "$tmp" ] || [ -e "$tmp.gz" ]; then ts="$ts-$$"; tmp="$OUT_DIR/guttercaps-$ts.sqlite"; fi',
  );
  assert.notEqual(preName, BACKUP, 'the naming mutation must actually apply');
  assert.equal(uniqueSnapshotName(preName), false, 'the rule must reject the existence-test shape');

  // 4. SEC-B48 — the pre-fix failure path: `snapshot` unchecked, reported as an integrity failure
  const loose = BACKUP.replace(/^  if ! sqlite3 .*$/m, '  sqlite3 "file:$DB_PATH?mode=ro&immutable=0" ".backup \'$tmp\'" || true');
  assert.notEqual(loose, BACKUP, 'the mutation must actually change the script');
  assert.equal(/if ! sqlite3/.test(loose), false, 'without the check, a failed `.backup` falls through to the integrity branch (and, under `one || echo`, without any branch at all)');
});
