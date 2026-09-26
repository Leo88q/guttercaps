// Account-layout gate (checklist item: "account-layout breakage across a program upgrade").
//
// An Anchor account is raw bytes at a fixed address: `#[account] pub struct X { a: u64, b: u64 }` becomes
// 8 (discriminator) + 16 bytes on chain, and every instruction that reads it reinterprets those bytes. Adding,
// removing or reordering a field — or changing a field's type — silently changes what every existing account
// *means*: `set_params` would write a new layout into an old `GameConfig`, `open_pack` would read a `u8` where
// a `u64` used to be, and the failure mode is not a compile error, it is a misread at runtime (the class of bug
// that has bricked more Anchor programs than any missing `has_one`).
//
// Nothing in `cargo test` catches it: the tests build the *new* layout on both sides. So this gate freezes the
// layout of every persisted account in `reports/state-layout.json` and fails when it moves, which turns "we
// upgraded the program" into "we upgraded the program and re-checked the bytes it reads".
//
// It reads Rust source text only (no cargo, no toolchain) because it has to run everywhere the repo does —
// including a laptop with no Anchor and the `economy` CI job.
//
//   npm run state:layout            # --check: fail if any layout moved
//   npm run state:layout -- --write  # accept the new layout (prints exactly what changed)
//   npm run state:layout -- --selftest
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, relative } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const BASELINE = 'reports/state-layout.json';

export interface AccountLayout { program: string; name: string; fields: string[] }
export interface LayoutFile { version: number; fingerprint: string; accounts: AccountLayout[] }

/** Every `#[account(…)]` struct in one Rust source file, in source order. */
export function accountsInSource(source: string): { name: string; fields: string[] }[] {
  const lines = source.split('\n');
  const out: { name: string; fields: string[] }[] = [];
  let pending = false;              // the previous non-blank line was #[account…]
  let current: { name: string; fields: string[] } | undefined;
  let attr: string[] = [];          // attributes belonging to the *next field* (they change INIT_SPACE)
  let depth = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (current) {
      if (line.startsWith('}')) { out.push(current); current = undefined; attr = []; pending = false; continue; }
      if (line === '' || line.startsWith('//')) continue;
      if (line.startsWith('#')) { attr.push(line.replace(/\s+/g, ' ')); continue; }
      // a trailing `//` comment is not part of the layout: keeping it would make the gate fire on a typo fix
      const code = line.replace(/\s*\/\/.*$/, '');
      const m = /^pub\s+([A-Za-z_][\w]*)\s*:\s*(.+?),?$/.exec(code);
      if (m) current.fields.push(`${attr.length ? `${attr.join(' ')} ` : ''}${m[1]}: ${m[2].replace(/\s+/g, ' ')}`);
      attr = [];
      continue;
    }
    if (line.startsWith('//') || line === '') continue;
    if (/^#\[account(\(|\])/.test(line)) { pending = true; depth = 0; continue; }
    if (pending && /^pub\s+struct\s+([A-Za-z_][\w]*)\s*\{?\s*$/.test(line)) {
      const name = /^pub\s+struct\s+([A-Za-z_][\w]*)/.exec(line)![1];
      current = { name, fields: [] };
      depth = line.includes('{') ? 1 : 0;
      continue;
    }
    if (!line.startsWith('#')) pending = false;
    void depth;
  }
  return out;
}

/** Canonical text of one account: the exact thing a byte-level change moves. */
export const canonical = (a: AccountLayout) => `${a.program}/${a.name}${a.fields.length ? `(${a.fields.join('; ')})` : ''}`;
export const fingerprint = (accounts: AccountLayout[]) =>
  createHash('sha256').update([...accounts].sort((x, y) => canonical(x).localeCompare(canonical(y))).map(canonical).join('\n')).digest('hex');

function rustFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) rustFiles(p, acc);
    else if (e.endsWith('.rs')) acc.push(p);
  }
  return acc;
}

export function scan(root = ROOT): AccountLayout[] {
  const out: AccountLayout[] = [];
  const programsDir = join(root, 'programs');
  for (const program of readdirSync(programsDir)) {
    const src = join(programsDir, program, 'src');
    if (!existsSync(src)) continue;
    for (const file of rustFiles(src).sort()) {
      for (const a of accountsInSource(readFileSync(file, 'utf8'))) out.push({ program, name: a.name, fields: a.fields });
    }
  }
  return out;
}

/** Human-readable diff between the committed baseline and the current tree. */
export function diff(before: AccountLayout[], after: AccountLayout[]): string[] {
  const key = (a: AccountLayout) => `${a.program}/${a.name}`;
  const b = new Map(before.map((a) => [key(a), a]));
  const a = new Map(after.map((x) => [key(x), x]));
  const lines: string[] = [];
  for (const [k, cur] of a) {
    const old = b.get(k);
    if (!old) { lines.push(`+ ${k} — NEW account (nobody has bytes at this address yet; fine, but the deploy is the first one that can create it)`); continue; }
    const added = cur.fields.filter((f) => !old.fields.includes(f));
    const removed = old.fields.filter((f) => !cur.fields.includes(f));
    const reordered = added.length === 0 && removed.length === 0 && cur.fields.join(';') !== old.fields.join(';');
    if (added.length || removed.length || reordered) {
      lines.push(`~ ${k}`);
      for (const f of removed) lines.push(`    - ${f}   → every existing account still holds these bytes; reading them as something else is silent`);
      for (const f of added) lines.push(`    + ${f}   → existing accounts are SHORTER than the new layout: Anchor will fail to deserialize them`);
      if (reordered) lines.push(`    ! field order changed (${old.fields.length} fields) — same size, different meaning`);
    }
  }
  for (const k of b.keys()) if (!a.has(k)) lines.push(`- ${k} — REMOVED (an account of this type on chain can no longer be read by any instruction)`);
  return lines;
}

function selftest(): void {
  const base = `#[account]\npub struct Thing {\n    pub a: u64,\n    pub b: u8,\n}\n`;
  const same = accountsInSource(base);
  const added = accountsInSource(`#[account]\npub struct Thing {\n    pub a: u64,\n    pub b: u8,\n    pub c: u8,\n}\n`);
  const reordered = accountsInSource(`#[account]\npub struct Thing {\n    pub b: u8,\n    pub a: u64,\n}\n`);
  const maxLen = accountsInSource(`#[account]\npub struct V {\n    #[max_len(32)]\n    pub items: Vec<u64>,\n}\n`);
  const zeroCopy = accountsInSource(`#[account(zero_copy)]\n#[repr(C)]\npub struct Z {\n    pub x: u32,\n}\n`);
  const notAccount = accountsInSource(`pub struct NotAnAccount {\n    pub x: u64,\n}\n`);
  const asAccount = (al: { name: string; fields: string[] }[]) => al.map((x) => ({ program: 'p', name: x.name, fields: x.fields }));
  const checks: [string, boolean][] = [
    ['a plain struct is not an account', asAccount(notAccount).length === 0],
    ['one account parsed', same.length === 1],
    ['fields captured in order', asAccount(same)[0].fields.join('|') === 'a: u64|b: u8'],
    ['an added field changes the fingerprint', fingerprint(asAccount(same)) !== fingerprint(asAccount(added))],
    ['a reordered field changes the fingerprint', fingerprint(asAccount(same)) !== fingerprint(asAccount(reordered))],
    ['an identical layout keeps the fingerprint', fingerprint(asAccount(same)) === fingerprint(asAccount(accountsInSource(base)))],
    ['#[max_len] is part of the layout (it changes INIT_SPACE)', asAccount(maxLen)[0].fields.join('') === '#[max_len(32)] items: Vec<u64>'],
    ['zero_copy accounts are included', asAccount(zeroCopy).length === 1 && asAccount(zeroCopy)[0].name === 'Z'],
    ['the diff names an added field', diff(asAccount(same), asAccount(added)).some((l) => l.includes('+ c: u8'))],
    ['the diff names a removal', diff(asAccount(same), asAccount(added.filter(() => false))).some((l) => l.includes('REMOVED'))],
  ];
  const bad = checks.filter(([, ok]) => !ok);
  console.log(`state-layout selftest: ${checks.length - bad.length}/${checks.length} проверок`);
  for (const [name] of bad) console.error(`  ✗ ${name}`);
  process.exit(bad.length ? 1 : 0);
}

function main(argv: string[]): void {
  if (argv.includes('--selftest')) return selftest();
  const accounts = scan();
  if (accounts.length === 0) { console.error('state-layout: no #[account] structs found — wrong directory?'); process.exit(1); }
  const path = join(ROOT, BASELINE);
  const write = argv.includes('--write');
  const fp = fingerprint(accounts);
  if (write) {
    const previous = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as LayoutFile) : undefined;
    const lines = previous ? diff(previous.accounts, accounts) : [`+ ${accounts.length} account(s) recorded for the first time`];
    writeFileSync(path, `${JSON.stringify({ version: 1, fingerprint: fp, accounts }, null, 2)}\n`);
    console.log(`state-layout: ${accounts.length} account(s) written to ${BASELINE} (${fp.slice(0, 12)}…)`);
    for (const l of lines) console.log(`  ${l}`);
    if (lines.length) {
      console.log('\n  A layout change is a migration, not a commit: (1) existing accounts are shorter/longer than the new');
      console.log('  struct — Anchor will refuse to deserialize them; (2) if the layout must change, ship a new account');
      console.log('  version (extra PDA seed or a new struct) + a migration instruction, and say so in docs/06 §2.2 /');
      console.log('  SECURITY.md. The `programs` CI job fails on a changed layout unless this file is regenerated in the');
      console.log('  same PR — that is the review point.');
    }
    return;
  }
  if (!existsSync(path)) { console.error(`state-layout: ${BASELINE} is missing — run: npm run state:layout -- --write`); process.exit(1); }
  const saved = JSON.parse(readFileSync(path, 'utf8')) as LayoutFile;
  const cur = scan();
  const problems = diff(saved.accounts, cur);
  if (saved.fingerprint === fp) { console.log(`state-layout: ${cur.length} account layout(s) unchanged (${fp.slice(0, 12)}…)`); return; }
  console.error(`state-layout: the persisted account layout changed since ${BASELINE} (${relative(ROOT, path)}):`);
  for (const l of problems) console.error(`  ${l}`);
  console.error('\nIf (and only if) the new layout is intended: plan the migration for the accounts that already exist on');
  console.error('chain, record it in docs/06 §2.2 + SECURITY.md, then run `npm run state:layout -- --write`.');
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
