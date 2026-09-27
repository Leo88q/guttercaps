// SEC-B13 gate — "a missing block_time must never mean 1970". SECURITY-AUDIT-2026-09-26.md.
//
// The websocket subscription delivers transaction logs WITHOUT a block time, so a projection row can be
// written from an event whose time is not known yet; the timed re-read (`patchLateTimes`) heals it later.
// Every day-bucketed read then has to decide what a NULL means, and the two directions are not the same
// risk:
//
//   * reads that SELECT ("was this bought in the last 30 days?", "did this quest window see a fusion?")
//     must treat NULL as "unknown", never as the epoch — `COALESCE(block_time, 0)` silently drops the
//     row, so the number a player or an operator reads disagrees with a rebuild (two answers, one chain).
//   * `staking.accrualFrom` is the one place where "unknown" could inflate a number a player reads as
//     money: an undated `Claimed` is a recent claim, so the accrual window must STOP there, never
//     restart at the stake's opening.
//
// `backend/test/projections.test.ts` and `backend/test/game.test.ts` are the behavioural half (the
// heal pass end-to-end, and the pending-estimate under an undated claim). These are the static rules,
// each with a known-bad mutation at the bottom: a gate nobody has seen fail is a comment.
//   node --experimental-strip-types --test tests/security/*.test.ts      (npm run security:static)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');

const INGEST = read('backend/src/ingest.ts');
const LISTEN = read('backend/src/listen.ts');
const STAKING = read('backend/src/staking.ts');

/** One function's source, from its declaration to the closing brace at the declaration's indentation. */
function fnBody(src: string, name: string): string {
  const m = new RegExp(`(?:^|\\n)(?:export )?(?:async )?function ${name}\\b`).exec(src);
  assert.ok(m, `function ${name} not found`);
  const start = m.index + (src[m.index] === '\n' ? 1 : 0);
  const end = src.indexOf('\n}', start);
  assert.ok(end > start, `function ${name} has no top-level terminator`);
  return src.slice(start, end + 2);
}

/** SQL string literals inside a function body — the queries it really runs. */
const queries = (body: string) => [...body.matchAll(/`([^`]*)`/gs)].map((m) => m[1].replace(/\s+/g, ' '));

test('the heal pass exists, drains untimed rows oldest-first, and re-ingests (so projections heal too)', () => {
  const body = fnBody(INGEST, 'healEventTimes');
  const sql = queries(body);
  assert.ok(sql.some((q) => /FROM events_raw WHERE block_time IS NULL/.test(q)), 'must select the untimed rows');
  assert.ok(sql.some((q) => /ORDER BY slot ASC LIMIT/.test(q)), 'oldest first, bounded per pass');
  assert.match(body, /\bmapLimit\(/, 'fetches with bounded concurrency');
  assert.match(body, /\bingestTx\(/, 'must re-ingest — a bare UPDATE of events_raw would leave pack_purchases/battles/claims undated');
  assert.match(INGEST, /export async function healEventTimes/, 'exported so the pass can be tested and called by an embedder');
});

test('an unhealable row is parked at the attempt cap and can fall back to the slot time', () => {
  const body = fnBody(INGEST, 'healEventTimes');
  const sql = queries(body);
  assert.ok(sql.some((q) => /time_heal_attempts < \?/.test(q)), 'the selection must skip rows that exhausted their attempts — otherwise a dead signature occupies every batch for ever');
  assert.match(body, /UPDATE events_raw SET time_heal_attempts = time_heal_attempts \+ 1/, 'attempts are counted before the fetch');
  assert.match(body, /connection\.getBlockTime\(r\.slot\)/, 'when the transaction is gone the stored slot time is tried — the slot is all patchLateTimes needs');
  const status = fnBody(INGEST, 'untimedStatus');
  assert.match(status, /time_heal_attempts >= \?/, 'the parked rows are counted separately from the waiting ones');
  assert.match(read('backend/src/server.ts'), /untimedEvents: untimedStatus\(db\)/, 'and surfaced in /health so a stuck row is visible, not silent');
});

test('the listener runs the heal pass (the live healer alone only reaches back LISTEN_HEAL_DEPTH signatures)', () => {
  assert.match(LISTEN, /import \{[^}]*\bhealEventTimes\b[^}]*\} from '\.\/ingest\.ts'/, 'listener imports the pass');
  assert.match(LISTEN, /healEventTimes\(connection, undefined, LISTEN_HEAL_TIMES_BATCH\)/, 'and calls it from the heal timer');
  assert.match(LISTEN, /LISTEN_HEAL_TIMES_BATCH/, 'with the bounded batch size from config');
});

test('an undated claim stops the accrual instead of resetting it to the epoch', () => {
  const body = fnBody(STAKING, 'accrualFrom');
  const sql = queries(body);
  assert.ok(sql.some((q) => /FROM claims WHERE owner = \? AND kind = \?/.test(q)), 'reads the owner/kind claims');
  assert.ok(sql.some((q) => /SUM\(block_time IS NULL\)/.test(q)), 'must count the undated claims — `COALESCE(block_time, 0)` alone reads "claimed at the epoch" and inflates `pending`');
  assert.match(body, /unknown > 0 \? t/, 'an unknown time must clamp the window to now, not to the stake opening');
});

// ---------------------------------------------------------------- mutations
// Each mutation edits the real source text and must make one of the rules above fail. The strings are
// byte-exact copies of what is in the tree; if an edit changes them, the mutation stops asserting
// anything, so each one asserts its own match first.
const mutate = (src: string, find: string | RegExp, to: string) => {
  const before = src;
  const after = src.replace(find, to);
  assert.notStrictEqual(after, before, `mutation did not match: ${find}`);
  return after;
};
const fails = (fn: () => void) => { try { fn(); return false; } catch { return true; } };

test('mutations: the gates above are wired to the code they claim to guard', () => {
  // 1. the listener stops draining the backlog
  const listen = mutate(LISTEN, /healEventTimes\(connection, undefined, LISTEN_HEAL_TIMES_BATCH\)/, 'void 0');
  assert.ok(fails(() => assert.match(listen, /healEventTimes\(connection, undefined, LISTEN_HEAL_TIMES_BATCH\)/)));

  // 2. the pass stops re-ingesting: only events_raw would be dated, projections keep NULL for ever
  //    (mutated inside the function body — `ingestSignatures` calls the same helper, so a whole-file
  //    replace would have hit that call and proved nothing)
  const ingest = mutate(fnBody(INGEST, 'healEventTimes'), /ingestTx\(t, db\)/, 'void 0');
  assert.ok(fails(() => assert.match(ingest, /\bingestTx\(/)));

  // 3. the untimed selection is dropped (heals recent, dated rows — a no-op)
  const blind = mutate(fnBody(INGEST, 'healEventTimes'), /WHERE block_time IS NULL AND time_heal_attempts < \?/, 'WHERE block_time IS NOT NULL AND time_heal_attempts < ?');
  //    (assert on the selection shape, not a bare `block_time IS NULL` — the pass's own before/after
  //    counters contain that phrase too and would otherwise rescue the mutation)
  assert.ok(fails(() => assert.ok(queries(blind).some((q) => /FROM events_raw WHERE block_time IS NULL AND time_heal_attempts < \?/.test(q)))));

  // 4. accrualFrom back to the inflating form
  const staking = mutate(STAKING, /const last = !r \? 0 : r\.unknown > 0 \? t : r\.bt \?\? 0;/, 'const last = 0;');
  assert.ok(fails(() => assert.match(fnBody(staking, 'accrualFrom'), /unknown > 0 \? t/)));

  // 5. the attempt cap is dropped: the pass retries a permanently dead signature in every batch
  const uncapped = mutate(fnBody(INGEST, 'healEventTimes'), /time_heal_attempts < \?/, '1 = 1');
  assert.ok(fails(() => assert.ok(queries(uncapped).some((q) => /time_heal_attempts < \?/.test(q)))));

  // 6. the slot fallback is dropped: a transaction outside the RPC retention window stays undated for ever
  const noFallback = mutate(fnBody(INGEST, 'healEventTimes'), /connection\.getBlockTime\(r\.slot\)/, 'null');
  assert.ok(fails(() => assert.match(noFallback, /connection\.getBlockTime\(r\.slot\)/)));
});
