// Typed fetch over backend/openapi.yaml (types generated into schema.d.ts).
// Falls back to the in-browser mock when the backend is unreachable in dev.
import type { paths } from './schema';
import { API_BASE, FLAGS } from '@/app/config';
import { useSessionStore } from '@/app/store/session';

type Paths = paths;
type Method = 'get' | 'post' | 'put' | 'delete';

type OpFor<P extends keyof Paths, M extends Method> = Paths[P] extends Record<M, infer O> ? O : never;
type Json<T> = T extends { content: { 'application/json': infer J } } ? J : never;

export type ResponseOf<P extends keyof Paths, M extends Method> =
  OpFor<P, M> extends { responses: infer R } ? (R extends { 200: infer OK } ? Json<OK> : R extends { 204: unknown } ? void : unknown) : never;
export type BodyOf<P extends keyof Paths, M extends Method> =
  OpFor<P, M> extends { requestBody: infer B } ? (B extends { content: { 'application/json': infer J } } ? J : never) : never;

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export interface RequestOpts {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  path?: Record<string, string | number>;
  signal?: AbortSignal;
}

let mockMode: boolean | undefined = FLAGS.apiMock ? true : undefined;
export const isMock = () => mockMode === true;
export function setMockMode(on: boolean) { mockMode = on; }

async function detectMock(): Promise<boolean> {
  if (mockMode !== undefined) return mockMode;
  if (!import.meta.env.DEV) { mockMode = false; return false; }
  try {
    const r = await fetch(`${API_BASE}/health`, { method: 'GET', signal: AbortSignal.timeout(1500) });
    mockMode = !r.ok;
  } catch {
    mockMode = true;
  }
  if (mockMode) console.info('[api] backend unreachable → using in-browser mock');
  return mockMode;
}

function buildUrl(path: string, opts: RequestOpts): string {
  let p = path;
  if (opts.path) for (const [k, v] of Object.entries(opts.path)) p = p.replace(`{${k}}`, encodeURIComponent(String(v)));
  const url = new URL(`${API_BASE}${p}`, window.location.origin);
  if (opts.query) for (const [k, v] of Object.entries(opts.query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  return url.toString();
}

export async function request<T = unknown>(method: Method, path: string, opts: RequestOpts = {}): Promise<T> {
  if (await detectMock()) {
    const { mockRequest } = await import('./mock');
    return mockRequest(method, path, opts) as Promise<T>;
  }
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const csrf = useSessionStore.getState().csrf;
  if (csrf && method !== 'get') headers['X-CSRF-Token'] = csrf;
  const res = await fetch(buildUrl(path, opts), {
    method: method.toUpperCase(),
    headers,
    credentials: 'include',
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    signal: opts.signal,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json = text ? safeJson(text) : undefined;
  if (!res.ok) {
    // A 401 on the pre-sign compliance probe must not wipe SIWS: that re-opened
    // the wallet "connect" sheet on every deal before the actual transaction.
    if (res.status === 401 && !path.includes('/me/compliance/check')) useSessionStore.getState().clear();
    const e = json as { code?: string; message?: string; details?: unknown } | undefined;
    throw new ApiError(res.status, e?.code ?? `http_${res.status}`, e?.message ?? res.statusText, e?.details);
  }
  return json as T;
}

function safeJson(t: string): unknown {
  try { return JSON.parse(t); } catch { return t; }
}

/**
 * Retry a post-payment claim while the backend is still catching up (SEC-M5): the indexer may not have
 * seen the transaction yet (402 `payment_not_found`) and, once it has, the payment must be **finalized**
 * before an entitlement is granted (409 `payment_pending`, ≈ 30–60 s after confirmation). Everything
 * else (ref_hash mismatch, consumed, not_owner…) surfaces immediately. Total wait ≤ ~2.5 min.
 */
export async function claimWithRetry<T>(fn: () => Promise<T>, opts: { onPending?: (code: string, attempt: number) => void; maxWaitMs?: number } = {}): Promise<T> {
  const RETRYABLE = new Set(['payment_not_found', 'payment_pending']);
  const started = Date.now();
  const maxWait = opts.maxWaitMs ?? 150_000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof ApiError) || !RETRYABLE.has(e.code) || Date.now() - started > maxWait) throw e;
      opts.onPending?.(e.code, attempt);
      await new Promise((f) => setTimeout(f, Math.min(2_000 * attempt, 10_000)));
    }
  }
}

/** Typed wrappers — `api.get('/packs')` etc. */
export const api = {
  get: <P extends keyof Paths>(path: P, opts?: RequestOpts) => request<ResponseOf<P, 'get'>>('get', path as string, opts),
  post: <P extends keyof Paths>(path: P, body?: BodyOf<P, 'post'>, opts?: RequestOpts) => request<ResponseOf<P, 'post'>>('post', path as string, { ...opts, body }),
  put: <P extends keyof Paths>(path: P, body?: BodyOf<P, 'put'>, opts?: RequestOpts) => request<ResponseOf<P, 'put'>>('put', path as string, { ...opts, body }),
  del: <P extends keyof Paths>(path: P, opts?: RequestOpts) => request<ResponseOf<P, 'delete'>>('delete', path as string, opts),
};
