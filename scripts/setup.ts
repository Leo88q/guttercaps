// One-time admin setup of the four programs — run once per deployment (devnet, then mainnet).
//
//   ANCHOR_WALLET=~/.config/solana/id.json ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
//     npm run setup [-- --step <name>]
//
// Steps (idempotent — every step checks the account it creates and skips when present; an existing config /
// arena config / emission must have the deployer or SETUP_EXPECTED_ADMINS as admin, else setup aborts — SEC-F7):
//   mints        devnet: $CG mint (authority = wallet, handed to the staking emission PDA by `emission`)
//                        + USDC / SKR stand-in mints (or reuse CG_MINT / USDC_MINT / SKR_MINT from env)
//                mainnet: CG_MINT must be given (created by the treasury multisig); USDC/SKR are the real mints
//   initialize   chip_core `initialize` (treasury / buyback / mints / Pyth accounts)
//   ledgers      chip_core `init_ledger` × LEDGER_SHARDS — the VaultLedger liability shards (#12; permissionless, buy_pack needs them)
//   collections  chip_core `create_collection` × 8 from packages/economy/src/lore.ts (Core collections, Royalties 250 bps)
//   atas         vault / treasury / buyback token accounts for $CG, USDC, SKR (buy_pack / sweep_vault assume they exist)
//   emission     staking `init_emission` (takes the $CG mint authority; oracles = QUEST_ORACLE / SEASON_ORACLE / SET_ORACLE env)
//   arena        arena `init_arena` (battle oracle = BATTLE_ORACLE env, season pool = emission's $CG ATA)
//   burn-oracle  staking `set_oracles(burn_oracle)` (SEC-M1; only when BURN_ORACLE is set — the backend keeper's pubkey)
//
// Not here on purpose: SKR prize pool (`npm run skr-pool -- init`), Pyth pusher + `set_params` for the price accounts
// (`npm run pyth-pusher -- set-params-args`), the lookup table (`npm run create-lut -- create`).
//
// Env: TREASURY (default: Squads HPMr… on mainnet, wallet on devnet), BUYBACK_WALLET (default: TREASURY),
//      BATTLE_ORACLE / QUEST_ORACLE / SEASON_ORACLE / SET_ORACLE (default: wallet — replace before G-1), BURN_ORACLE (no default),
//      ORACLE_DAILY_CAP_CG (default 120 000 = one baseline day of wager pots, SEC-F06), GENESIS_TS (default now), METADATA_BASE (default https://cdn.guttercaps.gg/c),
//      SETUP_EXPECTED_ADMINS (extra admin keys an EXISTING config/arena/emission may have, e.g. the Squads multisig after the hand-over — SEC-F7),
//      PYTH_SOL_ACCOUNT / PYTH_SKR_ACCOUNT (default: the 0xCA75 shard PDAs, see client/src/chain/ids.ts), DRY_RUN=1.
//
// The same sequence boots the localnet acceptance suite (tests/localnet/helpers/env.ts) — keep the account orders in sync.
//
// Mainnet pre-flight (runs before any step, also under DRY_RUN): the effective program ids must not be the
// [programs.devnet] / [programs.localnet] placeholders of Anchor.toml (SEC-F05 — `program-ids guard-mainnet`
// enforced, not just available), and the chip_core / arena bytes already on chain must carry the mainnet
// Switchboard pins (SEC-F19, scripts/verify-deploy.ts) — a devnet/localnet-featured build initialised on
// mainnet would accept a forged randomness oracle.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { sha256 } from '@noble/hashes/sha256';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  MINT_SIZE, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createInitializeMint2Instruction, getAssociatedTokenAddressSync,
} from '@solana/spl-token';
// The canonical lore, NOT the client's re-export (`client/src/shared/lib/lore.ts`): this script runs under
// bare Node (`node --experimental-strip-types`, see package.json → setup), which resolves relative paths and
// node_modules and nothing else — the client file imports `@/shared/i18n` (a Vite/tsconfig alias) and React,
// so importing it killed the setup stage with `ERR_MODULE_NOT_FOUND: Cannot find package '@/shared'` before
// a single instruction was built. Same import as `scripts/art-pipeline.ts`.
import { COLLECTIONS } from '../packages/economy/src/lore.ts';
import { ARENA_ORACLE_DAILY_CAP_DEFAULT_CG, EMISSION_SPLIT } from '../packages/economy/src/tokenomics.ts';
import { assessPins, fetchDeployedProgram, sha256hex, trimPadding } from './verify-deploy.ts';
import { assessExistingSingleton, expectedAdminsFromEnv, upgradeAuthorityProblem, type Singleton } from './init-guard.ts';

// ---------------------------------------------------------------- constants (mirror client/src/app/config.ts + chain/ids.ts)
const RPC = process.env.ANCHOR_PROVIDER_URL ?? 'https://api.devnet.solana.com';
const MAINNET = RPC.includes('mainnet');
const DRY_RUN = process.env.DRY_RUN === '1';
const CHIP_CORE = new PublicKey(process.env.PROGRAM_CHIP_CORE ?? 'J68G8KrbLTSdi68LHr9Kkw1YbRRHv3uBPirWCd5Xt13V');
const MARKET = new PublicKey(process.env.PROGRAM_MARKET ?? '5skEmmhgFYn5xjHEdrcsiQ68kUg5kvhXKhjWTWSppjfo');
const STAKING = new PublicKey(process.env.PROGRAM_STAKING ?? 'Ewkbp7WpqbiJAu3ofEcTPinqnr5oH3e94YJDZFg1eSJn');
const ARENA = new PublicKey(process.env.PROGRAM_ARENA ?? 'DUTokrhWBYL7nJ9VbMy7bFELQFf8TN1tmvVpKLsskqD6');
const MPL_CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const MPL_BUBBLEGUM_V2 = new PublicKey('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
const MPL_NOOP = new PublicKey('mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3');
const MPL_ACCOUNT_COMPRESSION = new PublicKey('mcmt6YrQEMKw8Mw43FmpRLmf7BqRnFMKmAcbxE3xkAW');
const SQUADS_TREASURY = new PublicKey('HPMr5r9sS5ApWsPNJytZRLbm2jz1veFxTn1wepjAhtho');
const REAL_USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const DEVNET_USDC = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const REAL_SKR = new PublicKey('SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3');
const PYTH_SOL = new PublicKey(process.env.PYTH_SOL_ACCOUNT ?? 'ELp9x5sFxGJ7zTurykU2p6A9nKDx72b3xzPxfsB5S8GB');
const PYTH_SKR = new PublicKey(process.env.PYTH_SKR_ACCOUNT ?? '9bCSdQVWckgKipe4G3G66aYU9yq2ZdDn8kRPZB9Nihbc');
/** lore element per collection index (client/src/shared/lib/rarity.ts ELEMENT_OF_COLLECTION) → on-chain u8 */
const ELEMENT_OF_COLLECTION = ['shadow', 'wheels', 'steel', 'wheels', 'noise', 'shadow', 'noise', 'wheels', 'paint', 'paint'] as const;
const ELEMENT_INDEX: Record<string, number> = { paint: 0, steel: 1, wheels: 2, noise: 3, shadow: 4 };
const METADATA_BASE = process.env.METADATA_BASE ?? 'https://cdn.guttercaps.gg/c';
const MICRO = 1_000_000n;

// ---------------------------------------------------------------- tiny anchor/borsh helpers (no IDL needed)
const disc = (name: string) => Buffer.from(sha256(`global:${name}`).subarray(0, 8));
const ro = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
const rw = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
const signer = (pubkey: PublicKey, isWritable = true) => ({ pubkey, isSigner: true, isWritable });
class W {
  private parts: Buffer[] = [];
  u8(v: number) { this.parts.push(Buffer.from([v & 0xff])); return this; }
  u16(v: number) { const b = Buffer.alloc(2); b.writeUInt16LE(v); this.parts.push(b); return this; }
  u32(v: number) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); this.parts.push(b); return this; }
  u64(v: bigint) { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); this.parts.push(b); return this; }
  i64(v: bigint) { const b = Buffer.alloc(8); b.writeBigInt64LE(v); this.parts.push(b); return this; }
  pubkey(k: PublicKey) { this.parts.push(Buffer.from(k.toBytes())); return this; }
  string(s: string) { const e = Buffer.from(s, 'utf8'); const l = Buffer.alloc(4); l.writeUInt32LE(e.length); this.parts.push(l, e); return this; }
  bytes() { return Buffer.concat(this.parts); }
}
const ix = (programId: PublicKey, name: string, keys: ReturnType<typeof ro>[], args: Buffer = Buffer.alloc(0)) =>
  new TransactionInstruction({ programId, keys, data: Buffer.concat([disc(name), args]) });
const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];
const ata = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true);

const configPda = pda([Buffer.from('config')], CHIP_CORE);
const vaultPda = pda([Buffer.from('vault')], CHIP_CORE);
/** #12 — mirrors chip_core `state::LEDGER_SHARDS` (sync-check pins it). */
const LEDGER_SHARDS = 4;
const ledgerPda = (shard: number) => pda([Buffer.from('ledger'), Buffer.from([shard])], CHIP_CORE);
const collectionMetaPda = (i: number) => pda([Buffer.from('collection'), Buffer.from([i])], CHIP_CORE);
const bubblegumTreeMetaPda = (i: number) => pda([Buffer.from('bubblegum_tree'), Buffer.from([i])], CHIP_CORE);
const treeConfigPda = (merkleTree: PublicKey) => pda([merkleTree.toBuffer()], MPL_BUBBLEGUM_V2);
const cmtAccountSize = (maxDepth: number, maxBufferSize: number, canopy = 0) =>
  56 + 24 + (maxBufferSize + 1) * (40 + 32 * maxDepth) + (canopy > 0 ? ((1 << (canopy + 1)) - 2) * 32 : 0);
const emissionPda = pda([Buffer.from('emission')], STAKING);
/** SEC-L5: authority of the arena's season pool — staking spends it with `fund_slice` (NOT the emission PDA, whose $CG ATA is the staking vault). */
const seasonPoolAuthPda = pda([Buffer.from('season_pool')], STAKING);
const tokenPoolPda = pda([Buffer.from('token_pool')], STAKING);
const chipPoolPda = pda([Buffer.from('chip_pool')], STAKING);
const arenaConfigPda = pda([Buffer.from('arena_config')], ARENA);
/** SEC-F7: ProgramData (upgradeable-loader PDA `[program_id]`) — `initialize` / `init_arena` accept only its upgrade authority, i.e. run setup with the deploy key. */
const BPF_LOADER_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const programDataOf = (program: PublicKey) => pda([program.toBuffer()], BPF_LOADER_UPGRADEABLE);

function loadWallet(): Keypair {
  const p = (process.env.ANCHOR_WALLET ?? '~/.config/solana/id.json').replace(/^~/, homedir());
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));
}
const envKey = (name: string, dflt: PublicKey) => (process.env[name] ? new PublicKey(process.env[name]!) : dflt);

async function send(conn: Connection, payer: Keypair, ixs: TransactionInstruction[], label: string, extra: Keypair[] = []) {
  if (DRY_RUN) { console.log(`[dry-run] ${label}: ${ixs.length} ix`); return 'dry-run'; }
  const tx = new Transaction().add(...ixs);
  const sig = await sendAndConfirmTransaction(conn, tx, [payer, ...extra], { commitment: 'confirmed' });
  console.log(`  ✓ ${label}: ${sig}`);
  return sig;
}
const exists = async (conn: Connection, key: PublicKey) => (await conn.getAccountInfo(key, 'confirmed')) !== null;

/** SEC-F7: the init instructions only accept the upgrade authority — fail with a readable reason before sending. */
async function assertUpgradeAuthority(conn: Connection, label: string, program: PublicKey, wallet: Keypair) {
  const pd = await conn.getAccountInfo(programDataOf(program), 'confirmed');
  const problem = upgradeAuthorityProblem(label, pd ? new Uint8Array(pd.data) : null, wallet.publicKey.toBase58());
  if (problem) throw new Error(`SEC-F7 upgrade-authority pre-flight FAILED: ${problem}`);
}

/** SEC-F7: an existing singleton (config / arena config / emission) must be OURS before a step skips it —
 *  the programs let the first caller initialise, so a front-run init would otherwise be adopted silently.
 *  Returns true when the account exists and passes (→ skip), false when absent (→ create), throws when hijacked. */
async function existingIsOurs(conn: Connection, kind: Singleton, key: PublicKey, wallet: Keypair, expect: { treasury?: PublicKey; buyback?: PublicKey } = {}): Promise<boolean> {
  const info = await conn.getAccountInfo(key, 'confirmed');
  if (!info) return false;
  const v = assessExistingSingleton(kind, info.data, {
    allowedAdmins: [wallet.publicKey.toBase58(), ...expectedAdminsFromEnv(process.env.SETUP_EXPECTED_ADMINS)],
    treasury: expect.treasury?.toBase58(),
    buyback: expect.buyback?.toBase58(),
  });
  for (const w of v.warnings) console.warn(`  !! ${w}`);
  if (!v.ok) throw new Error(`SEC-F7 init guard FAILED:\n  - ${v.problems.join('\n  - ')}`);
  console.log(`  ${kind}: exists, admin ${v.admin} is expected — skip`);
  return true;
}

// ---------------------------------------------------------------- GameConfig readers (offsets: 8 disc + admin, pending, treasury, buyback, cg, usdc, skr, staking, pythSol, pythSkr)
function readConfig(data: Buffer) {
  const pk = (o: number) => new PublicKey(data.subarray(o, o + 32));
  const collectionsCreatedOffset = 8 + 32 * 10 + 1 + 1 + 42 * 4 + 2 + 2; // featured u8, paused bool, packs [PackDef;4], market_fee u16, skr_discount u16
  return { admin: pk(8), cgMint: pk(8 + 32 * 4), usdcMint: pk(8 + 32 * 5), skrMint: pk(8 + 32 * 6), collectionsCreated: data.readUInt8(collectionsCreatedOffset) };
}

// ---------------------------------------------------------------- steps
async function stepMints(conn: Connection, wallet: Keypair) {
  const out = { cg: process.env.CG_MINT ? new PublicKey(process.env.CG_MINT) : undefined, usdc: envKey('USDC_MINT', MAINNET ? REAL_USDC : DEVNET_USDC), skr: process.env.SKR_MINT ? new PublicKey(process.env.SKR_MINT) : MAINNET ? REAL_SKR : undefined };
  const cfg = await conn.getAccountInfo(configPda, 'confirmed');
  if (cfg) {
    await existingIsOurs(conn, 'chip_core config', configPda, wallet); // never reuse the mints of a hijacked config
    const c = readConfig(cfg.data);
    console.log(`  config exists — reusing its mints (cg ${c.cgMint.toBase58()}, usdc ${c.usdcMint.toBase58()}, skr ${c.skrMint.toBase58()})`);
    return { cg: c.cgMint, usdc: c.usdcMint, skr: c.skrMint };
  }
  const create = async (label: string) => {
    const mint = Keypair.generate();
    await send(conn, wallet, [
      SystemProgram.createAccount({ fromPubkey: wallet.publicKey, newAccountPubkey: mint.publicKey, lamports: await conn.getMinimumBalanceForRentExemption(MINT_SIZE), space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
      createInitializeMint2Instruction(mint.publicKey, 6, wallet.publicKey, null),
    ], `create ${label} mint ${mint.publicKey.toBase58()}`, [mint]);
    return mint.publicKey;
  };
  if (!out.cg) {
    if (MAINNET) throw new Error('mainnet: CG_MINT is required (created by the treasury multisig with the wallet as temporary mint authority)');
    out.cg = await create('$CG');
  }
  if (!out.skr) out.skr = await create('SKR (devnet stand-in)');
  return out as { cg: PublicKey; usdc: PublicKey; skr: PublicKey };
}

async function stepInitialize(conn: Connection, wallet: Keypair, mints: { cg: PublicKey; usdc: PublicKey; skr: PublicKey }, treasury: PublicKey, buyback: PublicKey) {
  if (await existingIsOurs(conn, 'chip_core config', configPda, wallet, { treasury, buyback })) return;
  await assertUpgradeAuthority(conn, 'chip_core', CHIP_CORE, wallet);
  const args = new W().pubkey(treasury).pubkey(buyback).pubkey(mints.cg).pubkey(mints.usdc).pubkey(mints.skr).pubkey(STAKING).pubkey(PYTH_SOL).pubkey(PYTH_SKR).bytes();
  await send(conn, wallet, [ix(CHIP_CORE, 'initialize', [signer(wallet.publicKey), rw(configPda), rw(vaultPda), ro(SystemProgram.programId), ro(programDataOf(CHIP_CORE))], args)], 'initialize');
}

async function stepLedgers(conn: Connection, wallet: Keypair) {
  const missing: number[] = [];
  for (let i = 0; i < LEDGER_SHARDS; i++) if (!(await exists(conn, ledgerPda(i)))) missing.push(i);
  if (!missing.length) { console.log(`  ledgers: all ${LEDGER_SHARDS} shards exist — skip`); return; }
  await send(conn, wallet, missing.map((i) => ix(CHIP_CORE, 'init_ledger', [signer(wallet.publicKey), rw(ledgerPda(i)), ro(SystemProgram.programId)], new W().u8(i).bytes())), `init_ledger ${missing.join(',')}`);
}

async function stepCollections(conn: Connection, wallet: Keypair) {
  const cfg = await conn.getAccountInfo(configPda, 'confirmed');
  if (!cfg) throw new Error('run `initialize` first');
  let created = readConfig(cfg.data).collectionsCreated;
  for (let i = created; i < COLLECTIONS.length; i++) {
    const c = COLLECTIONS[i];
    const core = Keypair.generate();
    const args = new W().u8(i).string(c.symbol).string(c.name).string(`${METADATA_BASE}/${i}.json`).u8(ELEMENT_INDEX[ELEMENT_OF_COLLECTION[i]]).bytes();
    await send(conn, wallet, [ix(CHIP_CORE, 'create_collection', [signer(wallet.publicKey), rw(configPda), rw(collectionMetaPda(i)), signer(core.publicKey), ro(MPL_CORE), ro(SystemProgram.programId)], args)], `create_collection ${i} ${c.symbol} (core ${core.publicKey.toBase58()})`, [core]);
    created++;
  }
  console.log(`  collections: ${created}/${COLLECTIONS.length}`);
}

async function stepTrees(conn: Connection, wallet: Keypair) {
  const maxDepth = Number(process.env.TREE_MAX_DEPTH ?? '5');
  const canopy = Number(process.env.TREE_CANOPY ?? '0');
  const maxBufferSize = Number(process.env.TREE_MAX_BUFFER_SIZE ?? '8');
  const space = cmtAccountSize(maxDepth, maxBufferSize, canopy);
  const rent = DRY_RUN ? 0 : await conn.getMinimumBalanceForRentExemption(space);
  let ready = 0;
  for (let i = 0; i < COLLECTIONS.length; i++) {
    const c = COLLECTIONS[i];
    const treeMeta = bubblegumTreeMetaPda(i);
    if (await exists(conn, treeMeta)) {
      console.log(`  tree ${i} ${c.symbol} (${treeMeta.toBase58()}) exists — skip`);
      ready++;
      continue;
    }
    const merkleTree = Keypair.generate();
    const allocIx = SystemProgram.createAccount({
      fromPubkey: wallet.publicKey,
      newAccountPubkey: merkleTree.publicKey,
      lamports: rent,
      space,
      programId: MPL_ACCOUNT_COMPRESSION,
    });
    const args = new W().u8(i).u8(maxDepth).u8(canopy).u32(maxBufferSize).bytes();
    const createIx = ix(
      CHIP_CORE,
      'create_bubblegum_tree',
      [
        signer(wallet.publicKey),
        ro(configPda),
        ro(collectionMetaPda(i)),
        rw(treeMeta),
        rw(merkleTree.publicKey),
        rw(treeConfigPda(merkleTree.publicKey)),
        ro(MPL_BUBBLEGUM_V2),
        ro(MPL_NOOP),
        ro(MPL_ACCOUNT_COMPRESSION),
        ro(SystemProgram.programId),
      ],
      args,
    );
    await send(conn, wallet, [allocIx, createIx], `create_bubblegum_tree ${i} ${c.symbol} (merkle ${merkleTree.publicKey.toBase58()}, d=${maxDepth}/b=${maxBufferSize}/c=${canopy})`, [merkleTree]);
    ready++;
  }
  console.log(`  trees: ${ready}/${COLLECTIONS.length}`);
}

async function stepAtas(conn: Connection, wallet: Keypair, mints: { cg: PublicKey; usdc: PublicKey; skr: PublicKey }, treasury: PublicKey, buyback: PublicKey) {
  const ixs: TransactionInstruction[] = [];
  for (const m of [mints.cg, mints.usdc, mints.skr]) {
    for (const owner of [vaultPda, treasury, buyback]) {
      if (!(await exists(conn, ata(m, owner)))) ixs.push(createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, ata(m, owner), owner, m));
    }
  }
  // stake_cg requires vault_cg to be an initialized TokenAccount. init_emission only
  // creates emission + the two pools; do not confuse this vault with chip_core's vault.
  const stakingVault = ata(mints.cg, emissionPda);
  if (!(await exists(conn, stakingVault))) ixs.push(createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, stakingVault, emissionPda, mints.cg));
  if (ixs.length === 0) { console.log('  atas: all present — skip'); return; }
  await send(conn, wallet, ixs, `create ${ixs.length} token accounts (vault / treasury / buyback / staking)`);
}

async function stepEmission(conn: Connection, wallet: Keypair, cg: PublicKey) {
  if (await existingIsOurs(conn, 'staking emission', emissionPda, wallet)) return;
  const oracles = { quest: envKey('QUEST_ORACLE', wallet.publicKey), season: envKey('SEASON_ORACLE', wallet.publicKey), set: envKey('SET_ORACLE', wallet.publicKey) };
  const split = [EMISSION_SPLIT.chipStaking, EMISSION_SPLIT.tokenStaking, EMISSION_SPLIT.quests, EMISSION_SPLIT.pvpSeason, EMISSION_SPLIT.eventsReserve].map((p) => p * 100);
  const w = new W().pubkey(CHIP_CORE).pubkey(MARKET).pubkey(ARENA).pubkey(oracles.quest).pubkey(oracles.season).pubkey(oracles.set);
  for (const s of split) w.u16(s);
  w.i64(BigInt(process.env.GENESIS_TS ?? 0)); // 0 → now (program default)
  await send(conn, wallet, [ix(STAKING, 'init_emission', [signer(wallet.publicKey), rw(emissionPda), rw(tokenPoolPda), rw(chipPoolPda), rw(cg), ro(TOKEN_PROGRAM_ID), ro(SystemProgram.programId)], w.bytes())], 'init_emission ($CG mint authority → emission PDA)');
  for (const [k, v] of Object.entries(oracles)) if (v.equals(wallet.publicKey)) console.warn(`  !! ${k} oracle = deployer wallet — set ${k.toUpperCase()}_ORACLE and call set_oracles before G-1`);
  console.warn('  !! burn oracle (SEC-M1) is unset after init_emission — run `npm run setup -- --step burn-oracle` with BURN_ORACLE=<pubkey of backend BURN_ORACLE_KEYPAIR> before G-0, otherwise emission stays at the 30 % floor');
}

/** SEC-M1: designate the backend burn-oracle key (`set_oracles { burn_oracle: Some(BURN_ORACLE) }`); other oracles untouched. */
async function stepBurnOracle(conn: Connection, wallet: Keypair) {
  const key = process.env.BURN_ORACLE;
  if (!key) { console.log('  burn-oracle: BURN_ORACLE not set — skip'); return; }
  const burn = new PublicKey(key);
  const w = new W().u8(0).u8(0).u8(0).u8(1).pubkey(burn); // OraclePatch { quest: None, season: None, set: None, burn_oracle: Some(burn) }
  await send(conn, wallet, [ix(STAKING, 'set_oracles', [signer(wallet.publicKey), rw(emissionPda)], w.bytes())], `set_oracles(burn_oracle = ${burn.toBase58()})`);
}

async function stepArena(conn: Connection, wallet: Keypair, cg: PublicKey, treasury: PublicKey) {
  if (await existingIsOurs(conn, 'arena config', arenaConfigPda, wallet)) return;
  await assertUpgradeAuthority(conn, 'arena', ARENA, wallet);
  const oracle = envKey('BATTLE_ORACLE', wallet.publicKey);
  // SEC-F06: the cap bounds what a leaked battle-oracle key can misdirect per 24 h. The default is the
  // economy model's baseline daily pot volume (120 000 $CG at 5 000 DAU), not a round million; raise
  // it with `set_arena` (backend/src/admin.ts) when ArenaOracleCapNearlyExhausted fires for real volume.
  const cap = BigInt(process.env.ORACLE_DAILY_CAP_CG ?? ARENA_ORACLE_DAILY_CAP_DEFAULT_CG) * MICRO;
  const seasonPool = ata(cg, seasonPoolAuthPda);
  const ixs: TransactionInstruction[] = [];
  if (!(await exists(conn, seasonPool))) ixs.push(createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, seasonPool, seasonPoolAuthPda, cg));
  ixs.push(ix(ARENA, 'init_arena', [signer(wallet.publicKey), rw(arenaConfigPda), ro(SystemProgram.programId), ro(programDataOf(ARENA))], new W().pubkey(oracle).pubkey(cg).pubkey(seasonPool).pubkey(ata(cg, treasury)).u64(cap).bytes()));
  await send(conn, wallet, ixs, `init_arena (oracle ${oracle.toBase58()}, cap ${cap / MICRO} $CG/day)`);
  if (oracle.equals(wallet.publicKey)) console.warn('  !! battle oracle = deployer wallet — set BATTLE_ORACLE (backend resolver key) and call set_arena before G-1');
}

// ---------------------------------------------------------------- mainnet pre-flight (SEC-F05 / SEC-F19)
/** `[programs.<section>]` of Anchor.toml, parsed here: scripts/program-ids.ts is a CLI (top-level switch), not a module. */
function anchorIds(section: string): Record<string, string> {
  const toml = readFileSync(new URL('../Anchor.toml', import.meta.url), 'utf8');
  const parts = toml.split(/^\[programs\.(\w+)\]\s*$/m);
  const out: Record<string, string> = {};
  for (let i = 1; i < parts.length; i += 2) {
    if (parts[i] !== section) continue;
    for (const m of parts[i + 1].matchAll(/^(\w+)\s*=\s*"([^"]+)"/gm)) out[m[1]] = m[2];
  }
  return out;
}

async function mainnetPreflight(conn: Connection): Promise<void> {
  if (!MAINNET) return;
  const effective: Record<string, PublicKey> = { chip_core: CHIP_CORE, market: MARKET, staking: STAKING, arena: ARENA };
  const problems: string[] = [];
  for (const section of ['devnet', 'localnet']) {
    const ids = anchorIds(section);
    for (const [p, id] of Object.entries(effective)) {
      if (ids[p] === id.toBase58()) problems.push(`${p} = ${id.toBase58()} is the [programs.${section}] placeholder — regenerate (npm run program-ids -- new / apply) and pass PROGRAM_${p.toUpperCase()}`);
    }
  }
  if (problems.length) throw new Error(`mainnet pre-flight (SEC-F05) FAILED:\n  - ${problems.join('\n  - ')}`);
  for (const p of ['chip_core', 'arena'] as const) {
    const d = await fetchDeployedProgram(conn, effective[p]);
    console.log(`  ${p}: deployed at slot ${d.slot}, upgrade authority ${d.authority?.toBase58() ?? 'NONE (immutable)'}, sha256 ${sha256hex(trimPadding(d.elf))}`);
    const v = assessPins(d.elf, 'mainnet', p);
    if (!v.ok) throw new Error(`mainnet pre-flight (SEC-F19) FAILED — ${p} on chain is not a mainnet build:\n  - ${v.problems.join('\n  - ')}\n  rebuild without the devnet/localnet feature, redeploy, then run setup again.`);
  }
  console.log('  mainnet pre-flight OK: ids are not placeholders; chip_core + arena carry the mainnet Switchboard pins');
}

async function main() {
  const only = process.argv.includes('--step') ? process.argv[process.argv.indexOf('--step') + 1] : undefined;
  const conn = new Connection(RPC, 'confirmed');
  const wallet = loadWallet();
  const treasury = envKey('TREASURY', MAINNET ? SQUADS_TREASURY : wallet.publicKey);
  const buyback = envKey('BUYBACK_WALLET', treasury);
  console.log(`cluster ${MAINNET ? 'mainnet' : 'devnet/custom'} (${RPC})\nwallet   ${wallet.publicKey.toBase58()}\ntreasury ${treasury.toBase58()}\nbuyback  ${buyback.toBase58()}\nconfig   ${configPda.toBase58()}${DRY_RUN ? '\n(DRY_RUN — nothing is sent)' : ''}`);
  await mainnetPreflight(conn);
  const steps: [string, () => Promise<unknown>][] = [];
  let mints!: { cg: PublicKey; usdc: PublicKey; skr: PublicKey };
  const needsMints = !only || ['mints', 'initialize', 'atas', 'emission', 'arena'].includes(only);
  steps.push(['mints', async () => { mints = await stepMints(conn, wallet); }]);
  steps.push(['initialize', () => stepInitialize(conn, wallet, mints, treasury, buyback)]);
  steps.push(['ledgers', () => stepLedgers(conn, wallet)]);
  steps.push(['collections', () => stepCollections(conn, wallet)]);
  steps.push(['trees', () => stepTrees(conn, wallet)]);
  steps.push(['atas', () => stepAtas(conn, wallet, mints, treasury, buyback)]);
  steps.push(['emission', () => stepEmission(conn, wallet, mints.cg)]);
  steps.push(['arena', () => stepArena(conn, wallet, mints.cg, treasury)]);
  steps.push(['burn-oracle', () => stepBurnOracle(conn, wallet)]);
  for (const [name, run] of steps) {
    if (only && name !== only && !(name === 'mints' && needsMints)) continue;
    console.log(`\n▶ ${name}`);
    await run();
  }
  if (mints) {
    console.log(`\nDone. Client / backend env:\n  VITE_CG_MINT=${mints.cg.toBase58()}\n  VITE_USDC_MINT=${mints.usdc.toBase58()}\n  VITE_SKR_MINT=${mints.skr.toBase58()}\n  CG_MINT=${mints.cg.toBase58()}  SKR_MINT=${mints.skr.toBase58()}\nNext: npm run skr-pool -- init · npm run pyth-pusher -- set-params-args · npm run create-lut -- create`);
  } else {
    console.log(`\nDone (--step ${only}).`);
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
