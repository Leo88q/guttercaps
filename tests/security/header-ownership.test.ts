// M-6 gate (AUDIT-2026-10-02): one delivery path, and the headers live in it.
//
// `client/public/_headers` and `_redirects` were Cloudflare Pages conventions sitting in a tree whose
// real delivery path is `ops/deploy/nginx.conf`. `_headers` carried only Cache-Control (no CSP, no
// HSTS, no X-Frame-Options) and nginx ignores that syntax entirely; `_redirects` duplicated a
// try_files fallback nginx already had. The failure mode was a *second* deploy path that nobody
// knew about: one `wrangler pages deploy` or one CDN change and the app is served with no security
// headers at all, and nothing anywhere would say so — csp.test.ts only checks the nginx side.
//
// The fix was to delete both files (docs/09 §9 records the mapping and the condition that was
// verified first: no `wrangler pages deploy`, no Pages job in .github/workflows, Cloudflare present
// only as Turnstile and as the GEO_GATE header source). This file is the half that keeps them gone:
//   * no Cloudflare-Pages-only convention may come back in client/public/;
//   * the security headers must still exist at nginx *server* scope, because a location-level
//     add_header silently replaces the inherited set on nginx ≤ 1.28 (see csp.test.ts for that rule
//     — this one is the "they exist at all" complement, not a duplicate).
//   node --experimental-strip-types --no-warnings --test tests/security/*.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO = new URL('../../', import.meta.url).pathname;
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');

/** Comments stripped the same way csp.test.ts does, so a directive inside a comment does not count. */
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)#[^\n]*/g, '$1');

const NGINX = stripComments(read('ops/deploy/nginx.conf'));

test('client/public carries no Cloudflare-Pages-only convention', () => {
  const pub = join(REPO, 'client/public');
  const dead = ['_headers', '_redirects', 'wrangler.toml', 'wrangler.json', 'wrangler.jsonc', '_routes.json'];
  const present = dead.filter((f) => existsSync(join(pub, f)));
  assert.deepEqual(present, [], `${present.join(', ')} is Cloudflare Pages syntax and nginx ignores it — the header authority is ops/deploy/nginx.conf (docs/09 §9)`);
  // Recursive, because a nested copy is just as dead and much harder to notice than a top-level one.
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name.startsWith('.')) return [];
    const rel = join(dir, e.name);
    return e.isDirectory() ? walk(rel) : dead.includes(e.name) ? [rel.slice(pub.length + 1)] : [];
  });
  assert.deepEqual(walk(pub), [], 'a Cloudflare-Pages convention reappeared under client/public/');
});

test('nginx server scope still carries the headers _headers never had', () => {
  // CSP with a frame-ancestors, HSTS-ready TLS block, and the framing/referrer/Permissions set.
  for (const re of [
    /add_header Content-Security-Policy "[^"]*frame-ancestors 'none'/,
    /add_header X-Frame-Options "DENY"/,
    /add_header X-Content-Type-Options "nosniff"/,
    /add_header Referrer-Policy "no-referrer"/,
    /add_header Permissions-Policy "geolocation=\(\)/,
    /add_header Cross-Origin-Opener-Policy "same-origin"/,
  ]) assert.match(NGINX, re, `missing from ops/deploy/nginx.conf: ${re}`);
  // HSTS is deliberately NOT asserted here: it lives in the commented TLS block, because TLS is not
  // terminated in this container (nginx says so, and runbook §1.3 repeats it). Asserting it active
  // would be asserting a decision the file documents against — and "who terminates TLS for real" is
  // audit item 105, which is not code-closable. What IS asserted is that the block still says so:
  // a file that loses the explanation loses the reason the header is absent.
  const raw = read('ops/deploy/nginx.conf');
  assert.match(raw, /Strict-Transport-Security/, 'the TLS/HSTS guidance block disappeared from nginx.conf');
  assert.match(raw, /Not terminated in this container, on purpose/, 'nginx.conf no longer explains why TLS (and HSTS) are not set here');
  // And the SPA fallback that made _redirects redundant.
  assert.match(NGINX, /location \/ \{\s*try_files \$uri \$uri\/ \/index\.html;/, 'the SPA fallback is what _redirects duplicated');
});

test('self-test: the rules fire when a file comes back or a header disappears', () => {
  const pub = join(REPO, 'client/public');
  const names = readdirSync(pub, { withFileTypes: true }).map((e) => e.name);
  assert.ok(!names.includes('_headers'), 'fixture assumption: _headers is absent');
  assert.throws(() => {
    const dead = ['_headers', '_redirects'];
    const present = [...names, '_headers'].filter((f) => dead.includes(f));
    assert.deepEqual(present, []);
  }, /_headers/);
  assert.throws(() => assert.match(NGINX.replace(/X-Frame-Options "DENY"/, 'X-Frame-Options "SAMEORIGIN"'), /X-Frame-Options "DENY"/), /X-Frame-Options/);
});
