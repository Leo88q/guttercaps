// The Mac devnet `rust` stage invokes programs:gate, but it used to omit the two Anchor macro
// exceptions already applied in CI. A green rust-lints job therefore did not mean the local gate
// could pass. Pin both entry points to the same locked, strict commands, and exercise the actual npm
// script with a fake cargo to prove that failures still stop the gate. No Rust toolchain or network
// is needed; compilation itself remains covered by CI's rust-lints job.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');
const GATE = JSON.parse(read('package.json')).scripts['programs:gate'] as string;
const EXPECTED = [
  ['fmt', '--all', '--', '--check'],
  ['clippy', '--locked', '--workspace', '--all-targets', '--', '-D', 'warnings', '-A', 'deprecated', '-A', 'unexpected_cfgs'],
  ['test', '--locked', '--workspace'],
  // L-1: the same tests in release mode. Debug and release differ where it matters for an on-chain
  // program — `debug_assert!` is compiled out and the optimizer can expose a dependence on evaluation
  // order that a slow debug build hides — and LiteSVM loading a release `.so` is not the same as
  // running the crate's own `#[test]`s in release.
  ['test', '--locked', '--release', '--workspace'],
];

function runGate(t: TestContext, failStage = '') {
  const dir = mkdtempSync(join(tmpdir(), 'rust-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  const log = join(dir, 'cargo.log');
  mkdirSync(bin);
  writeFileSync(log, '');
  // The stage key is the whole argument string, not `$1`: two of the stages are `cargo test`, and a
  // `$1` comparison cannot tell the debug run from the release one.
  writeFileSync(join(bin, 'cargo'), `#!/bin/sh
printf '%s\\n' "$*" >> "$CARGO_GATE_LOG"
if [ "$*" = "$CARGO_GATE_FAIL_STAGE" ]; then exit 37; fi
`, { mode: 0o755 });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, scripts: { 'programs:gate': GATE } }));
  const result = spawnSync('npm', ['run', '--silent', 'programs:gate'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      CARGO_GATE_LOG: log,
      CARGO_GATE_FAIL_STAGE: failStage,
      NPM_CONFIG_UPDATE_NOTIFIER: 'false',
      npm_config_script_shell: '/bin/sh',
    },
  });
  assert.ifError(result.error);
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => line.split(' '));
  return { ...result, calls };
}

test('programs:gate runs fmt, strict clippy with only the two Anchor exceptions, then locked unit tests in debug and release', (t) => {
  const result = runGate(t);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, EXPECTED, 'keep -D warnings; do not replace the two specific exceptions with -A warnings');
});

test('CI and the Mac gate use the same fmt, clippy and unit-test arguments', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /if \[ -f Cargo\.lock \]; then locked=--locked;/, 'CI must select the committed dependency graph');
  const fmt = ci.match(/^\s*run: cargo (fmt [^\r\n]+)$/m)?.[1];
  assert.ok(fmt, 'CI fmt command not found');
  assert.deepEqual(fmt.trim().split(/\s+/), EXPECTED[0]);
  // Every stage the npm gate runs must appear verbatim in CI too — collect them all, because two of
  // the four stages start with `cargo test` and `match` would only ever see the first.
  for (const [i, expected] of EXPECTED.entries()) {
    const commands = [...ci.matchAll(new RegExp(`^\\s*(?:run: cargo |sh scripts/ci-run-logged\\.sh \\S+ cargo )(${expected[0]} [^\\r\\n]+)$`, 'mg'))].map((m) => m[1]!);
    const normalised = commands.map((c) => c.replace('$locked', '--locked').trim().split(/\s+/));
    assert.ok(normalised.some((c) => c.join(' ') === expected.join(' ')), `CI does not run \`cargo ${expected.join(' ')}\` — saw ${JSON.stringify(normalised)}`);
    void i;
  }
  assert.match(read('scripts/mac-devnet.sh'), /stage_rust\(\) \{[^}]*run npm run programs:gate/, 'the Mac rust stage must use the tested npm gate');
  assert.match(read('scripts/mac-devnet.sh'), /stage_rust\(\) \{[^}]*run npm run programs:gate/, 'the Mac rust stage must use the tested npm gate');
});

for (const [i, args] of EXPECTED.entries()) {
  test(`programs:gate preserves a \`cargo ${args.join(' ')}\` failure and does not run later steps`, (t) => {
    const result = runGate(t, args.join(' '));
    assert.equal(result.status, 37, result.stderr);
    assert.deepEqual(result.calls, EXPECTED.slice(0, i + 1));
  });
}
