// Reproducer for the client-image build wiring (ops/deploy/Dockerfile.client + docker-compose.yaml).
// The bundle is baked at build time, so a VITE_ name that the code reads but the image cannot declare is
// permanently a constant, and a name the image declares but the code never reads is a knob that does
// nothing while the build prints "build args ok".
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = join(__dirname, '..', '..');
const dockerfile = readFileSync(join(repo, 'ops/deploy/Dockerfile.client'), 'utf8');
const compose = readFileSync(join(repo, 'ops/deploy/docker-compose.yaml'), 'utf8');
const config = readFileSync(join(repo, 'client/src/app/config.ts'), 'utf8');

const read = new Set([...config.matchAll(/env\.(VITE_[A-Z0-9_]+)/g)].map((m) => m[1]!));
const declared = new Set([...dockerfile.matchAll(/ARG (VITE_[A-Z0-9_]+)/g)].map((m) => m[1]!));
const declaredGuard = new Set(
  (dockerfile.match(/const DECLARED = new Set\(\[(.*?)\]\)/s)?.[1] ?? '')
    .split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean),
);
const passedByCompose = new Set(
  [...compose.matchAll(/^\s+(VITE_[A-Z0-9_]+):/gm)].map((m) => m[1]!),
);

describe('client image build wiring', () => {
  it('every VITE_ name the client reads can be set on the deployed image', () => {
    const unsettable = [...read].filter((n) => !declared.has(n)).sort();
    console.log(JSON.stringify({ read: [...read].sort(), declared: [...declared].sort(), unsettable }, null, 1));
    // было: VITE_PROGRAM_SETTLE, VITE_LAUNCH_PHASE, VITE_DAS_RPC_URL, VITE_RPC_URL, VITE_RPC_WS_URL, VITE_FLAG_*
    expect(unsettable).toEqual([]);
  });

  it('every declared name is actually read (no dead knobs) and reaches compose', () => {
    const unread = [...declared].filter((n) => !read.has(n)).sort();
    const notInCompose = [...declared].filter((n) => !passedByCompose.has(n)).sort();
    console.log(JSON.stringify({ unread, notInCompose }, null, 1));
    // today: VITE_SOLANA_RPC and VITE_SOLANA_WS are required build args that nothing reads —
    // the client dials VITE_RPC_URL instead, which the image cannot set, so it falls back to
    // clusterApiUrl('mainnet-beta') = https://api.mainnet-beta.solana.com.
    expect(unread).toEqual([]);
  });

  it('the stray-switch guard lists exactly the same names the image declares', () => {
    // `VITE_API_MOCK` объявлен как ARG (иначе его значение не попало бы в сборочное окружение и
    // отказ SEC-B55 не сработал бы), поэтому ожидание — «guard == ровно набор ARG», без добавки.
    expect([...declaredGuard].sort()).toEqual([...declared].sort());
  });
});
