// `npm run test:validator` / `anchor test` — run the localnet suite against a real validator.
//
//   1. `scripts/anchor-build-localnet.sh` (= `npm run localnet:build`) builds with `--features localnet`
//      (SB_PROGRAM_ID = sb_mock). The script owns the three environment traps a bare `anchor build` trips on:
//      it installs fixtures/sb_mock-keypair.json into target/deploy/ (so sb_mock.so carries the id
//      chip_core::randomness::SB_PROGRAM_ID expects), shims `solana-install` → `agave-install` for the
//      `[toolchain] solana_version` lookup, and refuses to let anchor swap the pinned solana mid-build.
//      Skip it with SKIP_BUILD=1 when target/deploy/*.so are already there.
//   2. loads the Pyth PriceUpdateV2 fixtures fixtures/pyth_{sol,skr}_usd.json (SOL $150 / SKR $0.0174) as
//      genesis accounts owned by the cloned receiver program `rec5…`. Their `publish_time` is 2100-01-01:
//      the receiver SDK only checks `publish_time + 60 ≥ now`, so they never go stale; age-sensitive
//      scenarios are LiteSVM-only (chain.canWarp). Same files are declared in Anchor.toml [[test.validator.account]].
//   3. starts `solana-test-validator` with: our four programs + sb_mock (--upgradeable-program, authority = admin wallet — SEC-F7), mpl-core +
//      pyth receiver cloned from mainnet (--clone, or from `fixtures/*.so` when offline), the Pyth
//      fixtures (--account), and a pre-funded ANCHOR_WALLET
//   4. runs vitest with LOCALNET_RPC=http://127.0.0.1:8899
//   5. stops the validator (KEEP_VALIDATOR=1 keeps it running for a second `LOCALNET_RPC=… npm test`)
//
// Env knobs: SKIP_BUILD, KEEP_VALIDATOR, VALIDATOR_URL (clone source, default mainnet-beta),
// ANCHOR_WALLET (default ~/.config/solana/id.json, created if missing), RPC_PORT (8899),
// MPL_CORE_SO / PYTH_RECEIVER_SO (offline: use dumps instead of --clone), VITEST_ARGS.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { programIdsFromToml } from '../../scripts/lib/anchor-ids.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const PORT = Number(process.env.RPC_PORT ?? 8899);
const RPC = `http://127.0.0.1:${PORT}`;
const CLONE_URL = process.env.VALIDATOR_URL ?? 'https://api.mainnet-beta.solana.com';
const LEDGER = resolve(ROOT, 'test-ledger');
const OUT = resolve(ROOT, 'target/localnet');

/**
 * Id программ берутся из `Anchor.toml` `[programs.localnet]` — единственного источника истины
 * (`npm run program-ids -- apply` пишет его вместе с `declare_id!`). До этого здесь был захардкожен
 * ДРУГОЙ набор (`GCRhrg…`, `GCA2aU…`, `GCuGx7…`, `GCfERi…`): ни один из этих адресов не совпадает с
 * `declare_id!` программ, поэтому валидатор поднимал программы по адресам, которых нет в бандлах, а
 * `settle` (пятая программа) не загружался вовсе — то есть локальная сеть не могла исполнить ни одну
 * из них, и находка 53 «settle не исполняется ни одним тестом» была структурной, а не забывчивостью.
 */
const SB_MOCK_ID = 'ApDh35vcLCxXc5ivaRGFhayn1HduJ9b2nXbfR6WMpVKH'; // localnet-only, не в [programs.localnet]

function localnetPrograms(): [id: string, name: string][] {
  const ids = programIdsFromToml(resolve(ROOT, 'Anchor.toml'), 'localnet');
  // sb_mock — localnet-only стенд Switchboard; он входит в секцию, но .so для него нет.
  return [
    ...ids.filter((p) => p.name !== 'sb_mock').map((p): [string, string] => [p.id, p.name]),
    [SB_MOCK_ID, 'sb_mock'],
  ];
}

const PROGRAMS: [string, string][] = localnetPrograms();
const MPL_CORE = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
const PYTH_RECEIVER = 'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ';

const log = (m: string) => console.log(`[run-validator] ${m}`);
const sh = (cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}) => {
  log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: opts.cwd ?? ROOT, env: { ...process.env, ...opts.env } });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  return r.status ?? 1;
};
const have = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;

/** `solana account --output json`-shaped dump the validator accepts through `--account`. */
function writeAccountDump(path: string, pubkey: PublicKey, owner: string, data: Buffer, lamports = 10_000_000) {
  writeFileSync(path, JSON.stringify({
    pubkey: pubkey.toBase58(),
    account: { lamports, data: [data.toString('base64'), 'base64'], owner, executable: false, rentEpoch: 0, space: data.length },
  }, null, 2));
}

async function waitForRpc(child: ChildProcess, timeoutMs = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`solana-test-validator exited with ${child.exitCode} (see test-ledger/validator.log)`);
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }) });
      if (r.ok && ((await r.json()) as { result?: string }).result === 'ok') return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('validator did not become healthy in time');
}

async function main() {
  for (const bin of ['solana-test-validator', 'solana']) {
    if (!have(bin)) throw new Error(`${bin} not found in PATH — install the Solana CLI (Anchor.toml pins solana 2.1.x) or use \`npm test\` (LiteSVM, no validator needed)`);
  }
  mkdirSync(resolve(ROOT, 'target/deploy'), { recursive: true });
  mkdirSync(OUT, { recursive: true });

  // 1. build with the localnet feature (SB_PROGRAM_ID = sb_mock) — through the script that owns the three
  //    traps: the pinned sb_mock keypair (anchor fabricates one when it is absent, and a fabricated id is not
  //    the one chip_core accepts), the `solana-install` → `agave-install` shim, and the `[toolchain]
  //    solana_version` check. `npm test` needs the same artifacts, so `npm run localnet:build` is the one
  //    documented way to produce them.
  if (!process.env.SKIP_BUILD) {
    if (!have('anchor')) throw new Error('anchor not found in PATH (or set SKIP_BUILD=1 with prebuilt target/deploy/*.so)');
    if (sh('sh', ['scripts/anchor-build-localnet.sh']) !== 0) throw new Error('anchor build failed');
  }
  for (const [, name] of PROGRAMS) {
    const so = resolve(ROOT, 'target/deploy', `${name}.so`);
    if (!existsSync(so)) throw new Error(`missing ${so}`);
  }

  // 3. wallet + Pyth fixtures
  const walletPath = (process.env.ANCHOR_WALLET ?? '~/.config/solana/id.json').replace(/^~/, homedir());
  if (!existsSync(walletPath)) {
    mkdirSync(dirname(walletPath), { recursive: true });
    writeFileSync(walletPath, JSON.stringify(Array.from(Keypair.generate().secretKey)));
    log(`created ${walletPath}`);
  }
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(walletPath, 'utf8'))));
  const fixture = (name: string) => { const f = resolve(ROOT, 'tests/localnet/fixtures', `${name}.json`); return { path: f, pubkey: (JSON.parse(readFileSync(f, 'utf8')) as { pubkey: string }).pubkey }; };
  const pythSol = fixture('pyth_sol_usd');
  const pythSkr = fixture('pyth_skr_usd');
  // admin pre-funded at genesis (airdrops on test validators are capped)
  writeAccountDump(resolve(OUT, 'admin.json'), admin.publicKey, '11111111111111111111111111111111', Buffer.alloc(0), 1_000_000 * 1_000_000_000);

  // 4. validator
  rmSync(LEDGER, { recursive: true, force: true });
  const args = ['--reset', '--quiet', '--ledger', LEDGER, '--rpc-port', String(PORT), '--limit-ledger-size', '50000000'];
  // upgradeable with the admin as upgrade authority: chip_core `initialize` / arena `init_arena` check it (SEC-F7)
  for (const [id, name] of PROGRAMS) {
    const so = resolve(ROOT, 'target/deploy', `${name}.so`);
    // Явная ошибка вместо молчаливого «валидатор поднялся без программы»: без .so любая инструкция
    // падает с AccountNotFound, и тест выглядит как дефект программы.
    if (!existsSync(so)) throw new Error(`[run-validator] ${so} missing — run npm run localnet:build (anchor build) first`);
    args.push('--upgradeable-program', id, so, walletPath);
  }
  const mplSo = process.env.MPL_CORE_SO ?? (existsSync(resolve(ROOT, 'tests/localnet/fixtures/mpl_core.so')) ? resolve(ROOT, 'tests/localnet/fixtures/mpl_core.so') : undefined);
  const recSo = process.env.PYTH_RECEIVER_SO ?? (existsSync(resolve(ROOT, 'tests/localnet/fixtures/pyth_receiver.so')) ? resolve(ROOT, 'tests/localnet/fixtures/pyth_receiver.so') : undefined);
  if (mplSo) args.push('--bpf-program', MPL_CORE, mplSo); else args.push('--url', CLONE_URL, '--clone-upgradeable-program', MPL_CORE);
  if (recSo) args.push('--bpf-program', PYTH_RECEIVER, recSo); else { if (!args.includes('--url')) args.push('--url', CLONE_URL); args.push('--clone-upgradeable-program', PYTH_RECEIVER); }
  for (const f of [pythSol, pythSkr, { pubkey: admin.publicKey.toBase58(), path: resolve(OUT, 'admin.json') }]) args.push('--account', f.pubkey, f.path);
  log(`$ solana-test-validator ${args.join(' ')}`);
  const validator = spawn('solana-test-validator', args, { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  const stop = () => { if (validator.exitCode === null) { log('stopping validator'); validator.kill('SIGTERM'); } };
  process.on('SIGINT', () => { stop(); process.exit(130); });
  process.on('SIGTERM', () => { stop(); process.exit(143); });

  let status = 1;
  try {
    await waitForRpc(validator);
    log(`validator ready at ${RPC} (mpl-core ${mplSo ? 'from dump' : 'cloned'}, pyth receiver ${recSo ? 'from dump' : 'cloned'})`);
    // 5. the suite
    const extra = (process.env.VITEST_ARGS ?? '').split(' ').filter(Boolean);
    status = sh('npx', ['vitest', 'run', '--config', 'tests/localnet/vitest.config.mts', ...extra], {
      env: { LOCALNET_RPC: RPC, ANCHOR_WALLET: walletPath, PYTH_SOL_ACCOUNT: pythSol.pubkey, PYTH_SKR_ACCOUNT: pythSkr.pubkey },
    });
  } finally {
    if (process.env.KEEP_VALIDATOR) {
      log(`validator left running at ${RPC}; re-run with:\n  LOCALNET_RPC=${RPC} ANCHOR_WALLET=${walletPath} npm test`);
      validator.unref();
    } else stop();
  }
  process.exit(status);
}

main().catch((e) => { console.error(`[run-validator] ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
