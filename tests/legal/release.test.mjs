import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { assessLegalRelease, checkLegalRelease, legalContext, FEATURES, CONTROLS } from '../../scripts/legal-readiness.mjs';
const hash = s => createHash('sha256').update(s).digest('hex');
const context = { today: '2026-09-29', revision: 'test-revision', counselReviewed: true, documentsSha256: hash('test-only-documents') };
// Shape-only fixture; NOT an operator selection, market opinion, licence or release evidence.
function fixture() {
  return { schemaVersion: 1, status: 'approved', operator: { legalName: 'Synthetic Fixture Limited', legalForm: 'Limited company', country: 'CZ', registrationNumber: 'TEST-ONLY-1234', businessAddress: 'Synthetic test address', supportEmail: 'support@example.org', privacyEmail: 'privacy@example.org', legalNoticeUrl: 'https://example.org/legal' }, review: { revision: context.revision, documentsSha256: context.documentsSha256, approvedAt: '2026-09-28', expiresAt: '2026-10-29', evidenceSha256: hash('test-only-review') }, markets: [{ country: 'CZ', features: Object.fromEntries(FEATURES.map(k => [k, 'approved'])), evidenceSha256: hash('test-only-market') }], controls: Object.fromEntries(CONTROLS.map(k => [k, { status: 'verified', evidenceSha256: hash('test-only-' + k) }])) };
}
test('shape-valid synthetic evidence passes; no external facts are verified', () => assert.deepEqual(assessLegalRelease(fixture(), context), []));
for (const value of [null, [], 'approved', 1]) test(`malformed root ${JSON.stringify(value)} fails closed`, () => assert.ok(assessLegalRelease(value, context).length));
const mutations = {
  'unapproved release': m => { m.status = 'blocked'; },
  'invalid schema': m => { m.schemaVersion = 2; },
  'missing operator': m => { delete m.operator; },
  'blank contact': m => { m.operator.privacyEmail = ''; },
  'placeholder contact': m => { m.operator.supportEmail = 'TODO'; },
  'invalid email': m => { m.operator.supportEmail = 'support'; },
  'private-record field': m => { m.operator.passport = 'must-not-print-this'; },
  'HTTP legal notice': m => { m.operator.legalNoticeUrl = 'http://example.org/legal'; },
  'credential URL': m => { m.operator.legalNoticeUrl = 'https://secret:secret@example.org/legal'; },
  'tokenized URL': m => { m.operator.legalNoticeUrl += '?token=secret'; },
  'invalid contact domain': m => { m.operator.supportEmail = 'support@company.invalid'; },
  'future approval': m => { m.review.approvedAt = '2027-01-01'; },
  'malformed date': m => { m.review.expiresAt = '2026-02-30'; },
  'expired review': m => { m.review.expiresAt = '2026-09-28'; },
  'missing review': m => { delete m.review; },
  'reversed review dates': m => { m.review.expiresAt = '2026-09-27'; },
  'old revision': m => { m.review.revision = 'old'; },
  'stale documents': m => { m.review.documentsSha256 = hash('other'); },
  'zero evidence': m => { m.review.evidenceSha256 = '0'.repeat(64); },
  'no markets': m => { m.markets = []; },
  'null market': m => { m.markets = [null]; },
  'object markets': m => { m.markets = {}; },
  'wildcard worldwide': m => { m.markets[0].country = '*'; },
  'EU is not one cleared country': m => { m.markets[0].country = 'EU'; },
  'CLDR macroregion is not a country': m => { m.markets[0].country = 'QO'; },
  'unknown country': m => { m.markets[0].country = 'ZZ'; },
  'duplicate market': m => { m.markets.push(structuredClone(m.markets[0])); },
  'no country-specific evidence': m => { m.markets[0].evidenceSha256 = ''; },
  'features missing': m => { delete m.markets[0].features; },
  'hidden private top-level field': m => { m.founder = 'must-not-print-this'; },
  'controls missing': m => { delete m.controls; },
};
for (const [name, mutate] of Object.entries(mutations)) test(name, () => {
  const m = fixture(); mutate(m); const issues = assessLegalRelease(m, context);
  assert.ok(issues.length, name); assert.ok(!JSON.stringify(issues).includes('must-not-print-this'));
});
for (const feature of FEATURES) test(`all retained monetization: ${feature} requires approval in each market`, () => { const m = fixture(); m.markets[0].features[feature] = 'pending'; assert.ok(assessLegalRelease(m, context).some(i => i.includes(feature))); });
for (const control of CONTROLS) test(`${control} needs implementation evidence, not only status`, () => { const m = fixture(); m.controls[control].evidenceSha256 = ''; assert.ok(assessLegalRelease(m, context).some(i => i.includes(control))); });
test('a manifest cannot override absent counsel sign-off', () => assert.ok(assessLegalRelease(fixture(), { ...context, counselReviewed: false }).some(i => i.includes('LEGAL_REVIEWED'))));
test('actual repository is blocked without inventing approval', () => { const issues = checkLegalRelease(); assert.ok(issues.some(i => i.includes('LEGAL_REVIEWED'))); assert.ok(issues.some(i => i.startsWith('markets:'))); });
test('missing, malformed manifest and changed translations fail closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'gc-legal-'));
  try {
    assert.ok(checkLegalRelease(root).length);
    mkdirSync(join(root, 'ops/legal'), { recursive: true });
    writeFileSync(join(root, 'ops/legal/launch.json'), '{');
    assert.ok(checkLegalRelease(root).length);
    mkdirSync(join(root, 'client/src/shared/lib'), { recursive: true });
    cpSync('client/src/shared/lib/legal-copy', join(root, 'client/src/shared/lib/legal-copy'), { recursive: true });
    cpSync('client/src/shared/lib/legal.ts', join(root, 'client/src/shared/lib/legal.ts'));
    const a = legalContext(root);
    writeFileSync(join(root, 'client/src/shared/lib/legal-copy/ru.json'), '{}');
    assert.notEqual(legalContext(root).documentsSha256, a.documentsSha256);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('owner-requested removal: legal review is advisory, not a build/deploy prerequisite', () => {
  const read = f => readFileSync(f, 'utf8');
  for (const f of ['client/vite.config.ts', 'scripts/setup.ts', 'scripts/deploy-build-env.ts', '.github/workflows/images.yml']) {
    assert.doesNotMatch(read(f), /assertLegalRelease|checkLegalRelease|npm run legal:check/);
  }
  assert.doesNotMatch(JSON.parse(read('package.json')).scripts['ops:release'], /legal:check/);
  assert.match(read('client/vite.config.ts'), /sourcemap: false/);
  assert.match(read('.github/workflows/images.yml'), /program-ids -- guard-mainnet/);
});
