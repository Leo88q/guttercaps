// Supply-chain repair: `package-lock.json` shipped 705 of its 1 097 registry packages with neither
// `resolved` nor `integrity` (SEC-B12, SECURITY-AUDIT-2026-09-26.md). A lock node in that state pins a
// *version string* and nothing else: `npm ci` asks the registry for `name@version`, takes whatever
// tarball comes back, and has no hash to compare it to — the exact shape of the `@solana/web3.js`
// 1.95.6/1.95.7 incident, where a republished tarball under an existing version number reached every
// install that had no integrity to check. `@solana/web3.js` itself was one of the 705.
//
// Two sources are used to restore the fields, and they must agree when both are present:
//
//   1. the tarball cache (`~/.npm/_cacache/index-v5`, keys `…registry.npmjs.org/<…>.tgz`) — the hash of
//      the bytes npm actually fetched and installed on this machine;
//   2. the packument cache (`…/registry.npmjs.org/<name>`) — `versions[v].dist.integrity`, i.e. the
//      registry's own metadata for that version.
//
// The script only *adds* `resolved`/`integrity` next to the existing `version`; it never moves a version,
// so the diff is reviewable line by line and the tree that CI installs stays byte-identical. Verification
// is `rm -rf node_modules && npm ci`: npm checks every hash it finds, so a single wrong one fails loudly.
//
//   node --experimental-strip-types scripts/lock-integrity.ts             # check: list what is missing, exit 1
//   node --experimental-strip-types scripts/lock-integrity.ts --write     # repair from the npm cache
//   node --experimental-strip-types scripts/lock-integrity.ts --selftest  # pure logic, no fs/network
//
// The invariant itself is enforced forever by `tests/security/supply-chain.test.ts` (offline, in
// `npm run security:static`): every registry node must carry an https registry URL and a sha512.
import { readFileSync, writeFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const LOCK = join(REPO, 'package-lock.json');
const REGISTRY = 'https://registry.npmjs.org/';

/** Versions withdrawn from the registry after a compromise: no tree may resolve to them. */
export const COMPROMISED: Record<string, string[]> = {
  '@solana/web3.js': ['1.95.6', '1.95.7'],
};

interface Node {
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  /** set by npm for an aliased dependency (`"@coral-xyz/anchor-31": "npm:@coral-xyz/anchor@0.31.1"`) */
  name?: string;
  [k: string]: unknown;
}
type Lock = { lockfileVersion?: number; packages: Record<string, Node>; [k: string]: unknown };

/** One `index-v5` record: the cache key plus the integrity npm recorded for the bytes behind it. */
export interface CacheEntry {
  key: string;
  integrity?: string;
}
/** A lock node that must be filled: its name (unscoped path form) and version. */
export interface Missing {
  path: string;
  /** the real package name (an alias node's own `name`), used for the tarball URL */
  name: string;
  /** the directory-shaped name, what the alias is called in the tree */
  alias: string;
  version: string;
}

const isRegistryNode = (p: string) => p.startsWith('node_modules/') || p.includes('/node_modules/');
/** `node_modules/@scope/name` → `@scope/name`; `node_modules/a/node_modules/b` → `b`. */
export function nameOf(path: string): string {
  const i = path.lastIndexOf('node_modules/');
  return path.slice(i + 'node_modules/'.length);
}
/** npm's tarball naming: the scope is dropped, `@scope/name` → `<name>-<version>.tgz`. */
export function tarballUrl(name: string, version: string): string {
  const base = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
  return `${REGISTRY}${name}/-/${base}-${version}.tgz`;
}
export const isCompromised = (name: string, version: string): boolean =>
  (COMPROMISED[name] ?? []).includes(version);

/** Every registry node without a hash pin, in lock order. */
export function missingNodes(lock: Lock): Missing[] {
  const out: Missing[] = [];
  for (const [path, node] of Object.entries(lock.packages ?? {})) {
    if (!path || node.link || !isRegistryNode(path)) continue;
    if (node.resolved && node.integrity) continue;
    const alias = nameOf(path);
    out.push({ path, alias, name: node.name ?? alias, version: node.version ?? '' });
  }
  return out;
}

/** Parse `index-v5` file bodies (one `<hash>\t<json>` record per line) into key/integrity pairs. */
export function parseCacheIndex(text: string): CacheEntry[] {
  const out: CacheEntry[] = [];
  for (const line of text.split('\n')) {
    const tab = line.indexOf('\t{');
    if (tab < 0) continue;
    try {
      const rec = JSON.parse(line.slice(tab + 1)) as { key?: string; integrity?: string };
      if (rec.key) out.push({ key: rec.key, integrity: rec.integrity });
    } catch {
      // a torn index line is not a reason to abandon the other 800
    }
  }
  return out;
}

/** `{ url → integrity }` from tarball cache keys, and `{ name@version → { tarball, integrity } }` from
 *  packument bodies (abbreviated metadata, i.e. `versions[v].dist`). */
export function indexCache(entries: CacheEntry[], readContent: (integrity: string) => string | undefined) {
  const byUrl = new Map<string, string>();
  const byVersion = new Map<string, { tarball?: string; integrity?: string }>();
  for (const e of entries) {
    const m = /^make-fetch-happen:request-cache:(https:\/\/registry\.npmjs\.org\/.+)$/.exec(e.key);
    if (!m) continue;
    const url = m[1];
    if (url.endsWith('.tgz')) {
      if (e.integrity) byUrl.set(url, e.integrity);
      continue;
    }
    if (url.includes('/-/')) continue; // a non-.tgz artifact; not a packument
    const body = e.integrity ? readContent(e.integrity) : undefined;
    if (!body) continue;
    try {
      const pkg = JSON.parse(body) as { versions?: Record<string, { dist?: { tarball?: string; integrity?: string } }> };
      for (const [version, meta] of Object.entries(pkg.versions ?? {})) {
        if (!meta?.dist) continue;
        byVersion.set(`${url.slice(REGISTRY.length)}@${version}`, {
          tarball: meta.dist.tarball,
          integrity: meta.dist.integrity,
        });
      }
    } catch {
      // a packument we cannot read is a missing source, not a wrong one
    }
  }
  return { byUrl, byVersion };
}

/** The two sources must agree; either one alone is enough. Returns the fields or a reason they are absent. */
export function resolveNode(
  name: string,
  version: string,
  sources: ReturnType<typeof indexCache>,
): { resolved: string; integrity: string; source: 'cache' | 'packument' | 'both' } | { error: string } {
  const url = tarballUrl(name, version);
  const fromTarball = sources.byUrl.get(url);
  const pack = sources.byVersion.get(`${name}@${version}`);
  const packUrl = pack?.tarball && pack.tarball.startsWith(REGISTRY) ? pack.tarball : undefined;
  if (packUrl && packUrl !== url && fromTarball) {
    return { error: `tarball URL mismatch: cache says ${url}, packument says ${packUrl}` };
  }
  const integrity = fromTarball ?? pack?.integrity;
  if (!integrity) return { error: 'no tarball in the npm cache and no packument entry' };
  if (fromTarball && pack?.integrity && fromTarball !== pack.integrity) {
    return { error: `integrity mismatch: cache ${fromTarball} vs packument ${pack.integrity}` };
  }
  return { resolved: url, integrity, source: fromTarball && pack?.integrity ? 'both' : fromTarball ? 'cache' : 'packument' };
}

// --------------------------------------------------------------------------------------------- selftest

function selftest(): void {
  const checks: [string, boolean][] = [];
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  checks.push(['nameOf', eq(nameOf('node_modules/@scope/name'), '@scope/name') && eq(nameOf('node_modules/a/node_modules/b'), 'b')]);
  checks.push([
    'tarballUrl',
    eq(tarballUrl('@solana/web3.js', '1.99.0'), 'https://registry.npmjs.org/@solana/web3.js/-/web3.js-1.99.0.tgz') &&
      eq(tarballUrl('superstruct', '2.0.2'), 'https://registry.npmjs.org/superstruct/-/superstruct-2.0.2.tgz'),
  ]);
  checks.push(['compromised list', isCompromised('@solana/web3.js', '1.95.6') && !isCompromised('@solana/web3.js', '1.99.0')]);

  const lock: Lock = {
    packages: {
      '': { name: 'x' },
      'node_modules/a': { version: '1.0.0' },
      'node_modules/b': { version: '2.0.0', resolved: 'https://registry.npmjs.org/b/-/b-2.0.0.tgz', integrity: 'sha512-x' },
      'node_modules/c': { link: true },
      'backend': { version: '0.2.0' },
    },
  };
  checks.push(['missingNodes skips pinned/link/workspace', eq(missingNodes(lock).map((m) => m.path), ['node_modules/a'])]);
  const aliased: Lock = { packages: { 'node_modules/@coral-xyz/anchor-31': { name: '@coral-xyz/anchor', version: '0.31.1' } } };
  checks.push(['missingNodes uses the real name for an alias', eq(missingNodes(aliased)[0].name, '@coral-xyz/anchor') && eq(missingNodes(aliased)[0].alias, '@coral-xyz/anchor-31')]);

  const entries = parseCacheIndex(
    [
      '\ta\t{"key":"make-fetch-happen:request-cache:https://registry.npmjs.org/a/-/a-1.0.0.tgz","integrity":"sha512-AAA"}',
      'broken line',
      '\tb\t{"key":"make-fetch-happen:request-cache:https://registry.npmjs.org/a","integrity":"sha512-PACK"}',
      '\tc\t{"key":"make-fetch-happen:request-cache:https://registry.npmjs.org/@s/n","integrity":"sha512-SCOPED"}',
    ].join('\n'),
  );
  checks.push(['parseCacheIndex', eq(entries.length, 3)]);
  const bodies: Record<string, string> = {
    'sha512-PACK': JSON.stringify({ versions: { '1.0.0': { dist: { tarball: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz', integrity: 'sha512-AAA' } } } }),
    'sha512-SCOPED': JSON.stringify({ name: '@s/n', versions: { '0.1.0': { dist: { tarball: 'https://registry.npmjs.org/@s/n/-/n-0.1.0.tgz', integrity: 'sha512-BBB' } } } }),
  };
  const src = indexCache(entries, (i) => bodies[i]);
  checks.push(['indexCache', eq(src.byUrl.get('https://registry.npmjs.org/a/-/a-1.0.0.tgz'), 'sha512-AAA') && eq(src.byVersion.get('@s/n@0.1.0')?.integrity, 'sha512-BBB')]);
  checks.push(['resolveNode: both agree', eq(resolveNode('a', '1.0.0', src), { resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz', integrity: 'sha512-AAA', source: 'both' })]);
  checks.push(['resolveNode: packument only', eq(resolveNode('@s/n', '0.1.0', src), { resolved: 'https://registry.npmjs.org/@s/n/-/n-0.1.0.tgz', integrity: 'sha512-BBB', source: 'packument' })]);
  checks.push(['resolveNode: unknown', 'error' in resolveNode('zzz', '9.9.9', src)]);
  const disagree = indexCache(entries, (i) => (i === 'sha512-PACK' ? JSON.stringify({ versions: { '1.0.0': { dist: { tarball: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz', integrity: 'sha512-OTHER' } } } }) : bodies[i]));
  checks.push(['resolveNode: mismatch is an error, not a coin flip', 'error' in resolveNode('a', '1.0.0', disagree)]);

  let bad = 0;
  for (const [name, ok] of checks) {
    if (!ok) {
      bad++;
      console.error(`✗ ${name}`);
    } else console.log(`✓ ${name}`);
  }
  if (bad) {
    console.error(`lock-integrity selftest: ${bad}/${checks.length} failed`);
    process.exit(1);
  }
  console.log(`lock-integrity selftest: ${checks.length}/${checks.length} ok`);
}

// ------------------------------------------------------------------------------------------------ repair

/** Read the whole cache index into memory (`index-v5` is a few MB; content files are read on demand). */
function readCacheIndex(): { entries: CacheEntry[]; readContent: (integrity: string) => string | undefined } {
  const dir = join(homedir(), '.npm', '_cacache');
  const entries: CacheEntry[] = [];
  let files: string[] = [];
  try {
    for (const a of readdirSync(join(dir, 'index-v5')))
      for (const b of readdirSync(join(dir, 'index-v5', a)))
        for (const c of readdirSync(join(dir, 'index-v5', a, b))) files.push(join(dir, 'index-v5', a, b, c));
  } catch {
    console.error(`no npm cache index at ${dir}/index-v5 — run \`npm ci\` once, then retry`);
    process.exit(2);
  }
  for (const f of files) entries.push(...parseCacheIndex(readFileSync(f, 'utf8')));
  const readContent = (integrity: string): string | undefined => {
    const [algo, b64] = integrity.split('-', 2);
    if (!algo || !b64) return undefined;
    const hex = Buffer.from(b64, 'base64').toString('hex');
    try {
      return readFileSync(join(dir, 'content-v2', algo, hex.slice(0, 2), hex.slice(2, 4), hex.slice(4)), 'utf8');
    } catch {
      return undefined;
    }
  };
  return { entries, readContent };
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) return selftest();
  const write = args.includes('--write');
  const lock = JSON.parse(readFileSync(LOCK, 'utf8')) as Lock;
  const missing = missingNodes(lock);
  if (!missing.length) {
    console.log('lock-integrity: every registry node already carries resolved + integrity');
    return;
  }
  if (!write) {
    // check mode: report the pins that *could* be restored, then fail — like `npm-lock-matrix.ts`, a
    // checker that exits 0 while printing findings is a checker nobody wires into CI.
    for (const node of missing) console.error(`  MISSING  ${node.path}@${node.version}`);
    console.error(`lock-integrity: ${missing.length} node(s) have no resolved/integrity — \`npm ci\` would install unverified bytes. Run with --write (see the header for what that uses)`);
    process.exit(1);
  }
  const { entries, readContent } = readCacheIndex();
  const sources = indexCache(entries, readContent);
  console.log(`lock-integrity: ${missing.length} node(s) unpinned, ${sources.byUrl.size} tarball(s) + ${sources.byVersion.size} version(s) in the npm cache`);
  const filled: string[] = [];
  const failed: string[] = [];
  for (const node of missing) {
    const hit = resolveNode(node.name, node.version, sources);
    if ('error' in hit) {
      failed.push(`${node.path}@${node.version}: ${hit.error}`);
      continue;
    }
    if (write) {
      // npm writes `version`, `resolved`, `integrity` in that order: insert the two fields after `version`
      // and keep every other key where it was, so the diff is additions only.
      const ordered: Node = {};
      for (const [key, value] of Object.entries(lock.packages[node.path])) {
        if (key === 'resolved' || key === 'integrity') continue;
        ordered[key] = value;
        if (key === 'version') {
          ordered.resolved = hit.resolved;
          ordered.integrity = hit.integrity;
        }
      }
      lock.packages[node.path] = ordered;
    }
    filled.push(`${node.path}@${node.version}${node.name === node.alias ? '' : ` (npm:${node.name})`} ← ${hit.source}`);
  }
  for (const f of filled) console.log(`  ${write ? 'pin' : 'can pin'} ${f}`);
  for (const f of failed) console.log(`  MISS  ${f}`);
  if (write && filled.length) {
    writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
    console.log(`lock-integrity: wrote ${filled.length} pin(s) into package-lock.json`);
  }
  if (failed.length) {
    console.error(`lock-integrity: ${failed.length} node(s) could not be pinned from the cache — run \`npm ci\` (or \`npm cache add <name>@<version>\`) and retry`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main();
