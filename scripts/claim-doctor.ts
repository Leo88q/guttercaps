// claim-doctor — why a compressed fusion answers `AccountDidNotDeserialize` (0xbbb / 3003).
//
// The failure this script exists for (2026-10-14, `fuse_compressed_claims` on devnet):
//
//     Program log: Instruction: FuseCompressedClaims
//     Program 11111111111111111111111111111111 invoke [2]      <- the `init` of `result_claim`
//     Program 11111111111111111111111111111111 success
//     Program log: AnchorError occurred. Error Code: AccountDidNotDeserialize. Error Number: 3003.
//
// `Program 111…` in that log is the answer to "which account", and it is not the one the eye picks.
// Anchor 0.31's generated `try_accounts` does all of the *deserialization* first (`deser_fields`,
// lang/syn/src/codegen/accounts/try_accounts.rs) and only then the constraints — and `init` fields are
// handled inside the constraint phase, before the access checks. So by the time the system program is
// invoked to allocate `result_claim`, every named account of `FuseCompressedClaims` has already been
// decoded: `config`, `ledger`, `result_meta`, `cg_mint`, `owner_cg`. None of them can be the culprit:
//
//   * `cg_mint` / `owner_cg` are `anchor_spl` types — `spl_token::state::Mint::unpack` /
//     `Account::unpack`. Their `try_deserialize` delegates to `try_deserialize_unchecked`, which returns
//     the SPL program's own error, never Anchor 3003. 3003 is produced only by the `#[account]` derive
//     (`Self::deserialize(&mut data).map_err(|_| AccountDidNotDeserialize)`).
//   * the three remaining named accounts are program-owned structs; a wrong *owner* would be 3007 and a
//     wrong *discriminator* 3002, both printed before the CPI.
//
// What is left is the only decoding that happens after that CPI: the three material claims in
// `remaining_accounts`, read by the handler through `CompressedMintClaim::try_deserialize_compat`.
//
// The interesting part is what that function can and cannot answer. It pads a claim that is exactly one
// byte short of the current layout (the pre-`founder` generation — see SECURITY.md, 2026-10-12) and
// refuses anything shorter with `InvalidChipState`; it returns 3003 only when the *body* itself will not
// Borsh-decode (a `Rarity` variant out of range, a bool that is not 0/1), which the program cannot
// produce on its own. So a 3003 on a material claim is evidence about the **deployed build**, not about
// the account: a chip_core compiled before the compat work decodes those accounts strictly and fails on
// every legacy claim currently sitting in devnet.
//
// This script settles it without guessing: it reads the accounts the failing transaction named and prints,
// per claim, what the current source would do and what a pre-compat build does. It has no dependencies
// (plain `fetch` JSON-RPC) because it has to run on a laptop that only has the RPC.
//
//   npm run claims:doctor -- --selftest
//   npm run claims:doctor -- --sig <signature> [--rpc <url>]
//   npm run claims:doctor -- --claims <pda1,pda2,pda3> [--rpc <url>]
//   npm run claims:doctor -- --sig <signature> --json
//
// Read-only: it fetches accounts and (optionally) one transaction. It never builds or sends anything.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LAYOUT_FILE = join(ROOT, 'reports', 'state-layout.json');
const CHIP_CORE_ID = 'J68G8KrbLTSdi68LHr9Kkw1YbRRHv3uBPirWCd5Xt13V';
const DEFAULT_RPC = 'https://api.devnet.solana.com';

// The number of named accounts in `FuseCompressedClaims` (programs/chip_core/src/instructions/compressed.rs):
// owner, config, ledger, result_meta, result_claim, cg_mint, owner_cg, token_program, system_program.
// The material claims are everything after them in the same instruction.
const NAMED_ACCOUNTS = 9;
const MATERIALS = 3;

// ----------------------------------------------------------------- layout

/** Borsh width of every field type `CompressedMintClaim` uses (`Rarity` is a one-byte enum). */
const FIELD_BYTES: Record<string, number> = {
  Pubkey: 32, u8: 1, u16: 2, u32: 4, u64: 8, i64: 8, bool: 1, Rarity: 1,
};

interface LayoutEntry { program: string; name: string; fields: string[] }

/** Body size of one `#[account]` struct, from the frozen layout gate (`npm run state:layout`). */
export function bodySizeOf(fields: string[], discard: { unknown: string[] } = { unknown: [] }): number {
  let total = 0;
  for (const field of fields) {
    const at = field.lastIndexOf(':');
    const type = at < 0 ? field : field.slice(at + 1).trim();
    const width = FIELD_BYTES[type];
    if (width === undefined) { discard.unknown.push(field); continue; }
    total += width;
  }
  return total;
}

/** `8 + INIT_SPACE` of `chip_core`'s `CompressedMintClaim`, straight from reports/state-layout.json. */
export function expectedClaimSize(file = LAYOUT_FILE): number {
  const { accounts } = JSON.parse(readFileSync(file, 'utf8')) as { accounts: LayoutEntry[] };
  const entry = accounts.find((a) => a.program === 'chip_core' && a.name === 'CompressedMintClaim');
  if (!entry) throw new Error(`${file}: нет записи chip_core/CompressedMintClaim`);
  const discard: { unknown: string[] } = { unknown: [] };
  const body = bodySizeOf(entry.fields, discard);
  if (discard.unknown.length) throw new Error(`${file}: неизвестный тип поля: ${discard.unknown.join(', ')}`);
  return 8 + body;
}

/** Anchor's account discriminator: sha256("account:<Name>")[..8]. */
export function accountDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
}

/** Anchor's instruction discriminator: sha256("global:<name>")[..8]. */
export function ixDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

// --------------------------------------------------------------- borsh-ish

const RARITY_NAMES = ['Common', 'Rare', 'Epic', 'Legend', 'Mythic'] as const;

export interface ClaimBody {
  buyer: string; collectionIdx: number; rarity: number; level: number; gameIndex: bigint;
  expiresAt: bigint; settlement: string; indexReserved: boolean; minted: boolean; registered: boolean;
  consumed: boolean; listed: boolean; bump: number; staked: boolean; origin: string;
  lockUntil: bigint; founder: boolean;
}

/** Strict little-endian reader. Borsh refuses a bool that is not 0/1 and an enum variant out of range —
 *  that refusal is exactly the 3003 the program reports, so the decoder has to refuse it too. */
class Reader {
  at = 0;
  bytes: Uint8Array;
  constructor(bytes: Uint8Array) { this.bytes = bytes; }
  get remaining(): number { return this.bytes.length - this.at; }
  take(n: number): Uint8Array {
    if (this.remaining < n) throw new Error(`не хватает ${n} байт (осталось ${this.remaining})`);
    const slice = this.bytes.subarray(this.at, this.at + n);
    this.at += n;
    return slice;
  }
  u8(): number { return this.take(1)[0]; }
  bool(): boolean {
    const v = this.u8();
    if (v > 1) throw new Error(`bool = ${v} (допустимо 0 или 1)`);
    return v === 1;
  }
  u64(): bigint {
    const b = this.take(8);
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
    return v;
  }
  i64(): bigint {
    const v = this.u64();
    return v >= 1n << 63n ? v - (1n << 64n) : v;
  }
  pubkey(): string { return b58encode(this.take(32)); }
}

/** Decode the *body* (after the 8-byte discriminator) of a `CompressedMintClaim`. */
export function decodeClaimBody(body: Uint8Array): { ok: true; claim: ClaimBody } | { ok: false; why: string } {
  try {
    const r = new Reader(body);
    const claim: ClaimBody = {
      buyer: r.pubkey(), collectionIdx: r.u8(), rarity: r.u8(), level: r.u8(), gameIndex: r.u64(),
      expiresAt: r.i64(), settlement: r.pubkey(), indexReserved: r.bool(), minted: r.bool(),
      registered: r.bool(), consumed: r.bool(), listed: r.bool(), bump: r.u8(), staked: r.bool(),
      origin: r.pubkey(), lockUntil: r.i64(), founder: r.bool(),
    };
    if (claim.rarity >= RARITY_NAMES.length) throw new Error(`rarity = ${claim.rarity} (старше ${RARITY_NAMES.length - 1})`);
    return { ok: true, claim };
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : String(e) };
  }
}

export const rarityName = (i: number): string => RARITY_NAMES[i] ?? `rarity:${i}`;

// ---------------------------------------------------------------- verdicts

export type ClaimVerdict =
  | 'missing'      // no account at this address
  | 'foreign'      // not a CompressedMintClaim (another chip_core type, or another program)
  | 'current'      // exactly the current layout
  | 'legacy-short' // one byte short: the pre-`founder` generation
  | 'legacy-older' // shorter than that
  | 'oversized'    // longer than the current layout (a newer build wrote it)
  | 'undecodable'; // right size, body will not Borsh-decode

export interface ClaimReport {
  address: string;
  size: number;
  expected: number;
  verdict: ClaimVerdict;
  claim?: ClaimBody;
  why?: string;
  /** what the current source does: `try_deserialize_compat` in the fusion handler */
  head: string;
  /** what a build with a strict `Account<CompressedMintClaim>` does */
  strict: string;
}

/** Classify one on-chain account against the layout of this checkout. */
export function classifyClaim(address: string, data: Uint8Array | null, expected: number): ClaimReport {
  const base = { address, expected, size: data ? data.length : 0 };
  if (!data || data.length === 0) {
    return { ...base, verdict: 'missing', head: 'InvalidChipState (пустой аккаунт)', strict: 'InvalidChipState / 3007' };
  }
  const disc = accountDiscriminator('CompressedMintClaim');
  if (data.length < 8 || Buffer.compare(Buffer.from(data.subarray(0, 8)), disc) !== 0) {
    return { ...base, verdict: 'foreign', head: 'не клейм: другой дискриминатор', strict: 'AccountDiscriminatorMismatch (3002)' };
  }
  // `try_deserialize_compat`: pads the missing trailing `founder` byte, refuses anything shorter.
  const padded = new Uint8Array(Math.max(data.length, expected));
  padded.set(data);
  const decoded = decodeClaimBody(padded.subarray(8));
  const size = data.length;
  // Right size, unreadable body: Borsh refuses it on every build, so both columns answer 3003.
  if (!decoded.ok) {
    return {
      ...base, verdict: 'undecodable', why: decoded.why,
      head: `3003: ${decoded.why}`, strict: `3003: ${decoded.why}`,
    };
  }
  const claim = decoded.claim;
  const ok = `OK (${rarityName(claim.rarity)}, lvl ${claim.level}, collection ${claim.collectionIdx})`;
  if (size > expected) {
    return {
      ...base, verdict: 'oversized', claim,
      head: `${ok} — хвост из ${size - expected} байт игнорируется`, strict: ok,
    };
  }
  if (size === expected) {
    return { ...base, verdict: 'current', claim: decoded.claim, head: ok, strict: ok };
  }
  if (size === expected - 1) {
    return {
      ...base, verdict: 'legacy-short', claim,
      head: `${ok} — compat дописывает нулевой \`founder\``, strict: '3003 AccountDidNotDeserialize',
    };
  }
  return {
    ...base, verdict: 'legacy-older',
    head: `InvalidChipState — на ${expected - size} байт короче, compat дополняет только 1 байт`,
    strict: '3003 AccountDidNotDeserialize',
  };
}

/** The one-line answer for the whole set: what explains a 3003 on these materials? */
export function verdictFor(reports: ClaimReport[]): { code: string; text: string } {
  const short = reports.filter((r) => r.verdict === 'legacy-short' || r.verdict === 'legacy-older');
  if (short.length) {
    return {
      code: 'stale_program',
      text: `${short.length} из ${reports.length} материалов короче текущего layout. Этот чекаут читает ` +
        '`legacy-short` (compat дополняет байт `founder`), а сборка со строгим ' +
        '`Account<CompressedMintClaim>` — нет: ровно она и даёт 3003. Значит, в кластере стоит ' +
        'chip_core старше фикса от 2026-10-12 (SECURITY.md) — пересоберите и задеплойте его.',
    };
  }
  if (reports.some((r) => r.verdict === 'undecodable')) {
    return {
      code: 'corrupt_body',
      text: 'Тело клейма не декодируется ни при какой раскладке (битый enum/bool) — ни текущий код, ни ' +
        'старый его не прочитают. Разбирайте конкретный аккаунт: так программа его не записывала.',
    };
  }
  if (reports.every((r) => r.verdict === 'current' || r.verdict === 'oversized')) {
    return {
      code: 'program_mismatch',
      text: 'Все материалы полного размера и декодируются — этот чекаут прочитал бы их. 3003 тогда ' +
        'означает, что в кластере стоит сборка с ДРУГИМ `INIT_SPACE` (не этот чекаут). Сверьте байты: ' +
        '`npm run verify-deploy -- onchain --cluster devnet --rpc <URL>`.',
    };
  }
  if (reports.some((r) => r.verdict === 'missing')) {
    return {
      code: 'missing_claim',
      text: 'Один из материалов не существует на кластере. Программа ответит InvalidChipState (владелец ' +
        'аккаунта — системная программа), а не 3003: значит, это не те аккаунты, что были в упавшей tx.',
    };
  }
  return {
    code: 'foreign_account',
    text: 'Материалы не являются `CompressedMintClaim` (чужой дискриминатор или чужая программа). 3003 тут ' +
      'невозможен — сначала идёт проверка дискриминатора (3002). Проверьте, что передаётся в remaining_accounts.',
  };
}

// ------------------------------------------------------------------ base58

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function b58decode(s: string): Uint8Array {
  const bytes: number[] = [];
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error(`не base58: ${JSON.stringify(ch)}`);
    let carry = v;
    for (let i = 0; i < bytes.length; i++) { carry += bytes[i] * 58; bytes[i] = carry & 0xff; carry >>= 8; }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const ch of s) { if (ch === '1') bytes.push(0); else break; }
  return Uint8Array.from(bytes.reverse());
}

export function b58encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let d = 0; d < digits.length; d++) { carry += digits[d] << 8; digits[d] = carry % 58; carry = (carry / 58) | 0; }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

// --------------------------------------------------------------------- rpc

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = await res.json() as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

interface AccountInfo { data: [string, string] | null; owner: string; lamports: number }

async function getAccounts(url: string, addresses: string[]): Promise<(Uint8Array | null)[]> {
  const result = await rpc<{ value: (AccountInfo | null)[] }>(url, 'getMultipleAccounts', [
    addresses, { encoding: 'base64', commitment: 'confirmed' },
  ]);
  return (result?.value ?? []).map((v) => (v && v.data ? Buffer.from(v.data[0], 'base64') : null));
}

/** Last deploy of an upgradeable program: the `slot` in its ProgramData account, plus the authority. */
export async function programInfo(url: string, programId = CHIP_CORE_ID): Promise<{ programData: string; slot: bigint | null; authority: string }> {
  const [program] = await getAccounts(url, [programId]);
  if (!program || program.length < 36) return { programData: 'unknown', slot: null, authority: 'unknown' };
  const programData = b58encode(program.subarray(4, 36));
  const [pd] = await getAccounts(url, [programData]);
  if (!pd || pd.length < 45) return { programData, slot: null, authority: 'unknown' };
  let slot = 0n;
  for (let i = 11; i >= 4; i--) slot = (slot << 8n) | BigInt(pd[i]);
  const authority = pd[12] === 1 ? b58encode(pd.subarray(13, 45)) : 'none (не апгрейдится)';
  return { programData, slot, authority };
}

interface ParsedIx { programId: string; accounts: string[]; data?: string; parsed?: unknown }
interface ParsedTx {
  slot: number;
  transaction: { message: { instructions: ParsedIx[] } };
  meta: { err: unknown } | null;
}

/** Material claims of the `fuse_compressed_claims` inside a transaction (accounts 9..12 of that ix). */
export async function materialsOfSignature(url: string, signature: string): Promise<{ slot: number; err: unknown; materials: string[]; nonce: bigint; collectionIdx: number }> {
  const tx = await rpc<ParsedTx | null>(url, 'getTransaction', [
    signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
  ]);
  if (!tx) throw new Error(`транзакция ${signature} не найдена на этом RPC`);
  const disc = ixDiscriminator('fuse_compressed_claims');
  for (const ix of tx.transaction.message.instructions) {
    if (ix.programId !== CHIP_CORE_ID || !ix.data) continue;
    const data = b58decode(ix.data);
    if (Buffer.compare(data.subarray(0, 8), disc) !== 0) continue;
    const args = data.subarray(8);
    let nonce = 0n;
    for (let i = 7; i >= 0; i--) nonce = (nonce << 8n) | BigInt(args[i]);
    return {
      slot: tx.slot, err: tx.meta?.err ?? null,
      materials: ix.accounts.slice(NAMED_ACCOUNTS, NAMED_ACCOUNTS + MATERIALS),
      nonce, collectionIdx: args[8],
    };
  }
  throw new Error(`в ${signature} нет инструкции fuse_compressed_claims (проверьте кластер RPC)`);
}

// ------------------------------------------------------------------ report

function pad(s: string, n: number): string { return s.length >= n ? s : s + ' '.repeat(n - s.length); }

function printReport(reports: ClaimReport[], expected: number, program: { programData: string; slot: bigint | null; authority: string }, source: string): void {
  console.log(`источник материалов: ${source}`);
  console.log(`chip_core ${CHIP_CORE_ID}: ProgramData ${program.programData}, ` +
    `слот последнего деплоя ${program.slot === null ? 'неизвестен' : program.slot}, authority ${program.authority}`);
  console.log(`ожидаемый размер клейма (reports/state-layout.json): ${expected} байт = 8 дискриминатор + ${expected - 8} тело\n`);
  for (const [i, r] of reports.entries()) {
    console.log(`${i + 1}. ${r.address}`);
    console.log(`   ${r.size} байт  [${r.verdict}]${r.claim ? `  rarity=${rarityName(r.claim.rarity)} level=${r.claim.level} collection=${r.claim.collectionIdx}` : ''}`);
    if (r.claim) {
      console.log(`   minted=${r.claim.minted} registered=${r.claim.registered} consumed=${r.claim.consumed} listed=${r.claim.listed} staked=${r.claim.staked} founder=${r.claim.founder}`);
      console.log(`   buyer=${r.claim.buyer} origin=${r.claim.origin} lockUntil=${r.claim.lockUntil}`);
    }
    console.log(`   ${pad('этот чекаут (compat):', 26)} ${r.head}`);
    console.log(`   ${pad('строгий decode:', 26)} ${r.strict}\n`);
  }
  const verdict = verdictFor(reports);
  console.log(`ВЕРДИКТ [${verdict.code}]: ${verdict.text}`);
  if (verdict.code === 'stale_program') {
    console.log('\nЧто делать:');
    console.log('  1) доказать расхождение байт:  npm run verify-deploy -- onchain --cluster devnet --rpc <RPC_URL>');
    console.log('  2) пересобрать и задеплоить:   npm run mac:devnet        (этап deploy: 4 программы, extend при росте)');
    console.log('  3) повторить фьюжн — compat-сборка читает 138-байтовые клеймы, размер записи сохраняется (write_compat).');
  }
}

// -------------------------------------------------------------------- main

interface Args { rpc: string; claims: string[]; sig?: string; json: boolean; selftest: boolean; help: boolean }

export function parseArgs(argv: string[]): Args {
  const args: Args = { rpc: process.env.RPC_URL || DEFAULT_RPC, claims: [], json: false, selftest: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--selftest') args.selftest = true;
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--rpc') args.rpc = argv[++i];
    else if (a === '--claims') args.claims = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--sig' || a === '--signature') args.sig = argv[++i];
    else throw new Error(`неизвестный аргумент: ${a}`);
  }
  return args;
}

const USAGE = `claim-doctor — почему фьюжн отвечает 3003 (AccountDidNotDeserialize)

  npm run claims:doctor -- --selftest
  npm run claims:doctor -- --sig <signature> [--rpc <url>] [--json]
  npm run claims:doctor -- --claims <pda1,pda2,pda3> [--rpc <url>] [--json]

По умолчанию RPC: ${DEFAULT_RPC} (или $RPC_URL). Только чтение.`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); return; }
  const expected = expectedClaimSize();
  let addresses = args.claims;
  let source = `--claims (${addresses.length})`;
  if (args.sig) {
    const found = await materialsOfSignature(args.rpc, args.sig);
    addresses = found.materials;
    source = `tx ${args.sig} (слот ${found.slot}, nonce ${found.nonce}, collection ${found.collectionIdx}, err=${JSON.stringify(found.err)})`;
  }
  if (addresses.length === 0) { console.log(USAGE); process.exitCode = 1; return; }
  const [accounts, program] = await Promise.all([getAccounts(args.rpc, addresses), programInfo(args.rpc)]);
  const reports = addresses.map((a, i) => classifyClaim(a, accounts[i] ?? null, expected));
  if (args.json) {
    console.log(JSON.stringify({ expected, program, reports, verdict: verdictFor(reports) }, (_k, v) => (typeof v === 'bigint' ? String(v) : v), 2));
  } else {
    printReport(reports, expected, program, source);
  }
  if (verdictFor(reports).code !== 'program_mismatch' && reports.some((r) => r.verdict === 'missing' || r.verdict === 'foreign' || r.verdict === 'undecodable')) process.exitCode = 1;
}

// ---------------------------------------------------------------- selftest

/** One synthetic claim per generation, so every verdict is asserted on bytes, not on prose. */
export function makeClaimBody(over: Partial<ClaimBody> = {}): Uint8Array {
  const c: ClaimBody = {
    buyer: CHIP_CORE_ID, collectionIdx: 0, rarity: 0,
    level: 1, gameIndex: 42n, expiresAt: 1_800_000_000n, settlement: '11111111111111111111111111111111',
    indexReserved: false, minted: true, registered: true, consumed: false, listed: false, bump: 254,
    staked: false, origin: CHIP_CORE_ID, lockUntil: 0n, founder: false, ...over,
  };
  const out = new Uint8Array(131);
  const view = new DataView(out.buffer);
  let at = 0;
  const putBytes = (b: Uint8Array) => { out.set(b, at); at += b.length; };
  const u64 = (v: bigint) => { view.setBigUint64(at, v >= 0n ? v : v + (1n << 64n), true); at += 8; };
  putBytes(b58decode(c.buyer));
  view.setUint8(at++, c.collectionIdx); view.setUint8(at++, c.rarity); view.setUint8(at++, c.level);
  u64(c.gameIndex); u64(c.expiresAt);
  putBytes(b58decode(c.settlement));
  for (const b of [c.indexReserved, c.minted, c.registered, c.consumed, c.listed]) view.setUint8(at++, b ? 1 : 0);
  view.setUint8(at++, c.bump);
  view.setUint8(at++, c.staked ? 1 : 0);
  putBytes(b58decode(c.origin));
  u64(c.lockUntil);
  view.setUint8(at++, c.founder ? 1 : 0);
  return out;
}

function accountOf(body: Uint8Array, name = 'CompressedMintClaim'): Uint8Array {
  const disc = accountDiscriminator(name);
  const out = new Uint8Array(8 + body.length);
  out.set(disc, 0);
  out.set(body, 8);
  return out;
}

function selftest(): void {
  const expected = expectedClaimSize();
  assertEqual(expected, 139, 'ожидаемый размер CompressedMintClaim');

  // base58 round-trips (the system program and a claim-shaped address)
  assertEqual(b58encode(b58decode('11111111111111111111111111111111')), '11111111111111111111111111111111', 'base58: системная программа');
  assertEqual(b58decode(CHIP_CORE_ID).length, 32, 'base58: длина chip_core id');
  assertEqual(b58encode(b58decode(CHIP_CORE_ID)), CHIP_CORE_ID, 'base58: round-trip chip_core id');

  const disc = accountDiscriminator('CompressedMintClaim');
  assertEqual(disc.length, 8, 'дискриминатор аккаунта: 8 байт');
  assertEqual(ixDiscriminator('fuse_compressed_claims').length, 8, 'дискриминатор инструкции: 8 байт');

  const full = accountOf(makeClaimBody({ rarity: 2 }));
  assertEqual(full.length, expected, 'синтетический клейм полного размера');
  assertEqual(classifyClaim('full', full, expected).verdict, 'current', 'клейм текущего layout');
  assertEqual(classifyClaim('full', full, expected).claim?.rarity, 2, 'редкость читается');

  // the pre-`founder` generation: same bytes minus the trailing bool
  const legacy = accountOf(makeClaimBody().subarray(0, 130));
  assertEqual(legacy.length, expected - 1, 'legacy клейм на 1 байт короче');
  const legacyReport = classifyClaim('legacy', legacy, expected);
  assertEqual(legacyReport.verdict, 'legacy-short', 'legacy определяется как pre-founder');
  assertEqual(legacyReport.strict, '3003 AccountDidNotDeserialize', 'строгая сборка отвечает 3003');
  assertEqual(legacyReport.head.startsWith('OK'), true, 'compat читает legacy');

  // two bytes short: compat refuses with a custom error, a strict build with 3003
  const older = accountOf(makeClaimBody().subarray(0, 129));
  assertEqual(classifyClaim('older', older, expected).verdict, 'legacy-older', 'клейм старше pre-founder');
  assertEqual(classifyClaim('older', older, expected).head.startsWith('InvalidChipState'), true, 'compat отказывает');
  assertEqual(classifyClaim('older', older, expected).strict, '3003 AccountDidNotDeserialize', 'строгая сборка — 3003');

  // a newer build's account: longer, decodes, trailing bytes ignored
  const longer = new Uint8Array(expected + 4);
  longer.set(full, 0);
  assertEqual(classifyClaim('long', longer, expected).verdict, 'oversized', 'клейм нового layout');
  assertEqual(classifyClaim('long', longer, expected).head.includes('игнорируется'), true, 'хвост игнорируется');

  // the one case that is 3003 on every build: a body Borsh refuses
  const badRarity = accountOf(makeClaimBody({ rarity: 9 }));
  assertEqual(classifyClaim('bad', badRarity, expected).verdict, 'undecodable', 'битый enum → 3003 везде');
  const badBool = Uint8Array.from(full);
  badBool[8 + 32 + 1 + 1 + 1 + 8 + 8 + 32 + 4] = 7; // one of the bools
  assertEqual(classifyClaim('badbool', badBool, expected).verdict, 'undecodable', 'битый bool → 3003');

  // not a claim at all
  assertEqual(classifyClaim('x', accountOf(makeClaimBody(), 'CompressedChipState'), expected).verdict, 'foreign', 'чужой тип → 3002, не 3003');
  assertEqual(classifyClaim('x', null, expected).verdict, 'missing', 'пустого аккаунта нет');

  // the verdict a devnet fusion produces today: three pre-founder materials
  const trio = ['a', 'b', 'c'].map((n) => classifyClaim(n, legacy, expected));
  assertEqual(verdictFor(trio).code, 'stale_program', 'три legacy-материала → сборка старше фикса');
  assertEqual(verdictFor(trio.map((r) => ({ ...r, verdict: 'current' as ClaimVerdict }))).code, 'program_mismatch', 'полный размер → расхождение байт');
  assertEqual(verdictFor([{ ...trio[0], verdict: 'undecodable' }]).code, 'corrupt_body', 'битое тело → разбор аккаунта');

  // the instruction this whole script is about: accounts 9..12 carry the materials
  const args = parseArgs(['--claims', 'a,b,c']);
  assertEqual(args.claims.join('|'), 'a|b|c', 'разбор --claims');
  assertEqual(parseArgs([]).claims.length, 0, 'без аргументов — нет материалов');
  console.log('claim-doctor: selftest OK');
}

function assertEqual<T>(actual: T, want: T, what: string): void {
  if (actual !== want) throw new Error(`${what}: ожидали ${String(want)}, получили ${String(actual)}`);
}

if (process.argv.includes('--selftest')) {
  try {
    selftest();
  } catch (e) {
    console.error(`claim-doctor: SELFTEST FAILED — ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
} else {
  main().catch((e) => {
    console.error(`claim-doctor: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
