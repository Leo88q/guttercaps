// Minimal, dependency-free structural reader for the Anchor programs under programs/*/src.
//
// It is NOT a Rust parser: it understands exactly the shapes this repository uses — `#[derive(Accounts)]`
// structs with `#[account(...)]` field attributes, `#[program]` modules, `#[event]` / `#[account]` /
// `#[error_code]` items and top-level `fn` bodies — which is enough to turn the Solana/Anchor audit
// checklist (docs: audit 2026-09-25) into gates that run in a second, without a toolchain.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface Field {
  name: string;
  type: string;
  /** top-level comma-separated tokens of every `#[account(...)]` on the field */
  constraints: string[];
  line: number;
}
export interface AccountsStruct {
  name: string;
  file: string;
  line: number;
  fields: Field[];
  program: string;
}
export interface FnItem {
  name: string;
  file: string;
  line: number;
  params: string;
  body: string;
  program: string;
}
export interface SourceFile {
  path: string;
  rel: string;
  program: string;
  /** comments removed, string literals kept, line structure preserved */
  code: string;
}

/** Strip `//` and `/* *\/` comments while preserving string literals and newlines (so offsets → lines). */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (src[i] === '/' && src[i + 1] === '*') { depth++; i += 2; continue; }
        if (src[i] === '*' && src[i + 1] === '/') { depth--; i += 2; continue; }
        if (src[i] === '\n') out += '\n';
        i++;
      }
      continue;
    }
    if (c === '"') {
      // string literal (also covers b"..."; the `b` was already copied)
      let j = i + 1;
      while (j < n && src[j] !== '"') { if (src[j] === '\\') j++; j++; }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '\'' ) {
      // char literal vs lifetime: 'x' or '\n' are literals, 'info is a lifetime
      const m = /^'(\\.|[^'\\])'/.exec(src.slice(i, i + 4));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    out += c;
    i++;
  }
  return out;
}

const lineAt = (code: string, idx: number) => code.slice(0, idx).split('\n').length;

/** index of the bracket closing the one opened at `open` (supports () [] {} and <> when asked) */
export function matchClose(code: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const want = pairs[code[open]];
  if (!want) throw new Error(`no bracket at ${open}: ${code.slice(open, open + 20)}`);
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"') { i++; while (i < code.length && code[i] !== '"') { if (code[i] === '\\') i++; i++; } continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') { depth--; if (depth === 0) return i; }
  }
  throw new Error('unbalanced');
}

/** split on commas that are not nested in () [] {} <> */
export function splitTopLevel(s: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let angle = 0;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') { let j = i + 1; while (j < s.length && s[j] !== '"') { if (s[j] === '\\') j++; j++; } cur += s.slice(i, j + 1); i = j; continue; }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === '<' && /[A-Za-z_>:]/.test(s[i - 1] ?? '') ) angle++;
    else if (ch === '>' && angle > 0 && s[i - 1] !== '-' && s[i - 1] !== '=') angle--;
    if (ch === sep && depth === 0 && angle === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function listRustFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) { if (e !== 'target') walk(p); } else if (e.endsWith('.rs')) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

export function loadSources(repo: string, programs: string[]): SourceFile[] {
  const files: SourceFile[] = [];
  for (const program of programs) {
    for (const path of listRustFiles(join(repo, 'programs', program, 'src'))) {
      files.push({ path, rel: relative(repo, path), program, code: stripComments(readFileSync(path, 'utf8')) });
    }
  }
  return files;
}

/** Parse every `#[derive(Accounts)]` struct of one (comment-stripped) source. */
export function parseAccountsStructs(file: SourceFile): AccountsStruct[] {
  const out: AccountsStruct[] = [];
  const code = file.code;
  const re = /#\[derive\(([^)]*)\)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (!m[1].split(',').map((s) => s.trim()).includes('Accounts')) continue;
    const sm = /\bpub\s+struct\s+(\w+)\s*(<[^{]*>)?\s*\{/.exec(code.slice(m.index));
    if (!sm) continue;
    const bodyOpen = m.index + sm.index + sm[0].length - 1;
    const bodyClose = matchClose(code, bodyOpen);
    out.push({ name: sm[1], file: file.rel, line: lineAt(code, m.index), program: file.program, fields: parseFields(code, bodyOpen + 1, bodyClose) });
    re.lastIndex = bodyClose;
  }
  return out;
}

function parseFields(code: string, from: number, to: number): Field[] {
  const fields: Field[] = [];
  let i = from;
  let pending: string[] = [];
  while (i < to) {
    while (i < to && /\s/.test(code[i])) i++;
    if (i >= to) break;
    if (code[i] === '#' && code[i + 1] === '[') {
      const close = matchClose(code, i + 1);
      const attr = code.slice(i + 2, close).trim();
      const am = /^account\s*\(/.exec(attr);
      if (am) pending.push(...splitTopLevel(attr.slice(am[0].length, attr.lastIndexOf(')'))));
      i = close + 1;
      continue;
    }
    const fm = /^pub\s+(\w+)\s*:/.exec(code.slice(i, to));
    if (!fm) { i++; continue; }
    const typeStart = i + fm[0].length;
    // type ends at the first ',' outside <> / () or at the struct end
    let depth = 0;
    let j = typeStart;
    for (; j < to; j++) {
      const ch = code[j];
      if (ch === '<' || ch === '(' || ch === '[') depth++;
      else if (ch === '>' || ch === ')' || ch === ']') depth--;
      else if (ch === ',' && depth === 0) break;
    }
    fields.push({ name: fm[1], type: code.slice(typeStart, j).replace(/\s+/g, ' ').trim(), constraints: pending.map((c) => c.replace(/\s+/g, ' ')), line: lineAt(code, i) });
    pending = [];
    i = j + 1;
  }
  return fields;
}

/** every `fn name(...) ... { body }` (top-level or nested in impl / mod) */
export function parseFns(file: SourceFile): FnItem[] {
  const out: FnItem[] = [];
  const code = file.code;
  const re = /\bfn\s+(\w+)\s*(<[^(]*>)?\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const pOpen = m.index + m[0].length - 1;
    const pClose = matchClose(code, pOpen);
    // find the body `{` (skip return type / where clause); a `;` first means a declaration
    let k = pClose + 1;
    while (k < code.length && code[k] !== '{' && code[k] !== ';') k++;
    if (code[k] !== '{') continue;
    const bClose = matchClose(code, k);
    out.push({ name: m[1], file: file.rel, line: lineAt(code, m.index), params: code.slice(pOpen + 1, pClose), body: code.slice(k, bClose + 1), program: file.program });
  }
  return out;
}

/** names of the instruction handlers declared inside `#[program] pub mod x { ... }` */
export function programInstructionNames(file: SourceFile): string[] {
  const code = file.code;
  const pm = /#\[program\]\s*pub\s+mod\s+\w+\s*\{/.exec(code);
  if (!pm) return [];
  const open = pm.index + pm[0].length - 1;
  const body = code.slice(open, matchClose(code, open));
  return Array.from(body.matchAll(/\bpub\s+fn\s+(\w+)/g)).map((x) => x[1]);
}

/** `#[attr] pub struct Name { fields }` items carrying the given attribute (e.g. `event`, `account`) */
export function parseAttributedStructs(file: SourceFile, attr: string): { name: string; fields: string[]; line: number }[] {
  const out: { name: string; fields: string[]; line: number }[] = [];
  const code = file.code;
  const re = new RegExp(`#\\[${attr}(\\([^)]*\\))?\\]\\s*(#\\[[^\\]]*\\]\\s*)*pub\\s+struct\\s+(\\w+)\\s*\\{`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const open = m.index + m[0].length - 1;
    const body = code.slice(open + 1, matchClose(code, open));
    const fields = splitTopLevel(body).map((f) => f.replace(/#\[[^\]]*\]/g, '').replace(/\s+/g, ' ').replace(/^pub /, '').trim()).filter(Boolean);
    out.push({ name: m[3], fields, line: lineAt(code, m.index) });
  }
  return out;
}

/** variant names of a `#[error_code] pub enum X { ... }` in declaration order */
export function errorVariants(code: string): string[] {
  const m = /#\[error_code\]\s*pub\s+enum\s+\w+\s*\{/.exec(code);
  if (!m) return [];
  const open = m.index + m[0].length - 1;
  const body = code.slice(open + 1, matchClose(code, open));
  return splitTopLevel(body).map((v) => v.replace(/#\[[^\]]*\]/g, '').trim()).filter(Boolean).map((v) => v.split(/[\s=({]/)[0]);
}

/** innermost account type: `Box<Account<'info, T>>` → `Account<T>`; `Option<Signer<'info>>` → `Signer` */
export function coreType(t: string): { kind: string; inner?: string; optional: boolean } {
  let s = t.replace(/\s+/g, '');
  let optional = false;
  for (;;) {
    const w = /^(Box|Option)<(.*)>$/.exec(s);
    if (!w) break;
    if (w[1] === 'Option') optional = true;
    s = w[2];
  }
  const g = /^(\w+)<(.*)>$/.exec(s);
  if (!g) return { kind: s, optional };
  const args = splitTopLevel(g[2]).filter((a) => !a.startsWith('\''));
  return { kind: g[1], inner: args[0], optional };
}

export const has = (f: Field, re: RegExp) => f.constraints.some((c) => re.test(c));
export const constraintValue = (f: Field, key: string) => {
  const c = f.constraints.find((x) => new RegExp(`^${key.replace(/[:]/g, '\\:')}\\s*=`).test(x));
  return c ? c.slice(c.indexOf('=') + 1).trim() : undefined;
};

/** handlers taking `Context<Struct>` / `Context<'_, '_, 'info, 'info, Struct<'info>>` */
export function handlersFor(fns: FnItem[], structName: string): FnItem[] {
  const re = new RegExp(`Context<[^>]*?\\b${structName}\\b`);
  return fns.filter((f) => re.test(f.params));
}
