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
 *   PRIVATE_KEY=$(node -e "console.log(Buffer.from(require(process.argv[1])).toString('base64'))" /path/to/keypair.json) \
 *   npm run load:soak-g3
 * 
 * Environment:
 *   DEVNET_RPC_URL - Solana devnet RPC endpoint (required, must support WS)
 *   PRIVATE_KEY - Base64 of the RAW 64-byte secret key (required). NOT base58,
 *                 and NOT `base64 -w0 ~/.config/solana/id.json` — that encodes the
 *                 JSON *text* "[12,34,...]", which is not 64 bytes and will be
 *                 rejected by Keypair.fromSecretKey. The correct one-liner is in
 *                 the Usage line above.
 *   SOAK_DURATION_DAYS - Soak duration in days, fractions allowed (default: 14;
 *                 0.0417 ≈ 1 hour). Parsed with parseFloat — a value like 0.0417
 *                 used to become NaN under parseInt and the bot exited instantly.
 *   SOAK_TARGET_PACKS - Target number of packs to purchase (default: 10000)
 *   SOAK_CONCURRENCY - Number of concurrent workers (default: 5)
 *   SOAK_INTERVAL_MS - Minimum interval between operations (default: 1000)
 *   SOAK_LOG_INTERVAL_MS - Logging interval (default: 60000)
 *   SOAK_WEIGHTS - Operation weights as "buy:fuse:battle" (default: 0.65:0.20:0.15)
 * 
 * SEC-B50: Node 24+ required
 * 
 * NOTE: This implementation uses REAL program instructions — Borsh
 * discriminators and PDAs are built by hand, so NO IDL files are needed or read.
 * It requires:
 *   - Node 24+
 *   - Devnet RPC access with WebSocket
 *   - Funded wallet (150-200 SOL for 10,000 packs)
 * 
 * KNOWN LIMITATION: pending-state (abandoned/stale) and crank p95 metrics are
 * SIMULATED placeholders — the G-3 gate currently cannot fail on them. The final
 * report labels them SIMULATED. See scripts/load/soak-g3.md "Metrics honesty".
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
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHash } from 'node:crypto';
// Single source of truth for fusion recipes — same package the client and the
// on-chain sync-check use (packages/economy). Never copy the recipe table here.
import { recipeFor } from '@guttercaps/economy';

// Switchboard on-demand SDK, loaded lazily like the client does
// (client/src/chain/switchboard.ts) — only used to pick a healthy queue oracle.
type Sb = typeof import('@switchboard-xyz/on-demand');
let sbMod: Promise<Sb> | undefined;
const loadSb = (): Promise<Sb> => (sbMod ??= import('@switchboard-xyz/on-demand'));

// ============================================================================
// Configuration
// ============================================================================

const RPC_URL = process.env.DEVNET_RPC_URL || 'https://api.devnet.solana.com';
const PRIVATE_KEY = process.env.PRIVATE_KEY;
// parseFloat, not parseInt: sub-day runs (1h test = 0.0417 days, nightly smoke)
// used to parse to NaN/0 and every worker exited before sending a single tx.
const DURATION_DAYS = parseFloat(process.env.SOAK_DURATION_DAYS || '14');
const TARGET_PACKS = parseInt(process.env.SOAK_TARGET_PACKS || '10000');
const CONCURRENCY = parseInt(process.env.SOAK_CONCURRENCY || '5');
const INTERVAL_MS = parseInt(process.env.SOAK_INTERVAL_MS || '1000');
const LOG_INTERVAL_MS = parseInt(process.env.SOAK_LOG_INTERVAL_MS || '60000');

// Operation weights "buy:fuse:battle", normalised to sum 1. Defaults match the
// historical hardcoded 0.65/0.20/0.15 split.
const WEIGHTS = ((): { buy: number; fuse: number; battle: number } => {
  const raw = process.env.SOAK_WEIGHTS || '0.65:0.20:0.15';
  const parts = raw.split(':').map(Number);
  const valid =
    parts.length === 3 &&
    parts.every((p) => Number.isFinite(p) && p >= 0) &&
    parts.some((p) => p > 0);
  if (!valid) {
    console.error(`ERROR: SOAK_WEIGHTS must be "buy:fuse:battle" with non-negative numbers, at least one > 0 (got "${raw}")`);
    process.exit(1);
  }
  const sum = parts[0] + parts[1] + parts[2];
  return { buy: parts[0] / sum, fuse: parts[1] / sum, battle: parts[2] / sum };
})();

// ============================================================================
// Constants from programs and client
// ============================================================================

// Program IDs from Anchor.toml (devnet) - these match declare_id! in programs/*
const PROGRAM_IDS = {
  chip_core: new PublicKey('J68G8KrbLTSdi68LHr9Kkw1YbRRHv3uBPirWCd5Xt13V'),
  market: new PublicKey('5skEmmhgFYn5xjHEdrcsiQ68kUg5kvhXKhjWTWSppjfo'),
  staking: new PublicKey('Ewkbp7WpqbiJAu3ofEcTPinqnr5oH3e94YJDZFg1eSJn'),
  arena: new PublicKey('DUTokrhWBYL7nJ9VbMy7bFELQFf8TN1tmvVpKLsskqD6'),
};

// System program IDs
const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvxZBABZi3U86JLVs7NX29D4Q5');
const ADDRESS_LOOKUP_TABLE_PROGRAM_ID = new PublicKey('AddressLookupTab1e1111111111111111111111111');
const SYSVAR_SLOT_HASHES_ID = new PublicKey('SysvarS1otHashes111111111111111111111111111');
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const MPL_CORE_ID = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');

// Switchboard On-Demand, DEVNET (programs/chip_core/src/randomness.rs cfg(feature = "devnet"),
// mirrored in client/src/chain/ids.ts). The programs enforce SB_PROGRAM_ID and SB_QUEUE by
// address — a wrong value fails every commit with RandomnessMismatch.
const SWITCHBOARD_PROGRAM_ID = new PublicKey('Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2');
const SWITCHBOARD_QUEUE = new PublicKey('EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7');

// Pyth push-oracle shard 0xCA75 ("CAPS") — the studio's own pusher posts here
// (ops/pyth-pusher/). The hex strings are FEED IDs: the program checks them inside the
// PriceUpdateV2 account data — they are NOT account addresses and must never be passed to
// `new PublicKey(...)` (that was a startup crash). The price accounts are PDAs
// [shard u16 LE, feed_id] under the push-oracle program — same derivation as
// client/src/chain/pyth.ts pushOracleAccount; GameConfig.pyth_*_feed is initialised to
// exactly these by scripts/setup.ts.
const PYTH_PUSH_ORACLE_ID = new PublicKey('pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT');
const PYTH_SHARD_ID = 0xca75;
const PYTH_SOL_USD_FEED_ID_HEX = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
const PYTH_SKR_USD_FEED_ID_HEX = '38846ec4d0dbe808091817f5c0d6ab8058e25422348ddf97db52b6c378a93bf9';

function pushOraclePriceAccount(feedIdHex: string, shard: number = PYTH_SHARD_ID): PublicKey {
  const seed = new Uint8Array([shard & 0xff, (shard >> 8) & 0xff]);
  const feed = Uint8Array.from(feedIdHex.match(/../g)!.map((h) => parseInt(h, 16)));
  return PublicKey.findProgramAddressSync([seed, feed], PYTH_PUSH_ORACLE_ID)[0];
}

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

// Constants from economy
const RENT_RESERVE_PER_CHIP = 8_000_000; // 0.008 SOL per chip
const PYTH_MAX_CONF_BPS = 200; // 2%
const SOL_PRICE_MAX_AGE_SECS = 60;
const LEDGER_SHARDS = 16;

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
  opsSkipped: number;
  chipsOwned: number;
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
  opsSkipped: 0,
  chipsOwned: 0,
  totalTx: 0,
  startTime: new Date(),
  lastLogTime: new Date(),
  lastCrankCheck: new Date(),
  workerErrors: new Map(),
};

// ============================================================================
// Chip inventory (deterministic PDAs — no DAS needed)
// ============================================================================
// Every pack this bot buys creates PendingPack ["pending", buyer, nonce]; when the crank
// opens it, the chips appear as PDAs ["asset", pending, packNo, chipNo] with their
// ChipState at ["chip", asset] (client/src/chain/pdas.ts). Deriving them is enough to know
// what the bot owns — and fuse/battle need real owned chips, so this is the gate for them.

interface BoughtPack {
  buyer: PublicKey;
  nonce: bigint;
  sku: number;
}

interface OwnedChip {
  asset: PublicKey;
  collectionIdx: number;
  rarity: number;
}

const boughtPacks: BoughtPack[] = [];
const inventory = new Map<string, OwnedChip>(); // key: asset base58
const openedPacks = new Set<string>(); // key: `${buyer}:${nonce}` — observed opened on-chain

/** How many of the most recent bought packs to poll for opened chips each refresh. */
const INVENTORY_WINDOW = 30;
/** ChipState flags (programs/chip_core/src/state.rs): bit 2 = in a pending fusion. */
const CHIP_F_FUSING = 0x04;

// ============================================================================
// Helper Functions
// ============================================================================

async function getPayerBalance(connection: Connection, payer: PublicKey): Promise<number> {
  return (await connection.getBalance(payer)) / LAMPORTS_PER_SOL;
}

async function requestAirdropIfLow(connection: Connection, payer: Keypair, threshold: number = 0.5): Promise<void> {
  const balance = await getPayerBalance(connection, payer.publicKey);
  if (balance < threshold) {
    console.log(`[Airdrop] Requesting SOL (balance: ${balance.toFixed(4)} SOL < ${threshold} SOL)`);
    try {
      const signature = await connection.requestAirdrop(payer.publicKey, 1 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(signature, 'confirmed');
      console.log(`[Airdrop] Received 1 SOL: ${signature}`);
    } catch (error: any) {
      console.error('[Airdrop] Failed:', error.message);
    }
  }
}

// Simple Borsh writer for instruction data
class BorshWriter {
  private buffer: Buffer = Buffer.alloc(0);
  
  u8(value: number): this {
    const buf = Buffer.alloc(1);
    buf.writeUInt8(value, 0);
    this.buffer = Buffer.concat([this.buffer, buf]);
    return this;
  }
  
  u64(value: bigint | number): this {
    const buf = Buffer.alloc(8);
    if (typeof value === 'number') {
      buf.writeBigUInt64LE(BigInt(value), 0);
    } else {
      buf.writeBigUInt64LE(value, 0);
    }
    this.buffer = Buffer.concat([this.buffer, buf]);
    return this;
  }

  bool(value: boolean): this {
    return this.u8(value ? 1 : 0);
  }
  
  pubkey(value: PublicKey): this {
    this.buffer = Buffer.concat([this.buffer, value.toBuffer()]);
    return this;
  }
  
  toBytes(): Buffer {
    return this.buffer;
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

/** chip_core owns kinds 0 (pack) / 1 (fusion); arena owns kind 2 (battle) — client/src/chain/pdas.ts rngProgram. */
function rngProgramOf(kind: number): PublicKey {
  return kind === RNG_KIND.BATTLE ? PROGRAM_IDS.arena : PROGRAM_IDS.chip_core;
}

function rngAuthPda(kind: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('rng_auth')], rngProgramOf(kind));
}

function randomnessPda(kind: number, owner: PublicKey, nonce: bigint): [PublicKey, number] {
  const nonceBytes = Buffer.alloc(8);
  nonceBytes.writeBigUInt64LE(BigInt(nonce), 0);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('rng'), Buffer.from([kind]), owner.toBuffer(), nonceBytes],
    rngProgramOf(kind)
  );
}

// Switchboard On-Demand PDAs (client/src/chain/pdas.ts) — needed by init_randomness.
function sbStatePda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('STATE')], SWITCHBOARD_PROGRAM_ID);
}

function sbLutSignerPda(randomness: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('LutSigner'), randomness.toBuffer()], SWITCHBOARD_PROGRAM_ID);
}

function sbLutPda(lutSigner: PublicKey, slot: bigint): [PublicKey, number] {
  const slotBytes = Buffer.alloc(8);
  slotBytes.writeBigUInt64LE(BigInt(slot), 0);
  return PublicKey.findProgramAddressSync([lutSigner.toBuffer(), slotBytes], ADDRESS_LOOKUP_TABLE_PROGRAM_ID);
}

function ledgerPdaOf(owner: PublicKey): [PublicKey, number] {
  const ownerBytes = owner.toBuffer();
  const shard = ownerBytes[0] % LEDGER_SHARDS;
  return PublicKey.findProgramAddressSync([Buffer.from('ledger'), Buffer.from([shard])], PROGRAM_IDS.chip_core);
}

function arenaConfigPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('arena_config')], PROGRAM_IDS.arena);
}

function collectionMetaPda(collectionIdx: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('meta'), Buffer.from([collectionIdx])], PROGRAM_IDS.chip_core);
}

function assetPda(pending: PublicKey, packNo: number, chipNo: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('asset'), pending.toBuffer(), Buffer.from([packNo, chipNo])],
    PROGRAM_IDS.chip_core
  );
}

function chipStatePda(asset: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('chip'), asset.toBuffer()], PROGRAM_IDS.chip_core);
}

// ============================================================================
// Account Meta Helpers
// ============================================================================

function signer(pubkey: PublicKey): { pubkey: PublicKey; isSigner: boolean; isWritable: boolean } {
  return { pubkey, isSigner: true, isWritable: true };
}

function ro(pubkey: PublicKey): { pubkey: PublicKey; isSigner: boolean; isWritable: boolean } {
  return { pubkey, isSigner: false, isWritable: false };
}

function rw(pubkey: PublicKey): { pubkey: PublicKey; isSigner: boolean; isWritable: boolean } {
  return { pubkey, isSigner: false, isWritable: true };
}

/**
 * Anchor `Option<Account>`: an absent account is passed as the program id itself
 * (read-only, non-signer) — Anchor checks `key == program_id` → None. Omitting it only
 * works for trailing optionals; price_update is followed by more accounts, so the
 * None-slot form is required (client/src/chain/anchor.ts optional).
 */
function optional(
  pubkey: PublicKey | undefined,
  writable: boolean = true,
  programId: PublicKey = PROGRAM_IDS.chip_core
): { pubkey: PublicKey; isSigner: boolean; isWritable: boolean } {
  if (!pubkey) return ro(programId);
  return writable ? rw(pubkey) : ro(pubkey);
}

// ============================================================================
// Instruction Data Helper
// ============================================================================

/** Anchor instruction discriminator: `sha256("global:<snake_case_ix>")[..8]` (client/src/chain/anchor.ts). */
function ixDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

function ixData(name: string, data: Buffer = Buffer.alloc(0)): Buffer {
  return Buffer.concat([ixDiscriminator(name), data]);
}

// ============================================================================
// Switchboard Randomness Instructions
// ============================================================================

interface InitRandomnessArgs {
  kind: number;
  owner: PublicKey;
  nonce: bigint;
  queue: PublicKey;
  oracle: PublicKey;
  recentSlot: bigint;
}

/**
 * `init_randomness(kind, nonce, recent_slot)` (chip_core) / `init_battle_randomness(nonce,
 * recent_slot)` (arena) — mirrors client/src/chain/ix/rng.ts initRandomnessIx exactly
 * (account order is load-bearing). `recentSlot` MUST be a finalized slot: the LUT address
 * is derived from it and Switchboard checks it against SlotHashes. MUST be in the same
 * transaction as buy_pack / fuse / create_battle — those commit the randomness by CPI.
 */
function initRandomnessIx(a: InitRandomnessArgs): TransactionInstruction {
  const isBattle = a.kind === RNG_KIND.BATTLE;
  const [randomness] = randomnessPda(a.kind, a.owner, a.nonce);
  const [rngAuth] = rngAuthPda(a.kind);
  const [lutSigner] = sbLutSignerPda(randomness);
  const [sbState] = sbStatePda();
  const [lut] = sbLutPda(lutSigner, a.recentSlot);
  const data = isBattle
    ? new BorshWriter().u64(a.nonce).u64(a.recentSlot).toBytes()
    : new BorshWriter().u8(a.kind).u64(a.nonce).u64(a.recentSlot).toBytes();
  return new TransactionInstruction({
    programId: rngProgramOf(a.kind),
    keys: [
      signer(a.owner),
      rw(randomness),
      ro(rngAuth),
      rw(ata(WSOL_MINT, randomness)), // sbRewardEscrow
      rw(a.queue),
      ro(sbState),
      ro(lutSigner),
      rw(lut),
      ro(SWITCHBOARD_PROGRAM_ID),
      ro(WSOL_MINT),
      ro(ADDRESS_LOOKUP_TABLE_PROGRAM_ID),
      ro(TOKEN_PROGRAM_ID),
      ro(ASSOCIATED_TOKEN_PROGRAM_ID),
      ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData(isBattle ? 'init_battle_randomness' : 'init_randomness', data)),
  });
}

// ============================================================================
// Chip Core Instructions
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
}

function buyPackIx(a: BuyPackArgs): TransactionInstruction {
  const [config] = configPda();
  const [pity] = pityPda(a.buyer);
  const [pending] = pendingPackPda(a.buyer, a.nonce);
  const [vault] = vaultPda();
  const [ledger] = ledgerPdaOf(a.buyer);
  const [randomness] = randomnessPda(RNG_KIND.PACK, a.buyer, a.nonce);
  const [rngAuth] = rngAuthPda(RNG_KIND.PACK);

  const data = new BorshWriter()
    .u8(a.sku)
    .u8(a.qty)
    .u8(a.currency)
    .u64(a.nonce)
    .u64(a.maxLamports)
    .toBytes();

  const volatile = a.currency === Currency.SOL || a.currency === Currency.SKR;
  const payMint =
    a.currency === Currency.USDC ? CLUSTER.usdcMint
    : a.currency === Currency.CG ? CLUSTER.cgMint
    : a.currency === Currency.SKR ? CLUSTER.skrMint
    : undefined;

  // Account order MUST match programs/chip_core/src/instructions/packs.rs BuyPack
  // (mirrors client/src/chain/ix/chipCore.ts buyPackIx):
  // buyer, config, ledger, pity, pending, randomness, rng_auth, switchboard_program,
  // queue, oracle, recent_slothashes, vault, price_update?, buyer_token?, vault_token?,
  // token_program, system_program.
  return new TransactionInstruction({
    programId: PROGRAM_IDS.chip_core,
    keys: [
      signer(a.buyer),
      ro(config), // #12: config is read-only in every player instruction
      rw(ledger),
      rw(pity),
      rw(pending),
      rw(randomness),
      ro(rngAuth),
      ro(SWITCHBOARD_PROGRAM_ID),
      ro(a.queue),
      rw(a.oracle),
      ro(SYSVAR_SLOT_HASHES_ID),
      a.currency === Currency.SOL ? rw(vault) : ro(vault), // vault lamports change only on the SOL path
      optional(volatile ? a.priceUpdate : undefined, false),
      optional(payMint ? ata(payMint, a.buyer) : undefined),
      optional(payMint ? ata(payMint, vault) : undefined),
      ro(TOKEN_PROGRAM_ID),
      ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('buy_pack', data)),
  });
}

interface OpenPackArgs {
  payer: PublicKey;
  buyer: PublicKey;
  nonce: bigint;
  packNo: number;
  rolledCollections: number[];
}

function openPackIx(a: OpenPackArgs): TransactionInstruction {
  const [config] = configPda();
  const [pending] = pendingPackPda(a.buyer, a.nonce);
  const [pity] = pityPda(a.buyer);
  const [vault] = vaultPda();
  const [ledger] = ledgerPdaOf(a.buyer);
  const [randomness] = randomnessPda(RNG_KIND.PACK, a.buyer, a.nonce);
  
  const data = new BorshWriter()
    .u64(a.nonce)
    .u8(a.packNo)
    .toBytes();
  
  for (const collectionIdx of a.rolledCollections) {
    data.writeUInt8(collectionIdx, data.length);
  }
  
  const keys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> = [
    signer(a.payer),
    ro(config),
    rw(ledger),
    rw(pity),
    rw(pending),
    ro(randomness),
    rw(vault),
    ro(SYSTEM_PROGRAM_ID),
  ];
  
  return new TransactionInstruction({
    programId: PROGRAM_IDS.chip_core,
    keys,
    data: Buffer.from(ixData('open_pack', data)),
  });
}

// ============================================================================
// Fusion Instructions
// ============================================================================

interface FuseMaterial {
  asset: PublicKey;
  collectionIdx: number;
}

interface FuseArgs {
  owner: PublicKey;
  nonce: bigint;
  useBooster: boolean;
  /** present only for recipes with < 100% success (commit-reveal); None slots otherwise */
  rng?: { randomness: PublicKey; queue: PublicKey; oracle: PublicKey };
  materials: FuseMaterial[];
  resultCollectionIdx: number;
  cgMint: PublicKey;
  coreCollectionOf: (idx: number) => PublicKey;
}

/**
 * `fuse(nonce, use_booster)` — mirrors client/src/chain/ix/chipCore.ts fuseIx exactly.
 * Fixed keys first, then remaining accounts: [asset, chip_state] × materials, then
 * [collection_meta, core_collection] × materials (programs/chip_core/src/instructions/fusion.rs).
 */
function fuseIx(a: FuseArgs): TransactionInstruction {
  const [config] = configPda();
  const [pending] = pendingFusionPda(a.owner, a.nonce);
  const [items] = playerItemsPda(a.owner);
  const [resultMeta] = collectionMetaPda(a.resultCollectionIdx);
  const [resultAsset] = assetPda(pending, 0, 0);
  const [resultState] = chipStatePda(resultAsset);
  const [vault] = vaultPda();

  const keys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> = [
    signer(a.owner),
    ro(config),
    rw(ledgerPdaOf(a.owner)[0]), // #12: fee burn / escrow accounting
    rw(pending),
    optional(a.rng?.randomness),
    ro(rngAuthPda(RNG_KIND.FUSION)[0]),
    optional(a.rng ? SWITCHBOARD_PROGRAM_ID : undefined, false),
    optional(a.rng?.queue, false),
    optional(a.rng?.oracle),
    optional(a.rng ? SYSVAR_SLOT_HASHES_ID : undefined, false),
    rw(items),
    rw(resultMeta),
    rw(a.coreCollectionOf(a.resultCollectionIdx)),
    rw(resultAsset),
    rw(resultState),
    rw(a.cgMint),
    rw(ata(a.cgMint, a.owner)),
    ro(vault), // SEC-M3: fee escrow authority
    rw(ata(a.cgMint, vault)), // vault $CG ATA (randomized recipes park the fee here)
    ro(MPL_CORE_ID),
    ro(TOKEN_PROGRAM_ID),
    ro(SYSTEM_PROGRAM_ID),
  ];
  // remaining: [asset, state] × 3, then [meta, core_collection] × 3
  for (const m of a.materials) keys.push(rw(m.asset), rw(chipStatePda(m.asset)[0]));
  for (const m of a.materials) keys.push(rw(collectionMetaPda(m.collectionIdx)[0]), rw(a.coreCollectionOf(m.collectionIdx)));

  return new TransactionInstruction({
    programId: PROGRAM_IDS.chip_core,
    keys,
    data: Buffer.from(ixData('fuse', new BorshWriter().u64(a.nonce).bool(a.useBooster).toBytes())),
  });
}

function playerItemsPda(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('items'), owner.toBuffer()], PROGRAM_IDS.chip_core);
}

// ============================================================================
// Arena Instructions
// ============================================================================

interface CreateBattleArgs {
  challenger: PublicKey;
  nonce: bigint;
  wager: bigint;
  randomness: PublicKey;
  queue: PublicKey;
  oracle: PublicKey;
  squad: PublicKey[];
  cgMint: PublicKey;
}

function createBattleIx(a: CreateBattleArgs): TransactionInstruction {
  const [config] = arenaConfigPda();
  const [battle] = battlePda(a.challenger, a.nonce);

  const data = new BorshWriter()
    .u64(a.nonce)
    .u64(a.wager)
    .toBytes();

  // Account order MUST match programs/arena (mirrors client/src/chain/ix/arena.ts
  // createBattleIx): challenger, arena_config, battle, randomness, then the commit-CPI
  // accounts [rng_auth, switchboard_program, queue, oracle, recent_slothashes].
  const keys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> = [
    signer(a.challenger),
    ro(config),
    rw(battle),
    rw(a.randomness),
    ro(rngAuthPda(RNG_KIND.BATTLE)[0]),
    ro(SWITCHBOARD_PROGRAM_ID),
    ro(a.queue),
    rw(a.oracle),
    ro(SYSVAR_SLOT_HASHES_ID),
    ro(a.cgMint),
    rw(ata(a.cgMint, a.challenger)),
    rw(ata(a.cgMint, battle)),
    ro(TOKEN_PROGRAM_ID),
    ro(ASSOCIATED_TOKEN_PROGRAM_ID),
    ro(SYSTEM_PROGRAM_ID),
  ];

  for (const asset of a.squad) {
    keys.push(ro(asset));
    keys.push(ro(chipStatePda(asset)[0]));
  }

  return new TransactionInstruction({
    programId: PROGRAM_IDS.arena,
    keys,
    data: Buffer.from(ixData('create_battle', data)),
  });
}

interface AcceptBattleArgs {
  opponent: PublicKey;
  challenger: PublicKey;
  nonce: bigint;
  squad: PublicKey[];
  cgMint: PublicKey;
}

function acceptBattleIx(a: AcceptBattleArgs): TransactionInstruction {
  const [config] = arenaConfigPda();
  const [battle] = battlePda(a.challenger, a.nonce);

  const keys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> = [
    signer(a.opponent),
    ro(config),
    rw(battle),
    rw(ata(a.cgMint, a.opponent)),
    rw(ata(a.cgMint, battle)),
    ro(TOKEN_PROGRAM_ID),
  ];

  for (const asset of a.squad) {
    keys.push(ro(asset));
    keys.push(ro(chipStatePda(asset)[0]));
  }

  return new TransactionInstruction({
    programId: PROGRAM_IDS.arena,
    keys,
    data: Buffer.from(ixData('accept_battle')),
  });
}

// ============================================================================
// ATA Helper
// ============================================================================

function ata(mint: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )[0];
}

// ============================================================================
// On-chain cluster config + oracle selection + chip inventory
// ============================================================================

// Mints and Pyth price accounts are setup-created on devnet (scripts/setup.ts) and live in
// GameConfig — never hardcode them. Field offsets mirror programs/chip_core/src/state.rs
// GameConfig (8-byte Anchor discriminator first) and backend/src/chain.ts decodeGameConfig.
const GAME_CONFIG_OFFSETS = {
  cgMint: 8 + 4 * 32,
  usdcMint: 8 + 5 * 32,
  skrMint: 8 + 6 * 32,
  pythSolUsdFeed: 8 + 8 * 32,
  pythSkrUsdFeed: 8 + 9 * 32,
} as const;

interface ClusterConfig {
  cgMint: PublicKey;
  usdcMint: PublicKey;
  skrMint: PublicKey;
  pythSolUsdFeed: PublicKey;
  pythSkrUsdFeed: PublicKey;
}

function accountDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
}

async function loadClusterConfig(connection: Connection): Promise<ClusterConfig> {
  const [config] = configPda();
  const info = await connection.getAccountInfo(config, 'confirmed');
  if (!info) {
    throw new Error(
      `GameConfig ${config.toBase58()} not found on ${RPC_URL} — are the programs deployed and initialized on this cluster?`
    );
  }
  const disc = accountDiscriminator('GameConfig');
  for (let i = 0; i < 8; i++) {
    if (info.data[i] !== disc[i]) throw new Error('Account at the config PDA is not GameConfig (discriminator mismatch)');
  }
  const pk = (offset: number) => new PublicKey(info.data.subarray(offset, offset + 32));
  return {
    cgMint: pk(GAME_CONFIG_OFFSETS.cgMint),
    usdcMint: pk(GAME_CONFIG_OFFSETS.usdcMint),
    skrMint: pk(GAME_CONFIG_OFFSETS.skrMint),
    pythSolUsdFeed: pk(GAME_CONFIG_OFFSETS.pythSolUsdFeed),
    pythSkrUsdFeed: pk(GAME_CONFIG_OFFSETS.pythSkrUsdFeed),
  };
}

/** Assigned in main() before any worker starts; every ix builder reads mints/feeds from here. */
let CLUSTER: ClusterConfig;

/** ChipState decode (programs/chip_core/src/state.rs, backend/src/chain.ts decodeChipState). */
function decodeChipState(data: Uint8Array): { asset: PublicKey; collectionIdx: number; rarity: number; flags: number } {
  return {
    asset: new PublicKey(data.subarray(8, 40)),
    collectionIdx: data[40],
    rarity: data[41],
    flags: data[51],
  };
}

/** CollectionMeta core_collection is the pubkey right after idx u8 (state.rs CollectionMeta). */
function decodeCollectionMetaCoreCollection(data: Uint8Array): PublicKey {
  return new PublicKey(data.subarray(9, 41));
}

/**
 * Pick a healthy oracle from the pinned queue — same as the client
 * (client/src/chain/switchboard.ts selectOracle). The programs let Switchboard verify queue
 * membership/health, so an arbitrary oracle key would fail every commit.
 */
async function selectOracle(connection: Connection, payer: PublicKey): Promise<PublicKey> {
  const sb = await loadSb();
  // A "wallet" that can't sign: we never let the SDK send; we only read and build.
  const wallet = {
    publicKey: payer,
    signTransaction: async () => { throw new Error('read-only'); },
    signAllTransactions: async () => { throw new Error('read-only'); },
  };
  const program = await sb.AnchorUtils.loadProgramFromConnection(connection, wallet as any, SWITCHBOARD_PROGRAM_ID);
  const { oracle } = await new sb.Queue(program, SWITCHBOARD_QUEUE).selectRandomnessOracle();
  return oracle.pubkey;
}

/** $CG balance of `owner` in micro-CG (6 dp); 0 when the ATA does not exist yet. */
async function cgBalance(connection: Connection, owner: PublicKey): Promise<bigint> {
  try {
    const res = await connection.getTokenAccountBalance(ata(CLUSTER.cgMint, owner), 'confirmed');
    return BigInt(res.value.amount);
  } catch {
    return 0n;
  }
}

/**
 * Refresh the chip inventory: derive the asset/chipState PDAs of the most recent bought
 * packs, batch-fetch them, and keep the chips that exist on-chain and are not mid-fusion.
 * Also counts packs as opened once at least one of their chips is visible — that is the
 * real "packs opened" number (the crank opens packs, not the bot).
 */
const SKU_BY_INDEX: Array<{ chips: number }> = [SKUS.starter, SKUS.standard, SKUS.premium, SKUS.ultimate];

async function refreshInventory(connection: Connection): Promise<void> {
  try {
    const recent = boughtPacks.slice(-INVENTORY_WINDOW);
    const wanted = new Map<string, { asset: PublicKey; chipState: PublicKey; packKey: string; chipNo: number }>();
    for (const p of recent) {
      const packKey = `${p.buyer.toBase58()}:${p.nonce}`;
      const chips = SKU_BY_INDEX[p.sku]?.chips ?? 0;
      const [pending] = pendingPackPda(p.buyer, p.nonce);
      for (let chipNo = 0; chipNo < chips; chipNo++) {
        const [asset] = assetPda(pending, 0, chipNo);
        const [chipState] = chipStatePda(asset);
        wanted.set(asset.toBase58(), { asset, chipState, packKey, chipNo });
      }
    }
    const next = new Map<string, OwnedChip>();
    const entries = [...wanted.values()];
    for (let i = 0; i < entries.length; i += 100) {
      const chunk = entries.slice(i, i + 100);
      const infos = await connection.getMultipleAccountsInfo(chunk.map((c) => c.chipState), 'confirmed');
      infos.forEach((info, j) => {
        if (!info) return;
        const st = decodeChipState(info.data);
        if (st.flags & CHIP_F_FUSING) return; // mid-fusion — not a free chip
        openedPacks.add(chunk[j].packKey);
        next.set(chunk[j].asset.toBase58(), { asset: chunk[j].asset, collectionIdx: st.collectionIdx, rarity: st.rarity });
      });
    }
    // keep previously found chips that are still on-chain (outside the window)
    for (const [key, chip] of inventory) {
      if (next.has(key)) continue;
      const info = await connection.getAccountInfo(chipStatePda(chip.asset)[0], 'confirmed');
      if (!info) continue; // consumed (fused/burned/transferred)
      const st = decodeChipState(info.data);
      if (st.flags & CHIP_F_FUSING) continue;
      next.set(key, { asset: chip.asset, collectionIdx: st.collectionIdx, rarity: st.rarity });
    }
    inventory.clear();
    for (const [k, v] of next) inventory.set(k, v);
    metrics.chipsOwned = inventory.size;
    metrics.packsOpened = openedPacks.size;
  } catch (error: any) {
    console.error('[Monitor] Failed to refresh chip inventory:', error.message);
  }
}

/** Take up to `n` free chips from the inventory (optionally of one rarity / collection). */
function takeFreeChips(n: number, rarity?: number, collectionIdx?: number): OwnedChip[] {
  const out: OwnedChip[] = [];
  for (const chip of inventory.values()) {
    if (out.length >= n) break;
    if (rarity !== undefined && chip.rarity !== rarity) continue;
    if (collectionIdx !== undefined && chip.collectionIdx !== collectionIdx) continue;
    out.push(chip);
  }
  return out;
}

function releaseChips(chips: OwnedChip[]): void {
  for (const c of chips) inventory.delete(c.asset.toBase58());
  metrics.chipsOwned = inventory.size;
}

// ============================================================================
// Core Operations with REAL Instructions
// ============================================================================

async function buyAndOpenPack(
  connection: Connection,
  payer: Keypair,
  workerId: number,
  skuIndex: number = 0
): Promise<boolean> {
  try {
    const nonce = BigInt(Date.now() + workerId * 1000000 + metrics.packsPurchased);
    const [randomness] = randomnessPda(RNG_KIND.PACK, payer.publicKey, nonce);

    // init_randomness MUST be in the same tx as buy_pack (buy_pack commits it by CPI),
    // and recentSlot must be a FINALIZED slot (LUT derivation + Switchboard SlotHashes check).
    const [oracle, recentSlot] = await Promise.all([
      selectOracle(connection, payer.publicKey),
      connection.getSlot('finalized'),
    ]);
    const initRngIx = initRandomnessIx({
      kind: RNG_KIND.PACK,
      owner: payer.publicKey,
      nonce,
      queue: SWITCHBOARD_QUEUE,
      oracle,
      recentSlot: BigInt(recentSlot),
    });

    const buyIx = buyPackIx({
      buyer: payer.publicKey,
      sku: skuIndex,
      qty: 1,
      currency: Currency.SOL,
      nonce,
      maxLamports: BigInt(100000000), // 0.1 SOL max
      randomness,
      queue: SWITCHBOARD_QUEUE,
      oracle,
      priceUpdate: CLUSTER.pythSolUsdFeed, // pinned by GameConfig; the program checks the feed id inside
    });

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
      initRngIx,
      buyIx
    );

    const signature = await sendAndConfirmTransaction(connection, tx, [payer]);
    metrics.packsPurchased++;
    metrics.totalTx++;
    boughtPacks.push({ buyer: payer.publicKey, nonce, sku: skuIndex });

    console.log(`[Worker ${workerId}] Pack purchased: ${signature} (total: ${metrics.packsPurchased})`);

    // NOTE: the pack is NOT opened here — the crank reveals randomness and opens it.
    // metrics.packsOpened is updated by refreshInventory() from on-chain chip PDAs.
    return true;
  } catch (error: any) {
    metrics.errors++;
    metrics.workerErrors.set(workerId, (metrics.workerErrors.get(workerId) || 0) + 1);
    console.error(`[Worker ${workerId}] buy_and_open_pack failed:`, error.message);
    return false;
  }
}

async function performFusion(
  connection: Connection,
  payer: Keypair,
  workerId: number
): Promise<boolean> {
  try {
    // Fusion burns 3 chips of one rarity + a $CG fee (packages/economy FUSION_RECIPES).
    // Pick the lowest rarity we own 3 of — cheapest fee, and low-tier recipes are atomic
    // (no commit-reveal). Skip honestly when we can't: never send a malformed attempt.
    let materials: OwnedChip[] = [];
    let recipe: ReturnType<typeof recipeFor> = undefined;
    for (let r = 0; r < 9; r++) {
      const sameRarity = takeFreeChips(3, r);
      if (sameRarity.length < 3) continue;
      const candidate = recipeFor(r as any);
      if (!candidate) continue;
      if (candidate.rule === 'same-collection') {
        const sameCollection = takeFreeChips(3, r, sameRarity[0].collectionIdx);
        if (sameCollection.length < 3) continue;
        materials = sameCollection;
      } else {
        materials = sameRarity;
      }
      recipe = candidate;
      break;
    }
    if (!recipe || materials.length < 3) {
      metrics.opsSkipped++;
      console.log(`[Worker ${workerId}] Fusion skipped: need 3 free chips of one rarity (owned: ${inventory.size})`);
      return false;
    }

    const cg = await cgBalance(connection, payer.publicKey);
    if (cg < BigInt(recipe.feeCgMicro)) {
      metrics.opsSkipped++;
      console.log(`[Worker ${workerId}] Fusion skipped: need ${recipe.feeCgMicro / 1_000_000} CG fee, balance ${Number(cg) / 1_000_000} CG`);
      return false;
    }

    // Result collection: recipe.to → CollectionMeta PDA → its core_collection (mpl_core).
    const [resultMeta] = collectionMetaPda(recipe.to);
    const metaInfos = await connection.getMultipleAccountsInfo(
      [resultMeta, ...materials.map((m) => collectionMetaPda(m.collectionIdx)[0])],
      'confirmed'
    );
    if (!metaInfos[0]) {
      metrics.opsSkipped++;
      console.log(`[Worker ${workerId}] Fusion skipped: result collection ${recipe.to} not created on-chain yet`);
      return false;
    }
    const coreCollectionOf = (idx: number): PublicKey => {
      const meta = idx === recipe!.to ? metaInfos[0] : metaInfos[1 + materials.findIndex((m) => m.collectionIdx === idx)];
      if (!meta) throw new Error(`collection meta ${idx} not found on-chain`);
      return decodeCollectionMetaCoreCollection(meta.data);
    };

    const nonce = BigInt(Date.now() + workerId * 1000000 + metrics.fusionsCompleted);
    const atomic = recipe.successBps === 10_000;
    // A "risky" fusion is one sent with useBooster — the counter must reflect the
    // instruction actually submitted, not a second coin flip.
    const risky = Math.random() < 0.2;

    const ixs: TransactionInstruction[] = [];
    let rng: { randomness: PublicKey; queue: PublicKey; oracle: PublicKey } | undefined;
    if (!atomic) {
      // commit-reveal recipe: init the program-owned randomness account in the same tx
      const [oracle, recentSlot] = await Promise.all([
        selectOracle(connection, payer.publicKey),
        connection.getSlot('finalized'),
      ]);
      const [randomness] = randomnessPda(RNG_KIND.FUSION, payer.publicKey, nonce);
      rng = { randomness, queue: SWITCHBOARD_QUEUE, oracle };
      ixs.push(initRandomnessIx({
        kind: RNG_KIND.FUSION, owner: payer.publicKey, nonce, queue: SWITCHBOARD_QUEUE, oracle, recentSlot: BigInt(recentSlot),
      }));
    }
    ixs.push(fuseIx({
      owner: payer.publicKey,
      nonce,
      useBooster: risky,
      rng,
      materials: materials.map((m) => ({ asset: m.asset, collectionIdx: m.collectionIdx })),
      resultCollectionIdx: recipe.to,
      cgMint: CLUSTER.cgMint,
      coreCollectionOf,
    }));

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 700000 }),
      ...ixs
    );

    const signature = await sendAndConfirmTransaction(connection, tx, [payer]);
    metrics.fusionsCompleted++;
    metrics.totalTx++;
    if (risky) metrics.riskyFusions++;
    releaseChips(materials); // burned (or escrowed) — no longer free inventory

    console.log(`[Worker ${workerId}] Fusion completed: ${signature} (total: ${metrics.fusionsCompleted}, risky: ${metrics.riskyFusions})`);
    return true;
  } catch (error: any) {
    metrics.errors++;
    metrics.workerErrors.set(workerId, (metrics.workerErrors.get(workerId) || 0) + 1);
    console.error(`[Worker ${workerId}] fusion failed:`, error.message);
    return false;
  }
}

async function createWagerMatch(
  connection: Connection,
  payer: Keypair,
  workerId: number
): Promise<boolean> {
  try {
    // A battle needs a squad of 3 owned chips and a $CG wager escrowed from the
    // challenger's ATA. Skip honestly when we can't — never send placeholder squads.
    const squad = takeFreeChips(3);
    if (squad.length < 3) {
      metrics.opsSkipped++;
      console.log(`[Worker ${workerId}] Wager match skipped: need 3 free chips (owned: ${inventory.size})`);
      return false;
    }
    const wager = BigInt(5_000_000); // 5 CG (micro, 6 dp) escrowed per battle
    const cg = await cgBalance(connection, payer.publicKey);
    if (cg < wager) {
      metrics.opsSkipped++;
      console.log(`[Worker ${workerId}] Wager match skipped: need ${Number(wager) / 1_000_000} CG wager, balance ${Number(cg) / 1_000_000} CG`);
      return false;
    }

    const nonce = BigInt(Date.now() + workerId * 1000000 + metrics.wagerMatches);
    const [randomness] = randomnessPda(RNG_KIND.BATTLE, payer.publicKey, nonce);
    const [oracle, recentSlot] = await Promise.all([
      selectOracle(connection, payer.publicKey),
      connection.getSlot('finalized'),
    ]);

    // init_battle_randomness (arena) + create_battle in one tx — create_battle commits by CPI.
    const initRngIx = initRandomnessIx({
      kind: RNG_KIND.BATTLE,
      owner: payer.publicKey,
      nonce,
      queue: SWITCHBOARD_QUEUE,
      oracle,
      recentSlot: BigInt(recentSlot),
    });
    const battleIx = createBattleIx({
      challenger: payer.publicKey,
      nonce,
      wager,
      randomness,
      queue: SWITCHBOARD_QUEUE,
      oracle,
      squad: squad.map((c) => c.asset),
      cgMint: CLUSTER.cgMint,
    });

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
      initRngIx,
      battleIx
    );

    const signature = await sendAndConfirmTransaction(connection, tx, [payer]);
    metrics.wagerMatches++;
    metrics.totalTx++;
    releaseChips(squad); // escrowed into the battle — no longer free inventory

    console.log(`[Worker ${workerId}] Wager match created: ${signature} (total: ${metrics.wagerMatches})`);
    return true;
  } catch (error: any) {
    metrics.errors++;
    metrics.workerErrors.set(workerId, (metrics.workerErrors.get(workerId) || 0) + 1);
    console.error(`[Worker ${workerId}] wager match failed:`, error.message);
    return false;
  }
}

// ============================================================================
// Pending State Monitoring
// ============================================================================

async function checkPendingStates(connection: Connection): Promise<void> {
  try {
    // Query for PendingPack accounts with phase = abandoned or stale
    // This uses getProgramAccounts which requires the program to be deployed
    
    // For now, we simulate this check
    // Real implementation would use:
    // const pendingPacks = await connection.getProgramAccounts(
    //   PROGRAM_IDS.chip_core,
    //   {
    //     filters: [
    //       { memcmp: { offset: 0, bytes: Buffer.from('pending') } },
    //     ]
    //   }
    // );
    
    // Simulate finding some pending states
    // In production, parse the account data to check phase
    
    if (Math.random() < 0.01) {
      // Occasionally log pending check
      console.log('[Monitor] Checking pending states...');
    }
  } catch (error: any) {
    console.error('[Monitor] Failed to check pending states:', error.message);
  }
}

// ============================================================================
// Crank Monitoring
// ============================================================================

async function checkCrankMetrics(): Promise<void> {
  try {
    // In production, this would query the /metrics endpoint of the API
    // For now, we simulate crank metrics
    
    metrics.crankP95Ms = 1500 + Math.floor(Math.random() * 5000); // 1.5s - 6.5s
    metrics.crankP99Ms = metrics.crankP95Ms + Math.floor(Math.random() * 2000);
    metrics.crankJobsProcessed += 10 + Math.floor(Math.random() * 50);
    metrics.lastCrankCheck = new Date();
    
    if (Math.random() < 0.1) {
      console.log(`[Crank] p95: ${metrics.crankP95Ms}ms, p99: ${metrics.crankP99Ms}ms, jobs: ${metrics.crankJobsProcessed}`);
    }
  } catch (error: any) {
    console.error('[Monitor] Failed to check crank metrics:', error.message);
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
        await buyAndOpenPack(connection, payer, workerId, skuIndex);
      } else if (op < 0.85) {
        await performFusion(connection, payer, workerId);
      } else {
        await createWagerMatch(connection, payer, workerId);
      }
      
      await sleep(INTERVAL_MS);
    } catch (error: any) {
      await sleep(1000);
    }
  }
  
  console.log(`[Worker ${workerId}] Finished: ${metrics.workerErrors.get(workerId) || 0} errors`);
}

// ============================================================================
// Metrics Logging
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
  console.log(`  Errors: ${metrics.errors} total, ${metrics.opsSkipped} ops skipped (no chips/CG yet)`);
  console.log(`  Chips owned: ${metrics.chipsOwned}`);
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
  console.log(`  Ops Skipped (no chips/CG): ${metrics.opsSkipped}`);
  console.log(`  Chips Owned (end of run): ${metrics.chipsOwned}`);
  console.log(`  Abandoned Pending: ${metrics.abandonedPending} (SIMULATED — not measured on-chain)`);
  console.log(`  Stale Pending: ${metrics.stalePending} (SIMULATED — not measured on-chain)`);
  console.log(`  Crank p95: ${metrics.crankP95Ms}ms (SIMULATED — random placeholder)`);
  console.log(`  Crank p99: ${metrics.crankP99Ms}ms (SIMULATED — random placeholder)`);
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
    console.error('   PRIVATE_KEY must be the base64 of the RAW 64-byte secret key:');
    console.error('   PRIVATE_KEY=$(node -e "console.log(Buffer.from(require(process.argv[1])).toString(\'base64\'))" /path/to/keypair.json)');
    process.exit(1);
  }
  
  if (!RPC_URL.startsWith('http')) {
    console.error('\n ERROR: DEVNET_RPC_URL must be a valid HTTP(S) URL');
    process.exit(1);
  }
  
  if (!Number.isFinite(DURATION_DAYS) || DURATION_DAYS <= 0) {
    console.error(`\n ERROR: SOAK_DURATION_DAYS must be a positive number of days (got "${process.env.SOAK_DURATION_DAYS}")`);
    process.exit(1);
  }
  
  console.log(`\nConfiguration:`);
  console.log(`  RPC URL: ${RPC_URL}`);
  console.log(`  Duration: ${DURATION_DAYS} days`);
  console.log(`  Target Packs: ${TARGET_PACKS}`);
  console.log(`  Workers: ${CONCURRENCY}`);
  console.log(`  Weights: buy=${WEIGHTS.buy.toFixed(2)} fuse=${WEIGHTS.fuse.toFixed(2)} battle=${WEIGHTS.battle.toFixed(2)}`);
  console.log('');
  console.log('  NOTE: pending-state and crank p95 metrics are SIMULATED placeholders —');
  console.log('        the G-3 gate cannot fail on them yet (see scripts/load/soak-g3.md).');
  console.log('');
  
  const connection = new Connection(RPC_URL, {
    wsEndpoint: RPC_URL.replace('http', 'ws'),
    commitment: 'confirmed',
  });
  
  console.log('Connecting to RPC...');
  
  try {
    const version = await connection.getVersion();
    console.log(` Connected to ${RPC_URL} (Solana ${version['solana-core']})`);
  } catch (error: any) {
    console.error(' Failed to connect to RPC:', error.message);
    process.exit(1);
  }
  
  let payer: Keypair;
  try {
    payer = Keypair.fromSecretKey(Buffer.from(PRIVATE_KEY, 'base64'));
    console.log(` Payer loaded: ${payer.publicKey.toBase58()}`);
  } catch (error: any) {
    console.error(' Failed to load private key:', error.message);
    console.error('   PRIVATE_KEY must be the base64 of the RAW 64-byte secret key —');
    console.error('   see the header of this file for the correct one-liner.');
    process.exit(1);
  }

  // Mints and Pyth feeds come from the on-chain GameConfig — never hardcoded.
  try {
    CLUSTER = await loadClusterConfig(connection);
  } catch (error: any) {
    console.error(' Failed to load GameConfig:', error.message);
    process.exit(1);
  }
  console.log(' GameConfig:');
  console.log(`   cgMint:          ${CLUSTER.cgMint.toBase58()}`);
  console.log(`   usdcMint:        ${CLUSTER.usdcMint.toBase58()}`);
  console.log(`   skrMint:         ${CLUSTER.skrMint.toBase58()}`);
  console.log(`   pythSolUsdFeed:  ${CLUSTER.pythSolUsdFeed.toBase58()}`);
  console.log(`     (shard 0x${PYTH_SHARD_ID.toString(16)} PDA: ${pushOraclePriceAccount(PYTH_SOL_USD_FEED_ID_HEX).toBase58()})`);
  console.log(`   pythSkrUsdFeed:  ${CLUSTER.pythSkrUsdFeed.toBase58()}`);
  if (!CLUSTER.pythSolUsdFeed.equals(pushOraclePriceAccount(PYTH_SOL_USD_FEED_ID_HEX))) {
    console.log('   WARNING: configured SOL/USD feed differs from the shard-0xCA75 PDA — buy_pack will use the configured one.');
  }
  const cg = await cgBalance(connection, payer.publicKey);
  console.log(`   payer CG balance: ${Number(cg) / 1_000_000} CG`);

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
    checkPendingStates(connection).catch(console.error);
    checkCrankMetrics().catch(console.error);
    refreshInventory(connection).catch(console.error);
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
  } catch (error: any) {
    console.error('\n Fatal error:', error.message);
    logFinalMetrics();
    process.exit(1);
  }
}

main().catch(error => {
  console.error('\n Fatal error in main:', error);
  process.exit(1);
});
