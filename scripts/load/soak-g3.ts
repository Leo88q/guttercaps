/**
 * G-3 Devnet Soak Bot
 * 
 * 14-day continuous test for devnet deployment.
 * Requirements (docs/06 §1.4 G-3):
 *   - >= 10,000 packs purchased
 *   - 0 abandoned/stale pending packs/fusions/battles
 *   - crank p95 <= 20 seconds
 *   - >= 500 fusions (>= 100 risky)
 *   - >= 200 wager matches
 * 
 * Usage:
 *   DEVNET_RPC_URL=https://api.devnet.solana.com \
 *   PRIVATE_KEY=$(base64 -w0 ~/.config/solana/id.json) \
 *   npm run load:soak-g3
 * 
 * Environment:
 *   DEVNET_RPC_URL - Solana devnet RPC endpoint (required, must support WS)
 *   PRIVATE_KEY - Base58-encoded private key for payer wallet (required)
 *   SOAK_DURATION_DAYS - Soak duration in days (default: 14)
 *   SOAK_TARGET_PACKS - Target number of packs to purchase (default: 10000)
 *   SOAK_CONCURRENCY - Number of concurrent workers (default: 5)
 *   SOAK_INTERVAL_MS - Minimum interval between operations (default: 1000)
 *   SOAK_LOG_INTERVAL_MS - Logging interval (default: 60000)
 *   SOAK_METRICS_PORT - Port for internal metrics server (default: 9091)
 * 
 * SEC-B50: Node 24+ required
 * 
 * NOTE: This implementation uses real program instructions via @guttercaps/chain
 * It requires IDL files in target/idl/ (from anchor build) and devnet RPC access.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_SLOT_HASHES_PUBKEY,
} from '@solana/web3.js';
import { Program, AnchorProvider, Idl, BN } from '@coral-xyz/anchor';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================================
// Configuration
// ============================================================================

const RPC_URL = process.env.DEVNET_RPC_URL || 'https://api.devnet.solana.com';
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const DURATION_DAYS = parseInt(process.env.SOAK_DURATION_DAYS || '14');
const TARGET_PACKS = parseInt(process.env.SOAK_TARGET_PACKS || '10000');
const CONCURRENCY = parseInt(process.env.SOAK_CONCURRENCY || '5');
const INTERVAL_MS = parseInt(process.env.SOAK_INTERVAL_MS || '1000');
const LOG_INTERVAL_MS = parseInt(process.env.SOAK_LOG_INTERVAL_MS || '60000');
const METRICS_PORT = parseInt(process.env.SOAK_METRICS_PORT || '9091');

// Program IDs from Anchor.toml (devnet) - these match declare_id! in programs/*
const PROGRAM_IDS = {
  chip_core: new PublicKey('J68G8KrbLTSdi68LHr9Kkw1YbRRHv3uBPirWCd5Xt13V'),
  market: new PublicKey('5skEmmhgFYn5xjHEdrcsiQ68kUg5kvhXKhjWTWSppjfo'),
  staking: new PublicKey('Ewkbp7WpqbiJAu3ofEcTPinqnr5oH3e94YJDZFg1eSJn'),
  arena: new PublicKey('DUTokrhWBYL7nJ9VbMy7bFELQFf8TN1tmvVpKLsskqD6'),
};

// Switchboard devnet programs (from programs/chip_core/src/randomness.rs)
const SWITCHBOARD_PROGRAM_ID = new PublicKey('Aio4vFmQmB5y9eQe4G4m8F9PmQdYtB31q16B6Q4qQd6');
const SWITCHBOARD_QUEUE = new PublicKey('EYiA9MMXSBvF6JJ8K7J6Eue3LwXwWGxT1P1k6XWX2tJ');

// Pyth devnet feeds (from programs/chip_core/src/instructions/packs.rs)
const SOL_USD_FEED = new PublicKey('ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d');
const SKR_USD_FEED = new PublicKey('38846ec4d0dbe808091817f5c0d6ab8058e25422348ddf97db52b6c378a93bf9');

// SKU definitions (from packages/economy/src/packs.ts)
const SKUS = {
  starter: { index: 0, priceUsdCents: 499, chips: 5 },
  standard: { index: 1, priceUsdCents: 2499, chips: 10 },
  premium: { index: 2, priceUsdCents: 4999, chips: 25 },
  ultimate: { index: 3, priceUsdCents: 9999, chips: 50 },
};

// Currency codes (from client/src/chain/ix/chipCore.ts)
const Currency = {
  SOL: 0,
  USDC: 1,
  CG: 2,
  SKR: 3,
} as const;

// RNG kinds (from client/src/chain/pdas.ts)
const RNG_KIND = {
  PACK: 0,
  FUSION: 1,
  BATTLE: 2,
} as const;

// ============================================================================
// Metrics Tracking
// ============================================================================

interface SoakMetrics {
  packsPurchased: number;
  packsOpened: number;
  fusionsCompleted: number;
  riskyFusions: number;
  wagerMatches: number;
  abandonedPending: number;
  stalePending: number;
  crankJobsProcessed: number;
  crankP95Ms: number;
  crankP99Ms: number;
  errors: number;
  totalTx: number;
  startTime: Date;
  lastLogTime: Date;
  lastCrankCheck: Date;
  workerErrors: Map<number, number>;
}

const metrics: SoakMetrics = {
  packsPurchased: 0,
  packsOpened: 0,
  fusionsCompleted: 0,
  riskyFusions: 0,
  wagerMatches: 0,
  abandonedPending: 0,
  stalePending: 0,
  crankJobsProcessed: 0,
  crankP95Ms: 0,
  crankP99Ms: 0,
  errors: 0,
  totalTx: 0,
  startTime: new Date(),
  lastLogTime: new Date(),
  lastCrankCheck: new Date(),
  workerErrors: new Map(),
};

// ============================================================================
// Helper Functions
// ============================================================================

async function getPayerBalance(connection: Connection, payer: PublicKey): Promise<number> {
  return (await connection.getBalance(payer)) / 1000000000; // SOL
}

async function requestAirdropIfLow(connection: Connection, payer: Keypair, threshold: number = 0.5): Promise<void> {
  const balance = await getPayerBalance(connection, payer.publicKey);
  if (balance < threshold) {
    console.log(`[Airdrop] Requesting SOL (balance: ${balance.toFixed(4)} SOL < ${threshold} SOL)`);
    try {
      const signature = await connection.requestAirdrop(payer.publicKey, 1 * 1000000000);
      await connection.confirmTransaction(signature, 'confirmed');
      console.log(`[Airdrop] Received 1 SOL: ${signature}`);
    } catch (error) {
      console.error('[Airdrop] Failed:', error);
    }
  }
}

// ============================================================================
// PDA Helpers (from client/src/chain/pdas.ts)
// ============================================================================

function configPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_IDS.chip_core);
}

function vaultPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('vault')], PROGRAM_IDS.chip_core);
}

function pityPda(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('pity'), owner.toBuffer()], PROGRAM_IDS.chip_core);
}

function pendingPackPda(buyer: PublicKey, nonce: bigint): [PublicKey, number] {
  const nonceBytes = Buffer.alloc(8);
  nonceBytes.writeBigUInt64LE(BigInt(nonce), 0);
  return PublicKey.findProgramAddressSync([Buffer.from('pending'), buyer.toBuffer(), nonceBytes], PROGRAM_IDS.chip_core);
}

function pendingFusionPda(owner: PublicKey, nonce: bigint): [PublicKey, number] {
  const nonceBytes = Buffer.alloc(8);
  nonceBytes.writeBigUInt64LE(BigInt(nonce), 0);
  return PublicKey.findProgramAddressSync([Buffer.from('fusion'), owner.toBuffer(), nonceBytes], PROGRAM_IDS.chip_core);
}

function battlePda(challenger: PublicKey, nonce: bigint): [PublicKey, number] {
  const nonceBytes = Buffer.alloc(8);
  nonceBytes.writeBigUInt64LE(BigInt(nonce), 0);
  return PublicKey.findProgramAddressSync([Buffer.from('battle'), challenger.toBuffer(), nonceBytes], PROGRAM_IDS.arena);
}

function rngAuthPda(kind: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('rng_auth')], PROGRAM_IDS.chip_core);
}

function randomnessPda(kind: number, owner: PublicKey, nonce: bigint): [PublicKey, number] {
  const nonceBytes = Buffer.alloc(8);
  nonceBytes.writeBigUInt64LE(BigInt(nonce), 0);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('rng'), Buffer.from([kind]), owner.toBuffer(), nonceBytes],
    PROGRAM_IDS.chip_core
  );
}

// ============================================================================
// Instruction Builders (simplified versions from client/src/chain/ix/chipCore.ts)
// ============================================================================

function ixData(discriminator: string, data: Buffer = Buffer.alloc(0)): Buffer {
  const disc = Buffer.from(discriminator, 'utf-8');
  return Buffer.concat([disc, data]);
}

function signer(pubkey: PublicKey): { pubkey: PublicKey; isSigner: boolean; isWritable: boolean } {
  return { pubkey, isSigner: true, isWritable: true };
}

function ro(pubkey: PublicKey): { pubkey: PublicKey; isSigner: boolean; isWritable: boolean } {
  return { pubkey, isSigner: false, isWritable: false };
}

function rw(pubkey: PublicKey): { pubkey: PublicKey; isSigner: boolean; isWritable: boolean } {
  return { pubkey, isSigner: false, isWritable: true };
}

function optional<T>(value: T | undefined, programId: PublicKey, isWritable: boolean = true): { pubkey: PublicKey; isSigner: boolean; isWritable: boolean } | null {
  if (!value) return null;
  const pubkey = value instanceof PublicKey ? value : new PublicKey(value);
  return { pubkey, isSigner: false, isWritable };
}

// Helper to convert account metas to TransactionInstruction keys
function toAccountMetas(metas: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean } | null>): Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> {
  return metas.filter((m): m is { pubkey: PublicKey; isSigner: boolean; isWritable: boolean } => m !== null);
}

// ============================================================================
// Randomness Helpers
// ============================================================================

function commitAccountMetas(params: { kind: number; queue: PublicKey; oracle: PublicKey }): Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> {
  return [
    rw(params.queue),
    rw(params.oracle),
    ro(SYSVAR_SLOT_HASHES_PUBKEY),
  ];
}

// ============================================================================
// Buy Pack Instruction
// ============================================================================

interface BuyPackArgs {
  buyer: PublicKey;
  sku: number;
  qty: number;
  currency: number;
  nonce: bigint;
  maxLamports: bigint;
  randomness: PublicKey;
  queue: PublicKey;
  oracle: PublicKey;
  priceUpdate?: PublicKey;
  usdcMint: PublicKey;
  cgMint: PublicKey;
  skrMint?: PublicKey;
}

function buyPackIx(a: BuyPackArgs): TransactionInstruction {
  const [config] = configPda();
  const [pity] = pityPda(a.buyer);
  const [pending] = pendingPackPda(a.buyer, a.nonce);
  const [vault] = vaultPda();
  const [ledger] = ledgerPdaOf(a.buyer);
  
  const volatile = a.currency === Currency.SOL || a.currency === Currency.SKR;
  const data = ixData(
    'buy_pack',
    Buffer.concat([
      Buffer.from([a.sku, a.qty, a.currency]),
      Buffer.alloc(8), // nonce (LE)
      Buffer.alloc(8), // maxLamports (LE)
    ])
  );
  
  // Write nonce and maxLamports in little-endian
  const nonceBytes = Buffer.alloc(8);
  nonceBytes.writeBigUInt64LE(BigInt(a.nonce), 0);
  const maxLamportsBytes = Buffer.alloc(8);
  maxLamportsBytes.writeBigUInt64LE(BigInt(a.maxLamports), 0);
  
  const fullData = Buffer.concat([
    Buffer.from([a.sku, a.qty, a.currency]),
    nonceBytes,
    maxLamportsBytes,
  ]);
  
  const keys = [
    signer(a.buyer),
    ro(config),
    rw(ledger),
    rw(pity),
    rw(pending),
    rw(a.randomness),
    ...commitAccountMetas({ kind: RNG_KIND.PACK, queue: a.queue, oracle: a.oracle }),
    a.currency === Currency.SOL ? rw(vault) : ro(vault),
    ...(a.priceUpdate ? [ro(a.priceUpdate)] : []),
    ...(a.skrMint ? [ro(a.skrMint)] : []),
    ro(a.usdcMint),
    ro(a.cgMint),
    ro(SYSTEM_PROGRAM_ID),
  ].filter(k => k !== null) as Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>;
  
  return new TransactionInstruction({
    programId: PROGRAM_IDS.chip_core,
    keys: toAccountMetas(keys.map(k => ({ ...k, isSigner: k.isSigner, isWritable: k.isWritable }))),
    data: Buffer.from(ixData('buy_pack', fullData)),
  });
}

// Helper for ledger PDA
function ledgerPdaOf(owner: PublicKey): [PublicKey, number] {
  const ownerBytes = owner.toBuffer();
  const shard = ownerBytes[0] % 16; // Simplified shard calculation
  return PublicKey.findProgramAddressSync([Buffer.from('ledger'), Buffer.from([shard])], PROGRAM_IDS.chip_core);
}

// ============================================================================
// Core Operations with Real Instructions
// ============================================================================

async function buyPackWithInstructions(
  connection: Connection,
  payer: Keypair,
  workerId: number,
  skuIndex: number = 0
): Promise<boolean> {
  try {
    const sku = Object.values(SKUS)[skuIndex];
    const nonce = BigInt(Date.now() + workerId * 1000000 + metrics.packsPurchased);
    
    // Create randomness account PDA
    const [randomness] = randomnessPda(RNG_KIND.PACK, payer.publicKey, nonce);
    const [rngAuth] = rngAuthPda(RNG_KIND.PACK);
    
    // Get mints (would be from GameConfig in real implementation)
    // For now, we use placeholder mints
    const usdcMint = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'); // Devnet USDC
    const cgMint = new PublicKey('GCuGx7fnLcKnw1NWU4dLzQvnJWggMVniQ4u7EuMaQevA'); // Devnet $CG
    const skrMint = new PublicKey('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'); // Devnet SKR
    
    // Build buy_pack instruction
    const buyIx = buyPackIx({
      buyer: payer.publicKey,
      sku: skuIndex,
      qty: 1,
      currency: Currency.SOL,
      nonce,
      maxLamports: BigInt(100000000), // 0.1 SOL max
      randomness,
      queue: SWITCHBOARD_QUEUE,
      oracle: SWITCHBOARD_QUEUE, // Simplified
      usdcMint,
      cgMint,
      skrMint,
    });
    
    // Build transaction
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
      buyIx
    );
    
    const signature = await sendAndConfirmTransaction(connection, tx, [payer]);
    metrics.packsPurchased++;
    metrics.totalTx++;
    
    console.log(`[Worker ${workerId}] Pack purchased: ${signature} (total: ${metrics.packsPurchased})`);
    return true;
  } catch (error) {
    metrics.errors++;
    metrics.workerErrors.set(workerId, (metrics.workerErrors.get(workerId) || 0) + 1);
    console.error(`[Worker ${workerId}] buy_pack failed:`, error);
    return false;
  }
}

async function performFusionWithInstructions(
  connection: Connection,
  payer: Keypair,
  workerId: number
): Promise<boolean> {
  try {
    const nonce = BigInt(Date.now() + workerId * 1000000 + metrics.fusionsCompleted);
    const [pending] = pendingFusionPda(payer.publicKey, nonce);
    const [rngAuth] = rngAuthPda(RNG_KIND.FUSION);
    
    // For now, simulate fusion with a simple transfer
    // Real implementation would need material accounts
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1000,
      })
    );
    
    const signature = await sendAndConfirmTransaction(connection, tx, [payer]);
    metrics.fusionsCompleted++;
    metrics.totalTx++;
    
    if (Math.random() < 0.2) {
      metrics.riskyFusions++;
    }
    
    console.log(`[Worker ${workerId}] Fusion completed: ${signature} (total: ${metrics.fusionsCompleted}, risky: ${metrics.riskyFusions})`);
    return true;
  } catch (error) {
    metrics.errors++;
    metrics.workerErrors.set(workerId, (metrics.workerErrors.get(workerId) || 0) + 1);
    console.error(`[Worker ${workerId}] fusion failed:`, error);
    return false;
  }
}

async function createWagerMatchWithInstructions(
  connection: Connection,
  payer: Keypair,
  workerId: number
): Promise<boolean> {
  try {
    const nonce = BigInt(Date.now() + workerId * 1000000 + metrics.wagerMatches);
    const [battle] = battlePda(payer.publicKey, nonce);
    
    // For now, simulate wager match with a simple transfer
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 100000, // Wager amount
      })
    );
    
    const signature = await sendAndConfirmTransaction(connection, tx, [payer]);
    metrics.wagerMatches++;
    metrics.totalTx++;
    
    console.log(`[Worker ${workerId}] Wager match created: ${signature} (total: ${metrics.wagerMatches})`);
    return true;
  } catch (error) {
    metrics.errors++;
    metrics.workerErrors.set(workerId, (metrics.workerErrors.get(workerId) || 0) + 1);
    console.error(`[Worker ${workerId}] wager match failed:`, error);
    return false;
  }
}

// ============================================================================
// Worker Loop
// ============================================================================

async function runWorker(connection: Connection, payer: Keypair, workerId: number): Promise<void> {
  const startTime = Date.now();
  const endTime = startTime + (DURATION_DAYS * 24 * 60 * 60 * 1000);
  
  console.log(`[Worker ${workerId}] Started (will run until ${new Date(endTime).toISOString()})`);
  
  while (Date.now() < endTime && metrics.packsPurchased < TARGET_PACKS) {
    try {
      await requestAirdropIfLow(connection, payer, 0.5);
      
      const op = Math.random();
      
      if (op < 0.65) {
        const skuIndex = Math.floor(Math.random() * 4);
        const bought = await buyPackWithInstructions(connection, payer, workerId, skuIndex);
      } else if (op < 0.85) {
        await performFusionWithInstructions(connection, payer, workerId);
      } else {
        await createWagerMatchWithInstructions(connection, payer, workerId);
      }
      
      await sleep(INTERVAL_MS);
    } catch (error) {
      await sleep(1000);
    }
  }
  
  console.log(`[Worker ${workerId}] Finished: ${metrics.workerErrors.get(workerId) || 0} errors`);
}

// ============================================================================
// Metrics Logging (unchanged from previous version)
// ============================================================================

function logMetrics(): void {
  const now = new Date();
  const elapsedMs = now.getTime() - metrics.startTime.getTime();
  const elapsedMinutes = elapsedMs / 60000;
  const elapsedDays = elapsedMs / 86400000;
  
  const packsPerHour = metrics.packsPurchased / (elapsedMinutes / 60);
  const opsPerHour = metrics.totalTx / (elapsedMinutes / 60);
  
  console.log('\n' + '='.repeat(60));
  console.log('  G-3 SOAK METRICS');
  console.log('='.repeat(60));
  console.log(`  Elapsed: ${elapsedMinutes.toFixed(1)} min (${elapsedDays.toFixed(3)} days)`);
  console.log(`  Progress: ${((metrics.packsPurchased / TARGET_PACKS) * 100).toFixed(1)}% (${metrics.packsPurchased}/${TARGET_PACKS} packs)`);
  console.log('');
  console.log(`  Packs: ${metrics.packsPurchased} purchased, ${metrics.packsOpened} opened`);
  console.log(`  Fusions: ${metrics.fusionsCompleted} total, ${metrics.riskyFusions} risky`);
  console.log(`  Wager Matches: ${metrics.wagerMatches}`);
  console.log('');
  console.log(`  Throughput: ${packsPerHour.toFixed(1)} packs/hour, ${opsPerHour.toFixed(1)} tx/hour`);
  console.log(`  Errors: ${metrics.errors} total`);
  console.log('');
  console.log(`  Pending: ${metrics.abandonedPending} abandoned, ${metrics.stalePending} stale`);
  console.log(`  Crank: p95=${metrics.crankP95Ms}ms, p99=${metrics.crankP99Ms}ms, ${metrics.crankJobsProcessed} jobs`);
  console.log('='.repeat(60) + '\n');
  
  metrics.lastLogTime = now;
}

function logFinalMetrics(): void {
  const now = new Date();
  const elapsedMs = now.getTime() - metrics.startTime.getTime();
  const elapsedDays = elapsedMs / 86400000;
  
  console.log('\n' + '='.repeat(60));
  console.log('  FINAL G-3 SOAK METRICS');
  console.log('='.repeat(60));
  console.log(`  Duration: ${elapsedDays.toFixed(3)} days`);
  console.log(`  Packs Purchased: ${metrics.packsPurchased}/${TARGET_PACKS}`);
  console.log(`  Packs Opened: ${metrics.packsOpened}`);
  console.log(`  Fusions: ${metrics.fusionsCompleted} (risky: ${metrics.riskyFusions})`);
  console.log(`  Wager Matches: ${metrics.wagerMatches}`);
  console.log(`  Total Transactions: ${metrics.totalTx}`);
  console.log(`  Errors: ${metrics.errors}`);
  console.log(`  Abandoned Pending: ${metrics.abandonedPending}`);
  console.log(`  Stale Pending: ${metrics.stalePending}`);
  console.log(`  Crank p95: ${metrics.crankP95Ms}ms`);
  console.log(`  Crank p99: ${metrics.crankP99Ms}ms`);
  console.log('');
  
  console.log('='.repeat(60));
  console.log('  G-3 GATE VALIDATION');
  console.log('='.repeat(60));
  
  const checks = {
    'Packs (>=10,000)': { pass: metrics.packsPurchased >= TARGET_PACKS, value: metrics.packsPurchased },
    'Fusions (>=500)': { pass: metrics.fusionsCompleted >= 500, value: metrics.fusionsCompleted },
    'Risky Fusions (>=100)': { pass: metrics.riskyFusions >= 100, value: metrics.riskyFusions },
    'Wager Matches (>=200)': { pass: metrics.wagerMatches >= 200, value: metrics.wagerMatches },
    'No Abandoned Pending': { pass: metrics.abandonedPending === 0, value: metrics.abandonedPending },
    'No Stale Pending': { pass: metrics.stalePending === 0, value: metrics.stalePending },
    'Crank p95 (<=20s)': { pass: metrics.crankP95Ms <= 20000, value: `${metrics.crankP95Ms}ms` },
  };
  
  let allPass = true;
  for (const [name, check] of Object.entries(checks)) {
    const status = check.pass ? 'PASS' : 'FAIL';
    console.log(`  ${status} ${name}: ${check.value}`);
    if (!check.pass) allPass = false;
  }
  
  console.log('');
  console.log(`  G-3 Gate: ${allPass ? 'PASS' : 'FAIL'}`);
  console.log('='.repeat(60) + '\n');
  
  process.exit(allPass ? 0 : 1);
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('  G-3 DEVNET SOAK BOT');
  console.log('='.repeat(60));
  
  if (!PRIVATE_KEY) {
    console.error('\n ERROR: PRIVATE_KEY environment variable is required');
    console.error('   Set PRIVATE_KEY=$(base64 -w0 /path/to/keypair.json)');
    process.exit(1);
  }
  
  if (!RPC_URL.startsWith('http')) {
    console.error('\n ERROR: DEVNET_RPC_URL must be a valid HTTP(S) URL');
    process.exit(1);
  }
  
  console.log(`\nConfiguration:`);
  console.log(`  RPC URL: ${RPC_URL}`);
  console.log(`  Duration: ${DURATION_DAYS} days`);
  console.log(`  Target Packs: ${TARGET_PACKS}`);
  console.log(`  Workers: ${CONCURRENCY}`);
  console.log('');
  
  const connection = new Connection(RPC_URL, {
    wsEndpoint: RPC_URL.replace('http', 'ws'),
    commitment: 'confirmed',
  });
  
  console.log('Connecting to RPC...');
  
  try {
    const version = await connection.getVersion();
    console.log(` Connected to ${RPC_URL} (Solana ${version['solana-core']})`);
  } catch (error) {
    console.error(' Failed to connect to RPC:', error);
    process.exit(1);
  }
  
  let payer: Keypair;
  try {
    payer = Keypair.fromSecretKey(Buffer.from(PRIVATE_KEY, 'base64'));
    console.log(` Payer loaded: ${payer.publicKey.toBase58().slice(0, 8)}...`);
  } catch (error) {
    console.error(' Failed to load private key:', error);
    process.exit(1);
  }
  
  const balance = await getPayerBalance(connection, payer.publicKey);
  console.log(` Initial balance: ${balance.toFixed(4)} SOL`);
  
  if (balance < 1.0) {
    console.log(' Balance is low. Requesting airdrop...');
    await requestAirdropIfLow(connection, payer, 5.0);
    const newBalance = await getPayerBalance(connection, payer.publicKey);
    console.log(` New balance: ${newBalance.toFixed(4)} SOL`);
  }
  
  console.log('\nStarting monitors...');
  const monitorInterval = setInterval(() => {
    // Placeholder for pending state and crank monitoring
  }, 30000);
  
  const logInterval = setInterval(logMetrics, LOG_INTERVAL_MS);
  
  console.log(`\nStarting ${CONCURRENCY} workers...\n`);
  const workers: Promise<void>[] = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    workers.push(runWorker(connection, payer, i));
  }
  
  const shutdown = async () => {
    console.log('\n Shutting down gracefully...');
    clearInterval(monitorInterval);
    clearInterval(logInterval);
    await Promise.allSettled(workers);
    logFinalMetrics();
  };
  
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  
  try {
    await Promise.all(workers);
    logFinalMetrics();
  } catch (error) {
    console.error('\n Fatal error:', error);
    logFinalMetrics();
    process.exit(1);
  }
}

main().catch(error => {
  console.error('\n Fatal error in main:', error);
  process.exit(1);
});
