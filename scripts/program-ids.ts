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
//   npm run program-ids -- guard-mainnet    # exit 1 while [programs.mainnet] == devnet/localnet placeholders (SEC-F05)
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
import { Keypair, PublicKey } from '@solana/web3.js';

const root = resolve(import.meta.dirname, '..');
const PROGRAMS = ['chip_core', 'market', 'staking', 'arena'] as const;
type ProgramName = (typeof PROGRAMS)[number];

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
  const dirs = [arg('from') ?? '', 'tests/localnet/fixtures', 'target/deploy'].filter(Boolean);
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
  if (existsSync(resolve(root, 'programs/program-ids.json'))) console.log('\nmanifest: programs/program-ids.json (freeze record — commit it with the deploy)');
  else console.log('\nmanifest: programs/program-ids.json not written yet (do it at the freeze commit, ops/deploy/runbook.md §1.1)');

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

function manifest(from: string): number {
  const declared = declaredIds();
  const doc = {
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
  const out = resolve(root, 'programs/program-ids.json');
  writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
  console.log(`wrote ${out.replace(`${root}/`, '')}`);
  return 0;
}

// ---------------------------------------------------------------- guard-mainnet (SEC-F05)
// The pre-ceremony dev-derived ids (Anchor.toml at the freeze-base commit). The gate compares mainnet
// against THESE VALUES, not against devnet — post-ceremony devnet carries the real ids too. Do not
// "update" this set: after the ceremony it is inert by construction (real ids never equal placeholders).
const PLACEHOLDER_IDS: Record<ProgramName, string> = {
  chip_core: 'GCRhrg6mc7zH1VdXG5rX3tQEpgu8Gptf27vdsJGV7G8q',
  market: 'GCA2aUeX7ZFbGz3zvjqvsbjD1G3QjWxLhBpK5jwwPdcz',
  staking: 'GCuGx7fnLcKnw1NWU4dLzQvnJWggMVniQ4u7EuMaQevA',
  arena: 'GCfERiohebYDJLtNwAZpGxudwbXRqnxmuTT413fkTYrM',
};
/** Fail while [programs.mainnet] still carries the pre-ceremony placeholder ids (SEC-F05). This is the
 * pre-deploy gate: images.yml calls it before any mainnet-beta image is produced, so the
 * "REGENERATE THE IDS BEFORE MAINNET" comment in Anchor.toml stops being the only line of defence.
 * It compares against the placeholder SET, not against devnet/localnet: post-ceremony all three
 * clusters deliberately share the frozen ids (one cold keypair signs both — docs/09 §2, and `check`
 * requires every cluster to equal declare_id!), so mainnet==devnet is the healthy state, not the alarm.
 * mainnet==declare_id! is also enforced here: on the images path this gate runs alone (no `check`),
 * and a hand-edited mainnet section would otherwise deploy somewhere the client never looks. */
function guardMainnet(): number {
  const mainnet = anchorIds('mainnet');
  const declared = declaredIds();
  const problems: string[] = [];
  for (const p of PROGRAMS) {
    if (!mainnet[p]) { problems.push(`[programs.mainnet] has no ${p}`); continue; }
    if (mainnet[p] === PLACEHOLDER_IDS[p]) problems.push(`[programs.mainnet] ${p} is still the placeholder (${mainnet[p]}) — run the id ceremony (docs/09 §2): npm run program-ids -- new --out DIR, then \`apply --from DIR\`, then this gate again.`);
    else if (mainnet[p] !== declared[p]) problems.push(`[programs.mainnet] ${p} = ${mainnet[p]} != declare_id! ${declared[p]} — mainnet must carry the frozen ids, nothing hand-edited (only \`apply\` rewrites ids).`);
  }
  if (problems.length) {
    console.error('guard-mainnet FAILED:');
    for (const x of problems) console.error(`  - ${x}`);
    console.error('  reminder (SEC-F19): also verify the build features of the deploy artifact — mainnet must pin SB_PROGRAM_ID = SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv (no `localnet`/`devnet` feature).');
    return 1;
  }
  console.log('guard-mainnet OK: mainnet carries the frozen non-placeholder ids (== declare_id!).');
  return 0;
}

switch (cmd) {
  case 'status': process.exit(status(false));
  case 'check': process.exit(status(true));
  case 'guard-mainnet': process.exit(guardMainnet());
  case 'new': process.exit(generate(arg('out') ?? join(homedir(), '.config/solana/guttercaps')));
  case 'apply': {
    const from = arg('from');
    if (!from) { console.error('apply needs --from DIR (the directory `new` wrote)'); process.exit(1); }
    process.exit(apply(from, flag('dry-run')));
  }
  case 'manifest': process.exit(manifest(arg('from') ?? ''));
  default:
    console.error(`usage: npm run program-ids -- [status|check|guard-mainnet|new|apply|manifest] [--out DIR] [--from DIR] [--dry-run]`);
    process.exit(2);
}
