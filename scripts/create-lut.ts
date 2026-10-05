// Static Address Lookup Table for GUTTERCAPS (docs/06 §4.2 вывод 3, backlog #13).
//
// `reveal_randomness + open_pack` references 33 (3 chips) to 44 (5 chips, $CG) account keys;
// a legacy/v0 transaction without a lookup table holds ~35 × 32-byte keys at most, so the
// crank and the client either split reveal/open into two transactions or use this table.
// One table per cluster; its address goes to the crank as LOOKUP_TABLE and to the client as
// VITE_LOOKUP_TABLE. Extending is idempotent: `extend` only adds addresses that are missing.
//
//   ANCHOR_WALLET=~/.config/solana/id.json ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
//     npm run create-lut -- <command> [args]
//
//   plan                 print the addresses the table should contain (reads GameConfig + CollectionMeta on chain)
//   create               create a new table (authority = signer) and extend it with `plan`; prints LOOKUP_TABLE=…
//   extend <table>       add any missing addresses to an existing table (after new collections / params)
//   show <table>         print the table contents and which planned addresses are missing
//   freeze <table>       drop the authority (immutable) — do this once the collection set is final (G-1)
//
// Env: PROGRAM_CHIP_CORE / PROGRAM_ARENA / SWITCHBOARD_PROGRAM_ID / SWITCHBOARD_QUEUE override the defaults
// (same env names as backend/src/config.ts), DRY_RUN=1 prints without sending.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  AddressLookupTableProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

const RPC = process.env.ANCHOR_PROVIDER_URL ?? 'https://api.devnet.solana.com';
const MAINNET = RPC.includes('mainnet');
const CHIP_CORE = new PublicKey(process.env.PROGRAM_CHIP_CORE ?? 'J68G8KrbLTSdi68LHr9Kkw1YbRRHv3uBPirWCd5Xt13V');
/** #12 — mirrors chip_core `state::LEDGER_SHARDS` (sync-check pins it). */
const LEDGER_SHARDS = 4;
const MARKET = new PublicKey(process.env.PROGRAM_MARKET ?? '5skEmmhgFYn5xjHEdrcsiQ68kUg5kvhXKhjWTWSppjfo');
const STAKING = new PublicKey(process.env.PROGRAM_STAKING ?? 'Ewkbp7WpqbiJAu3ofEcTPinqnr5oH3e94YJDZFg1eSJn');
const ARENA = new PublicKey(process.env.PROGRAM_ARENA ?? 'DUTokrhWBYL7nJ9VbMy7bFELQFf8TN1tmvVpKLsskqD6');
const SWITCHBOARD = new PublicKey(process.env.SWITCHBOARD_PROGRAM_ID ?? (MAINNET ? 'SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv' : 'Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2'));
const SB_QUEUE = new PublicKey(process.env.SWITCHBOARD_QUEUE ?? (MAINNET ? 'A43DyUGA7s8eXPxqEjJY6EBu1KKbNgfxF8h17VAHn13w' : 'EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7'));
const MPL_CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const MPL_BUBBLEGUM_V2 = new PublicKey('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
const MPL_NOOP = new PublicKey('mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3');
const MPL_ACCOUNT_COMPRESSION = new PublicKey('mcmt6YrQEMKw8Mw43FmpRLmf7BqRnFMKmAcbxE3xkAW');
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const SLOT_HASHES = new PublicKey('SysvarS1otHashes111111111111111111111111111');
const ALT_PROGRAM = new PublicKey('AddressLookupTab1e1111111111111111111111111');
const PYTH_RECEIVER = new PublicKey('rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ');
const DRY_RUN = process.env.DRY_RUN === '1';

const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];
const enc = (s: string) => Buffer.from(s);

function loadWallet(): Keypair {
  const p = (process.env.ANCHOR_WALLET ?? '~/.config/solana/id.json').replace(/^~/, homedir());
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));
}

/** GameConfig decode — just the fields we need (layout: programs/chip_core/src/state.rs; full decoder in backend/src/chain.ts). */
function readConfig(data: Buffer) {
  let o = 8;
  const pk = () => { const k = new PublicKey(data.subarray(o, o + 32)); o += 32; return k; };
  const admin = pk(); pk(); const treasury = pk(); pk(); const cgMint = pk(); const usdcMint = pk(); const skrMint = pk(); pk(); const pythSol = pk(); const pythSkr = pk();
  o += 1 + 1; // featured_collection, paused
  const PACK_DEF = 1 + 4 + 8 + 18 + 1 + 1 + 1 + 2 + 2 + 2 + 1 + 1;
  o += 4 * PACK_DEF;
  o += 2 + 2; // market_fee_bps, skr_discount_bps
  const collectionsCreated = data[o];
  return { admin, treasury, cgMint, usdcMint, skrMint, pythSol, pythSkr, collectionsCreated };
}

export async function plan(conn: Connection): Promise<{ label: string; key: PublicKey }[]> {
  const config = pda([enc('config')], CHIP_CORE);
  const info = await conn.getAccountInfo(config, 'confirmed');
  if (!info) throw new Error(`GameConfig ${config.toBase58()} not found on ${RPC} — run scripts/setup.ts first`);
  const cfg = readConfig(info.data);
  const vault = pda([enc('vault')], CHIP_CORE);
  const out: { label: string; key: PublicKey }[] = [
    { label: 'chip_core', key: CHIP_CORE }, { label: 'market', key: MARKET }, { label: 'staking', key: STAKING }, { label: 'arena', key: ARENA },
    { label: 'mpl_core', key: MPL_CORE }, { label: 'mpl_bubblegum_v2', key: MPL_BUBBLEGUM_V2 }, { label: 'mpl_noop', key: MPL_NOOP }, { label: 'mpl_account_compression', key: MPL_ACCOUNT_COMPRESSION }, { label: 'token', key: TOKEN }, { label: 'ata_program', key: ATA_PROGRAM }, { label: 'system', key: SystemProgram.programId },
    { label: 'wsol', key: WSOL }, { label: 'slot_hashes', key: SLOT_HASHES }, { label: 'alt_program', key: ALT_PROGRAM }, { label: 'pyth_receiver', key: PYTH_RECEIVER },
    { label: 'switchboard', key: SWITCHBOARD }, { label: 'sb_state', key: pda([enc('STATE')], SWITCHBOARD) }, { label: 'sb_queue', key: SB_QUEUE },
    { label: 'config', key: config }, { label: 'vault', key: vault },
    ...Array.from({ length: LEDGER_SHARDS }, (_, i) => ({ label: `ledger[${i}]`, key: pda([enc('ledger'), Buffer.from([i])], CHIP_CORE) })), // #12
    { label: 'rng_auth(chip_core)', key: pda([enc('rng_auth')], CHIP_CORE) }, { label: 'rng_auth(arena)', key: pda([enc('rng_auth')], ARENA) },
    { label: 'market_auth', key: pda([enc('market_auth')], MARKET) }, { label: 'stake_auth', key: pda([enc('stake_auth')], STAKING) },
    { label: 'emission', key: pda([enc('emission')], STAKING) }, { label: 'arena_config', key: pda([enc('arena_config')], ARENA) },
    { label: 'treasury', key: cfg.treasury },
    { label: 'pyth_sol', key: cfg.pythSol }, { label: 'pyth_skr', key: cfg.pythSkr },
  ];
  for (const [label, mint] of [['cg_mint', cfg.cgMint], ['usdc_mint', cfg.usdcMint], ['skr_mint', cfg.skrMint]] as const) {
    if (mint.equals(PublicKey.default)) continue;
    out.push({ label, key: mint });
    out.push({ label: `vault_${label.split('_')[0]}`, key: getAssociatedTokenAddressSync(mint, vault, true) });
    out.push({ label: `treasury_${label.split('_')[0]}`, key: getAssociatedTokenAddressSync(mint, cfg.treasury, true) });
  }
  for (let i = 0; i < cfg.collectionsCreated; i++) {
    const meta = pda([enc('collection'), Buffer.from([i])], CHIP_CORE);
    const mi = await conn.getAccountInfo(meta, 'confirmed');
    if (!mi) { console.warn(`collection ${i}: meta ${meta.toBase58()} missing (collections_created says ${cfg.collectionsCreated})`); continue; }
    out.push({ label: `collection_meta[${i}]`, key: meta });
    out.push({ label: `core_collection[${i}]`, key: new PublicKey(mi.data.subarray(9, 41)) });
    const treeMeta = pda([enc('bubblegum_tree'), Buffer.from([i])], CHIP_CORE);
    const ti = await conn.getAccountInfo(treeMeta, 'confirmed');
    if (ti && ti.data.length >= 105) {
      out.push({ label: `bubblegum_tree[${i}]`, key: treeMeta });
      out.push({ label: `merkle_tree[${i}]`, key: new PublicKey(ti.data.subarray(41, 73)) });
      out.push({ label: `tree_config[${i}]`, key: new PublicKey(ti.data.subarray(73, 105)) });
    }
  }
  // de-duplicate, keep first label
  const seen = new Set<string>();
  return out.filter((e) => { const k = e.key.toBase58(); if (seen.has(k)) return false; seen.add(k); return true; });
}

async function send(conn: Connection, payer: Keypair, ixs: TransactionInstruction[], label: string) {
  if (DRY_RUN) { console.log(`[dry-run] ${label}: ${ixs.length} ix`); return 'dry-run'; }
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [payer], { commitment: 'confirmed' });
  console.log(`${label}: ${sig}`);
  return sig;
}

async function extend(conn: Connection, payer: Keypair, table: PublicKey, wanted: PublicKey[]) {
  const cur = (await conn.getAddressLookupTable(table, { commitment: 'confirmed' })).value;
  if (!cur) throw new Error(`lookup table ${table.toBase58()} not found`);
  const have = new Set(cur.state.addresses.map((a) => a.toBase58()));
  const missing = wanted.filter((k) => !have.has(k.toBase58()));
  if (!missing.length) { console.log(`table ${table.toBase58()} already complete (${have.size} addresses)`); return; }
  for (let i = 0; i < missing.length; i += 20) {
    const chunk = missing.slice(i, i + 20);
    await send(conn, payer, [AddressLookupTableProgram.extendLookupTable({ lookupTable: table, authority: payer.publicKey, payer: payer.publicKey, addresses: chunk })], `extend +${chunk.length}`);
  }
  console.log(`table ${table.toBase58()}: ${have.size} → ${have.size + missing.length} addresses (usable in the NEXT slot after the last extend)`);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const conn = new Connection(RPC, 'confirmed');
  if (cmd === 'plan') {
    const p = await plan(conn);
    for (const e of p) console.log(`${e.label.padEnd(22)} ${e.key.toBase58()}`);
    console.log(`\n${p.length} addresses (table capacity 256)`);
    return;
  }
  if (cmd === 'show') {
    const table = new PublicKey(arg);
    const cur = (await conn.getAddressLookupTable(table, { commitment: 'confirmed' })).value;
    if (!cur) throw new Error('not found');
    const p = await plan(conn);
    const have = new Set(cur.state.addresses.map((a) => a.toBase58()));
    console.log(`authority ${cur.state.authority?.toBase58() ?? 'FROZEN'} · ${have.size} addresses · deactivation ${cur.state.deactivationSlot}`);
    for (const e of p) console.log(`${have.has(e.key.toBase58()) ? '✓' : '✗ MISSING'} ${e.label.padEnd(22)} ${e.key.toBase58()}`);
    return;
  }
  if (!['create', 'extend', 'freeze'].includes(cmd ?? '')) {
    console.log('usage: npm run create-lut -- plan | create | extend <table> | show <table> | freeze <table>');
    process.exit(1);
  }
  const payer = loadWallet();
  console.log(`${RPC} · signer ${payer.publicKey.toBase58()}${DRY_RUN ? ' · DRY RUN' : ''}`);
  if (cmd === 'create') {
    const p = await plan(conn);
    const recentSlot = await conn.getSlot('finalized');
    const [ix, table] = AddressLookupTableProgram.createLookupTable({ authority: payer.publicKey, payer: payer.publicKey, recentSlot });
    await send(conn, payer, [ix], `create ${table.toBase58()}`);
    if (!DRY_RUN) await extend(conn, payer, table, p.map((e) => e.key));
    console.log(`\nLOOKUP_TABLE=${table.toBase58()}          # backend/.env (crank)\nVITE_LOOKUP_TABLE=${table.toBase58()}     # client/.env.local`);
    return;
  }
  if (cmd === 'extend') { await extend(conn, payer, new PublicKey(arg), (await plan(conn)).map((e) => e.key)); return; }
  if (cmd === 'freeze') {
    await send(conn, payer, [AddressLookupTableProgram.freezeLookupTable({ lookupTable: new PublicKey(arg), authority: payer.publicKey })], 'freeze');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
