/** Optional readiness report only. Not wired into any build/deploy. No legal or licence verification. */
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FEATURES = ['randomPacks', 'marketplace', 'staking', 'arenaWagers', 'rewards', 'paidServices'];
export const CONTROLS = ['operatorAndDisclosures', 'jurisdictionAndLicensing', 'cryptoClassification', 'amlSanctionsAndAge', 'consumerRightsAndComplaints', 'privacyRightsAndRetention', 'vendorsAndTransfers', 'securityAndIncidents', 'geoAndOnchainEnforcement', 'taxAndAccounting', 'ipAndDistribution', 'sevenLanguageReview'];
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const object = v => !!v && typeof v === 'object' && !Array.isArray(v);
const filled = v => typeof v === 'string' && !!v.trim() && !/\b(?:todo|tbd|changeme|unknown|pending)\b|[<>]/i.test(v);
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v) && !/^(.)\1+$/.test(v);
const date = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
// ISO 3166-1 alpha-2, explicit rather than CLDR (which also accepts EU, QO and deprecated aliases).
const COUNTRIES = new Set('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' '));
const country = v => typeof v === 'string' && COUNTRIES.has(v);
function publicUrl(v) {
  if (!filled(v)) return false;
  try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash && u.hostname.includes('.') && !/^(?:localhost|127\.|0\.)|\.(?:invalid|example|test|localhost)$/i.test(u.hostname); } catch { return false; }
}
function email(v) { return filled(v) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && !/\.(?:invalid|example|test)$/i.test(v); }

export function assessLegalRelease(input, context) {
  const issues = [];
  if (!object(input)) return ['manifest: expected an object'];
  const only = (obj, keys, path) => { if (object(obj)) for (const k of Object.keys(obj)) if (!keys.includes(k)) issues.push(`${path}: unexpected field (keep private evidence and personal team records out of this public manifest)`); };
  only(input, ['schemaVersion', 'status', 'operator', 'review', 'markets', 'controls'], 'manifest');
  if (input.schemaVersion !== 1) issues.push('schemaVersion: expected 1');
  if (input.status !== 'approved') issues.push('status: release is not approved');
  if (!context.counselReviewed) issues.push('LEGAL_REVIEWED: independent legal sign-off has not been recorded');
  const op = object(input.operator) ? input.operator : {};
  const fields = ['legalName', 'legalForm', 'country', 'registrationNumber', 'businessAddress', 'supportEmail', 'privacyEmail', 'legalNoticeUrl'];
  only(op, fields, 'operator');
  for (const field of fields) if (!filled(op[field])) issues.push(`operator.${field}: required public operator information is missing`);
  if (!country(op.country)) issues.push('operator.country: use a specific country code, not a global region');
  for (const field of ['supportEmail', 'privacyEmail']) if (!email(op[field])) issues.push(`operator.${field}: a working role contact is required`);
  if (!publicUrl(op.legalNoticeUrl)) issues.push('operator.legalNoticeUrl: a public HTTPS legal notice is required');
  const review = object(input.review) ? input.review : {};
  only(review, ['revision', 'documentsSha256', 'approvedAt', 'expiresAt', 'evidenceSha256'], 'review');
  if (review.revision !== context.revision) issues.push('review.revision: stale legal revision');
  if (!hash(review.documentsSha256) || review.documentsSha256 !== context.documentsSha256) issues.push('review.documentsSha256: documents changed or have not been reviewed');
  if (!hash(review.evidenceSha256)) issues.push('review.evidenceSha256: missing private review evidence fingerprint');
  if (!date(review.approvedAt) || review.approvedAt > context.today) issues.push('review.approvedAt: missing, invalid or future date');
  if (!date(review.expiresAt) || review.expiresAt < context.today || review.expiresAt < review.approvedAt) issues.push('review.expiresAt: expired or invalid review');
  if (!Array.isArray(input.markets) || !input.markets.length) issues.push('markets: no individually approved markets; international is not an approval');
  const seen = new Set();
  for (const [i, m] of (Array.isArray(input.markets) ? input.markets : []).entries()) {
    if (!object(m)) { issues.push(`markets[${i}]: invalid entry`); continue; }
    only(m, ['country', 'features', 'evidenceSha256'], `markets[${i}]`);
    if (!country(m.country) || seen.has(m.country)) issues.push(`markets[${i}].country: invalid or duplicate country`);
    seen.add(m.country);
    if (!hash(m.evidenceSha256)) issues.push(`markets[${i}].evidenceSha256: missing country-specific review`);
    only(m.features, FEATURES, `markets[${i}].features`);
    for (const feature of FEATURES) if (!object(m.features) || m.features[feature] !== 'approved') issues.push(`markets[${i}].${feature}: current product feature is not approved`);
  }
  only(input.controls, CONTROLS, 'controls');
  for (const name of CONTROLS) {
    const control = object(input.controls) ? input.controls[name] : undefined;
    only(control, ['status', 'evidenceSha256'], `controls.${name}`);
    if (!object(control) || control.status !== 'verified' || !hash(control.evidenceSha256)) issues.push(`controls.${name}: implementation and review evidence required`);
  }
  return issues;
}

export function legalContext(root = ROOT, today = new Date().toISOString().slice(0, 10)) {
  const base = join(root, 'client/src/shared/lib');
  const code = readFileSync(join(base, 'legal.ts'), 'utf8');
  const files = ['legal.ts', ...readdirSync(join(base, 'legal-copy')).filter(f => f.endsWith('.json')).map(f => 'legal-copy/' + f)].sort();
  const documentsSha256 = createHash('sha256').update(JSON.stringify(files.map(f => [f, readFileSync(join(base, f), 'utf8')]))).digest('hex');
  return { today, revision: /^export const LEGAL_REVISION = '([^']+)'/m.exec(code)?.[1], counselReviewed: /^export const LEGAL_REVIEWED = true;$/m.test(code), documentsSha256 };
}
export function checkLegalRelease(root = ROOT) {
  try { return assessLegalRelease(JSON.parse(readFileSync(join(root, 'ops/legal/launch.json'), 'utf8')), legalContext(root)); }
  catch { return ['manifest/documents: missing, malformed or unreadable; refusing approval']; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--fingerprint')) console.log(legalContext().documentsSha256);
  else {
    const issues = checkLegalRelease();
    console.log(JSON.stringify({ status: issues.length ? 'blocked' : 'evidence-recorded', issues, notice: 'Structural/evidence checks only; no verification of licences, external documents or legal conclusions.' }, null, 2));
    process.exitCode = issues.length ? 1 : 0;
  }
}
