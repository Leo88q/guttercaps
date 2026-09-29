// Gate for the gate (same shape as the other tests/security files): the "no committed keypairs"
// step used to be an inline `grep -E '(-keypair|keypair|id)\.json$'` in ci.yml, and its bare `id`
// half matched every Indonesian locale file — `id` is the ISO 639-1 code, so
// `client/src/shared/i18n/*/id.json` and `scripts/landing/locales/id.json` each burned the security
// job as a "committed keypair". The predicates now live in scripts/committed-keypairs.ts
// (`npm run keypairs:scan`); this file pins them:
//   * the actually tracked `id.json` locale files stay clean (regression on the real tree),
//   * a 64-uint8 array is a keypair wherever it hides, a locale object never is,
//   * `*keypair*.json` stays damning by name, the fixtures tree stays allowed.
// Runs offline in `npm run security:static`.
//   node --experimental-strip-types --test tests/security/committed-keypairs.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED_PREFIXES, isKeypairContent, scan, type TrackedFile } from '../../scripts/committed-keypairs.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');

const locale = JSON.stringify({ 'rights.title': 'Usia, pengembalian dana & privasi', deep: { key: 'nilai' } });
const keypair = JSON.stringify(Array.from({ length: 64 }, (_, i) => (i * 7 + 13) % 256));
const flagged = (file: TrackedFile): boolean => scan([file]).hits.length > 0;

test('isKeypairContent: a solana-keygen output is 64 uint8s, nothing else is', () => {
  assert.equal(isKeypairContent(keypair), true);
  assert.equal(isKeypairContent(locale), false, 'a locale object is not a keypair');
  assert.equal(isKeypairContent('not json'), false, 'unparseable body is not a keypair');
  assert.equal(isKeypairContent(JSON.stringify(Array.from({ length: 63 }, (_, i) => i % 256))), false, '63 bytes is not a keypair');
  assert.equal(isKeypairContent(JSON.stringify(Array.from({ length: 64 }, () => 999))), false, 'values above 255 are not keypair bytes');
  assert.equal(isKeypairContent(JSON.stringify(Array.from({ length: 64 }, () => 1.5))), false, 'non-integers are not keypair bytes');
});

test('the tracked Indonesian locale files are not flagged (the regression)', () => {
  // the five paths the old grep burned on, pinned here for the record…
  const known = [
    'client/src/shared/i18n/diagnostics/id.json',
    'client/src/shared/i18n/failures/id.json',
    'client/src/shared/i18n/rights/id.json',
    'client/src/shared/lib/legal-copy/id.json',
    'scripts/landing/locales/id.json',
  ];
  // …and whatever `id.json`-suffixed files are tracked right now, so a future locale tree is covered too
  const tracked = spawnSync('git', ['ls-files'], { encoding: 'utf8', cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(tracked.status, 0, 'git ls-files must succeed');
  const idFiles = [...new Set([...known, ...tracked.stdout.split('\n').filter((f) => /id\.json$/.test(f))])];
  assert.ok(idFiles.length >= known.length, 'the known locale files must exist on the tracked tree');
  for (const path of idFiles) {
    assert.equal(flagged({ path, content: read(path) }), false, `${path} is a translation, not a keypair`);
  }
});

test('scan: name-flagged, content-flagged and allowed cases', () => {
  assert.equal(flagged({ path: 'target/deploy/guttercaps-keypair.json', content: locale }), true, '*keypair.json is damning by name even with a non-keypair body');
  assert.equal(flagged({ path: 'id.json', content: keypair }), true, 'solana-keygen default output at the root is flagged');
  assert.equal(flagged({ path: 'ops/keys/grid-id.json', content: keypair }), true, 'suffix-id.json with a keypair body is flagged');
  assert.equal(flagged({ path: 'ops/keys/valid.json', content: locale }), false, 'a file merely ending in id.json with a non-keypair body is not');
  assert.equal(flagged({ path: 'ambiguous/id.json', content: null }), true, 'an unreadable id-candidate fails closed');
});

test('the fixtures allowlist still covers the committed mock oracle keypair', () => {
  assert.deepEqual(ALLOWED_PREFIXES, ['tests/localnet/fixtures/']);
  assert.equal(flagged({ path: 'tests/localnet/fixtures/sb_mock-keypair.json', content: keypair }), false);
  assert.equal(flagged({ path: 'tests/localnet/fixtures/id.json', content: keypair }), false, 'the whole fixtures tree stays allowed');
});
