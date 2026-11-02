// SEC-B14 gate — a paid entitlement is spent exactly once, and the *right* payment is spent.
//
// `ServicePaid` is the chain's receipt: `claimHandle` / `claimService` recompute `ref_hash` from the
// payload and grant the entitlement off-chain. Two properties have to hold for that to be an exchange
// rather than a lottery:
//
//   1. SELECTION — one transaction may carry several `buy_service` instructions of the same kind (a
//      player buying two cap skins in one tx; each event has its own ref_hash). The lookup must prefer the
//      row that matches what the caller is about to grant. It used to return "the first unconsumed row of
//      that kind", so the second purchase could never be claimed: the ref_hash compare in the caller
//      rejected the wrong row and the right one was never looked at — money in, entitlement lost.
//   2. SINGLE SPEND — `consume` inserts one row into `payment_consumption`, whose primary key is
//      (signature, event_index); exactly one insert succeeds. The earlier SELECT is a check, not a lock:
//      two API replicas (or a retried request racing the first) could both read the row as free and both
//      grant an entitlement for one payment. The ledger is deliberately NOT in PROJECTION_TABLES: a
//      `dropSignatures`/`rebuild` replays `service_payments` from `events_raw`, which knows nothing about
//      the spend, so a mark stored on that table comes back «free» (находка 67).
//
// `backend/test/cosmetics.test.ts` is the behavioural half (two same-kind purchases in one tx claimed in
// reverse event order; a consumed payment refused a second time). These are the static rules; each one
// has a byte-exact known-bad mutation at the bottom.
//   node --experimental-strip-types --test tests/security/*.test.ts      (npm run security:static)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');
const SERVICES = read('backend/src/services.ts');
const CONSUMPTION = read('backend/src/consumption.ts');
const DB = read('backend/src/db.ts');

/** One function's source, from its declaration to the closing brace at the declaration's indentation. */
function fnBody(src: string, name: string): string {
  const m = new RegExp(`(?:^|\\n)(?:export )?(?:async )?function ${name}\\b`).exec(src);
  assert.ok(m, `function ${name} not found`);
  const start = m.index + (src[m.index] === '\n' ? 1 : 0);
  const end = src.indexOf('\n}', start);
  assert.ok(end > start, `function ${name} has no top-level terminator`);
  return src.slice(start, end + 2);
}

test('findPayment takes the expected ref hash and prefers the row that matches it', () => {
  const body = fnBody(SERVICES, 'findPayment');
  assert.match(body, /expectedRefHash\?: string/, 'the caller must be able to say which payment it means');
  assert.match(body, /r\.ref_hash === expectedRefHash/, 'and the lookup must prefer exactly that row');
  // order still matters for the fallback: an unconsumed row is preferred over a consumed one, so the
  // "already used" answer keeps its meaning
  assert.match(body, /mine\.find\(\(r\) => !r\.consumed_by\) \?\? mine\[0\]/, 'fallback order unchanged');
  assert.match(body, /requireFinalized\(db, signature\)/, 'SEC-M5 finality gate still applies to every lookup');
});

test('both callers pass the ref hash they are about to grant', () => {
  const handle = fnBody(SERVICES, 'claimHandle');
  assert.match(handle, /const expected = toHex\(handleRefHash\(kind, wallet, handle\)\);\s*\n\s*const p = findPayment\(db, signature, wallet, \[kind\], expected\)/, 'claimHandle computes before it looks up and passes it');
  const claim = fnBody(SERVICES, 'claimService');
  assert.match(claim, /const expected = toHex\(serviceRefHash\(kind, wallet, payload\)\);\s*\n\s*const p = findPayment\(db, signature, wallet, \[kind\], expected\)/, 'claimService too');
});

test('a payment is spent by one INSERT on a primary key, and a second spender fails closed', () => {
  const body = fnBody(CONSUMPTION, 'markConsumed');
  assert.match(body, /insertIgnore\('payment_consumption'/, 'the guard is the unique key of the ledger row, not the earlier SELECT');
  assert.match(body, /if \(Number\(r\.changes\) !== 1\) return false/, 'a no-op insert must be reported, not swallowed');
  const consume = fnBody(SERVICES, 'consume');
  assert.match(consume, /if \(!markConsumed\(db, p, by, now\(\)\)\)/, 'consume delegates the decision to the ledger');
  assert.match(consume, /throw new ServiceError\(409, 'payment_consumed'/, 'and it surfaces as the same 409 the stale-row path uses');
});

test('the ledger is outside the projection set, so a rebuild cannot un-spend a payment', () => {
  const list = /export const PROJECTION_TABLES = \[([\s\S]*?)\];/.exec(DB)?.[1] ?? '';
  assert.ok(list.includes('service_payments'), 'service_payments is a projection — that is exactly why the mark cannot live on it');
  assert.ok(!list.includes('payment_consumption'), 'the consumption ledger must never be wiped by a replay');
  assert.match(
    DB,
    /CREATE TABLE IF NOT EXISTS payment_consumption \([\s\S]*?PRIMARY KEY \(signature, event_index\)/,
    'one payment event = one spend, forever (primary key), not an index on a projection',
  );
  // and the lookup reads the ledger, not just the mirrored column
  assert.match(fnBody(SERVICES, 'findPayment'), /LEFT JOIN payment_consumption/, 'findPayment must consult the durable ledger');
});

// ---------------------------------------------------------------- mutations
const mutate = (src: string, find: string | RegExp, to: string) => {
  const after = src.replace(find, to);
  assert.notStrictEqual(after, src, `mutation did not match: ${find}`);
  return after;
};
const fails = (fn: () => void) => { try { fn(); return false; } catch { return true; } };

test('mutations: the gates above are wired to the code they claim to guard', () => {
  // 1. back to "first unconsumed row of that kind" (the lost-entitlement bug)
  const first = mutate(SERVICES, /\s*\(expectedRefHash \? mine\.find\(\(r\) => !r\.consumed_by && r\.ref_hash === expectedRefHash\) : undefined\) \?\?/, '');
  assert.ok(fails(() => assert.match(fnBody(first, 'findPayment'), /r\.ref_hash === expectedRefHash/)));

  // 2. the caller stops asking for the row it means
  const noHint = mutate(fnBody(SERVICES, 'claimService'), /findPayment\(db, signature, wallet, \[kind\], expected\)/, 'findPayment(db, signature, wallet, [kind])');
  assert.ok(fails(() => assert.match(noHint, /findPayment\(db, signature, wallet, \[kind\], expected\)/)));

  // 3. the single-spend guard goes back to an UPDATE on the projection (the shape a rebuild un-does)
  const projection = mutate(fnBody(CONSUMPTION, 'markConsumed'), /insertIgnore\('payment_consumption'[\s\S]*?\);/,
    "db.run(`UPDATE service_payments SET consumed_by = ? WHERE signature = ? AND event_index = ?`);");
  assert.ok(fails(() => assert.match(projection, /insertIgnore\('payment_consumption'/)));

  // 4. the single-spend guard stops checking what SQLite did
  const unchecked = mutate(fnBody(CONSUMPTION, 'markConsumed'), /if \(Number\(r\.changes\) !== 1\) return false;/, 'void r;');
  assert.ok(fails(() => assert.match(unchecked, /Number\(r\.changes\) !== 1\) return false/)));

  // 5. the ledger is dragged into the projection set, so the next replay re-sells every payment
  const wiped = mutate(DB, /export const PROJECTION_TABLES = \[/, `export const PROJECTION_TABLES = [\n  'payment_consumption',`);
  const list = /export const PROJECTION_TABLES = \[([\s\S]*?)\];/.exec(wiped)?.[1] ?? '';
  assert.ok(fails(() => assert.ok(!list.includes('payment_consumption'))));
});
