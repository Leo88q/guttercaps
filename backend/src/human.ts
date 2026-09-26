// Proof of human + device dedupe (docs/02 "Жёсткие ограничители", docs/03 §3.4, docs/06 T-B-49).
//
// Two cheap Sybil brakes in front of the reward faucets, both *settlement-time* gates (nothing is
// blocked on chain, nothing is banned automatically — the flags below are ops decisions):
//
//   * Turnstile — `POST /me/human { token, fingerprint? }` verifies a Cloudflare Turnstile token with
//     siteverify and records a pass for `HUMAN_CHECK_TTL_S` (7 d). While a wallet has no fresh pass,
//     `quests.eligibility` answers `human_check_required` and `settleWallet` POSTPONES the wallet
//     (its finished quests are settled after the pass, inside the normal current-or-previous-period
//     window — so "verify within the day and you are paid", nothing is silently zeroed). SKR roots
//     use the same pass (`skrEligibility`). PvP match rewards are not gated by it — they are
//     credited at match time and the arena has its own brakes (≤ 8/day, ≤ 3/opponent, win-trading).
//   * Device dedupe — the client sends a salted, canvas-free fingerprint at sign-in; we store only
//     `sha256(DEVICE_SALT || fingerprint)` in `wallet_devices`. The first `DEVICE_MAX_WALLETS` (3)
//     wallets ever seen on a device may earn rewards; later ones get `device_limit` (quests, SKR,
//     PvP rewards and season payouts). A shared phone still serves a family; a farm of 50 wallets
//     on one Seeker earns 3×, not 50×. A device with more wallets than the limit is also raised as
//     a `device_ring` fraud signal so ops can look at the earlier wallets too.
//
// `flags.trusted` (admin resolution `trust`) bypasses both gates for support cases (lost phone,
// shared household device, false positive). The gate is OFF when `TURNSTILE_SECRET` is unset
// (dev / tests / explicit `HUMAN_CHECK=0`); production refuses to start without one of the two
// (config.ts). Tests configure the module through `configureHuman` (injected verifier + clock).
import { createHash } from 'node:crypto';
import { DEVICE_MAX_WALLETS, DEVICE_SALT, HUMAN_CHECK_ENABLED, HUMAN_CHECK_TTL_S, TURNSTILE_ACTION, TURNSTILE_HOSTNAMES, TURNSTILE_MAX_AGE_S, TURNSTILE_SECRET, TURNSTILE_SITEVERIFY_URL, TURNSTILE_SITE_KEY } from './config.ts';
import { type Db, now } from './db.ts';
import { ServiceError } from './services.ts';

export interface TurnstileOutcome { success: boolean; hostname?: string; action?: string; challengeTs?: string; errorCodes: string[] }
/** siteverify call — injected in tests; the default posts form-encoded `secret/response/remoteip`. */
export type TurnstileVerifier = (token: string, remoteIp?: string) => Promise<TurnstileOutcome>;

export function createTurnstileVerifier(secret = TURNSTILE_SECRET, url = TURNSTILE_SITEVERIFY_URL, fetchImpl: typeof fetch = fetch): TurnstileVerifier {
  return async (token, remoteIp) => {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp) body.set('remoteip', remoteIp);
    const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new ServiceError(503, 'human_check_unavailable', `Turnstile siteverify answered HTTP ${res.status}`);
    const j = (await res.json()) as { success?: boolean; hostname?: string; action?: string; challenge_ts?: string; 'error-codes'?: string[] };
    return { success: j.success === true, hostname: j.hostname, action: j.action, challengeTs: j.challenge_ts, errorCodes: j['error-codes'] ?? [] };
  };
}

/** Runtime knobs (module state so `quests.eligibility` and friends see the same view as the API). */
export const HUMAN = {
  enabled: HUMAN_CHECK_ENABLED,
  siteKey: TURNSTILE_SITE_KEY,
  ttlS: HUMAN_CHECK_TTL_S,
  maxWalletsPerDevice: DEVICE_MAX_WALLETS,
  salt: DEVICE_SALT,
  /** SEC-B5: where the pass may have been minted / which action it answers — see config.ts. */
  hostnames: TURNSTILE_HOSTNAMES,
  action: TURNSTILE_ACTION,
  maxAgeS: TURNSTILE_MAX_AGE_S,
  verifier: undefined as TurnstileVerifier | undefined,
};
export function configureHuman(o: Partial<typeof HUMAN>): void { Object.assign(HUMAN, o); }

// ---------------------------------------------------------------- devices
/** Salted hash of the client fingerprint; `undefined` for missing / absurd input (never fail sign-in over it). */
export function deviceHash(fingerprint: unknown): string | undefined {
  if (typeof fingerprint !== 'string') return undefined;
  const fp = fingerprint.trim();
  if (fp.length < 8 || fp.length > 256) return undefined;
  return createHash('sha256').update(HUMAN.salt).update('\u0000').update(fp).digest('hex');
}

export function recordDevice(db: Db, wallet: string, fingerprint: unknown, t = now()): string | undefined {
  const h = deviceHash(fingerprint);
  if (!h) return undefined;
  db.run(`INSERT INTO wallet_devices (device_hash, wallet, first_seen, last_seen, seen) VALUES (?, ?, ?, ?, 1)
          ON CONFLICT(device_hash, wallet) DO UPDATE SET last_seen = excluded.last_seen, seen = seen + 1`, h, wallet, t, t);
  return h;
}

export interface DeviceStatus { devices: number; limited: boolean; /** most wallets seen on any of this wallet's devices */ maxWalletsOnDevice: number }
/**
 * A wallet is device-limited when, on any device it used, more than `maxWalletsPerDevice` wallets
 * were seen BEFORE it (rank by first_seen, ties by address) — the earliest wallets keep earning, the
 * late arrivals do not. Deterministic, so a user cannot rotate the limit onto someone else.
 */
export function deviceStatus(db: Db, wallet: string, max = HUMAN.maxWalletsPerDevice): DeviceStatus {
  const rows = db.all<{ device_hash: string; first_seen: number }>(`SELECT device_hash, first_seen FROM wallet_devices WHERE wallet = ?`, wallet);
  let limited = false, maxOn = 0;
  for (const r of rows) {
    const earlier = db.scalar(`SELECT COUNT(*) FROM wallet_devices WHERE device_hash = ? AND (first_seen < ? OR (first_seen = ? AND wallet < ?))`, r.device_hash, r.first_seen, r.first_seen, wallet);
    const total = db.scalar(`SELECT COUNT(*) FROM wallet_devices WHERE device_hash = ?`, r.device_hash);
    maxOn = Math.max(maxOn, total);
    if (earlier >= max) limited = true;
  }
  return { devices: rows.length, limited, maxWalletsOnDevice: maxOn };
}

// ---------------------------------------------------------------- human check
export interface HumanStatus { required: boolean; verified: boolean; verifiedAt: string | null; expiresAt: string | null; siteKey: string }

function trusted(db: Db, wallet: string): boolean {
  const raw = db.get<{ flags: string }>(`SELECT flags FROM wallets WHERE address = ?`, wallet)?.flags;
  try { return (JSON.parse(raw ?? '{}') as { trusted?: boolean }).trusted === true; } catch { return false; }
}

export function humanStatus(db: Db, wallet: string, t = now()): HumanStatus {
  const row = db.get<{ verified_at: number; expires_at: number }>(`SELECT verified_at, expires_at FROM human_checks WHERE wallet = ?`, wallet);
  const verified = !!row && row.expires_at > t;
  const iso = (s?: number) => (s ? new Date(s * 1000).toISOString() : null);
  return { required: HUMAN.enabled && !trusted(db, wallet), verified, verifiedAt: iso(row?.verified_at), expiresAt: verified ? iso(row!.expires_at) : null, siteKey: HUMAN.siteKey };
}

/** Verify a widget token and record the pass. Throws 400 `turnstile_failed` / 503 `human_check_unavailable`. */
export async function verifyHuman(db: Db, wallet: string, body: unknown, ip: { ip?: string; net?: string } = {}, t = now()): Promise<HumanStatus> {
  const b = (body ?? {}) as { token?: unknown; fingerprint?: unknown };
  const token = typeof b.token === 'string' ? b.token.trim() : '';
  if (!token || token.length > 2048) throw new ServiceError(400, 'turnstile_failed', 'token is required');
  recordDevice(db, wallet, b.fingerprint, t);
  let outcome: TurnstileOutcome = { success: true, errorCodes: [] };
  if (HUMAN.enabled) {
    const verifier = HUMAN.verifier ?? createTurnstileVerifier();
    outcome = await verifier(token, ip.ip);
    if (!outcome.success) throw new ServiceError(400, 'turnstile_failed', `Turnstile rejected the token (${outcome.errorCodes.join(', ') || 'no error code'})`, { errorCodes: outcome.errorCodes });
    // SEC-B5 — a pass is only ours if it was minted on our page and for our action. A sitekey is
    // public: without these two checks a farm renders the same widget on its own domain, solves a
    // challenge there and spends the token on our reward faucets (`/me/human` is the gate for quest
    // and SKR settlement). `hostname` may be absent only when the allowlist is empty (dev/tests).
    const hostname = (outcome.hostname ?? '').toLowerCase();
    if (HUMAN.hostnames.length > 0 && !HUMAN.hostnames.some((h) => (h.startsWith('.') ? hostname === h.slice(1) || hostname.endsWith(h) : hostname === h))) {
      throw new ServiceError(400, 'turnstile_failed', 'the challenge was solved on a different site', { hostname: outcome.hostname ?? null });
    }
    if (HUMAN.action && outcome.action !== HUMAN.action) {
      throw new ServiceError(400, 'turnstile_failed', `the challenge answers a different action (${outcome.action ?? 'none'})`, { action: outcome.action ?? null });
    }
    // Single-use and ~5 min at Cloudflare; the age check is for a cached/leaked token, and a
    // timestamp we cannot parse is a refusal, not a pass (fail closed).
    if (outcome.challengeTs !== undefined && outcome.challengeTs !== '') {
      const ts = Math.floor(Date.parse(outcome.challengeTs) / 1000);
      // ≤ maxAgeS old (Cloudflare mints ~5 min tokens) and not from the future beyond clock skew.
      if (!Number.isFinite(ts) || t - ts > HUMAN.maxAgeS || ts - t > 300) {
        throw new ServiceError(400, 'turnstile_failed', 'the challenge token is stale or its timestamp is bogus — solve it again');
      }
    }
  }
  db.run(`INSERT INTO human_checks (wallet, verified_at, expires_at, ip_net, hostname, action) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(wallet) DO UPDATE SET verified_at = excluded.verified_at, expires_at = excluded.expires_at, ip_net = excluded.ip_net, hostname = excluded.hostname, action = excluded.action`,
    wallet, t, t + HUMAN.ttlS, ip.net ?? null, outcome.hostname ?? null, outcome.action ?? null);
  return humanStatus(db, wallet, t);
}

// ---------------------------------------------------------------- the gate
export type GateReason = 'device_limit' | 'human_check_required' | null;
/** Settlement-time gate shared by quests ($CG + SKR) — `null` = passes. `flags.trusted` bypasses both checks. */
export function rewardGate(db: Db, wallet: string, t = now()): GateReason {
  if (trusted(db, wallet)) return null;
  if (deviceStatus(db, wallet).limited) return 'device_limit';
  if (HUMAN.enabled && !humanStatus(db, wallet, t).verified) return 'human_check_required';
  return null;
}
/** PvP / season variant: device dedupe only (match rewards are credited at match time — see header). */
export function deviceLimited(db: Db, wallet: string): boolean { return !trusted(db, wallet) && deviceStatus(db, wallet).limited; }

/** `/health.antifraud` summary. */
export function humanSummary(db: Db, t = now()) {
  return {
    enabled: HUMAN.enabled,
    verifiedWallets: db.scalar(`SELECT COUNT(*) FROM human_checks WHERE expires_at > ?`, t),
    devices: db.scalar(`SELECT COUNT(DISTINCT device_hash) FROM wallet_devices`),
    crowdedDevices: db.scalar(`SELECT COUNT(*) FROM (SELECT device_hash FROM wallet_devices GROUP BY device_hash HAVING COUNT(*) > ?)`, HUMAN.maxWalletsPerDevice),
  };
}
