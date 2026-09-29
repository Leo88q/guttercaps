// Service access, self-declared age and a rights/helpdesk ledger. Never signs or pays funds.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import { type Db, now } from './db.ts';
import { geoOf, geoOptions } from './geo.ts';
import { upsert } from './sql.ts';
import { ServiceError } from './services.ts';

export const FEATURES = ['packs', 'market', 'staking', 'arena', 'rewards', 'services', 'fusion'] as const;
export type Feature = typeof FEATURES[number];
export const KINDS = ['refund', 'withdrawal', 'privacy_access', 'privacy_erase', 'privacy_correct', 'privacy_restrict', 'privacy_object'] as const;
export const STATUSES = ['received', 'in_review', 'answered', 'closed'] as const;
export interface AccessPolicy {
  revision: string; minimumAge: number; countryMinimumAge: Record<string, number>;
  declarationDays: number; deniedRetryDays: number; closedRequestRetentionDays: number;
  features: Record<Feature, { allow: string[] | null; deny: string[] }>;
}
const COUNTRIES = new Set('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' '));
const countryCode = (v: unknown): v is string => typeof v === 'string' && COUNTRIES.has(v);
const integer = (v: unknown, min: number, max: number) => Number.isInteger(v) && Number(v) >= min && Number(v) <= max;
export function validatePolicy(p: AccessPolicy): AccessPolicy {
  if (!p || typeof p.revision !== 'string' || !/^[a-zA-Z0-9.-]{1,64}$/.test(p.revision) || !integer(p.minimumAge, 18, 99)
    || !integer(p.declarationDays, 1, 365) || !integer(p.deniedRetryDays, 1, 365) || !integer(p.closedRequestRetentionDays, 1, 3650)
    || !p.countryMinimumAge || Array.isArray(p.countryMinimumAge)) throw new Error('Invalid access policy');
  for (const [c, age] of Object.entries(p.countryMinimumAge)) if (!countryCode(c) || !integer(age, p.minimumAge, 99)) throw new Error('Invalid country age');
  for (const f of FEATURES) {
    const r = p.features?.[f];
    if (!r || (r.allow !== null && (!Array.isArray(r.allow) || !r.allow.every(countryCode))) || !Array.isArray(r.deny) || !r.deny.every(countryCode)) throw new Error('Invalid feature market policy');
  }
  return p;
}
export const loadPolicy = (): AccessPolicy => validatePolicy(JSON.parse(readFileSync(new URL('../access-policy.json', import.meta.url), 'utf8')));
export const enforcementEnabled = () => {
  // Temporary owner-selected default: no age/country enforcement, including production.
  // Explicit 1 re-enables it; privacy restrictions and authentication are independent.
  const value = process.env.COMPLIANCE_ENFORCE ?? '0';
  if (!['0', '1'].includes(value)) throw new Error('COMPLIANCE_ENFORCE must be 0 or 1');
  return value === '1';
};
export function detectedCountry(headers: IncomingHttpHeaders): string | null {
  const geo = geoOf(headers, { ...geoOptions(), mode: 'shop', unknown: 'block', restricted: new Set() });
  return geo.source === 'header' && countryCode(geo.country) ? geo.country : null;
}
export interface AgeRow { wallet: string; passed: number; minimum_age: number; policy_revision: string; declared_at: number; expires_at: number }
export function accessState(db: Db, wallet: string, country: string | null, policy: AccessPolicy, enabled: boolean, time = now()) {
  const minimumAge = country ? policy.countryMinimumAge[country] ?? policy.minimumAge : policy.minimumAge;
  const row = db.get<AgeRow>('SELECT * FROM age_declarations WHERE wallet = ?', wallet);
  const age = !row ? 'missing' : row.expires_at <= time ? 'expired' : !row.passed ? 'denied' : row.policy_revision !== policy.revision || row.minimum_age < minimumAge ? 'expired' : 'declared';
  const restricted = !!db.get('SELECT wallet FROM privacy_restrictions WHERE wallet = ? AND resumed_at IS NULL', wallet);
  const features = Object.fromEntries(FEATURES.map(f => {
    const rule = policy.features[f];
    // A privacy restriction remains effective even if age/geo enforcement is switched off.
    const reason = restricted ? 'privacy_restricted' : !enabled ? null : !country ? 'country_unknown' : rule.deny.includes(country) || (rule.allow !== null && !rule.allow.includes(country)) ? 'region_restricted' : age === 'denied' ? 'age_denied' : age !== 'declared' ? 'age_required' : null;
    return [f, { allowed: reason === null, reason }];
  })) as Record<Feature, { allowed: boolean; reason: string | null }>;
  return { enabled, country, minimumAge, age, expiresAt: row?.expires_at ?? null, policyRevision: policy.revision, restricted, features };
}
export function requireFeature(db: Db, wallet: string, feature: unknown, country: string | null, policy: AccessPolicy, enabled: boolean) {
  if (!FEATURES.includes(feature as Feature)) throw new ServiceError(400, 'bad_request', 'Unknown access feature');
  const state = accessState(db, wallet, country, policy, enabled);
  const decision = state.features[feature as Feature];
  if (!decision.allowed) throw new ServiceError(403, decision.reason!, 'Review eligibility in the account rights centre.', { feature, minimumAge: state.minimumAge });
  return { allowed: true, policyRevision: policy.revision };
}
export function declareAge(db: Db, wallet: string, body: unknown, country: string | null, policy: AccessPolicy, time = now()) {
  const b = body as { birthDate?: unknown; acknowledged?: unknown; policyRevision?: unknown } | null;
  if (!b || b.acknowledged !== true || b.policyRevision !== policy.revision || typeof b.birthDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.birthDate)) throw new ServiceError(400, 'age_declaration_invalid', 'A current declaration and valid birth date are required');
  const dob = new Date(b.birthDate + 'T00:00:00.000Z');
  if (!Number.isFinite(dob.getTime()) || dob.toISOString().slice(0, 10) !== b.birthDate || dob.getTime() > time * 1000 || dob.getUTCFullYear() < 1900) throw new ServiceError(400, 'age_declaration_invalid', 'Invalid birth date');
  const today = new Date(time * 1000);
  const years = today.getUTCFullYear() - dob.getUTCFullYear() - (today.toISOString().slice(5, 10) < b.birthDate.slice(5) ? 1 : 0);
  const minimumAge = country ? policy.countryMinimumAge[country] ?? policy.minimumAge : policy.minimumAge;
  db.tx(() => {
    const old = db.get<AgeRow>('SELECT * FROM age_declarations WHERE wallet = ?', wallet);
    if (old && !old.passed && old.expires_at > time) throw new ServiceError(403, 'age_denied', 'A denied declaration cannot be overwritten during its cooldown; request correction');
    db.run(upsert('age_declarations', ['wallet', 'passed', 'minimum_age', 'policy_revision', 'declared_at', 'expires_at'], ['wallet'], ['passed = excluded.passed', 'minimum_age = excluded.minimum_age', 'policy_revision = excluded.policy_revision', 'declared_at = excluded.declared_at', 'expires_at = excluded.expires_at']), wallet, years >= minimumAge ? 1 : 0, minimumAge, policy.revision, time, time + (years >= minimumAge ? policy.declarationDays : policy.deniedRetryDays) * 86400);
  });
  // No DOB, birth year, document or inferred age is persisted or returned.
}
export interface RightsRequest {
  id: string; wallet: string; idempotency_key: string; body_hash: string; kind: typeof KINDS[number]; signature: string | null;
  message: string; locale: string; status: typeof STATUSES[number]; created_at: number; updated_at: number;
  due_at: number; closed_at: number | null; hold_until: number | null; version: number; policy_revision: string;
}
const fail = (code = 'bad_request', message = 'Invalid request') => new ServiceError(400, code, message);
function text(v: unknown, max = 4000) { if (typeof v !== 'string' || !v.trim() || v.length > max || /[\u0000-\u0008]/.test(v)) throw fail(); return v.trim(); }
export function addMonth(time: number) {
  const d = new Date(time * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, Math.min(d.getUTCDate(), new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 0)).getUTCDate()), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()) / 1000;
}
export function requestView(db: Db, row: RightsRequest) {
  const { idempotency_key: _key, body_hash: _hash, ...publicRow } = row;
  return { ...publicRow, messages: db.all('SELECT id, actor, message, created_at FROM rights_messages WHERE request_id = ? ORDER BY created_at, id', row.id) };
}
export function ownedRequest(db: Db, wallet: string, id: string) {
  const r = db.get<RightsRequest>('SELECT * FROM rights_requests WHERE id = ? AND wallet = ?', id, wallet);
  if (!r) throw new ServiceError(404, 'not_found', 'Request not found');
  return r;
}
export function createRequest(db: Db, wallet: string, input: unknown, policy: AccessPolicy, time = now()) {
  const b = input as Record<string, unknown> | null;
  if (!b || !KINDS.includes(b.kind as never) || typeof b.idempotencyKey !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(b.idempotencyKey) || !['en', 'ru', 'pt', 'es', 'vi', 'id', 'fil'].includes(String(b.locale))) throw fail();
  const message = text(b.message);
  const signature = b.signature ? text(b.signature, 88) : null;
  if (signature && !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) throw fail();
  const bodyHash = createHash('sha256').update(JSON.stringify([b.kind, message, signature, b.locale])).digest('hex');
  return db.tx(() => {
    const existing = db.get<RightsRequest>('SELECT * FROM rights_requests WHERE wallet = ? AND idempotency_key = ?', wallet, b.idempotencyKey as string);
    if (existing) {
      if (existing.body_hash !== bodyHash) throw new ServiceError(409, 'request_conflict', 'Idempotency key belongs to a different request');
      return requestView(db, existing);
    }
    if (db.scalar("SELECT COUNT(*) FROM rights_requests WHERE wallet = ? AND status != 'closed'", wallet) >= 20) throw new ServiceError(429, 'request_limit', 'Use an existing open request to add information');
    const id = randomUUID();
    db.run('INSERT INTO rights_requests (id, wallet, idempotency_key, body_hash, kind, signature, message, locale, status, created_at, updated_at, due_at, policy_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, wallet, b.idempotencyKey as string, bodyHash, b.kind as string, signature, message, b.locale as string, 'received', time, time, String(b.kind).startsWith('privacy_') ? addMonth(time) : time + 14 * 86400, policy.revision);
    if (b.kind === 'privacy_restrict' || b.kind === 'privacy_object') db.run(upsert('privacy_restrictions', ['wallet', 'request_id', 'restricted_at'], ['wallet'], ['request_id = excluded.request_id', 'restricted_at = excluded.restricted_at', 'resumed_at = NULL', 'erased_at = NULL']), wallet, id, time);
    return requestView(db, ownedRequest(db, wallet, id));
  });
}
export function updateRequest(db: Db, id: string, input: unknown, actor: 'operator' | 'user', wallet?: string, time = now()) {
  const b = input as { message?: unknown; status?: unknown; version?: unknown; holdUntil?: unknown } | null;
  if (!b || !integer(b.version, 1, 1e9)) throw fail();
  const message = text(b.message);
  return db.tx(() => {
    const r = wallet ? ownedRequest(db, wallet, id) : db.get<RightsRequest>('SELECT * FROM rights_requests WHERE id = ?', id);
    if (!r) throw new ServiceError(404, 'not_found', 'Request not found');
    if (r.version !== b.version) throw new ServiceError(409, 'request_conflict', 'Refresh the request before replying');
    if (actor === 'user' && r.status === 'closed') throw new ServiceError(409, 'request_closed', 'Create a new request for a closed case');
    const status = actor === 'user' ? 'received' : b.status as RightsRequest['status'];
    if (!STATUSES.includes(status)) throw fail();
    if (actor === 'user' && db.scalar("SELECT COUNT(*) FROM rights_messages WHERE request_id = ? AND actor = 'user'", id) >= 50) throw new ServiceError(429, 'request_limit', 'Message limit reached');
    const holdUntil = actor === 'operator' && b.holdUntil !== undefined ? b.holdUntil : r.hold_until;
    if (actor === 'operator' && b.holdUntil !== undefined && holdUntil !== null && (!integer(holdUntil, time, time + 10 * 366 * 86400))) throw fail();
    db.run('INSERT INTO rights_messages (id, request_id, actor, message, created_at) VALUES (?, ?, ?, ?, ?)', randomUUID(), id, actor, message, time);
    db.run('UPDATE rights_requests SET status = ?, updated_at = ?, closed_at = ?, hold_until = ?, version = version + 1 WHERE id = ?', status, time, status === 'closed' ? time : null, holdUntil as number | null, id);
    return requestView(db, db.get<RightsRequest>('SELECT * FROM rights_requests WHERE id = ?', id)!);
  });
}
export function exportData(db: Db, wallet: string) {
  return {
    scope: 'self_service_subset', generatedAt: now(),
    profile: db.get('SELECT address, handle, first_seen, country FROM wallets WHERE address = ?', wallet) ?? null,
    ageDeclaration: db.get('SELECT passed, minimum_age, policy_revision, declared_at, expires_at FROM age_declarations WHERE wallet = ?', wallet) ?? null,
    restriction: db.get('SELECT request_id, restricted_at, erased_at, resumed_at FROM privacy_restrictions WHERE wallet = ?', wallet) ?? null,
    requests: db.all<RightsRequest>('SELECT * FROM rights_requests WHERE wallet = ? ORDER BY created_at', wallet).map(r => requestView(db, r)),
    // No session IDs, CSRF tokens, raw authentication messages, other users' records or staff identities.
    furtherAccessRequestKind: 'privacy_access',
  };
}
function clearProfile(db: Db, wallet: string) {
  db.run('UPDATE wallets SET handle = NULL, handle_set_at = NULL, country = NULL WHERE address = ?', wallet);
  for (const table of ['handle_history', 'handle_reservations', 'sessions', 'siws_nonces']) db.run(`DELETE FROM ${table} WHERE wallet = ?`, wallet);
}
export function eraseProfile(db: Db, id: string, version: number, response: unknown, time = now()) {
  const message = text(response);
  return db.tx(() => {
    const r = db.get<RightsRequest>('SELECT * FROM rights_requests WHERE id = ?', id);
    if (!r || r.kind !== 'privacy_erase') throw fail();
    if (r.version !== version || r.status !== 'in_review') throw new ServiceError(409, 'request_conflict', 'Review the current erasure request first');
    db.run(upsert('privacy_restrictions', ['wallet', 'request_id', 'restricted_at', 'erased_at'], ['wallet'], ['request_id = excluded.request_id', 'erased_at = excluded.erased_at', 'resumed_at = NULL']), r.wallet, id, time, time);
    clearProfile(db, r.wallet);
    db.run('INSERT INTO rights_messages (id, request_id, actor, message, created_at) VALUES (?, ?, ?, ?, ?)', randomUUID(), id, 'operator', message, time);
    // Answered, NOT complete erasure of all data. Operator must assess retained categories separately.
    db.run("UPDATE rights_requests SET status = 'answered', updated_at = ?, version = version + 1 WHERE id = ?", time, id);
    return { ...requestView(db, db.get<RightsRequest>('SELECT * FROM rights_requests WHERE id = ?', id)!), erasedScope: ['profile_handle', 'profile_country', 'handle_history', 'handle_reservations', 'sessions', 'siws_nonces'], retainedScope: ['public_chain_and_projections', 'financial_and_fraud_records', 'age_declaration', 'rights_case', 'restriction_marker', 'external_logs_and_backups'] };
  });
}
/** Run after restoring the latest privacy ledger, BEFORE reopening service. Not a blockchain eraser. */
export function reapplyProfileErasures(db: Db) {
  return db.tx(() => { const rows = db.all<{ wallet: string }>('SELECT wallet FROM privacy_restrictions WHERE erased_at IS NOT NULL AND resumed_at IS NULL'); for (const row of rows) clearProfile(db, row.wallet); return rows.length; });
}
export function sweepRetention(db: Db, policy: AccessPolicy, time = now()) {
  return db.tx(() => {
    const rows = db.all<{ id: string }>("SELECT id FROM rights_requests WHERE status = 'closed' AND closed_at < ? AND (hold_until IS NULL OR hold_until <= ?) AND id NOT IN (SELECT request_id FROM privacy_restrictions) LIMIT 1000", time - policy.closedRequestRetentionDays * 86400, time);
    for (const r of rows) { db.run('DELETE FROM rights_messages WHERE request_id = ?', r.id); db.run('DELETE FROM rights_requests WHERE id = ?', r.id); }
    const ages = db.run('DELETE FROM age_declarations WHERE expires_at < ? AND wallet NOT IN (SELECT wallet FROM rights_requests WHERE status != ? OR hold_until > ?) AND wallet NOT IN (SELECT wallet FROM privacy_restrictions)', time - 30 * 86400, 'closed', time).changes;
    const sessions = db.run('DELETE FROM sessions WHERE expires_at < ?', time).changes;
    const nonces = db.run('DELETE FROM siws_nonces WHERE expires_at < ?', time - 86400).changes;
    return { requests: rows.length, declarations: Number(ages), sessions: Number(sessions), nonces: Number(nonces) };
  });
}

export function correctAccess(db: Db, id: string, input: unknown, time = now()) {
  const b = input as { version?: number; message?: unknown; resetAge?: unknown; resumeProcessing?: unknown } | null;
  if (!b || (!b.resetAge && !b.resumeProcessing) || (b.resetAge !== undefined && typeof b.resetAge !== 'boolean') || (b.resumeProcessing !== undefined && typeof b.resumeProcessing !== 'boolean')) throw fail();
  const message = text(b.message);
  return db.tx(() => {
    const r = db.get<RightsRequest>('SELECT * FROM rights_requests WHERE id = ?', id);
    if (!r || r.kind !== 'privacy_correct') throw fail();
    if (r.version !== b.version || r.status !== 'in_review') throw new ServiceError(409, 'request_conflict', 'Review the current correction request first');
    if (b.resetAge) db.run('DELETE FROM age_declarations WHERE wallet = ?', r.wallet);
    if (b.resumeProcessing) db.run('UPDATE privacy_restrictions SET resumed_at = ? WHERE wallet = ?', time, r.wallet);
    db.run('INSERT INTO rights_messages (id, request_id, actor, message, created_at) VALUES (?, ?, ?, ?, ?)', randomUUID(), id, 'operator', message, time);
    db.run("UPDATE rights_requests SET status = 'answered', updated_at = ?, version = version + 1 WHERE id = ?", time, id);
    return requestView(db, db.get<RightsRequest>('SELECT * FROM rights_requests WHERE id = ?', id)!);
  });
}
