// "No committed keypairs outside tests/localnet/fixtures" as a gate, not a one-line grep.
//
// The inline CI step used to flag every tracked path matching `(-keypair|keypair|id)\.json$`. The
// `keypair` halves are fine — no translation is called `*keypair*.json` — but the bare `id` half
// collides with the Indonesian locale filename: `client/src/shared/i18n/*/id.json` and
// `scripts/landing/locales/id.json` are translations ("id" is the ISO 639-1 code), and every one
// of them burned the security job as a "committed keypair". The same suffix also swallows any
// file that merely *ends* in `id.json` (`valid.json`, `grid-id.json`).
//
// So the name gate stays, split by how damning the name is:
//   * `*keypair*.json` outside the fixtures allowlist — flagged by name alone (solana deploy
//     keypairs, `solana-keygen new -o …-keypair.json`);
//   * any path ending in `id.json` (solana-keygen's default output `id.json` included) — decided
//     by content: a keypair is a JSON array of exactly 64 uint8s, a locale file is an object of
//     strings. A leaked `id.json` is always an array; no translation ever is.
// Fixtures stay allowed: tests/localnet/fixtures carries the committed mock oracle keypair on
// purpose (the localnet specs import it), same exclusion the old step and .gitignore had.
//
//   npm run keypairs:scan               # scan the tracked tree (fails on hits)
//   npm run keypairs:scan -- --selftest # offline: the predicates on synthetic files
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// git semantics, not the script's own location: the tracked tree of the repo the caller stands in
// (`npm run` executes at the package root, so CI scans the full tree either way).
const ROOT = process.cwd();

/** Trees where a committed keypair is the point, not a leak (mirrors .gitignore's allowlist). */
export const ALLOWED_PREFIXES = ['tests/localnet/fixtures/'];

/** `sb_mock-keypair.json`, `target/deploy/guttercaps-keypair.json`, `keypair.json` — name alone is damning. */
const KEYPAIR_NAME = /keypair\.json$/;

/** `id.json` and everything that merely ends in it (`grid-id.json`, `valid.json`) — content decides. */
const ID_NAME = /id\.json$/i;

/** A solana-keygen output is a JSON array of exactly 64 bytes; anything else (a locale object, a config) is not one. */
export function isKeypairContent(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      && parsed.length === 64
      && parsed.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 255);
  } catch {
    return false;
  }
}

export interface TrackedFile { path: string; /** file body, or null when unreadable (fail-closed for id-candidates) */ content: string | null }

export interface ScanResult { hits: string[]; /** `id.json`-suffixed files whose body was inspected */ inspected: string[] }

/** Pure walk of the tracked list, so the selftest and the tests need no git and no temp files. */
export function scan(files: TrackedFile[]): ScanResult {
  const hits: string[] = [];
  const inspected: string[] = [];
  for (const file of files) {
    if (ALLOWED_PREFIXES.some((p) => file.path === p || file.path.startsWith(p))) continue;
    if (KEYPAIR_NAME.test(file.path)) { hits.push(file.path); continue; }
    if (basename(file.path) === 'id.json' || ID_NAME.test(file.path)) {
      inspected.push(file.path);
      // fail-closed: an unreadable id-candidate cannot be proven to be a translation
      if (file.content === null || isKeypairContent(file.content)) hits.push(file.path);
    }
  }
  return { hits, inspected };
}

// --------------------------------------------------------------------------- selftest

function selftest(): number {
  const locale = JSON.stringify({ 'nav.world': 'Dunia', 'nav.how': 'Cara bermain', deep: { key: 'nilai' } });
  const keypair = JSON.stringify(Array.from({ length: 64 }, (_, i) => (i * 7 + 13) % 256));
  const notKeypair63 = JSON.stringify(Array.from({ length: 63 }, (_, i) => i % 256));
  const notKeypairRange = JSON.stringify(Array.from({ length: 64 }, () => 999));
  const cases: Array<{ file: TrackedFile; want: boolean; why: string }> = [
    { file: { path: 'client/src/shared/i18n/rights/id.json', content: locale }, want: false, why: 'Indonesian locale must not be flagged (the regression)' },
    { file: { path: 'scripts/landing/locales/id.json', content: locale }, want: false, why: 'landing locale must not be flagged' },
    { file: { path: 'client/src/shared/i18n/rights/id.json', content: keypair }, want: true, why: 'a leaked keypair under a locale-style path must be flagged' },
    { file: { path: 'id.json', content: keypair }, want: true, why: 'solana-keygen default output at the root must be flagged' },
    { file: { path: 'ops/keys/grid-id.json', content: keypair }, want: true, why: 'suffix-id.json with a keypair body must be flagged' },
    { file: { path: 'ops/keys/valid.json', content: locale }, want: false, why: '…but a file merely ending in id.json with a non-keypair body must not be' },
    { file: { path: 'target/deploy/guttercaps-keypair.json', content: locale }, want: true, why: '*keypair.json is damning by name even with a non-keypair body' },
    { file: { path: 'keypair.json', content: keypair }, want: true, why: 'bare keypair.json must be flagged' },
    { file: { path: 'tests/localnet/fixtures/sb_mock-keypair.json', content: keypair }, want: false, why: 'the committed fixture stays allowed' },
    { file: { path: 'tests/localnet/fixtures/id.json', content: keypair }, want: false, why: 'the whole fixtures tree stays allowed' },
    { file: { path: 'ambiguous/id.json', content: null }, want: true, why: 'unreadable id-candidate fails closed' },
    { file: { path: 'ambiguous/id.json', content: notKeypair63 }, want: false, why: '63 bytes is not a keypair' },
    { file: { path: 'ambiguous/id.json', content: notKeypairRange }, want: false, why: 'values above 255 are not keypair bytes' },
    { file: { path: 'ambiguous/id.json', content: 'not json' }, want: false, why: 'unparseable body is not a keypair' },
  ];
  let failed = 0;
  for (const c of cases) {
    const got = scan([c.file]).hits.length > 0;
    if (got !== c.want) { console.error(`selftest: ${c.why} — wanted ${c.want ? 'flagged' : 'clean'}, got ${got ? 'flagged' : 'clean'} (${c.file.path})`); failed++; }
  }
  if (failed > 0) { console.error(`selftest: ${failed}/${cases.length} cases failed`); return 1; }
  console.log(`selftest: all ${cases.length} cases pass`);
  return 0;
}

function main(argv: string[]): number {
  if (argv.includes('--selftest')) return selftest();
  const ls = spawnSync('git', ['ls-files'], { encoding: 'utf8', cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  if (ls.status !== 0 || ls.error) { console.error('git ls-files failed:', ls.stderr || ls.error?.message); return 2; }
  const files: TrackedFile[] = ls.stdout.split('\n').filter(Boolean).map((path) => ({
    path,
    // only id-candidates pay the read; the name-flagged and the allowed need no body
    content: basename(path) === 'id.json' || ID_NAME.test(path)
      ? (() => { try { return readFileSync(join(ROOT, path), 'utf8'); } catch { return null; } })()
      : undefined,
  }));
  const { hits, inspected } = scan(files);
  if (inspected.length > 0) console.log(`id.json-suffixed files inspected by content: ${inspected.length}`);
  if (hits.length === 0) { console.log('no committed keypairs outside tests/localnet/fixtures'); return 0; }
  console.error('keypair files committed:');
  for (const h of hits) console.error(`  ${h}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main(process.argv.slice(2)));
