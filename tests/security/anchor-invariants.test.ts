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
  // 2026-10-01 (Bubblegum V2 migration, STEP 4): the Core-market / Core-staking pruning and the
  // `open_pack` dead-body removal deleted 9 account contexts and ~55 fields, so the floors moved
  // 93 → 90, 800 → 745, 45 → 45 (init sites were unaffected: `open_pack`'s init lived in the
  // deleted body and the rest are elsewhere) and 14 → 11. Each floor is still far above anything a
  // broken parser would produce — the point of the test is that the reader is not silently matching
  // nothing, not that the surface never shrinks.
  assert.ok(structs.length >= 90, `#[derive(Accounts)] structs: ${structs.length}`);
  assert.ok(structs.reduce((a, s) => a + s.fields.length, 0) >= 745, 'account fields');
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
  const clientCatalog = JSON.parse(src('client/src/chain/errorCatalog.json')) as Record<string, { name: string; key: string }[]>;
  for (const [name, variants] of Object.entries(rust)) {
    assert.ok(variants.length >= 10, `${name}: ${variants.length} variants`);
    const names = Array.from(listIn(expectTs, name).matchAll(/'(\w+)'/g)).map((m) => m[1]);
    assert.deepEqual(names, variants, `tests/localnet/helpers/expect.ts ${name}`);
    const entries = clientCatalog[name.toLowerCase()];
    assert.ok(Array.isArray(entries), `client error catalog missing ${name}`);
    assert.deepEqual(entries.map(e => e.name), variants, `client error catalog ${name}: names and order`);
    // Identical errors intentionally share a translation key across programs.
    for (const locale of ['en', 'ru', 'pt', 'es', 'vi', 'id', 'fil']) {
      const messages = JSON.parse(src(`client/src/shared/i18n/failures/${locale}.json`)) as Record<string, string>;
      for (const entry of entries) assert.ok(typeof messages[entry.key] === 'string' && messages[entry.key].trim(),
        `${locale}/${name}/${entry.name}: missing localized message`);
    }
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
  assert.ok(n >= 11, `close sites seen: ${n}`);
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

test('B10 randomness mixes a delayed SlotHashes entry, not unix_timestamp', () => {
  const code = stripComments(src('programs/chip_core/src/randomness.rs')).replace(/#\[cfg\(test\)\][\s\S]*$/, '');
  assert.doesNotMatch(code, /unix_timestamp/, 'programs/chip_core/src/randomness.rs');
  assert.match(code, /SLOT_HASHES_ID/);
  assert.match(code, /RNG_DELAY_SLOTS/);
  assert.match(code, /gc-rng-v1/);
  const econ = stripComments(src('programs/chip_core/src/economy.rs')).replace(/#\[cfg\(test\)\][\s\S]*$/, '');
  assert.doesNotMatch(econ, /unix_timestamp|Clock::get/, 'programs/chip_core/src/economy.rs');
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
const secB23Violations = (rust: string, econ: string, panelRaw: string, stake = '', chain = ''): string[] => {
  const srcs: Record<string, string> = { chain };
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
  // 4. the same class for the staking mirror: `proposeParams` encodes `set_split` by hand too, so its
  //    three rails (slice count, sum, ±delta, 7-day interval) must be the program's numbers.
  if (stake) {
    const splitBody = bodyOf(stake, 'pub fn set_split');
    if (!splitBody) bad.push('staking::set_split is gone — the panel still encodes it');
    else {
      const konst = (name: string) => num(new RegExp(`pub const ${name}: \\w+ = ([\\d_]+|\\d+ \\* \\w+);`), stake);
      const scalar = (m: RegExpExecArray | null) => (m ? m[1]!.trim() : '');
      const count = konst('SPLIT_COUNT'), delta = konst('MAX_SPLIT_DELTA_BPS'), day = konst('DAY');
      // `MIN_SPLIT_INTERVAL = 7 * DAY` — resolve the product rather than trusting a second literal
      const minRaw = scalar(/pub const MIN_SPLIT_INTERVAL: i64 = (\d+ \* \w+);/.exec(stake));
      const minInterval = minRaw && day ? Number(minRaw.split('*')[0]!.trim()) * day : NaN;
      // `GUARD.split.count` is written as the imported `SPLIT_COUNT` (which the on-chain decoder also uses),
      // so accept that identifier — but then the literal must not have drifted either.
      if (!Number.isNaN(count) && !new RegExp(`count: (${count}\\b|SPLIT_COUNT,)`).test(guard)) bad.push(`GUARD.split.count ≠ SPLIT_COUNT (${count})`);
      if (srcs.chain && !Number.isNaN(count) && !new RegExp(`export const SPLIT_COUNT = ${count};`).test(srcs.chain)) bad.push(`backend/src/chain.ts SPLIT_COUNT ≠ the program's ${count}`);
      if (!Number.isNaN(delta) && !new RegExp(`maxDeltaBps: ${gn(delta)}\\b`).test(guard)) bad.push(`GUARD.split.maxDeltaBps ≠ MAX_SPLIT_DELTA_BPS (${delta})`);
      // the panel writes the product (`7 * 86_400`), the program names a constant (`7 * DAY`): evaluate both
      const panelInterval = (() => {
        const m = /minIntervalS: ([0-9_*\s]+)/.exec(guard);
        return m ? m[1]!.split('*').reduce((a, t) => a * Number(t.replace(/_/g, '').trim()), 1) : NaN;
      })();
      if (Number.isNaN(minInterval) || panelInterval !== minInterval) {
        bad.push(`GUARD.split.minIntervalS ≠ MIN_SPLIT_INTERVAL (${minRaw || '?'} = ${minInterval}, panel = ${panelInterval})`);
      }
      const sum = scalar(/iter\(\)\.map\(\|&b\| b as u32\)\.sum::<u32>\(\) == ([\d_]+)/.exec(splitBody));
      if (sum !== '10_000') bad.push(`set_split no longer checks sum == 10_000 (found ${sum || 'nothing'}) — the panel mirrors that literal`);
      if (!/const sum = s\.reduce\(\(a, b\) => a \+ b, 0\);\s+if \(sum !== 10_000\)/.test(panel.replace(/\n/g, ' '))) bad.push('the panel does not compare the split sum against 10 000');
      if (!/now - e\.split_changed_at >= MIN_SPLIT_INTERVAL/.test(splitBody)) bad.push('set_split no longer enforces the 7-day interval');
      if (!/Number\(c\.emission\.splitChangedAt\) \+ GUARD\.split\.minIntervalS/.test(panel)) bad.push('the panel does not compare against the live split_changed_at');
      if (!/Math\.abs\(v - cur\[i\]\) > GUARD\.split\.maxDeltaBps/.test(panel)) bad.push('the panel does not apply the ±delta rail per slice');
    }
  }
  return bad;
};

test('SEC-B23 the admin panel mirrors set_params and set_split: same vocabulary, same thresholds, JSON-safe payload', () => {
  const bad = secB23Violations(
    src('programs/chip_core/src/instructions/admin.rs'),
    src('programs/chip_core/src/economy.rs'),
    src('backend/src/admin.ts'),
    // the rails of set_split span two files: the instruction and the constants module
    src('programs/staking/src/instructions/emission.rs') + '\n' + src('programs/staking/src/state.rs'),
    src('backend/src/chain.ts'),
  );
  assert.deepEqual(bad, []);
});

// SEC-B24: the kill switch encodes `pause` / `set_paused` / `set_arena` and *picks the signer*. Each
// program validates that signer against its **own** config account (chip_core `config`, staking
// `emission`, arena `arena_config`), so a panel that reads chip_core's pair for an arena pause hands the
// multisig a transaction that can only revert — on the incident path, where it costs minutes. This rule
// binds every `Pause` struct to the PDA the panel writes and to the authority pair it signs with.
const secB24Violations = (srcs: { admin: string; server: string; chip: string; staking: string; arena: string }): string[] => {
  const bad: string[] = [];
  const norm = (t: string) => t.replace(/\s+/g, ' ');
  const admin = norm(srcs.admin);
  const server = norm(srcs.server);
  const paStart = admin.indexOf('export const PAUSABLE');
  const pa = admin.slice(paStart, admin.indexOf('};', paStart));
  if (paStart < 0) return ['PAUSABLE is gone — the kill switch has no account map'];
  // 1. Rust side: what each program's `Pause` is seeded from, and that it accepts its own admin/pauser
  const pda: Record<string, string> = { config: 'configPda()', emission: 'emissionPda()', arena_config: 'arenaConfigPda()' };
  const authority: Record<string, RegExp> = {
    chip_core: /c\.config\.admin, pauser: c\.config\.pauser, current: c\.config\.paused/,
    staking: /c\.emission\.admin, pauser: c\.emission\.pauser, current: c\.emission\.paused/,
    arena: /c\.arena\.admin, pauser: c\.arena\.pauser, current: c\.arena\.paused/,
  };
  for (const [prog, file] of [['chip_core', srcs.chip], ['staking', srcs.staking], ['arena', srcs.arena]] as const) {
    // NB: `pub struct Pause<` — a bare `pub struct Pause` also matches `pub struct PauseChanged` in arena/lib.rs.
    const body = bodyOf(file, 'pub struct Pause<');
    if (!body) { bad.push(`${prog}: no \`pub struct Pause\` — the panel encodes an instruction the program does not have`); continue; }
    const seed = /seeds = \[b"(\w+)"/.exec(body)?.[1];
    if (!seed || !pda[seed]) { bad.push(`${prog}: Pause PDA seed ${seed ?? '(none)'} is not one this rule knows — update the rule and PAUSABLE`); continue; }
    const obj = prog === 'staking' ? 'emission' : 'config';
    if (!body.includes(`${obj}.admin`) || !body.includes(`${obj}.pauser`)) bad.push(`${prog}: Pause does not accept its own admin *or* pauser`);
    const want = pda[seed]!.replace(/[()]/g, '\\$&');
    if (!new RegExp(`${prog}: \\(\\) => \\(\\{ programId: \\w+(?:\\.\\w+)?, account: ${want}\\[0\\] \\}\\)`).test(pa)) {
      bad.push(`${prog}: the panel pauses the wrong account (Pause is seeded from b"${seed}" ⇒ ${pda[seed]})`);
    }
    // 2. TS side: the signer for that program must come from that program's own account
    if (!authority[prog]!.test(server)) bad.push(`${prog}: the kill-switch route does not take the authority from ${prog}'s own account`);
  }
  // 3. arena un-pause goes through `set_arena` (ArenaAdmin: has_one = admin) — admin-only, and the panel
  //    must not sign it with a pauser or with a missing arena.
  const arena = norm(srcs.arena);
  const adminStruct = arena.slice(arena.indexOf('pub struct ArenaAdmin'));
  if (!/pub struct ArenaAdmin/.test(arena)) bad.push('arena: ArenaAdmin is gone — set_arena is the un-pause path');
  else if (!/has_one = admin/.test(adminStruct.slice(0, 400))) bad.push('arena: ArenaAdmin no longer requires the admin — the un-pause rail moved');
  if (!/arena_missing/.test(server)) bad.push('arena: a cluster without ArenaConfig is not reported (the panel would sign with a default key)');
  // 4. the live state, and the "pause is admin-only to undo" rule
  if (!/body\.paused && !authority\.pauser\.equals\(PublicKey\.default\) \? authority\.pauser : authority\.admin/.test(admin)) {
    bad.push('killSwitch: the signer is not "pauser for pause, admin for un-pause" — an un-pause could go out signed by the hot key');
  }
  if (!/from: authority\.current/.test(admin)) bad.push('killSwitch: the diff no longer reports the live state');
  // 5. the panel actually reads the arena account
  if (!/getAccountInfo\(arenaConfigPda\(\)\[0\]\)/.test(admin)) bad.push('fetchChainParams does not read the ArenaConfig account');
  if (!/decodeArenaConfig\(new Uint8Array\(arena\.data\)\)/.test(admin)) bad.push('the arena account is read but not decoded into admin/pauser/paused');
  if (!/arena: c\.arena \? \{ admin: c\.arena\.admin\.toBase58\(\), pauser: c\.arena\.pauser\.toBase58\(\), paused: c\.arena\.paused \} : null/.test(admin)) {
    bad.push('GET /admin/params does not publish the arena authority pair');
  }
  return bad;
};

test('SEC-B24 the kill switch signs each program with that program\'s own authority (arena ≠ chip_core)', () => {
  const bad = secB24Violations({
    admin: src('backend/src/admin.ts'),
    server: src('backend/src/server.ts'),
    chip: src('programs/chip_core/src/instructions/admin.rs'),
    staking: src('programs/staking/src/instructions/emission.rs'),
    arena: src('programs/arena/src/lib.rs'),
  });
  assert.deepEqual(bad, []);
});

// ---------------------------------------------------------------- F. marketplace currency
/**
 * SEC-B28 — the claim market settles in SOL only, and the *listing* side has to know it.
 *
 * `buy_compressed` / `buy_compressed_asset` pay the seller with `system_program::transfer` and answer
 * `CompressedCurrencyMismatch` for anything else, but `list_compressed*` accepted USDC/SKR anyway: the
 * listing PDA was created and the claim was flagged `listed`, which closes that claim's mint and fusion
 * paths in chip_core (`InvalidChipState`) until the seller cancels — an unfillable listing plus a
 * self-lockout, from a UI that offered the currencies the docs listed. The guard is one shared helper
 * (a third list path cannot be added without it), the buy-side check stays as defense in depth for a
 * listing created before it, and the client builders refuse the currency before a wallet pays a fee.
 */
const secB28Violations = (srcs: { market: string; client: string }): string[] => {
  const bad: string[] = [];
  const bodyIn = (text: string, anchor: string) => bodyOf(text, anchor);
  for (const handler of ['pub fn list_compressed_handler', 'pub fn list_compressed_asset_handler']) {
    const body = bodyIn(srcs.market, handler);
    if (!body) { bad.push(`${handler}: handler is gone — the rule no longer covers the listing side`); continue; }
    if (!/require_sol_claim_market\(currency\)\?;/.test(body)) bad.push(`${handler}: lists a currency the claim market cannot settle (SEC-B28)`);
  }
  const helper = bodyIn(srcs.market, 'fn require_sol_claim_market');
  if (!helper) bad.push('require_sol_claim_market is gone — the SOL-only rule has no single definition');
  else {
    if (!/currency == Currency::Sol/.test(helper)) bad.push('require_sol_claim_market no longer compares against Currency::Sol (an inverted comparison accepts USDC/SKR)');
    if (!/MarketError::CompressedCurrencyMismatch/.test(helper)) bad.push('require_sol_claim_market answers a different error — the client table translates 6011 to "Compressed listing expects SOL"');
  }
  for (const handler of ['pub fn buy_compressed_handler', 'pub fn buy_compressed_asset_handler']) {
    const body = bodyIn(srcs.market, handler);
    if (!body) { bad.push(`${handler}: handler is gone`); continue; }
    if (!/listing\.currency == Currency::Sol/.test(body) || !/MarketError::CompressedCurrencyMismatch/.test(body)) {
      bad.push(`${handler}: dropped its own currency check — a listing created before SEC-B28 would be buyable`);
    }
  }
  for (const builder of ['export function listCompressedIx', 'export function listCompressedAssetIx']) {
    const body = bodyIn(srcs.client, builder);
    if (!body) { bad.push(`${builder}: builder is gone — the client-side check is not covered`); continue; }
    if (!/assertSolClaimListing\(a\.currency\);/.test(body)) bad.push(`${builder}: encodes a claim listing without the SOL-only check (the wallet pays for a guaranteed revert)`);
  }
  const assertFn = bodyIn(srcs.client, 'export function assertSolClaimListing');
  if (!assertFn || !/currency !== MarketCurrency\.SOL/.test(assertFn)) bad.push('assertSolClaimListing no longer compares against MarketCurrency.SOL');
  return bad;
};

test("SEC-B28 the claim market lists in SOL only: both list handlers, both buy handlers, both builders", () => {
  const bad = secB28Violations({ market: src('programs/market/src/lib.rs'), client: src('client/src/chain/ix/market.ts') });
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

test('self-test: SEC-B28 rule flags a claim listing in USDC and a buy path that trusts it', () => {
  const market = src('programs/market/src/lib.rs');
  const client = src('client/src/chain/ix/market.ts');
  const files = { market, client };
  assert.deepEqual(secB28Violations(files), []);
  // NB: both list handlers open with the same two requires, so the mutation is applied from the asset
  // handler's own offset — a file-wide replace would mutate the pre-mint handler and the assertion below
  // would pass while proving nothing about this one.
  const assetAt = market.indexOf('pub fn list_compressed_asset_handler');
  const usdcListed = market.slice(0, assetAt) + market.slice(assetAt).replace('require_sol_claim_market(currency)?;\n', '');
  assert.notEqual(usdcListed, market, 'the mutation must match the asset list handler');
  assert.ok(secB28Violations({ ...files, market: usdcListed }).some((v) => /list_compressed_asset_handler/.test(v)));
  const inverted = market.replace('currency == Currency::Sol,', 'currency != Currency::Usdc,');
  assert.notEqual(inverted, market);
  assert.ok(secB28Violations({ ...files, market: inverted }).some((v) => /no longer compares against Currency::Sol/.test(v)));
  const trustingBuy = market.replace('listing.currency == Currency::Sol,\n        MarketError::CompressedCurrencyMismatch', 'true,\n        MarketError::CompressedCurrencyMismatch');
  assert.notEqual(trustingBuy, market);
  assert.ok(secB28Violations({ ...files, market: trustingBuy }).some((v) => /dropped its own currency check/.test(v)));
  const openBuilder = client.replace('  assertSolClaimListing(a.currency);\n  const [listing] = compressedAssetListingPda(a.asset);', '  const [listing] = compressedAssetListingPda(a.asset);');
  assert.notEqual(openBuilder, client, 'the mutation must match the asset builder');
  assert.ok(secB28Violations({ ...files, client: openBuilder }).some((v) => /listCompressedAssetIx/.test(v)));
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
  const stake = src('programs/staking/src/instructions/emission.rs') + '\n' + src('programs/staking/src/state.rs');
  assert.deepEqual(secB23Violations(rust, econ, panel, stake), []);
  const noCgRule = panel.replace(/rule: 'CgPriceGuardRail'/g, "rule: 'ok'");
  assert.notEqual(noCgRule, panel);
  assert.ok(secB23Violations(rust, econ, noCgRule, stake).some((v) => /CgPriceGuardRail/.test(v)));
  const drift = econ.replace('pub const MAX_MARKET_FEE_BPS: u16 = 1_000;', 'pub const MAX_MARKET_FEE_BPS: u16 = 1_500;');
  assert.notEqual(drift, econ);
  assert.ok(secB23Violations(rust, drift, panel, stake).some((v) => /maxMarketFeeBps/.test(v)));
  const newRequire = rust.replace('require!(fee <= MAX_MARKET_FEE_BPS, ChipError::FeeTooHigh);', 'require!(fee <= MAX_MARKET_FEE_BPS, ChipError::FeeTooHigh);\n        require!(fee != 999, ChipError::BrandNewRail);');
  assert.notEqual(newRequire, rust);
  assert.ok(secB23Violations(newRequire, econ, panel, stake).some((v) => /BrandNewRail/.test(v)));
  const bigint = panel.replace('maxPackCgPriceMicro: 1_000_000_000_000,', 'maxPackCgPriceMicro: 1_000_000_000_000n,');
  assert.notEqual(bigint, panel);
  assert.ok(secB23Violations(rust, econ, bigint, stake).some((v) => /BigInt/.test(v)));
  const looserSplit = stake.replace('pub const MAX_SPLIT_DELTA_BPS: u16 = 1_000;', 'pub const MAX_SPLIT_DELTA_BPS: u16 = 2_000;');
  assert.notEqual(looserSplit, stake);
  assert.ok(secB23Violations(rust, econ, panel, looserSplit).some((v) => /maxDeltaBps/.test(v)));
});

test('self-test: SEC-B24 rule flags an arena pause signed with chip_core keys and a wrong PDA', () => {
  const files = {
    admin: src('backend/src/admin.ts'),
    server: src('backend/src/server.ts'),
    chip: src('programs/chip_core/src/instructions/admin.rs'),
    staking: src('programs/staking/src/instructions/emission.rs'),
    arena: src('programs/arena/src/lib.rs'),
  };
  assert.deepEqual(secB24Violations(files), []);
  const wrongKeys = files.server.replace('c.arena.admin, pauser: c.arena.pauser, current: c.arena.paused', 'c.config.admin, pauser: c.config.pauser, current: c.config.paused');
  assert.notEqual(wrongKeys, files.server);
  assert.ok(secB24Violations({ ...files, server: wrongKeys }).some((v) => /arena: the kill-switch route/.test(v)));
  const wrongPda = files.admin.replace('arena: () => ({ programId: ARENA_ID, account: arenaConfigPda()[0] })', 'arena: () => ({ programId: ARENA_ID, account: configPda()[0] })');
  assert.notEqual(wrongPda, files.admin);
  assert.ok(secB24Violations({ ...files, admin: wrongPda }).some((v) => /wrong account/.test(v)));
  const noDecode = files.admin.replace('decodeArenaConfig(new Uint8Array(arena.data))', 'decodeGameConfig(arena.data)');
  assert.notEqual(noDecode, files.admin);
  assert.ok(secB24Violations({ ...files, admin: noDecode }).some((v) => /not decoded/.test(v)));
  const hotUnpause = files.admin.replace('body.paused && !authority.pauser.equals(PublicKey.default) ? authority.pauser : authority.admin', 'authority.pauser');
  assert.notEqual(hotUnpause, files.admin);
  assert.ok(secB24Violations({ ...files, admin: hotUnpause }).some((v) => /hot key/.test(v)));
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
