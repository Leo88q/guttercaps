// REST contract guard (docs/09-production-readiness.md §4.7).
//
// `npm run verify` already proves the generated client types match openapi.yaml (the CI `client`
// job regenerates src/api/schema.d.ts and diffs it). That check cannot see the other half of the
// drift: a path documented in the spec with no Express route behind it (the client then gets a 404
// at runtime) or a route that exists but is undocumented. Both were true in this repo when
// docs/09 was written — `/collections/{idx}/chips/{rarity}` was in the spec + the client mock and
// returned 404, while `/stats` and `/wallet/{address}/events` were live but undocumented.
//
//   node --experimental-strip-types scripts/api-contract.ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const spec = readFileSync(resolve(root, 'backend/openapi.yaml'), 'utf8');
const server = readFileSync(resolve(root, 'backend/src/server.ts'), 'utf8');

/** `paths:` block of the spec → `get /collections/{idx}/chips/{rarity}` style keys. */
function specOperations(): Set<string> {
  const out = new Set<string>();
  let current: string | null = null;
  let inPaths = false;
  for (const line of spec.split('\n')) {
    if (/^paths:\s*$/.test(line)) { inPaths = true; continue; }
    if (inPaths && /^[a-zA-Z]/.test(line)) break; // next top-level key (components:)
    if (!inPaths) continue;
    const p = /^  (\/[^:]*):\s*$/.exec(line);
    if (p) { current = p[1]; continue; }
    const m = /^    (get|post|put|patch|delete):(\s*\{|$)/.exec(line);
    if (m && current) out.add(`${m[1]} ${current}`);
  }
  return out;
}

/** Express routes → the same key shape (`:param` normalised to `{param}`). */
function implementedOperations(): Set<string> {
  const out = new Set<string>();
  for (const m of server.matchAll(/v1\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
    out.add(`${m[1]} ${m[2].replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}')}`);
  }
  return out;
}

const want = specOperations();
const have = implementedOperations();

/**
 * The load profile (`scripts/load/lt1.js`) is a contract too: it claims to measure *reads*, so every path
 * in it has to be one the API actually answers with a 200. It was not: `/market/listings?sort=price` asked
 * for a sort value `LISTING_SORTS` rejects with `400 bad_sort`, so those virtual users were measuring an
 * error response and the "read is 200" check failed on every iteration — invisible because the load smoke
 * is a nightly job. This validates the profile against the spec: the path must be a documented GET, every
 * query parameter must be documented for it, and the enum-valued ones must use a documented value.
 */
function specGetPatterns(): { pattern: RegExp; params: Map<string, string[] | null> }[] {
  const out: { pattern: RegExp; params: Map<string, string[] | null> }[] = [];
  const blocks = spec.split(/\n  (?=\/)/).filter((b) => /^\//.test(b));
  for (const block of blocks) {
    const path = block.split('\n')[0].trim().replace(/:$/, '');
    if (!/^    get:/.test(block) && !/\n    get:/.test(block)) continue;
    const params = new Map<string, string[] | null>();
    for (const m of block.matchAll(/- \{ in: query, name: ([A-Za-z0-9_]+)([^\n]*)/g)) {
      const enumMatch = /enum: \[([^\]]*)\]/.exec(m[2]);
      params.set(m[1], enumMatch ? enumMatch[1].split(',').map((v) => v.trim()) : null);
    }
    // Placeholders first, escaping second: `{board}` must become `[^/]+`, and a `\{` that survived an
    // escape pass would match a literal brace instead (`/leaderboard/rating` then looked undocumented).
    const toRegex = (p: string) =>
      `^${p.split(/(\{[^}]+\})/).map((seg) => (/^\{[^}]+\}$/.test(seg) ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('')}$`;
    out.push({ pattern: new RegExp(toRegex(path)), params });
  }
  return out;
}

function checkLoadProfile(): string[] {
  const load = readFileSync(resolve(root, 'scripts/load/lt1.js'), 'utf8');
  const problems: string[] = [];
  const seen = new Set<string>();
  // The requests are built from an array of literals (`READ_PATHS`) plus a few inline calls, so the
  // candidates are every string literal that starts with `/` — not only the ones inside `http.get(`.
  for (const m of load.matchAll(/[`'"](\/[^`'"]*)[`'"]/g)) {
    const raw = m[1];
    if (!raw.startsWith('/')) continue;
    const [path, query] = raw.split('?');
    if (seen.has(raw)) continue;
    seen.add(raw);
    const hit = specGetPatterns().find((p) => p.pattern.test(path.replace(/\$\{[^}]+\}/g, '1')));
    if (!hit) { problems.push(`${raw} — no documented GET operation matches this path`); continue; }
    for (const q of new URLSearchParams(query ?? '')) {
      const [name, value] = q;
      if (!hit.params.has(name)) { problems.push(`${raw} — \`${name}\` is not a documented query parameter here`); continue; }
      const allowed = hit.params.get(name);
      if (allowed && !allowed.includes(value)) problems.push(`${raw} — \`${name}=${value}\` is outside the documented enum [${allowed.join(', ')}]`);
    }
  }
  return problems;
}
const missing = [...want].filter((k) => !have.has(k));
const undocumented = [...have].filter((k) => !want.has(k));

let failed = 0;
const report = (label: string, items: string[]) => {
  if (!items.length) { console.log(`✓ ${label} — ${label === 'undocumented routes' ? have.size : want.size} operations in sync`); return; }
  failed += 1;
  console.error(`✗ ${label}:\n  ${items.join('\n  ')}`);
};

console.log(`api contract: ${want.size} operations in backend/openapi.yaml, ${have.size} routes in backend/src/server.ts`);
report('every documented operation has a route', missing);
report('undocumented routes', undocumented);
report('the load profile only calls documented reads', checkLoadProfile());
if (missing.length) console.error('  → implement the route in backend/src/server.ts or drop it from the spec');
if (undocumented.length) console.error('  → document it in backend/openapi.yaml (then: cd client && npx openapi-typescript ../backend/openapi.yaml -o src/api/schema.d.ts)');
if (!failed && checkLoadProfile().length) console.error('  → fix scripts/load/lt1.js: a load path that answers 400 measures nothing');

if (failed) process.exit(1);
