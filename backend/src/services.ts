// Paid services: bind an on-chain `ServicePaid` event to an off-chain
// entitlement (handle, skin, theme, season pass, …). The chain proves the
// payment; we prove the payload by recomputing ref_hash. Every payment can be
// consumed exactly once.
//
//   ref_hash = keccak256(0x00 ‖ kind:u8 ‖ wallet:32 ‖ payloadBytes)
//   handle payload  = lowercase(handle) utf-8
//   other payloads  = canonical JSON (sorted keys, no whitespace)
import { keccak_256 } from '@noble/hashes/sha3';
import { PublicKey } from '@solana/web3.js';
import { SERVICES, SERVICE_BY_KIND, SKIN_BY_ID, PROFILE_THEME_BY_ID, EMOTE_PACK_BY_ID, COLLECTIONS, type ServiceDef } from '@guttercaps/economy';
import { HANDLE_BLOCKLIST, HANDLE_CHANGE_COOLDOWN_S, HANDLE_MAX_RESERVATIONS, HANDLE_QUARANTINE_S, HANDLE_RE, HANDLE_RESERVE_MS, SKR_USD_FALLBACK, SOL_USD_FALLBACK } from './config.ts';
import { type Db, now } from './db.ts';
import { FinalityError, requireFinalized } from './finality.ts';
import { foldEq } from './sql.ts';

export const enc = new TextEncoder();

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

export function serviceRefHash(kind: number, wallet: PublicKey | string, payload: string | Record<string, unknown>): Uint8Array {
  const body = typeof payload === 'string' ? payload : canonicalJson(payload);
  const bytes = enc.encode(body);
  const w = typeof wallet === 'string' ? new PublicKey(wallet) : wallet;
  const buf = new Uint8Array(34 + bytes.length);
  buf[0] = 0x00;
  buf[1] = kind;
  buf.set(w.toBytes(), 2);
  buf.set(bytes, 34);
  return keccak_256(buf);
}
export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const handleRefHash = (kind: 0 | 1, wallet: string, handle: string) => serviceRefHash(kind, wallet, handle.trim().toLowerCase());

export class ServiceError extends Error {
  /** `details` (optional) is serialised next to code/message — e.g. admin guard-rail violations. */
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}

// ---------------------------------------------------------------- catalogue
export interface Quotes { SOL: string; USDC: string; CG: string; SKR: string }
export function quoteUsdCents(cents: number, solUsd: number, skrUsd: number): Quotes {
  const usd = cents / 100;
  return {
    SOL: String(Math.ceil((usd / solUsd) * 1e9 * 1.01)),   // +1 % slippage guard, like the client
    USDC: String(cents * 10_000),
    CG: String(cents * 1_000_000),                         // 1 ¢ ≙ 1 $CG (burned)
    SKR: String(Math.ceil((usd / skrUsd) * 1e6 * 1.01)),
  };
}

/**
 * USD display prices: the pyth-cache worker writes `oracle_prices` from OUR Pyth accounts every
 * 10 s (owner decision Q7); the env fallbacks only cover a fresh dev database. Never use these
 * for on-chain amounts — /packs/quote and the client re-price from the PriceUpdateV2 account.
 */
export function prices(db: Db): { solUsd: number; skrUsd: number; source: 'pyth' | 'fallback' } {
  const sol = db.get<{ usd: number }>(`SELECT usd FROM oracle_prices WHERE symbol = 'SOL'`)?.usd;
  const skr = db.get<{ usd: number }>(`SELECT usd FROM oracle_prices WHERE symbol = 'SKR'`)?.usd;
  return { solUsd: sol ?? SOL_USD_FALLBACK, skrUsd: skr ?? SKR_USD_FALLBACK, source: sol !== undefined && skr !== undefined ? 'pyth' : 'fallback' };
}

export function catalogue(db: Db) {
  const { solUsd, skrUsd, source } = prices(db);
  return {
    services: SERVICES.map((s) => ({ id: s.id, kind: s.kind, name: s.name, priceUsdCents: s.priceUsdCents, dailyCap: s.dailyCap, recurring: s.recurring, quotes: quoteUsdCents(s.priceUsdCents, solUsd, skrUsd) })),
    solUsd, skrUsd, priceSource: source,
  };
}

// ---------------------------------------------------------------- payments
export interface PaymentRow { signature: string; event_index: number; buyer: string; kind: number; currency: number; amount: string; burned: string; ref_hash: string; block_time: number | null; consumed_by: string | null }

/**
 * Find an unconsumed ServicePaid for (signature, buyer, kind).
 *
 * `expectedRefHash` (hex, optional) is what the caller is about to grant: one transaction can carry
 * several `buy_service` instructions of the SAME kind (a player buying two cap skins in one tx — each
 * payment carries its own `ref_hash`). Without it the first unconsumed row of that kind was returned
 * for every claim, so the second purchase could never be claimed at all: the `ref_hash` compare in the
 * caller rejected the wrong row and the right one was never looked at (the player paid and got nothing).
 * The match is preferred, not required — a real payload mismatch must still surface as `ref_hash_mismatch`
 * in the caller, never as "payment not found".
 *
 * SEC-M5: an entitlement is value leaving the treasury — only a finalized payment can buy it.
 */
export function findPayment(db: Db, signature: string, buyer: string, kinds: number[], expectedRefHash?: string): PaymentRow {
  const rows = db.all<PaymentRow>(`SELECT * FROM service_payments WHERE signature = ? AND buyer = ? ORDER BY event_index ASC`, signature, buyer);
  if (rows.length === 0) throw new ServiceError(402, 'payment_not_found', 'No ServicePaid event from this wallet in that transaction (indexer may still be catching up — retry in a few seconds)');
  const mine = rows.filter((r) => kinds.includes(r.kind));
  const match =
    (expectedRefHash ? mine.find((r) => !r.consumed_by && r.ref_hash === expectedRefHash) : undefined) ??
    mine.find((r) => !r.consumed_by) ?? mine[0];
  if (!match) throw new ServiceError(402, 'payment_kind_mismatch', `Transaction paid for kind ${rows[0].kind}, expected ${kinds.join('/')}`);
  if (match.consumed_by) throw new ServiceError(402, 'payment_consumed', 'This payment was already used');
  try { requireFinalized(db, signature); } catch (e) { if (e instanceof FinalityError) throw new ServiceError(409, e.code, e.message); throw e; }
  return match;
}

/**
 * Spend a payment exactly once. The `consumed_by IS NULL` predicate is the guard, not the earlier
 * SELECT: two API replicas (or a retried request racing the first) could both read the row as free and
 * both grant an entitlement for one payment — the second UPDATE now changes no row and the claim fails
 * with `payment_consumed`. One statement decides, and it decides in SQLite.
 */
function consume(db: Db, p: PaymentRow, by: string) {
  const r = db.run(`UPDATE service_payments SET consumed_by = ?, consumed_at = ? WHERE signature = ? AND event_index = ? AND consumed_by IS NULL`, by, now(), p.signature, p.event_index);
  if (Number(r.changes) !== 1) throw new ServiceError(409, 'payment_consumed', 'This payment was already used');
}

// ---------------------------------------------------------------- handles
export type HandleCheck = { available: boolean; reason?: 'taken' | 'reserved' | 'blocked' | 'cooldown' | 'invalid'; kind: 0 | 1; refHash: string; priceUsdCents: number; reservedUntil?: string };

export function checkHandle(db: Db, wallet: string, raw: string): HandleCheck {
  const handle = raw.trim();
  const me = db.get<{ handle: string | null; handle_set_at: number | null }>(`SELECT handle, handle_set_at FROM wallets WHERE address = ?`, wallet);
  const kind: 0 | 1 = me?.handle ? 1 : 0;
  const price = SERVICE_BY_KIND[kind].priceUsdCents;
  const refHash = toHex(handleRefHash(kind, wallet, handle));
  const base = { kind, refHash, priceUsdCents: price };
  if (!HANDLE_RE.test(handle)) return { available: false, reason: 'invalid', ...base };
  const lower = handle.toLowerCase();
  if (HANDLE_BLOCKLIST.has(lower)) return { available: false, reason: 'blocked', ...base };
  if (kind === 1 && me?.handle_set_at && now() - me.handle_set_at < HANDLE_CHANGE_COOLDOWN_S) return { available: false, reason: 'cooldown', ...base };
  const owner = db.get<{ address: string }>(`SELECT address FROM wallets WHERE ${foldEq('handle', '?')}`, lower);
  if (owner && owner.address !== wallet) return { available: false, reason: 'taken', ...base };
  const quarantined = db.get(`SELECT 1 FROM handle_history WHERE ${foldEq('handle', '?')} AND wallet != ? AND released_at > ?`, lower, wallet, now() - HANDLE_QUARANTINE_S);
  if (quarantined) return { available: false, reason: 'taken', ...base };
  const t = now();
  db.run(`DELETE FROM handle_reservations WHERE expires_at < ?`, t);
  const res = db.get<{ wallet: string; expires_at: number }>(`SELECT wallet, expires_at FROM handle_reservations WHERE ${foldEq('handle', '?')}`, lower);
  if (res && res.wallet !== wallet) return { available: false, reason: 'reserved', ...base };
  // SEC-B18: a hold is what makes the handle read as `reserved` for everyone else, and one wallet could
  // take a hold on every handle it could ask about — unbounded `handle_reservations` growth with the
  // IP-scoped read budget (600/min) as the only ceiling, plus squatting of the whole namespace by a bot
  // that never pays. Cap the live holds per wallet. The answer stays honest; only the hold stops. A
  // claim never needs the hold to exist: `claimHandle` re-checks availability inside its transaction and
  // refuses with `handle_reserved` if someone else holds it, before the payment is consumed.
  if (!res && db.scalar(`SELECT COUNT(*) FROM handle_reservations WHERE wallet = ?`, wallet) >= HANDLE_MAX_RESERVATIONS) {
    return { available: true, ...base };
  }
  const reservedUntil = t + Math.floor(HANDLE_RESERVE_MS / 1000);
  db.run(`INSERT INTO handle_reservations (handle, wallet, expires_at) VALUES (?, ?, ?) ON CONFLICT(handle) DO UPDATE SET wallet = excluded.wallet, expires_at = excluded.expires_at`, lower, wallet, reservedUntil);
  return { available: true, ...base, reservedUntil: new Date(reservedUntil * 1000).toISOString() };
}

/** PUT /me/handle — validates the on-chain payment and assigns the handle atomically. */
export function claimHandle(db: Db, wallet: string, raw: string, signature: string): { address: string; handle: string } {
  const handle = raw.trim();
  if (!HANDLE_RE.test(handle)) throw new ServiceError(400, 'invalid_handle', 'Handle must be 3–16 chars [a-zA-Z0-9_]');
  const lower = handle.toLowerCase();
  return db.tx(() => {
    const me = db.get<{ handle: string | null; handle_set_at: number | null }>(`SELECT handle, handle_set_at FROM wallets WHERE address = ?`, wallet);
    const kind: 0 | 1 = me?.handle ? 1 : 0;
    if (me?.handle && me.handle.toLowerCase() === lower) throw new ServiceError(409, 'same_handle', 'That is already your handle');
    const check = checkHandle(db, wallet, handle);
    if (!check.available) throw new ServiceError(409, `handle_${check.reason}`, `Handle unavailable (${check.reason})`);
    // strict: first handle must be paid as kind 0 ($1.99), a change as kind 1 ($0.99)
    const expected = toHex(handleRefHash(kind, wallet, handle));
    const p = findPayment(db, signature, wallet, [kind], expected);
    if (p.ref_hash !== expected) throw new ServiceError(402, 'ref_hash_mismatch', 'Payment was committed for a different handle');
    if (kind === 1 && me?.handle_set_at && now() - me.handle_set_at < HANDLE_CHANGE_COOLDOWN_S) throw new ServiceError(409, 'handle_cooldown', 'Handle can change once per 30 days');
    if (me?.handle) db.run(`INSERT INTO handle_history (handle, wallet, released_at) VALUES (?, ?, ?)`, me.handle, wallet, now());
    db.run(`INSERT INTO wallets (address, handle, handle_set_at, first_seen) VALUES (?, ?, ?, ?) ON CONFLICT(address) DO UPDATE SET handle = excluded.handle, handle_set_at = excluded.handle_set_at`, wallet, handle, now(), now());
    db.run(`DELETE FROM handle_reservations WHERE ${foldEq('handle', '?')}`, lower);
    consume(db, p, `handle:${lower}`);
    db.run(
      `INSERT INTO entitlements (wallet, kind, payload, signature, currency, amount, granted_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      wallet, p.kind, canonicalJson({ handle }), signature, p.currency, p.amount, now(),
    );
    return { address: wallet, handle };
  });
}

// ---------------------------------------------------------------- generic entitlements
export interface Entitlement { id: string; kind: number; payload: Record<string, unknown>; signature: string; currency: string; amount: string; grantedAt: string; expiresAt: string | null }
const CUR = ['SOL', 'USDC', 'CG', 'SKR'];
const iso = (s: number | null) => (s === null ? null : new Date(s * 1000).toISOString());

export function rowToEntitlement(r: { id: number; kind: number; payload: string; signature: string; currency: number; amount: string; granted_at: number; expires_at: number | null }): Entitlement {
  return { id: String(r.id), kind: r.kind, payload: JSON.parse(r.payload), signature: r.signature, currency: CUR[r.currency] ?? String(r.currency), amount: r.amount, grantedAt: iso(r.granted_at)!, expiresAt: iso(r.expires_at) };
}

/** Season pass = 6 weeks from grant; everything else is permanent. */
export function expiryFor(s: ServiceDef, grantedAt: number): number | null {
  return s.id === 'seasonPass' ? grantedAt + 42 * 86_400 : null;
}

/** True when the wallet holds all 9 rarities of the district (unburned) — the banner requirement. */
export function districtCompleted(db: Db, wallet: string, collection: number): boolean {
  return db.scalar(`SELECT COUNT(DISTINCT rarity) FROM chips WHERE owner = ? AND collection_idx = ? AND burned_at IS NULL`, wallet, collection) >= 9;
}

const PAYLOAD_RULES: Record<string, (p: Record<string, unknown>) => string | undefined> = {
  capSkin: (p) => (typeof p.asset === 'string' && typeof p.skin === 'string' && SKIN_BY_ID[p.skin] ? undefined : 'payload needs {asset, skin} with a known skin id'),
  profileTheme: (p) => (typeof p.theme === 'string' && PROFILE_THEME_BY_ID[p.theme] ? undefined : 'payload needs {theme} with a known theme id'),
  arenaEmotePack: (p) => (typeof p.pack === 'string' && EMOTE_PACK_BY_ID[p.pack] ? undefined : 'payload needs {pack} with a known pack id'),
  districtBanner: (p) => (typeof p.collection === 'number' && Number.isInteger(p.collection) && p.collection >= 0 && p.collection < COLLECTIONS.length ? undefined : 'payload needs {collection} with a live district index'),
};

/** POST /services/claim */
export function claimService(db: Db, wallet: string, signature: string, kind: number, payload: Record<string, unknown>): Entitlement {
  const s = SERVICE_BY_KIND[kind];
  if (!s) throw new ServiceError(400, 'unknown_kind', `Unknown service kind ${kind}`);
  if (kind === 0 || kind === 1) throw new ServiceError(400, 'use_handle_endpoint', 'Handles are claimed via PUT /me/handle');
  if (s.fulfilment === 'chain') throw new ServiceError(400, 'chain_fulfilled', `${s.name} is fulfilled on-chain; nothing to claim`);
  const problem = PAYLOAD_RULES[s.id]?.(payload);
  if (problem) throw new ServiceError(400, 'bad_payload', problem);
  return db.tx(() => {
    const expected = toHex(serviceRefHash(kind, wallet, payload));
    const p = findPayment(db, signature, wallet, [kind], expected);
    if (p.ref_hash !== expected) throw new ServiceError(402, 'ref_hash_mismatch', 'Payment was committed for a different payload');
    if (s.id === 'capSkin') {
      const chip = db.get<{ owner: string }>(`SELECT owner FROM chips WHERE asset = ? AND burned_at IS NULL`, String(payload.asset));
      if (!chip || chip.owner !== wallet) throw new ServiceError(409, 'not_owner', 'You do not own that cap');
    }
    if (s.id === 'districtBanner' && !districtCompleted(db, wallet, Number(payload.collection))) {
      throw new ServiceError(409, 'set_not_completed', 'Finish the district set first');
    }
    const granted = now();
    const res = db.run(
      `INSERT INTO entitlements (wallet, kind, payload, signature, currency, amount, granted_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      wallet, kind, canonicalJson(payload), signature, p.currency, p.amount, granted, expiryFor(s, granted),
    );
    const id = Number(res.lastInsertRowid);
    if (s.id === 'capSkin') db.run(`UPDATE chips SET skin = ? WHERE asset = ?`, String(payload.skin), String(payload.asset));
    consume(db, p, `entitlement:${id}`);
    return rowToEntitlement({ id, kind, payload: canonicalJson(payload), signature, currency: p.currency, amount: p.amount, granted_at: granted, expires_at: expiryFor(s, granted) });
  });
}

export function myServices(db: Db, wallet: string) {
  const rows = db.all<{ id: number; kind: number; payload: string; signature: string; currency: number; amount: string; granted_at: number; expires_at: number | null }>(
    `SELECT id, kind, payload, signature, currency, amount, granted_at, expires_at FROM entitlements WHERE wallet = ? ORDER BY id DESC`, wallet,
  );
  const since = now() - 86_400;
  const dailyLeft: Record<string, number> = {};
  for (const s of SERVICES) {
    const used = db.scalar(`SELECT COUNT(*) FROM service_payments WHERE buyer = ? AND kind = ? AND COALESCE(block_time, ?) >= ?`, wallet, s.kind, now(), since);
    dailyLeft[String(s.kind)] = Math.max(0, s.dailyCap - used);
  }
  return { entitlements: rows.map(rowToEntitlement), dailyLeft };
}
