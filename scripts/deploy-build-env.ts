// Assembles and validates the env file that `docker compose build` needs to produce the deploy images
// (ops/deploy/runbook.md §1.2, docs/09 §4.1 «images»).
//
// Why a script and not ten `--build-arg` flags in the workflow: the list of required build values lives in
// `ops/deploy/docker-compose.yaml` (that is where a `${VAR:?}` is decided), and the CI that builds images
// must not keep its own copy of it. A workflow that hardcodes the args drifts the moment someone adds one,
// and it drifts *silently* — the image still builds, with the value it had yesterday. Reading the compose
// file is what turns «add a required build arg» into «CI stops being able to build» instead of «prod ships
// with the id that was in the file last week».
//
// What it also does, and the reason it is not a two-line cat: it fails here, in a second, with every
// problem listed, instead of failing four minutes into a docker layer. `Dockerfile.client` has the same
// guard *inside* the build (so nobody can skip it); this is the fast path in front of it, plus one check a
// Dockerfile cannot make: the freeze record in `programs/program-ids.json`, if it exists, is the authority
// for the ids — a published image may not be built from ids that predate the deploy keypairs.
//
// That authority is only as good as the reader. The record is written by `npm run program-ids -- manifest`
// as `programs[]` — a *list* of `{ name, id, keypairPresent }` — and this file used to read it as
// `(…).programs ?? {}`, i.e. as a map keyed by program: `array['chip_core']` is `undefined`, so every
// comparison below was against `undefined` and the check reported nothing for any record ever written.
// `freezeIds` asserts the shape and the caller turns a record it cannot read into a problem, because a
// gate whose condition is never true is a comment.
//
//   npm run ops:buildenv -- --check                                    # validate, print only problems
//   npm run ops:buildenv -- --out /tmp/build.env                       # write it (compose --env-file format)
//   npm run ops:buildenv -- --from ci-vars.env --out /tmp/build.env     # + an overlay (CI repo variables)
//   npm run ops:buildenv -- --selftest                                  # inline cases (run by npm run verify)
//
// Precedence: `ops/deploy/.env.example` (documented defaults) < --from file < process.env. Writing the file
// back is intentionally dumb: KEY=VALUE, no quotes, values verbatim — compose does the interpolation, and a
// quoted value would reach the Dockerfile with the quotes in it.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const COMPOSE = 'ops/deploy/docker-compose.yaml';
const EXAMPLE = 'ops/deploy/.env.example';
const FREEZE = 'programs/program-ids.json';
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** base58 excludes 0 O I l — a shape check catches the address that went through a chat app. */
const ID_LIKE = ['CG_MINT', 'USDC_MINT', 'SKR_MINT', 'PROGRAM_CHIP_CORE', 'PROGRAM_MARKET', 'PROGRAM_STAKING', 'PROGRAM_ARENA'];
const PLACEHOLDER_HINTS = ['replace', 'changeme', 'change_me', 'your-', 'todo', 'xxxx'];
const CLUSTERS = ['mainnet-beta', 'devnet', 'localnet'];

// --------------------------------------------------------------------------- sources

/**
 * Every `${VAR:?}` / `${VAR:-default}` in every service's `build.args:` block. `:?` means the build cannot
 * happen without it; `:-` means compose already says what to use, so unset is not a problem.
 */
export function requiredArgs(composeText: string): { name: string; required: boolean; default?: string }[] {
  const out: { name: string; required: boolean; default?: string }[] = [];
  const seen = new Set<string>();
  let inArgs = false;
  for (const line of composeText.split('\n')) {
    if (/^\s*args:\s*$/.test(line)) { inArgs = true; continue; }
    // a comment does not end the block — the real compose file opens `args:` with an explanatory line, and
    // treating it as the terminator silently parsed zero args, i.e. validated nothing (the last case below
    // is what caught it)
    if (inArgs && /^\s*(#|$)/.test(line)) continue;
    // the block ends at the first line that is not another `        NAME: value` entry
    if (inArgs && !/^\s{8}[A-Z][A-Z0-9_]*:\s*\S/.test(line)) inArgs = false;
    if (!inArgs) continue;
    const m = /^\s{8}([A-Z][A-Z0-9_]*):\s*(\S.*)$/.exec(line);
    if (!m) continue;
    const [, , rawValue] = m;
    const interp = /^\$\{([A-Z][A-Z0-9_]+)([^}]*)\}$/.exec(rawValue.trim());
    if (!interp) continue; // a literal (`VITE_API_BASE: /`) — there is nothing for anyone to supply
    const name = interp[1];
    const mod = interp[2];
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, required: mod.startsWith(':?'), default: mod.startsWith(':-') ? mod.slice(2) || undefined : undefined });
  }
  return out;
}

/** `KEY=value` lines of a dotenv file; comments and blank lines ignored, `export ` tolerated. */
export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line.replace(/\r$/, ''));
    if (!m) continue;
    out.set(m[1], m[2].trim().replace(/^(['"])(.*)\1$/, '$2'));
  }
  return out;
}

/** The dev defaults baked into the client (`pk(env.VITE_X, '<id>')`) — what a mainnet image must not carry. */
export function devDefaults(clientConfigText: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of clientConfigText.matchAll(/VITE_([A-Z_]+?),\s*'([1-9A-HJ-NP-Za-km-z]{32,44})'/g)) out.set(m[1], m[2]);
  return out;
}

/**
 * The freeze record's ids, keyed by program — the *shape* is the whole point. `manifest`
 * (scripts/program-ids.ts:freezeRecordDoc) writes `programs` as a list of `{ name, id, keypairPresent }`;
 * read as a map that list answers `undefined` to every question, which is how this check came to compare
 * nothing against nothing and pass. A record this function cannot read is `null`, and the caller reports
 * it: "the authority exists but says nothing" is a problem, not a skip.
 */
export function freezeIds(text: string): Record<string, string> | null {
  let doc: { programs?: unknown };
  try { doc = JSON.parse(text) as { programs?: unknown }; } catch { return null; }
  if (!Array.isArray(doc.programs)) return null;
  const ids: Record<string, string> = {};
  for (const e of doc.programs as { name?: unknown; id?: unknown; keypairPresent?: unknown }[]) {
    if (typeof e?.name !== 'string' || typeof e.id !== 'string') return null;
    ids[e.name] = e.id;
  }
  return Object.keys(ids).length ? ids : null;
}

// --------------------------------------------------------------------------- assembly

export interface Result { values: Map<string, string>; problems: string[] }

export function buildEnv(opts: {
  composeText: string;
  exampleText: string;
  overlay?: string;
  env?: Record<string, string | undefined>;
  clientConfigText?: string;
  /** the *contents* of `programs/program-ids.json` — null when the file does not exist. Passed as text, not
   * as a parsed map, so the reader and the writer cannot disagree about the shape without failing a case
   * here (`freezeIds`). */
  freezeText?: string | null;
  cluster?: string;
}): Result {
  const args = requiredArgs(opts.composeText);
  const fromExample = parseEnv(opts.exampleText);
  const fromOverlay = opts.overlay ? parseEnv(opts.overlay) : new Map<string, string>();
  const fromEnv = opts.env ?? process.env;

  const values = new Map<string, string>();
  for (const { name } of args) {
    const v = fromEnv[name] ?? fromOverlay.get(name) ?? fromExample.get(name) ?? '';
    if (v) values.set(name, v);
  }
  // The Dockerfile reads VITE_*, compose maps the un-prefixed names onto them; the output carries both, so
  // the same file works as `docker compose --env-file` and as the env of a bare `docker build`.
  for (const [k, v] of [...values]) if (!k.startsWith('VITE_')) values.set(`VITE_${k}`, v);

  const problems: string[] = [];
  const cluster = opts.cluster ?? values.get('VITE_CLUSTER') ?? 'mainnet-beta';
  if (!CLUSTERS.includes(cluster)) problems.push(`VITE_CLUSTER: "${cluster}" is not one of ${CLUSTERS.join(' | ')}`);
  const dev = opts.clientConfigText ? devDefaults(opts.clientConfigText) : new Map<string, string>();

  for (const { name, required } of args) {
    const v = values.get(name) ?? '';
    if (!v) {
      if (required) problems.push(`${name}: required by a build.args ":?" in ${COMPOSE}, and empty in ${EXAMPLE}, --from and the environment`);
      continue;
    }
    if (ID_LIKE.includes(name) && !B58.test(v)) problems.push(`${name}: "${v}" is not a base58 public key (32–44 chars, no 0 O I l)`);
    if (ID_LIKE.includes(name) && PLACEHOLDER_HINTS.some((h) => v.toLowerCase().includes(h))) problems.push(`${name}: "${v}" reads like a placeholder, not a value`);
    if (v.includes('${')) problems.push(`${name}: contains "\${" — a value has to be resolved, not another interpolation`);
  }

  const rpc = values.get('VITE_SOLANA_RPC') ?? '';
  if (rpc) {
    let url: URL | null = null;
    try { url = new URL(rpc); } catch { url = null; }
    if (!url) problems.push(`VITE_SOLANA_RPC: "${rpc}" is not a URL`);
    else {
      if (url.protocol !== 'https:' && cluster === 'mainnet-beta') problems.push(`VITE_SOLANA_RPC: ${url.protocol}// — a page served over https will refuse it (mixed content), and the app will look like a dead wallet provider`);
      if (url.username) problems.push('VITE_SOLANA_RPC: credentials in the URL ship inside a public JS bundle');
      if (/(localhost|127\.0\.0\.1|0\.0\.0\.0)/.test(url.hostname) && cluster === 'mainnet-beta') problems.push('VITE_SOLANA_RPC: a mainnet bundle cannot reach the build machine\'s localhost');
      const hint = PLACEHOLDER_HINTS.find((h) => rpc.toLowerCase().includes(h));
      if (hint) problems.push(`VITE_SOLANA_RPC: contains "${hint}" — an unedited placeholder RPC is a bundle that works for nobody (and the UI will blame the wallet)`);
    }
  }

  // A mainnet image built with the repo's dev ids is the mistake this file exists to prevent: the app
  // works, the wallet signs, and every transaction fails with an error the UI cannot explain.
  if (cluster === 'mainnet-beta' && dev.size) {
    for (const [key, id] of dev) {
      const use = values.get(key) ?? values.get(`VITE_${key}`);
      if (use && use === id) problems.push(`${key}: equals the dev placeholder baked into client/src/app/config.ts — apply the freeze (ops/deploy/runbook.md §1.1) before a mainnet image is published`);
    }
  }
  if (opts.freezeText !== undefined && opts.freezeText !== null) {
    const named: Record<string, string> = { chip_core: 'PROGRAM_CHIP_CORE', market: 'PROGRAM_MARKET', staking: 'PROGRAM_STAKING', arena: 'PROGRAM_ARENA' };
    const frozen = freezeIds(opts.freezeText);
    if (!frozen) problems.push(`${FREEZE}: exists but is not the record \`npm run program-ids -- manifest\` writes (\`programs[]\` as a list of { name, id, keypairPresent }) — the ids below cannot be checked against it, and an unreadable authority is refused rather than skipped`);
    else for (const [program, varName] of Object.entries(named)) {
      const want = frozen[program];
      const got = values.get(varName);
      if (!want) problems.push(`${FREEZE}: no entry for ${program} — the record has to speak for all four (rewrite it with \`npm run program-ids -- manifest --from DIR\`)`);
      else if (got && want !== got) problems.push(`${varName}: "${got}" disagrees with the freeze record ${FREEZE} ("${want}") for ${program}`);
    }
  }
  return { values, problems };
}

export function render(values: Map<string, string>): string {
  const lines = ['# generated by `npm run ops:buildenv` — what compose interpolates at image build time. Do not edit by hand.'];
  for (const [k, v] of [...values].sort()) lines.push(`${k}=${v}`);
  return lines.join('\n') + '\n';
}

// --------------------------------------------------------------------------- selftest

const A = 'GCRhrg6mc7zH1VdXG5rX3tQEpgu8Gptf27vdsJGV7G8q';
const B = '9h6NnH5vXQuXNUXYUUJHRnPmtZvQaEwPLwrz1VFGm2Ri';
const C = 'H6VJmGpXfLr1i1wTt7s5d5e2n8p4r6t8v2w2y4a6c8e1';
const FIXTURE_COMPOSE = `services:
  client:
    build:
      args:
        VITE_CLUSTER: \${VITE_CLUSTER:-mainnet-beta}
        VITE_SOLANA_RPC: \${VITE_SOLANA_RPC:?client build needs a mainnet RPC URL}
        VITE_API_BASE: /
        VITE_WS_BASE: /ws
        VITE_PROGRAM_CHIP_CORE: \${PROGRAM_CHIP_CORE:?}
        VITE_PROGRAM_MARKET: \${PROGRAM_MARKET:?}
        VITE_CG_MINT: \${CG_MINT:?}
        VITE_LOOKUP_TABLE: \${LOOKUP_TABLE:-}
        VITE_TURNSTILE_SITE_KEY: \${TURNSTILE_SITE_KEY:-}
    restart: unless-stopped
  api:
    image: guttercaps/api:local
`;
/** one program carries a dev default, the way `pk(env.X, '…')` does in the real config */
const FIXTURE_CLIENT = `export const PROGRAMS = { chipCore: pk(env.VITE_PROGRAM_CHIP_CORE, '${A}') };`;
/** `programs/program-ids.json` as `npm run program-ids -- manifest` writes it: `programs[]` is a list. */
const record = (ids: Record<string, string>) =>
  JSON.stringify({ programs: Object.entries(ids).map(([name, id]) => ({ name, id, keypairPresent: true })) });
const RPCS = 'https://mainnet.helius-rpc.com/?api-key=0123456789abcdef';

type Env = Record<string, string | undefined>;
const FULL: Env = {
  VITE_CLUSTER: 'mainnet-beta', VITE_SOLANA_RPC: RPCS, PROGRAM_CHIP_CORE: B, PROGRAM_MARKET: C, CG_MINT: B,
};

const cases: { name: string; run: () => string[] }[] = [
  {
    name: 'a required build arg with no value anywhere is named, and only it',
    run: () => {
      // `undefined` and not deletion: the lookup must fall through the whole chain for an unset name
      const r = buildEnv({ composeText: FIXTURE_COMPOSE, exampleText: '', env: { ...FULL, PROGRAM_MARKET: undefined }, clientConfigText: FIXTURE_CLIENT });
      return [...expectProblem(r.problems, 'PROGRAM_MARKET', 'required by'), ...r.problems.filter((p) => !p.includes('PROGRAM_MARKET')).map((p) => 'unexpected problem: ' + p)];
    },
  },
  {
    name: 'an arg with a compose default is not required',
    run: () => expectNoProblem(buildEnv({ composeText: FIXTURE_COMPOSE, exampleText: '', env: FULL, clientConfigText: FIXTURE_CLIENT }).problems, 'LOOKUP_TABLE'),
  },
  {
    name: 'a literal build arg (VITE_API_BASE) is never asked of anyone',
    run: () => {
      const names = requiredArgs(FIXTURE_COMPOSE).map((a) => a.name);
      return names.includes('VITE_API_BASE') ? ['VITE_API_BASE: / is a literal, and the script demanded it'] : [];
    },
  },
  {
    name: '--from overrides the example, the environment overrides --from',
    run: () => {
      const ex = buildEnv({ composeText: FIXTURE_COMPOSE, exampleText: `PROGRAM_CHIP_CORE=${A}\nVITE_CLUSTER=devnet`, overlay: `PROGRAM_CHIP_CORE=${B}`, env: {} });
      const envWins = buildEnv({ composeText: FIXTURE_COMPOSE, exampleText: `PROGRAM_CHIP_CORE=${A}`, overlay: `PROGRAM_CHIP_CORE=${B}`, env: { PROGRAM_CHIP_CORE: C, VITE_CLUSTER: 'devnet' } });
      return [...(ex.values.get('PROGRAM_CHIP_CORE') === B ? [] : ['--from did not beat the example']),
        ...(envWins.values.get('PROGRAM_CHIP_CORE') === C ? [] : ['the environment did not beat --from'])];
    },
  },
  {
    name: 'a malformed id is rejected, a well-formed one is not',
    run: () => {
      const bad = buildEnv({ composeText: FIXTURE_COMPOSE, exampleText: '', env: { ...FULL, VITE_CLUSTER: 'devnet', PROGRAM_CHIP_CORE: 'GCRhrg!!' }, clientConfigText: FIXTURE_CLIENT }).problems;
      const good = buildEnv({ composeText: FIXTURE_COMPOSE, exampleText: '', env: { ...FULL, VITE_CLUSTER: 'devnet' }, clientConfigText: FIXTURE_CLIENT }).problems;
      return [...expectProblem(bad, 'PROGRAM_CHIP_CORE', 'base58'), ...(good.length ? ['a well-formed id was rejected: ' + good[0]] : [])];
    },
  },
  {
    name: 'the dev placeholder fails a mainnet build and nothing else',
    run: () => {
      const mk = (cluster: string) => buildEnv({ composeText: FIXTURE_COMPOSE, exampleText: '', env: { ...FULL, VITE_CLUSTER: cluster, PROGRAM_CHIP_CORE: A }, clientConfigText: FIXTURE_CLIENT }).problems.filter((p) => p.includes('dev placeholder'));
      return [...expectProblem(mk('mainnet-beta'), 'PROGRAM_CHIP_CORE', 'dev placeholder'), ...(mk('devnet').length ? ['a devnet build was blocked for using a dev id'] : [])];
    },
  },
  {
    name: 'the freeze record outranks every other source',
    run: () => {
      const mk = (ids: Record<string, string>) => buildEnv({ composeText: FIXTURE_COMPOSE, exampleText: '', env: FULL, clientConfigText: FIXTURE_CLIENT, freezeText: record(ids) }).problems.filter((p) => p.includes('freeze record'));
      // FULL carries PROGRAM_CHIP_CORE=B and PROGRAM_MARKET=C, so "agrees" means exactly those two values.
      return [...expectProblem(mk({ chip_core: C, market: C, staking: B, arena: B }), 'PROGRAM_CHIP_CORE', 'freeze record'), ...(mk({ chip_core: B, market: C, staking: B, arena: B }).length ? ['a record that agrees was reported: ' + mk({ chip_core: B, market: C, staking: B, arena: B })[0]] : [])];
    },
  },
  {
    // The shape mutation: `manifest` writes programs[] as a *list*. This file read it as a map for as long
    // as the record existed — `array['chip_core']` is undefined, every comparison was against undefined,
    // and the check reported nothing at all. A record in the map shape, or one that is not JSON, must be
    // named as unreadable instead of quietly dropping the authority it is supposed to carry.
    name: 'a freeze record in the wrong shape or not JSON is refused, never skipped',
    run: () => {
      const mk = (text: string) => buildEnv({ composeText: FIXTURE_COMPOSE, exampleText: '', env: FULL, clientConfigText: FIXTURE_CLIENT, freezeText: text }).problems;
      const good = mk(record({ chip_core: B, market: C, staking: B, arena: C }));
      return [
        ...expectProblem(mk(JSON.stringify({ programs: { chip_core: C } })), FREEZE, 'not the record'),
        ...expectProblem(mk('{ not json'), FREEZE, 'not the record'),
        ...expectProblem(mk(JSON.stringify({ programs: [{ name: 'chip_core', id: B }] })), FREEZE, 'no entry for'),
        ...(good.some((p) => p.includes(FREEZE)) ? [`a record written the way \`manifest\` writes it was reported: ${good.find((p) => p.includes(FREEZE))}`] : []),
        ...(freezeIds(record({ chip_core: C }))?.chip_core === C ? [] : ['freezeIds did not read the shape it was handed — the cases above would pass on a parse that returns nothing']),
      ];
    },
  },
  {
    name: 'an http RPC fails a mainnet build, and localhost is named',
    run: () => {
      const mk = (cluster: string, rpc: string) => buildEnv({ composeText: FIXTURE_COMPOSE, exampleText: '', env: { ...FULL, VITE_CLUSTER: cluster, VITE_SOLANA_RPC: rpc }, clientConfigText: FIXTURE_CLIENT }).problems.filter((p) => p.startsWith('VITE_SOLANA_RPC:'));
      return [...expectProblem(mk('mainnet-beta', 'http://localhost:8899'), 'VITE_SOLANA_RPC', 'mixed content'),
        ...expectNoProblem(mk('localnet', 'http://localhost:8899'), 'VITE_SOLANA_RPC'),
        ...expectProblem(mk('mainnet-beta', 'https://mainnet.helius-rpc.com/?api-key=REPLACE_ME'), 'VITE_SOLANA_RPC', 'placeholder')];
    },
  },
  {
    name: 'an interpolated-looking value is refused (a compose value that never resolved)',
    run: () => expectProblem(buildEnv({ composeText: FIXTURE_COMPOSE, exampleText: '', env: { ...FULL, PROGRAM_CHIP_CORE: '${PROGRAM_CHIP_CORE}' }, clientConfigText: FIXTURE_CLIENT }).problems, 'PROGRAM_CHIP_CORE', 'interpolation'),
  },
  {
    name: 'render → parseEnv is lossless, including URLs with ? and =',
    run: () => {
      const values = new Map([['VITE_SOLANA_RPC', RPCS], ['PROGRAM_CHIP_CORE', B], ['VITE_SENTRY_DSN', 'https://abc@o1.ingest.sentry.io/2']]);
      const back = parseEnv(render(values));
      return [...values].filter(([k, v]) => back.get(k) !== v).map(([k]) => `${k} did not survive render → parseEnv`);
    },
  },
  {
    name: 'every name in the un-prefixed set also appears VITE_-prefixed (Dockerfiles read the latter)',
    run: () => {
      const r = buildEnv({ composeText: FIXTURE_COMPOSE, exampleText: '', env: FULL, clientConfigText: FIXTURE_CLIENT });
      return [...r.values.keys()].filter((k) => !k.startsWith('VITE_') && !r.values.has(`VITE_${k}`)).map((k) => `${k} has no VITE_ alias in the output`);
    },
  },
  {
    name: 'the real compose file demands nothing the example does not document',
    run: () => {
      const needed = requiredArgs(readFileSync(join(root, COMPOSE), 'utf8')).filter((a) => a.required).map((a) => a.name).sort();
      const documented = [...parseEnv(readFileSync(join(root, EXAMPLE), 'utf8')).keys()];
      const missing = needed.filter((n) => !documented.includes(n));
      // and the reverse direction that matters for images: the example must not hide a name compose never
      // asks for, or `ops:buildenv` will drop the value nobody consumes and the deployer will hunt for it.
      const asked = new Set(requiredArgs(readFileSync(join(root, COMPOSE), 'utf8')).map((a) => a.name));
      void asked;
      return missing.map((n) => `${n}: ${COMPOSE} requires it for the build, ${EXAMPLE} does not document it`);
    },
  },
  {
    name: 'a required set that is empty means the compose parse broke (guard against silently checking nothing)',
    run: () => {
      const real = requiredArgs(readFileSync(join(root, COMPOSE), 'utf8')).filter((a) => a.required).map((a) => a.name);
      return real.length >= 8 ? [] : [`only ${real.length} required build arg(s) found in ${COMPOSE} — the block moved or the indentation changed, and the gate would pass everything`];
    },
  },
];

function expectProblem(problems: string[], name: string, needle: string): string[] {
  return problems.some((p) => p.startsWith(name) && p.includes(needle)) ? [] : [`${name}: expected a problem mentioning "${needle}", got [${problems.join(' | ') || 'none'}]`];
}
function expectNoProblem(problems: string[], name: string): string[] {
  const hit = problems.filter((p) => p.startsWith(name));
  return hit.length ? [`${name}: expected no problem, got ${hit[0]}`] : [];
}

function selftest(): number {
  let failed = 0;
  for (const c of cases) {
    let problems: string[] = [];
    try { problems = c.run(); } catch (e) { problems = ['threw: ' + (e as Error).message]; }
    if (problems.length) { failed++; console.log(`✗ ${c.name}`); for (const p of problems) console.log(`    ${p}`); }
    else console.log(`✓ ${c.name}`);
  }
  console.log(failed ? `\n${failed}/${cases.length} case(s) failed` : `\n${cases.length} deploy-env case(s) ok`);
  return failed ? 1 : 0;
}

// --------------------------------------------------------------------------- cli

const argv = process.argv.slice(2);
const opt = (name: string, dflt?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};

function main(): number {
  if (argv.includes('--selftest')) return selftest();

  const overlay = opt('from') ? readFileSync(resolve(root, opt('from')!), 'utf8') : undefined;
  const freezePath = join(root, FREEZE);
  const freezeText = existsSync(freezePath) ? readFileSync(freezePath, 'utf8') : null;
  const result = buildEnv({
    composeText: readFileSync(join(root, COMPOSE), 'utf8'),
    exampleText: existsSync(join(root, EXAMPLE)) ? readFileSync(join(root, EXAMPLE), 'utf8') : '',
    overlay,
    clientConfigText: readFileSync(join(root, 'client/src/app/config.ts'), 'utf8'),
    freezeText,
    cluster: opt('cluster'),
  });

  for (const p of result.problems) console.error('✗ ' + p);
  if (result.problems.length) {
    console.error(`\n${result.problems.length} problem(s); nothing was written. An image built with a missing or\nplaceholder value is not "a build to retry" — it is a deployable artifact for the wrong\nnetwork. Fix the sources (${EXAMPLE}, or the freeze record) and re-run.`);
    return 1;
  }

  const text = render(result.values);
  const out = opt('out');
  if (argv.includes('--check')) {
    console.log(`ok: ${result.values.size} value(s), cluster ${result.values.get('VITE_CLUSTER') ?? 'mainnet-beta'}, ${result.values.get('VITE_PROGRAM_CHIP_CORE') ? 'ids from ' + (freezeText ? FREEZE + ' + overlay' : 'overlay/env') : 'no ids (do not publish a mainnet image from this)'}`);
  } else if (out) {
    const abs = resolve(root, out);
    if (abs === resolve(root, EXAMPLE)) { console.error(`refusing to overwrite ${EXAMPLE} — that file is hand-maintained truth, not a generated artifact`); return 1; }
    // The guard is against the mistake that would be invisible: a generated env file committed into the tree
    // and then read as truth by the next deploy. Temp dir or ops/deploy, nowhere else.
    if (!abs.startsWith(tmpdir()) && !abs.startsWith(resolve(root, 'ops/deploy'))) { console.error(`refusing to write outside ${tmpdir()} or ops/deploy (got ${abs})`); return 1; }
    writeFileSync(abs, text, { mode: 0o600 });
    console.log(`wrote ${out}: ${result.values.size} value(s), cluster ${result.values.get('VITE_CLUSTER') ?? 'mainnet-beta'}`);
  } else {
    process.stdout.write(text);
  }
  return 0;
}

// Importable, and it has to be: the freeze record has two readers (this file's `freezeIds` and
// scripts/program-ids.ts's `parseFreezeRecord`) and one writer, and tests/security/program-ids-guard.test.ts
// asserts that both read what `manifest` writes. A module that runs its CLI — and `process.exit`s — at
// import time cannot take part in that.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main());
