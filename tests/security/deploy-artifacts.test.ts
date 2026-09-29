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
const DOCKERIGNORE = read('.dockerignore');
const DOCKERFILE_CLIENT = read('ops/deploy/Dockerfile.client');
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

// --------------------------------------------------------------------------- SEC-B55

/**
 * `.dockerignore` excluded one literal dotenv name (`.env`) out of the four `vite build` reads (`.env`, `.env.local`,
 * `.env.production`, `.env.production.local`, verified in the installed vite: `getEnvFilesForMode`), and
 * `client/.env.example` tells every developer to "copy to .env.local and adjust". Vite applies the dotenv
 * files first and then overwrites with `process.env`, so the names the Dockerfile declares are safe — but
 * an *undeclared* `VITE_*` name is exactly what a local file contributes, and `VITE_API_MOCK` (in-browser
 * backend: fake balances, fake sign-in) or `VITE_FLAG_DEBUG_PANEL` would ship baked into a production
 * bundle, from a file `.gitignore` hides and no diff of the deploy artifacts would ever show.
 *
 * The matcher below implements the pattern shapes this ignore file uses, for *file* paths: a leading
 * double-star-slash (any depth),
 * depth), `*` (within one path segment), a leading `!` (re-include), last match wins. Directory patterns
 * are not modelled — the paths checked are the dotenv names themselves.
 */
const dockerignoreMatch = (patterns: string[], path: string): boolean => {
  // Built without regex literals on purpose: every backslash in this file would otherwise have to survive
  // a review of the escaping itself. `B` is a backslash, `specials` is Regexp.escape's set.
  const B = String.fromCharCode(92);
  const specials = '.+^${}()|[]' + B;
  const glob = (pat: string): RegExp => {
    const escaped = [...pat].map((c) => (specials.includes(c) ? B + c : c)).join('');
    const rx = escaped
      .split(B + B + '/').join('(?:.*/)?') // `**/` — any depth, including none
      .split(B + B).join('.*')             // `**`  — anything
      .split('*').join('[^/]*')            // `*`   — within one segment
      .split('?').join('[^/]');
    return new RegExp('^' + rx + '$');
  };
  let ignored = false;
  for (const raw of patterns) {
    const negated = raw.startsWith('!');
    const pat = negated ? raw.slice(1) : raw;
    if (glob(pat).test(path)) ignored = !negated;
  }
  return ignored;
};

/** The four files `vite build` (mode production) loads from the client root, plus the example kept in the tree. */
const VITE_DOTENV = ['client/.env', 'client/.env.local', 'client/.env.production', 'client/.env.production.local'];

const contextProblems = (dockerignore: string): string[] => {
  const patterns = dockerignore.split('\n').map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith('#'));
  const problems: string[] = [];
  for (const f of VITE_DOTENV) {
    if (!dockerignoreMatch(patterns, f)) problems.push(`${f} is copied into the client image build context — Vite reads it and bakes any undeclared VITE_* switch it finds`);
  }
  if (dockerignoreMatch(patterns, 'client/.env.example')) problems.push('client/.env.example is excluded — the documented template for those files must stay in the tree');
  return problems;
};

/**
 * The Dockerfile's own half: `VITE_API_MOCK` is declared so it can be refused, every name in the
 * refuse-list is actually pinned by the `ENV` line (Vite lets `process.env` win over a dotenv file only for
 * names that are present there), and the refuse-list is not a comment — it must be read by a branch that
 * exits non-zero.
 */
const declaredViteNames = (docker: string): string[] => {
  const m = /const DECLARED = new Set\(\[([^\]]*)\]\)/.exec(docker);
  return m ? [...m[1].matchAll(/'([A-Z0-9_]+)'/g)].map((x) => x[1]) : [];
};
const envViteNames = (docker: string): string[] => {
  // The ENV directive is a multi-line continuation (trailing `\\`), so the names after the first line do not
  // start with `ENV `. Reading only the first line would report every declared name as unpinned — the exact
  // false positive the mutation below would otherwise be hiding behind.
  const lines = docker.split('\n');
  let block = '';
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('ENV ')) continue;
    block += ' ' + lines[i];
    while (lines[i].trimEnd().endsWith('\\') && i + 1 < lines.length) { i++; block += ' ' + lines[i]; }
  }
  return [...new Set([...block.matchAll(/\b(VITE_[A-Z0-9_]+)=/g)].map((x) => x[1]))];
};
const clientDockerfileProblems = (docker: string): string[] => {
  const problems: string[] = [];
  const declared = declaredViteNames(docker);
  const envNames = envViteNames(docker);
  if (!declared.includes('VITE_API_MOCK')) problems.push('VITE_API_MOCK is not in the Dockerfile refuse-list');
  if (!envNames.includes('VITE_API_MOCK')) problems.push('VITE_API_MOCK is not pinned by the ENV line — a `.env.local` in the context could still set it (Vite prefers process.env, but only for names that are there)');
  for (const n of declared) if (!envNames.includes(n)) problems.push(`${n} is in the refuse-list but not pinned by the ENV line`);
  for (const n of envNames) if (!declared.includes(n) && n !== 'NODE_ENV') problems.push(`${n} is pinned by the ENV line but absent from the refuse-list — the stray check would let a dotenv file set it`);
  for (const f of VITE_DOTENV) if (!docker.includes(`'${f}'`)) problems.push(`${f} is not among the files the build-time check reads`);
  if (!/process\.exit\(1\)/.test(docker) || !/VITE_API_MOCK/.test(docker.slice(docker.indexOf('const DECLARED')))) problems.push('the refuse-list is not followed by a failing branch');
  return problems;
};

test('SEC-B55 no undeclared VITE_ switch can reach a production client bundle from the build context', () => {
  assert.deepEqual(contextProblems(DOCKERIGNORE), []);
  assert.deepEqual(clientDockerfileProblems(DOCKERFILE_CLIENT), []);
  // the check cannot pass by finding nothing to read
  assert.ok(DOCKERFILE_CLIENT.includes('files.length + \' file names checked)'), 'the build-time check must report how many file names it examined');
});

// --------------------------------------------------------------------------- SEC-B54

/**
 * The chain id in the SIWS message is the one sentence the user is trained to read before signing, and the
 * wallet adapter's `chains` decides whether the login popup even asks the wallet for the right cluster. The
 * id was a literal `'solana:devnet'` in `session.tsx` while `main.tsx` chose `solana:mainnet` from
 * `CLUSTER`, so on mainnet the login request *told the user* they were signing on devnet and a strict
 * wallet could refuse the mismatch. Returning problems instead of asserting keeps the rule testable: the
 * mutations below call this predicate on synthetic pre-fix sources.
 */
const chainIdProblems = (session: string, main: string, config: string): string[] => {
  const code = (s: string) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const problems: string[] = [];
  if (/chainId:\s*['"]solana:(mainnet|devnet|localnet)['"]/.test(code(session))) problems.push('session.tsx hardcodes the chain id in the SIWS message');
  if (!/chainId:\s*SIWS_CHAIN_ID\b/.test(code(session))) problems.push('session.tsx does not sign SIWS_CHAIN_ID');
  if (!/chains:\s*\[SIWS_CHAIN_ID\]/.test(code(main))) problems.push('main.tsx advertises a chain set other than SIWS_CHAIN_ID');
  if (!/CLUSTER === 'mainnet-beta' \? 'solana:mainnet'/.test(code(config))) problems.push('config.ts does not derive SIWS_CHAIN_ID from CLUSTER');
  return problems;
};

test('SEC-B54 the SIWS message and the wallet adapter name the same chain, derived from CLUSTER', () => {
  const problems = chainIdProblems(read('client/src/app/session.tsx'), read('client/src/main.tsx'), read('client/src/app/config.ts'));
  assert.deepEqual(problems, []);
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

  // 5. SEC-B54 — the pre-fix client: the message names devnet by hand while the adapter follows CLUSTER
  const preFixSession = read('client/src/app/session.tsx').replace('chainId: SIWS_CHAIN_ID', "chainId: 'solana:devnet'");
  assert.notEqual(preFixSession, read('client/src/app/session.tsx'), 'the chain-id mutation must actually apply');
  assert.ok(
    chainIdProblems(preFixSession, read('client/src/main.tsx'), read('client/src/app/config.ts')).length > 0,
    'the rule must reject a hardcoded chain id in the signed message',
  );

  // 6. SEC-B55 — the pre-fix ignore list named one dotenv file out of the four Vite reads
  const preFixIgnore = DOCKERIGNORE.replace('**/.env*', '**/.env');
  assert.notEqual(preFixIgnore, DOCKERIGNORE, 'the ignore-list mutation must actually apply');
  const preProblems = contextProblems(preFixIgnore);
  assert.ok(
    preProblems.some((p) => p.startsWith('client/.env.local') && p.includes('undeclared VITE_* switch')),
    `the rule must reject a context carrying client/.env.local, got ${JSON.stringify(preProblems)}`,
  );
  // and the Dockerfile half: a refuse-list whose failing branch was dropped, or a name not pinned by ENV
  const unpinned = DOCKERFILE_CLIENT.replace("VITE_SENTRY_DSN=$VITE_SENTRY_DSN VITE_API_MOCK=$VITE_API_MOCK", "VITE_SENTRY_DSN=$VITE_SENTRY_DSN");
  assert.notEqual(unpinned, DOCKERFILE_CLIENT, 'the ENV mutation must actually apply');
  assert.ok(clientDockerfileProblems(unpinned).some((p) => p.includes('VITE_API_MOCK')), 'the rule must reject a mock switch that is not pinned by ENV');
});


test('API Docker build smoke imports TypeScript with its production loader on Node 22.13', () => {
  const dockerfile = read('ops/deploy/Dockerfile.api');
  const check = (text: string) => {
    const command = text.split('\n').find(line => line.includes("import('@guttercaps/economy')"));
    assert.ok(command, 'economy workspace import smoke must remain in the image build');
    assert.match(command, /node --import tsx --input-type=module/, 'Node 22.13 needs the TypeScript loader');
  };
  check(dockerfile);
  const backend = JSON.parse(read('backend/package.json'));
  assert.ok(backend.dependencies.tsx, 'tsx must survive npm ci --omit=dev');
  assert.throws(() => check(dockerfile.replace('--import tsx --input-type=module', '--input-type=module')),
    /TypeScript loader/);
});
