// Query-parameter parsing at the HTTP boundary.
// -----------------------------------------------------------------------------
// Why this module exists (SEC-B2, 2026-09-26). Numeric query parameters used to be coerced with
// `Number(v)` and handed straight to SQL. Three concrete failures followed from that, all of them
// reproduced against a live `createApp()` before this file existed:
//
//   * `GET /v1/wallet/:address/events?limit=abc` → **500** `datatype mismatch`
//     (node:sqlite binds `NaN` as SQL NULL and `LIMIT NULL` is a datatype error, so a public read
//     endpoint answered with an unhandled-request 500 instead of a 400);
//   * `?limit=1.5` (a fraction) → the same 500;
//   * `?limit=-1` → **200 with the whole table scan** (256 KB in the repro): SQLite reads a negative
//     `LIMIT` as *no limit*, so the `Math.min(limit, 200)` caps in `queries.ts` were decoration.
//
// The rule this module enforces instead: a numeric parameter is either a single decimal integer
// inside its declared range, or the request is rejected with a `400 bad_request`. `limit` is the one
// exception — a value **above** its maximum is clamped (the document says `maximum: 200`, and a
// client asking for `limit=100000` must not be able to make us build an unbounded response).
//
// Rejecting beats silently coercing: `?cursor=abc` used to become offset 0, which returns page 1
// again — a client that trusts `nextCursor` then loops forever on a cursor that never advances.
import { ServiceError } from './services.ts';

const bad = (message: string) => new ServiceError(400, 'bad_request', message);

/** A single decimal integer (optionally signed), i.e. exactly what `Number()` would accept *and* we can check. */
const INT_RE = /^[+-]?\d+$/;

export interface IntParam {
  /** Parameter name, as it appears in the error message and the spec. */
  name: string;
  min?: number;
  max?: number;
  /** Value for `undefined` / empty (`?limit=`). Omit to make the parameter optional-but-unvalidated. */
  def?: number;
}

/**
 * Strict integer parameter: rejects repeats (`?limit=1&limit=2` → array), nesting (`?limit[]=1` →
 * array/object), fractions, exponent notation, `NaN`, `Infinity` and out-of-range values.
 * Returns `o.def` when absent/empty (which may be `undefined`).
 */
export function intQuery(raw: unknown, o: IntParam): number | undefined {
  const { name, min = 0, max = Number.MAX_SAFE_INTEGER, def } = o;
  if (raw === undefined || raw === null || raw === '') return def;
  // Express' extended query parser turns `?limit=1&limit=2` into an array and `?limit[x]=1` into an
  // object. Both reach SQL as a "datatype mismatch"; both are client bugs, so say so.
  if (typeof raw !== 'string') throw bad(`${name} must be a single integer`);
  if (!INT_RE.test(raw)) throw bad(`${name} must be an integer (got '${raw.slice(0, 24)}')`);
  const n = Number(raw);
  // `Number('9'.repeat(400))` is finite but not a safe integer — and SQLite would bind the rounded
  // double, so reject rather than round.
  if (!Number.isSafeInteger(n)) throw bad(`${name} is out of range`);
  if (n < min) throw bad(`${name} must be ≥ ${min}`);
  if (n > max) throw bad(`${name} must be ≤ ${max}`);
  return n;
}

/**
 * `limit`-shaped parameter: `min`..`max` with the **upper** bound clamped instead of rejected (a
 * legitimate client may ask for more rows than we are willing to build), everything else strict.
 * Never negative, never fractional, never `NaN` — so the value that reaches `LIMIT ?` is always a
 * bounded non-negative integer.
 */
export function limitQuery(raw: unknown, o: { name?: string; min?: number; max: number; def: number }): number {
  const { name = 'limit', min = 0, max, def } = o;
  const n = intQuery(raw, { name, min, max: Number.MAX_SAFE_INTEGER, def });
  const v = n ?? def;
  return Math.min(Math.max(v, min), max);
}

/**
 * Pagination cursor as `queries.ts` understands it: a non-negative integer offset, carried as a
 * string so the wire format stays opaque. Anything else is a 400 — see the header for why silently
 * treating it as 0 is worse.
 */
export function cursorQuery(raw: unknown, name = 'cursor'): string | undefined {
  const n = intQuery(raw, { name, min: 0 });
  return n === undefined ? undefined : String(n);
}

/**
 * Decimal parameter (`?priceMaxUsd=12.5`): a finite non-negative number, not an integer. Same
 * "reject, never coerce" rule — `Number('abc')` used to be bound as NaN and the filter silently
 * disappeared (every listing came back as if the filter were absent).
 */
export function numberQuery(raw: unknown, o: { name: string; min?: number; max?: number }): number | undefined {
  const { name, min = 0, max = Number.MAX_VALUE } = o;
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') throw bad(`${name} must be a single number`);
  if (!/^[+]?(\d+(\.\d+)?|\.\d+)$/.test(raw)) throw bad(`${name} must be a non-negative number`);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw bad(`${name} is out of range`);
  if (n < min || n > max) throw bad(`${name} must be between ${min} and ${max}`);
  return n;
}

/**
 * Pure clamp for the query layer: the last line of defence when a call site bypasses the parsers.
 * `NaN` → `min` (never a value SQLite would read as "unlimited"); `±Infinity` saturate to the bound.
 */
export function clampInt(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min;
  if (n === Infinity) return max;
  if (n === -Infinity) return min;
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(Math.trunc(n), min), max);
}
