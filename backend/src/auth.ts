// Sign-In-With-Solana sessions. The client (client/src/app/session.tsx) either
// uses the wallet's native `signIn` (returns the exact signed message) or
// builds the SIWS text itself; both end up as (message, signature) here.
// Session = random id in an HttpOnly cookie + CSRF token echoed in
// `X-CSRF-Token` on mutating requests (double-submit pattern).
import { ed25519 } from '@noble/curves/ed25519';
import { randomBytes, createHmac } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { PublicKey } from '@solana/web3.js';
import { base58Decode } from './base58.ts';
import { COOKIE_NAME, COOKIE_SAMESITE, COOKIE_SECURE, SESSION_SECRET, SESSION_TTL_S, SIWS_DOMAINS, SIWS_MAX_DRIFT_S } from './config.ts';
import { type Db, now } from './db.ts';

const secret = SESSION_SECRET || randomBytes(32).toString('hex');
const hmac = (v: string) => createHmac('sha256', secret).update(v).digest('base64url');

/** Live nonces a single wallet may hold (SEC-H3: caps DB growth from a nonce flood; oldest are dropped). */
export const NONCES_PER_WALLET = 3;

export function issueNonce(db: Db, address: string) {
  new PublicKey(address); // throws on garbage
  const nonce = randomBytes(16).toString('hex');
  const expiresAt = now() + 300;
  db.run(`DELETE FROM siws_nonces WHERE expires_at < ?`, now());
  // keep the newest NONCES_PER_WALLET − 1 (rowid breaks same-second ties; Postgres port: order by a serial id)
  db.run(`DELETE FROM siws_nonces WHERE wallet = ? AND nonce NOT IN (SELECT nonce FROM siws_nonces WHERE wallet = ? ORDER BY expires_at DESC, rowid DESC LIMIT ?)`, address, address, NONCES_PER_WALLET - 1);
  db.run(`INSERT INTO siws_nonces (nonce, wallet, expires_at) VALUES (?, ?, ?)`, nonce, address, expiresAt);
  return { nonce, statement: 'Sign in to GUTTERCAPS', expiresAt: new Date(expiresAt * 1000).toISOString() };
}

/** Parse the fields we verify out of an ERC-4361/SIWS-style message. */
export function parseSiws(message: string): { address?: string; nonce?: string; domain?: string; issuedAt?: string } {
  const lines = message.split('\n');
  const domain = (/^(\S+) wants you to sign in/.exec(lines[0] ?? '') ?? /^GUTTERCAPS sign-in \(([^)]+)\):/.exec(lines[0] ?? ''))?.[1];
  const address = lines[1]?.trim();
  const field = (k: string) => lines.find((l) => l.startsWith(`${k}: `))?.slice(k.length + 2).trim();
  return { domain, address, nonce: field('Nonce'), issuedAt: field('Issued At') };
}

export class AuthError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }

/**
 * Verify a SIWS (message, signature) pair against a live nonce. Domain policy (SEC-M4): the
 * message's `domain` must be in `allowedDomains` (config, never a request header); an empty list
 * (dev with wildcard CORS) skips the check. `issuedAt` must be within ±SIWS_MAX_DRIFT_S of now.
 */
export function verifySiws(db: Db, body: { address: string; message: string; signature: string }, allowedDomains: readonly string[] = SIWS_DOMAINS, nowS: () => number = now) {
  const { address, message, signature } = body;
  if (typeof message !== 'string' || typeof signature !== 'string' || message.length > 4096) throw new AuthError(400, 'siws_malformed', 'message/signature must be strings');
  const pk = new PublicKey(address);
  const parsed = parseSiws(message);
  if (parsed.address !== address) throw new AuthError(401, 'siws_address', 'Message is for a different address');
  if (!parsed.nonce) throw new AuthError(401, 'siws_nonce', 'Nonce missing');
  const row = db.get<{ wallet: string; expires_at: number }>(`SELECT wallet, expires_at FROM siws_nonces WHERE nonce = ?`, parsed.nonce);
  if (!row || row.wallet !== address) throw new AuthError(401, 'siws_nonce', 'Unknown nonce');
  if (row.expires_at < nowS()) throw new AuthError(401, 'siws_expired', 'Nonce expired');
  if (allowedDomains.length) {
    if (!parsed.domain) throw new AuthError(401, 'siws_domain', 'Domain missing');
    if (!allowedDomains.includes(parsed.domain)) throw new AuthError(401, 'siws_domain', `Domain mismatch (${parsed.domain})`);
  }
  if (parsed.issuedAt) {
    const t = Date.parse(parsed.issuedAt);
    if (!Number.isFinite(t) || Math.abs(t / 1000 - nowS()) > SIWS_MAX_DRIFT_S) throw new AuthError(401, 'siws_issued_at', `issuedAt outside ±${SIWS_MAX_DRIFT_S} s`);
  } else throw new AuthError(401, 'siws_issued_at', 'Issued At missing');
  let ok = false;
  try { ok = ed25519.verify(base58Decode(signature), new TextEncoder().encode(message), pk.toBytes()); } catch { ok = false; }
  if (!ok) throw new AuthError(401, 'siws_signature', 'Bad signature');
  // Consume atomically after signature verification. A select-then-delete race
  // would let two concurrent requests redeem one valid SIWS signature.
  const consumed = db.run(`DELETE FROM siws_nonces WHERE nonce = ? AND wallet = ? AND expires_at >= ?`, parsed.nonce, address, nowS());
  if (!consumed.changes) throw new AuthError(401, 'siws_nonce', 'Nonce already used');
  return address;
}

export function createSession(db: Db, wallet: string) {
  const id = randomBytes(24).toString('base64url');
  const csrf = randomBytes(24).toString('base64url');
  const t = now();
  db.run(`DELETE FROM sessions WHERE expires_at < ?`, t);
  db.run(`INSERT INTO sessions (id, wallet, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`, id, wallet, csrf, t, t + SESSION_TTL_S);
  db.run(`INSERT INTO wallets (address, first_seen) VALUES (?, ?) ON CONFLICT(address) DO NOTHING`, wallet, t);
  return { id, csrf, cookie: `${id}.${hmac(id)}` };
}

/**
 * The attributes every session cookie carries (SEC-B25). Exported so a test can pin them: `HttpOnly`
 * always, `Secure` whenever the deployment is https (or the policy is `none`, where browsers would drop
 * the cookie anyway), and `SameSite` from `COOKIE_SAMESITE` — `Lax` by default, because this repo's
 * deploy serves the client and the API from one origin and a cross-site request then cannot even send
 * the cookie. `'none'` is the explicit opt-in for a cross-site client (see config.ts).
 */
export function sessionCookieAttributes(samesite: 'lax' | 'strict' | 'none' = COOKIE_SAMESITE, secure = COOKIE_SECURE): string[] {
  return ['Path=/', 'HttpOnly', `SameSite=${samesite[0]!.toUpperCase()}${samesite.slice(1)}`, ...(secure || samesite === 'none' ? ['Secure'] : [])];
}

export function setSessionCookie(res: Response, cookie: string | null, attrs = sessionCookieAttributes()) {
  if (cookie === null) res.append('Set-Cookie', `${COOKIE_NAME}=; ${attrs.join('; ')}; Max-Age=0`);
  else res.append('Set-Cookie', `${COOKIE_NAME}=${cookie}; ${attrs.join('; ')}; Max-Age=${SESSION_TTL_S}`);
}

function readCookie(req: Request): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE_NAME) return v.join('=');
  }
  return undefined;
}

export interface Session { id: string; wallet: string; csrf: string }

export function sessionFromRequest(db: Db, req: Request): Session | undefined {
  const c = readCookie(req);
  if (!c) return undefined;
  const dot = c.lastIndexOf('.');
  if (dot < 0) return undefined;
  const id = c.slice(0, dot);
  if (hmac(id) !== c.slice(dot + 1)) return undefined;
  const row = db.get<{ id: string; wallet: string; csrf: string; expires_at: number }>(`SELECT id, wallet, csrf, expires_at FROM sessions WHERE id = ?`, id);
  if (!row || row.expires_at < now()) return undefined;
  return { id: row.id, wallet: row.wallet, csrf: row.csrf };
}

export function destroySession(db: Db, s: Session) { db.run(`DELETE FROM sessions WHERE id = ?`, s.id); }

declare module 'express-serve-static-core' {
  interface Request { session?: Session }
}

/** Attaches req.session when a valid cookie is present (never rejects). */
export const attachSession = (db: Db) => (req: Request, _res: Response, next: NextFunction) => {
  req.session = sessionFromRequest(db, req);
  next();
};

/** Rejects unauthenticated requests; enforces CSRF on non-GET. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session) { res.status(401).json({ code: 'unauthenticated', message: 'Sign in first' }); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-csrf-token'] !== req.session.csrf) {
    res.status(403).json({ code: 'csrf', message: 'Bad CSRF token' });
    return;
  }
  next();
}
