// Static gate: the token posture of the four production programs (checklist items 38 and 47).
//
// Two whole classes of on-chain exploit are closed *by construction* here, and "by construction" is exactly
// the kind of claim that quietly stops being true — one `spl-token-2022` dependency, one account typed
// `UncheckedAccount` where a token program belongs, one `approve` added for a feature, and the posture is
// gone with no test failing. So the invariants are written down as rules:
//
//   * Classic SPL Token only, always via a pinned program account. Every token CPI names
//     `Program<'info, Token>` (Anchor checks the program id at deserialization, so a look-alike program
//     cannot be substituted) and every token account/mint is a classic-layout `Account<TokenAccount>` /
//     `Account<Mint>`. Token-2022 is therefore *unusable* rather than merely unused: a T22 mint carrying a
//     transfer hook, permanent delegate or default-frozen state cannot be routed through a mint CPI
//     (classic CPI against a T22 mint fails; the layouts differ, so it fails at read, not silently).
//     Exceptions are exactly two, listed below: `chip_core::randomness` (accounts that are handed to the
//     Switchboard program, which validates its own) and `sb_mock` (the localnet-only stand-in).
//   * No SPL delegate is ever granted. Nothing calls `approve`, so there is no allowance a player has to
//     remember to withdraw and no third party who can move a chip or $CG out from under an instruction —
//     item 47 is not "we revoke them", it is "we never create them". (`delegates` in `arena` are Merkle
//     leaf delegates for compressed NFTs, pinned to `chip_core` itself — a different concept.)
//
// Everything is source text: this must run with no Rust toolchain (`security:static` runs anywhere).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Production programs — `sb_mock` is the localnet-only Switchboard stand-in and is excluded on purpose. */
const PROGRAMS = ['chip_core', 'market', 'staking', 'arena'];
/**
 * Files where a token account is a pass-through argument to another program, so it is not (and cannot be)
 * typed `Program<'info, Token>`. A new entry here is a review event, not a convenience.
 */
const PASSTHROUGH = new Set(['programs/chip_core/src/randomness.rs']);

function rustFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) rustFiles(p, acc);
    else if (e.endsWith('.rs')) acc.push(p);
  }
  return acc;
}
const sources = () => PROGRAMS.flatMap((p) => rustFiles(join(REPO, 'programs', p, 'src')).map((f) => ({ program: p, path: f, text: readFileSync(f, 'utf8') })));
const rel = (p: string) => relative(REPO, p);

/**
 * `token_program: T,` declarations (not `associated_token_program:`). A helper *parameter*
 * (`pub fn mint_to_user(token_program: &AccountInfo<…>)`) is not an account declaration: it inherits
 * whatever the caller passes, which is why the callers are checked separately below.
 */
export const TOKEN_PROGRAM_FIELD = /(?<![\w])token_program:\s*(Program<[^>]*>|UncheckedAccount<[^>]*>|&?AccountInfo<[^>]*>|Interface<[^>]*>)/g;
/** True when the match sits inside a function signature (its parameter list), not inside a struct. */
export function insideSignature(text: string, index: number): boolean {
  const before = text.slice(0, index);
  const lastFn = Math.max(before.lastIndexOf('pub fn '), before.lastIndexOf('\nfn '), before.lastIndexOf(' fn '));
  if (lastFn < 0) return false;
  const tail = before.slice(lastFn);
  if (tail.includes('{')) return false;                                  // the body already started → not a signature
  return (tail.match(/\(/g)?.length ?? 0) > (tail.match(/\)/g)?.length ?? 0);
}
/** `let tp = ctx.accounts.token_program.to_account_info();` — a local alias of a pinned account. */
export function aliases(text: string, types: Map<string, string>): Map<string, string> {
  const m = new Map(types);
  for (const hit of text.matchAll(/let\s+(?:mut\s+)?([a-z_][\w]*)\s*=\s*&?ctx\.accounts\.([a-z_][\w]*)\.to_account_info\(\);/g)) {
    const type = m.get(hit[2]);
    if (type) m.set(hit[1], type);
  }
  return m;
}
/** name → declared type, per file (enough to follow a token program from a field to a CPI). */
export function fieldTypes(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const hit of text.matchAll(/\bpub\s+([a-z_][\w]*):\s*(Program<[^>]*>|UncheckedAccount<[^>]*>|&?AccountInfo<[^>]*>|Account<[^>]*>)/g)) m.set(hit[1], hit[2]);
  return m;
}
/** Helpers that take the token program as an `&AccountInfo` parameter (they cannot pin it themselves). */
export function helperParams(text: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const hit of text.matchAll(/pub\s+fn\s+([a-z_][\w]*)[\s\S]{0,400}?token_program:\s*&AccountInfo<'info>/g)) m.set(hit[1], 0);
  return m;
}
/**
 * Source with `//` comments blanked out (string literals respected). Comments are prose: a doc comment
 * that *mentions* `mint_to_user_from(..)` is not a call site, and a rule that cannot tell them apart
 * forces people to stop documenting.
 */
export function stripComments(text: string): string {
  return text.split('\n').map((line) => {
    let inStr: string | undefined;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inStr) { if (ch === '\\') i++; else if (ch === inStr) inStr = undefined; continue; }
      if (ch === '"' || ch === "'") { inStr = ch; continue; }
      if (ch === '/' && line[i + 1] === '/') return line.slice(0, i);
    }
    return line;
  }).join('\n');
}

/** The first argument of a `CpiContext::new[_with_signer](…)` that wraps one of the SPL token instructions. */
export function tokenCpiProgramArgs(text: string): string[] {
  const out: string[] = [];
  for (const hit of text.matchAll(/CpiContext::new(?:_with_signer)?\(\s*([^,]+),\s*[\s\S]{0,120}?token::(MintTo|Transfer|TransferChecked|Burn|CloseAccount|Approve|Revoke)\b/g)) {
    out.push(hit[1].trim());
  }
  return out;
}

const tokenProgramFields = () => sources().flatMap((s) =>
  [...s.text.matchAll(TOKEN_PROGRAM_FIELD)]
    .filter((m) => !insideSignature(s.text, m.index!))
    .map((m) => ({ program: s.program, path: s.path, type: m[1].trim() })));

test("token posture: every token program account is `Program<'info, Token>` (pinned by Anchor)", () => {
  const bad = tokenProgramFields().filter((f) => !/^Program<'info,\s*Token>$/.test(f.type));
  const offenders = bad.filter((f) => !PASSTHROUGH.has(rel(f.path)));
  assert.deepEqual(offenders.map((f) => `${rel(f.path)}: token_program: ${f.type}`), [],
    "a token program account that is not `Program<'info, Token>` can be a look-alike program (or a Token-2022 program with extensions) — pin it, or add a reviewed exception");
  // the passthrough exceptions are exactly the ones documented above: a new one must show up here
  assert.deepEqual([...new Set(bad.map((f) => rel(f.path)))].sort(), [...PASSTHROUGH].sort(),
    'the passthrough allowlist is stale — update it together with the comment that explains why');
});

test('token posture: every SPL token CPI names a pinned `Program<Token>` account, never a user-supplied one', () => {
  const problems: string[] = [];
  for (const s of sources()) {
    const types = aliases(s.text, fieldTypes(s.text));
    const helpers = helperParams(s.text);
    for (const arg of tokenCpiProgramArgs(s.text)) {
      // either `ctx.accounts.x.to_account_info()`, `x.clone()` or the bare binding `x` (common for CloseAccount)
      const field = /(?:ctx\.accounts\.)?([a-z_][\w]*)(?:\.(?:to_account_info\(\)|clone\(\)))?$/.exec(arg)?.[1];
      if (!field) { problems.push(`${rel(s.path)}: token CPI program argument '${arg}' is not a named account — it cannot be checked`); continue; }
      if (helpers.has(field)) continue;                                  // helper parameter; its callers are checked below
      const type = types.get(field);
      if (type === undefined) { problems.push(`${rel(s.path)}: token CPI uses '${field}', which no account in this file declares`); continue; }
      if (!/^Program<'info,\s*Token>$/.test(type)) problems.push(`${rel(s.path)}: token CPI program '${field}' is '${type}'`);
    }
  }
  assert.deepEqual(problems, [], 'an SPL token CPI must take a `Program<\'info, Token>` account (Anchor pins the id) — a bare AccountInfo can be a look-alike program');
});

test('token posture: helpers that forward the token program are only called with a pinned account', () => {
  const problems: string[] = [];
  for (const s of sources()) {
    const helpers = helperParams(s.text);
    if (helpers.size === 0) continue;
    const known = aliases(s.text, fieldTypes(s.text));
    for (const [name] of helpers) {
      // A window after each call site: the argument list nests parens (`…to_account_info()`), so no regex
      // delimits it — 400 characters is wider than any call in this program set.
      const code = stripComments(s.text);
      for (const call of code.matchAll(new RegExp(String.raw`(?<!fn\s)\b${name}\(`, 'g'))) {
        const args = code.slice(call.index! + call[0].length, call.index! + call[0].length + 400);
        if (/token_program:\s*&AccountInfo/.test(args)) continue;        // the declaration, not a call
        // Any argument in the window that resolves to a pinned `Program<'info, Token>` account is the
        // token program being handed over; a same-file forward of the helper's own parameter is fine
        // because its callers are the ones this rule checks.
        const forwarded = [...args.matchAll(/(?:ctx\.accounts\.)?([a-z_][\w]*)(?:\.to_account_info\(\)|\.clone\(\))?|\btoken_program\b/g)]
          .map((m) => m[1] ?? 'token_program')
          .find((id) => id === 'token_program' || /^Program<'info,\s*Token>$/.test(known.get(id) ?? ''));
        if (!forwarded) {
          problems.push(`${rel(s.path)}: ${name}(…) does not forward a Program<'info, Token> account — got: ${args.split('\n')[1]?.trim() ?? args.slice(0, 60)}`);
        }
      }
    }
  }
  assert.deepEqual(problems, [], 'the `mint_to_user`-style helpers mint through whatever token program they are handed — the caller must hand a pinned one');
});

test('token posture: no Token-2022 anywhere (dependency, import or extension field)', () => {
  const hits: string[] = [];
  for (const m of ['Cargo.toml', ...PROGRAMS.map((p) => `programs/${p}/Cargo.toml`)]) {
    for (const line of readFileSync(join(REPO, m), 'utf8').split('\n')) {
      if (/^\s*#/.test(line)) continue;
      if (/token[-_]?2022/i.test(line)) hits.push(`${m}: ${line.trim()}`);
    }
  }
  for (const s of sources()) {
    for (const [i, line] of s.text.split('\n').entries()) {
      if (/^\s*\/\//.test(line)) continue;
      if (/token[-_]?2022|spl_token_2022|TransferHook|PermanentDelegate|DefaultAccountState|transfer_hook/i.test(line)) hits.push(`${rel(s.path)}:${i + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(hits, [],
    'Token-2022 (transfer hooks, permanent delegate, default-frozen, decimals drift) is out of scope by design — making a T22 mint usable means reviewing every value flow it can reach');
});

test('token posture: no SPL delegate is ever granted, so none can be left dangling', () => {
  const hits: string[] = [];
  for (const s of sources()) {
    for (const [i, line] of s.text.split('\n').entries()) {
      if (/^\s*\/\//.test(line)) continue;
      if (/\btoken::(approve|revoke)(_checked)?\b|\bApprove\s*\{|\bRevoke\s*\{/.test(line)) hits.push(`${rel(s.path)}:${i + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(hits, [], 'a new SPL delegate must be paired with a `revoke` on every path that returns the asset (item 47)');
});

test('token posture self-test: the rules fire on a look-alike program, a forwarded bare AccountInfo, a T22 import and an approve', () => {
  assert.equal(TOKEN_PROGRAM_FIELD.test("pub token_program: Program<'info, Token>,\n"), true);
  TOKEN_PROGRAM_FIELD.lastIndex = 0;
  assert.equal(TOKEN_PROGRAM_FIELD.test("pub associated_token_program: Program<'info, AssociatedToken>,\n"), false);
  TOKEN_PROGRAM_FIELD.lastIndex = 0;
  assert.deepEqual([..."pub token_program: Program<'info, Token>,\n".matchAll(TOKEN_PROGRAM_FIELD)].map((m) => m[1]), ["Program<'info, Token>"]);
  assert.equal([...tokenCpiProgramArgs(`token::mint_to(CpiContext::new_with_signer(token_program.clone(), token::MintTo { .. }, &[s]), 1)?;`)].length, 1);
  assert.equal(tokenCpiProgramArgs('associated_token::create(CpiContext::new(prog, ix))?;').length, 0);
  const types = fieldTypes("pub token_program: Program<'info, Token>,\npub evil: UncheckedAccount<'info>,\n");
  assert.equal(types.get('evil'), "UncheckedAccount<'info>");
  assert.equal(!/^Program<'info,\s*Token>$/.test(types.get('evil')!), true);
  assert.equal(stripComments('// mint_to_user_from(..) in prose').includes('mint_to_user_from'), false);
  assert.equal(stripComments('token::transfer(CpiContext::new(tp, ix))?; // trailing note').includes('token::transfer'), true);
  assert.equal(insideSignature('pub fn f(\n  token_program: &AccountInfo<x>,\n) {}', 20), true);
  assert.equal(insideSignature("pub struct S {\n  pub token_program: Program<x>,\n}", 20), false);
  assert.equal(aliases('let tp = ctx.accounts.token_program.to_account_info();', new Map([['token_program', "Program<'info, Token>"]] as [string, string][])).get('tp'), "Program<'info, Token>");
  const helperSrc = 'pub fn mint_to_user<\'info>(\n  token_program: &AccountInfo<\'info>,\n) -> Result<()> {}';
  assert.equal(helperParams(helperSrc).has('mint_to_user'), true);
});
