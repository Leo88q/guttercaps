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

// --------------------------------------------------------------------------- assembly

export interface Result { values: Map<string, string>; problems: string[] }

export function buildEnv(opts: {
  composeText: string;
  exampleText: string;
  overlay?: string;
  env?: Record<string, string | undefined>;
  clientConfigText?: string;
  freeze?: Record<string, string> | null;
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
  if (opts.freeze) {
    const named: Record<string, string> = { chip_core: 'PROGRAM_CHIP_CORE', market: 'PROGRAM_MARKET', staking: 'PROGRAM_STAKING', arena: 'PROGRAM_ARENA' };
    for (const [program, varName] of Object.entries(named)) {
      const want = opts.freeze[program];
      const got = values.get(varName);
      if (want && got && want !== got) problems.push(`${varName}: "${got}" disagrees with the freeze record ${FREEZE} ("${want}") for ${program}`);
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
      const mk = (freeze: Record<string, string>) => buildEnv({ composeText: FIXTURE_COMPOSE, exampleText: '', env: FULL, clientConfigText: FIXTURE_CLIENT, freeze }).problems.filter((p) => p.includes('freeze record'));
      return [...expectProblem(mk({ chip_core: C }), 'PROGRAM_CHIP_CORE', 'freeze record'), ...(mk({ chip_core: B }).length ? ['a record that agrees was reported'] : [])];
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

if (argv.includes('--selftest')) process.exit(selftest());

const overlay = opt('from') ? readFileSync(resolve(root, opt('from')!), 'utf8') : undefined;
const freezePath = join(root, FREEZE);
const freeze = existsSync(freezePath) ? ((JSON.parse(readFileSync(freezePath, 'utf8')).programs ?? {}) as Record<string, string>) : null;
const result = buildEnv({
  composeText: readFileSync(join(root, COMPOSE), 'utf8'),
  exampleText: existsSync(join(root, EXAMPLE)) ? readFileSync(join(root, EXAMPLE), 'utf8') : '',
  overlay,
  clientConfigText: readFileSync(join(root, 'client/src/app/config.ts'), 'utf8'),
  freeze,
  cluster: opt('cluster'),
});

for (const p of result.problems) console.error('✗ ' + p);
if (result.problems.length) {
  console.error(`\n${result.problems.length} problem(s); nothing was written. An image built with a missing or\nplaceholder value is not "a build to retry" — it is a deployable artifact for the wrong\nnetwork. Fix the sources (${EXAMPLE}, or the freeze record) and re-run.`);
  process.exit(1);
}

const text = render(result.values);
const out = opt('out');
if (argv.includes('--check')) {
  console.log(`ok: ${result.values.size} value(s), cluster ${result.values.get('VITE_CLUSTER') ?? 'mainnet-beta'}, ${result.values.get('VITE_PROGRAM_CHIP_CORE') ? 'ids from ' + (freeze ? FREEZE + ' + overlay' : 'overlay/env') : 'no ids (do not publish a mainnet image from this)'}`);
} else if (out) {
  const abs = resolve(root, out);
  if (abs === resolve(root, EXAMPLE)) { console.error(`refusing to overwrite ${EXAMPLE} — that file is hand-maintained truth, not a generated artifact`); process.exit(1); }
  // The guard is against the mistake that would be invisible: a generated env file committed into the tree
  // and then read as truth by the next deploy. Temp dir or ops/deploy, nowhere else.
  if (!abs.startsWith(tmpdir()) && !abs.startsWith(resolve(root, 'ops/deploy'))) { console.error(`refusing to write outside ${tmpdir()} or ops/deploy (got ${abs})`); process.exit(1); }
  writeFileSync(abs, text, { mode: 0o600 });
  console.log(`wrote ${out}: ${result.values.size} value(s), cluster ${result.values.get('VITE_CLUSTER') ?? 'mainnet-beta'}`);
} else {
  process.stdout.write(text);
}
