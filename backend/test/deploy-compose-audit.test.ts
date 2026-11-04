// Регрессии находок 5, 6 и 10 (ops/deploy/docker-compose.yaml, Dockerfile.client, backend/src/config.ts).
//
//   5.  `VITE_API_BASE: /` — клиент собирает URL как `new URL(`${API_BASE}${path}`, origin)`, поэтому
//       «/» + «/me» = «//me», а протокол-относительный URL разбирается как ХОСТ `me`: каждый запрос
//       уходил на чужой домен, а не в `/v1`. nginx проксирует именно `/v1/`, значит база — `/v1`.
//   6.  compose передавал `VITE_SOLANA_RPC`/`VITE_SOLANA_WS` (приложение их не читает) и не передавал
//       `VITE_RPC_URL`, `VITE_DAS_RPC_URL`, `VITE_LAUNCH_PHASE` и флаги: браузер молча шёл на публичный
//       `clusterApiUrl('mainnet-beta')`, а фазовый запуск выглядел как full.
//   10. `COMPLIANCE_ENFORCE: ${COMPLIANCE_ENFORCE:-0}` при `NODE_ENV: production` — дефолтный `ops:up`
//       из этой же папки не поднимался никогда: config.ts в production требует `=1`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = join(__dirname, '..', '..');
const compose = readFileSync(join(repo, 'ops/deploy/docker-compose.yaml'), 'utf8');
const dockerfile = readFileSync(join(repo, 'ops/deploy/Dockerfile.client'), 'utf8');
const config = readFileSync(join(repo, 'backend/src/config.ts'), 'utf8');

const clientArgs = (() => {
  const at = compose.indexOf('      args:');
  const rest = compose.slice(at);
  const end = rest.indexOf('\n    image:');
  const block = rest.slice(0, end < 0 ? undefined : end);
  return new Map(
    [...block.matchAll(/^\s+(VITE_[A-Z0-9_]+):\s*(.+)$/gm)].map((m) => [m[1]!, m[2]!.trim()]),
  );
})();

describe('compose: имена, которые реально читает клиент', () => {
  it('находка 5: база API — /v1, а не «/» (иначе //me разбирается как хост me)', () => {
    expect(clientArgs.get('VITE_API_BASE')).toBe('/v1');
    // и сам контракт клиента: относительная база без ведущего слеша не даёт протокол-относительный URL
    const base = '/v1';
    expect(new URL(`${base}/me`, 'https://app.example').href).toBe('https://app.example/v1/me');
    // то, что было: доказательство механизма
    expect(new URL(`${'/'}${'/me'}`, 'https://app.example').host).toBe('me');
  });

  it('находка 6: собираются VITE_RPC_URL / VITE_DAS_RPC_URL / VITE_LAUNCH_PHASE, а не мёртвые VITE_SOLANA_*', () => {
    expect([...clientArgs.keys()]).not.toContain('VITE_SOLANA_RPC');
    expect([...clientArgs.keys()]).not.toContain('VITE_SOLANA_WS');
    for (const name of ['VITE_RPC_URL', 'VITE_RPC_WS_URL', 'VITE_DAS_RPC_URL', 'VITE_LAUNCH_PHASE', 'VITE_PROGRAM_SETTLE']) {
      expect(clientArgs.has(name), `${name} must be a build arg`).toBe(true);
    }
    // имена, которые читает приложение, должны быть объявлены в образе
    const read = [...new Set([...config.matchAll(/env\.(VITE_[A-Z0-9_]+)/g)].map((m) => m[1]!))];
    const declared = new Set([...dockerfile.matchAll(/^ARG (VITE_[A-Z0-9_]+)/gm)].map((m) => m[1]!));
    expect(read.filter((n) => !declared.has(n))).toEqual([]);
  });
});

describe('compose: production fail-fast (находка 10)', () => {
  it('дефолт COMPLIANCE_ENFORCE совпадает с тем, что требует config.ts в production', () => {
    const requiresOne = /COMPLIANCE_ENFORCE\s*!==\s*'1'/.test(config);
    const line = compose.split('\n').find((l) => /^\s+COMPLIANCE_ENFORCE:/.test(l)) ?? '';
    expect(line, 'compose must set COMPLIANCE_ENFORCE').not.toBe('');
    expect(line).not.toContain(':-0}');           // то, из-за чего дефолтный запуск падал на старте
    // Либо явное обязательное значение (`:?`), либо дефолт, совпадающий с требованием кода.
    if (requiresOne) expect(line).toMatch(/:\?|:-1\}/);
  });

  it('секретные и адресные значения деплоя не получают молчаливых дефолтов', () => {
    // `:?` — единственная форма, при которой отсутствие значения видно оператору, а не превращается
    // в заглушку, которую заметит только игрок.
    expect(clientArgs.get('VITE_RPC_URL') ?? '').toContain(':?');
    for (const name of ['PROGRAM_CHIP_CORE', 'PROGRAM_SETTLE', 'CG_MINT']) {
      const line = compose.split('\n').find((l) => l.includes(`\${${name}:?`)) ?? '';
      expect(line, `${name} must be required with :?`).not.toBe('');
    }
  });
});
