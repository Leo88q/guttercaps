import { afterEach, expect, it, vi } from 'vitest';
import { Keypair, type Connection } from '@solana/web3.js';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { battleSignerPublicKey, checkMacBattle, BATTLE_LAUNCH_RESERVE } from '../src/battle-preflight.ts';
import { arenaConfigPda } from '../src/arena-config.ts';
import { FakeConnection, encodeArenaConfig, ARENA_ID, pk } from './chainFixtures.ts';
import type {} from '../../scripts/mac-battle-preflight.mts';

const dirs: string[] = [];
function temp() { const dir = mkdtempSync(join(tmpdir(), 'battle-preflight-')); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function world() {
  const signer = pk();
  const conn = Object.assign(new FakeConnection(), { getGenesisHash: vi.fn(async () => 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG') });
  const cfg = { admin: pk(), battleOracle: signer, cgMint: pk(), seasonPool: pk(), treasuryCg: pk() };
  conn.set(arenaConfigPda()[0], encodeArenaConfig(cfg), ARENA_ID);
  conn.balanceLamports = BATTLE_LAUNCH_RESERVE;
  return { signer, conn, cfg, check: () => checkMacBattle(conn as unknown as Connection, signer) };
}
it('reads the pinned config, matches authority and fee reserve without submitting', async () => {
  const w = world();
  expect(await w.check()).toMatchObject({ ready: true, readOnly: true, oracle: w.signer.toBase58() });
  expect(w.conn.sent).toHaveLength(0);
});
it('rejects mainnet before looking up an arena config', async () => {
  const w = world(); w.conn.getGenesisHash.mockResolvedValue('mainnet');
  const read = vi.spyOn(w.conn, 'getAccountInfo');
  await expect(w.check()).rejects.toMatchObject({ code: 'battle_requires_devnet' });
  expect(read).not.toHaveBeenCalled(); expect(w.conn.sent).toHaveLength(0);
});
it.each(['missing', 'owner', 'schema', 'mismatch', 'paused', 'balance'] as const)('refuses %s without changing config or sending funds', async reason => {
  const w = world();
  if (reason === 'missing') w.conn.accounts.clear();
  if (reason === 'owner') w.conn.set(arenaConfigPda()[0], encodeArenaConfig(w.cfg), pk());
  if (reason === 'schema') w.conn.set(arenaConfigPda()[0], Buffer.alloc(200), ARENA_ID);
  if (reason === 'mismatch') w.conn.set(arenaConfigPda()[0], encodeArenaConfig({ ...w.cfg, battleOracle: pk() }), ARENA_ID);
  if (reason === 'paused') w.conn.set(arenaConfigPda()[0], encodeArenaConfig({ ...w.cfg, paused: true }), ARENA_ID);
  if (reason === 'balance') w.conn.balanceLamports = BATTLE_LAUNCH_RESERVE - 1;
  const codes = { missing: 'battle_config_missing', owner: 'battle_config_owner', schema: 'battle_config_schema',
    mismatch: 'battle_oracle_mismatch', paused: 'battle_arena_paused', balance: 'battle_fee_reserve_low' };
  await expect(w.check()).rejects.toMatchObject({ code: codes[reason] });
  expect(w.conn.sent).toHaveLength(0);
});
it('does not emit RPC credentials or raw provider exceptions', async () => {
  const w = world(); w.conn.getGenesisHash.mockRejectedValue(new Error('https://rpc.invalid/?api-key=PRIVATE'));
  await expect(w.check()).rejects.toMatchObject({ code: 'battle_rpc_unavailable', message: 'battle_rpc_unavailable', facts: {} });
});
it('reads a validated local keypair without exposing the secret or its path on errors', () => {
  const file = join(temp(), 'signer.json'), key = Keypair.generate();
  writeFileSync(file, JSON.stringify(Array.from(key.secretKey)));
  expect(battleSignerPublicKey(file).equals(key.publicKey)).toBe(true);
  for (const raw of ['bad', '[1,2]', JSON.stringify(Array(64).fill(256))]) {
    writeFileSync(file, raw);
    expect(() => battleSignerPublicKey(file)).toThrow('battle_keypair_unreadable');
  }
  expect(() => battleSignerPublicKey(undefined)).toThrow('battle_keypair_missing');
});

const script = readFileSync(resolve(import.meta.dirname, '../../scripts/mac-devnet.sh'), 'utf8');
const shellFunction = script.slice(script.indexOf('mac_backend_env() {'), script.indexOf('\nstage_run() {'));
it.each([undefined, 'crank,pyth', ''])('Mac defaults only an unset WORKERS, preserves explicit list %s and isolates secrets', workers => {
  const dir = temp(); mkdirSync(join(dir, 'backend'));
  writeFileSync(join(dir, 'backend/.env'), `SESSION_SECRET=TEST_ONLY_SECRET\n${workers === undefined ? '' : `WORKERS='${workers}'\n`}BATTLE_ORACLE_KEYPAIR='/configured key.json'\n`);
  const env = { ...process.env }; delete env.WORKERS; delete env.BATTLE_ORACLE_KEYPAIR; delete env.SESSION_SECRET;
  const run = spawnSync('bash', ['-c', `${shellFunction}\nWALLET='/fallback.json'\n(mac_backend_env && printf '%s|%s\\n' "$WORKERS" "$BATTLE_ORACLE_KEYPAIR")\nprintf 'parent=%s' "\${SESSION_SECRET-unset}"`], { cwd: dir, env, encoding: 'utf8' });
  expect(run.status).toBe(0);
  expect(run.stdout).toBe(`${workers === undefined ? 'crank,pyth,battle' : workers}|/configured key.json\nparent=unset`);
});
it('Mac passes its deployer only as a preflight candidate when no battle key is configured', () => {
  const dir = temp(); mkdirSync(join(dir, 'backend')); writeFileSync(join(dir, 'backend/.env'), '');
  const env = { ...process.env }; delete env.WORKERS; delete env.BATTLE_ORACLE_KEYPAIR;
  const run = spawnSync('bash', ['-c', `${shellFunction}\nWALLET='/candidate key.json'\nmac_backend_env && printf '%s' "$BATTLE_ORACLE_KEYPAIR"`], { cwd: dir, env, encoding: 'utf8' });
  expect(run.status).toBe(0); expect(run.stdout).toBe('/candidate key.json');
  const stage = script.slice(script.indexOf('stage_run() {'));
  expect(stage.indexOf('mac-battle-preflight.mts')).toBeLessThan(stage.indexOf('exec npm run backend:start'));
  expect(stage).toContain(') || die "battle preflight');
});
it.each([['crank,pyth', 0, 'battle_disabled_by_workers'], ['unknown', 1, 'battle_workers_invalid'], ['battle', 1, 'battle_keypair_missing']] as const)('CLI handles %s before any RPC or worker startup', (workers, status, code) => {
  const run = spawnSync(process.execPath, ['--import', 'tsx', resolve(import.meta.dirname, '../../scripts/mac-battle-preflight.mts')], {
    env: { ...process.env, WORKERS: workers, BATTLE_ORACLE_KEYPAIR: '', SOLANA_RPC_URL: 'https://rpc.invalid/?key=PRIVATE' }, encoding: 'utf8', timeout: 15_000,
  });
  expect(run.status).toBe(status); expect(run.stdout).toContain(code);
  expect(run.stdout + run.stderr).not.toContain('PRIVATE');
});
it('resolver no longer falls back to CRANK_KEYPAIR when its own signer is unset', () => {
  const module = new URL('../src/battle-resolver.ts', import.meta.url).href;
  const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `const {battleResolver} = await import(${JSON.stringify(module)}); try { await battleResolver(); process.exitCode=2; } catch(e) { console.log(e.message); }`], {
    env: { ...process.env, BATTLE_ORACLE_KEYPAIR: '', CRANK_KEYPAIR: '/must-not-be-opened' }, encoding: 'utf8', timeout: 15_000,
  });
  expect(run.status).toBe(0);
  expect(run.stdout).toContain('BATTLE_ORACLE_KEYPAIR is required; refusing to use the crank signer');
  expect(run.stdout + run.stderr).not.toContain('/must-not-be-opened');
});
