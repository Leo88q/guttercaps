// Ephemeral demo only. No real requests, identity verification, data erasure or payments.
import { ApiError, type RequestOpts } from '../client';
import { useSessionStore } from '@/app/store/session';
import type { Case } from '@/features/rights/Rights';
const rows: Case[] = [];
const ages = new Map<string, string>();
const keys = new Map<string, { body: string; id: string }>();
const current = () => useSessionStore.getState().address ?? 'mock';
export function isRightsPath(path: string) { return /^\/(me\/compliance|me\/rights|admin\/rights)(\/|$)/.test(path); }
export function mockRights(method: string, path: string, opts: RequestOpts): unknown {
  const wallet = current();
  const b = (opts.body ?? {}) as Record<string, any>;
  const now = Math.floor(Date.now() / 1000);
  const state = () => ({ enabled: false, minimumAge: 18, age: ages.get(wallet) ?? 'missing', policyRevision: 'demo', features: Object.fromEntries(['packs','market','staking','arena','rewards','services','fusion'].map(f => [f, { allowed: true, reason: null }])) });
  if (path === '/me/compliance' && method === 'get') return state();
  if (path === '/me/compliance/check' && method === 'post') return { allowed: true };
  if (path === '/me/compliance/age' && method === 'post') {
    const date = new Date(String(b.birthDate) + 'T00:00:00Z');
    if (!b.acknowledged || !Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== b.birthDate || date.getTime() > Date.now()) throw new ApiError(400, 'age_declaration_invalid', 'Invalid date');
    const today = new Date().toISOString().slice(0,10);
    const age = Number(today.slice(0,4)) - Number(b.birthDate.slice(0,4)) - (today.slice(5) < b.birthDate.slice(5) ? 1 : 0);
    ages.set(wallet, age >= 18 ? 'declared' : 'denied'); return state();
  }
  if (path === '/me/rights/export' && method === 'post') return { scope: 'demo_subset', requests: structuredClone(rows.filter(r => r.wallet === wallet)), age: ages.get(wallet) };
  if (path === '/me/rights' && method === 'post') {
    const k = wallet + ':' + b.idempotencyKey; const fingerprint = JSON.stringify(b); const prior = keys.get(k);
    if (prior) { if (prior.body !== fingerprint) throw new ApiError(409,'request_conflict','Changed request'); return structuredClone(rows.find(r=>r.id===prior.id)); }
    const r: Case = { id: crypto.randomUUID(), wallet, kind: b.kind, signature: b.signature || null, message: b.message, status: 'received', version: 1, created_at: now, due_at: now + 14*86400, messages: [] };
    rows.unshift(r); keys.set(k, { body: fingerprint, id: r.id }); return structuredClone(r);
  }
  if (path === '/me/rights' && method === 'get') return structuredClone(rows.filter(r=>r.wallet===wallet));
  if (path === '/admin/rights' && method === 'get') return structuredClone(rows);
  const m = /^\/(me|admin)\/rights\/([^/]+)(\/messages)?$/.exec(path);
  if (m) {
    const r = rows.find(r=>r.id===m[2] && (m[1] === 'admin' || r.wallet === wallet));
    if (!r) throw new ApiError(404,'not_found','Request not found');
    if (method === 'post') {
      if (r.version !== b.version) throw new ApiError(409,'request_conflict','Refresh first');
      r.messages.push({ id: crypto.randomUUID(), actor: m[1] === 'admin' ? 'operator' : 'user', message: b.message, created_at: now });
      r.status = m[1] === 'admin' ? b.status : 'received'; r.version++;
    }
    return structuredClone(r);
  }
  throw new ApiError(503, 'bad_request', 'This action requires the real API; the demo does not erase data');
}
