// Static security gates for the four Anchor programs — the Solana/Anchor audit checklist
// (SECURITY-AUDIT-2026-09-25.md, items A1–E30) turned into assertions over the source tree.
//
//   node --experimental-strip-types --test tests/security/*.test.ts      (npm run security:static)
//
// Unlike scripts/sec-scan.py (raw hits for human triage, never a gate) every rule here has zero
// hits at HEAD: each exception is listed next to the rule WITH the reason it is safe, so a new
// hit is either a bug or a conscious, reviewed allowlist entry. The last block self-tests the
// rules against synthetic vulnerable snippets (including the pre-fix SEC-F2 fusion loop) so a
// rule that silently stops matching fails loudly instead of passing vacuously.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AccountsStruct, type Field, type FnItem, type SourceFile,
  constraintValue, coreType, errorVariants, handlersFor, has, loadSources, parseAccountsStructs,
  parseAttributedStructs, parseFns, programInstructionNames, stripComments,
} from './lib/rust-scan.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROGRAMS = ['chip_core', 'market', 'staking', 'arena'] as const;
const files: SourceFile[] = loadSources(REPO, [...PROGRAMS]);
const structs: AccountsStruct[] = files.flatMap(parseAccountsStructs);
const fns: FnItem[] = files.flatMap(parseFns);
const src = (rel: string) => readFileSync(join(REPO, rel), 'utf8');
const where = (s: AccountsStruct, f?: Field) => `${s.file}:${f ? f.line : s.line} ${s.name}${f ? '.' + f.name : ''}`;
const isInit = (f: Field) => f.constraints.includes('init') || f.constraints.includes('init_if_needed');
const handlerBody = (s: AccountsStruct) => handlersFor(fns, s.name).map((h) => h.body).join('\n');
/** Body of a `fn` / `struct` / `event` item: from its name to the first top-level `}` after it, with
 *  comments stripped — a commented-out guard must not be able to satisfy a rule. */
const bodyOf = (ts: string, name: string): string => {
  const start = ts.indexOf(name);
  if (start < 0) return '';
  const end = ts.indexOf('\n}\n', start);
  return stripComments(ts.slice(start, end < 0 ? start + 2400 : end));
};

test('sanity: the reader sees the whole program surface', () => {
  assert.ok(files.length >= 20, `rust files: ${files.length}`);
  assert.ok(structs.length >= 90, `#[derive(Accounts)] structs: ${structs.length}`);
  assert.ok(structs.reduce((a, s) => a + s.fields.length, 0) >= 800, 'account fields');
  for (const p of PROGRAMS) {
    const ixs = files.filter((f) => f.program === p).flatMap(programInstructionNames);
    assert.ok(ixs.length >= 5, `${p}: #[program] instructions ${ixs.length}`);
  }
});

// ---------------------------------------------------------------- A. identity & accounts

test('A1/A3/D21/D22 every init / init_if_needed: Signer payer, PDA seeds + bump (or ATA), exact INIT_SPACE', () => {
  const bad: string[] = [];
  let n = 0;
  for (const s of structs) for (const f of s.fields) {
    if (!isInit(f)) continue;
    n++;
    const payer = constraintValue(f, 'payer');
    const pf = s.fields.find((x) => x.name === payer);
    if (!payer || !pf) bad.push(`${where(s, f)}: init without a payer field`);
    else if (coreType(pf.type).kind !== 'Signer' || !has(pf, /^mut$/)) bad.push(`${where(s, f)}: payer '${payer}' is not a mut Signer`);
    const t = coreType(f.type);
    const ata = has(f, /^associated_token::mint\s*=/) && has(f, /^associated_token::authority\s*=/);
    const pda = has(f, /^seeds\s*=/) && has(f, /^bump$/);
    if (!ata && !pda) bad.push(`${where(s, f)}: neither canonical PDA (seeds + bump) nor ATA — keypair accounts can be front-run / squatted`);
    if (t.kind === 'Account' && t.inner !== 'TokenAccount' && t.inner !== 'Mint') {
      const space = constraintValue(f, 'space')?.replace(/\s+/g, ' ');
      if (space !== `8 + ${t.inner}::INIT_SPACE`) bad.push(`${where(s, f)}: space '${space}' ≠ '8 + ${t.inner}::INIT_SPACE'`);
    }
  }
  assert.ok(n >= 45, `init sites seen: ${n}`);
  assert.deepEqual(bad, []);
});

// init_if_needed re-initialisation: the handler must adopt a zeroed account (owner/buyer == default)
// and afterwards pin it to the signer; a bare init_if_needed lets a second caller overwrite state.
test('A6 every init_if_needed handler guards re-initialisation (adopt-if-default, then require owner)', () => {
  const bad: string[] = [];
  for (const s of structs) for (const f of s.fields) {
    if (!f.constraints.includes('init_if_needed')) continue;
    const body = handlerBody(s);
    if (!body) { bad.push(`${where(s, f)}: no handler found`); continue; }
    const payer = constraintValue(f, 'payer') ?? '?';
    const adopt = /==\s*Pubkey::default\(\)/.test(body) && /require_keys_eq!|require!\(/.test(body);
    // or: the PDA itself is keyed by the payer (nobody else can reach it) and ownership is re-asserted
    const seededByPayer = (constraintValue(f, 'seeds') ?? '').includes(`${payer}.key()`) && /require_keys_eq!\(\s*\w+\.owner/.test(body);
    const guard = adopt || seededByPayer;
    if (!guard) bad.push(`${where(s, f)}: no default-then-pin guard in ${handlersFor(fns, s.name).map((h) => h.name)}`);
  }
  assert.deepEqual(bad, []);
});

// Passthrough accounts that are validated by the program they are forwarded to.
const PROGRAM_ACCOUNT_ALLOW: Record<string, string> = {
  'ClaimChipRoot.switchboard_program': 'forwarded to chip_core::open_voucher, which pins `address = randomness::SB_PROGRAM_ID`',
  'ClaimChipRoot.recent_slothashes': 'forwarded to chip_core::open_voucher, which pins `address = randomness::SLOT_HASHES_ID`',
};
test('A4 program accounts are typed Program<> or address-pinned (no fake System/Token/Core/Bubblegum/Switchboard)', () => {
  const bad: string[] = [];
  const typed: Record<string, string> = { system_program: 'System', token_program: 'Token', associated_token_program: 'AssociatedToken' };
  for (const s of structs) for (const f of s.fields) {
    const t = coreType(f.type);
    if (typed[f.name]) {
      if (t.kind !== 'Program' || t.inner !== typed[f.name]) bad.push(`${where(s, f)}: ${f.type} (expected Program<'info, ${typed[f.name]}>)`);
      continue;
    }
    const programLike = /_program$/.test(f.name) || ['mpl_core', 'log_wrapper', 'chip_core', 'noop'].includes(f.name);
    if (!programLike || t.kind === 'Program') continue;
    if ((t.kind === 'UncheckedAccount' || t.kind === 'AccountInfo') && !has(f, /^address\s*=/) && !PROGRAM_ACCOUNT_ALLOW[`${s.name}.${f.name}`]) {
      bad.push(`${where(s, f)}: unchecked program account without \`address =\``);
    }
  }
  assert.deepEqual(bad, []);
});

// ---------------------------------------------------------------- C. tokens & economics

test('C12 legacy SPL Token only: no Token-2022 / token_interface anywhere in the programs', () => {
  const bad = files.filter((f) => /token_2022|Token2022|token_interface|InterfaceAccount\s*<|Interface\s*<\s*'info/.test(f.code)).map((f) => f.rel);
  assert.deepEqual(bad, []);
});

test('C2/C16 every TokenAccount is bound to its mint (constraint, or a require_keys_eq on `.mint` in the handler)', () => {
  const bad: string[] = [];
  for (const s of structs) for (const f of s.fields) {
    const t = coreType(f.type);
    if (t.kind !== 'Account' || t.inner !== 'TokenAccount') continue;
    if (has(f, /^(token::mint|associated_token::mint|address)\s*=/) || has(f, new RegExp(`\\b${f.name}\\.mint\\b`))) continue;
    const body = handlerBody(s);
    const mentioned = new RegExp(`\\.${f.name}\\b`).test(body);
    const checked = /require_keys_eq!\(\s*\w+\.mint\b/.test(body);
    if (!(mentioned && checked)) bad.push(`${where(s, f)}: token account with no mint binding`);
  }
  assert.deepEqual(bad, []);
});

test('C13/C14 release profile keeps overflow-checks = true (unchecked `+`/`-` panic instead of wrapping)', () => {
  const toml = src('Cargo.toml');
  const m = /\[profile\.release\]([\s\S]*?)(\n\[|$)/.exec(toml);
  assert.ok(m, '[profile.release] missing');
  assert.match(m[1], /overflow-checks\s*=\s*true/);
});

// admin-gated mutators leave an audit trail; one-time bootstrap / pinned-destination paths are listed.
const ADMIN_NO_EVENT_ALLOW: Record<string, string> = {
  CreateBubblegumTree: 'one-time deploy bootstrap of a tree per collection (init; cannot be replayed)',
  ConfigureBubblegumTree: 'one-time deploy bootstrap (init of the tree meta PDA)',
  SweepVault: 'moves only the surplus above liabilities + rent, and only to the pinned config.treasury (has_one)',
};
test('C20 every admin-gated instruction emits an event (governance audit trail)', () => {
  const bad: string[] = [];
  let n = 0;
  for (const s of structs) {
    const gated = s.fields.some((f) => f.constraints.some((c) => /^has_one\s*=\s*admin\b/.test(c) || /^address\s*=\s*[\w.]+\.admin\b/.test(c)));
    if (!gated) continue;
    n++;
    const hs = handlersFor(fns, s.name);
    if (!hs.length) { bad.push(`${where(s)}: no handler`); continue; }
    if (!hs.some((h) => /\bemit!\s*\(/.test(h.body)) && !ADMIN_NO_EVENT_ALLOW[s.name]) bad.push(`${where(s)}: admin mutation without emit! (${hs.map((h) => h.name)})`);
  }
  assert.ok(n >= 15, `admin-gated structs seen: ${n}`);
  assert.deepEqual(bad, []);
});

test('C18 unbounded inputs: every Vec<> instruction argument is length-capped in its handler', () => {
  const ixNames = new Set(files.flatMap((f) => programInstructionNames(f).map((n) => `${f.program}:${n}`)));
  const bad: string[] = [];
  for (const f of fns) {
    if (!ixNames.has(`${f.program}:${f.name}`) || f.file.endsWith('lib.rs')) continue;
    for (const m of f.params.matchAll(/(\w+)\s*:\s*Vec</g)) {
      if (!new RegExp(`${m[1]}\\.len\\(\\)\\s*<=?`).test(f.body)) bad.push(`${f.file}:${f.line} ${f.name}(${m[1]}: Vec<..>) has no length cap`);
    }
  }
  assert.deepEqual(bad, []);
});

// ---------------------------------------------------------------- B. state / CPI

test('B8 no self-CPI (a program never invokes its own cpi module)', () => {
  const bad = files.filter((f) => new RegExp(`\\b(${f.program}|crate)::cpi::`).test(f.code)).map((f) => f.rel);
  assert.deepEqual(bad, []);
});

// ---------------------------------------------------------------- D. Anchor specifics

test('D25 same-named #[event] / #[account] types across programs have identical layouts (discriminator = name hash)', () => {
  for (const attr of ['event', 'account']) {
    const byName = new Map<string, { program: string; fields: string }[]>();
    for (const f of files) for (const it of parseAttributedStructs(f, attr)) {
      const list = byName.get(it.name) ?? [];
      list.push({ program: f.program, fields: it.fields.join('; ') });
      byName.set(it.name, list);
    }
    const bad: string[] = [];
    for (const [name, list] of byName) {
      const programs = new Set(list.map((x) => x.program));
      if (list.length > programs.size) bad.push(`${attr} ${name} declared twice in one program`);
      if (new Set(list.map((x) => x.fields)).size > 1) bad.push(`${attr} ${name}: ${list.map((x) => `${x.program}{${x.fields}}`).join(' vs ')}`);
    }
    assert.ok(byName.size >= (attr === 'event' ? 40 : 15), `${attr} types seen: ${byName.size}`);
    assert.deepEqual(bad, [], attr);
  }
});

const listIn = (ts: string, name: string) => {
  const m = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\]`).exec(ts);
  assert.ok(m, `${name} table missing`);
  return m[1];
};
test('D26 client + test error tables match every #[error_code] enum (names and order ⇒ 6000+i codes)', () => {
  const rust: Record<string, string[]> = {
    CHIP_CORE: errorVariants(stripComments(src('programs/chip_core/src/errors.rs'))),
    MARKET: errorVariants(stripComments(src('programs/market/src/lib.rs'))),
    STAKING: errorVariants(stripComments(src('programs/staking/src/errors.rs'))),
    ARENA: errorVariants(stripComments(src('programs/arena/src/lib.rs'))),
  };
  const expectTs = src('tests/localnet/helpers/expect.ts');
  const clientTs = src('client/src/chain/errors.ts');
  for (const [name, variants] of Object.entries(rust)) {
    assert.ok(variants.length >= 10, `${name}: ${variants.length} variants`);
    const names = Array.from(listIn(expectTs, name).matchAll(/'(\w+)'/g)).map((m) => m[1]);
    assert.deepEqual(names, variants, `tests/localnet/helpers/expect.ts ${name}`);
    const msgs = Array.from(listIn(clientTs, name).matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g));
    assert.equal(msgs.length, variants.length, `client/src/chain/errors.ts ${name}: one message per variant`);
  }
});

const tsFiles = (dir: string): string[] => readdirSync(join(REPO, dir)).flatMap((e) => {
  const rel = join(dir, e);
  if (e === 'node_modules' || e.startsWith('.')) return [];
  return statSync(join(REPO, rel)).isDirectory() ? tsFiles(rel) : /\.tsx?$/.test(e) ? [rel] : [];
});
test('D26 every instruction the client / harness / backend encodes exists in a #[program] module', () => {
  const known = new Set(loadSources(REPO, [...PROGRAMS, 'sb_mock']).flatMap(programInstructionNames));
  const bad: string[] = [];
  let n = 0;
  for (const dir of ['client/src', 'tests/localnet', 'backend/src', 'scripts']) {
    for (const rel of tsFiles(dir)) {
      for (const m of src(rel).matchAll(/\bixData\(\s*'(\w+)'/g)) {
        n++;
        if (!known.has(m[1])) bad.push(`${rel}: ixData('${m[1]}')`);
      }
    }
  }
  assert.ok(n >= 40, `ixData call sites seen: ${n}`);
  assert.deepEqual(bad, []);
});

// ---------------------------------------------------------------- E. runtime

test('E28 every `close = X` pays the rent to a bound party (has_one / address / require_keys_eq in the handler)', () => {
  const bad: string[] = [];
  let n = 0;
  for (const s of structs) for (const f of s.fields) {
    const target = constraintValue(f, 'close');
    if (!target) continue;
    n++;
    const tf = s.fields.find((x) => x.name === target);
    if (!tf) { bad.push(`${where(s, f)}: close target '${target}' is not an account of the struct`); continue; }
    const bound = has(f, new RegExp(`^has_one\\s*=\\s*${target}\\b`)) || has(tf, /^address\s*=/)
      || new RegExp(`require_keys_eq!\\([^;]*\\b${f.name}\\b[^;]*\\b${target}\\b|require_keys_eq!\\([^;]*\\b${target}\\b[^;]*\\b${f.name}\\b`).test(handlerBody(s));
    if (!bound) bad.push(`${where(s, f)}: rent goes to '${target}' which is not bound to the closed account`);
    if (coreType(tf.type).kind !== 'Signer' && !has(tf, /^address\s*=/)) bad.push(`${where(s, f)}: close target neither signer nor address-pinned`);
  }
  assert.ok(n >= 14, `close sites seen: ${n}`);
  assert.deepEqual(bad, []);
});

// E29: Anchor 0.31 has no `dup` constraint; remaining_accounts are never deduplicated. Every handler
// that deserialises + writes accounts out of remaining_accounts must reject repeats or bind each key.
const REMAINING_ALLOW: Record<string, string> = {
  open_compressed_pack: 'claim PDAs derived per (nonce, pack_no, slot) ⇒ distinct; collection metas re-read and exit() per slot',
  fuse_claims_reveal: 'key == pending.materials[m] (distinct at commit via ensure_distinct_material)',
  cancel_stale_claim_fusion: 'key == pending.materials[m] (distinct at commit)',
  register_compressed_chip: 'remaining_accounts are read-only Merkle proof nodes (≤ tree max_depth)',
  fuse: 'load_materials() rejects repeats (fusion.rs DuplicateMaterial) before any write',
  fuse_reveal: 'key == pending.materials[m] (distinct at commit)',
  cancel_stale_fusion: 'key == pending.materials[m] (distinct at commit)',
  open_pack: 'legacy Core path, fail-closed (CompressedMigrationRequired); asset/state PDAs derived per slot',
};
export function remainingAccountsViolations(list: FnItem[]): string[] {
  return list
    .filter((f) => /remaining_accounts/.test(f.body) && /try_borrow_mut_data|\.exit\(|\.serialize\(/.test(f.body))
    .filter((f) => !/ensure_distinct_material|Duplicate\w*/.test(f.body) && !REMAINING_ALLOW[f.name])
    .map((f) => `${f.file}:${f.line} ${f.name}`);
}
test('E29 duplicate accounts: every remaining_accounts write loop rejects repeated keys (or binds each key)', () => {
  assert.deepEqual(remainingAccountsViolations(fns), []);
  // allowlist entries must still exist (a renamed fn must not keep a stale exemption alive)
  for (const name of Object.keys(REMAINING_ALLOW)) assert.ok(fns.some((f) => f.name === name), `stale allowlist entry ${name}`);
  // the SEC-F2 fix: both compressed-claim fusion entry points call the shared guard
  for (const name of ['fuse_compressed_claims', 'fuse_claims_commit']) {
    const f = fns.find((x) => x.name === name && x.program === 'chip_core' && /remaining_accounts/.test(x.body));
    assert.ok(f && /ensure_distinct_material\(&material_keys\[\.\.i\]/.test(f.body), `${name} must dedupe materials`);
  }
});

test('E29 fixed-account duplicates: arena squads / sweep shards / market self-trade keep their explicit guards', () => {
  const all = files.map((f) => f.code).join('\n');
  for (const guard of ['ArenaError::DuplicateChip', 'ArenaError::SelfBattle', 'MarketError::SelfTrade', 'ChipError::InvalidShard', 'ChipError::DuplicateMaterial']) {
    assert.ok(all.includes(guard), guard);
  }
});

test('E30 no deprecated sysvars; SlotHashes is address-pinned wherever it is taken', () => {
  const bad = files.filter((f) => /RecentBlockhashes|recent_blockhashes|sysvar::fees|Sysvar<'info,\s*Fees>|sysvar::rewards/.test(f.code)).map((f) => f.rel);
  assert.deepEqual(bad, []);
  for (const s of structs) for (const f of s.fields) {
    if (!/slot_?hashes/.test(f.name) || PROGRAM_ACCOUNT_ALLOW[`${s.name}.${f.name}`]) continue;
    assert.ok(has(f, /^address\s*=\s*[\w:]*SLOT_HASHES_ID\b/) || coreType(f.type).kind === 'Sysvar', `${where(s, f)} not pinned`);
  }
});

test('A5/E27 manual create_account always funds the rent-exempt minimum', () => {
  const bad = fns.filter((f) => /create_account\s*\(/.test(f.body) && !/minimum_balance\s*\(/.test(f.body)).map((f) => `${f.file}:${f.line} ${f.name}`);
  assert.deepEqual(bad, []);
});

test('B10 randomness never derives from the clock (commit-reveal via Switchboard only)', () => {
  for (const rel of ['programs/chip_core/src/randomness.rs', 'programs/chip_core/src/economy.rs']) {
    const code = stripComments(src(rel)).replace(/#\[cfg\(test\)\][\s\S]*$/, '');
    assert.doesNotMatch(code, /unix_timestamp|Clock::get|\.slot\b(?!_)/, rel);
  }
});

// Report A2/A8 ("`slot % N` rarity is biased and predictable"): a bare modulo over a random byte or
// a slot is where both bugs live, so `%` in program code is allowlisted per function. The two draw
// helpers must keep their rejection bound (every residue gets the same number of pre-images).
const MODULO_ALLOW: Record<string, string> = {
  uniform_bps: 'rarity roll: u32 window, values ≥ LIMIT rejected before `% RANGE` (no bias)',
  uniform_pool: 'collection pick: same rejection sampling, `limit` = largest multiple of `pool`',
  shard_of: 'ledger shard = first pubkey byte % 4 — load balancing only, 256 % 4 = 0, no value attached',
  tick_day: '`day_index % 7` indexes the 7-day burn ring buffer — bookkeeping, not randomness',
};
function moduloViolations(sources: SourceFile[]): string[] {
  const bad: string[] = [];
  for (const f of sources) {
    const code = f.code.replace(/#\[cfg\(test\)\][\s\S]*$/, '').replace(/"(?:\\.|[^"\\])*"/g, '""');
    for (const fn of parseFns({ ...f, code })) {
      if (!/%/.test(fn.body)) continue;
      if (!MODULO_ALLOW[fn.name]) bad.push(`${f.rel}:${fn.line} ${fn.name}: bare \`%\` — biased if the operand is random, predictable if it is a slot`);
      else if (/^uniform_/.test(fn.name) && !/\bv\s*<\s*(LIMIT|limit)\b/.test(fn.body)) bad.push(`${f.rel}:${fn.line} ${fn.name}: rejection bound removed`);
    }
  }
  return bad;
}

test('A2/A8 `%` only in reviewed functions; random draws keep rejection sampling', () => {
  assert.deepEqual(moduloViolations(files), []);
  for (const name of Object.keys(MODULO_ALLOW)) assert.ok(fns.some((f) => f.name === name), `stale allowlist entry ${name}`);
});

// SEC-B19: the compressed claim nonce is `nonce * STRIDE + pack_no * MAX_CHIPS_PER_PACK + chip_index`
// (chip_core `open_compressed_pack`), so the stride has to cover the largest bundle a purchase may open.
// Otherwise two different (nonce, pack_no, chip) triples derive the same claim PDA — the second pack
// cannot be opened at all, its settlement never reaches `total_claims`, and the buyer's money stays in
// the vault. The Rust side asserts this at compile time; this rule reads the three constants out of the
// source so the *relation* is pinned too (a compile-time assert nobody can see is easy to delete).
function claimNonceStrideViolations(srcOf: (rel: string) => string): string[] {
  const num = (rel: string, re: RegExp): number | undefined => {
    const m = re.exec(stripComments(srcOf(rel)));
    return m ? Number(m[1]) : undefined;
  };
  const stride = num('programs/chip_core/src/instructions/compressed.rs', /const COMPRESSED_CLAIM_PACK_STRIDE:\s*u64\s*=\s*(\d+)/);
  const perPack = num('programs/chip_core/src/economy.rs', /pub const MAX_CHIPS_PER_PACK:\s*usize\s*=\s*(\d+)/);
  const qty = num('programs/chip_core/src/economy.rs', /pub const MAX_PACK_QTY:\s*u8\s*=\s*(\d+)/);
  const out: string[] = [];
  if (stride === undefined) out.push('COMPRESSED_CLAIM_PACK_STRIDE not found');
  if (perPack === undefined) out.push('MAX_CHIPS_PER_PACK not found');
  if (qty === undefined) out.push('MAX_PACK_QTY not found');
  if (out.length) return out;
  if (perPack! * qty! > stride!) out.push(`stride ${stride} < MAX_PACK_QTY ${qty} x MAX_CHIPS_PER_PACK ${perPack} — claim PDAs collide across nonces`);
  const compressed = stripComments(srcOf('programs/chip_core/src/instructions/compressed.rs'));
  if (!/const _:\s*\(\)\s*=\s*assert!/.test(compressed)) out.push('the compile-time stride assert is gone');
  // the pack nonce really is built with that stride and that per-pack factor
  if (!/COMPRESSED_CLAIM_PACK_STRIDE/.test(compressed)) out.push('the stride is no longer used to build the claim nonce');
  if (!/\(pack_no as u64\)\s*\*\s*MAX_CHIPS_PER_PACK as u64/.test(compressed)) out.push('the per-pack factor changed — re-derive the bound');
  // the purchase bound must be the same constant the stride was sized for (a literal 25 could drift)
  const packs = stripComments(srcOf('programs/chip_core/src/instructions/packs.rs'));
  // whitespace-tolerant on purpose: rustfmt (the pinned image in CI) broke this `require!` across
  // lines, and a gate that only matches the unformatted spelling fails on a formatting commit.
  if (!/require!\(\s*\(1\.\.=MAX_PACK_QTY\)\.contains\(&qty\)/.test(packs)) out.push('buy_pack no longer bounds qty by MAX_PACK_QTY');
  return out;
}

test('SEC-B19 the compressed claim-nonce stride covers the largest pack bundle (or two packs collide)', () => {
  assert.deepEqual(claimNonceStrideViolations(src), []);
  // the rule is not vacuous: shrinking the stride below MAX_PACK_QTY x MAX_CHIPS_PER_PACK must fail it
  const shrunk = (rel: string) => src(rel).replace('const COMPRESSED_CLAIM_PACK_STRIDE: u64 = 128;', 'const COMPRESSED_CLAIM_PACK_STRIDE: u64 = 64;');
  assert.ok(claimNonceStrideViolations(shrunk).some((v) => /claim PDAs collide/.test(v)), 'rule must fail on a stride below the bound');
  // whitespace-tolerant again: `cargo fmt` writes `const _: () =` and `assert!(...)` on two lines
  const noAssert = (rel: string) => src(rel).replace(/const _:\s*\(\)\s*=\s*assert!\s*\([\s\S]*?\);/, '');
  assert.ok(claimNonceStrideViolations(noAssert).some((v) => /compile-time stride assert/.test(v)), 'rule must notice a deleted const assert');
});

// SEC-B23: `backend/src/admin.ts` hand-mirrors the guard-rails of `set_params`, because the panel only
// *encodes* a Squads transaction — a panel that says ok and a tx that fails on chain (or worse, a
// BigInt that 500s `GET /admin/params`) is the failure mode this rule closes. Same error vocabulary,
// same thresholds, JSON-safe payload.
const secB23Violations = (rust: string, econ: string, panelRaw: string): string[] => {
  const bad: string[] = [];
  const body = bodyOf(rust, 'pub fn set_params');
  // NB: do *not* run the Rust comment stripper over TS — a `/*` inside a TS string opens a block comment
  // there and swallows most of the file (the rule then "passes" by seeing nothing). Skip whole comment
  // lines instead, so a commented-out guard cannot satisfy the rule either.
  const panel = panelRaw.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  if (!body) return ['set_params body not found — the guard-rails this rule mirrors live in it'];
  // 1. vocabulary: a new `require!(…, ChipError::X)` inside set_params must show up as a panel rule name
  const raised = [...new Set([
    ...[...body.matchAll(/ChipError::(\w+)/g)].map((m) => m[1]!),
    ...[...bodyOf(rust, 'fn require_non_default').matchAll(/ChipError::(\w+)/g)].map((m) => m[1]!),
  ])].sort();
  const PINNED = ['CgPriceGuardRail', 'FeeTooHigh', 'InvalidCollection', 'InvalidConfigAddress', 'InvalidQuantity', 'OddsGuardRail', 'OddsSumInvalid', 'Overflow'];
  if (raised.join(',') !== PINNED.join(',')) bad.push(`set_params raises {${raised.join(', ')}} — mirror it in the panel and extend this rule`);
  for (const v of raised) if (!new RegExp(`rule: '${v}'`).test(panel)) bad.push(`${v}: the program can return it, the panel has no rule with that name`);
  // 2. thresholds: every numeric rail must be the same number on both sides
  const gn = (v: string | number) => Number(String(v).replace(/_/g, '')).toLocaleString('en-US').replace(/,/g, '_');
  const guardStart = panel.indexOf('export const GUARD');
  const guard = panel.slice(guardStart, panel.indexOf('} as const;', guardStart)).replace(/\s+/g, ' ');
  const num = (re: RegExp, hay: string) => { const m = re.exec(hay); return m ? Number(m[1]!.replace(/_/g, '')) : NaN; };
  for (const [konst, field] of [
    ['BPS_DENOM', 'bpsDenom'], ['MAX_CHIPS_PER_PACK', 'maxChipsPerPack'], ['MAX_TOP2_BPS_STANDARD', 'maxTop2BpsStandard'],
    ['MAX_MARKET_FEE_BPS', 'maxMarketFeeBps'], ['MAX_SKR_DISCOUNT_BPS', 'maxSkrDiscountBps'], ['MAX_PACK_CG_PRICE_MICRO', 'maxPackCgPriceMicro'],
  ] as const) {
    const v = num(new RegExp(`pub const ${konst}: \\w+ = ([\\d_]+);`), econ);
    if (Number.isNaN(v)) bad.push(`${konst} is no longer a plain integer const — update this rule with it`);
    else if (!new RegExp(`${field}: ${gn(v)}\\b`).test(guard)) bad.push(`GUARD.${field} ≠ ${konst} (${v}): the panel would propose what the program rejects`);
  }
  for (const [label, re, field] of [
    ['Common floor', /odds_bps\[0\] >= ([\d_]+)/, 'minCommonBps'],
    ['pity hard floor', /pity_hard_at >= ([\d_]+)/, 'minHardAt'],
    ['pity soft-step cap', /pity_soft_step_bps <= ([\d_]+)/, 'maxSoftStepBps'],
    ['$CG ×½–2× factor', /saturating_mul\((\d+)\)/, 'cgPriceMoveFactor'],
  ] as const) {
    const v = num(re, body);
    if (Number.isNaN(v)) bad.push(`the ${label} literal is gone from set_params — update this rule`);
    else if (!new RegExp(`${field}: ${gn(v)}\\b`).test(guard)) bad.push(`GUARD.${field} ≠ the ${label} literal (${v})`);
  }
  const price = /\((\d[\d_]*)\.\.=(\d[\d_]*)\)\.contains\(&p\.price_usd_cents\)/.exec(body);
  if (!price) bad.push('the pack price band is no longer an explicit literal — update this rule');
  else if (!guard.includes(`priceCentsRange: [${gn(price[1]!)}, ${gn(price[2]!)}]`)) bad.push(`GUARD.priceCentsRange ≠ the ${gn(price[1]!)}…${gn(price[2]!)} program band`);
  if (!/old \/ 2/.test(body)) bad.push('the $CG band no longer uses `old / 2` — the panel mirrors integer division, keep them equal');
  // 3. the panel side: same comparison sites, no second copy of a number, and a payload that can be JSON-serialised
  if (!/priceCgMicro > CG_PRICE_GUARD\.maxMicro/.test(panel)) bad.push('the panel compares priceCgMicro against something other than CG_PRICE_GUARD.maxMicro');
  if (!/maxMicro: BigInt\(GUARD\.maxPackCgPriceMicro\)/.test(panel)) bad.push('CG_PRICE_GUARD.maxMicro is not derived from GUARD.maxPackCgPriceMicro — two numbers can drift');
  if (!/cur\.priceCgMicro \/ CG_PRICE_GUARD\.moveFactor/.test(panel) || !/cur\.priceCgMicro \* CG_PRICE_GUARD\.moveFactor/.test(panel)) bad.push('the one-shot ×½–2× band is missing from checkPackGuardRails');
  if (/\b\d[\d_]*n\b/.test(guard)) bad.push('GUARD holds a BigInt literal — GET /admin/params returns guardRails verbatim and JSON.stringify throws on it');
  if (!/k\.equals\(ZERO_KEY\)/.test(panel)) bad.push('the panel accepts 111…111 as a destination — the program refuses it (SEC-B22)');
  if (!/cfg\.paramsVersion >= 65_535/.test(panel)) bad.push('the params_version ceiling (ChipError::Overflow) is not mirrored — the panel would encode a patch that reverts');
  if (!/checkPackGuardRails\(patch\.sku, merged, violations, `packs\[\$\{i\}\]`, cfg\.packs\[patch\.sku\]\)/.test(panel)) bad.push('checkPackGuardRails is not given the live row — the ×½–2× band compares against nothing');
  return bad;
};

test('SEC-B23 the admin panel mirrors set_params: same error vocabulary, same thresholds, JSON-safe payload', () => {
  const bad = secB23Violations(
    src('programs/chip_core/src/instructions/admin.rs'),
    src('programs/chip_core/src/economy.rs'),
    src('backend/src/admin.ts'),
  );
  assert.deepEqual(bad, []);
});

// ---------------------------------------------------------------- rule self-tests

const fake = (code: string, rel = 'programs/chip_core/src/instructions/fake.rs'): SourceFile => ({ path: rel, rel, program: 'chip_core', code: stripComments(code) });

test('SEC-B22 set_params: every money/feed address is validated and the change is described, not just counted', () => {
  const admin = src('programs/chip_core/src/instructions/admin.rs');
  const state = src('programs/chip_core/src/state.rs');
  const events = src('backend/src/events.ts');
  const bad: string[] = [];
  const body = bodyOf(admin, 'pub fn set_params');
  if (!body) bad.push('set_params is gone — the guard-rails this rule reads live in its body');
  // 1. the five address fields must pass the non-default check before they reach GameConfig. Parsed
  //    per branch on purpose: a rule that only asked "does require_non_default appear anywhere" would
  //    pass with one guarded field and four open ones.
  for (const [field, local] of [
    ['treasury', 't'],
    ['buyback_wallet', 'b'],
    ['pyth_sol_usd_feed', 'p'],
    ['pyth_skr_usd_feed', 'p'],
    ['skr_mint', 'm'],
  ] as const) {
    const branch = new RegExp(`if let Some\\(${local}\\) = patch\\.${field}\\\s*\\{[\\s\\S]{0,120}?\\}\\s*`);
    const m = branch.exec(body);
    if (!m) bad.push(`${field}: branch not found (a field was renamed — update this rule with it)`);
    else if (!/require_non_default\(/.test(m[0])) bad.push(`${field}: assigned without the zero-key check (SEC-B22)`);
  }
  // 2. the emitted description must carry the new values, and both events must be emitted (the old one
  //    is what the admin log and the fairness note read).
  const emit = body.slice(body.indexOf('emit!(ParamsChanged'));
  if (!/emit!\(ParamsChanged\s*\{/.test(emit)) bad.push('ParamsChanged is no longer emitted (existing consumers read it)');
  if (!/emit!\(ParamsPatched\s*\{/.test(emit)) bad.push('ParamsPatched is not emitted — the audit trail is back to a bare counter');
  for (const f of ['treasury', 'buyback_wallet', 'pyth_sol_usd_feed', 'pyth_skr_usd_feed', 'skr_mint', 'market_fee_bps', 'skr_discount_bps', 'featured_collection']) {
    if (!new RegExp(`${f}:\\s*c\\.${f}`).test(emit)) bad.push(`ParamsPatched does not carry ${f}`);
  }
  // 3. the bitmask must have one bit per patch field, and both halves have to agree about the count:
  //    the struct's `Option` fields on one side, the `changed |=` sites on the other.
  const patchFields = (bodyOf(admin, 'pub struct ParamsPatch').match(/pub \w+: Option</g) ?? []).length;
  const setBits = (body.match(/changed \|= PARAMS_FIELD_/g) ?? []).length;
  const constBits = new Set((admin.match(/pub const PARAMS_FIELD_\w+: u16 = 1 << \d+;/g) ?? []).map((l) => l.match(/1 << (\d+)/)![1]));
  if (patchFields !== 9) bad.push(`ParamsPatch has ${patchFields} Option fields — one field per bit is the invariant`);
  if (setBits !== patchFields) bad.push(`${setBits} \`changed |= …\` sites for ${patchFields} patch fields`);
  if (constBits.size !== patchFields) bad.push(`${constBits.size} distinct PARAMS_FIELD_* bits for ${patchFields} fields`);
  // 4. the program-side event and the backend codec must declare the same fields, in the same order —
  //    a mismatch decodes the tail of the event as garbage instead of failing.
  const rustEvent = bodyOf(state, 'pub struct ParamsPatched');
  const rustFields = [...rustEvent.matchAll(/pub (\w+): (\w+),/g)].map((m) => m[1]);
  const specMatch = /spec\('chip_core', 'ParamsPatched', \[([\s\S]*?)\]\)/.exec(events);
  const specFields = specMatch ? [...specMatch[1].matchAll(/\['(\w+)',/g)].map((m) => m[1]) : [];
  if (!rustEvent) bad.push('ParamsPatched is not declared in state.rs');
  else if (!specMatch) bad.push('backend events.ts has no ParamsPatched spec — the event would land in events_raw undecoded');
  else if (rustFields.length !== specFields.length) bad.push(`ParamsPatched: ${rustFields.length} Rust fields vs ${specFields.length} in the codec`);
  else {
    // the codec names its fields in camelCase (`lockUntil`, `refHash`): compare after normalising the
    // Rust side, or every multi-word field would look like drift.
    const toCamel = (w: string) => w.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    for (let i = 0; i < rustFields.length; i++) {
      if (toCamel(rustFields[i]!) !== specFields[i]) bad.push(`ParamsPatched field ${i}: Rust ${rustFields[i]} vs codec ${specFields[i]}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('self-test: E29 rule flags the pre-fix SEC-F2 fusion loop and accepts the fixed one', () => {
  const vulnerable = `
    pub fn fuse_compressed_claims_v0<'info>(ctx: Context<'_, '_, 'info, 'info, FuseCompressedClaims<'info>>) -> Result<()> {
        for (i, claim_ai) in ctx.remaining_accounts.iter().enumerate() {
            let claim: Account<CompressedMintClaim> = Account::try_from(claim_ai)?;
            material_keys[i] = claim_ai.key();
        }
        for claim_ai in ctx.remaining_accounts.iter() {
            let mut data = claim_ai.try_borrow_mut_data()?; // consumed = true
        }
        Ok(())
    }`;
  assert.equal(remainingAccountsViolations(parseFns(fake(vulnerable))).length, 1);
  const fixed = vulnerable.replace('material_keys[i] = claim_ai.key();', 'ensure_distinct_material(&material_keys[..i], &claim_ai.key())?; material_keys[i] = claim_ai.key();');
  assert.equal(remainingAccountsViolations(parseFns(fake(fixed))).length, 0);
});

test('self-test: the account reader extracts constraints, types and close targets', () => {
  const [s] = parseAccountsStructs(fake(`
    #[derive(Accounts)]
    #[instruction(nonce: u64)]
    pub struct Steal<'info> {
        /// CHECK: doc comments are ignored
        pub thief: Signer<'info>, // not mut
        #[account(init, payer = thief, space = 8 + 32, seeds = [b"x", thief.key().as_ref()], bump)]
        pub loot: Box<Account<'info, Loot>>,
        #[account(mut, close = thief, seeds = [b"p", &nonce.to_le_bytes()], bump = pending.bump)]
        pub pending: Account<'info, PendingPack>,
        pub token_program: UncheckedAccount<'info>,
        pub vault_token: Option<Account<'info, TokenAccount>>,
    }`));
  assert.equal(s.name, 'Steal');
  assert.deepEqual(s.fields.map((f) => f.name), ['thief', 'loot', 'pending', 'token_program', 'vault_token']);
  assert.deepEqual(coreType(s.fields[1].type), { kind: 'Account', inner: 'Loot', optional: false });
  assert.deepEqual(coreType(s.fields[4].type), { kind: 'Account', inner: 'TokenAccount', optional: true });
  assert.equal(constraintValue(s.fields[1], 'space'), '8 + 32'); // ← would fail the INIT_SPACE rule
  assert.equal(constraintValue(s.fields[2], 'close'), 'thief'); // ← no has_one ⇒ would fail E28
  assert.ok(!has(s.fields[0], /^mut$/)); // ← payer not mut ⇒ would fail A3
  assert.equal(coreType(s.fields[3].type).kind, 'UncheckedAccount'); // ← would fail A4
});

test('self-test: SEC-B22 rule flags an unguarded address and a codec that drifted from the event', () => {
  const admin = src('programs/chip_core/src/instructions/admin.rs');
  const events = src('backend/src/events.ts');
  // re-render the rule against a mutated tree by re-reading the two files it depends on
  const runRule = (next: { admin?: string; events?: string; state?: string }) => {
    const files: Record<string, string> = {
      'programs/chip_core/src/instructions/admin.rs': next.admin ?? admin,
      'backend/src/events.ts': next.events ?? events,
      'programs/chip_core/src/state.rs': next.state ?? src('programs/chip_core/src/state.rs'),
    };
    // the rule body above is a closure over `src`; the cheapest honest mutation check is to search the
    // mutated text for the same two facts the rule asserts
    const bad: string[] = [];
    const body = bodyOf(files['programs/chip_core/src/instructions/admin.rs'], 'pub fn set_params');
    const branch = /if let Some\(t\) = patch\.treasury\s*\{[\s\S]{0,120}?\}\s*/.exec(body);
    if (!branch || !/require_non_default\(/.test(branch[0])) bad.push('treasury: assigned without the zero-key check (SEC-B22)');
    const rustFields = [...bodyOf(files['programs/chip_core/src/state.rs'], 'pub struct ParamsPatched').matchAll(/pub (\w+): (\w+),/g)]
      .map((m) => m[1]!.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()));
    const specMatch = /spec\('chip_core', 'ParamsPatched', \[([\s\S]*?)\]\)/.exec(files['backend/src/events.ts']);
    const specFields = specMatch ? [...specMatch[1].matchAll(/\['(\w+)',/g)].map((m) => m[1]) : [];
    if (rustFields.join(',') !== specFields.join(',')) bad.push('codec drifted');
    return bad;
  };
  assert.deepEqual(runRule({}), []);
  const unguarded = admin.replace(/    if let Some\(t\) = patch\.treasury \{\n        require_non_default\(t\)\?;/, '    if let Some(t) = patch.treasury {');
  assert.notEqual(unguarded, admin);
  assert.ok(runRule({ admin: unguarded }).some((v) => /treasury/.test(v)));
  const drifted = events.replace("['treasury', 'pubkey'],", '');
  assert.notEqual(drifted, events);
  assert.ok(runRule({ events: drifted }).some((v) => /codec drifted/.test(v)));
});

test('self-test: SEC-B23 rule flags a dropped panel rule, a drifted threshold and a BigInt payload', () => {
  const rust = src('programs/chip_core/src/instructions/admin.rs');
  const econ = src('programs/chip_core/src/economy.rs');
  const panel = src('backend/src/admin.ts');
  assert.deepEqual(secB23Violations(rust, econ, panel), []);
  const noCgRule = panel.replace(/rule: 'CgPriceGuardRail'/g, "rule: 'ok'");
  assert.notEqual(noCgRule, panel);
  assert.ok(secB23Violations(rust, econ, noCgRule).some((v) => /CgPriceGuardRail/.test(v)));
  const drift = econ.replace('pub const MAX_MARKET_FEE_BPS: u16 = 1_000;', 'pub const MAX_MARKET_FEE_BPS: u16 = 1_500;');
  assert.notEqual(drift, econ);
  assert.ok(secB23Violations(rust, drift, panel).some((v) => /maxMarketFeeBps/.test(v)));
  const newRequire = rust.replace('require!(fee <= MAX_MARKET_FEE_BPS, ChipError::FeeTooHigh);', 'require!(fee <= MAX_MARKET_FEE_BPS, ChipError::FeeTooHigh);\n        require!(fee != 999, ChipError::BrandNewRail);');
  assert.notEqual(newRequire, rust);
  assert.ok(secB23Violations(newRequire, econ, panel).some((v) => /BrandNewRail/.test(v)));
  const bigint = panel.replace('maxPackCgPriceMicro: 1_000_000_000_000,', 'maxPackCgPriceMicro: 1_000_000_000_000n,');
  assert.notEqual(bigint, panel);
  assert.ok(secB23Violations(rust, econ, bigint).some((v) => /BigInt/.test(v)));
});

test('self-test: A2/A8 modulo rule flags a slot-modulo roll and a stripped rejection bound', () => {
  const slotRoll = `pub fn roll(ctx: Context<Open>) -> Result<()> { let r = Clock::get()?.slot % 100; Ok(()) }`;
  assert.equal(moduloViolations([fake(slotRoll)]).length, 1);
  const byteRoll = `pub fn pick(bytes: &[u8; 32]) -> usize { (bytes[0] % 10) as usize }`;
  assert.equal(moduloViolations([fake(byteRoll)]).length, 1);
  const noReject = `pub fn uniform_pool(bytes: &[u8; 32], slot: usize, pool: usize) -> usize { (bytes[slot] as usize) % pool }`;
  assert.equal(moduloViolations([fake(noReject)]).length, 1);
  const ok = `pub fn uniform_pool(b: &[u8; 32], s: usize, pool: usize) -> usize { let v = w(b, s); if v < limit { return (v % range) as usize; } 0 }
    pub fn log_it() { msg!("100 % done"); }`;
  assert.deepEqual(moduloViolations([fake(ok)]), []);
});
