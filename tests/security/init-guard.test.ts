// SEC-F7 (checklist A6 / C17) — `npm run setup` must refuse to adopt a singleton somebody else
// initialised first. The programs are first-caller-wins (no upgrade-authority check), so the deploy
// script is the line of defence: see scripts/init-guard.ts.
//
//   node --experimental-strip-types --test tests/security/*.test.ts      (npm run security:static)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { assessExistingSingleton, b58, expectedAdminsFromEnv, upgradeAuthorityOf, upgradeAuthorityProblem } from '../../scripts/init-guard.ts';

const require = createRequire(import.meta.url);
const { PublicKey } = require('@solana/web3.js') as typeof import('@solana/web3.js');

const key = () => new Uint8Array(randomBytes(32));
const DEPLOYER = key();
const MULTISIG = key();
const ATTACKER = key();
const TREASURY = key();
const BUYBACK = key();
const ZERO = new Uint8Array(32);

/** GameConfig prefix: disc | admin | pending_admin | treasury | buyback | …padding to a realistic size */
function gameConfig(admin: Uint8Array, pending: Uint8Array, treasury = TREASURY, buyback = BUYBACK): Uint8Array {
  const d = new Uint8Array(8 + 32 * 10 + 256);
  d.set(randomBytes(8), 0);
  d.set(admin, 8); d.set(pending, 40); d.set(treasury, 72); d.set(buyback, 104);
  return d;
}
function adminFirst(admin: Uint8Array): Uint8Array {
  const d = new Uint8Array(8 + 32 * 6);
  d.set(admin, 8);
  return d;
}
const expectFrom = (extra: Uint8Array[] = []) => ({
  allowedAdmins: [b58(DEPLOYER), ...extra.map(b58)],
  treasury: b58(TREASURY),
  buyback: b58(BUYBACK),
});

test('b58 matches @solana/web3.js PublicKey#toBase58 (incl. leading-zero keys)', () => {
  for (let i = 0; i < 200; i++) {
    const k = key();
    if (i % 10 === 0) k.fill(0, 0, i % 7); // leading zero bytes → leading '1's
    assert.equal(b58(k), new PublicKey(k).toBase58());
  }
  assert.equal(b58(ZERO), '11111111111111111111111111111111');
});

test('SEC-F7 front-run init: a config whose admin is the attacker is rejected, with the recovery path in the message', () => {
  const v = assessExistingSingleton('chip_core config', gameConfig(ATTACKER, ZERO), expectFrom());
  assert.equal(v.ok, false);
  assert.equal(v.admin, b58(ATTACKER));
  assert.match(v.problems.join('\n'), /somebody initialised it first \(SEC-F7\).*redeploy under fresh program ids/s);
  // same for the admin-first singletons
  for (const kind of ['arena config', 'staking emission'] as const) {
    assert.equal(assessExistingSingleton(kind, adminFirst(ATTACKER), expectFrom()).ok, false, kind);
  }
});

test('SEC-F7: naming US as pending_admin does not launder a hijacked config (the attacker stays admin until we accept)', () => {
  assert.equal(assessExistingSingleton('chip_core config', gameConfig(ATTACKER, DEPLOYER), expectFrom()).ok, false);
  assert.equal(assessExistingSingleton('chip_core config', gameConfig(ATTACKER, MULTISIG), expectFrom([MULTISIG])).ok, false);
});

test('our own config passes: deployer admin, multisig after hand-over (SETUP_EXPECTED_ADMINS), our hand-over in flight', () => {
  assert.equal(assessExistingSingleton('chip_core config', gameConfig(DEPLOYER, ZERO), expectFrom()).ok, true);
  assert.equal(assessExistingSingleton('chip_core config', gameConfig(MULTISIG, ZERO), expectFrom()).ok, false, 'multisig not declared');
  assert.equal(assessExistingSingleton('chip_core config', gameConfig(MULTISIG, ZERO), expectFrom([MULTISIG])).ok, true);
  assert.equal(assessExistingSingleton('chip_core config', gameConfig(DEPLOYER, MULTISIG), expectFrom()).ok, true);
  assert.equal(assessExistingSingleton('arena config', adminFirst(MULTISIG), expectFrom([MULTISIG])).ok, true);
  assert.equal(assessExistingSingleton('staking emission', adminFirst(DEPLOYER), expectFrom()).ok, true);
});

test('treasury / buyback drift on our own config is a loud warning, not a silent pass', () => {
  const v = assessExistingSingleton('chip_core config', gameConfig(DEPLOYER, ZERO, key(), key()), expectFrom());
  assert.equal(v.ok, true);
  assert.equal(v.warnings.length, 2);
  assert.match(v.warnings.join('\n'), /treasury on chain .* ≠ expected/);
});

test('a truncated / foreign account at the PDA is rejected instead of being parsed', () => {
  assert.equal(assessExistingSingleton('chip_core config', new Uint8Array(100), expectFrom()).ok, false);
  assert.equal(assessExistingSingleton('arena config', new Uint8Array(0), expectFrom()).ok, false);
});

test('SETUP_EXPECTED_ADMINS parsing', () => {
  assert.deepEqual(expectedAdminsFromEnv(undefined), []);
  assert.deepEqual(expectedAdminsFromEnv(' A, B\nC  '), ['A', 'B', 'C']);
});

test('setup.ts wires the guard into every singleton step (no bare `exists(…) → skip` left for config / emission / arena)', () => {
  const src = readFileSync(new URL('../../scripts/setup.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /exists\(conn,\s*(configPda|emissionPda|arenaConfigPda)\)/);
  for (const [kind, pda] of [['chip_core config', 'configPda'], ['staking emission', 'emissionPda'], ['arena config', 'arenaConfigPda']]) {
    assert.match(src, new RegExp(`existingIsOurs\\(conn, '${kind}', ${pda}, wallet`), kind);
  }
  // stepMints reuses the mints of an existing config — it must vet it first
  assert.match(src, /if \(cfg\) \{\s*await existingIsOurs\(conn, 'chip_core config', configPda, wallet\)/);
});

/** bincode UpgradeableLoaderState::ProgramData header + a few ELF bytes */
function programData(authority: Uint8Array | null, tag = 3): Uint8Array {
  const d = new Uint8Array(45 + 4);
  new DataView(d.buffer).setUint32(0, tag, true);
  new DataView(d.buffer).setBigUint64(4, 42n, true);
  if (authority) { d[12] = 1; d.set(authority, 13); }
  d.set([0x7f, 0x45, 0x4c, 0x46], 45);
  return d;
}

test('SEC-F7 on-chain gate pre-flight: ProgramData header parsing mirrors chip_core::deploy_guard', () => {
  assert.equal(upgradeAuthorityOf(programData(DEPLOYER)), b58(DEPLOYER));
  assert.equal(upgradeAuthorityOf(programData(null)), null);
  assert.equal(upgradeAuthorityOf(programData(DEPLOYER, 2)), undefined, 'UpgradeableLoaderState::Program, not ProgramData');
  assert.equal(upgradeAuthorityOf(programData(DEPLOYER).subarray(0, 44)), undefined);
});

test('SEC-F7 pre-flight explains every way initialize would hit NotUpgradeAuthority', () => {
  assert.equal(upgradeAuthorityProblem('chip_core', programData(DEPLOYER), b58(DEPLOYER)), null);
  assert.match(upgradeAuthorityProblem('chip_core', programData(MULTISIG), b58(DEPLOYER))!, /run setup with the deploy key/);
  assert.match(upgradeAuthorityProblem('arena', programData(null), b58(DEPLOYER))!, /immutable/);
  assert.match(upgradeAuthorityProblem('arena', null, b58(DEPLOYER))!, /upgradeable loader/);
  assert.match(upgradeAuthorityProblem('arena', programData(DEPLOYER, 1), b58(DEPLOYER))!, /not an upgradeable-loader ProgramData/);
});

test('setup.ts passes the ProgramData account to initialize / init_arena and pre-flights the authority', () => {
  const src = readFileSync(new URL('../../scripts/setup.ts', import.meta.url), 'utf8');
  assert.match(src, /'initialize', \[signer\(wallet\.publicKey\), rw\(configPda\), rw\(vaultPda\), ro\(SystemProgram\.programId\), ro\(programDataOf\(CHIP_CORE\)\)\]/);
  assert.match(src, /'init_arena', \[signer\(wallet\.publicKey\), rw\(arenaConfigPda\), ro\(SystemProgram\.programId\), ro\(programDataOf\(ARENA\)\)\]/);
  assert.match(src, /assertUpgradeAuthority\(conn, 'chip_core', CHIP_CORE, wallet\)/);
  assert.match(src, /assertUpgradeAuthority\(conn, 'arena', ARENA, wallet\)/);
  assert.match(src, /BPFLoaderUpgradeab1e11111111111111111111111/);
});


// Localnet fixtures already provisioned this ATA, but the real setup omitted it:
// stake_cg then fails Anchor 3012 at vault_cg on a fresh deployment.
test('setup provisions the CG staking vault ATA, not only the pack vault and treasury', () => {
  const src = readFileSync(new URL('../../scripts/setup.ts', import.meta.url), 'utf8');
  const step = src.slice(src.indexOf('async function stepAtas('), src.indexOf('async function stepEmission('));
  assert.match(step, /const stakingVault = ata\(mints\.cg, emissionPda\)/);
  assert.match(step, /if \(!\(await exists\(conn, stakingVault\)\)\) ixs\.push\(createAssociatedTokenAccountIdempotentInstruction\(wallet\.publicKey, stakingVault, emissionPda, mints\.cg\)\)/);
});
