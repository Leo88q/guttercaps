// SEC-B27 gate — "a transaction the RPC will not serve is recorded, not skipped".
// SECURITY-AUDIT-2026-09-26.md / SECURITY-AUDIT-2026-09-27-checklist.md.
//
// `getSignaturesForAddress` lists signatures; the transaction itself is a second call and
// `getTransaction` legitimately answers `null` (older than the provider's retention, or a transient
// answer). The walk used to `continue` on that null, finish, and stamp `history_complete = 1`: the read
// model was short whatever the transaction emitted — a ServicePaid (a player who paid and is told
// `payment_not_found`), a chip mint, a battle result — and nothing anywhere said a page had been short.
// The docs meanwhile promised a "sequence detector" and an `npm run backfill -- --from-slot …` command
// that did not exist (the root has no `backfill` script, and the CLI filtered the flags away and ran a
// full walk instead of the documented range).
//
// The rules below pin the three halves of the fix: the record (`indexer_gaps`), the honesty of the
// completeness flag, and the retry path (heal tick + `--repair-gaps`) with the operator surfaces the
// runbooks now point at. `backend/test/backfill.test.ts` is the behavioural half.
//   node --experimental-strip-types --test tests/security/*.test.ts      (npm run security:static)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');

const INGEST = read('backend/src/ingest.ts');
const BACKFILL = read('backend/src/backfill.ts');
const LISTEN = read('backend/src/listen.ts');
const SERVER = read('backend/src/server.ts');
const DB = read('backend/src/db.ts');
const PRISMA = read('backend/prisma/schema.prisma');
const ALERTS = read('ops/monitoring/alerts.yml');
const CATALOG = read('docs/ALERT_CATALOG.md');
const DR = read('docs/DISASTER_RECOVERY.md');

/** One function's source, from its declaration to the closing brace at the declaration's indentation. */
function fnBody(src: string, name: string): string {
  const m = new RegExp(`(?:^|\\n)(?:export )?(?:async )?function ${name}\\b`).exec(src);
  assert.ok(m, `function ${name} not found`);
  const start = m.index + (src[m.index] === '\n' ? 1 : 0);
  const end = src.indexOf('\n}', start);
  assert.ok(end > start, `function ${name} has no top-level terminator`);
  return src.slice(start, end + 2);
}

/** The body of a `const <name> = async () => { … };` arrow block (two-space indented, as `listen.ts` writes it). */
function arrowBlock(src: string, name: string): string {
  const opener = `const ${name} = async () => {`;
  const start = src.indexOf(opener);
  assert.ok(start >= 0, `${opener} not found`);
  const end = src.indexOf('\n  };', start);
  assert.ok(end > start, `${name} has no terminator`);
  return src.slice(start, end + 4);
}

test('a page the RPC cannot serve yields the missing signatures instead of a silent `continue`', () => {
  const body = fnBody(INGEST, 'ingestSignatures');
  assert.match(body, /missing\.push\(\{ signature: info\.signature, slot: info\.slot \}\)/, 'the unfetched signature must be returned to the caller — a `continue` here is the bug this rule exists for');
  assert.match(body, /return \{ events, inserted, missing \}/, 'and carried out of the page ingest');
  assert.ok(!/\bcatch\b/.test(body), 'a *throwing* fetch must abort the page (the cursor then stays put and the next run re-scans) — swallowing it would be indistinguishable from "served, emitted nothing"');
  assert.match(INGEST, /export interface MissingSignature \{ signature: string; slot: number \}/, 'the shape is named, so callers cannot quietly drop the slot (it is what bounds the loss)');
});

test('the history walk files the gaps and refuses to call an incomplete history complete', () => {
  const body = fnBody(BACKFILL, 'backfillProgram');
  assert.match(body, /recordGaps\(db, program, r\.missing\)/, 'the walk records what it could not fetch');
  assert.match(body, /const complete = unserved\.size === 0 \? 1 : 0;/, 'completeness is derived from the unserved set, not assumed');
  assert.match(body, /history_complete: complete/, 'and written to the cursor with that value');
  assert.ok(!/history_complete: 1\b/.test(body), 'no unconditional stamp anywhere in the walk');
  assert.match(body, /INCOMPLETE: \$\{unserved\.size\} transaction/, 'the run says it out loud, with the oldest slot');
});

test('the record is a real table in both schemas (the Postgres target cannot silently drop it)', () => {
  assert.match(DB, /CREATE TABLE IF NOT EXISTS indexer_gaps \(/, 'db.ts declares it (SCHEMA also creates it on an existing file)');
  const ddl = DB.slice(DB.indexOf('CREATE TABLE IF NOT EXISTS indexer_gaps ('), DB.indexOf('CREATE TABLE IF NOT EXISTS indexer_gaps (') + 400);
  assert.match(ddl, /PRIMARY KEY \(program, signature\)/, 'keyed so a re-scan cannot double-count a gap');
  for (const col of ['program', 'signature', 'slot', 'first_seen', 'attempts', 'last_attempt']) assert.match(ddl, new RegExp(`\\b${col}\\b`), `indexer_gaps.${col}`);
  assert.match(PRISMA, /@@map\("indexer_gaps"\)/, 'and the target schema maps the same table — `npm run schema:check` would fail a model-only table, but the intent belongs here too');
});

test('the repair pass retries oldest-first, parks what the provider will never serve, and both halves call it', () => {
  const body = fnBody(INGEST, 'repairIndexerGaps');
  assert.match(body, /ORDER BY slot ASC LIMIT \?/, 'oldest slot first: the gap that reaches furthest back is the one that can still be repaired');
  assert.match(body, /\$\{includeParked \? '' : 'WHERE attempts < \?'\}/, 'the ticks skip parked rows; only an explicit operator run retries them');
  assert.match(body, /UPDATE indexer_gaps SET attempts = \?, last_attempt = \?/, 'a still-failing fetch costs one attempt');
  assert.match(body, /if \(attempts >= maxAttempts\) out\.parked\+\+/, 'and the row is reported as parked at the cap');
  assert.match(body, /DELETE FROM indexer_gaps WHERE program = \? AND signature = \?/, 'a healed row is removed, so the table stays a work list rather than a growing log');

  const healer = arrowBlock(LISTEN, 'heal');
  assert.match(healer, /recordGaps\(db, p, r\.missing\)/, 'the listener records the recent-page half of the same record');
  assert.match(healer, /repairIndexerGaps\(connection, db, INDEXER_GAP_REPAIR_BATCH\)/, 'and the heal tick is the automatic retry (a gap recorded a minute ago is usually a transient answer)');

  const cli = BACKFILL.slice(BACKFILL.indexOf('if (import.meta.url ==='));
  assert.match(cli, /args\.includes\('--repair-gaps'\)/, 'the CLI dispatches on the documented flag');
  assert.match(cli, /\? repairGaps\(only\.length \? only : undefined\)/, 'the flag really runs the repair');
  assert.match(cli, /: backfillAll\(only\.length \? only : undefined\)/, 'and without it the CLI still walks the history (the flags of a walk are not silently ignored)');
  assert.match(BACKFILL, /npm run backend:backfill -- --repair-gaps/, 'the repair command is the one the runbooks quote');
});

test('the gaps are visible: /health, two scrapes, and an alert that reads them', () => {
  assert.match(SERVER, /indexerGaps: gapStatus\(db\)/, 'GET /v1/health carries the state');
  assert.match(SERVER, /registerScrape\('indexer_gaps_pending'/, 'a pending gauge a heal tick can drain');
  assert.match(SERVER, /registerScrape\('indexer_gaps_parked'/, 'and a parked gauge only an operator can drain (archival provider)');
  assert.match(ALERTS, /expr: indexer_gaps_pending > 0 or indexer_gaps_parked > 0/, 'an alert reads them — a counter nobody alerts on is a dashboard nobody watches');
});

test('the runbooks describe the mechanism that exists (the detector they used to promise did not)', () => {
  assert.match(CATALOG, /npm run backend:backfill -- --repair-gaps/, 'the gap runbook gives the command the CLI actually implements');
  assert.ok(!/--from-slot|--to-slot/.test(CATALOG), 'and no flag the CLI would silently ignore (the old `npm run backfill -- --from-slot …` line: no root `backfill` script, flags filtered away, a full walk instead of the range)');
  assert.match(CATALOG, /indexer_gaps_pending|\.indexerGaps/, 'the trigger is a value an operator can read back');
  assert.ok(!/sequence detector/i.test(DR), 'DISASTER_RECOVERY must not claim a sequence detector the tree does not have');
  assert.match(DR, /indexer_gaps/, 'it points at the record instead');
});

test('every `npm run …` an incident runbook quotes is a script that exists', () => {
  // The half of this finding that is not about code: ALERT-02 told the operator to run
  // `npm run backfill -- --from-slot … --to-slot …`. The root has no `backfill` script at all, and the
  // CLI filtered both flags away — so the command either fails or (worse, if the reader fixes the script
  // name themselves) silently runs a *full* walk while they believe they re-indexed a range. A runbook is
  // executed under pressure by someone who will not read the source; this rule is what keeps it runnable.
  const scripts = new Map<string, Set<string>>([
    ['', new Set(Object.keys(JSON.parse(read('package.json')).scripts as Record<string, string>))],
    ['--prefix backend', new Set(Object.keys(JSON.parse(read('backend/package.json')).scripts as Record<string, string>))],
    ['--prefix client', new Set(Object.keys(JSON.parse(read('client/package.json')).scripts as Record<string, string>))],
  ]);
  const quoted: [string, string][] = [];
  for (const rel of ['docs/ALERT_CATALOG.md', 'docs/DISASTER_RECOVERY.md']) {
    for (const m of read(rel).matchAll(/npm (?:--prefix (\S+) )?run ([A-Za-z0-9:_-]+)/g)) {
      quoted.push([rel, `npm ${m[1] ? `--prefix ${m[1]} ` : ''}run ${m[2]}`]);
    }
  }
  assert.ok(quoted.length >= 5, `the runbooks quote ${quoted.length} commands — the scan found nothing, which means the pattern changed`);
  const broken = quoted.filter(([, cmd]) => {
    const m = /^npm (?:--prefix (\S+) )?run (\S+)$/.exec(cmd)!;
    const set = scripts.get(m[1] ?? '');
    return !set || !set.has(m[2]!);
  });
  assert.deepEqual(broken, [], 'an incident runbook quotes a command that does not run');
});

// ---------------------------------------------------------------- mutations
// Each mutation edits the real source text and must make one rule above fail. The strings are byte-exact
// copies of what is in the tree; if an edit changes them the mutation stops asserting anything, so each
// one asserts its own match first.
const mutate = (src: string, find: string | RegExp, to: string) => {
  const before = src;
  const after = src.replace(find, to);
  assert.notStrictEqual(after, before, `mutation did not match: ${find}`);
  return after;
};
const fails = (fn: () => void) => { try { fn(); return false; } catch { return true; } };

test('mutations: every rule above is wired to the code it guards', () => {
  // 1. back to a silent skip: the unfetched page reports nothing
  const silent = mutate(fnBody(INGEST, 'ingestSignatures'), /missing\.push\(\{ signature: info\.signature, slot: info\.slot \}\);/, 'continue;');
  assert.ok(fails(() => assert.match(silent, /missing\.push\(/)));

  // 2. the page swallows a fetch error: the cursor advances past a transaction nobody ever read
  const swallowed = mutate(fnBody(INGEST, 'ingestSignatures'), /const ok = sigs\.filter/, 'try { void 0; } catch { /* swallow */ } const ok = sigs.filter');
  assert.ok(fails(() => assert.ok(!/\bcatch\b/.test(swallowed))));

  // 3. the walk stamps completeness unconditionally again
  const stamped = mutate(fnBody(BACKFILL, 'backfillProgram'), /const complete = unserved\.size === 0 \? 1 : 0;/, 'const complete = 1;');
  assert.ok(fails(() => assert.match(stamped, /const complete = unserved\.size === 0 \? 1 : 0;/)));

  // 4. the Postgres target loses the table (a port that silently drops the record)
  const ported = mutate(PRISMA, /@@map\("indexer_gaps"\)/, '@@map("indexer_gap")');
  assert.ok(fails(() => assert.match(ported, /@@map\("indexer_gaps"\)/)));

  // 5. the parked cap is dropped: every tick pays for a signature the provider will never serve again
  const uncapped = mutate(fnBody(INGEST, 'repairIndexerGaps'), /\$\{includeParked \? '' : 'WHERE attempts < \?'\}/, "''");
  assert.ok(fails(() => assert.match(uncapped, /WHERE attempts < \?/)));

  // 6. the listener stops recording (the recent half) — a page silently short instead of a written-down gap
  const deaf = mutate(arrowBlock(LISTEN, 'heal'), /recordGaps\(db, p, r\.missing\);/, 'void 0;');
  assert.ok(fails(() => assert.match(deaf, /recordGaps\(db, p, r\.missing\)/)));

  // 7. the alert goes away: a parked gap with nothing reading it
  const blind = mutate(ALERTS, /expr: indexer_gaps_pending > 0 or indexer_gaps_parked > 0/, 'expr: vector(0)');
  assert.ok(fails(() => assert.match(blind, /expr: indexer_gaps_pending > 0 or indexer_gaps_parked > 0/)));

  // 8. the runbook goes back to the flag the CLI ignores
  const lying = mutate(CATALOG, /npm run backend:backfill -- --repair-gaps/, 'npm run backfill -- --from-slot <slot_start> --to-slot <slot_end>');
  assert.ok(fails(() => assert.ok(!/--from-slot|--to-slot/.test(lying))));

  // 9. a runbook command that does not exist (the original defect: `npm run backfill` is not a script)
  const unrunnable = mutate(CATALOG, /npm run backend:backfill/, 'npm run backfill');
  const scripts = new Set(Object.keys(JSON.parse(read('package.json')).scripts as Record<string, string>));
  const cmd = /npm run (\S+)/.exec(unrunnable)!;
  assert.ok(fails(() => assert.ok(scripts.has(cmd[1]!), `runbook quotes npm run ${cmd[1]}, which is not a script`)));

  // 10. DISASTER_RECOVERY back to a detector that does not exist
  const imaginary = mutate(DR, /A gap is a signature the walk was told about but the RPC would not serve/, 'A sequence detector tracks slot intervals: any detected gap triggers a backfill fetch via getSignaturesForAddress before updating the head cursor.');
  assert.ok(fails(() => assert.ok(!/sequence detector/i.test(imaginary))));
});
