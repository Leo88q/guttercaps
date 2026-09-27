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
import { readFileSync } from 'node:fs';
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
