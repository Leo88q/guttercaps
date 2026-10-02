// M-9 gate. `npm run secret:scan` used to be nothing: the `security` job was named "npm audit + secret
// scan" and its secret half was `scripts/committed-keypapers.ts`, which reads `git ls-files` — the
// current tree only — and knows one secret class. A credential committed in one commit and deleted in
// the next was invisible to it forever, and an API key was invisible to it always.
//
// scripts/secret-scan.ts closes that by walking the object database. This file is the half that keeps
// it closed, and it is deliberately not a re-implementation of the scanner: it asserts the properties
// that make the scanner *mean* something, on a repository it builds itself:
//   * a secret in a blob that no commit points at any more is still a hit — the whole point;
//   * the allow-list (tests/localnet/fixtures/) is what suppresses a fixture, not a broken regex;
//   * the things that look like secrets and are not (sha256 digests, 40-hex git SHAs, two-segment
//     JWT-likes, base58 public keys) stay clean, or the gate gets deleted on the first false positive;
//   * CI actually checks out history and actually runs the scan — a perfect script behind a shallow
//     checkout is a gate that only ever sees today.
// Runs offline in `npm run security:static`.
//   node --experimental-strip-types --no-warnings --test tests/security/secret-scan.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED_PREFIXES, MAX_BLOB_BYTES, RULES, isKeypairContent, scan, scanBlob } from '../../scripts/secret-scan.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');

/** A 64-uint8 array: solana-keygen's default output. */
const keypair = JSON.stringify(Array.from({ length: 64 }, (_, i) => (i * 7 + 13) % 256));
/** 35 chars after `AIza` — exactly what the rule demands, so the probe cannot pass for the wrong reason. */
const googleKey = `AIza${'B'.repeat(35)}`;
// Assembled, not written out: this file is scanned by the rules it tests, so a literal PEM block in the
// source is a hit against tests/security/secret-scan.test.ts and a gate that fails on its own fixture.
// The runtime value is still exactly what the rule matches.
const pem = ['-----BEGIN ' + 'RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEA', '-----BEGIN '.replace('BEGIN', 'END') + ' RSA PRIVATE KEY-----'].join('\n');

/**
 * Build a throwaway repository with real history: commit a file, then delete it. A depth-1 clone of
 * the sandbox cannot express that, and a gate that cannot be shown to fail is decoration.
 */
function scratchRepo(files: Record<string, string>, thenDelete: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'guttercaps-secret-scan-'));
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  };
  git('init', '--quiet', '.');
  git('config', 'user.email', 'gate@example.invalid');
  git('config', 'user.name', 'gate');
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  git('add', '-A');
  git('commit', '--quiet', '-m', 'add');
  for (const path of thenDelete) {
    rmSync(join(dir, path), { force: true });
    git('add', '-A');
    git('commit', '--quiet', '-m', 'remove');
  }
  return dir;
}

test('a secret in a deleted blob is still a hit', async () => {
  // The regression this whole script exists for: the file is gone from the tree, so `git ls-files`
  // (and therefore `npm run keypairs:scan`) sees nothing. The blob is still in the object database,
  // still in every clone, and still a live credential.
  const pretty = '[\n' + Array.from({ length: 64 }, (_, i) => `  ${(i * 7 + 13) % 256}`).join(',\n') + '\n]';
  const dir = scratchRepo({ 'notes/old-keypair.json': pretty, 'README.md': '# scratch\n' }, ['notes/old-keypair.json']);
  try {
    const { hits, scanned, error } = await scan(dir);
    assert.equal(error, undefined, `the scan itself must not error: ${error}`);
    assert.ok(scanned >= 1, 'the scratch repo must yield at least one blob');
    const hit = hits.find((h) => h.rule === 'solana-keypair');
    assert.ok(hit, `expected a solana-keypair hit, got ${JSON.stringify(hits)}`);
    assert.equal(hit.path, 'notes/old-keypair.json');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a non-keypair secret class is caught in history too', async () => {
  const dir = scratchRepo({ '.env.prod': `GOOGLE_KEY=${googleKey}\n` }, ['.env.prod']);
  try {
    const { hits } = await scan(dir);
    assert.deepEqual(hits.map((h) => h.rule), ['google-api-key']);
    assert.equal(hits[0]!.path, '.env.prod');
    assert.equal(hits[0]!.line, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the allow-list suppresses a fixture, and only the allow-list does', async () => {
  const fixture = `${ALLOWED_PREFIXES[0]}authority.json`;
  assert.equal(ALLOWED_PREFIXES.length, 1, 'one allow-list prefix: tests/localnet/fixtures/');
  const dir = scratchRepo({ [fixture]: keypair }, []);
  try {
    const { hits } = await scan(dir);
    assert.deepEqual(hits, [], 'a fixture keypair is the point of the tree, not a leak');

    // Mutation: take the allow-list off the keypair rule and the very same blob must fire. If it does
    // not, the allow-list was never what was suppressing it and the assertion above was vacuous.
    const withoutAllow = RULES.map((r) => (r.id === 'solana-keypair' ? { ...r, allow: [] } : r));
    assert.ok(scanBlob('0'.repeat(40), fixture, keypair, withoutAllow).length > 0,
      'without the allow-list the fixture keypair must fire');
    // And the scan is not hardcoding the answer: no rules, no hits, same input.
    assert.deepEqual(scanBlob('0'.repeat(40), fixture, keypair, []), [], 'no rules, no hits');

    // The same keypair one directory outside the allow-list still fires — from the object database,
    // so it has to be committed, not just written to the working tree.
    writeFileSync(join(dir, 'elsewhere.json'), keypair);
    spawnSync('git', ['add', '-A'], { cwd: dir });
    spawnSync('git', ['commit', '--quiet', '-m', 'elsewhere'], { cwd: dir });
    const { hits: hits2 } = await scan(dir);
    assert.ok(hits2.some((h) => h.rule === 'solana-keypair' && h.path === 'elsewhere.json'),
      'the same keypair outside tests/localnet/fixtures/ must fire');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isKeypairContent: 64 uint8s and nothing else', () => {
  assert.equal(isKeypairContent(keypair), true);
  const pretty = '[\n' + Array.from({ length: 64 }, (_, i) => `  ${(i * 7 + 13) % 256}`).join(',\n') + '\n]';
  assert.equal(isKeypairContent(pretty), true, 'a pretty-printed 64-byte array is still a keypair');
  assert.ok(scanBlob('0'.repeat(40), 'leaked.json', pretty).some((h) => h.rule === 'solana-keypair'),
    'a multiline keypair must be flagged — a line-only scan misses it');
  assert.equal(isKeypairContent(JSON.stringify({ 'rights.title': 'nilai' })), false, 'a locale object is not a keypair');
  assert.equal(isKeypairContent(JSON.stringify(Array.from({ length: 63 }, (_, i) => i % 256))), false, '63 bytes is not a keypair');
  assert.equal(isKeypairContent(JSON.stringify(Array.from({ length: 64 }, () => 999))), false, 'values above 255 are not keypair bytes');
  assert.equal(isKeypairContent(JSON.stringify(Array.from({ length: 64 }, () => 1.5))), false, 'non-integers are not keypair bytes');
  assert.equal(isKeypairContent('[999,999,999]'), false, 'out-of-range digits must not read as bytes');
  assert.equal(isKeypairContent('not json'), false, 'unparseable is not a keypair');
});

test('things that look like secrets and are not stay clean', () => {
  // A gate that fires on these gets disabled by the first person it annoys, so the negatives are part
  // of the contract, not documentation.
  const noise = [
    ['sha256 digest in a lockfile', 'Cargo.lock', 'checksum = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"'],
    ['a 40-hex git sha in a changelog', 'CHANGELOG.md', 'fd7e92b56fcda8f2fd6e4c08d7e43e92f4ae9e22'],
    ['a two-segment JWT-like', 'docs/notes.md', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0'],
    ['a base58 solana public key', 'client/src/api/ws.ts', 'const PROGRAM = "ChpGame1111111111111111111111111111111111";'],
    ['prose about a private key', 'README.md', 'Never commit a private key. Rotate it instead.'],
    ['a CSP nonce', 'client/src/api/csp.ts', 'nonce-2726c7f26c9a1b6c8d4e0f3a5b7c9d1e'],
    ['an empty file', 'client/public/robots.txt', ''],
  ] as const;
  for (const [what, path, body] of noise) {
    assert.deepEqual(scanBlob('0'.repeat(40), path, body), [], `${what} must not be flagged (${path})`);
  }
  // The size cap is what keeps 3 MB of generated landing HTML out of the rule set.
  assert.ok(MAX_BLOB_BYTES <= 1_048_576, 'the blob cap must stay small enough to skip generated art');
  assert.equal(scanBlob('0'.repeat(40), 'big.txt', 'x'.repeat(MAX_BLOB_BYTES + 1)).length, 0, 'a blob over the cap is skipped before its body is read');
});

test('the rule set stays enumerable and self-labelled', () => {
  const names = RULES.map((r) => r.id);
  assert.deepEqual(names, [...new Set(names)], 'rule names must be unique');
  const required = ['solana-keypair', 'private-key-pem', 'aws-access-key-id', 'github-token', 'slack-token', 'google-api-key', 'stripe-secret-key', 'jwt', 'openai-key'];
  for (const name of required) assert.ok(names.includes(name), `${name} is a class this tree can actually hold`);
  // Every rule must be demonstrable: `--selftest` proves each one fires on its own probe, so a rule
  // that can only ever fail cannot be carried silently.
  const selftest = spawnSync('node', ['--experimental-strip-types', '--no-warnings', join(REPO, 'scripts/secret-scan.ts'), '--selftest'], { encoding: 'utf8', cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(selftest.status, 0, `--selftest must pass:\n${selftest.stdout}\n${selftest.stderr}`);
  assert.match(selftest.stdout, /selftest: all \d+ cases pass/);
});

test('ci checks out history and runs the scan', () => {
  // A full-history scanner behind the default depth-1 checkout is a gate that only ever sees today.
  const ci = read('.github/workflows/ci.yml');
  const start = ci.indexOf('\n  security:');
  assert.ok(start >= 0, 'the security job must exist in .github/workflows/ci.yml');
  const after = ci.slice(start + 1);
  const next = after.slice(1).search(/^  [a-z][\w-]*:/m);
  const security = next < 0 ? after : after.slice(0, next + 1);
  assert.match(security, /- uses: actions\/checkout@[0-9a-f]{40} # v[\d.]+\n\s+with: \{ fetch-depth: 0 \}/,
    'the security job checkout must be a full-SHA ref AND fetch-depth: 0');
  assert.match(security, /npm run secret:scan -- --selftest[\s\S]*npm run secret:scan/,
    'the security job must run the selftest and then the scan');
  // The scan has to be reachable the way every other gate is.
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assert.match(pkg.scripts['secret:scan']!, /scripts\/secret-scan\.ts/);
  // Nothing else in the job may go un-pinned while we are here: the same SEC-B50 rule as everywhere.
  const unpinned = [...security.matchAll(/- uses: (\S+)/g)].map((m) => m[1]!).filter((ref) => !/@[0-9a-f]{40}$/.test(ref));
  assert.deepEqual(unpinned, [], `unpinned action refs in the security job: ${unpinned.join(', ')}`);
});

test('the real repository is clean, and the scan is not vacuous here', async () => {
  const { hits, scanned, error } = await scan(REPO);
  assert.equal(error, undefined, `the scan itself must not error: ${error}`);
  assert.ok(scanned > 500, `expected the text blobs of this tree to be scanned, got ${scanned} — the filter is swallowing the repo`);
  assert.deepEqual(hits, [], `${hits.length} secret hit(s) in the object database: ${hits.map((h) => `${h.path}:${h.line} ${h.rule}`).join(', ')}`);
});
