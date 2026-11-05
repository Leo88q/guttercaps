// Находка 86: ops-скрипт, который отработал и не завершился.
//
// Наблюдено на машине владельца: `npm run create-lut -- extend <table>` напечатал последнюю строку
// («table …: 86 → 90 addresses»), транзакция исполнилась, а процесс остался жив — `stage_setup` в
// `scripts/mac-devnet.sh` ждал его вечно, и прогон выглядел зависшим на сети. Причина — подтверждение через
// `sendAndConfirmTransaction` из `@solana/web3.js`: он ждёт подписи по WebSocket-подписке и сокет не
// закрывает, а `main()` в этих файлах завершается без выхода, так что event loop продолжает жить.
//
// Для шага, который вызывают из другого скрипта, «успешно сделал и висит» неотличимо от «сеть не отвечает»:
// следующий этап не начинается, лог обрывается на строке успеха, и человек идёт чинить RPC. Поэтому у
// каждого такого скрипта успешный путь обязан заканчиваться явным `process.exit(0)`: конец работы должен
// быть наблюдаемым, а не выводимым из тишины. Настоящее лечение (опрос `getSignatureStatuses` вместо
// WebSocket-подтверждения) — отдельная работа; этот гейт держит симптом, который уже стоил прогона.
//
//   node --experimental-strip-types --test tests/security/*.test.ts      (npm run security:static)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPTS = join(REPO, 'scripts');

/** The scripts that send at least one transaction through web3.js's confirmation subscription. */
function senders(): { name: string; src: string }[] {
  return readdirSync(SCRIPTS)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ name: f, src: readFileSync(join(SCRIPTS, f), 'utf8') }))
    .filter((s) => /sendAndConfirmTransaction/.test(s.src));
}

/** A CLI entry point runs its `main()` at module scope; imported-as-library modules have no such call. */
const runsMain = (src: string) => /^main\(\)/m.test(src) || /^void main\(\)/m.test(src);

/**
 * Two shapes both end the process on success, and both are in the tree:
 *   1. `process.exit(0)` inside `main()` — its body sits before the top-level `main()` call;
 *   2. `main().then(() => process.exit(0))` — the exit lives after the call, in the continuation.
 * What is NOT accepted is the shape that hung: `main().catch(...)` and nothing else, success falls off the end.
 */
const exitsOnSuccess = (src: string): boolean => {
  const call = src.search(/^main\(\)/m);
  const beforeCall = call >= 0 ? src.slice(0, call) : src;
  if (/process\.exit\(0\)/.test(beforeCall)) return true;
  return /main\(\)\s*\n?\s*\.then\(\s*\(\s*\)\s*=>\s*process\.exit\(0\)/.test(src) || /main\(\)\.then\(\(\) => process\.exit\(0\)\)/.test(src);
};

test('every ops script that sends transactions terminates on success', () => {
  const bad: string[] = [];
  for (const { name, src } of senders()) {
    if (!runsMain(src)) continue; // imported as a library, not run as a CLI
    if (!exitsOnSuccess(src)) bad.push(`scripts/${name}`);
  }
  assert.deepEqual(bad, [], `эти скрипты не завершаются после успеха — добавьте \`.then(() => process.exit(0))\`: ${bad.join(', ')}`);
});

test('mutations: the gate is wired to the code it claims to guard', () => {
  const real = readFileSync(join(SCRIPTS, 'create-lut.ts'), 'utf8');
  assert.equal(exitsOnSuccess(real), true, 'the shipped script is expected to exit');
  // 1. the exact shape that hung: main() with only a .catch()
  const hangs = real.replace(/main\(\)\.then\(\(\) => process\.exit\(0\)\)\.catch/, 'main().catch');
  assert.notStrictEqual(hangs, real, 'mutation did not apply — the script no longer has the exit');
  assert.equal(exitsOnSuccess(hangs), false, 'the mutated text must be recognised as hanging');
  // 2. a script that never sends has nothing to hang on and must not be reported
  assert.equal(runsMain('console.log("no rpc here")\n'), false);
  // 3. the other accepted shape: the exit lives inside main(), before the call
  assert.equal(exitsOnSuccess('async function main() { await send(); process.exit(0); }\nmain().catch(() => process.exit(1));\n'), true);
});
