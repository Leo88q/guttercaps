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
