// Verifies that a program artifact — or the program already on chain — is the build the cluster needs
// (SEC-F19 from SECURITY-ECON-AUDIT-2026-09-21; the "reminder" line that `program-ids guard-mainnet`
// prints becomes a check here).
//
// What nothing else catches: `anchor build -- --features devnet` (or `localnet`) yields a chip_core.so /
// arena.so that pins the *devnet* Switchboard program — or `programs/sb_mock` — as the only accepted
// owner of randomness accounts, and the devnet queue as the only accepted queue
// (programs/chip_core/src/randomness.rs, `#[cfg(feature = …)]`). Deployed to mainnet such a binary
// passes `program-ids check`, `anchor verify` against the wrong feature set, and every test. With the
// devnet pin, packs never open (nobody owns that id on mainnet). With the localnet pin it is worse:
// the sb_mock keypair is IN THIS REPO (tests/localnet/fixtures/sb_mock-keypair.json), so anyone can
// deploy their own "oracle" at that address on mainnet and forge every pack, fusion and battle roll.
// The program cannot tell a bad build from itself, so the check has to look at the bytes.
//
//   npm run verify-deploy -- artifact --cluster mainnet [--dir target/deploy]
//       scans chip_core.so + arena.so for the 32-byte pins: the cluster's SB program id and queue must be
//       present; every other cluster's pin (and the mock) must be absent.
//   npm run verify-deploy -- onchain --cluster mainnet --rpc URL [--dir target/deploy] [--authority PUBKEY]
//       fetches the deployed program data, prints the upgrade authority + deploy slot, runs the same pin
//       scan on the on-chain bytes, and — when the local .so exists — checks it is byte-identical.
//   npm run verify-deploy -- --selftest
//       inline cases (synthetic ELF-like buffers, the loader header, and this file's pin table against
//       randomness.rs). Run by `npm run verify` and by CI.
//
// How a pubkey shows up in an SBF binary: usually as 32 contiguous bytes in .rodata (that is what
// `require_keys_eq!` compares against), but LLVM may also materialise a constant as four 64-bit `lddw`
// immediates, each split into two 32-bit halves 8 bytes apart. The scan understands both, and is
// deliberately asymmetric: the *expected* pins must be found whole (all four chunks in some form),
// while a *foreign* pin is reported on a single 8-byte chunk (a random 8-byte collision in a 400 KB
// file has odds around 1e-13; a partial hit is not noise, it is a lead).
//
// `scripts/setup.ts` imports `fetchDeployedProgram` + `assessPins` and refuses to initialise a mainnet
// deployment whose chip_core / arena bytes do not carry the mainnet pins. Nothing below runs on import.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PublicKey, type Connection } from '@solana/web3.js';

const root = resolve(import.meta.dirname, '..');

export type Cluster = 'mainnet' | 'devnet' | 'localnet';
export const CLUSTERS: Cluster[] = ['mainnet', 'devnet', 'localnet'];
/** Mirror of programs/chip_core/src/randomness.rs (the selftest fails if the two drift). */
export const PINS: Record<Cluster, { program: string; queue: string }> = {
  mainnet: { program: 'SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv', queue: 'A43DyUGA7s8eXPxqEjJY6EBu1KKbNgfxF8h17VAHn13w' },
  devnet: { program: 'Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2', queue: 'EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7' },
  localnet: { program: 'ApDh35vcLCxXc5ivaRGFhayn1HduJ9b2nXbfR6WMpVKH', queue: 'EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7' },
};
/** The programs that compile randomness.rs in (arena through `chip_core/{devnet,localnet}` feature forwarding). */
export const PINNED_PROGRAMS = ['chip_core', 'arena'] as const;
export const UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

// --------------------------------------------------------------------------- byte scan

export interface PinHit { whole: boolean; chunks: number; forms: string[] }

/** Every offset of `needle` in `hay`. */
function offsets(hay: Buffer, needle: Buffer): number[] {
  const out: number[] = [];
  let i = hay.indexOf(needle);
  while (i >= 0) { out.push(i); i = hay.indexOf(needle, i + 1); }
  return out;
}

/** Is the 8-byte `chunk` present as an `lddw` immediate: `18 rr oo oo LO LO LO LO | 00 00 00 00 HI HI HI HI`? */
function lddwHit(hay: Buffer, chunk: Buffer): boolean {
  const lo = chunk.subarray(0, 4), hi = chunk.subarray(4, 8);
  for (const at of offsets(hay, lo)) {
    const start = at - 4;
    if (start < 0 || start + 16 > hay.length) continue;
    if (hay[start] !== 0x18) continue;
    if (hay.readUInt32LE(start + 8) !== 0) continue;
    if (hay.subarray(start + 12, start + 16).equals(hi)) return true;
  }
  return false;
}

/** How much of a 32-byte key is in `bytes`, and in what shape. */
export function findPubkey(bytes: Uint8Array, key: string | Uint8Array): PinHit {
  const hay = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const k = Buffer.from(typeof key === 'string' ? new PublicKey(key).toBytes() : key);
  if (hay.indexOf(k) >= 0) return { whole: true, chunks: 4, forms: ['contiguous'] };
  let chunks = 0;
  const forms = new Set<string>();
  for (let c = 0; c < 4; c++) {
    const chunk = k.subarray(c * 8, c * 8 + 8);
    if (hay.indexOf(chunk) >= 0) { chunks++; forms.add('8-byte chunk'); } else if (lddwHit(hay, chunk)) { chunks++; forms.add('lddw immediate'); }
  }
  return { whole: chunks === 4, chunks, forms: [...forms] };
}

export interface PinVerdict { ok: boolean; problems: string[]; notes: string[] }

/** The cluster's pins must be whole; every other cluster's distinct pins must leave no trace. */
export function assessPins(bytes: Uint8Array, cluster: Cluster, label = 'artifact'): PinVerdict {
  const problems: string[] = [];
  const notes: string[] = [];
  const want = PINS[cluster];
  for (const [what, key] of [['SB program id', want.program], ['SB queue', want.queue]] as const) {
    const hit = findPubkey(bytes, key);
    if (hit.whole) notes.push(`${label}: ${cluster} ${what} ${key} present (${hit.forms.join('+')})`);
    else if (hit.chunks) problems.push(`${label}: ${cluster} ${what} ${key} only partially present (${hit.chunks}/4 chunks) — inconclusive, treat as a foreign build`);
    else problems.push(`${label}: ${cluster} ${what} ${key} NOT found — this is not a ${cluster} build (check the cargo features: ${cluster === 'mainnet' ? 'no `devnet`/`localnet` feature' : `\`--features ${cluster}\``})`);
  }
  const foreign = new Map<string, string>();
  for (const c of CLUSTERS) {
    if (c === cluster) continue;
    if (PINS[c].program !== want.program) foreign.set(PINS[c].program, `${c} SB program id${c === 'localnet' ? ' (sb_mock — its keypair is in the repo)' : ''}`);
    if (PINS[c].queue !== want.queue) foreign.set(PINS[c].queue, `${c} SB queue`);
  }
  for (const [key, what] of foreign) {
    const hit = findPubkey(bytes, key);
    if (hit.chunks) problems.push(`${label}: ${what} ${key} found (${hit.whole ? 'whole' : `${hit.chunks}/4 chunks`}, ${hit.forms.join('+')}) — a ${cluster} build must not carry it`);
  }
  return { ok: problems.length === 0, problems, notes };
}

// --------------------------------------------------------------------------- upgradeable-loader layout

/** `UpgradeableLoaderState::Program { programdata_address }` — u32 enum tag 2 + 32 bytes. */
export function parseProgramAccount(data: Uint8Array): PublicKey {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (b.length < 36 || b.readUInt32LE(0) !== 2) throw new Error(`not an upgradeable Program account (len ${b.length}, tag ${b.length >= 4 ? b.readUInt32LE(0) : '?'})`);
  return new PublicKey(b.subarray(4, 36));
}

export interface ProgramData { slot: bigint; authority: PublicKey | null; elf: Uint8Array }
/** `UpgradeableLoaderState::ProgramData { slot, upgrade_authority_address }` — 45-byte header, ELF after it, zero padding to max_len. */
export function parseProgramData(data: Uint8Array): ProgramData {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (b.length < 45 || b.readUInt32LE(0) !== 3) throw new Error(`not an upgradeable ProgramData account (len ${b.length}, tag ${b.length >= 4 ? b.readUInt32LE(0) : '?'})`);
  const slot = b.readBigUInt64LE(4);
  const authority = b[12] === 1 ? new PublicKey(b.subarray(13, 45)) : null;
  return { slot, authority, elf: new Uint8Array(b.subarray(45)) };
}

/** The deployed bytes are the local .so followed by zero padding (max_len ≥ len): prefix-equal, rest zero. */
export function sameElf(onchain: Uint8Array, local: Uint8Array): boolean {
  if (onchain.length < local.length) return false;
  if (!Buffer.from(onchain.subarray(0, local.length)).equals(Buffer.from(local))) return false;
  for (let i = local.length; i < onchain.length; i++) if (onchain[i] !== 0) return false;
  return true;
}

/** Trim the loader's zero padding for hashing / display (an ELF never ends in a run of zeros this long). */
export function trimPadding(elf: Uint8Array): Uint8Array {
  let end = elf.length;
  while (end > 0 && elf[end - 1] === 0) end--;
  return elf.subarray(0, end);
}

export const sha256hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** Program account → ProgramData account, or throw with the reason (not deployed / not upgradeable / wrong owner). */
export async function fetchDeployedProgram(conn: Pick<Connection, 'getAccountInfo'>, programId: PublicKey): Promise<ProgramData & { programdata: PublicKey }> {
  const prog = await conn.getAccountInfo(programId);
  if (!prog) throw new Error(`${programId.toBase58()} is not deployed (no account)`);
  if (!prog.owner.equals(UPGRADEABLE_LOADER)) throw new Error(`${programId.toBase58()} is owned by ${prog.owner.toBase58()}, not the upgradeable loader`);
  const programdata = parseProgramAccount(new Uint8Array(prog.data));
  const pd = await conn.getAccountInfo(programdata);
  if (!pd) throw new Error(`${programId.toBase58()}: programdata ${programdata.toBase58()} missing`);
  return { programdata, ...parseProgramData(new Uint8Array(pd.data)) };
}

// --------------------------------------------------------------------------- commands

function annotate(problems: string[]): void {
  for (const p of problems) console.error(process.env.GITHUB_ACTIONS ? `::error::verify-deploy: ${p}` : `  ✗ ${p}`);
}

export function artifactCommand(cluster: Cluster, dir: string): number {
  let failed = 0;
  for (const p of PINNED_PROGRAMS) {
    const file = join(dir, `${p}.so`);
    if (!existsSync(file)) { annotate([`${file} missing — build first (anchor build${cluster === 'mainnet' ? '' : ` -- --features ${cluster}`})`]); failed++; continue; }
    const bytes = new Uint8Array(readFileSync(file));
    const v = assessPins(bytes, cluster, `${p}.so`);
    console.log(`${p}.so  ${bytes.length} bytes  sha256 ${sha256hex(bytes)}`);
    for (const n of v.notes) console.log(`  ✓ ${n}`);
    if (!v.ok) { annotate(v.problems); failed++; }
  }
  console.log(failed ? `\nverify-deploy artifact FAILED for ${cluster}: ${failed} program(s)` : `\nverify-deploy artifact OK: ${PINNED_PROGRAMS.join(' + ')} carry the ${cluster} Switchboard pins and no foreign ones`);
  return failed ? 1 : 0;
}

export async function onchainCommand(cluster: Cluster, rpc: string, dir: string, ids: Record<string, PublicKey>, authority?: PublicKey, programs: readonly string[] = PINNED_PROGRAMS): Promise<number> {
  const { Connection } = await import('@solana/web3.js');
  const conn = new Connection(rpc, 'confirmed');
  let failed = 0;
  for (const p of programs) {
    const id = ids[p];
    try {
      const d = await fetchDeployedProgram(conn, id);
      const elf = trimPadding(d.elf);
      console.log(`${p} ${id.toBase58()}\n  programdata ${d.programdata.toBase58()}  slot ${d.slot}  authority ${d.authority?.toBase58() ?? 'NONE (immutable)'}\n  on-chain ${elf.length} bytes  sha256 ${sha256hex(elf)}`);
      const problems: string[] = [];
      if (authority && !(d.authority?.equals(authority) ?? false)) problems.push(`${p}: upgrade authority is ${d.authority?.toBase58() ?? 'none'}, expected ${authority.toBase58()}`);
      const v = assessPins(d.elf, cluster, `${p} (on chain)`);
      for (const n of v.notes) console.log(`  ✓ ${n}`);
      problems.push(...v.problems);
      const file = join(dir, `${p}.so`);
      if (existsSync(file)) {
        const local = new Uint8Array(readFileSync(file));
        if (sameElf(d.elf, local)) console.log(`  ✓ byte-identical to ${file} (sha256 ${sha256hex(local)})`);
        else problems.push(`${p}: on-chain bytes differ from ${file} (local sha256 ${sha256hex(local)}) — not the artifact you think you deployed`);
      } else console.log(`  · ${file} not present, skipping the byte comparison`);
      if (problems.length) { annotate(problems); failed++; }
    } catch (e) { annotate([`${p}: ${(e as Error).message}`]); failed++; }
  }
  console.log(failed ? `\nverify-deploy onchain FAILED for ${cluster}: ${failed} program(s)` : `\nverify-deploy onchain OK for ${cluster}`);
  return failed ? 1 : 0;
}

// --------------------------------------------------------------------------- selftest

/** A fake "binary": random bytes with the given keys planted in the requested shapes. */
function synth(parts: { key: string; form: 'contiguous' | 'lddw' | 'chunks'; only?: number[] }[], size = 4096, seed = 7): Uint8Array {
  const buf = Buffer.alloc(size);
  let x = seed;
  for (let i = 0; i < size; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; buf[i] = x >> 16; }
  let cursor = 64;
  for (const p of parts) {
    const k = Buffer.from(new PublicKey(p.key).toBytes());
    if (p.form === 'contiguous') { k.copy(buf, cursor); cursor += 48; continue; }
    for (const c of p.only ?? [0, 1, 2, 3]) {
      const chunk = k.subarray(c * 8, c * 8 + 8);
      if (p.form === 'chunks') { chunk.copy(buf, cursor); cursor += 24; continue; }
      buf[cursor] = 0x18; buf[cursor + 1] = 0x01; buf.writeUInt16LE(0, cursor + 2);
      chunk.subarray(0, 4).copy(buf, cursor + 4);
      buf.writeUInt32LE(0, cursor + 8);
      chunk.subarray(4, 8).copy(buf, cursor + 12);
      cursor += 32;
    }
  }
  return new Uint8Array(buf);
}

const cases: { name: string; run: () => string[] }[] = [
  {
    name: 'PINS mirrors programs/chip_core/src/randomness.rs (every SB_PROGRAM_ID / SB_QUEUE constant, per cfg)',
    run: () => {
      const src = readFileSync(join(root, 'programs/chip_core/src/randomness.rs'), 'utf8');
      const found = [...src.matchAll(/pub const SB_(?:PROGRAM_ID|QUEUE): Pubkey = pubkey!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\)/g)].map((m) => m[1]);
      const table = new Set(Object.values(PINS).flatMap((p) => [p.program, p.queue]));
      const problems = found.filter((k) => !table.has(k)).map((k) => `randomness.rs pins ${k} which PINS does not know`);
      if (found.length !== 6) problems.push(`expected 6 SB_PROGRAM_ID/SB_QUEUE constants in randomness.rs, found ${found.length}`);
      for (const k of table) if (!found.includes(k)) problems.push(`PINS has ${k} which randomness.rs no longer pins`);
      // the cfg lines decide which cluster each constant belongs to; check the mainnet one is the un-featured default
      const mainnetBlock = /#\[cfg\(not\(any\(feature = "devnet", feature = "localnet"\)\)\)\]\s*pub const SB_PROGRAM_ID: Pubkey = pubkey!\("([^"]+)"\)/.exec(src);
      if (!mainnetBlock || mainnetBlock[1] !== PINS.mainnet.program) problems.push('the un-featured (mainnet) SB_PROGRAM_ID in randomness.rs is not PINS.mainnet.program');
      const localBlock = /#\[cfg\(feature = "localnet"\)\]\s*pub const SB_PROGRAM_ID: Pubkey = pubkey!\("([^"]+)"\)/.exec(src);
      if (!localBlock || localBlock[1] !== PINS.localnet.program) problems.push('the localnet SB_PROGRAM_ID in randomness.rs is not PINS.localnet.program');
      return problems;
    },
  },
  {
    name: 'contiguous mainnet pins: OK for mainnet, rejected for devnet and localnet (missing + foreign)',
    run: () => {
      const b = synth([{ key: PINS.mainnet.program, form: 'contiguous' }, { key: PINS.mainnet.queue, form: 'contiguous' }]);
      const m = assessPins(b, 'mainnet');
      const d = assessPins(b, 'devnet');
      const l = assessPins(b, 'localnet');
      const problems: string[] = [];
      if (!m.ok) problems.push(`mainnet should pass: ${m.problems.join(' | ')}`);
      if (d.ok || !d.problems.some((p) => p.includes('NOT found')) || !d.problems.some((p) => p.includes('mainnet SB program id'))) problems.push(`devnet should fail on missing + foreign: ${d.problems.join(' | ')}`);
      if (l.ok || !l.problems.some((p) => p.includes('sb_mock') || p.includes('NOT found'))) problems.push(`localnet should fail: ${l.problems.join(' | ')}`);
      return problems;
    },
  },
  {
    name: 'lddw-split localnet program pin + contiguous queue: OK for localnet, the mock is flagged for mainnet',
    run: () => {
      const b = synth([{ key: PINS.localnet.program, form: 'lddw' }, { key: PINS.localnet.queue, form: 'contiguous' }]);
      const l = assessPins(b, 'localnet');
      const m = assessPins(b, 'mainnet');
      const problems: string[] = [];
      if (!l.ok) problems.push(`localnet should pass: ${l.problems.join(' | ')}`);
      if (!l.notes.some((n) => n.includes('lddw immediate'))) problems.push(`expected the lddw form to be reported: ${l.notes.join(' | ')}`);
      if (m.ok || !m.problems.some((p) => p.includes('sb_mock') && p.includes('whole'))) problems.push(`mainnet should flag the whole mock pin: ${m.problems.join(' | ')}`);
      // devnet and localnet share the queue: it must not be reported as foreign for either
      if (assessPins(b, 'localnet').problems.some((p) => p.includes('devnet SB queue'))) problems.push('the shared devnet/localnet queue was reported as foreign');
      return problems;
    },
  },
  {
    name: 'a partial expected pin is inconclusive (fails), a single foreign chunk is enough to fail',
    run: () => {
      const b = synth([{ key: PINS.mainnet.program, form: 'chunks', only: [0, 3] }, { key: PINS.mainnet.queue, form: 'contiguous' }, { key: PINS.devnet.program, form: 'lddw', only: [2] }]);
      const m = assessPins(b, 'mainnet');
      const problems: string[] = [];
      if (m.ok) problems.push('should fail');
      if (!m.problems.some((p) => p.includes('partially present (2/4 chunks)'))) problems.push(`expected a partial-pin problem: ${m.problems.join(' | ')}`);
      if (!m.problems.some((p) => p.includes('devnet SB program id') && p.includes('1/4 chunks'))) problems.push(`expected the single devnet chunk to be flagged: ${m.problems.join(' | ')}`);
      const clean = synth([{ key: PINS.mainnet.program, form: 'contiguous' }, { key: PINS.mainnet.queue, form: 'lddw' }], 65536, 99);
      const c = assessPins(clean, 'mainnet');
      if (!c.ok) problems.push(`random filler must not produce false positives: ${c.problems.join(' | ')}`);
      return problems;
    },
  },
  {
    name: 'upgradeable-loader layout: Program → programdata, ProgramData header, zero padding, byte comparison',
    run: () => {
      const problems: string[] = [];
      const pdAddr = new PublicKey('11111111111111111111111111111112');
      const prog = Buffer.concat([Buffer.from([2, 0, 0, 0]), Buffer.from(pdAddr.toBytes())]);
      if (!parseProgramAccount(new Uint8Array(prog)).equals(pdAddr)) problems.push('programdata address not parsed');
      try { parseProgramAccount(new Uint8Array(Buffer.from([3, 0, 0, 0]))); problems.push('a ProgramData tag must not parse as a Program'); } catch { /* expected */ }
      const auth = new PublicKey('HPMr5r9sS5ApWsPNJytZRLbm2jz1veFxTn1wepjAhtho');
      const elf = Buffer.from(synth([{ key: PINS.mainnet.program, form: 'contiguous' }], 1000, 3));
      const header = Buffer.alloc(45); header.writeUInt32LE(3, 0); header.writeBigUInt64LE(123456789n, 4); header[12] = 1; Buffer.from(auth.toBytes()).copy(header, 13);
      const onchain = Buffer.concat([header, elf, Buffer.alloc(500)]);
      const pd = parseProgramData(new Uint8Array(onchain));
      if (pd.slot !== 123456789n) problems.push(`slot ${pd.slot}`);
      if (!pd.authority?.equals(auth)) problems.push('authority not parsed');
      if (!sameElf(pd.elf, new Uint8Array(elf))) problems.push('padded on-chain bytes should equal the local .so');
      if (trimPadding(pd.elf).length !== elf.length) problems.push(`trimPadding: ${trimPadding(pd.elf).length} vs ${elf.length}`);
      const tampered = Buffer.from(elf); tampered[500] ^= 1;
      if (sameElf(pd.elf, new Uint8Array(tampered))) problems.push('a one-bit difference must not compare equal');
      if (sameElf(pd.elf.subarray(0, 900), new Uint8Array(elf))) problems.push('a shorter on-chain program must not compare equal');
      const noAuth = Buffer.from(onchain); noAuth[12] = 0;
      if (parseProgramData(new Uint8Array(noAuth)).authority !== null) problems.push('Option::None authority should be null');
      return problems;
    },
  },
];

function selftest(): number {
  let failed = 0;
  for (const c of cases) {
    let problems: string[] = [];
    try { problems = c.run(); } catch (e) { problems = ['threw: ' + (e as Error).message]; }
    if (problems.length) { failed++; console.log(`✗ ${c.name}`); for (const p of problems) console.log(`    ${p}`); }
    else console.log(`✓ ${c.name}`);
  }
  console.log(failed ? `\n${failed}/${cases.length} case(s) failed` : `\n${cases.length} verify-deploy case(s) ok`);
  return failed ? 1 : 0;
}

// --------------------------------------------------------------------------- cli

async function cli(argv: string[]): Promise<number> {
  const opt = (name: string, dflt?: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
  if (argv.includes('--selftest')) return selftest();
  const cmd = argv[0];
  const cluster = opt('cluster') as Cluster | undefined;
  if (!cmd || !['artifact', 'onchain'].includes(cmd) || !cluster || !CLUSTERS.includes(cluster)) {
    console.error('usage: verify-deploy.ts artifact --cluster mainnet|devnet|localnet [--dir target/deploy]\n       verify-deploy.ts onchain --cluster … --rpc URL [--dir target/deploy] [--authority PUBKEY]\n       verify-deploy.ts --selftest');
    return 2;
  }
  const dir = resolve(root, opt('dir', 'target/deploy')!);
  if (cmd === 'artifact') return artifactCommand(cluster, dir);
  const rpc = opt('rpc') ?? process.env.ANCHOR_PROVIDER_URL ?? process.env.RPC_URL;
  if (!rpc) { console.error('onchain needs --rpc URL (or ANCHOR_PROVIDER_URL / RPC_URL)'); return 2; }
  // ids: env override (PROGRAM_*) > Anchor.toml [programs.<cluster>]
  const toml = readFileSync(join(root, 'Anchor.toml'), 'utf8');
  const section = toml.split(/^\[programs\.(\w+)\]\s*$/m);
  const ids: Record<string, PublicKey> = {};
  for (let i = 1; i < section.length; i += 2) {
    if (section[i] !== cluster) continue;
    for (const m of section[i + 1].matchAll(/^(\w+)\s*=\s*"([^"]+)"/gm)) ids[m[1]] = new PublicKey(m[2]);
  }
  const programs = (opt('programs') ?? PINNED_PROGRAMS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  for (const p of programs) {
    if (!(PINNED_PROGRAMS as readonly string[]).includes(p)) { console.error(`unknown program '${p}' (pinned: ${PINNED_PROGRAMS.join(', ')})`); return 2; }
    const env = process.env[`PROGRAM_${p.toUpperCase()}`];
    if (env) ids[p] = new PublicKey(env);
    if (!ids[p]) { console.error(`no id for ${p}: not in Anchor.toml [programs.${cluster}] and PROGRAM_${p.toUpperCase()} unset`); return 2; }
  }
  const authority = opt('authority') ? new PublicKey(opt('authority')!) : undefined;
  return onchainCommand(cluster, rpc, dir, ids, authority, programs);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  cli(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
