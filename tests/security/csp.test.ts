// CSP ↔ code gate (SEC-B9, SECURITY-AUDIT-2026-09-26.md).
//
// The production CSP lives in `ops/deploy/nginx.conf` and the things it must allow live in the client
// bundle. Nothing connected the two, and they disagreed in both directions:
//
//   * `script-src 'self'` **blocked Cloudflare Turnstile** — `HumanCheck.tsx` injects
//     `https://challenges.cloudflare.com/turnstile/v0/api.js` when the player opens the proof-of-human
//     card. In production the widget could never load, so no player could obtain a human pass, so quests
//     and SKR rewards (settled only for verified wallets) were unreachable. A security control that
//     cannot run is indistinguishable from a wall: the failure is silent, client-side, and looks like
//     "Turnstile script blocked" in a console nobody in ops reads.
//   * `connect-src … wss:` allowed a WebSocket to **any host**. That is the scheme-source form of `*`:
//     after an XSS it is a first-class exfiltration channel, and no legitimate need was behind it — the
//     app's own socket is built from `window.location.host` (`client/src/api/ws.ts:41`, same origin,
//     covered by `'self'`) and RPC subscriptions only ever go to the configured RPC provider.
//
// So this file reads the CSP, reads the client sources, and fails when the two do not name the same
// origins — in either direction. Adding a new third-party origin therefore means editing the CSP *and*
// this allowlist, i.e. a reviewer sees it.
//   node --experimental-strip-types --test tests/security/*.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (rel: string) => readFileSync(join(REPO, rel), 'utf8');

/** Comments are prose, not requests: the nginx file explains the old, broken policy in a comment. */
const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1').replace(/(^|\s)#[^\n]*/g, '$1');

/** `add_header Content-Security-Policy "…" always;` → `{ directive: [sources] }`. */
function parseCsp(conf: string): Record<string, string[]> {
  const m = /add_header\s+Content-Security-Policy\s+"([^"]+)"/.exec(conf);
  assert.ok(m, 'ops/deploy/nginx.conf no longer sets a Content-Security-Policy header');
  const out: Record<string, string[]> = {};
  // `;` separates directives, but a single-quoted keyword never contains one — splitting is safe here
  for (const part of m[1].split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out[name] = values;
  }
  return out;
}

const NGINX = src('ops/deploy/nginx.conf');
const CSP = parseCsp(NGINX);
const sources = (d: string) => CSP[d] ?? [];
const hosts = (d: string) => sources(d).filter((s) => /^[a-z+]+:\/\//.test(s)).map((s) => s.replace(/^[a-z+]+:\/\//, ''));

/**
 * Every source expression the CSP is allowed to contain, with the reason it is needed. Keywords that are
 * not listed here fail the last test — that is the point: a new origin cannot appear without review.
 */
const ALLOWED: Record<string, string> = {
  "'self'": 'our own origin: the app, /assets, /fonts and the same-origin API + websocket',
  'data:': 'img-src/font-src: inlined artwork and the self-hosted woff2 files',
  'https:': 'img-src only: cNFT art may live on any https gateway (ipfs/arweave/CDN)',
  'https://challenges.cloudflare.com': 'Turnstile: api.js (script), widget iframe (frame), telemetry (connect)',
  'https://*.solana.com': 'Solana RPC (https + wss)',
  'https://api.mainnet-beta.solana.com': 'Solana public RPC, named explicitly in the client defaults',
  'https://*.helius-rpc.com': 'Helius RPC/DAS (https + wss)',
  'https://*.triton.one': 'Triton RPC (https + wss)',
  'wss://*.solana.com': 'RPC websocket subscriptions (web3.js derives wss:// from the https endpoint)',
  'wss://api.mainnet-beta.solana.com': 'Solana public RPC websocket',
  'wss://*.helius-rpc.com': 'Helius websocket subscriptions',
  'wss://*.triton.one': 'Triton websocket subscriptions',
};

test('SEC-B9 the CSP is default-deny and leaves no directive-wide escape hatch', () => {
  assert.deepEqual(sources('default-src'), ["'self'"]);
  assert.deepEqual(sources('frame-ancestors'), ["'none'"]);
  assert.deepEqual(sources('base-uri'), ["'self'"]);
  assert.deepEqual(sources('form-action'), ["'self'"]);
  assert.ok(!('object-src' in CSP) || sources('object-src').join(' ') === "'none'", 'object-src must be none or absent (default-src covers it)');
  for (const [name, values] of Object.entries(CSP)) {
    for (const v of values) {
      assert.notEqual(v, '*', `${name} allows every host`);
      assert.ok(!/^[a-z+]+:\/?\/?$/.test(v) || !['ws:', 'http:'].includes(v), `${name}: '${v}' is a blanket scheme-source`);
    }
  }
  // script-src is where an XSS turns into a wallet drainer: no inline, no eval, no hashes escaping review
  for (const bad of ["'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'", "'wasm-unsafe-eval'"]) {
    assert.ok(!sources('script-src').includes(bad), `script-src must not contain ${bad}`);
  }
  // 'unsafe-inline' for styles is deliberate (the wallet adapters inject styles at runtime); nothing else may have it
  for (const d of ['default-src', 'img-src', 'font-src', 'connect-src', 'frame-src']) {
    assert.ok(!sources(d).includes("'unsafe-inline'"), `${d} must not contain 'unsafe-inline'`);
  }
  // data: URIs are inert in an image/font context, but an executable document in script/frame context
  assert.ok(!sources('script-src').includes('data:') && !sources('frame-src').includes('data:'), 'data: must not reach script-src/frame-src');
});

test('SEC-B9 script-src names every origin the client injects a <script> from', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (/\.(ts|tsx)$/.test(e.name)) files.push(join(dir, e.name));
    }
  };
  walk(join(REPO, 'client/src'));

  const injected = new Set<string>();
  let injects = 0;
  for (const file of files) {
    const text = stripComments(readFileSync(file, 'utf8'));
    if (!/createElement\(\s*['"]script['"]\s*\)|<script[^>]+src\s*=|\.src\s*=\s*[A-Z_]*SCRIPT/.test(text)) continue;
    injects++;
    // the URL may be a constant (`SCRIPT_SRC = 'https://host/…'`) or inline on the assignment
    for (const m of text.matchAll(/https:\/\/([a-zA-Z0-9.-]+)\/[^'"`\s]*api\.js/g)) injected.add(m[1]);
    for (const m of text.matchAll(/['"](https:\/\/[a-zA-Z0-9.-]+)\//g)) injected.add(m[1].replace(/^https:\/\//, ''));
  }
  assert.ok(injects > 0, 'no client file injects a script any more — this rule has gone stale, remove or repoint it instead of leaving a vacuous check');
  assert.deepEqual([...injected].sort(), ['challenges.cloudflare.com'], 'the only third-party script the client is allowed to inject is Turnstile');
  for (const host of injected) {
    assert.ok(sources('script-src').includes(`https://${host}`), `client injects a script from https://${host}, but script-src is ${JSON.stringify(sources('script-src'))} — the widget would be blocked in production`);
  }
});

test('SEC-B9 frame-src covers the widget iframe, and connect-src names hosts rather than a scheme', () => {
  // Turnstile renders its challenge in an iframe owned by Cloudflare; without this the widget is blank.
  assert.ok(sources('frame-src').includes('https://challenges.cloudflare.com'), 'frame-src must name challenges.cloudflare.com (Turnstile iframe)');
  // and its runtime fetches go to the same host (challenge platform + pre-clearance), so connect-src too
  assert.ok(sources('connect-src').includes('https://challenges.cloudflare.com'), 'connect-src must name challenges.cloudflare.com (Turnstile runtime fetches)');
  assert.ok(!sources('frame-src').includes('*'), 'frame-src must not allow every origin');

  // `connect-src … wss:` (pre-audit) allowed a socket to any host: an exfiltration channel for injected
  // script. We allow websockets, but only to the RPC hosts we already trust over https.
  for (const bad of ['wss:', 'ws:', 'https:', 'http:']) {
    assert.ok(!sources('connect-src').includes(bad), `connect-src: '${bad}' is a blanket scheme-source — name the hosts instead`);
  }
  assert.ok(sources('connect-src').includes("'self'"), "connect-src must keep 'self' (same-origin API and websocket)");
  for (const d of ['connect-src', 'frame-src', 'script-src']) {
    for (const h of hosts(d)) assert.ok(h.includes('.') || h.includes('*'), `${d}: '${h}' is not a host`);
  }
  // every https RPC host must have a wss counterpart, or subscriptions silently fall back to polling
  // (Turnstile is fetched over https only — it has no websocket endpoint, hence the exception)
  const NO_WS = ['https://challenges.cloudflare.com'];
  const httpsRpc = sources('connect-src').filter((s) => s.startsWith('https://') && !NO_WS.includes(s));
  assert.ok(httpsRpc.length >= 4, 'the RPC hosts are gone from connect-src');
  for (const h of httpsRpc) {
    const wss = `wss://${h.slice('https://'.length)}`;
    assert.ok(sources('connect-src').includes(wss), `connect-src names ${h} but not ${wss}: a websocket subscription to that provider would be blocked`);
  }
});

test('SEC-B9 fonts are self-hosted, so font-src stays on our origin', () => {
  assert.deepEqual(sources('font-src'), ["'self'", 'data:'], 'font-src must stay self+data (SEC-B4: the woff2 files are vendored, no font CDN)');
  assert.ok(!hosts('font-src').length, 'no third-party font host may appear in font-src');
  // and the landing, which ships its own policy, must agree
  assert.match(src('scripts/landing/build.py'), /font-src 'self' data:/);
});

test('SEC-B9 every source expression in the CSP is in the reviewed allowlist', () => {
  const seen = new Set<string>();
  for (const values of Object.values(CSP)) for (const v of values) if (!v.startsWith("'") || v === "'self'") seen.add(v);
  const unknown = [...seen].filter((v) => !(v in ALLOWED)).sort();
  assert.deepEqual(unknown, [], `unreviewed CSP source(s): ${unknown.join(', ')} — add a reason to ALLOWED in this file, or drop them`);
  const unused = Object.keys(ALLOWED).filter((k) => !seen.has(k)).sort();
  assert.deepEqual(unused, [], `allowlist entries that are no longer in the CSP: ${unused.join(', ')} — remove them so the list stays honest`);
});

test('SEC-B9 the app reaches its API on its own origin (or the origin is in connect-src)', () => {
  // `connect-src 'self'` is only correct while the client's API base is relative. Point the build at
  // https://api.example and every request dies in the browser unless that origin is named here — the same
  // shape of bug as the Turnstile one, one config line away.
  const config = src('client/src/app/config.ts');
  const clientBase = /API_BASE[^=]*=\s*env\.VITE_API_BASE\s*\?\?\s*'([^']+)'/.exec(config)?.[1];
  assert.ok(clientBase, 'client/src/app/config.ts no longer defaults API_BASE to a literal — update this rule');
  const declared = [clientBase, ...Array.from(src('client/.env.example').matchAll(/^VITE_API_BASE=(\S+)/gm)).map((m) => m[1])];
  for (const base of declared) {
    if (base.startsWith('/')) continue;
    const origin = new RegExp('^https?://[^/]+').exec(base)?.[0].replace(/^http:/, 'https:');
    assert.ok(origin && sources('connect-src').includes(origin), `VITE_API_BASE=${base} is absolute: its origin must be named in connect-src (${JSON.stringify(sources('connect-src'))})`);
  }
  if (clientBase.startsWith('/')) {
    // the relative base is only real if the SPA's nginx actually forwards it, with the websocket upgrade
    assert.match(NGINX, /location\s+\/v1\//, 'nginx.conf must proxy /v1/ to the API (the client defaults to a same-origin /v1)');
    assert.match(NGINX, /location\s+=?\s*\/ws/, 'nginx.conf must proxy /ws to the API (the client opens a same-origin websocket)');
    assert.match(NGINX.slice(NGINX.indexOf('location = /ws')), /proxy_set_header\s+Upgrade/, '/ws needs the Upgrade/Connection headers or the socket never connects');
  }
});

test('SEC-B9 the deploy docs tell the operator to update connect-src when the RPC host changes', () => {
  // The RPC URL is an env var; the CSP is a file. Point the app at a provider that is not in the list and
  // every wallet call dies in the browser — with a CSP violation nobody associates with "we changed RPC".
  const docs = src('ops/deploy/runbook.md') + src('docs/09-production-readiness.md');
  assert.match(docs, /connect-src/, 'the runbook/production-readiness doc must mention connect-src next to the RPC env vars');
});
