// SEC-B26 — the log pipeline is a third party, so the redaction layer that keeps credentials out of it
// is a security control, not a formatting detail. The suite (`backend/test/log.test.ts`) proves the
// behaviour; this gate proves the control is still *there* and still wired into every path a value can
// take out of the process:
//
//   * `safeValue` (objects, arrays, maps, sets, depth) — a key is checked before its value is copied;
//   * `line` — the message is scrubbed, because `console.error('…', TURNSTILE_SECRET)` arrives as text;
//   * `errFields` — a fetch/RPC error message carries the endpoint, and endpoints carry `?api-key=…`;
//   * the two nets (key names, value shapes) are both present and applied in the order that matters
//     (`Bearer eyJ…` first, or the scheme word itself would be masked while the token survived).
//
//   node --experimental-strip-types --test tests/security/*.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (rel: string) => readFileSync(join(REPO, rel), 'utf8');

/** Body of a top-level `export function name(…) { … }` (comments kept: this rule reads literals). */
function fnBody(ts: string, name: string): string {
  const start = ts.indexOf(name);
  if (start < 0) return '';
  const open = ts.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < ts.length; i++) {
    if (ts[i] === '{') depth++;
    else if (ts[i] === '}') { depth--; if (depth === 0) return ts.slice(start, i + 1); }
  }
  return ts.slice(start);
}

function secB26Violations(logTs: string): string[] {
  const bad: string[] = [];
  // 1. the key-name net exists and is consulted from `safeValue` before the value is walked
  if (!/export function isSecretKey\(key: string\): boolean \{ return SECRET_KEY\.test\(key\.replace\(/.test(logTs)) {
    bad.push('isSecretKey no longer strips separators — `apiKey` / `api_key` / `API_KEY` would drift apart');
  }
  const safe = fnBody(logTs, 'function safeValue');
  if (!safe) bad.push('safeValue is gone — every log field is copied verbatim again');
  else {
    if (!/if \(isSecretKey\(k\)\) \{ out\[k\] = REDACTED; continue; \}/.test(safe)) bad.push('safeValue copies object keys without consulting isSecretKey (SEC-B26)');
    if (!/scrubString\(v as string\)/.test(safe)) bad.push('safeValue no longer scrubs string values');
    // scrub before truncate, or a secret past 2 000 chars survives the "safety" cut
    if (safe.indexOf('scrubString') > safe.indexOf('slice(0, 2_000)')) bad.push('safeValue truncates before scrubbing — a long string can smuggle a credential past the cut');
  }
  // 2. the message and the error-message paths
  const lineFn = fnBody(logTs, 'function line(');
  if (!/msg = scrubString\(msg\)/.test(lineFn)) bad.push('`line` logs the message unscrubbed (console.error with a secret arrives as the message)');
  const err = fnBody(logTs, 'export function errFields');
  if (!/err: scrubString\(err\?\.message/.test(err)) bad.push('errFields logs an unscrubbed error message (RPC URLs carry ?api-key=…)');
  // 3. the value-shape net, in the order that matters
  const patterns = /const VALUE_PATTERNS[\s\S]*?\n\];/.exec(logTs)?.[0] ?? '';
  if (!/bearer\|basic/.test(patterns) || !/api\[-_\]\?key/.test(patterns)) bad.push('the value-shape net (Bearer / api-key) is gone');
  else if (patterns.indexOf('bearer|basic') > patterns.indexOf('api[-_]?key')) bad.push('the Bearer rule runs after the key=value rule: `authorization: Bearer <token>` would be masked as `authorization: [redacted] <token>`');
  if (!/export const REDACTED = '\[redacted\]'/.test(logTs)) bad.push('REDACTED is gone — the tests and the ops greps key on it');
  // 4. the suite that proves the behaviour must exist and cover both nets
  const suite = src('backend/test/log.test.ts');
  for (const [what, re] of [
    ['a deep credential field', /nested: \{ keypair/],
    ['a credential in free text', /api-key=/],
    ['an error message', /errFields\(new Error/],
    ['the readable-but-not-secret control', /expect\(isSecretKey\(k\), k\)\.toBe\(false\)/],
  ] as const) {
    if (!re.test(suite)) bad.push(`backend/test/log.test.ts no longer covers ${what}`);
  }
  return bad;
}

test('SEC-B26 credentials cannot leave the process through the log pipeline', () => {
  const bad = secB26Violations(src('backend/src/log.ts'));
  assert.deepEqual(bad, []);
});

test('self-test: SEC-B26 flags an unguarded safeValue, an unscrubbed message and a reordered net', () => {
  const logTs = src('backend/src/log.ts');
  assert.deepEqual(secB26Violations(logTs), []);
  const unguarded = logTs.replace('if (isSecretKey(k)) { out[k] = REDACTED; continue; }', '');
  assert.notEqual(unguarded, logTs);
  assert.ok(secB26Violations(unguarded).some((v) => /without consulting isSecretKey/.test(v)));
  const noScrub = logTs.replace('msg = scrubString(msg); // `console.error', '// `console.error');
  assert.notEqual(noScrub, logTs);
  assert.ok(secB26Violations(noScrub).some((v) => /unscrubbed/.test(v)));
  // swap the two array entries by line, so the mutation cannot silently no-op on a reformat
  const lines = logTs.split('\n');
  const bi = lines.findIndex((l) => l.includes('bearer|basic'));
  const ai = lines.findIndex((l) => l.includes('api[-_]?key'));
  assert.ok(bi >= 0 && ai >= 0 && bi < ai, 'the two value-shape patterns must exist, Bearer first');
  const swappedLines = [...lines];
  [swappedLines[bi], swappedLines[ai]] = [swappedLines[ai]!, swappedLines[bi]!];
  const swapped = swappedLines.join('\n');
  assert.notEqual(swapped, logTs, 'the mutation must actually reorder the patterns');
  assert.ok(secB26Violations(swapped).some((v) => /runs after the key=value rule/.test(v)));
  const noErr = logTs.replace('err: scrubString(err?.message ?? String(e)),', 'err: err?.message ?? String(e),');
  assert.notEqual(noErr, logTs);
  assert.ok(secB26Violations(noErr).some((v) => /unscrubbed error message/.test(v)));
});
