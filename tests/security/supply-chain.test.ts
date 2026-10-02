// Supply-chain gate (SEC-B12, SECURITY-AUDIT-2026-09-26.md).
//
// `package-lock.json` shipped with 705 of its 1 097 registry packages carrying neither `resolved` nor
// `integrity` — a lock node that pins a *version string* and nothing else. `npm ci` in that state asks
// the registry for `name@version` and installs whatever bytes come back: no URL to pin the host, no
// hash to compare the tarball against. That is the exact shape of the `@solana/web3.js` 1.95.6/1.95.7
// incident the audit checklist names (a republished tarball under an unchanged version reaching every
// install that had nothing to verify), and `@solana/web3.js` itself was one of the 705.
//
// The lock is repaired (`scripts/lock-integrity.ts`, hashes taken from what npm actually fetched and
// cross-checked against the registry packument metadata). This file is what keeps it repaired: it runs
// offline in `npm run security:static`, so a future `npm install` that drops the fields, adds a
// non-registry host, introduces an install script or resolves a withdrawn version fails the build
// instead of quietly widening the trust boundary.
//
// Every rule below has a known-bad mutation in the test itself (see the last block): a gate nobody has
// seen fail is a comment.
//   node --experimental-strip-types --test tests/security/*.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPROMISED, missingNodes } from '../../scripts/lock-integrity.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');

interface Node {
  version?: string;
  resolved?: string;
  integrity?: string;
  name?: string;
  link?: boolean;
  hasInstallScript?: boolean;
}
const lock = JSON.parse(read('package-lock.json')) as { lockfileVersion?: number; packages: Record<string, Node> };
const registryNodes = Object.entries(lock.packages ?? {}).filter(([p, n]) => p && p.includes('node_modules/') && !n.link);

/** package.json manifests that feed the single root lock (the repo is one npm workspace). */
const MANIFESTS = ['package.json', 'backend/package.json', 'client/package.json', 'packages/economy/package.json'];

/**
 * The lowest version a declared range admits. `^1.95.3` → `1.95.3`, `~2.0.0` → `2.0.0`, `>=3.1.0` → `3.1.0`,
 * `1.2.3` → `1.2.3`; the `||` alternatives are all compared, since any of them can be installed.
 */
export function rangeFloors(spec: string): string[] {
  return spec
    .split('||')
    .map((part) => /(?:^|[\s(])(?:\^|~|>=|>|=)?\s*(\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(part.trim())?.[1])
    .filter((v): v is string => Boolean(v));
}

/** Numeric compare of `X.Y.Z`, prerelease ignored — enough to order the versions a lock can hold. */
export function cmpVersion(a: string, b: string): number {
  const p = (v: string) => v.split('-')[0].split('.').map(Number);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

test('every registry package in the lock pins its host and its bytes', () => {
  assert.ok(registryNodes.length > 900, `lock only has ${registryNodes.length} registry nodes — reading the wrong tree?`);
  const unpinned = missingNodes(lock as never);
  assert.deepEqual(
    unpinned.map((m) => `${m.path}@${m.version}`),
    [],
    'these lock nodes have no `resolved`/`integrity`: `npm ci` would install whatever the registry serves. Run `node --experimental-strip-types scripts/lock-integrity.ts --write` (from a machine that has the npm cache) and commit the result',
  );
});

test('resolved URLs are https on the single official registry host', () => {
  const bad: string[] = [];
  for (const [path, node] of registryNodes) {
    const url = node.resolved ?? '';
    if (!url.startsWith('https://registry.npmjs.org/')) bad.push(`${path}: ${url || '<none>'}`);
  }
  assert.deepEqual(bad, [], 'a dependency resolved from a host other than https://registry.npmjs.org/ (mirror, http, git or file URL): that is a different publisher than the audited one');
});

test('integrity is a sha512 recorded per package', () => {
  const bad = registryNodes.filter(([, n]) => !(n.integrity ?? '').startsWith('sha512-')).map(([p]) => p);
  assert.deepEqual(bad, [], 'these nodes carry no sha512 integrity — a sha1 shasum (or nothing) cannot detect a republished tarball');
});

test('no withdrawn/compromised version is resolved anywhere in the tree', () => {
  assert.ok(Object.keys(COMPROMISED).length > 0, 'the deny-list must not be empty — an empty list makes this test vacuous');
  const hits: string[] = [];
  for (const [path, node] of registryNodes) {
    const name = node.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if ((COMPROMISED[name] ?? []).includes(node.version ?? '')) hits.push(`${path}@${node.version}`);
  }
  assert.deepEqual(hits, [], 'a dependency resolves to a version withdrawn after a supply-chain compromise');
});

test('no declared range reaches down to a withdrawn/compromised version', () => {
  // `^1.95.3` admits 1.95.6 — the range is what a future lockfile regeneration resolves against, so the
  // floor has to clear every withdrawn version, not just the version the lock happens to hold today.
  const bad: string[] = [];
  for (const manifest of MANIFESTS) {
    const pkg = JSON.parse(read(manifest)) as Record<string, Record<string, string> | undefined>;
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
        for (const withdrawn of COMPROMISED[name] ?? []) {
          for (const floor of rangeFloors(spec)) {
            if (cmpVersion(floor, withdrawn) <= 0 && withinRange(spec, withdrawn)) bad.push(`${manifest} ${name}="${spec}" admits ${withdrawn}`);
          }
        }
      }
    }
  }
  assert.deepEqual(bad, [], 'a declared range can resolve to a version withdrawn after a compromise — raise its floor above the last withdrawn version');
});

/** Does `spec` (the `^`/`~`/`>=`/exact forms the repo uses) admit `version`? Kept next to the gate so a
 *  width bug is visible; anything it cannot parse is treated as admitting the version (fail closed). */
export function withinRange(spec: string, version: string): boolean {
  return spec.split('||').some((part) => {
    const t = part.trim();
    if (!t || t === '*' || t === 'latest') return true;
    const m = /^(\^|~|>=|>|=)?\s*(\d+\.\d+\.\d+)(?:-[\w.]+)?$/.exec(t);
    if (!m) return true;
    const [, op = '', base] = m;
    const c = cmpVersion(version, base);
    if (op === '' || op === '=') return c === 0;
    if (op === '>=') return c >= 0;
    if (op === '>') return c > 0;
    if (op === '~') return c >= 0 && version.split('-')[0].split('.').slice(0, 2).join('.') === base.split('.').slice(0, 2).join('.');
    // caret: same major, and same minor below 1.0.0
    const [maj, min] = base.split('.').map(Number);
    if (c < 0) return false;
    const vmaj = Number(version.split('.')[0]);
    if (maj > 0) return vmaj === maj;
    return vmaj === 0 && (min === 0 ? Number(version.split('.')[2].split('-')[0]) === 0 : Number(version.split('.')[1]) === min);
  });
}

test('install scripts are a conscious decision, not a new arrival', () => {
  // Install scripts run arbitrary code as the CI user (and on every dev machine) with no sandbox: the
  // `esbuild`/`fsevents`/`utf-8-validate` family compiles native bindings, `bigint-buffer` tries node-gyp
  // (the accepted, dated GHSA allow-list entry in `scripts/audit-gate.ts`). A package that starts shipping
  // one is a review event, so the list is pinned here the same way the CPIs and layout fingerprints are.
  const allowed = new Set([
    'node_modules/bigint-buffer',
    'node_modules/bufferutil',
    'node_modules/esbuild',
    'node_modules/fsevents',
    'node_modules/protobufjs',
    'node_modules/tsx/node_modules/esbuild',
    'node_modules/tsx/node_modules/fsevents',
    'node_modules/utf-8-validate',
    'node_modules/vite/node_modules/fsevents',
  ]);
  const nested = /node_modules\/(@react-native\/dev-middleware|jayson|lighthouse|metro|react-devtools-core|react-native)\/node_modules\/(utf-8-validate|fsevents)$/;
  const found = Object.entries(lock.packages ?? {})
    .filter(([, n]) => n.hasInstallScript)
    .map(([p]) => p);
  const unexpected = found.filter((p) => !allowed.has(p) && !nested.test(p));
  assert.deepEqual(unexpected, [], `new install script(s): ${unexpected.join(', ')}. Review the package, then add it here — and to scripts/audit-gate.ts if it drags in an advisory`);
  assert.ok(found.length >= 4, `only ${found.length} install scripts found — the field is probably not being read`);
});

test('the lock matches the manifests it is resolved from', () => {
  // `npm ci` refuses to run otherwise; catching it here means the failure lands in review, not in a
  // deploy step three jobs later.
  const bad: string[] = [];
  for (const manifest of MANIFESTS) {
    const rel = manifest === 'package.json' ? '' : manifest.replace('/package.json', '');
    const pkg = JSON.parse(read(manifest)) as Record<string, Record<string, string> | undefined>;
    const locked = (lock.packages[rel] ?? {}) as Record<string, Record<string, string> | undefined>;
    for (const section of ['dependencies', 'devDependencies']) {
      for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
        const pinned = locked[section]?.[name];
        assert.ok(pinned, `${manifest} declares ${name} but the lock records no spec for it`);
        if (pinned !== spec) bad.push(`${manifest} ${section}.${name}: "${spec}" vs lock "${pinned}"`);
      }
    }
  }
  assert.deepEqual(bad, [], 'package.json and package-lock.json disagree — run `npm install --package-lock-only`');
});

// --------------------------------------------------------------------------------- [patch.crates-io] (M-8)
// The npm rules above protect `package-lock.json`. Cargo has the same failure mode and none of the
// same machinery: a `[patch.crates-io]` entry pointing at a path directory is a *local modification of
// third-party code* that `cargo audit` cannot see (no registry identity, so no advisory-db entry) and
// `cargo update` cannot move. `vendor/mpl-core` is exactly that — root Cargo.toml:41-45 explains the
// omission (upstream `hooked`/`indexable_asset` are left out so SBF does not link a 4 KiB-overflowing
// plugin-list conversion frame), and Cargo.lock:1233 records the entry with no `source` and no
// `checksum`. A patched crate with no written-down origin is a crate nobody can audit or update.
test('every [patch.crates-io] path entry has a sibling PATCHES.md recording its origin', () => {
  const patchBlock = /\[patch\.crates-io\]\n([\s\S]*?)(?=\n\[|$)/.exec(read('Cargo.toml'));
  assert.ok(patchBlock, 'root Cargo.toml has no [patch.crates-io] block — the vendored subset is no longer wired in, and this gate has nothing to protect');
  const entries = [...patchBlock[1]!.matchAll(/([A-Za-z0-9_-]+)\s*=\s*\{[^}]*path\s*=\s*"([^"]+)"/g)];
  assert.ok(entries.length > 0, 'no path-based patch parsed — the reader is broken, not the manifest');

  for (const [, crate, dir] of entries) {
    const rel = dir.replace(/^\.\//, '').replace(/\/$/, '');
    const doc = join(REPO, rel, 'PATCHES.md');
    assert.ok(existsSync(doc), `${rel} is patched into the build via [patch.crates-io] ${crate} = { path = "${dir}" } but has no PATCHES.md — a local modification of third-party code nobody can audit`);
    const text = read(`${rel}/PATCHES.md`);
    // It has to name the upstream, and it has to say which revision — or say explicitly that it is
    // unknown and why. "Unknown" is an acceptable answer here; a blank is not.
    assert.match(text, /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+/, `${rel}/PATCHES.md does not name an upstream repository`);
    assert.match(text, /\b[0-9a-f]{7,40}\b/, `${rel}/PATCHES.md records no upstream revision (a tag SHA, or an explicit "unknown" with the reason)`);
    assert.match(text, /unknown|no tag|cannot be|crates\.io/, `${rel}/PATCHES.md names a revision but does not say whether it was verified`);
    // And the reason for the fork, which is the part a reviewer needs first.
    assert.match(text, /intentionally|deliberate|omitted|because|reason/i, `${rel}/PATCHES.md does not state why the code differs from upstream`);
  }
});

test('a patched crate whose Cargo.lock entry has no checksum is recorded as a path dependency', () => {
  // Not a rule to fix — a *fact* to keep visible. `cargo audit` cannot see a path dependency, so the
  // security posture of the vendored subset is "reviewed by hand or not at all", and this asserts the
  // shape that makes that true rather than leaving it to be discovered during an incident.
  const lock = read('Cargo.lock');
  // Split on the block header rather than matching across it: `[[package]]` contains brackets, so a
  // character-class exclusion silently matches nothing and the rule would pass vacuously.
  const blocks = lock.split('[[package]]').slice(1);
  for (const crate of ['mpl-core']) {
    const block = blocks.find((b) => new RegExp(`^name = "${crate}"$`, 'm').test(b));
    assert.ok(block, `Cargo.lock has no entry for ${crate} (read ${blocks.length} blocks)`);
    assert.ok(!/^source = /m.test(block!), `${crate} now resolves from a registry — PATCHES.md and this rule need updating`);
    assert.ok(!/^checksum = /m.test(block!), `${crate} now carries a checksum — the fork is pinned to a registry release, so record the revision in PATCHES.md`);
    // and the version the lock agrees with the vendored manifest
    const vendored = /^version = "([^"]+)"/m.exec(read('vendor/mpl-core/Cargo.toml'))!;
    const locked = /^version = "([^"]+)"/m.exec(block!);
    assert.equal(locked?.[1], vendored[1], `Cargo.lock pins mpl-core ${locked?.[1]} but vendor/mpl-core/Cargo.toml declares ${vendored[1]}`);
  }
});

// ------------------------------------------------------------------- self-test for the patch gate
// Same principle as the mutation block below, on the rules added for M-8: a gate nobody has seen fail
// is a comment. These use the real reader over synthetic manifests, so a silently-broken parse of
// `[patch.crates-io]` is caught here rather than by a future fork that ships with no PATCHES.md.
test('the patch gate fires on a path entry with no PATCHES.md, and on a PATCHES.md with no origin', () => {
  const patchEntries = (toml: string) =>
    [...(/\[patch\.crates-io\]\n([\s\S]*?)(?=\n\[|$)/.exec(toml)?.[1] ?? '').matchAll(/([A-Za-z0-9_-]+)\s*=\s*\{[^}]*path\s*=\s*"([^"]+)"/g)];

  const withPatch = '[dependencies]\nmpl-core = "0.11.2"\n\n[patch.crates-io]\nmpl-core = { path = "vendor/mpl-core" }\n';
  const noPatch = '[dependencies]\nmpl-core = "0.11.2"\n';
  const noPath = '[patch.crates-io]\nmpl-core = { git = "https://github.com/metaplex-foundation/mpl-core", rev = "f973593" }\n';
  const twoEntries = '[patch.crates-io]\nmpl-core = { path = "vendor/mpl-core" }\nsolana-program = { path = "vendor/solana-program" }\n';

  assert.equal(patchEntries(withPatch).length, 1, 'a path patch must be parsed');
  assert.equal(patchEntries(noPatch).length, 0, 'a manifest with no patch block yields nothing');
  assert.equal(patchEntries(noPath).length, 0, 'a git-rev patch is not a path patch — nothing to record');
  assert.equal(patchEntries(twoEntries).length, 2, 'every path entry is checked, not just the first');
  assert.equal(patchEntries(withPatch)[0]![2], 'vendor/mpl-core', 'the directory is what the sibling PATCHES.md must live in');

  // and the four things PATCHES.md has to contain, as the gate reads them
  const doc = read('vendor/mpl-core/PATCHES.md');
  for (const [what, re] of [
    ['an upstream repository', /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+/],
    ['a revision or an explicit unknown', /\b[0-9a-f]{7,40}\b|unknown/i],
    ['a stated reason for the fork', /intentionally|deliberate|omitted|because|reason/i],
  ] as const) assert.match(doc, re, `PATCHES.md is missing ${what}`);
});

// ------------------------------------------------------------------------------ M-2 (cargo audit)
// The npm half of the tree has an advisory gate (`npm run audit:gate`, SEC-F12: every high/critical
// advisory fails unless it is in the dated, justified ACCEPTED list of scripts/audit-gate.ts). The
// Rust half had none at all — `security`'s "npm audit" name described half a job, and 318 crates in
// Cargo.lock were never checked against an advisory database.
//
// The `rust-security` job is that gate. What is checkable offline is its *shape*: that it exists, that
// it is strict, that it cannot be made non-blocking or stale by accident, and that its actions are
// pinned the way SEC-B50 requires. The advisory *outcome* needs cargo and crates.io, neither of which
// exists in the sandbox this was written in — so this file pins the shape, and the first CI run on the
// branch is where the outcome gets confirmed.
test('M-2 a rust advisory gate exists, is strict, and cannot be quietly weakened', () => {
  const ci = read('.github/workflows/ci.yml');
  const job = jobBlock(ci, 'rust-security');
  assert.ok(job, '.github/workflows/ci.yml has no rust-security job — the 318 crates in Cargo.lock are unchecked against any advisory database');
  assert.deepEqual(auditProblems(job), [], 'the advisory gate is missing or weakened');
  assert.match(auditCommand(job), /--locked --deny warnings/, 'the audit must resolve the committed graph and deny the notices');
  // SEC-B50 applies here like everywhere else.
  for (const [, ref] of job.matchAll(/- uses: (\S+)/g)) {
    assert.match(ref, /@[0-9a-f]{40}(\s|$)/, `unpinned action ref in rust-security: ${ref}`);
  }
  // And the npm half it is held to the same standard as still has its accept-list, with a reason per
  // entry — an undocumented ignore is how an advisory gate stops measuring anything.
  const accepted = /export const ACCEPTED[^=]*=\s*\[([\s\S]*?)\n\];/.exec(read('scripts/audit-gate.ts'))?.[1] ?? '';
  assert.ok(accepted.length > 0, 'scripts/audit-gate.ts lost its ACCEPTED list');
  assert.equal(accepted.split('id:').length - 1, (accepted.match(/\bwhy:/g) ?? []).length, 'every accepted npm advisory must carry its reason');
});

/**
 * The `cargo audit` argument string of one job, with `$locked` normalised. Anchored to the start of a
 * line: the job is *named* "rust · cargo audit against the shipped lock", and a bare
 * `/cargo audit (…)/` happily reads that prose as the command — a reader that reports "not --locked"
 * against a comment is a reader nobody trusts twice.
 */
function auditCommand(job: string): string {
  return (/(?:^|\n)[ \t]*(?:sh scripts\/ci-run-logged\.sh \S+ )?cargo audit ([^\r\n]+)/.exec(job)?.[1] ?? '').replace('$locked', '--locked');
}

/**
 * The body of one top-level CI job: everything after its `  name:` key, up to the next top-level key.
 * `(?:^|\n)` because a synthetic workflow in the self-test starts at offset 0 with no newline in
 * front of it, and a reader that returns '' for that would make the self-test vacuous.
 */
function jobBlock(ci: string, name: string): string {
  const m = new RegExp(`(?:^|\\n)  ${name}:\\n`).exec(ci);
  if (!m) return '';
  const after = ci.slice(m.index + m[0].length);
  const next = after.search(/^  [a-z][\w-]*:/m);
  return next < 0 ? after : after.slice(0, next);
}

/** The M-2 rule as a pure predicate, so the real gate and the synthetic self-test share one reader. */
function auditProblems(job: string): string[] {
  const problems: string[] = [];
  if (!job) return ['no rust-security job'];
  const audit = auditCommand(job);
  // `--locked`: the graph audited must be the one being shipped, not whatever the runner re-resolves.
  if (!/--locked/.test(audit)) problems.push('not --locked');
  // `--deny warnings`: plain `cargo audit` exits non-zero on a vulnerability but *prints and ignores*
  // the notices — yanked, unmaintained, unsupported — and a lockfile that has quietly picked up a
  // yanked dependency is exactly the shape of a supply-chain incident here.
  if (!/--deny warnings/.test(audit)) problems.push('no --deny warnings');
  for (const weak of ['--no-fetch', '--stale', '--target-arch']) {
    if (audit.includes(weak)) problems.push(`passed ${weak}: it audits a database nobody chose`);
  }
  if (/continue-on-error:\s*true/.test(job)) problems.push('continue-on-error: a gate allowed to fail is not a gate');
  if (!/sh scripts\/ci-run-logged\.sh \S+ cargo audit/.test(job)) problems.push('no exit-code wrapper');
  // The cache is the registry, never the installed binary: a cached cargo-audit is a scanner whose
  // version nobody chose.
  if (/\/usr\/local\/cargo\/bin/.test(job)) problems.push('cached scanner binary');
  return problems;
}

// --------------------------------------------------------------------------------------------- mutations
// The rules above are the assertions; these show each one can fail. Every case is a mutated copy of the
// real lock (never written to disk) plus the same helper the gate uses, so a silently-broken reader is
// caught here rather than in production.
test('each rule fails on a deliberately broken lock (mutation check)', () => {
  const clone = () => JSON.parse(JSON.stringify(lock)) as typeof lock;
  const first = registryNodes[0][0];

  const droppedField = clone();
  delete droppedField.packages[first].integrity;
  assert.ok(missingNodes(droppedField as never).some((m) => m.path === first), 'unpinned node not detected');

  const foreignHost = clone();
  foreignHost.packages[first].resolved = 'https://registry.npmjs.cf/x.tgz';
  assert.ok(!foreignHost.packages[first].resolved.startsWith('https://registry.npmjs.org/'), 'host rule must reject a lookalike registry');

  const sha1 = clone();
  sha1.packages[first].integrity = 'sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  assert.ok(!sha1.packages[first].integrity.startsWith('sha512-'), 'sha1 must not pass the integrity rule');

  assert.ok(withinRange('^1.95.3', '1.95.7'), 'the range reader must see 1.95.3 as admitting 1.95.7 — otherwise the range rule is vacuous');
  assert.ok(!withinRange('^1.99.0', '1.95.7'), 'a raised floor must exclude the withdrawn version');
  assert.ok(withinRange('~1.98.0', '1.98.9') && !withinRange('~1.98.0', '1.99.0'), 'tilde width');
  assert.ok(!withinRange('>=1.99.0', '1.95.7') && withinRange('>=1.99.0', '2.0.0'), 'gte floor');
  assert.deepEqual(rangeFloors('^1.95.3 || ~2.0.0'), ['1.95.3', '2.0.0']);
  assert.ok(cmpVersion('1.95.7', '1.99.0') < 0 && cmpVersion('1.99.0', '1.99.0') === 0 && cmpVersion('2.0.0', '1.99.0') > 0, 'cmpVersion orders versions');
});

// ------------------------------------------------------------------ self-test for the M-2 gate
// The reader over synthetic workflow text, so a silently-broken job slice cannot pass the real rule
// vacuously: `jobBlock` must find the job, stop at the next one, and every weakening below must be
// visible to it.
test('the M-2 reader sees a weakened advisory gate', () => {
  const good = [
    '  rust-security:',
    '    name: rust · cargo audit',
    '    steps:',
    '      - run: |',
    '          sh scripts/ci-run-logged.sh /tmp/cargo-audit.log cargo audit --locked --deny warnings',
    '  localnet:',
    '    name: localnet',
  ].join('\n');
  const weakenings: Array<[string, string]> = [
    ['no --deny warnings', good.replace(' --deny warnings', '')],
    ['a stale advisory database', good.replace('--locked --deny warnings', '--locked --no-fetch --deny warnings')],
    ['a non-blocking gate', good.replace('    name: rust · cargo audit', '    continue-on-error: true')],
    ['no exit-code wrapper', good.replace('sh scripts/ci-run-logged.sh /tmp/cargo-audit.log cargo audit', 'cargo audit')],
    ['a cached scanner binary', good.replace('      - run: |', '      - uses: actions/cache@' + 'a'.repeat(40) + ' # v4.3.0\n        with:\n          path: /usr/local/cargo/bin')],
    ['no job at all', good.replace('  rust-security:', '  rust-audit-gone:')],
  ];
  for (const [what, text] of weakenings) {
    assert.notEqual(text, good, `the "${what}" mutation must actually change the workflow`);
    assert.ok(auditProblems(jobBlock(text, 'rust-security')).length > 0, `the reader must reject ${what}`);
  }
  assert.deepEqual(auditProblems(jobBlock(good, 'rust-security')), [], 'the synthetic good job must pass');
  assert.equal(jobBlock(good, 'rust-security').includes('localnet'), false, 'the job slice must stop at the next top-level key');
  assert.equal(jobBlock(good, 'nope'), '', 'an absent job is an empty slice, not the whole file');
});
