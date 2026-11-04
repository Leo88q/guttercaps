// SEC-B29 gate — "a report the chain cannot take back must not be built from an event the chain can take back".
// audit 2026-09-27 checklist, SECURITY.md.
//
// The burn oracle sums indexed burns and sends `staking.report_burn(delta)`, which adds to `burn_today` and
// to the 7-day ring the emission guard reads (`0.30·cap + 1.25·burn7d`). That call is irreversible: the
// program has no "un-report". The indexer, on the other hand, officially accepts that a confirmed
// transaction can be *dropped* by a fork and deletes its events (`finality.ts dropSignatures`).
//
// So the two halves have to meet:
//
//   * `pendingBurn` may aggregate only rows at or below `finalizedHorizon` — the same rule every other
//     value-bearing reader follows (quests.ts, arena.ts, referrals.ts, reward-oracle.ts). Everything the
//     reconciler can delete is above that horizon *by construction*, so a counted burn is final;
//   * the durable cursor (`burn_oracle_cursor.last_rowid`) may not step over a row that was not counted.
//     `events_raw.id` follows insertion order while slots do not (each program is indexed by its own
//     cursor), so reporting a low-slot burn that arrived late must not move the cursor past an unfinalized
//     burn indexed earlier — that burn would never be reported and emission would sit at the 30 % floor;
//   * the stall has to be visible: `/health.burnOracle.deferredMicro` + the `burn_oracle_deferred_cg` gauge,
//     because `pending` alone reads 0 in exactly the case the keeper exists to prevent.
//
// `backend/test/burn-oracle.test.ts` is the behavioural half (a dropped transaction's burn, and an
// out-of-slot-order burn, both against a real Db). These are the static rules, each with a known-bad
// mutation at the bottom: a gate nobody has seen fail is a comment.
//   node --experimental-strip-types --test tests/security/*.test.ts      (npm run security:static)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');

const ORACLE = read('backend/src/burn-oracle.ts');
const FINALITY = read('backend/src/finality.ts');
const SERVER = read('backend/src/server.ts');
const METRICS = read('backend/src/oracle-metrics.ts');
const OPENAPI = read('backend/openapi.yaml');
const EMISSION = read('programs/staking/src/instructions/emission.rs');

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

// ------------------------------------------------------------------- the rules
// Each rule takes a source text (the real one or a mutation of it) and throws on a violation.

/** The aggregation is finalized-only, and reportOnce is the caller that must take the default horizon. */
function ruleFinalizedOnly(oracle: string) {
  const body = fnBody(oracle, 'pendingBurn');
  const sql = queries(body);
  assert.match(body, /horizon = finalizedHorizon\(db\)/, 'the horizon must come from finality.ts — a caller that forgets it must still get the filtered default');
  assert.ok(sql.some((q) => /FROM burns b JOIN events_raw e/.test(q)), 'reads the burns joined to their raw event');
  assert.ok(sql.some((q) => /e\.slot AS slot/.test(q)), 'the row slot is needed to compare against the horizon');
  assert.match(body, /r\.slot > horizon/, 'rows above the horizon are not reportable: the reconciler deletes exactly those');
  assert.match(body, /if \(r\.id >= cutoff\)/, 'and the cursor may not step over them (see the ordering rule below)');
  assert.match(fnBody(oracle, 'reportOnce'), /pendingBurn\(d\.db, c\.last_rowid\)/, 'reportOnce uses the finalized default, never an explicit horizon');
}

/** The cursor moves once, after the send, and only to the watermark of what was counted.
 *
 * Находка 83: «после отправки» — это не «сразу после sendRawTransaction». Отчёт, который ушёл и не подтвердился,
 * нельзя закрывать повтором: `report_burn` складывает, поэтому повтор удваивает вход предохранителя эмиссии.
 * Отсюда вторая половина правила — `ruleNoDoubleReport`: курсор двигает только подтверждённая операция. */
function ruleCursorWatermark(oracle: string) {
  const body = fnBody(oracle, 'reportOnce');
  assert.ok(body.indexOf('await sendAndConfirm(') > -1, 'the report is sent');
  assert.doesNotMatch(body, /UPDATE burn_oracle_cursor/, 'reportOnce does not write the cursor itself: one write path (advanceCursor), so the monotone guard cannot be bypassed by a second UPDATE');
  const advance = fnBody(oracle, 'advanceCursor');
  assert.match(advance, /UPDATE burn_oracle_cursor/, 'advanceCursor is that one path');
  assert.match(advance, /WHERE id = 1 AND last_rowid < \?/, 'and it only steps forward: a second confirmation of the same report must not add its amount twice');
  assert.match(body, /advanceCursor\(d\.db, (?:p|landed)\.maxRowid, /, 'the cursor advances to the watermark of what was actually counted — not to the newest row seen');
  assert.match(body, /advanceCursor\(d\.db, p\.maxRowid, p\.amount, signature/, 'the freshly sent and confirmed report advances it itself');
  const status = fnBody(oracle, 'burnOracleStatus');
  assert.match(status, /deferredMicro: p\.deferredMicro\.toString\(\)/, '/health carries what is stuck behind finality');
  assert.match(status, /healthy: !\(waiting \|\| deferred\) \|\| fresh/, 'a material deferred set with a stale report is not "healthy"');
}

/**
 * «Отчёт ушёл, подтверждения нет» — не повод отчитываться ещё раз.
 *
 * Посылка правила живёт в программе: `report_burn` складывает (`saturating_add(amount)`), поэтому два отчёта за
 * одни и те же burn'ы считаются дважды. Пока это так, оракул обязан давать отчёту бизнес-ключ и решать судьбу
 * подписи по цепи, а не догадкой: неизвестный исход остаётся в полёте, `failed` ставится только на явный отказ
 * программы (у `TxError` есть `code`), иначе повтор будет молчаливым удвоением.
 */
function ruleNoDoubleReport(oracle: string, emission: string) {
  const rb = emission.slice(emission.indexOf('pub fn report_burn'));
  assert.match(rb, /burn_today = e\.burn_today\.saturating_add\(amount\)\.min\(clamp\)/, 'the premise: report_burn is additive on chain — if this stops being true, revisit this gate rather than delete it');
  const body = fnBody(oracle, 'reportOnce');
  assert.match(body, /const bizKey = burnReportKey\(p\.maxRowid\)/, 'one report, one business key — keyed by the watermark, so the next tick computes the same key');
  assert.match(body, /beginChainOp\(d\.db, \{ kind: 'burn_report', bizKey, payload/, 'the report is registered before it is sent, with its amount in the payload');
  const guard = body.indexOf('inFlight(op.status)');
  const send = body.indexOf('await sendAndConfirm(');
  assert.ok(guard > -1, 'an in-flight report is recognised as such');
  assert.ok(send > guard, 'and that check comes before the send: the second tick has to hit it, not pass it');
  assert.match(body, /reconcileChainOps\(/, 'the unknown outcome is settled by the chain (getSignatureStatuses), not by a clock');
  assert.match(body, /onSigned: \(sig, extra\) => recordSigned\(/, 'the signature is persisted as it is produced — a process that dies mid-confirm leaves a trace to reconcile');
  assert.match(body, /if \(sig && code === undefined\)/, 'only an explicit program refusal (`code`) may be marked failed; an unknown outcome must stay in flight');
  assert.match(body, /recordConfirmed\(d\.db, op2\.id, signature/, 'success is recorded on the operation, so the cursor step and the ledger agree');
}

/** Everything the reconciler can drop sits above the horizon the oracle counts — the two halves meet. */
function ruleHalvesMeet(finality: string) {
  const body = fnBody(finality, 'reconcileOnce');
  const sql = queries(body);
  assert.ok(sql.some((q) => /FROM events_raw WHERE finalized_at IS NULL AND slot <= \?/.test(q)), 'drops are selected from the unfinalized rows only — a finalized row is never retracted');
  assert.match(body, /dropSignatures\(db, gone\)/, 'and only those are dropped');
  assert.match(fnBody(finality, 'finalizedHorizon'), /MIN\(slot\) s FROM events_raw WHERE finalized_at IS NULL/, 'the horizon is the slot just before the oldest unfinalized event');
}

/** The stall is observable in the contract and in metrics, not only in a log line. */
function ruleObservable(oracle: string, server: string, metrics: string, openapi: string) {
  assert.match(server, /burn_oracle_deferred_cg/, 'a Prometheus series exists for the deferred set');
  assert.match(server, /burnOracle: burnOracleStatus\(db\)/, '/health publishes the keeper status');
  assert.match(metrics, /deferredCg: cg\(s\.deferredMicro\)/, 'the gauge reads the deferred micro-$CG, not the reportable one');
  assert.match(openapi, /deferredMicro: \{ type: string, description: SEC-B29/, 'documented in the contract (client/src/api/schema.d.ts is generated from it)');
  assert.match(fnBody(oracle, 'burnOracleStatus'), /deferredMicro/, 'and the status object carries it (the rule is on the same field the gauge reads)');
}

// ------------------------------------------------------------------- the tests
test('the burn oracle aggregates only finalized burns (the report cannot be taken back)', () => {
  ruleFinalizedOnly(ORACLE);
});

test('the cursor is written once, after the send, with the counted watermark only', () => {
  ruleCursorWatermark(ORACLE);
});

test('an unconfirmed report is reconciled, never re-sent (report_burn is additive on chain)', () => {
  ruleNoDoubleReport(ORACLE, EMISSION);
});

test('the two halves meet: everything the reconciler drops is above the horizon the oracle counts', () => {
  ruleHalvesMeet(FINALITY);
});

test('the stall is observable: /health field, gauge and openapi, not just a log line', () => {
  ruleObservable(ORACLE, SERVER, METRICS, OPENAPI);
});

// ---------------------------------------------------------------- mutations
const mutate = (src: string, find: string | RegExp, to: string) => {
  const before = src;
  const after = src.replace(find, to);
  assert.notStrictEqual(after, before, `mutation did not match: ${find}`);
  return after;
};
const fails = (fn: () => void) => { try { fn(); return false; } catch { return true; } };

test('mutations: the gates above are wired to the code they claim to guard', () => {
  // 1. "everything is final" — the horizon filter is what stands between a reorg and a week-long phantom burn
  const optimistic = mutate(ORACLE, /horizon = finalizedHorizon\(db\)/, 'horizon = Number.MAX_SAFE_INTEGER');
  assert.ok(fails(() => ruleFinalizedOnly(optimistic)));

  // 2. the cutoff is dropped: the cursor may step over a burn indexed out of slot order
  const jumps = mutate(ORACLE, /if \(r\.id >= cutoff\)/, 'if (false)');
  assert.ok(fails(() => ruleFinalizedOnly(jumps)));

  // 3. the cursor advances past what was counted (`p.maxRowid` is the watermark, `+ 1` skips a row)
  const past = mutate(ORACLE, /advanceCursor\(d\.db, p\.maxRowid, p\.amount, signature/, 'advanceCursor(d.db, p.maxRowid + 1, p.amount, signature');
  assert.ok(fails(() => ruleCursorWatermark(past)));

  // 3b. the monotone guard is dropped: two confirmations of one report would add its amount twice
  const backwards = mutate(ORACLE, /WHERE id = 1 AND last_rowid < \?/, 'WHERE id = 1');
  assert.ok(fails(() => ruleCursorWatermark(backwards)));

  // 4. no send at all: the cursor write would then be the only trace of a report nobody sent
  const unsent = mutate(ORACLE, /\(\{ signature \} = await sendAndConfirm\(/, '({ signature } = "x"); void (');
  assert.ok(fails(() => ruleCursorWatermark(unsent)));

  // 4b. the dedupe check is skipped: the second tick re-sends a brand-new transaction for the same burns
  const resend = mutate(ORACLE, /if \(inFlight\(op\.status\)\)/, 'if (false)');
  assert.ok(fails(() => ruleNoDoubleReport(resend, EMISSION)));

  // 4c. the signature is not persisted: a process that dies mid-confirm leaves nothing to reconcile
  const unsigned = mutate(ORACLE, /onSigned: \(sig, extra\) => recordSigned\(/, 'onSigned: () => void (');
  assert.ok(fails(() => ruleNoDoubleReport(unsigned, EMISSION)));

  // 4d. "unknown outcome" is treated as failure: the report is retried although the chain already has it
  const guessed = mutate(ORACLE, /if \(sig && code === undefined\)/, 'if (sig)');
  assert.ok(fails(() => ruleNoDoubleReport(guessed, EMISSION)));

  // 4e. the premise moves: report_burn becomes a set instead of a sum, so the gate must be revisited, not silently kept
  const idempotent = mutate(EMISSION, /burn_today = e\.burn_today\.saturating_add\(amount\)\.min\(clamp\)/, 'burn_today = amount.min(clamp)');
  assert.ok(fails(() => ruleNoDoubleReport(ORACLE, idempotent)));

  // 5. the reconciler starts retracting finalized rows: the construction the oracle relies on is gone
  const retract = mutate(FINALITY, /FROM events_raw WHERE finalized_at IS NULL AND slot <= \?/, 'FROM events_raw WHERE finalized_at IS NOT NULL AND slot <= ?');
  assert.ok(fails(() => ruleHalvesMeet(retract)));

  // 6. the deferred set stops being published — `pending` reads 0 through a finality stall
  const blind = mutate(ORACLE, /deferredMicro: p\.deferredMicro\.toString\(\)/, 'deferredMicro: "0"');
  assert.ok(fails(() => ruleCursorWatermark(blind)));

  // 7. the gauge is pointed at the reportable number instead of the deferred one
  const miswired = mutate(METRICS, /deferredCg: cg\(s\.deferredMicro\)/, 'deferredCg: cg(s.pendingMicro)');
  assert.ok(fails(() => ruleObservable(ORACLE, SERVER, miswired, OPENAPI)));
});
