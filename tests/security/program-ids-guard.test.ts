// SEC-F05 gate: a mainnet image may not be published while the four ids are declarations rather than a
// frozen deploy set.
//
// The defect this file is written against is not a missing check — it is a check that could not fire.
// `guard-mainnet` compared `[programs.mainnet]` against a hardcoded snapshot of the `GC…` ids that stood in
// Anchor.toml at the freeze-base commit. `program-ids -- apply` rewrites every copy of an id in one pass, so
// when the ids were rotated to the present `J68G8…` set the comparison could no longer match anything, and
// the gate printed
//
//     guard-mainnet OK: mainnet carries the frozen non-placeholder ids (== declare_id!).
//
// and exited 0 on the tree this test runs against — the same tree whose `npm run program-ids -- status`
// reports `unverified` for all four programs and whose `programs/program-ids.json` does not exist. Two
// subcommands of one script, opposite verdicts about one tree, and the false half was the log line an
// operator reads before a mainnet build. (The refusal did happen, one step later in `ops:buildenv`, for an
// unrelated reason — which is exactly how a gate rots unnoticed: something is still red, so nobody asks
// which line said what.)
//
// The fix reads the evidence `status` prints the absence of: the freeze record. So this file pins, in order:
//
//   1. the verdict on the real tree follows the record's presence, and the refusal names it — the
//      regression is that this tree must be refused, and before the change it was not;
//   2. every way a record can be unusable flips the verdict: absent, malformed, a stale id, an entry
//      written where the keypair was not, a record that does not speak for a program;
//   3. `mainnet == declare_id!` is still enforced with a perfect record in hand — on the images path this
//      gate runs alone (`check` does not run there), and a hand-edited mainnet section would deploy
//      somewhere the client never looks;
//   4. the writer agrees with both readers — `freezeIds` in scripts/deploy-build-env.ts compared the build
//      env against the record and matched nothing at all until this change, because it read the list
//      `manifest` writes as a map keyed by program;
//   5. comparing mainnet against devnet is *not* the fix, tempting as it is: after the ceremony all three
//      clusters share the frozen ids on purpose (one cold keypair signs both, docs/09 §2), so that
//      comparison would report the healthy state as the alarm.
//
// Runs offline in `npm run security:static`.
//   node --experimental-strip-types --no-warnings --test tests/security/program-ids-guard.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freezeRecordDoc, guardProblems, parseFreezeRecord, type FreezeState } from '../../scripts/program-ids.ts';
import { freezeIds } from '../../scripts/deploy-build-env.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');
const RECORD = 'programs/program-ids.json';
const PROGRAMS = ['chip_core', 'market', 'staking', 'arena'] as const;

/** `declare_id!` per program, read from the tree: an expectation taken from the module under test would
 * only ever say that the module agrees with itself. */
function declaredIds(): Record<string, string> {
  return Object.fromEntries(PROGRAMS.map((p) => {
    const m = /declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\)/.exec(read(`programs/${p}/src/lib.rs`));
    assert.ok(m, `no declare_id! in programs/${p}/src/lib.rs`);
    return [p, m[1]!];
  }));
}

/** `[programs.<cluster>]` of Anchor.toml (`sb_mock` is localnet-only and never a deploy id). */
function anchorIds(cluster: string): Record<string, string> {
  const out: Record<string, string> = {};
  let inside = false;
  for (const line of read('Anchor.toml').split('\n')) {
    if (/^\[programs\./.test(line)) { inside = line.trim() === `[programs.${cluster}]`; continue; }
    if (inside && /^\[/.test(line)) break;
    if (!inside) continue;
    const m = /^\s*([a-z_]+)\s*=\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/.exec(line);
    if (m && m[1] !== 'sb_mock') out[m[1]!] = m[2]!;
  }
  return out;
}

/**
 * Would a deploy be cut from this tree? Re-derived from the tree's own evidence — the declared ids, the
 * mainnet section and the record's contents — so the assertion below is about the tree, not about the
 * module it imports. `true` is the post-ceremony state; `false` is the state every checkout is in until it.
 */
function treeIsFrozen(): boolean {
  const declared = declaredIds();
  const mainnet = anchorIds('mainnet');
  if (PROGRAMS.some((p) => mainnet[p] === undefined || mainnet[p] !== declared[p])) return false;
  if (!existsSync(join(REPO, RECORD))) return false;
  let programs: unknown;
  try { programs = (JSON.parse(read(RECORD)) as { programs?: unknown }).programs; } catch { return false; }
  if (!Array.isArray(programs)) return false;
  const byName = new Map((programs as { name?: unknown; id?: unknown; keypairPresent?: unknown }[])
    .filter((e) => typeof e?.name === 'string')
    .map((e) => [e.name as string, e]));
  return PROGRAMS.every((p) => byName.get(p)?.id === declared[p] && byName.get(p)?.keypairPresent === true);
}

test('SEC-F05 the gate refuses this tree exactly while no usable freeze record is committed', () => {
  const frozen = treeIsFrozen();
  const run = spawnSync(process.execPath, ['--experimental-strip-types', join(REPO, 'scripts/program-ids.ts'), 'guard-mainnet'], { cwd: REPO, encoding: 'utf8' });
  assert.ifError(run.error);
  assert.equal(run.status, frozen ? 0 : 1,
    `guard-mainnet exited ${run.status} on a tree that ${frozen ? 'carries' : 'does not carry'} a frozen deploy set\n${run.stdout}${run.stderr}`);
  if (frozen) {
    assert.match(run.stdout, /guard-mainnet OK: .*programs\/program-ids\.json/);
    return;
  }
  // The regression, stated as the assertion that was false before the change: this tree used to get the OK
  // line above, while `status` of the same script said `unverified` four times.
  assert.doesNotMatch(run.stdout, /guard-mainnet OK/, 'the gate printed its OK line for a tree it would not deploy from');
  assert.match(run.stderr, /no freeze record \(programs\/program-ids\.json\)/);
  // …and it points at the state `status` prints — the reason the record is missing is that the ids were
  // never checked against a keypair, and the note says which of the two situations the checkout is in.
  assert.match(run.stderr, /ids unverified|-- check --from DIR/);
});

// --------------------------------------------------------------------------- the verdict, case by case

/** The three inputs `guardProblems` reads, with values nobody can mistake for the tree's: the cases below
 * are about the *shape* of the record and the section, not about which ids today's tree carries. */
const D: Record<string, string> = Object.fromEntries(PROGRAMS.map((p) => [p, `declared-${p}`]));
const healthy = (): FreezeState => ({ kind: 'ok', record: parseFreezeRecord(recordJson(D))! });
/** `programs/program-ids.json` as `manifest` writes it: `programs[]` is a list of entries. */
const recordJson = (ids: Record<string, string>, keypairPresent = true) =>
  JSON.stringify({ generatedBy: 'npm run program-ids -- manifest', programs: PROGRAMS.map((p) => ({ name: p, id: ids[p], keypairPresent })) });
const problemsFor = (freeze: FreezeState, mainnet: Record<string, string> = { ...D }) =>
  guardProblems({ mainnet, declared: { ...D }, freeze });

test('SEC-F05 a tree whose every id copy agrees is still refused while the record is absent', () => {
  // The exact input the old gate passed: every copy of the id agrees (that is what `apply` guarantees, and
  // it is all the old comparison could see). `guardProblems` must have exactly one thing to say.
  const problems = problemsFor({ kind: 'absent' });
  assert.equal(problems.length, 1, `expected exactly the missing-record refusal, got:\n${problems.join('\n')}`);
  assert.match(problems[0]!, /no freeze record \(programs\/program-ids\.json\)/);
  assert.match(problems[0]!, /declarations, not a frozen deploy set/);
  assert.match(problems[0]!, /npm run program-ids -- new --out DIR/, 'the refusal has to name the way out');
});

test('SEC-F05 each unusable record is refused for its own reason, and a good one is silent', () => {
  const cases: [what: string, freeze: FreezeState, want: RegExp][] = [
    ['absent', { kind: 'absent' }, /no freeze record/],
    ['the file is not a record', { kind: 'malformed' }, /is not the record `manifest` writes/],
    ['a stale id — the ids moved after the freeze', healthyWith({ chip_core: 'older-chip-core' }), /the ids moved after the freeze/],
    ['a record written where the keypair was not', healthyWith(D, false), /keypairPresent: false/],
    ['a record that does not speak for a program', healthyWithout('arena'), /has no entry for arena/],
  ];
  for (const [what, freeze, want] of cases) {
    const problems = problemsFor(freeze);
    assert.ok(problems.length, `${what}: the gate passed a record it cannot deploy from`);
    assert.ok(problems.some((p) => want.test(p)), `${what}: nothing matches ${want}\n${problems.join('\n')}`);
  }
  // The shape is the one failure mode that cannot be expressed as a `FreezeState`: the file parses as JSON
  // and `programs` is there — it is just a map, which is what `scripts/deploy-build-env.ts` read for as long
  // as the record existed. `parseFreezeRecord` refuses it, so the CLI reports it as malformed rather than
  // absent, and either way it is not deployable.
  assert.equal(parseFreezeRecord(JSON.stringify({ programs: { chip_core: D.chip_core } })), null);

  // The healthy state — and therefore the post-ceremony state — must be silent, or the gate is red forever.
  assert.deepEqual(problemsFor(healthy()), []);
  // …while a hand-edited mainnet section is caught with a perfect record in hand: on the images path this
  // gate runs alone, and nothing else would notice a program that now lives somewhere the client never looks.
  const handEdited = problemsFor(healthy(), { ...D, arena: 'somewhere-else' });
  assert.equal(handEdited.length, 1, handEdited.join('\n'));
  assert.match(handEdited[0]!, /\[programs\.mainnet\] arena = somewhere-else != declare_id! declared-arena/);
});

function healthyWith(ids: Record<string, string>, keypairPresent = true): FreezeState {
  return { kind: 'ok', record: parseFreezeRecord(recordJson({ ...D, ...ids }, keypairPresent))! };
}
function healthyWithout(program: string): FreezeState {
  const doc = JSON.parse(recordJson(D)) as { programs: { name: string }[] };
  return { kind: 'ok', record: parseFreezeRecord(JSON.stringify({ ...doc, programs: doc.programs.filter((e) => e.name !== program) }))! };
}

test('SEC-F05 the writer, the gate and the other reader agree on the shape — and keypairPresent is a measurement', () => {
  const fromWriter = JSON.stringify(freezeRecordDoc('tests/localnet/fixtures'));
  const parsed = parseFreezeRecord(fromWriter);
  assert.ok(parsed, 'the record `manifest` writes does not parse back — the gate would refuse a frozen tree');
  const declared = declaredIds();
  for (const p of PROGRAMS) {
    assert.equal(parsed.ids[p], declared[p], `the record's ${p} is not the declared id`);
    // `keypairPresent` is an observation of the directory `manifest` was pointed at, not a literal `true`:
    // a checkout has no deploy keypair (they are never committed), which is why CI cannot verify ids and
    // why the record, not a keypair, is the evidence the gate reads.
    assert.equal(parsed.keypairsPresent[p], existsSync(join(REPO, 'tests/localnet/fixtures', `${p}-keypair.json`)));
  }
  assert.equal(PROGRAMS.some((p) => parsed.keypairsPresent[p]), false, 'tests/localnet/fixtures now holds a deploy keypair — a checkout must not, and the assertions below assume the honest record says so');
  // …and a record written in a checkout is refused for exactly that reason.
  assert.ok(guardProblems({ mainnet: declared, declared, freeze: { kind: 'ok', record: parsed } }).some((p) => /keypairPresent: false/.test(p)));

  // One writer, two readers. `freezeIds` is the half `ops:buildenv` compares the build env against; until
  // this change it read `programs` as a map, so every comparison was against `undefined` and the freeze
  // record was silently not checked at all.
  assert.deepEqual(freezeIds(fromWriter), parsed.ids);
  assert.equal(freezeIds(JSON.stringify({ programs: { chip_core: declared.chip_core } })), null, 'the map shape must be refused, not read as an empty record');
  assert.equal(freezeIds('{ not json'), null);
  assert.equal(freezeIds(JSON.stringify({ programs: [{ name: 'chip_core' }] })), null, 'an entry without an id is not a record');

  // …and the section relation is deliberately not the gate: every cluster carries the same frozen ids, so a
  // gate comparing mainnet against devnet would call the healthy post-ceremony state an alarm.
  const frozen = parseFreezeRecord(recordJson(declared))!;
  assert.deepEqual(anchorIds('devnet'), declared, 'the tree no longer shares ids across clusters — if that is deliberate, this gate and docs/09 §2 have to be re-read together');
  assert.deepEqual(guardProblems({ mainnet: { ...declared }, declared, freeze: { kind: 'ok', record: frozen } }), []);
});
