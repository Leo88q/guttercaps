// M-3 gate: the instruction arguments the programs declare, cross-checked against the hand-written
// Borsh at every call site.
//
// The finding was "no IDL, instructions are encoded by hand". The full fix commits `anchor build`'s IDL
// and diffs it in CI, and that needs a toolchain this sandbox does not have — but the *failure mode* the
// IDL protects against is checkable without one: a call site whose argument list no longer matches the
// `#[program]` signature it is aimed at. That is byte-level drift. The program decodes a different
// layout than the client wrote, and today nothing notices until a transaction fails on chain — or,
// worse, silently decodes into the wrong values.
//
// scripts/ix-shape.ts is the reader; this file is the half that keeps it honest. It asserts, in order:
//
//   1. the real tree has no drift, and the check is not vacuous (67 call sites, not three);
//   2. every instruction the registry *cannot* expand is in COMPLEX_INSTRUCTIONS, and nothing else is —
//      a new named argument type has to be a conscious decision, not a silent hole;
//   3. every call site whose encoding cannot be read is in UNRESOLVED_SITES, and nothing else is;
//   4. the two duplicated instruction names (`pause`, `set_paused`, `set_pauser`) still agree, because
//      the reader keys them by name alone;
//   5. the reader itself fails on each shape of drift, on synthetic input — a gate nobody has seen fail
//      is a comment.
//
// Runs offline in `npm run security:static`.
//   node --experimental-strip-types --no-warnings --test tests/security/ix-shape.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  COMPLEX_INSTRUCTIONS,
  UNRESOLVED_SITES,
  blindSpots,
  rustInstructions,
  shapeProblems,
  tsEncodings,
  writerSpecFor,
} from '../../scripts/ix-shape.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('M-3 no call site drifts from the instruction it encodes', () => {
  const { byName, conflicts } = rustInstructions(REPO);
  const encodings = tsEncodings(REPO);
  const problems = shapeProblems(encodings, byName, conflicts);
  assert.deepEqual(problems, [], problems.map((p) => `${p.where} ${p.name}: ${p.problem}`).join('\n'));

  // Not vacuous: this has to be looking at the real surface, not the three instructions that happen
  // to be inline.
  const { complex, complexEncoded } = blindSpots(encodings, byName);
  const checked = encodings.filter((e) => e.name !== null && e.chain !== null && !complex.some((c) => c.name === e.name));
  assert.ok(checked.length >= 50, `only ${checked.length} call sites were checked — the reader is not seeing the tree`);
  assert.ok(byName.size >= 90, `only ${byName.size} instructions were read from programs/`);
  assert.deepEqual(conflicts, [], 'two programs declare the same instruction name with different arguments');
});

test('M-3 the scope limits are exactly the ones written down', () => {
  const { byName } = rustInstructions(REPO);
  const encodings = tsEncodings(REPO);

  // (2) instructions with a type the registry cannot expand
  const complex = [...byName.values()].filter((ix) => ix.args.some((a) => writerSpecFor(a) === null)).map((ix) => ix.name).sort();
  assert.deepEqual(complex, [...COMPLEX_INSTRUCTIONS].sort(),
    'a new instruction carries an argument type the registry cannot expand — either teach the registry\n' +
    '(scripts/ix-shape.ts KNOWN_TYPES) or add it to COMPLEX_INSTRUCTIONS with the reason');

  // (3) call sites whose encoding cannot be read
  const blind = encodings.filter((e) => e.name === null || e.chain === null).map((e) => [e.file, e.name ?? '(dynamic)', e.why ?? ''] as const);
  assert.deepEqual(blind, [...UNRESOLVED_SITES].map(([f, n, w]) => [f, n, w] as const),
    'a new call site encodes an instruction in a way the reader cannot see — either make it resolvable\n' +
    'or add it to UNRESOLVED_SITES with the reason');

  // The instructions with no call site at all are the keeper-only and Rust-test-only ones; there are
  // enough of them that "every instruction is encoded somewhere" is not a rule, but the number is
  // recorded so a jump in it is visible rather than silent.
  const encoded = new Set(encodings.filter((e) => e.name).map((e) => e.name));
  const neverEncoded = [...byName.values()].filter((ix) => !encoded.has(ix.name));
  assert.ok(neverEncoded.length > 0 && neverEncoded.length <= 40,
    `${neverEncoded.length} of ${byName.size} instructions have no client call site — keeper-only, or the reader has stopped seeing them`);
});

// --------------------------------------------------------------------------- the reader, on synthetic input

const ix = (args: Record<string, string[]>) =>
  new Map(Object.entries(args).map(([name, a]) => [name, { program: 'p', name, args: a, at: 'a.rs:1' }]));
const at = (file: string, name: string | null, chain: string[] | null): { file: string; line: number; name: string | null; chain: string[] | null } =>
  ({ file, line: 1, name, chain });

test('M-3 the reader fails on every shape of drift', () => {
  const cases: Array<[string, Parameters<typeof shapeProblems>[0], Map<string, { program: string; name: string; args: string[]; at: string }>, number]> = [
    ['an argument dropped', [at('a.ts', 'x', ['u64'])], ix({ x: ['u64', 'Pubkey'] }), 1],
    ['an argument added', [at('a.ts', 'x', ['u64', 'pubkey', 'u8'])], ix({ x: ['u64', 'Pubkey'] }), 1],
    ['two arguments swapped', [at('a.ts', 'x', ['pubkey', 'u64'])], ix({ x: ['u64', 'Pubkey'] }), 1],
    ['a width changed u64 → u8', [at('a.ts', 'x', ['u8', 'pubkey'])], ix({ x: ['u64', 'Pubkey'] }), 1],
    ['a bool where u8 belongs', [at('a.ts', 'x', ['u64', 'bool'])], ix({ x: ['u64', 'u8'] }), 1],
    ['a chain on a zero-argument instruction', [at('a.ts', 'x', ['u8'])], ix({ x: [] }), 1],
    ['an unknown instruction name', [at('a.ts', 'nope', [])], ix({ x: [] }), 1],
    ['a Vec element type changed bytes → u8', [at('a.ts', 'x', ['vec', 'u8'])], ix({ x: ['Vec<[u8; 32]>'] }), 1],
    ['a fixed array encoded as bytes → u8', [at('a.ts', 'x', ['u8', 'u8', 'u64', 'u8'])], ix({ x: ['u8', 'u8', 'u64', '[u8; 32]'] }), 1],
    ['a fixed array given a length prefix', [at('a.ts', 'x', ['u8', 'u8', 'u64', 'vec', 'bytes'])], ix({ x: ['u8', 'u8', 'u64', '[u8; 32]'] }), 1],
    ['an Option inner widened pubkey → u8', [at('a.ts', 'x', ['option', 'u8'])], ix({ x: ['Option<Pubkey>'] }), 1],
    ['an Option discriminant written as pubkey', [at('a.ts', 'x', ['pubkey'])], ix({ x: ['Option<Pubkey>'] }), 1],
  ];
  for (const [what, encodings, instructions, want] of cases) {
    assert.equal(shapeProblems(encodings, instructions).length, want, `the reader must reject: ${what}`);
  }
  // and the shapes that are *not* drift, because Borsh really does allow them
  const clean: Array<[string, Parameters<typeof shapeProblems>[0], Map<string, { program: string; name: string; args: string[]; at: string }>]> = [
    ['an exact match', [at('a.ts', 'x', ['u64', 'pubkey'])], ix({ x: ['u64', 'Pubkey'] })],
    ['a None discriminant', [at('a.ts', 'x', ['option'])], ix({ x: ['Option<u64>'] })],
    ['a hand-written discriminant plus its value', [at('a.ts', 'x', ['u8', 'u64'])], ix({ x: ['Option<u64>'] })],
    ['a zero-argument instruction with no chain', [at('a.ts', 'x', [])], ix({ x: [] })],
    ['an out-of-scope named type', [at('a.ts', 'x', ['u8'])], ix({ x: ['ParamsPatch'] })],
  ];
  for (const [what, encodings, instructions] of clean) {
    assert.deepEqual(shapeProblems(encodings, instructions), [], `the reader must not reject: ${what}`);
  }
});

test('M-3 a drifted call site in a real file is caught', () => {
  // End to end, against a throwaway clone of the reader's own inputs: drop the `qty` argument from
  // `buy_pack` and the gate must name the file and the line. A reader that only ever passes on
  // synthetic input is a reader nobody has watched read this repository.
  const dir = mkdtempSync(join(tmpdir(), 'ix-shape-'));
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  };
  try {
    git('init', '--quiet', '.');
    git('config', 'user.email', 'gate@example.invalid');
    git('config', 'user.name', 'gate');
    mkdirSync(join(dir, 'programs/chip_core/src'), { recursive: true });
    mkdirSync(join(dir, 'client/src/chain/ix'), { recursive: true });
    writeFileSync(join(dir, 'programs/chip_core/src/lib.rs'), [
      'use anchor_lang::prelude::*;',
      '#[program] pub mod chip_core { pub fn buy_pack(_ctx: Context<X>, sku: u8, qty: u8, nonce: u64) -> Result<()> { Ok(()) } }',
      '',
    ].join('\n'));
    writeFileSync(join(dir, 'client/src/chain/ix/chipCore.ts'), [
      "import { ixData } from '../anchor';",
      "export const buyPackIx = () => Buffer.from(ixData('buy_pack', new BorshWriter().u8(1).u64(2n).toBytes()));",
      '',
    ].join('\n'));
    // `git ls-files` is how the readers enumerate, so the files have to be in the index.
    git('add', '-A');
    const { byName, conflicts } = rustInstructions(dir);
    const problems = shapeProblems(tsEncodings(dir), byName, conflicts);
    assert.equal(problems.length, 1, JSON.stringify(problems));
    assert.match(problems[0]!.where, /chipCore\.ts:2$/, 'the report names the file and the line');
    assert.match(problems[0]!.problem, /encodes \[u8, u64\]/, 'the report shows what was encoded');
    assert.match(problems[0]!.problem, /declares \[u8, u8, u64\]/, 'the report shows what the program wants');

    // Two arrow functions: without spreading both match lists into Math.max the second
    // writer's start is NaN and the gate reads a BorshWriter from the *other* function.
    writeFileSync(join(dir, 'client/src/chain/ix/chipCore.ts'), [
      "import { ixData } from '../anchor';",
      'export const leftover = () => {',
      "  const w = new BorshWriter().u8(1).u8(1).u64(2n);",
      '  return 0;',
      '};',
      'export const buyPackIx = () => {',
      "  return Buffer.from(ixData('buy_pack', w.toBytes()));",
      '};',
      '',
    ].join('\n'));
    git('add', '-A');
    const leaked = shapeProblems(tsEncodings(dir), rustInstructions(dir).byName, []);
    assert.equal(leaked.length, 0, JSON.stringify(leaked));
    const encodings = tsEncodings(dir);
    const buy = encodings.find((e) => e.name === 'buy_pack');
    assert.equal(buy?.chain, null, 'buy_pack must not pick up leftover\'s writer from another arrow function');

    // and the same file, uncorrupted, is clean
    writeFileSync(join(dir, 'client/src/chain/ix/chipCore.ts'), [
      "import { ixData } from '../anchor';",
      "export const buyPackIx = () => Buffer.from(ixData('buy_pack', new BorshWriter().u8(1).u8(1).u64(2n).toBytes()));",
      '',
    ].join('\n'));
    git('add', '-A');
    assert.deepEqual(shapeProblems(tsEncodings(dir), rustInstructions(dir).byName, []), [], 'the repaired encoding must pass');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
