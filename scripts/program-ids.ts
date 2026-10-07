// Program-id ceremony tool (docs/09-production-readiness.md §2).
//
// The four ids in this repo are dev-derived placeholders: Anchor.toml says so, and `anchor keys sync`
// after the first build would silently rewrite `declare_id!` to whatever keypair happens to sit in
// ~/.config/solana/id.json. The same ids are hard-coded in nine more places (chip.rs CPI constants,
// client + backend defaults, .env.example, the CI devnet probe, this table). This script makes the
// change once, from the keypairs that will actually sign the deploy, and verifies afterwards that no
// copy was left behind.
//
//   npm run program-ids                     # status: id per program, keypair present, consistent?
//   npm run program-ids -- check            # exit 1 on any drift (wired into `npm run verify`)
//   npm run program-ids -- guard-mainnet    # exit 1 until programs/program-ids.json freezes these ids (SEC-F05)
//   npm run program-ids -- new --out DIR    # create 4 cold keypairs (refuses to overwrite anything)
//   npm run program-ids -- apply --from DIR # rewrite every id site from those keypairs
//   npm run program-ids -- apply --from DIR --dry-run
//
// `new` writes keypairs with 0600 and prints the exact commands to hand them to the multisig ceremony.
// Keypairs are never committed: `check` reads target/deploy/*.json (anchor's own location) or --from DIR.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { chmodSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Keypair, PublicKey } from '@solana/web3.js';

const root = resolve(import.meta.dirname, '..');
const PROGRAMS = ['chip_core', 'market', 'staking', 'arena'] as const;
type ProgramName = (typeof PROGRAMS)[number];

/** The freeze record: written by `manifest` at the ceremony, committed with the deploy, and read by every
 * deploy-side gate as the authority for the ids (docs/09 §2, ops/deploy/runbook.md §1.1). */
const FREEZE_RECORD = 'programs/program-ids.json';

/** Every file that hard-codes a program id. `apply` rewrites all of them in one pass. */
const ID_SITES = [
  'programs/chip_core/src/lib.rs',
  'programs/market/src/lib.rs',
  'programs/staking/src/lib.rs',
  'programs/arena/src/lib.rs',
  'programs/chip_core/src/instructions/chip.rs',
  'Anchor.toml',
  'client/src/app/config.ts',
  'client/.env.example',
  'backend/src/config.ts',
  '.github/workflows/ci.yml',
  // the two one-shot ops scripts cite the ids too — a freeze that leaves them behind means
  // `setup.ts` initialises a program nobody is looking at.
  'scripts/setup.ts',
  'scripts/create-lut.ts',
] as const;

const read = (p: string) => readFileSync(resolve(root, p), 'utf8');
const ID_RE = '[1-9A-HJ-NP-Za-km-z]{32,44}';

/** `declare_id!` per program — the anchor-side truth that everything else has to agree with. */
function declaredIds(): Record<ProgramName, string> {
  const file: Record<string, string> = { chip_core: 'programs/chip_core/src/lib.rs', market: 'programs/market/src/lib.rs', staking: 'programs/staking/src/lib.rs', arena: 'programs/arena/src/lib.rs' };
  return Object.fromEntries(PROGRAMS.map((p) => {
    const m = new RegExp(`declare_id!\\("(${ID_RE})"\\)`).exec(read(file[p]));
    if (!m) throw new Error(`no declare_id! in ${file[p]}`);
    return [p, m[1]];
  })) as Record<ProgramName, string>;
}

/** `[programs.<cluster>]` block of Anchor.toml. */
function anchorIds(cluster: 'localnet' | 'devnet' | 'mainnet'): Record<string, string> {
  const lines = read('Anchor.toml').split('\n');
  const out: Record<string, string> = {};
  let inside = false;
  for (const l of lines) {
    if (/^\[programs\./.test(l)) { inside = l.trim() === `[programs.${cluster}]`; continue; }
    if (inside && /^\[/.test(l)) break;
    if (!inside) continue;
    const m = /^\s*(chip_core|market|staking|arena)\s*=\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/.exec(l);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Default program ids the client / backend / CI use when no env override is set. */
function siteIds(): { site: string; name: string; id: string }[] {
  const out: { site: string; name: string; id: string }[] = [];
  const camel: Record<string, string> = { chip_core: 'chipCore', market: 'market', staking: 'staking', arena: 'arena' };
  const envName: Record<string, string> = { chip_core: 'CHIP_CORE', market: 'MARKET', staking: 'STAKING', arena: 'ARENA' };
  for (const p of PROGRAMS) {
    const client = new RegExp(`${camel[p]}: pk\\(env\\.VITE_PROGRAM_${envName[p]}, '(${ID_RE})'\\)`).exec(read('client/src/app/config.ts'))?.[1];
    if (client) out.push({ site: 'client/src/app/config.ts', name: p, id: client });
    const backend = new RegExp(`${p}: pk\\(env\\.PROGRAM_${envName[p]}, '(${ID_RE})'\\)`).exec(read('backend/src/config.ts'))?.[1];
    if (backend) out.push({ site: 'backend/src/config.ts', name: p, id: backend });
    const env = new RegExp(`VITE_PROGRAM_${envName[p]}=(${ID_RE})`).exec(read('client/.env.example'))?.[1];
    if (env) out.push({ site: 'client/.env.example', name: p, id: env });
    for (const script of ['scripts/setup.ts', 'scripts/create-lut.ts']) {
      const id = new RegExp(`process\\.env\\.PROGRAM_${envName[p]} \\?\\? '(${ID_RE})'`).exec(read(script))?.[1];
      if (id) out.push({ site: script, name: p, id });
    }
  }
  return out;
}

function keypairPath(dir: string, p: ProgramName) {
  return join(dir, p === 'chip_core' ? 'chip_core-keypair.json' : `${p}-keypair.json`);
}
function readKeypair(path: string): PublicKey {
  const arr = JSON.parse(readFileSync(path, 'utf8')) as number[];
  if (arr.length !== 64) throw new Error(`${path}: expected a 64-byte solana-keygen secret array, got ${arr.length} bytes`);
  return Keypair.fromSecretKey(Uint8Array.from(arr)).publicKey;
}

/** Where a deploy keypair can legitimately sit, in the order `status` trusts them: the directory the
 * ceremony hands in with `--from`, the committed localnet fixture, and anchor's own output directory.
 * `target/deploy` is last on purpose — see the long note in `status`. */
const keypairDirs = () => [arg('from') ?? '', 'tests/localnet/fixtures', 'target/deploy'].filter(Boolean);

const cmd = process.argv[2] ?? 'status';
const arg = (name: string, dflt?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

// ---------------------------------------------------------------- status / check
function status(strict: boolean): number {
  const declared = declaredIds();
  const problems: string[] = [];
  const rows: string[] = [];

  // Two kinds of keypair file, and only one of them is evidence. A directory handed in with --from, or a
  // committed localnet fixture, is something someone intends to deploy (or replay) with. `target/deploy/`
  // is where `anchor build` writes a *freshly generated* keypair whenever one is missing — so in any build
  // workspace it holds four random keys whose pubkeys differ from `declare_id!`. Counting that as a mismatch
  // is what kept the `programs` job red after `check` had already been replaced by `status` (run 77, exit 1
  // from `status` alone): the only two ways out were committing private keys or deleting an artifact that
  // anchor re-creates on the next build, and neither is a fix. In non-strict mode such a file therefore
  // reads as `build placeholder` and is said out loud below, so the gate never quietly skips the question;
  // strict `check` — run at the ceremony, where a fabricated keypair in the deploy directory is a real
  // finding (it means nobody put the cold key where the deploy expects it) — still treats it as a mismatch.
  const dirs = keypairDirs();
  const placeholderDir = resolve(root, 'target/deploy');
  let placeholders = 0;
  rows.push('program      declared id (declare_id!)              keypair                          state');
  for (const p of PROGRAMS) {
    const found = dirs.map((d) => keypairPath(resolve(root, d), p)).find((f) => existsSync(f));
    if (!found) {
      rows.push(`${p.padEnd(12)} ${declared[p]}  (none in ${dirs.join(' / ')})`.padEnd(78) + ' unverified');
      if (strict) problems.push(`${p}: no keypair to verify against — run \`npm run program-ids -- new --out DIR\` before deploying`);
      continue;
    }
    const pk = readKeypair(found).toBase58();
    const ok = pk === declared[p];
    const placeholder = !strict && resolve(found) === join(placeholderDir, basename(found));
    if (placeholder) placeholders++;
    rows.push(`${p.padEnd(12)} ${declared[p]}  ${found.replace(`${root}/`, '')}`.padEnd(78)
      + (ok ? ' OK' : placeholder ? ' build placeholder' : ` MISMATCH (keypair = ${pk})`));
    if (!ok && !placeholder) problems.push(`${p}: keypair at ${found} derives ${pk}, but declare_id! says ${declared[p]} — deploy would use the keypair, the client would talk to the declared id`);
  }
  if (placeholders) {
    rows.push(``, `note: ${placeholders} keypair(s) live in target/deploy, which \`anchor build\` fills with generated`
      + `\n      keys when none exist — not deploy material. Verification against the real keys is`
      + `\n      \`npm run program-ids -- check --from DIR\`, and it belongs to the ceremony (ops/deploy/runbook.md §1.1).`);
  }

  for (const cluster of ['localnet', 'devnet', 'mainnet'] as const) {
    const ids = anchorIds(cluster);
    for (const p of PROGRAMS) {
      if (!ids[p]) problems.push(`Anchor.toml [programs.${cluster}] has no ${p}`);
      else if (ids[p] !== declared[p]) problems.push(`Anchor.toml [programs.${cluster}] ${p} = ${ids[p]} != declare_id! ${declared[p]}`);
    }
  }
  for (const { site, name, id } of siteIds()) {
    if (id !== declared[name]) problems.push(`${site} ${name} = ${id} != declare_id! ${declared[name]}`);
  }
  const ci = read('.github/workflows/ci.yml');
  for (const p of PROGRAMS) if (!ci.includes(declared[p])) problems.push(`.github/workflows/ci.yml devnet-smoke does not list ${p} — its deploy probe would silently check nothing`);
  // every file listed as an id site must actually carry one of the ids — the list is the contract
  // `apply` rewrites, so a renamed/moved file must fail loudly instead of keeping a stale id.
  for (const f of ID_SITES) {
    if (!PROGRAMS.some((p) => read(f).includes(declared[p]))) problems.push(`${f} is listed in ID_SITES but contains none of the current ids (moved? rename it in scripts/program-ids.ts)`);
  }

  console.log(rows.join('\n'));
  if (existsSync(resolve(root, FREEZE_RECORD))) console.log(`\nmanifest: ${FREEZE_RECORD} (freeze record — commit it with the deploy)`);
  else console.log(`\nmanifest: ${FREEZE_RECORD} not written yet (do it at the freeze commit, ops/deploy/runbook.md §1.1)`);

  if (problems.length) {
    console.error(`\n✗ program ids:\n  ${problems.join('\n  ')}`);
    return 1;
  }
  console.log('\n✓ every program id copy agrees (Anchor.toml × 3 clusters, declare_id!, chip.rs, client, backend, .env.example, setup.ts, CI)');
  return 0;
}

// ---------------------------------------------------------------- new
function generate(outDir: string): number {
  const dir = resolve(root, outDir);
  if (existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.json'))) {
    console.error(`✗ ${dir} already contains json files — refusing to touch a directory with keys in it`);
    return 1;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lines: string[] = [];
  for (const p of PROGRAMS) {
    const k = Keypair.generate();
    const file = keypairPath(dir, p);
    writeFileSync(file, JSON.stringify([...k.secretKey]));
    chmodSync(file, 0o600);
    lines.push(`${p.padEnd(12)} ${k.publicKey.toBase58()}  ${file.replace(homedir(), '~')}`);
  }
  console.log(`Generated 4 deploy keypairs in ${dir} (0600). Copy them into the multisig ceremony and delete the local copies:\n`);
  console.log(lines.join('\n'));
  console.log(`
Next steps (docs/09 §2, docs/06 §2.5):
  1. Hand each pubkey to the Squads proposal that becomes upgrade authority:
       chip_core, staking → 3/5 + 48 h timelock · market, arena → 2/5.
  2. Import the keypairs into the HSM/cold wallet that holds them; upgrade authority must NOT be a
     hot deployer wallet. The keypairs are only needed again for the deploy itself.
  3. npm run program-ids -- apply --from ${outDir}     # rewrites declare_id!, Anchor.toml, chip.rs, client, backend, CI
  4. npm run economy:check && npm run program-ids -- check
  5. anchor build && anchor deploy --provider.cluster devnet
  6. Write the freeze record: npm run program-ids -- manifest --from ${outDir} && commit programs/program-ids.json with the tag audit-v1-<yyyymmdd>`);
  return 0;
}

// ---------------------------------------------------------------- apply / manifest
function targets(from: string): Record<ProgramName, string> {
  const dir = resolve(root, from);
  return Object.fromEntries(PROGRAMS.map((p) => [p, readKeypair(keypairPath(dir, p)).toBase58()])) as Record<ProgramName, string>;
}

function apply(from: string, dry: boolean): number {
  const declared = declaredIds();
  const next = targets(from);
  const same = PROGRAMS.filter((p) => next[p] === declared[p]);
  if (same.length === PROGRAMS.length) { console.log('nothing to do — the declared ids already come from those keypairs'); return 0; }
  const pairs = PROGRAMS.map((p) => ({ old: declared[p], new: next[p], p })).filter((x) => x.old !== x.new);
  for (const p of pairs) {
    const hits = ID_SITES.filter((f) => read(f).includes(p.old)).length;
    console.log(`${p.p}: ${p.old} → ${p.new} (${hits} files)`);
  }
  if (dry) { console.log('\n(dry run — nothing written)'); return 0; }
  for (const f of ID_SITES) {
    const src = read(f);
    let out = src;
    for (const p of pairs) out = out.split(p.old).join(p.new);
    if (out !== src) writeFileSync(resolve(root, f), out);
  }
  console.log(`\nrewrote ${ID_SITES.length} id sites. Now run: npm run economy:check && npm run program-ids -- manifest --from ${from} && npm run program-ids -- check --from ${from}`);
  return 0;
}

/**
 * The freeze record's contents, exactly as `manifest` writes them. Exported because the reader half of this
 * file (`parseFreezeRecord`) is only right when it accepts what this produces: the shape is `programs[]` as
 * a *list* of `{ name, id, keypairPresent }`, and a reader that treated it as a map keyed by program name
 * matched nothing at all (scripts/deploy-build-env.ts did, and reported its freeze check as passing).
 */
export function freezeRecordDoc(from: string) {
  const declared = declaredIds();
  return {
    '$comment: purpose': 'Freeze record for the deploy (ops/deploy/runbook.md §1.1). Generated by `npm run program-ids -- manifest`.',
    '$comment: ids': 'These are the program ids the client, backend and Anchor.toml all agree on. A deploy whose target/deploy/*-keypair.json derives a different address is a release blocker.',
    '$comment: authority': 'chip_core + staking: Squads 3/5 with 48 h timelock (staking holds the $CG mint authority). market + arena: Squads 2/5. Emergency pause: separate 1/3 hot pauser key.',
    '$comment: build': 'Rebuild with `solana-verify build --library-name <p>` and compare the program hash before trusting any deployed id.',
    generatedBy: 'npm run program-ids -- manifest',
    toolchain: { anchor: '0.31.1', solana: '2.1.0', rust: '1.89.0' },
    cluster: {
      devnet: anchorIds('devnet'),
      mainnet: anchorIds('mainnet'),
      note: 'devnet and mainnet share ids deliberately — one cold keypair per program signs both (docs/09 §2).',
    },
    programs: PROGRAMS.map((p) => ({
      name: p,
      id: declared[p],
      keypair: from ? `${from}/${p === 'chip_core' ? 'chip_core-keypair.json' : `${p}-keypair.json`}` : 'target/deploy/' + `${p === 'chip_core' ? 'chip_core-keypair.json' : `${p}-keypair.json`}`,
      keypairPresent: existsSync(resolve(root, from || 'target/deploy', p === 'chip_core' ? 'chip_core-keypair.json' : `${p}-keypair.json`)),
    })),
  };
}

function manifest(from: string): number {
  const out = resolve(root, FREEZE_RECORD);
  writeFileSync(out, JSON.stringify(freezeRecordDoc(from), null, 2) + '\n');
  console.log(`wrote ${out.replace(`${root}/`, '')}`);
  return 0;
}

// ---------------------------------------------------------------- guard-mainnet (SEC-F05)
/**
 * The gate's question is not "are these ids placeholders?" — that is unanswerable from the tree, and the
 * attempt to answer it is what broke this function. It is: **is there a frozen deploy set here?** The only
 * artifact that can say yes is the freeze record (`FREEZE_RECORD`), written by `manifest` from the cold
 * keypairs at the ceremony and committed with the deploy — the same file `scripts/deploy-build-env.ts`
 * calls "the authority for the ids".
 *
 * Why the previous shape could not work, recorded because the wrong fix is the tempting one: it compared
 * `[programs.mainnet]` against `PLACEHOLDER_IDS`, a hardcoded snapshot of the `GC…` ids that sat in
 * Anchor.toml at the freeze-base commit. But `apply` rewrites every copy of an id in one pass, so ids that
 * were never cut from a deploy keypair still agree with each other in all thirteen sites — a tree can be
 * internally consistent and have nothing to do with the deploy. When the ids were rotated to the present
 * `J68G8…` set, the comparison could no longer fire, and the gate printed "mainnet carries the frozen
 * non-placeholder ids (== declare_id!)" and exited 0 while `status` of this same script reported all four
 * ids `unverified` and the record did not exist. Two subcommands, opposite verdicts about one tree.
 *
 * Comparing mainnet against devnet/localnet would be the other wrong fix, and it is the one that looks
 * right: after the ceremony all three clusters deliberately share the frozen ids (one cold keypair signs
 * both — docs/09 §2, and `check` requires every cluster to equal `declare_id!`), so `mainnet == devnet` is
 * the healthy state. A gate that failed on it would never pass again.
 *
 * `mainnet == declare_id!` stays enforced here as before: on the images path this gate runs alone (no
 * `check`), and a hand-edited mainnet section would otherwise deploy somewhere the client never looks.
 *
 * The limit, stated so the gate is not mistaken for more than it is: keypairs are never committed, so on a
 * CI checkout there is nothing to re-derive the ids from — re-verifying them against the real keys is
 * `check --from DIR`, and it belongs to the ceremony, where the keys are. A fabricated record is a
 * deliberate lie, not an accident this gate can catch.
 */

/** What the gate reads out of `programs/program-ids.json`. */
export interface FreezeRecord { ids: Record<string, string>; keypairsPresent: Record<string, boolean> }

/** `absent` and `malformed` are separate answers on purpose: the first says the ceremony has not happened,
 * the second says somebody edited the record — and a reader that lumps them together teaches the operator
 * nothing about which of the two to fix. */
export type FreezeState = { kind: 'ok'; record: FreezeRecord } | { kind: 'absent' } | { kind: 'malformed' };

/**
 * The record's `programs` field is a *list* of `{ name, id, keypairPresent }` (see `freezeRecordDoc`), not
 * a map keyed by program name. Read as a map it yields `undefined` for every program, and a check whose
 * condition is never true is a comment — `scripts/deploy-build-env.ts` shipped exactly that. So the shape
 * is asserted here rather than tolerated: anything else is `null`, i.e. "no usable record".
 */
export function parseFreezeRecord(text: string): FreezeRecord | null {
  let doc: { programs?: unknown };
  try { doc = JSON.parse(text) as { programs?: unknown }; } catch { return null; }
  if (!Array.isArray(doc.programs)) return null;
  const ids: Record<string, string> = {};
  const keypairsPresent: Record<string, boolean> = {};
  for (const e of doc.programs as { name?: unknown; id?: unknown; keypairPresent?: unknown }[]) {
    if (typeof e?.name !== 'string' || typeof e?.id !== 'string') return null;
    ids[e.name] = e.id;
    keypairsPresent[e.name] = e.keypairPresent === true;
  }
  return { ids, keypairsPresent };
}

/** Every complaint the pre-deploy gate has about a tree, given the three things it reads. Returns the
 * problems instead of exiting so the refusals can be exercised without a tree that has them. */
export function guardProblems(input: { mainnet: Record<string, string>; declared: Record<string, string>; freeze: FreezeState }): string[] {
  const { mainnet, declared, freeze } = input;
  const problems: string[] = [];
  for (const p of PROGRAMS) {
    if (!mainnet[p]) { problems.push(`[programs.mainnet] has no ${p}`); continue; }
    if (mainnet[p] !== declared[p]) problems.push(`[programs.mainnet] ${p} = ${mainnet[p]} != declare_id! ${declared[p]} — mainnet must carry the frozen ids, nothing hand-edited (only \`apply\` rewrites ids).`);
  }

  if (freeze.kind === 'absent') {
    problems.push(`no freeze record (${FREEZE_RECORD}) — these ids are declarations, not a frozen deploy set: nothing in this tree says they were ever derived from the deploy keypairs, and every id copy agreeing with every other (which \`apply\` guarantees) proves nothing about the key that signs. Run the ceremony where the cold keypairs are — npm run program-ids -- new --out DIR, then \`apply --from DIR\`, then \`manifest --from DIR\` and commit the record (docs/09 §2, ops/deploy/runbook.md §1.1).`);
  } else if (freeze.kind === 'malformed') {
    problems.push(`${FREEZE_RECORD} exists but is not the record \`manifest\` writes — a hand-edited freeze record does not freeze anything, and every reader of it (this gate, scripts/deploy-build-env.ts) reads programs[] as the list of { name, id, keypairPresent } entries. Rewrite it with npm run program-ids -- manifest --from DIR.`);
  } else {
    for (const p of PROGRAMS) {
      if (freeze.record.ids[p] === undefined) problems.push(`${FREEZE_RECORD} has no entry for ${p} — it was written from a tree without it, or the program was renamed without re-freezing`);
      else if (freeze.record.ids[p] !== declared[p]) problems.push(`${FREEZE_RECORD} says ${p} = ${freeze.record.ids[p]}, declare_id! says ${declared[p]} — the ids moved after the freeze. Re-run the ceremony (\`apply --from DIR\`, then \`manifest --from DIR\`) and commit both halves together; do not hand-edit either side.`);
      if (!freeze.record.keypairsPresent[p]) problems.push(`${FREEZE_RECORD} records ${p} with keypairPresent: false — \`manifest\` ran where its deploy keypair was not, so the record attests an id and nothing at all about the key that signs it. Re-run \`manifest --from DIR\` in the ceremony directory.`);
    }
  }
  return problems;
}

function guardMainnet(): number {
  const mainnet = anchorIds('mainnet');
  const declared = declaredIds();
  const path = resolve(root, FREEZE_RECORD);
  const freeze: FreezeState = !existsSync(path) ? { kind: 'absent' }
    : (() => { const record = parseFreezeRecord(readFileSync(path, 'utf8')); return record ? { kind: 'ok', record } : { kind: 'malformed' }; })();

  const problems = guardProblems({ mainnet, declared, freeze });
  if (problems.length) {
    console.error('guard-mainnet FAILED:');
    for (const x of problems) console.error(`  - ${x}`);
    // What `status` can say about this tree, since that is the state the record is a substitute for. CI
    // never has a keypair (they are not committed, by design) — which is why the record, and not a keypair,
    // is the evidence this gate reads; where the keys do exist, `check --from DIR` is the stronger answer.
    const dirs = keypairDirs();
    const unverified = PROGRAMS.filter((p) => !dirs.some((d) => existsSync(keypairPath(resolve(root, d), p))));
    console.error(unverified.length
      ? `  note: \`program-ids status\` reports ${unverified.length}/${PROGRAMS.length} ids unverified — no keypair in ${dirs.join(' / ')} to check them against.`
      : `  note: keypairs are present in ${dirs.join(' / ')} — \`program-ids -- check --from DIR\` verifies the ids against them, and this gate reads the committed record, the only evidence that travels with the deploy.`);
    console.error('  reminder (SEC-F19): also verify the build features of the deploy artifact — mainnet must pin SB_PROGRAM_ID = SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv (no `localnet`/`devnet` feature).');
    return 1;
  }
  console.log(`guard-mainnet OK: [programs.mainnet] == declare_id!, and ${FREEZE_RECORD} freezes the same four ids with their keypairs present at freeze time.`);
  return 0;
}

function main(): number {
  switch (cmd) {
    case 'status': return status(false);
    case 'check': return status(true);
    case 'guard-mainnet': return guardMainnet();
    case 'new': return generate(arg('out') ?? join(homedir(), '.config/solana/guttercaps'));
    case 'apply': {
      const from = arg('from');
      if (!from) { console.error('apply needs --from DIR (the directory `new` wrote)'); return 1; }
      return apply(from, flag('dry-run'));
    }
    case 'manifest': return manifest(arg('from') ?? '');
    default:
      console.error(`usage: npm run program-ids -- [status|check|guard-mainnet|new|apply|manifest] [--out DIR] [--from DIR] [--dry-run]`);
      return 2;
  }
}

// Importable: tests/security/program-ids-guard.test.ts drives `guardProblems` and `parseFreezeRecord`
// directly, and a script that calls `process.exit` at import time cannot be imported at all.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main());
