// On-chain glue for the crank: PDAs, account decoders and the instruction
// builders the worker needs (reveal_randomness / Bubblegum mint / proof
// registration / fuse_reveal / close_randomness + the arena twins). Deliberately a mirror of
// client/src/chain/{pdas,ix/rng,ix/chipCore,accounts}.ts rather than a shared
// package: the client is bundled by Vite with `@/app/config` aliases, the
// backend runs on plain Node — and the *program* is the contract both sides
// follow (account order == the `#[derive(Accounts)]` structs in
// programs/chip_core/src/instructions/{rng,packs,fusion}.rs and
// programs/arena/src/lib.rs). backend/test/crank.test.ts pins the layouts.
import { PublicKey, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';
import { keccak_256 } from '@noble/hashes/sha3';
import { BorshReader, BorshWriter } from './borsh.ts';
import { PROGRAMS, SWITCHBOARD_PROGRAM_ID } from './config.ts';

// ---------------------------------------------------------------- ids
export const CHIP_CORE_ID = PROGRAMS.chip_core;
export const MARKET_ID = PROGRAMS.market;
export const ARENA_ID = PROGRAMS.arena;
export const MPL_CORE_ID = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
export const MPL_BUBBLEGUM_V2_ID = new PublicKey('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
export const MPL_ACCOUNT_COMPRESSION_ID = new PublicKey('mcmt6YrQEMKw8Mw43FmpRLmf7BqRnFMKmAcbxE3xkAW');
export const MPL_NOOP_ID = new PublicKey('mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3');
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');
export const SYSVAR_SLOT_HASHES_ID = new PublicKey('SysvarS1otHashes111111111111111111111111111');
export const ADDRESS_LOOKUP_TABLE_PROGRAM_ID = new PublicKey('AddressLookupTab1e1111111111111111111111111');
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

// ---------------------------------------------------------------- anchor wire helpers
const enc = (s: string) => new TextEncoder().encode(s);
const u8 = (v: number) => Uint8Array.of(v & 0xff);
export const u64le = (v: bigint | number): Uint8Array => new BorshWriter().u64(v).toBytes();
const disc = (prefix: string, name: string) => sha256(enc(`${prefix}:${name}`)).slice(0, 8);
export const ixDiscriminator = (name: string) => disc('global', name);
export const accountDiscriminator = (name: string) => disc('account', name);
export function ixData(name: string, args: Uint8Array = new Uint8Array()): Buffer {
  return Buffer.concat([ixDiscriminator(name), args]);
}
export const ro = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
export const rw = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
export const signer = (pubkey: PublicKey, writable = true): AccountMeta => ({ pubkey, isSigner: true, isWritable: writable });
/** Anchor `Option<Account<…>>`: absent = the program id itself (readonly). */
export const optional = (pubkey: PublicKey | undefined, programId: PublicKey): AccountMeta => (pubkey ? rw(pubkey) : ro(programId));

export function expectDiscriminator(data: Uint8Array, name: string): BorshReader {
  const d = accountDiscriminator(name);
  for (let i = 0; i < 8; i++) if (data[i] !== d[i]) throw new Error(`Account discriminator mismatch: expected ${name}`);
  return new BorshReader(data, 8);
}
export function hasDiscriminator(data: Uint8Array, name: string): boolean {
  const d = accountDiscriminator(name);
  for (let i = 0; i < 8; i++) if (data[i] !== d[i]) return false;
  return true;
}

// ---------------------------------------------------------------- PDAs
const find = (seeds: Uint8Array[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds.map((s) => Buffer.from(s)), program);

export const configPda = () => find([enc('config')], CHIP_CORE_ID);
export const vaultPda = () => find([enc('vault')], CHIP_CORE_ID);
/** `VaultLedger` shards (#12) — mirrors chip_core `state::LEDGER_SHARDS` / client `LEDGER_SHARDS` (sync-check). */
export const LEDGER_SHARDS = 4;
export const ledgerShardOf = (wallet: PublicKey) => wallet.toBytes()[0] % LEDGER_SHARDS;
export const ledgerPda = (shard: number) => find([enc('ledger'), u8(shard)], CHIP_CORE_ID);
export const ledgerPdaOf = (wallet: PublicKey) => ledgerPda(ledgerShardOf(wallet));
export const allLedgerPdas = () => Array.from({ length: LEDGER_SHARDS }, (_, i) => ledgerPda(i)[0]);
export const collectionMetaPda = (idx: number) => find([enc('collection'), u8(idx)], CHIP_CORE_ID);
export const bubblegumTreeMetaPda = (idx: number) => find([enc('bubblegum_tree'), u8(idx)], CHIP_CORE_ID);
export const chipStatePda = (asset: PublicKey) => find([enc('chip'), asset.toBytes()], CHIP_CORE_ID);
export const compressedChipStatePda = (asset: PublicKey) => find([enc('compressed_chip'), asset.toBytes()], CHIP_CORE_ID);
export const compressedAssetListingPda = (asset: PublicKey) => find([enc('compressed_asset_listing'), asset.toBytes()], MARKET_ID);
/** Stable claim PDA; use the immutable origin, not the mutable current buyer. */
export const compressedMintClaimPda = (origin: PublicKey, claimNonce: bigint) => find([enc('compressed_claim'), origin.toBytes(), u64le(claimNonce)], CHIP_CORE_ID);
export const compressedMintClaimPdaForOrigin = compressedMintClaimPda;
export const compressedSettlementPda = (buyer: PublicKey, nonce: bigint) => find([enc('compressed_settlement'), buyer.toBytes(), u64le(nonce)], CHIP_CORE_ID);
export const bubblegumLeafAssetPda = (merkleTree: PublicKey, leafIndex: number) =>
  find([enc('asset'), merkleTree.toBytes(), new BorshWriter().u32(leafIndex).toBytes()], MPL_BUBBLEGUM_V2_ID);
export const bubblegumTreeConfigPda = (merkleTree: PublicKey) => find([merkleTree.toBytes()], MPL_BUBBLEGUM_V2_ID);
export const pendingPackPda = (buyer: PublicKey, nonce: bigint) => find([enc('pending'), buyer.toBytes(), u64le(nonce)], CHIP_CORE_ID);
export const pityPda = (wallet: PublicKey) => find([enc('pity'), wallet.toBytes()], CHIP_CORE_ID);
export const itemsPda = (wallet: PublicKey) => find([enc('items'), wallet.toBytes()], CHIP_CORE_ID);
export const pendingFusionPda = (owner: PublicKey, nonce: bigint) => find([enc('fusion'), owner.toBytes(), u64le(nonce)], CHIP_CORE_ID);
export const claimFusionPda = (owner: PublicKey, nonce: bigint) => find([enc('claim_fusion'), owner.toBytes(), u64le(nonce)], CHIP_CORE_ID);
export const playerItemsPda = (wallet: PublicKey) => find([enc('items'), wallet.toBytes()], CHIP_CORE_ID);
export const assetPda = (pending: PublicKey, packNo: number, i: number) => find([enc('asset'), pending.toBytes(), u8(packNo), u8(i)], CHIP_CORE_ID);
export const battlePda = (challenger: PublicKey, nonce: bigint) => find([enc('battle'), challenger.toBytes(), u64le(nonce)], ARENA_ID);
export const emissionPda = () => find([enc('emission')], PROGRAMS.staking);
/** SEC-L5: staking's `["season_pool"]` PDA — authority of the arena's season pool ($CG ATA), spent only by `fund_slice`. */
export const seasonPoolAuthPda = () => find([enc('season_pool')], PROGRAMS.staking);
export const seasonPoolAta = (cgMint: PublicKey) => ata(cgMint, seasonPoolAuthPda()[0]);
/** staking `["skr_pool"]` — treasury-funded SKR prize pool (reward currency #2). */
export const skrPoolPda = () => find([enc('skr_pool')], PROGRAMS.staking);

/** Randomness account kinds: 0 pack, 1 fusion (chip_core), 2 battle (arena). */
export const RNG_KIND = { PACK: 0, FUSION: 1, BATTLE: 2, CLAIM_FUSION: 3 } as const;
export type RngKind = (typeof RNG_KIND)[keyof typeof RNG_KIND];
export const rngProgram = (kind: RngKind) => (kind === RNG_KIND.BATTLE ? ARENA_ID : CHIP_CORE_ID);
export const rngAuthPda = (kind: RngKind) => find([enc('rng_auth')], rngProgram(kind));
export const rngPda = (kind: RngKind, owner: PublicKey, nonce: bigint) => find([enc('rng'), u8(kind), owner.toBytes(), u64le(nonce)], rngProgram(kind));

export const sbStatePda = () => find([enc('STATE')], SWITCHBOARD_PROGRAM_ID);
export const sbLutSignerPda = (randomness: PublicKey) => find([enc('LutSigner'), randomness.toBytes()], SWITCHBOARD_PROGRAM_ID);
export const sbLutPda = (lutSigner: PublicKey, slot: bigint) => find([lutSigner.toBytes(), u64le(slot)], ADDRESS_LOOKUP_TABLE_PROGRAM_ID);
export const sbOracleStatsPda = (oracle: PublicKey) => find([enc('OracleRandomnessStats'), oracle.toBytes()], SWITCHBOARD_PROGRAM_ID);

export function ata(mint: PublicKey, owner: PublicKey): PublicKey {
  return find([owner.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
}
export const sbRewardEscrow = (randomness: PublicKey) => ata(WSOL_MINT, randomness);

// ---------------------------------------------------------------- account decoders (programs/chip_core/src/state.rs)
export const RARITY_COUNT = 9;
export const MATERIALS_PER_FUSION = 3;
export const SQUAD = 3;

export interface PackDef {
  chips: number; priceUsdCents: number; priceCgMicro: bigint; oddsBps: number[]; floor: number; dailyCap: number;
  pityTier: number; pityHardAt: number; pitySoftStart: number; pitySoftStepBps: number; featuredOnly: boolean; enabled: boolean;
}
function readPackDef(r: BorshReader): PackDef {
  return {
    chips: r.u8(), priceUsdCents: r.u32(), priceCgMicro: r.u64(), oddsBps: r.array(RARITY_COUNT, () => r.u16()), floor: r.u8(), dailyCap: r.u8(),
    pityTier: r.u8(), pityHardAt: r.u16(), pitySoftStart: r.u16(), pitySoftStepBps: r.u16(), featuredOnly: r.bool(), enabled: r.bool(),
  };
}

export interface GameConfig {
  admin: PublicKey; pendingAdmin: PublicKey; treasury: PublicKey; buybackWallet: PublicKey; cgMint: PublicKey; usdcMint: PublicKey; skrMint: PublicKey;
  stakingProgram: PublicKey; pythSolUsdFeed: PublicKey; pythSkrUsdFeed: PublicKey; featuredCollection: number; paused: boolean; packs: PackDef[];
  marketFeeBps: number; skrDiscountBps: number; collectionsCreated: number;
  paramsVersion: number; vaultBump: number; bump: number;
  /** SEC-H2 hot pauser; `PublicKey.default` = none */
  pauser: PublicKey;
}
/** `VaultLedger` (`["ledger", shard]`, #12): refund liabilities + $CG burn total of one shard. */
export interface VaultLedger { shard: number; liabLamports: bigint; liabUsdc: bigint; liabCg: bigint; liabSkr: bigint; burnedTotal: bigint; bump: number }
export function decodeVaultLedger(data: Uint8Array): VaultLedger {
  const r = expectDiscriminator(data, 'VaultLedger');
  return { shard: r.u8(), liabLamports: r.u64(), liabUsdc: r.u64(), liabCg: r.u64(), liabSkr: r.u64(), burnedTotal: r.u64(), bump: r.u8() };
}
/** Sum of the shards (a missing shard counts as zero — `init_ledger` not run yet). */
export function sumLedgers(shards: (VaultLedger | null | undefined)[]) {
  const t = { liabLamports: 0n, liabUsdc: 0n, liabCg: 0n, liabSkr: 0n, burnedTotal: 0n };
  for (const l of shards) { if (!l) continue; t.liabLamports += l.liabLamports; t.liabUsdc += l.liabUsdc; t.liabCg += l.liabCg; t.liabSkr += l.liabSkr; t.burnedTotal += l.burnedTotal; }
  return t;
}
export function decodeGameConfig(data: Uint8Array): GameConfig {
  const r = expectDiscriminator(data, 'GameConfig');
  return {
    admin: r.pubkey(), pendingAdmin: r.pubkey(), treasury: r.pubkey(), buybackWallet: r.pubkey(), cgMint: r.pubkey(), usdcMint: r.pubkey(), skrMint: r.pubkey(),
    stakingProgram: r.pubkey(), pythSolUsdFeed: r.pubkey(), pythSkrUsdFeed: r.pubkey(), featuredCollection: r.u8(), paused: r.bool(),
    packs: r.array(4, () => readPackDef(r)), marketFeeBps: r.u16(), skrDiscountBps: r.u16(), collectionsCreated: r.u8(),
    paramsVersion: r.u32(), vaultBump: r.u8(), bump: r.u8(),
    pauser: r.remaining >= 32 ? r.pubkey() : PublicKey.default,
  };
}
/** 42-byte Borsh `PackDef` (programs/chip_core/src/economy.rs) — the `set_params` patch carries `Option<[PackDef; 4]>`. */
export function writePackDef(w: BorshWriter, p: PackDef): BorshWriter {
  w.u8(p.chips).u32(p.priceUsdCents).u64(p.priceCgMicro);
  for (const o of p.oddsBps) w.u16(o);
  return w.u8(p.floor).u8(p.dailyCap).u8(p.pityTier).u16(p.pityHardAt).u16(p.pitySoftStart).u16(p.pitySoftStepBps).bool(p.featuredOnly).bool(p.enabled);
}

export const SPLIT_COUNT = 5;
/** staking `EmissionState` (`["emission"]`, programs/staking/src/state.rs) — mirror of client/src/chain/accounts.ts. */
export interface EmissionState {
  admin: PublicKey; cgMint: PublicKey; chipCoreProgram: PublicKey; marketProgram: PublicKey; arenaProgram: PublicKey;
  questOracle: PublicKey; seasonOracle: PublicKey; setOracle: PublicKey; genesisTs: bigint; dayIndex: number;
  mintedTotal: bigint; scheduleMinted: bigint[]; burnRing: bigint[]; burnToday: bigint; splitBps: number[];
  splitChangedAt: bigint; sliceBudget: bigint[]; paused: boolean; bump: number; pauser: PublicKey; burnOracle: PublicKey;
  /** SEC-L5: $CG burned out of the season pool by `fund_slice` / re-minted at claim (supply-neutral recycling of the 20 % rake). */
  recycledTotal: bigint; recycledMinted: bigint;
}
export function decodeEmissionState(data: Uint8Array): EmissionState {
  const r = expectDiscriminator(data, 'EmissionState');
  return {
    admin: r.pubkey(), cgMint: r.pubkey(), chipCoreProgram: r.pubkey(), marketProgram: r.pubkey(), arenaProgram: r.pubkey(),
    questOracle: r.pubkey(), seasonOracle: r.pubkey(), setOracle: r.pubkey(), genesisTs: r.i64(), dayIndex: r.u32(),
    mintedTotal: r.u64(), scheduleMinted: r.array(8, () => r.u64()), burnRing: r.array(7, () => r.u64()), burnToday: r.u64(),
    splitBps: r.array(SPLIT_COUNT, () => r.u16()), splitChangedAt: r.i64(), sliceBudget: r.array(SPLIT_COUNT, () => r.u64()),
    paused: r.bool(), bump: r.u8(), pauser: r.remaining >= 32 ? r.pubkey() : PublicKey.default, burnOracle: r.remaining >= 32 ? r.pubkey() : PublicKey.default,
    recycledTotal: r.remaining >= 8 ? r.u64() : 0n, recycledMinted: r.remaining >= 8 ? r.u64() : 0n,
  };
}

/** staking `SkrPool` (programs/staking/src/state.rs) — invariant vault ≥ budget + reserved; mirror of client/src/chain/accounts.ts. */
export interface SkrPool { skrMint: PublicKey; vault: PublicKey; budget: bigint; reserved: bigint; fundedTotal: bigint; paidTotal: bigint; maxRootBudget: bigint; paused: boolean; bump: number }
export function decodeSkrPool(data: Uint8Array): SkrPool {
  const r = expectDiscriminator(data, 'SkrPool');
  return { skrMint: r.pubkey(), vault: r.pubkey(), budget: r.u64(), reserved: r.u64(), fundedTotal: r.u64(), paidTotal: r.u64(), maxRootBudget: r.u64(), paused: r.bool(), bump: r.u8() };
}

export interface CollectionMeta { idx: number; coreCollection: PublicKey; symbol: string; element: number; minted: bigint; mintedByRarity: bigint[]; bump: number }
export function decodeCollectionMeta(data: Uint8Array): CollectionMeta {
  const r = expectDiscriminator(data, 'CollectionMeta');
  const idx = r.u8(), coreCollection = r.pubkey();
  const len = r.u32(); const symbol = new TextDecoder().decode(r.bytes(len));
  return { idx, coreCollection, symbol, element: r.u8(), minted: r.u64(), mintedByRarity: r.array(RARITY_COUNT, () => r.u64()), bump: r.u8() };
}

export interface BubblegumTreeMeta { collectionIdx: number; coreCollection: PublicKey; merkleTree: PublicKey; treeConfig: PublicKey; treeAuthority: PublicKey; maxDepth: number; canopy: number; active: boolean; bump: number }
export function decodeBubblegumTreeMeta(data: Uint8Array): BubblegumTreeMeta {
  const r = expectDiscriminator(data, 'BubblegumTreeMeta');
  return { collectionIdx: r.u8(), coreCollection: r.pubkey(), merkleTree: r.pubkey(), treeConfig: r.pubkey(), treeAuthority: r.pubkey(), maxDepth: r.u8(), canopy: r.u8(), active: r.bool(), bump: r.u8() };
}

export interface ChipState { asset: PublicKey; collectionIdx: number; rarity: number; level: number; index: bigint; flags: number; lockUntil: bigint; mintedAt: bigint; bump: number }
export function decodeChipState(data: Uint8Array): ChipState {
  const r = expectDiscriminator(data, 'ChipState');
  return { asset: r.pubkey(), collectionIdx: r.u8(), rarity: r.u8(), level: r.u8(), index: r.u64(), flags: r.u8(), lockUntil: r.i64(), mintedAt: r.i64(), bump: r.u8() };
}

export interface CompressedChipState {
  asset: PublicKey; claim: PublicKey; collectionIdx: number; merkleTree: PublicKey; leafIndex: number; leafNonce: bigint;
  dataHash: Uint8Array; creatorHash: Uint8Array; collectionHash: Uint8Array; assetDataHash: Uint8Array; leafFlags: number;
  rarity: number; level: number; index: bigint; flags: number; lockUntil: bigint; mintedAt: bigint; bump: number;
}
export function decodeCompressedChipState(data: Uint8Array): CompressedChipState {
  const r = expectDiscriminator(data, 'CompressedChipState');
  return {
    asset: r.pubkey(), claim: r.pubkey(), collectionIdx: r.u8(), merkleTree: r.pubkey(), leafIndex: r.u32(), leafNonce: r.u64(),
    dataHash: r.bytes(32), creatorHash: r.bytes(32), collectionHash: r.bytes(32), assetDataHash: r.bytes(32), leafFlags: r.u8(),
    rarity: r.u8(), level: r.u8(), index: r.u64(), flags: r.u8(), lockUntil: r.i64(), mintedAt: r.i64(), bump: r.u8(),
  };
}
export interface CompressedMintClaim { buyer: PublicKey; collectionIdx: number; rarity: number; level: number; gameIndex: bigint; expiresAt: bigint; settlement: PublicKey; indexReserved: boolean; minted: boolean; registered: boolean; consumed: boolean; listed: boolean; bump: number; staked: boolean; origin: PublicKey; lockUntil: bigint }
export function decodeCompressedMintClaim(data: Uint8Array): CompressedMintClaim {
  const r = expectDiscriminator(data, 'CompressedMintClaim');
  return { buyer: r.pubkey(), collectionIdx: r.u8(), rarity: r.u8(), level: r.u8(), gameIndex: r.u64(), expiresAt: r.i64(), settlement: r.pubkey(), indexReserved: r.bool(), minted: r.bool(), registered: r.bool(), consumed: r.bool(), listed: r.bool(), bump: r.u8(), staked: r.bool(), origin: r.pubkey(), lockUntil: r.i64() };
}

export interface CompressedAssetListing { asset: PublicKey; claim: PublicKey; seller: PublicKey; merkleTree: PublicKey; treeConfig: PublicKey; coreCollection: PublicKey; collectionIdx: number; price: bigint; currency: number; createdAt: bigint; bump: number }
export function decodeCompressedAssetListing(data: Uint8Array): CompressedAssetListing {
  const r = expectDiscriminator(data, 'CompressedAssetListing');
  return { asset: r.pubkey(), claim: r.pubkey(), seller: r.pubkey(), merkleTree: r.pubkey(), treeConfig: r.pubkey(), coreCollection: r.pubkey(), collectionIdx: r.u8(), price: r.u64(), currency: r.u8(), createdAt: r.i64(), bump: r.u8() };
}

export interface CompressedPackSettlement { buyer: PublicKey; pending: PublicKey; nonce: bigint; totalClaims: number; registeredClaims: number; cancelledClaims: number; bump: number }
export function decodeCompressedPackSettlement(data: Uint8Array): CompressedPackSettlement {
  const r = expectDiscriminator(data, 'CompressedPackSettlement');
  return { buyer: r.pubkey(), pending: r.pubkey(), nonce: r.u64(), totalClaims: r.u16(), registeredClaims: r.u16(), cancelledClaims: r.u16(), bump: r.u8() };
}

export interface PlayerPity { owner: PublicKey; counters: number[]; dayStart: bigint; boughtToday: number[]; starterClaimed: boolean; bump: number }
export function decodePlayerPity(data: Uint8Array): PlayerPity {
  const r = expectDiscriminator(data, 'PlayerPity');
  return { owner: r.pubkey(), counters: r.array(4, () => r.u16()), dayStart: r.i64(), boughtToday: r.array(4, () => r.u8()), starterClaimed: r.bool(), bump: r.u8() };
}

export interface PendingPack {
  buyer: PublicKey; sku: number; qty: number; opened: number; randomness: PublicKey; commitSlot: bigint;
  paidLamports: bigint; paidUsdc: bigint; paidCg: bigint; paidSkr: bigint; pitySnapshot: number; nonce: bigint; bump: number;
  /** set by the first open_pack (SEC-C2): packs 2…N reuse `value`, the oracle account is never re-read */
  revealed: boolean; value: Uint8Array;
  /** (#28) quest chip voucher: 1 chip rolled with `voucherOdds`, frozen `soulboundDays`; `sku` (0) only indexes pity arrays */
  voucher: boolean; voucherOdds: number[]; soulboundDays: number;
}
/** 8 + 32+1+1+1+32+8 + 8×4 + 2+8+1 + 1+32 (159) + #28 appendix 1 + 18 + 1 */
export const PENDING_PACK_SIZE = 179;
export function decodePendingPack(data: Uint8Array): PendingPack {
  const r = expectDiscriminator(data, 'PendingPack');
  const head = {
    buyer: r.pubkey(), sku: r.u8(), qty: r.u8(), opened: r.u8(), randomness: r.pubkey(), commitSlot: r.u64(),
    paidLamports: r.u64(), paidUsdc: r.u64(), paidCg: r.u64(), paidSkr: r.u64(), pitySnapshot: r.u16(), nonce: r.u64(), bump: r.u8(),
    revealed: r.bool(), value: r.bytes(32),
  };
  // pre-#28 accounts (159 bytes) decode as purchases
  const voucher = r.remaining >= 20 ? r.bool() : false;
  const voucherOdds = r.remaining >= 19 ? r.array(RARITY_COUNT, () => r.u16()) : Array<number>(RARITY_COUNT).fill(0);
  const soulboundDays = r.remaining >= 1 ? r.u8() : 0;
  return { ...head, voucher, voucherOdds, soulboundDays };
}

export interface PendingFusion { owner: PublicKey; recipe: number; materials: PublicKey[]; resultCollectionIdx: number; boosted: boolean; randomness: PublicKey; commitSlot: bigint; nonce: bigint; bump: number; feeEscrowed: bigint }
export function decodePendingFusion(data: Uint8Array): PendingFusion {
  const r = expectDiscriminator(data, 'PendingFusion');
  return {
    owner: r.pubkey(), recipe: r.u8(), materials: r.array(MATERIALS_PER_FUSION, () => r.pubkey()), resultCollectionIdx: r.u8(), boosted: r.bool(),
    randomness: r.pubkey(), commitSlot: r.u64(), nonce: r.u64(), bump: r.u8(), feeEscrowed: r.u64(), // SEC-M3
  };
}

/** Randomized claim fusion (`["claim_fusion", owner, nonce]`, H3) — same layout as PendingFusion, claim PDAs as materials. */
export interface PendingClaimFusion { owner: PublicKey; recipe: number; materials: PublicKey[]; resultCollectionIdx: number; boosted: boolean; randomness: PublicKey; commitSlot: bigint; nonce: bigint; bump: number; feeEscrowed: bigint }
export function decodePendingClaimFusion(data: Uint8Array): PendingClaimFusion {
  const r = expectDiscriminator(data, 'PendingClaimFusion');
  return {
    owner: r.pubkey(), recipe: r.u8(), materials: r.array(MATERIALS_PER_FUSION, () => r.pubkey()), resultCollectionIdx: r.u8(), boosted: r.bool(),
    randomness: r.pubkey(), commitSlot: r.u64(), nonce: r.u64(), bump: r.u8(), feeEscrowed: r.u64(), // SEC-M3
  };
}

export const BATTLE_STATUS = { OPEN: 0, ACCEPTED: 1, RESOLVED: 2, CANCELLED: 3 } as const;
export interface WagerBattle {
  challenger: PublicKey; opponent: PublicKey; wager: bigint; squadA: PublicKey[]; squadB: PublicKey[]; powerA: number; powerB: number;
  randomness: PublicKey; commitSlot: bigint; status: number; createdAt: bigint; acceptedAt: bigint; winner: PublicKey; resultHash: Uint8Array; nonce: bigint; bump: number;
}
export function decodeWagerBattle(data: Uint8Array): WagerBattle {
  const r = expectDiscriminator(data, 'WagerBattle');
  return {
    challenger: r.pubkey(), opponent: r.pubkey(), wager: r.u64(), squadA: r.array(SQUAD, () => r.pubkey()), squadB: r.array(SQUAD, () => r.pubkey()),
    powerA: r.u32(), powerB: r.u32(), randomness: r.pubkey(), commitSlot: r.u64(), status: r.u8(), createdAt: r.i64(), acceptedAt: r.i64(),
    winner: r.pubkey(), resultHash: r.bytes(32), nonce: r.u64(), bump: r.u8(),
  };
}

// ---------------------------------------------------------------- Switchboard accounts (raw layouts, no SDK)
/**
 * `RandomnessAccountData` (sb_on_demand IDL, bytemuck, 480 bytes): authority @8, queue @40,
 * seed_slothash @72, seed_slot @104, oracle @112, reveal_slot @144, value @152, lut_slot @184.
 */
export const RANDOMNESS_ACCOUNT_SIZE = 480;
export interface RandomnessData {
  authority: PublicKey; queue: PublicKey; seedSlothash: Uint8Array; seedSlot: bigint; oracle: PublicKey; revealSlot: bigint; value: Uint8Array; lutSlot: bigint;
}
export function decodeRandomness(data: Uint8Array): RandomnessData {
  const r = expectDiscriminator(data, 'RandomnessAccountData');
  if (data.length < RANDOMNESS_ACCOUNT_SIZE) throw new Error(`RandomnessAccountData: ${data.length} bytes`);
  return { authority: r.pubkey(), queue: r.pubkey(), seedSlothash: r.bytes(32), seedSlot: r.u64(), oracle: r.pubkey(), revealSlot: r.u64(), value: r.bytes(32), lutSlot: r.u64() };
}

/** `OracleAccountData` (4816 bytes): gateway_uri[64] @3584 (NUL-padded), authority @3440, queue @3472. */
export const ORACLE_GATEWAY_URI_OFFSET = 3584;
export const ORACLE_ACCOUNT_SIZE = 4816;
export function decodeOracleGateway(data: Uint8Array): string {
  if (!hasDiscriminator(data, 'OracleAccountData')) throw new Error('Account discriminator mismatch: expected OracleAccountData');
  if (data.length < ORACLE_GATEWAY_URI_OFFSET + 64) throw new Error(`OracleAccountData: ${data.length} bytes`);
  const raw = data.subarray(ORACLE_GATEWAY_URI_OFFSET, ORACLE_GATEWAY_URI_OFFSET + 64);
  let end = raw.indexOf(0); if (end < 0) end = raw.length;
  return new TextDecoder().decode(raw.subarray(0, end)).trim();
}

// ---------------------------------------------------------------- economy mirrors
/** Sub-seed for pack `packNo` of a bundle (packs.rs `open_pack`: keccak(value ‖ pack_no) when qty > 1). */
export function packSeed(value: Uint8Array, qty: number, packNo: number): Uint8Array {
  if (qty === 1) return value;
  const buf = new Uint8Array(33); buf.set(value, 0); buf[32] = packNo;
  return keccak_256(buf);
}

// ---------------------------------------------------------------- instructions
export interface CompressedLeafProof {
  root: Uint8Array; dataHash: Uint8Array; creatorHash: Uint8Array; collectionHash: Uint8Array; assetDataHash: Uint8Array;
  flags: number; nonce: bigint; index: number; proofNodes: PublicKey[];
}
export interface CreateBubblegumTreeArgs {
  admin: PublicKey; collectionIdx: number; merkleTree: PublicKey; treeConfig: PublicKey; maxDepth: number; canopy: number; maxBufferSize: number;
}
export function createBubblegumTreeIx(a: CreateBubblegumTreeArgs): TransactionInstruction {
  const data = new BorshWriter().u8(a.collectionIdx).u8(a.maxDepth).u8(a.canopy).u32(a.maxBufferSize).toBytes();
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [
      signer(a.admin), ro(configPda()[0]), ro(collectionMetaPda(a.collectionIdx)[0]), rw(bubblegumTreeMetaPda(a.collectionIdx)[0]), rw(a.merkleTree), rw(a.treeConfig),
      ro(MPL_BUBBLEGUM_V2_ID), ro(MPL_NOOP_ID), ro(MPL_ACCOUNT_COMPRESSION_ID), ro(SYSTEM_PROGRAM_ID),
    ],
    data: ixData('create_bubblegum_tree', data),
  });
}
export const COMPRESSED_CLAIM_PACK_STRIDE = 128n;
export const compressedClaimNonce = (purchaseNonce: bigint, packNo: number, chipNo: number) => {
  if (!Number.isInteger(packNo) || packNo < 0 || !Number.isInteger(chipNo) || chipNo < 0 || chipNo >= 5) throw new Error('Invalid compressed claim coordinates');
  return purchaseNonce * COMPRESSED_CLAIM_PACK_STRIDE + BigInt(packNo * 5 + chipNo);
};
export interface OpenCompressedPackArgs {
  payer: PublicKey; buyer: PublicKey; nonce: bigint; packNo: number; chips: number; collectionIdx: number[]; randomness: PublicKey;
}
export function openCompressedPackIx(a: OpenCompressedPackArgs): TransactionInstruction {
  if (!Number.isInteger(a.chips) || a.chips < 1 || a.chips > 5 || a.collectionIdx.length !== a.chips) throw new Error('Invalid compressed pack chip count');
  const [pending] = pendingPackPda(a.buyer, a.nonce);
  const [settlement] = compressedSettlementPda(a.buyer, a.nonce);
  const keys = [
    signer(a.payer), ro(configPda()[0]), rw(pending), ro(a.randomness), rw(pityPda(a.buyer)[0]), rw(settlement), ro(a.buyer), ro(SYSTEM_PROGRAM_ID),
  ];
  for (let i = 0; i < a.chips; i++) {
    keys.push(rw(compressedMintClaimPda(a.buyer, compressedClaimNonce(a.nonce, a.packNo, i))[0]));
    keys.push(rw(collectionMetaPda(a.collectionIdx[i])[0]));
    keys.push(ro(bubblegumTreeMetaPda(a.collectionIdx[i])[0]));
  }
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys,
    data: ixData('open_compressed_pack', new BorshWriter().u64(a.nonce).u8(a.packNo).toBytes()),
  });
}
export interface StageCompressedChipArgs {
  admin: PublicKey; buyer: PublicKey; collectionIdx: number; claimNonce: bigint; rarity: number; level: number; gameIndex: bigint; expiresAt: bigint;
}
export function stageCompressedChipIx(a: StageCompressedChipArgs): TransactionInstruction {
  const data = new BorshWriter().pubkey(a.buyer).u8(a.collectionIdx).u64(a.claimNonce).u8(a.rarity).u8(a.level).u64(a.gameIndex).i64(a.expiresAt).toBytes();
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [signer(a.admin), ro(configPda()[0]), ro(collectionMetaPda(a.collectionIdx)[0]), ro(bubblegumTreeMetaPda(a.collectionIdx)[0]), rw(compressedMintClaimPda(a.buyer, a.claimNonce)[0]), ro(a.buyer), ro(SYSTEM_PROGRAM_ID)],
    data: ixData('stage_compressed_chip', data),
  });
}
export interface MintCompressedChipArgs {
  payer: PublicKey; buyer: PublicKey; claimNonce: bigint; collectionIdx: number; treeConfig: PublicKey; merkleTree: PublicKey; coreCollection: PublicKey;
}
export function mintCompressedChipIx(a: MintCompressedChipArgs): TransactionInstruction {
  const data = new BorshWriter().pubkey(a.buyer).u8(a.collectionIdx).u64(a.claimNonce).toBytes();
  const [collection] = collectionMetaPda(a.collectionIdx);
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [
      signer(a.payer), ro(configPda()[0]), ro(collection), ro(bubblegumTreeMetaPda(a.collectionIdx)[0]), rw(compressedMintClaimPda(a.buyer, a.claimNonce)[0]), ro(a.buyer),
      rw(a.treeConfig), rw(a.merkleTree), ro(collection), rw(a.coreCollection), ro(find([enc('collection_cpi')], MPL_BUBBLEGUM_V2_ID)[0]),
      ro(MPL_BUBBLEGUM_V2_ID), ro(MPL_NOOP_ID), ro(MPL_ACCOUNT_COMPRESSION_ID), ro(MPL_CORE_ID), ro(SYSTEM_PROGRAM_ID),
    ],
    data: ixData('mint_compressed_chip', data),
  });
}
export interface RegisterCompressedChipArgs {
  payer: PublicKey; buyer: PublicKey; claimNonce: bigint; asset: PublicKey; merkleTree: PublicKey; treeConfig: PublicKey; collectionIdx: number;
  owner: PublicKey; delegate: PublicKey; proof: CompressedLeafProof; rarity: number; level: number; gameIndex: bigint; settlement?: PublicKey;
}
export function registerCompressedChipIx(a: RegisterCompressedChipArgs): TransactionInstruction {
  const hashes = [a.proof.root, a.proof.dataHash, a.proof.creatorHash, a.proof.collectionHash, a.proof.assetDataHash];
  if (hashes.some((h) => h.length !== 32)) throw new Error('Bubblegum V2 hashes and root must be exactly 32 bytes');
  if (!Number.isInteger(a.proof.index) || a.proof.index < 0 || a.proof.index > 0xffff_ffff) throw new Error('Invalid Bubblegum leaf index');
  if (!Number.isInteger(a.proof.flags) || a.proof.flags < 0 || a.proof.flags > 255) throw new Error('Invalid Bubblegum flags');
  if (a.proof.nonce < 0n || a.gameIndex < 0n || a.claimNonce < 0n || a.proof.proofNodes.length > 30) throw new Error('Invalid Bubblegum proof coordinates');
  const [chip] = compressedChipStatePda(a.asset);
  const data = new BorshWriter()
    .pubkey(a.asset).u8(a.collectionIdx).pubkey(a.owner).pubkey(a.delegate).pubkey(a.buyer).u64(a.claimNonce)
    .bytes(a.proof.root).bytes(a.proof.dataHash).bytes(a.proof.creatorHash).bytes(a.proof.collectionHash).bytes(a.proof.assetDataHash)
    .u8(a.proof.flags).u64(a.proof.nonce).u32(a.proof.index).u8(a.rarity).u8(a.level).u64(a.gameIndex).toBytes();
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [
      signer(a.payer), ro(configPda()[0]), rw(collectionMetaPda(a.collectionIdx)[0]), ro(bubblegumTreeMetaPda(a.collectionIdx)[0]),
      rw(compressedMintClaimPda(a.buyer, a.claimNonce)[0]), a.settlement ? rw(a.settlement) : ro(SYSTEM_PROGRAM_ID), ro(a.buyer), rw(chip), ro(a.asset), ro(a.owner), ro(a.delegate), ro(a.merkleTree), ro(a.treeConfig), ro(MPL_BUBBLEGUM_V2_ID), ro(MPL_ACCOUNT_COMPRESSION_ID), ro(SYSTEM_PROGRAM_ID),
      ...a.proof.proofNodes.map(ro),
    ],
    data: ixData('register_compressed_chip', data),
  });
}

export interface CancelCompressedClaimArgs { buyer: PublicKey; claimNonce: bigint; nonce: bigint }
export function cancelCompressedClaimIx(a: CancelCompressedClaimArgs): TransactionInstruction {
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [signer(a.buyer), rw(compressedSettlementPda(a.buyer, a.nonce)[0]), ro(pendingPackPda(a.buyer, a.nonce)[0]), rw(compressedMintClaimPda(a.buyer, a.claimNonce)[0]), ro(SYSTEM_PROGRAM_ID)],
    data: ixData('cancel_compressed_claim', new BorshWriter().u64(a.claimNonce).u64(a.nonce).toBytes()),
  });
}
export interface FinalizeCompressedPackArgs { payer: PublicKey; buyer: PublicKey; nonce: bigint; cg?: { cgMint: PublicKey; vaultCg: PublicKey; treasuryCg: PublicKey }; refundToken?: { vault: PublicKey; buyer: PublicKey } }
export function finalizeCompressedPackIx(a: FinalizeCompressedPackArgs): TransactionInstruction {
  const [settlement] = compressedSettlementPda(a.buyer, a.nonce);
  const [pending] = pendingPackPda(a.buyer, a.nonce);
  const [ledger] = ledgerPdaOf(a.buyer);
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [
      signer(a.payer), ro(configPda()[0]), rw(settlement), rw(pending), rw(a.buyer), rw(ledger), rw(vaultPda()[0]),
      optional(a.cg?.cgMint, CHIP_CORE_ID), optional(a.cg?.vaultCg, CHIP_CORE_ID), optional(a.cg?.treasuryCg, CHIP_CORE_ID), optional(a.refundToken?.vault, CHIP_CORE_ID), optional(a.refundToken?.buyer, CHIP_CORE_ID), ro(TOKEN_PROGRAM_ID), ro(SYSTEM_PROGRAM_ID),
    ],
    data: ixData('finalize_compressed_pack', new BorshWriter().u64(a.nonce).toBytes()),
  });
}

export interface RevealArgs {
  kind: RngKind; payer: PublicKey; randomness: PublicKey; oracle: PublicKey; queue: PublicKey;
  /** oracle gateway response */
  signature: Uint8Array; recoveryId: number; value: Uint8Array;
}
/** `reveal_randomness(signature[64], recovery_id, value[32])` (chip_core) / `reveal_battle_randomness` (arena) — permissionless relay. */
export function revealRandomnessIx(a: RevealArgs): TransactionInstruction {
  if (a.signature.length !== 64) throw new Error('oracle signature must be 64 bytes');
  if (a.value.length !== 32) throw new Error('revealed value must be 32 bytes');
  const keys = [
    signer(a.payer), rw(a.randomness), ro(rngAuthPda(a.kind)[0]), ro(a.oracle), ro(a.queue), rw(sbOracleStatsPda(a.oracle)[0]), rw(sbRewardEscrow(a.randomness)),
    ro(sbStatePda()[0]), ro(SYSVAR_SLOT_HASHES_ID), ro(SWITCHBOARD_PROGRAM_ID), ro(WSOL_MINT), ro(TOKEN_PROGRAM_ID), ro(SYSTEM_PROGRAM_ID),
  ];
  const name = a.kind === RNG_KIND.BATTLE ? 'reveal_battle_randomness' : 'reveal_randomness';
  return new TransactionInstruction({ programId: rngProgram(a.kind), keys, data: ixData(name, new BorshWriter().bytes(a.signature).u8(a.recoveryId).bytes(a.value).toBytes()) });
}

/** `close_randomness(kind, nonce)` / `close_battle_randomness(nonce)` — permissionless once the pinned account is gone (battle settled). Rent → owner. */
export function closeRandomnessIx(a: { kind: RngKind; payer: PublicKey; owner: PublicKey; nonce: bigint; lutSlot: bigint }): TransactionInstruction {
  const randomness = rngPda(a.kind, a.owner, a.nonce)[0];
  const lutSigner = sbLutSignerPda(randomness)[0];
  const pinned = a.kind === RNG_KIND.PACK ? pendingPackPda(a.owner, a.nonce)[0] : a.kind === RNG_KIND.FUSION ? pendingFusionPda(a.owner, a.nonce)[0] : a.kind === RNG_KIND.CLAIM_FUSION ? claimFusionPda(a.owner, a.nonce)[0] : battlePda(a.owner, a.nonce)[0];
  const keys = [
    signer(a.payer), rw(a.owner), rw(randomness), rw(rngAuthPda(a.kind)[0]), ro(pinned), rw(sbRewardEscrow(randomness)), ro(sbStatePda()[0]),
    rw(sbLutPda(lutSigner, a.lutSlot)[0]), ro(lutSigner), ro(SWITCHBOARD_PROGRAM_ID), ro(WSOL_MINT), ro(ADDRESS_LOOKUP_TABLE_PROGRAM_ID), ro(TOKEN_PROGRAM_ID), ro(SYSTEM_PROGRAM_ID),
  ];
  const data = a.kind === RNG_KIND.BATTLE
    ? ixData('close_battle_randomness', new BorshWriter().u64(a.nonce).toBytes())
    : ixData('close_randomness', new BorshWriter().u8(a.kind).u64(a.nonce).toBytes());
  return new TransactionInstruction({ programId: rngProgram(a.kind), keys, data });
}

/**
 * `close_randomness_lut(kind, nonce, lut_slot)` (chip_core) / `close_battle_randomness_lut(nonce, lut_slot)`
 * (arena) — backlog #23. Permissionless and idempotent: callable once the randomness account is gone
 * (`close_randomness` deactivates the table as it closes the account, and the Address Lookup Table
 * cooldown starts there) and pays the table's rent (~0.0015 SOL per bundle) to `owner`.
 *
 * `lutSlot` is not trusted: the program re-derives `["LutSigner", randomness]` and the table address
 * from it and requires the passed accounts to match, so a caller cannot point the CPI at somebody
 * else's table. `owner` is both a randomness PDA seed and Switchboard's `recipient` — a relayer
 * therefore cannot redirect the rent to itself (SEC-F07).
 */
export function closeRandomnessLutIx(a: { kind: RngKind; payer: PublicKey; owner: PublicKey; nonce: bigint; lutSlot: bigint }): TransactionInstruction {
  const randomness = rngPda(a.kind, a.owner, a.nonce)[0];
  const lutSigner = sbLutSignerPda(randomness)[0];
  const pinned = a.kind === RNG_KIND.PACK ? pendingPackPda(a.owner, a.nonce)[0] : a.kind === RNG_KIND.FUSION ? pendingFusionPda(a.owner, a.nonce)[0] : a.kind === RNG_KIND.CLAIM_FUSION ? claimFusionPda(a.owner, a.nonce)[0] : battlePda(a.owner, a.nonce)[0];
  const keys = [
    signer(a.payer), rw(a.owner), ro(randomness), ro(pinned), ro(lutSigner), rw(sbLutPda(lutSigner, a.lutSlot)[0]),
    ro(SWITCHBOARD_PROGRAM_ID), ro(ADDRESS_LOOKUP_TABLE_PROGRAM_ID),
  ];
  const data = a.kind === RNG_KIND.BATTLE
    ? ixData('close_battle_randomness_lut', new BorshWriter().u64(a.nonce).u64(a.lutSlot).toBytes())
    : ixData('close_randomness_lut', new BorshWriter().u8(a.kind).u64(a.nonce).u64(a.lutSlot).toBytes());
  return new TransactionInstruction({ programId: rngProgram(a.kind), keys, data });
}

export interface OpenPackArgs {
  payer: PublicKey; buyer: PublicKey; nonce: bigint; packNo: number; randomness: PublicKey;
  /** packs in the purchase — the last one settles and needs the buyer's ledger shard writable (#12); default 1 */
  qty?: number;
  /** collection index rolled for each chip slot (crank pre-simulates `expand`) */
  rolledCollections: number[];
  coreCollectionOf: (idx: number) => PublicKey;
  /** present when the purchase was paid in $CG (final pack burns 75 % / 25 % → treasury) */
  cg?: { cgMint: PublicKey; treasury: PublicKey };
}
/**
 * `open_pack(nonce, pack_no)` — LEGACY, fail-closed on chain (`params_version == 0` is
 * unreachable). Builds the historical MPL-Core settlement for reference/tests only; the live
 * path is `open_compressed_pack` → `mint_compressed_chip` → `register_compressed_chip` →
 * `finalize_compressed_pack`.
 * @deprecated Use {@link openCompressedPackIx} and the V2 settlement pipeline instead.
 */
export function openPackIx(a: OpenPackArgs): TransactionInstruction {
  const [pending] = pendingPackPda(a.buyer, a.nonce);
  const [vault] = vaultPda();
  const settles = a.packNo === (a.qty ?? 1) - 1;
  const ledger = ledgerPdaOf(a.buyer)[0];
  const keys = [
    // #12: config read-only; the ledger shard is writable only on the settling pack; the vault only signs
    signer(a.payer), ro(configPda()[0]), settles ? rw(ledger) : ro(ledger), rw(pending), ro(a.randomness), rw(pityPda(a.buyer)[0]), rw(a.buyer), ro(vault),
    optional(a.cg?.cgMint, CHIP_CORE_ID), optional(a.cg ? ata(a.cg.cgMint, vault) : undefined, CHIP_CORE_ID), optional(a.cg ? ata(a.cg.cgMint, a.cg.treasury) : undefined, CHIP_CORE_ID),
    ro(MPL_CORE_ID), ro(TOKEN_PROGRAM_ID), ro(SYSTEM_PROGRAM_ID),
  ];
  a.rolledCollections.forEach((col, i) => {
    const [asset] = assetPda(pending, a.packNo, i);
    keys.push(rw(asset), rw(chipStatePda(asset)[0]), rw(collectionMetaPda(col)[0]), rw(a.coreCollectionOf(col)));
  });
  return new TransactionInstruction({ programId: CHIP_CORE_ID, keys, data: ixData('open_pack', new BorshWriter().u64(a.nonce).u8(a.packNo).toBytes()) });
}

export interface FuseRevealArgs {
  payer: PublicKey; owner: PublicKey; nonce: bigint; randomness: PublicKey; resultCollectionIdx: number;
  materials: { asset: PublicKey; collectionIdx: number }[];
  coreCollectionOf: (idx: number) => PublicKey;
  /** $CG mint (GameConfig.cg_mint) — the escrowed fee is burned from the vault ATA (SEC-M3) */
  cgMint: PublicKey;
}
/** `fuse_reveal(nonce)` — permissionless; PendingFusion rent → payer. */
export function fuseRevealIx(a: FuseRevealArgs): TransactionInstruction {
  const [pending] = pendingFusionPda(a.owner, a.nonce);
  const [resultAsset] = assetPda(pending, 0, 0);
  const [vault] = vaultPda();
  const keys = [
    signer(a.payer), ro(configPda()[0]), rw(ledgerPdaOf(a.owner)[0]) /* #12 */, rw(pending), ro(a.randomness), rw(a.owner), rw(collectionMetaPda(a.resultCollectionIdx)[0]), rw(a.coreCollectionOf(a.resultCollectionIdx)),
    rw(resultAsset), rw(chipStatePda(resultAsset)[0]), ro(MPL_CORE_ID), ro(SYSTEM_PROGRAM_ID),
    rw(vault), rw(a.cgMint), rw(ata(a.cgMint, vault)), ro(TOKEN_PROGRAM_ID),
  ];
  for (const m of a.materials) keys.push(rw(m.asset), rw(chipStatePda(m.asset)[0]), rw(collectionMetaPda(m.collectionIdx)[0]), rw(a.coreCollectionOf(m.collectionIdx)));
  return new TransactionInstruction({ programId: CHIP_CORE_ID, keys, data: ixData('fuse_reveal', new BorshWriter().u64(a.nonce).toBytes()) });
}

export interface FuseClaimsCommitArgs {
  owner: PublicKey; nonce: bigint; resultCollectionIdx: number; useBooster: boolean;
  randomness: PublicKey; queue: PublicKey; oracle: PublicKey; cgMint: PublicKey; materials: PublicKey[];
}
/** `fuse_claims_commit(nonce, use_booster)` — randomized claim fusion (Epic+, H3); fee escrowed, materials consumed. */
export function fuseClaimsCommitIx(a: FuseClaimsCommitArgs): TransactionInstruction {
  if (a.materials.length !== MATERIALS_PER_FUSION) throw new Error('Claim fusion needs exactly 3 material claims');
  const [pending] = claimFusionPda(a.owner, a.nonce);
  const [vault] = vaultPda();
  const keys = [
    signer(a.owner), ro(configPda()[0]), rw(ledgerPdaOf(a.owner)[0]), rw(pending), rw(a.randomness), ro(rngAuthPda(RNG_KIND.CLAIM_FUSION)[0]),
    ro(SWITCHBOARD_PROGRAM_ID), ro(a.queue), rw(a.oracle), ro(SYSVAR_SLOT_HASHES_ID), rw(itemsPda(a.owner)[0]), rw(collectionMetaPda(a.resultCollectionIdx)[0]),
    rw(a.cgMint), rw(ata(a.cgMint, a.owner)), ro(vault), rw(ata(a.cgMint, vault)), ro(TOKEN_PROGRAM_ID), ro(SYSTEM_PROGRAM_ID),
    ...a.materials.map(rw),
  ];
  return new TransactionInstruction({ programId: CHIP_CORE_ID, keys, data: ixData('fuse_claims_commit', new BorshWriter().u64(a.nonce).bool(a.useBooster).toBytes()) });
}

export interface FuseClaimsRevealArgs {
  payer: PublicKey; owner: PublicKey; nonce: bigint; resultClaimNonce: bigint; resultCollectionIdx: number;
  randomness: PublicKey; cgMint: PublicKey; materials: PublicKey[];
}
/**
 * `fuse_claims_reveal(nonce, result_claim_nonce)` — permissionless; survivors refunded or the result claim is created.
 *
 * Protocol convention: `resultClaimNonce == nonce` (the commit nonce). The pending account stores
 * no result nonce, so any third party (crank, UI) must derive the same PDA purely from (owner,
 * nonce). A collision with a live pack claim PDA fails closed (`init` on an occupied address);
 * committer UIs must therefore keep fusion nonces out of the `purchase_nonce * 128 + …` stride space.
 */
export function fuseClaimsRevealIx(a: FuseClaimsRevealArgs): TransactionInstruction {
  if (a.materials.length !== MATERIALS_PER_FUSION) throw new Error('Claim fusion needs exactly 3 material claims');
  const [pending] = claimFusionPda(a.owner, a.nonce);
  const [vault] = vaultPda();
  const keys = [
    signer(a.payer), ro(configPda()[0]), rw(ledgerPdaOf(a.owner)[0]), rw(pending), ro(a.randomness), rw(a.owner),
    rw(collectionMetaPda(a.resultCollectionIdx)[0]), rw(compressedMintClaimPda(a.owner, a.resultClaimNonce)[0]),
    rw(vault), rw(a.cgMint), rw(ata(a.cgMint, vault)), ro(TOKEN_PROGRAM_ID), ro(SYSTEM_PROGRAM_ID),
    ...a.materials.map(rw),
  ];
  return new TransactionInstruction({ programId: CHIP_CORE_ID, keys, data: ixData('fuse_claims_reveal', new BorshWriter().u64(a.nonce).u64(a.resultClaimNonce).toBytes()) });
}

export interface CancelStaleClaimFusionArgs { owner: PublicKey; nonce: bigint; randomness: PublicKey; cgMint: PublicKey; materials: PublicKey[] }
/** `cancel_stale_claim_fusion(nonce)` — oracle outage only; fee refunded, materials un-consumed. */
export function cancelStaleClaimFusionIx(a: CancelStaleClaimFusionArgs): TransactionInstruction {
  if (a.materials.length !== MATERIALS_PER_FUSION) throw new Error('Claim fusion needs exactly 3 material claims');
  const [pending] = claimFusionPda(a.owner, a.nonce);
  const [vault] = vaultPda();
  const keys = [
    signer(a.owner), ro(configPda()[0]), rw(ledgerPdaOf(a.owner)[0]), rw(pending), ro(a.randomness),
    rw(vault), rw(ata(a.cgMint, vault)), rw(ata(a.cgMint, a.owner)), ro(TOKEN_PROGRAM_ID), ro(SYSTEM_PROGRAM_ID),
    ...a.materials.map(rw),
  ];
  return new TransactionInstruction({ programId: CHIP_CORE_ID, keys, data: ixData('cancel_stale_claim_fusion', new BorshWriter().u64(a.nonce).toBytes()) });
}

/** `close_expired_claim(claim_nonce)` — buyer reclaims the rent of an expired settlement-free claim shell. */
export function closeExpiredClaimIx(a: { buyer: PublicKey; claimNonce: bigint }): TransactionInstruction {
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [signer(a.buyer), rw(compressedMintClaimPda(a.buyer, a.claimNonce)[0]), ro(SYSTEM_PROGRAM_ID)],
    data: ixData('close_expired_claim', new BorshWriter().u64(a.claimNonce).toBytes()),
  });
}

/** SPL Associated Token `CreateIdempotent` (instruction 1). */
export function createAtaIdempotentIx(payer: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [signer(payer), rw(ata(mint, owner)), ro(owner), ro(mint), ro(SYSTEM_PROGRAM_ID), ro(TOKEN_PROGRAM_ID)],
    data: Buffer.from([1]),
  });
}

// ---------------------------------------------------------------- program errors the crank reacts to
/** chip_core error codes (programs/chip_core/src/errors.rs; Anchor custom errors start at 6000). */
export const CHIP_CORE_ERR = {
  InvalidQuantity: 6005, RandomnessExpired: 6014, RandomnessAlreadyRevealed: 6015, RandomnessNotResolved: 6016, RandomnessMismatch: 6017, NotStale: 6018,
  InvalidChipState: 6024, RandomnessAuthority: 6035, RandomnessUsed: 6036,
} as const;
/** Switchboard On-Demand errors we expect from the reveal CPI. */
export const SB_ERR = { InvalidAuthority: 6012, RandomnessTooOld: 6035, RandomnessNotRequested: 6038, InvalidSlotNumber: 6039, OracleKeyExpired: 6040 } as const;

/** Parse `custom program error: 0x…` (message or logs) → numeric code. */
export function customErrorCode(err: unknown): number | undefined {
  const msg = String((err as { message?: string })?.message ?? err ?? '');
  const m = /custom program error: (0x[0-9a-fA-F]+|\d+)/.exec(msg);
  if (m) return m[1].startsWith('0x') ? parseInt(m[1], 16) : Number(m[1]);
  const logs: string[] | undefined = (err as { logs?: string[] })?.logs;
  for (const l of logs ?? []) {
    const mm = /custom program error: (0x[0-9a-fA-F]+)/.exec(l);
    if (mm) return parseInt(mm[1], 16);
  }
  const j = /"Custom":(\d+)/.exec(msg);
  return j ? Number(j[1]) : undefined;
}
