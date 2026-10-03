// Node-entrypoint gate: **every file `package.json` asks bare `node` to run must be loadable by bare Node.**
//
// The failure this file exists for (2026-10-03, `scripts/mac-devnet.sh` stage `setup`): `scripts/setup.ts`
// took `COLLECTIONS` from `client/src/shared/lib/lore.ts`, the client's re-export of the canonical lore —
// and that file imports `@/shared/i18n`. `@/…` is a *Vite / tsconfig* alias: the bundler is told about it,
// vitest is told about it, plain Node is not. `npm run setup` runs `node --experimental-strip-types`, which
// resolves relative paths and node_modules and then stops, so the stage died with
//
//     Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@/shared' imported from …/client/src/shared/lib/lore.ts
//
// before a single instruction was built — on a machine that had already spent 13 500 s in `deploy`.
//
// Nothing had ever executed that path, which is the interesting half:
//   * the only job that runs the script is the nightly `e2e-devnet`, and it runs it as
//     `npm run setup || echo '::warning::setup dry-run failed (expected until G-0 keys exist)'`;
//   * `npm run verify` never loads the bare-Node scripts, and the *typecheck* that covers `scripts/**/*.ts`
//     uses the root tsconfig, whose `paths` map `@/*` — so the compiler was satisfied with an import the
//     runtime could never resolve.
//
// So this gate asks Node itself, and asks it about the whole static import graph, not just the first hop:
//
//   1. the entrypoints are read out of every workspace manifest and every `.github/workflows/*.yml` line
//      (`node <file>`, flags and all), not from a hand-kept list, so a new script is covered the moment it is
//      added — and the set is asserted in the second test, so a change in how it is parsed cannot silently
//      shrink what is checked;
//   2. resolution is done by Node in a child process with `--experimental-import-meta-resolve`. That flag is
//      not decoration: without it `import.meta.resolve(spec, parent)` **ignores `parent`** (measured on
//      v22.22.3) and resolves against the calling file, so a naive in-process version would check every
//      specifier against *this* file's directory and report a clean tree forever — the vacuous gate this
//      repository keeps deleting;
//   3. a repo file reached from such an entrypoint must be one Node can actually load: a `.ts`/`.js`-family
//      extension (not `.tsx` — the stripper has no JSX), erasable syntax only (an enum, a namespace,
//      `import x = require(…)` and a constructor parameter property all compile to runtime code, so
//      `--experimental-strip-types` refuses the file — `declare`/type-only constructs are erased and are
//      therefore fine), and not inside `client/src`, which is Vite's tree (aliases, CSS imports, JSX). That
//      last rule is the failing import stated as a property.
//
// Entrypoints that run under a *transpiling* loader (`node --import tsx …` — the backend's dozen scripts)
// are listed and skipped, not silently dropped: tsx *transpiles* what the stripper refuses and erases
// type-only imports, so the same graph has different rules there and one rule set would be either false
// alarms or quiet exemptions. Nothing is lost by that boundary, because the mistake this gate exists for is
// invisible to `tsc` only where the root tsconfig maps `@/*`: the backend's own `paths` map nothing, so its
// typecheck already rejects an alias it cannot resolve.
//
//   node --experimental-strip-types --no-warnings --test tests/security/*.test.ts   (npm run security:static)
//
// Deliberately *not* checked: whether the files run (a `setup` dry-run needs a wallet and an RPC), and
// specifiers computed at runtime (`await import(base + name)`) — counted, so the blind spot is visible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rel = (root: string, abs: string) => relative(root, abs).split(sep).join('/');

/** Extensions bare Node loads as modules. `.json` is deliberately absent: it needs an import attribute. */
const LOADABLE = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']);
/** Declaration files are types only — the stripper drops the import, so nothing is loaded at run time. */
const TYPES_ONLY = /\.d\.(ts|mts|cts)$/;
/** `--import tsx` and friends: transpilers, whose rules are not Node's (see the header). */
const LOADERS = ['tsx', 'ts-node', 'ts-node/esm', '@swc-node/register', 'esbuild-register', 'sucrase/register'];

export interface Problem { file: string; spec: string; why: string }
export interface Walk {
  /** abs path of a repo file whose imports were followed → the manifest script / workflow line that runs it */
  entrypoints: Map<string, string>;
  /** labels of entrypoints skipped because their runner transpiles (`node --import tsx …`) */
  skipped: string[];
  /** abs path of every repo file visited, including the entrypoints */
  files: string[];
  /** resolved file → the (file, specifier) that first reached it, so a failure can name the chain */
  via: Map<string, { from: string; spec: string }>;
  /** specifiers built at runtime: seen but not resolvable, reported so the blind spot stays a number */
  dynamic: number;
  problems: Problem[];
}

/** `["build", "&&", …]` — enough shell to find the arguments of a `node` call, not to run one. */
function shellWords(cmd: string): string[] {
  const out: string[] = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const isModuleFile = (s: string) => /\.(ts|mts|cts|js|mjs|cjs)$/.test(s);

/** `tests/security/*.test.ts` → the files that glob stands for (the only glob shape any script here uses). */
function expandGlob(path: string): string[] {
  if (!path.includes('*')) return [path];
  const dir = dirname(path);
  if (!existsSync(dir)) return [];
  const re = new RegExp(`^${basename(path).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  return readdirSync(dir).filter((f) => re.test(f)).map((f) => join(dir, f));
}

/** The files one `node …` command line runs (absolute; `dir` is the manifest's own directory, so
 *  `src/serve.ts` in backend/package.json is backend/src/serve.ts and not this repository's), or `null` when
 *  the runner is a transpiler / the code is inline. Positional arguments that are not module files
 *  (e.g. `target/cu-log.jsonl`) are ignored. */
function nodeRuns(words: string[], dir: string): { files: string[]; transpiled: boolean } | null {
  const at = words.indexOf('node');
  if (at < 0) return null;
  if (words.some((w) => w === '-e' || w === '--eval' || w.startsWith('--eval=') || w.startsWith('-e'))) return null;
  const files: string[] = [];
  let transpiled = false;
  for (let i = at + 1; i < words.length; i++) {
    const word = words[i];
    if (word === '--import' || word === '--loader' || word === '-r' || word === '--require') {
      if (LOADERS.includes(words[i + 1])) transpiled = true;
      i++;
      continue;
    }
    if (word.startsWith('--import=') || word.startsWith('--loader=')) { if (LOADERS.includes(word.split('=')[1])) transpiled = true; continue; }
    if (word.startsWith('-')) continue;
    for (const file of expandGlob(join(dir, word))) if (isModuleFile(file) && existsSync(file)) files.push(file);
  }
  return { files, transpiled };
}

/** Every entrypoint the tools that run this repository declare: workspace manifests + workflow `run:` lines. */
function entrypointsOf(root: string): { checked: Map<string, string>; skipped: string[] } {
  const checked = new Map<string, string>();
  const skipped: string[] = [];
  const add = (dir: string, label: string, words: string[]): void => {
    const runs = nodeRuns(words, dir);
    if (!runs) return;
    if (runs.transpiled) { if (runs.files.length > 0) skipped.push(label); return; }
    for (const file of runs.files) checked.set(realpathSync(file), label);
  };

  // manifests: the root package.json plus what its `workspaces` field points at
  const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { workspaces?: string[] };
  const dirs = ['.'];
  for (const pattern of rootPkg.workspaces ?? []) {
    if (!pattern.endsWith('/*')) { dirs.push(pattern); continue; }
    const glob = join(root, pattern.slice(0, -2)); // packages/*
    if (!existsSync(glob)) continue;
    dirs.push(...readdirSync(glob, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => `${pattern.slice(0, -2)}/${e.name}`));
  }
  for (const dir of dirs) {
    const manifest = join(root, dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const label = dir === '.' ? 'package.json' : `${dir}/package.json`;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { scripts?: Record<string, string> };
    for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) add(join(root, dir), `${label}#${name}`, shellWords(cmd));
  }

  // workflows: the second place a `node` command exists without a manifest behind it. Comments are skipped
  // (`#` to end of line, which is all of YAML's comment syntax these files use) so prose about a command
  // does not become an entrypoint that is not one.
  const workflows = join(root, '.github', 'workflows');
  for (const file of existsSync(workflows) ? readdirSync(workflows).filter((f) => f.endsWith('.yml')).sort() : []) {
    readFileSync(join(workflows, file), 'utf8').split('\n').forEach((line, i) => {
      const code = line.replace(/(^|\s)#.*$/, '$1');
      if (!/(^|\s)node(\s|$)/.test(code)) return;
      add(root, `${file}:${i + 1}`, shellWords(code));
    });
  }
  return { checked, skipped };
}

/**
 * Node's own resolver, once, over a batch of (specifier, parent) pairs. `parent` is the importer's URL and
 * *does* take effect here — this is the whole reason the check runs out of process (see the header).
 */
const RESOLVER = `
import { readFileSync } from 'node:fs';
const pairs = JSON.parse(readFileSync(0, 'utf8'));
const out = pairs.map(([spec, parent]) => {
  try { return { url: import.meta.resolve(spec, parent) }; }
  catch (e) { return { error: (e && e.code) || String((e && e.message) || e) }; }
});
process.stdout.write(JSON.stringify(out));
`;

function resolveBatch(pairs: [string, string][]): ({ url: string } | { error: string })[] {
  if (pairs.length === 0) return [];
  const proc = spawnSync(process.execPath, ['--no-warnings', '--experimental-import-meta-resolve', '--input-type=module', '-e', RESOLVER], {
    input: JSON.stringify(pairs), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(proc.status, 0, `the resolver child exited ${proc.status} — nothing was checked, which is not a pass:\n${proc.stderr?.trim()}`);
  return JSON.parse(proc.stdout) as ({ url: string } | { error: string })[];
}

/**
 * Static module specifiers, read from the real syntax tree: a specifier inside a comment, a string or a
 * template literal is not one, and `import type` is skipped — the stripper deletes it, so a type-only import
 * of a module that is not even installed (the backend has one) is not a failure. Runtime specifiers are
 * counted instead, so the part that cannot be resolved statically is a number rather than a silence.
 */
function specifiersOf(sf: ts.SourceFile, counters: { dynamic: number }): { spec: string; typeOnly: boolean }[] {
  const out: { spec: string; typeOnly: boolean }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      out.push({ spec: node.moduleSpecifier.text, typeOnly: node.importClause?.isTypeOnly === true });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      out.push({ spec: node.moduleSpecifier.text, typeOnly: node.isTypeOnly });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) out.push({ spec: node.arguments[0].text, typeOnly: false });
      else counters.dynamic++;
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      if (node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) out.push({ spec: node.arguments[0].text, typeOnly: false });
      else counters.dynamic++;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * Syntax Node's stripper refuses: an enum, a namespace, `import x = require(…)` and a constructor parameter
 * property all compile to runtime code, so `--experimental-strip-types` errors on the file instead of
 * guessing — the same class of "works in tsc/vitest, dies under bare Node" as the alias above. Everything
 * under a `declare` (or `declare global`) is ambient, is erased, and is therefore not this gate's business.
 */
function nonErasable(file: string, sf: ts.SourceFile): string[] {
  if (!/\.(ts|mts|cts)$/.test(file) || TYPES_ONLY.test(file)) return [];
  const at = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const out: string[] = [];
  const visit = (node: ts.Node, ambient: boolean): void => {
    const declared = ambient
      || (node.flags & ts.NodeFlags.Ambient) !== 0
      || (ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DeclareKeyword));
    if (!declared) {
      if (ts.isEnumDeclaration(node)) out.push(`enum ${node.name.getText(sf)} (line ${at(node)})`);
      else if (ts.isModuleDeclaration(node)) out.push(`namespace ${node.name.getText(sf)} (line ${at(node)})`);
      else if (ts.isImportEqualsDeclaration(node)) out.push(`import ${node.name.text} = (line ${at(node)})`);
      else if (ts.isConstructorDeclaration(node)) {
        for (const p of node.parameters) {
          if (ts.getCombinedModifierFlags(p) & ts.ModifierFlags.ParameterPropertyModifier) out.push(`parameter property ${p.name.getText(sf)} (line ${at(p)})`);
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, declared));
  };
  visit(sf, false);
  return out;
}

const parse = (file: string, src: string) => ts.createSourceFile(file, src, ts.ScriptTarget.Latest, /* setParentNodes */ false);

/** Breadth-first over the static import graph, one `node` resolution batch per level. */
export function walkGraph(root: string, entrypoints: Map<string, string>, skipped: string[] = []): Walk {
  const via = new Map<string, { from: string; spec: string }>();
  const files: string[] = [];
  const problems: Problem[] = [];
  const counters = { dynamic: 0 };
  const seen = new Set(entrypoints.keys());
  let level = [...entrypoints.keys()];
  while (level.length > 0) {
    const pairs: [string, string][] = [];
    const meta: { file: string; spec: string }[] = [];
    for (const file of level) {
      files.push(file);
      const src = readFileSync(file, 'utf8');
      const sf = parse(file, src);
      for (const bad of nonErasable(file, sf)) problems.push({ file, spec: bad, why: 'not erasable: `node --experimental-strip-types` refuses the file' });
      for (const { spec, typeOnly } of specifiersOf(sf, counters)) {
        if (typeOnly || spec.startsWith('node:')) continue;
        pairs.push([spec, pathToFileURL(file).href]);
        meta.push({ file, spec });
      }
    }
    const next: string[] = [];
    resolveBatch(pairs).forEach((res, i) => {
      const { file, spec } = meta[i];
      if ('error' in res) { problems.push({ file, spec, why: res.error }); return; }
      const url = new URL(res.url);
      if (url.protocol !== 'file:') return;                        // a scheme Node handles itself (data:, node:)
      const path = fileURLToPath(url);
      if (path.split(sep).includes('node_modules')) return;        // a dependency: its own business, not walked
      if (!existsSync(path)) { problems.push({ file, spec, why: `resolves to ${path}, which does not exist` }); return; }
      if (TYPES_ONLY.test(path)) return;                           // types only: dropped before anything runs
      const abs = realpathSync(path);
      const ext = /\.([a-z]+)$/i.exec(path)?.[0] ?? '';
      if (!LOADABLE.has(ext)) { problems.push({ file, spec, why: `Node does not load ${ext} — a bundler-only import` }); return; }
      if (abs.startsWith(join(root, 'client', 'src') + sep)) {
        problems.push({ file, spec, why: 'the client tree is Vite\'s (aliases, CSS, JSX) — move what is shared into packages/ so Node can load it' });
        return;
      }
      if (abs.startsWith(root + sep) && !seen.has(abs)) { via.set(abs, { from: file, spec }); seen.add(abs); next.push(abs); }
    });
    level = next;
  }
  return { entrypoints, skipped, files, via, dynamic: counters.dynamic, problems };
}

/** The chain from an entrypoint down to the file that owns the failing specifier. */
function chain(walk: Walk, file: string): string[] {
  const out = [file];
  for (let cur = file; walk.via.has(cur);) {
    cur = walk.via.get(cur)!.from;
    out.push(cur);
  }
  return out.reverse();
}

function report(root: string, walk: Walk): string {
  return walk.problems.map((p) => {
    const hops = chain(walk, p.file);
    return `  ${walk.entrypoints.get(hops[0]) ?? '(entrypoint)'}\n    ${hops.map((f) => rel(root, f)).join(' → ')}\n      '${p.spec}' — ${p.why}`;
  }).join('\n');
}

const walkRepo = (): Walk => {
  const { checked, skipped } = entrypointsOf(REPO);
  return walkGraph(REPO, checked, skipped);
};

// ---------------------------------------------------------------- 1. the rule
test('every bare-node entrypoint resolves and loads under Node itself', () => {
  const walk = walkRepo();
  assert.equal(walk.problems.length, 0,
    `${walk.problems.length} module${walk.problems.length === 1 ? '' : 's'} in the graph of a \`node\` entrypoint cannot be resolved or loaded by Node itself.\n` +
    `Either import it the way Node resolves (a relative path or a node_modules package) or move the shared code out of the\n` +
    `bundler's reach (packages/…, not client/src) — \`npm run setup\` and the \`setup\` stage of scripts/mac-devnet.sh run these\n` +
    `scripts with no bundler anywhere in the process:\n\n${report(REPO, walk)}`);
});

// ---------------------------------------------------------------- 2. the gate has to be able to fail
test('the entrypoint set and the graph it covers are what they claim to be', () => {
  const walk = walkRepo();
  const label = (p: string) => walk.entrypoints.get(join(REPO, p));
  // one representative per runner shape the parser has to recognise: bare node, --experimental-strip-types,
  // node --test with a glob, an .mjs script, a workspace manifest, and a workflow `run:` line
  for (const [file, want] of [
    ['scripts/setup.ts', 'package.json#setup'],
    ['scripts/skr-pool.ts', 'package.json#skr-pool'],
    ['scripts/create-lut.ts', 'package.json#create-lut'],
    ['scripts/verify-deploy.ts', 'package.json#verify-deploy'],
    ['tests/security/node-entrypoints.test.ts', 'package.json#security:static'],
    ['tests/legal/release.test.mjs', 'package.json#legal:test'],
    ['scripts/restore-drill.mjs', 'package.json#ops:restore-drill'],
    ['packages/economy/scripts/report.ts', 'packages/economy/package.json#check'],
  ] as const) {
    assert.equal(label(file), want, `${file} is missing from the entrypoint set (${label(file) ?? 'absent'}) — the gate is checking less than it says`);
  }
  assert.ok(walk.files.length >= 60, `only ${walk.files.length} files were walked; the graph is expected to be much larger, so this check is close to vacuous`);
  // resolution really followed imports — in both of the ways it has to: a relative one (a security test's
  // `./lib/rust-scan.ts`) and a bare one through the workspace symlink (`@guttercaps/economy`, which lands in
  // packages/economy/src/index.ts). Without these two, "nothing failed" is indistinguishable from "nothing
  // was followed", which is how a resolution gate turns into a comment.
  assert.ok(walk.via.has(join(REPO, 'tests/security/lib/rust-scan.ts')), 'the relative import of tests/security/lib/rust-scan.ts was not followed');
  assert.ok(walk.via.has(join(REPO, 'packages/economy/src/index.ts')), 'the bare import of @guttercaps/economy was not followed into the workspace');
  assert.ok(walk.files.filter((f) => walk.via.has(f)).length >= 10, `only ${walk.files.filter((f) => walk.via.has(f)).length} files were reached through an import — resolution is not following the graph`);
  // the transpiled-runner boundary is stated, not silently assumed away. The backend's scripts are the
  // reason it exists (`tsx` transpiles what the stripper refuses), and they must still be *listed*.
  assert.ok(walk.skipped.includes('backend/package.json#serve'), `the tsx-run backend entrypoints were dropped without being listed: ${JSON.stringify(walk.skipped)}`);
  // no specifier is built at runtime today. If one appears, the static graph is no longer the whole story and
  // this file's header has to say so — the counter exists so that cannot happen in silence.
  assert.equal(walk.dynamic, 0, `${walk.dynamic} specifier(s) in the graph are computed at runtime: they are not checked, so name them in the header of this file`);
});

// ---------------------------------------------------------------- 3. mutations: each rule, on a fixture
/** One fixture tree, every rule fired at least once — and two that must stay quiet. */
test('each rule fires on a fixture — the gate is not decoration', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'node-entrypoints-'));
  const write = (p: string, body: string) => { mkdirSync(dirname(join(tmp, p)), { recursive: true }); writeFileSync(join(tmp, p), body); };
  try {
    // the historical failure, verbatim: a loadable file importing a Vite alias
    write('alias.ts', `import { t } from '@/shared/i18n';\nexport const x = t;\n`);
    // a bare specifier that only the importer's own node_modules can satisfy: if the resolver child ignored
    // `parent` this would look for `fixture-pkg` next to the *test process* instead of here
    write('pkg-root.ts', `import 'fixture-pkg';\n`);
    write('node_modules/fixture-pkg/package.json', `{ "name": "fixture-pkg", "main": "index.js" }\n`);
    write('node_modules/fixture-pkg/index.js', `export const ok = true;\n`);
    // syntax the stripper refuses, and a file a bundler would resolve but Node cannot load
    write('tsx-root.ts', `import './view.tsx';\n`);
    write('view.tsx', `export const View = () => null;\n`);
    write('enum-root.ts', `export enum Tier { Common }\n`);
    write('param-root.ts', `export class Client { constructor(private readonly url: string) {} }\n`);
    write('missing-root.ts', `import './gone.ts';\n`);
    write('client/src/ui/theme.ts', `export const theme = 'dark';\n`);
    write('client-root.ts', `import { theme } from './client/src/ui/theme.ts';\nexport const z = theme;\n`);
    // …and the three that must NOT fire: a commented-out import, one inside a string, and the two things
    // the stripper erases — a type-only import of a module that is not installed, and a `declare` block
    write('quiet.ts', `// import '@/commented-out';\nconst note = "import '@/inside-a-string';";\nexport const y = note;\n`);
    write('erased.ts', `import type { T } from '@nope/type-only';\ndeclare global { namespace Global { const x: number; } }\ndeclare enum Ambient { A }\nexport type Z = T;\n`);

    const labels: [string, string][] = [
      ['alias.ts', 'fixture#alias'], ['pkg-root.ts', 'fixture#pkg'], ['tsx-root.ts', 'fixture#tsx'],
      ['enum-root.ts', 'fixture#enum'], ['param-root.ts', 'fixture#param'], ['missing-root.ts', 'fixture#missing'],
      ['client-root.ts', 'fixture#client'], ['quiet.ts', 'fixture#quiet'], ['erased.ts', 'fixture#erased'],
    ];
    const walk = walkGraph(tmp, new Map(labels.map(([f, l]) => [realpathSync(join(tmp, f)), l])));
    const why = (f: string) => walk.problems.filter((p) => rel(tmp, p.file) === f).map((p) => p.why).join(' | ');
    const context = (): string => report(tmp, walk);

    assert.match(why('alias.ts'), /ERR_MODULE_NOT_FOUND/, `the alias rule did not fire:\n${context()}`);
    assert.equal(why('pkg-root.ts'), '', `a node_modules package the importer can reach must resolve:\n${context()}`);
    assert.match(why('tsx-root.ts'), /Node does not load \.tsx/, 'the TSX rule did not fire');
    assert.match(why('enum-root.ts'), /not erasable/, 'the enum rule did not fire');
    assert.match(why('param-root.ts'), /not erasable/, 'the parameter-property rule did not fire');
    assert.match(why('missing-root.ts'), /does not exist/, 'the missing-file rule did not fire');
    assert.match(why('client-root.ts'), /the client tree is Vite's/, 'the client-tree rule did not fire');
    assert.equal(why('quiet.ts'), '', `a specifier in a comment or a string is not an import:\n${context()}`);
    assert.equal(why('erased.ts'), '', `type-only imports and \`declare\` blocks are erased by the stripper:\n${context()}`);
    // the fixture tree is small, so this also pins that the walk *entered* the fixture files rather than
    // reporting on the entrypoints alone
    assert.ok(walk.files.length >= labels.length, `only ${walk.files.length} fixture files were walked`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
