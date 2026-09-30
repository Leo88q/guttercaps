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
];

function runGate(t: TestContext, failStage = '') {
  const dir = mkdtempSync(join(tmpdir(), 'rust-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  const log = join(dir, 'cargo.log');
  mkdirSync(bin);
  writeFileSync(log, '');
  writeFileSync(join(bin, 'cargo'), `#!/bin/sh
printf '%s\\n' "$*" >> "$CARGO_GATE_LOG"
if [ "$1" = "$CARGO_GATE_FAIL_STAGE" ]; then exit 37; fi
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

test('programs:gate runs fmt, strict clippy with only the two Anchor exceptions, then locked unit tests', (t) => {
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
  for (const i of [1, 2]) {
    const command = ci.match(new RegExp(`^\\s*sh scripts/ci-run-logged\\.sh \\S+ cargo (${EXPECTED[i][0]} [^\\r\\n]+)$`, 'm'))?.[1];
    assert.ok(command, `CI ${EXPECTED[i][0]} command not found`);
    assert.deepEqual(command.replace('$locked', '--locked').trim().split(/\s+/), EXPECTED[i], 'local and CI lint policies must not drift');
  }
  assert.match(read('scripts/mac-devnet.sh'), /stage_rust\(\) \{[^}]*run npm run programs:gate/, 'the Mac rust stage must use the tested npm gate');
});

for (const [i, args] of EXPECTED.entries()) {
  test(`programs:gate preserves a ${args[0]} failure and does not run later steps`, (t) => {
    const result = runGate(t, args[0]);
    assert.equal(result.status, 37, result.stderr);
    assert.deepEqual(result.calls, EXPECTED.slice(0, i + 1));
  });
}
