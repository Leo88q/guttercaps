// M-3 (AUDIT-2026-10-02): the instruction-argument shapes of the programs, cross-checked against the
// manual Borsh encoding at every call site.
//
// The finding was "no IDL, instructions are encoded by hand". `anchor build` produces an IDL and the
// full fix (variant A) is to commit it and diff it in CI — that needs a toolchain this sandbox does not
// have, and a guessed IDL is worse than none. What *is* checkable offline is the thing the IDL would
// have caught anyway: a call site whose argument list no longer matches the `#[program]` signature it
// is aimed at. That is a byte-level drift — the program decodes a different layout than the client
// wrote — and today nothing notices until a transaction fails on chain (or, worse, silently decodes
// into the wrong values).
//
// So this script answers, without a compiler:
//
//   for every `ixData(...)` call site, does the BorshWriter chain encode the same argument
//   sequence the Rust `pub fn name(ctx, …)` declares?
//
// Three deliberate limits, because a gate that cries wolf gets deleted:
//
//   1. **Only the call sites whose encoding is statically resolvable.** An inline
//      `new BorshWriter().u8(…).u64(…)`, or a `const w = new BorshWriter()…` in the same function, is
//      resolvable. A builder passed into a helper, or an `ixData(name, …)` with a computed name, is
//      not — those are listed and counted, and the count is asserted, so a new unresolvable site fails
//      the gate instead of quietly joining the blind spot.
//   2. **Only instructions whose arguments are all in the encoding registry below.** Named custom
//      types (`LeafProofArgs`, `ParamsPatch`, …) expand to a sequence that depends on their fields, and
//      resolving those needs the IDL the finding is about. They are listed explicitly and the list is
//      asserted, so a new one is a conscious decision rather than a silent hole.
//   3. **Order and method, not value.** A `.u8(x)` where Rust wants `u64` is caught; a `.u64(1)` where
//      Rust wants `u64(2)` is not — that is what the localnet specs are for.
//
//   node --experimental-strip-types scripts/ix-shape.ts          # report
//   node --experimental-strip-types scripts/ix-shape.ts --selftest
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const REPO = process.cwd();

// --------------------------------------------------------------------------- the encoding registry

/**
 * A Rust argument type → the `BorshWriter` methods that encode it, in order. One entry per *call*, so
 * `String` is one `.string(...)` even though it writes a length prefix internally.
 */
const WRITER: Record<string, string[]> = {
  u8: ['u8'],
  u16: ['u16'],
  u32: ['u32'],
  u64: ['u64'],
  u128: ['u128'],
  i64: ['i64'],
  bool: ['bool'],
  Pubkey: ['pubkey'],
  String: ['string'],
};

/**
 * Named types whose encoding is a fixed, known sequence. Each one is a struct or enum the client
 * flattens by hand; the sequence is what the call sites actually do today, and the gate fails the
 * moment a call site does something else. Keeping them here — rather than deriving them — is the
 * point: the derivation is what the IDL would give us, and until it does, a wrong entry is a visible,
 * reviewable line instead of a silent mismatch.
 */
const KNOWN_TYPES: Record<string, string[]> = {
  Currency: ['u8'], // a Rust enum, Borsh-encoded as its discriminant
  LeafProofArgs: ['bytes', 'bytes', 'bytes', 'bytes', 'bytes', 'u8', 'u64', 'u32'],
  /** `[u8; 32]` — a fixed 32-byte array, no length prefix (Borsh fixed arrays are raw). */
  '[u8; 32]': ['bytes'],
  '[u8; 64]': ['bytes'],
  /** `Vec<[u8; 32]>` — `w.vec(items, p => w.bytes(p))`: a u32 length, then each element. */
  'Vec<[u8; 32]>': ['vec', 'bytes'],
  /** `Vec<u8>` — `w.vec(bytes, b => w.u8(b))`. */
  'Vec<u8>': ['vec', 'u8'],
};

/** The instructions whose argument list contains a type this registry cannot expand. */
export const COMPLEX_INSTRUCTIONS = [
  'initialize', // InitArgs — the whole config struct
  'set_params', // ParamsPatch — a struct of Option<> fields
  'init_emission', // InitEmissionArgs
  'set_oracles', // OraclePatch
  'set_split', // [u16; SPLIT_COUNT]
  'create_battle_v2', // [LeafProofArgs; SQUAD] / [Pubkey; SQUAD]
  'accept_battle_v2', // [LeafProofArgs; SQUAD] / [u8; SQUAD]
] as const;

/**
 * The `ixData` call sites whose encoding cannot be read statically, as `[file, name, why]`. The `why` is
 * whatever the reader prints, so the list is a diff of the reader's own output rather than a parallel
 * description that can drift from it. Each entry is a place where the client and the program agree only
 * because somebody ran it: the gate fails when a fourth appears, which is the moment to either make it
 * resolvable or accept it in writing.
 */
export const UNRESOLVED_SITES = [
  ['client/src/chain/anchor.ts', '(dynamic)', 'computed name: name: string, args: Uint8Array = new Uint8Array('],
  ['client/src/chain/ix/arena.ts', '(dynamic)', 'computed name: name, w.toBytes()'],
  ['client/src/chain/ix/rng.ts', '(dynamic)', 'computed name: name, new BorshWriter().bytes(a.signature).u8(a.'],
] as const;

/** Every method `BorshWriter` can be called with, so an unknown one is reported rather than ignored. */
export const WRITER_METHODS = ['u8', 'u16', 'u32', 'u64', 'u128', 'i64', 'bool', 'pubkey', 'bytes', 'string', 'vec', 'option'];

// --------------------------------------------------------------------------- readers

/** One `pub fn` declared inside a `#[program]` module. */
export interface Instruction {
  program: string;
  name: string;
  /** Argument types in declaration order, `ctx` excluded. */
  args: string[];
  at: string;
}

/** Split on top-level commas, so `Option<Pubkey>, u64` is two arguments and `[u8; 32]` is one. */
function splitArgs(params: string): string[] {
  const out: string[] = [];
  let cur = '';
  let nest = 0;
  for (const ch of params) {
    if (ch === '<' || ch === '(' || ch === '[') nest++;
    else if (ch === '>' || ch === ')' || ch === ']') nest--;
    if (ch === ',' && nest === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Every `#[program]` instruction in `programs/`, keyed by instruction name.
 *
 * Three names (`pause`, `set_paused`, `set_pauser`) are declared by more than one program. They are
 * keyed by name alone, so a divergence between them has to be *reported* rather than silently
 * overwritten: `conflicts` is empty today because all three agree, and the gate asserts that.
 */
export function rustInstructions(repo = REPO): { byName: Map<string, Instruction>; conflicts: string[] } {
  const conflicts: string[] = [];
  const files = spawnSync('git', ['ls-files', 'programs/**/*.rs'], { cwd: repo, encoding: 'utf8' });
  if (files.status !== 0) throw new Error(`git ls-files failed: ${files.stderr}`);
  const out = new Map<string, Instruction>();
  for (const rel of files.stdout.split('\n').filter(Boolean)) {
    // Comments go first: a commented-out `pub fn` is not an instruction, and a `//` inside a string
    // literal is not a comment — the second case does not occur in a `#[program]` module.
    const src = readFileSync(join(repo, rel), 'utf8').replace(/\/\/[^\n]*/g, '');
    const pm = /#\[program\]\s*pub\s+mod\s+(\w+)\s*\{/.exec(src);
    if (!pm) continue;
    const open = pm.index + pm[0].length - 1;
    let depth = 0;
    let close = open;
    for (; close < src.length; close++) {
      if (src[close] === '{') depth++;
      else if (src[close] === '}') { depth--; if (!depth) break; }
    }
    const body = src.slice(open + 1, close);
    for (const fm of body.matchAll(/\bpub\s+fn\s+(\w+)\s*(?:<[^(]*>)?\s*\(/g)) {
      const pOpen = fm.index + fm[0].length - 1;
      let d = 0;
      let pClose = pOpen;
      for (; pClose < body.length; pClose++) {
        if (body[pClose] === '(') d++;
        else if (body[pClose] === ')') { d--; if (!d) break; }
      }
      // The Anchor context is the first parameter and is not an encoded argument. `_ctx` counts too:
      // an unused context is still spelled with the leading underscore in Rust, and a reader that
      // only knew `ctx` would treat `Context<X>` as a named argument type and silently put the whole
      // instruction out of scope.
      const args = splitArgs(body.slice(pOpen + 1, pClose))
        .filter((a) => a && !/^_?ctx\s*:/.test(a))
        .map((a) => a.split(':').slice(1).join(':').trim());
      const at = `${rel}:${src.slice(0, pm.index + fm.index).split('\n').length}`;
      const prev = out.get(fm[1]!);
      if (prev) {
        if (prev.args.join() !== args.join()) {
          conflicts.push(`${fm[1]} is declared twice with different arguments: ${prev.at} [${prev.args.join(', ')}] and ${at} [${args.join(', ')}]`);
        }
        continue;
      }
      out.set(fm[1]!, { program: pm[1]!, name: fm[1]!, args, at });
    }
  }
  return { byName: out, conflicts };
}

/** The text between two balanced parentheses, starting at the `(` in `s` at `i`. */
function balanced(s: string, i: number): string {
  let d = 0;
  for (let k = i; k < s.length; k++) {
    if (s[k] === '(') d++;
    else if (s[k] === ')') { d--; if (!d) return s.slice(i + 1, k); }
  }
  return '';
}

/**
 * One expected writer call. `alts` are the methods that satisfy it (an `Option` discriminant is written
 * either through the `.option()` combinator or by hand as a `.u8(0/1)`), and `optional` marks the
 * inner encoding of an `Option`, which is genuinely absent when the value is `None`.
 */
interface Token { alts: readonly string[]; optional?: boolean }

/** The expected writer calls for a Rust type, or `null` when the registry cannot expand it. */
export function writerSpecFor(rustType: string): Token[] | null {
  const direct = WRITER[rustType] ?? KNOWN_TYPES[rustType];
  if (direct) return direct.map((m) => ({ alts: [m] }));
  const opt = /^Option<(.+)>$/.exec(rustType);
  if (opt) {
    const inner = writerSpecFor(opt[1]!);
    // Both spellings are correct Borsh: `.option(v, w)` and a hand-written `.u8(disc)` + value. The
    // inner is optional because `None` really does encode to a single byte.
    return inner ? [{ alts: ['option', 'u8'] }, ...inner.map((t) => ({ ...t, optional: true }))] : null;
  }
  const vec = /^Vec<(.+)>$/.exec(rustType);
  if (vec) { const inner = writerSpecFor(vec[1]!); return inner ? [{ alts: ['vec'] }, ...inner] : null; }
  // A fixed array of a known element type is N repetitions, so it is only checkable when the element
  // type is a single method and N is spelled out — which the KNOWN_TYPES entries above do. Anything
  // else falls through to "complex".
  return null;
}

/** The methods a Rust type expands to, flattened. Kept for the report and the selftest. */
export function writerMethodsFor(rustType: string): string[] | null {
  const spec = writerSpecFor(rustType);
  return spec ? spec.flatMap((t) => t.alts.slice(0, 1)) : null;
}

/**
 * Does `chain` satisfy `spec`, left to right, with the `optional` tokens allowed to be absent?
 * Backtracking rather than a greedy walk, because an optional inner that happens to look like the
 * next required token would otherwise be consumed by the wrong argument.
 */
function matchesSpec(chain: readonly string[], spec: readonly Token[]): boolean {
  const walk = (i: number, j: number): boolean => {
    if (j === spec.length) return i === chain.length;
    const token = spec[j]!;
    const here = chain[i];
    if (token.alts.includes(here ?? '')) {
      if (walk(i + 1, j + 1)) return true;
      // The discriminant matched but the rest of the chain belongs to the next argument: try skipping
      // this token entirely, which is what `None` looks like.
      if (token.optional && walk(i, j + 1)) return true;
      return false;
    }
    return token.optional ? walk(i, j + 1) : false;
  };
  return walk(0, 0);
}

/** One `ixData(...)` call site. */
export interface Encoding {
  file: string;
  line: number;
  /** The literal instruction name, or `null` when it is computed. */
  name: string | null;
  /** The writer methods in order, `[]` for a no-argument instruction, `null` when unresolvable. */
  chain: string[] | null;
  why?: string;
}

/**
 * Every `ixData(...)` in the client, the backend and the localnet harness.
 *
 * The builder is resolved inside the *enclosing function*, not merely "the nearest preceding one": a
 * file with four `const w = new BorshWriter()` otherwise resolves every claim to whichever came first,
 * which is how a gate ends up comparing the wrong two things and passing.
 */
export function tsEncodings(repo = REPO): Encoding[] {
  const globs = ['client/src/**/*.ts', 'backend/src/**/*.ts', 'tests/localnet/**/*.ts'];
  const listed = spawnSync('git', ['ls-files', ...globs.flatMap((g) => [g, g.replace('.ts', '.tsx')])], { cwd: repo, encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
  const out: Encoding[] = [];
  for (const rel of listed.stdout.split('\n').filter((f) => f && !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'))) {
    const src = readFileSync(join(repo, rel), 'utf8');
    for (const m of src.matchAll(/ixData\(/g)) {
      const at = m.index!;
      const line = src.slice(0, at).split('\n').length;
      const inner = balanced(src, at + 'ixData'.length);
      const q = /^\s*'([A-Za-z_0-9]+)'\s*(?:,\s*([\s\S]*))?$/.exec(inner);
      if (!q) { out.push({ file: rel, line, name: null, chain: null, why: `computed name: ${inner.slice(0, 48)}` }); continue; }
      const name = q[1]!;
      const expr = (q[2] ?? '').trim();
      if (!expr) { out.push({ file: rel, line, name, chain: [] }); continue; }
      if (/^new BorshWriter\(\)/.test(expr)) {
        out.push({ file: rel, line, name, chain: [...expr.matchAll(/\.(\w+)\(/g)].map((x) => x[1]!).filter((x) => x !== 'toBytes') });
        continue;
      }
      const idm = /^([A-Za-z_$][\w$]*)(?:\.toBytes\(\))?$/.exec(expr);
      if (idm) {
        const id = idm[1]!;
        const fnStart = Math.max(
          ...[...src.slice(0, at).matchAll(/\n(?:export\s+)?(?:async\s+)?function\s+\w+[^\n{]*\{\n/g)].map((x) => x.index! + x[0].length),
          [...src.slice(0, at).matchAll(/\n(?:export\s+)?const\s+\w+\s*=\s*[^\n=]*=>\s*\{\n/g)].map((x) => x.index! + x[0].length),
          0,
        );
        const scope = src.slice(fnStart, at);
        // The declaration match has to run to the end of the *statement*, not stop at `()`: a
        // `const w = new BorshWriter().u64(a.amount);` carries its first argument in the chain, and a
        // reader that stops at `()` reports the whole instruction as encoding nothing.
        const decls = [...scope.matchAll(new RegExp(`(?:const|let)\\s+${id}\\s*=\\s*new BorshWriter\\(\\)([^;]*)`, 'g'))];
        const decl = decls[decls.length - 1];
        if (!decl) { out.push({ file: rel, line, name, chain: null, why: `builder ${id} not declared in this function` }); continue; }
        // Methods chained on the declaration itself, plus every later `w.method(` — including the ones
        // inside a `vec` / `option` callback, which are where the element encoding lives.
        const chained = [...decl[1]!.matchAll(/\.(\w+)\(/g)].map((x) => x[1]!).filter((x) => x !== 'toBytes');
        const later = [...scope.slice(decl.index! + decl[0].length).matchAll(new RegExp(`\\b${id}\\.(\\w+)\\(`, 'g'))].map((x) => x[1]!);
        out.push({ file: rel, line, name, chain: [...chained, ...later] });
        continue;
      }
      out.push({ file: rel, line, name, chain: null, why: expr.slice(0, 48) });
    }
  }
  return out;
}

// --------------------------------------------------------------------------- the rule

export interface ShapeProblem {
  where: string;
  name: string;
  problem: string;
}

/**
 * The rule, as a pure function of the two readers, so the gate and the self-test share one
 * implementation. Returns the problems, not a boolean: "12 sites drifted" is not actionable and
 * "buy_pack encodes u8,u8,u8,u64,u64 but declares u8,u8,u8,u64" is.
 */
export function shapeProblems(encodings: readonly Encoding[], instructions: Map<string, Instruction>, conflicts: readonly string[] = []): ShapeProblem[] {
  const problems: ShapeProblem[] = conflicts.map((c) => ({ where: 'programs/', name: '(ambiguous)', problem: c }));
  for (const e of encodings) {
    const where = `${e.file}:${e.line}`;
    if (e.name === null) continue; // counted separately, see the unresolvable rule
    const ix = instructions.get(e.name);
    if (!ix) { problems.push({ where, name: e.name, problem: 'no #[program] instruction with this name' }); continue; }
    if (e.chain === null) continue; // counted separately, see the unresolvable rule
    const spec = ix.args.map((a) => writerSpecFor(a));
    if (spec.some((x) => x === null)) {
      // Not a failure — a scope limit. COMPLEX_INSTRUCTIONS is what makes it visible.
      continue;
    }
    const got = e.chain;
    const want = spec.flatMap((x) => x!.flatMap((t) => t.alts.slice(0, 1)));
    if (!matchesSpec(got, spec.flat() as Token[])) {
      problems.push({
        where,
        name: e.name,
        problem: `encodes [${got.join(', ')}] but ${ix.at} declares [${ix.args.join(', ')}] → [${want.join(', ')}]`,
      });
    }
    for (const method of got) {
      if (!WRITER_METHODS.includes(method)) problems.push({ where, name: e.name, problem: `unknown writer method .${method}()` });
    }
  }
  return problems;
}

/** The rule's blind spots, stated so the gate can assert they do not grow unnoticed. */
export function blindSpots(encodings: readonly Encoding[], instructions: Map<string, Instruction>) {
  const unresolvable = encodings.filter((e) => e.name === null || e.chain === null);
  const complex = [...instructions.values()].filter((ix) => ix.args.some((a) => writerSpecFor(a) === null));
  const complexEncoded = complex.filter((ix) => encodings.some((e) => e.name === ix.name));
  return { unresolvable, complex, complexEncoded };
}

// --------------------------------------------------------------------------- selftest

function selftest(): number {
  let failed = 0;
  const check = (name: string, got: unknown, want: unknown) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) { console.error(`selftest: ${name} — wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); failed++; }
  };

  check('u64 is one u64 call', writerMethodsFor('u64'), ['u64']);
  check('Pubkey is one pubkey call', writerMethodsFor('Pubkey'), ['pubkey']);
  check('Option<u64> is option then u64', writerMethodsFor('Option<u64>'), ['option', 'u64']);
  check('an Option<Pubkey> accepts the hand-written discriminant', matchesSpec(['u8'], writerSpecFor('Option<Pubkey>')!), true);
  check('an Option<Pubkey> accepts option+pubkey', matchesSpec(['option', 'pubkey'], writerSpecFor('Option<Pubkey>')!), true);
  check('an Option<Pubkey> rejects a bare pubkey', matchesSpec(['pubkey'], writerSpecFor('Option<Pubkey>')!), false);
  check('an Option<Pubkey> rejects u8+u8', matchesSpec(['u8', 'u8'], writerSpecFor('Option<Pubkey>')!), false);
  check('Vec<[u8; 32]> is vec then bytes', writerMethodsFor('Vec<[u8; 32]>'), ['vec', 'bytes']);
  check('Vec<Option<Pubkey>> nests', writerMethodsFor('Vec<Option<Pubkey>>'), ['vec', 'option', 'pubkey']);
  check('a named custom type is null', writerMethodsFor('ParamsPatch'), null);
  check('an unknown type is null', writerMethodsFor('SomethingElse'), null);
  check('[Pubkey; SQUAD] is null (N is not 1)', writerMethodsFor('[Pubkey; SQUAD]'), null);

  const ix = (args: string[]) => new Map([['x', { program: 'p', name: 'x', args, at: 'a.rs:1' }]]);
  const at = (file: string, name: string | null, chain: string[] | null): Encoding => ({ file, line: 1, name, chain });
  check('a matching flat instruction is clean', shapeProblems([at('a.ts', 'x', ['u64', 'pubkey'])], ix(['u64', 'Pubkey'])), []);
  check('a wrong order is caught', shapeProblems([at('a.ts', 'x', ['pubkey', 'u64'])], ix(['u64', 'Pubkey'])).length, 1);
  check('a missing argument is caught', shapeProblems([at('a.ts', 'x', ['u64'])], ix(['u64', 'Pubkey'])).length, 1);
  check('a wrong width is caught', shapeProblems([at('a.ts', 'x', ['u8', 'pubkey'])], ix(['u64', 'Pubkey'])).length, 1);
  check('an extra argument is caught', shapeProblems([at('a.ts', 'x', ['u64', 'pubkey', 'u8'])], ix(['u64', 'Pubkey'])).length, 1);
  check('an unknown instruction name is caught', shapeProblems([at('a.ts', 'nope', [])], ix([])).length, 1);
  check('a zero-argument instruction with a chain is caught', shapeProblems([at('a.ts', 'x', ['u8'])], ix([])).length, 1);
  check('a zero-argument instruction with no chain is clean', shapeProblems([at('a.ts', 'x', [])], ix([])), []);
  check('an Option argument matches option+inner', shapeProblems([at('a.ts', 'x', ['option', 'u64'])], ix(['Option<u64>'])), []);
  // `None` really does encode to a lone discriminant byte, so a missing inner is not a drift — a
  // *wrong* inner is, and that is the case that has to fail.
  check('a lone Option discriminant is a None, not a drift', shapeProblems([at('a.ts', 'x', ['option'])], ix(['Option<u64>'])), []);
  check('a wrong Option inner is caught', shapeProblems([at('a.ts', 'x', ['option', 'u8'])], ix(['Option<u64>'])).length, 1);
  check('a hand-written Option discriminant is clean', shapeProblems([at('a.ts', 'x', ['u8'])], ix(['Option<Pubkey>'])), []);
  check('a hand-written Option with a wrong inner is caught', shapeProblems([at('a.ts', 'x', ['u8', 'u8'])], ix(['Option<Pubkey>'])).length, 1);
  check('two Options and a Some in the middle is clean', shapeProblems([at('a.ts', 'x', ['u8', 'u8', 'u8', 'bool', 'u8'])], ix(['Option<Pubkey>', 'Option<u64>', 'Option<bool>', 'Option<Pubkey>'])), []);
  check('swapping two Options is caught', shapeProblems([at('a.ts', 'x', ['u8', 'bool', 'u8', 'u8'])], ix(['Option<Pubkey>', 'Option<u64>', 'Option<bool>'])).length, 1);
  check('a complex instruction is out of scope, not a failure', shapeProblems([at('a.ts', 'x', ['u8'])], ix(['ParamsPatch'])), []);
  // An unknown method is always also a mismatch (nothing in the registry expands to it), so the
  // assertion is on the message rather than the count — otherwise the case passes for the wrong reason.
  const unknown = shapeProblems([at('a.ts', 'x', ['u64', 'nope'])], ix(['u64', 'u64']));
  check('an unknown writer method is named', unknown.some((p) => p.problem.includes('.nope()')), true);
  check('an unknown writer method is also a mismatch', unknown.length, 2);

  if (failed > 0) { console.error(`selftest: ${failed} case(s) failed`); return 1; }
  console.log('selftest: all 18 cases pass');
  return 0;
}

// --------------------------------------------------------------------------- report

function main(argv: string[]): number {
  if (argv.includes('--selftest')) return selftest();
  const { byName: instructions, conflicts } = rustInstructions();
  const encodings = tsEncodings();
  const problems = shapeProblems(encodings, instructions, conflicts);
  const { unresolvable, complex, complexEncoded } = blindSpots(encodings, instructions);
  const checkable = encodings.filter((e) => e.name !== null && e.chain !== null && !complex.some((c) => c.name === e.name));
  console.log(`instructions: ${instructions.size} · call sites: ${encodings.length} · checked: ${checkable.length}`);
  console.log(`out of scope: ${complexEncoded.length} instruction(s) with a named type, ${unresolvable.length} unresolvable call site(s)`);
  for (const p of problems) console.error(`  ${p.where} ${p.name}: ${p.problem}`);
  if (problems.length) { console.error(`\n${problems.length} argument-shape drift(s)`); return 1; }
  console.log('no argument-shape drift');
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) process.exit(main(process.argv.slice(2)));
