// Decoders for on-chain account layouts (programs/*/src/state.rs).
// Field order == Rust field order; sizes are asserted in accounts.test.ts.
import { PublicKey } from '@solana/web3.js';
import { BorshReader } from './borsh';
import { expectDiscriminator } from './anchor';

export const RARITY_COUNT = 9;
export const MAX_CHIPS_PER_PACK = 5;
export const MATERIALS_PER_FUSION = 3;
export const SQUAD = 3;
export const SPLIT_COUNT = 5;

// ---------------------------------------------------------------- chip_core
export interface PackDef {
  chips: number;
  priceUsdCents: number;
  priceCgMicro: bigint;
  oddsBps: number[];
  floor: number;
  dailyCap: number;
  pityTier: number;
  pityHardAt: number;
  pitySoftStart: number;
  pitySoftStepBps: number;
  featuredOnly: boolean;
  enabled: boolean;
}

function readPackDef(r: BorshReader): PackDef {
  return {
    chips: r.u8(),
    priceUsdCents: r.u32(),
    priceCgMicro: r.u64(),
    oddsBps: r.array(RARITY_COUNT, () => r.u16()),
    floor: r.u8(),
    dailyCap: r.u8(),
    pityTier: r.u8(),
    pityHardAt: r.u16(),
    pitySoftStart: r.u16(),
    pitySoftStepBps: r.u16(),
    featuredOnly: r.bool(),
    enabled: r.bool(),
  };
}

export interface GameConfig {
  admin: PublicKey;
  pendingAdmin: PublicKey;
  treasury: PublicKey;
  buybackWallet: PublicKey;
  cgMint: PublicKey;
  usdcMint: PublicKey;
  skrMint: PublicKey;
  stakingProgram: PublicKey;
  pythSolUsdFeed: PublicKey;
  pythSkrUsdFeed: PublicKey;
  featuredCollection: number;
  paused: boolean;
  packs: PackDef[];
  marketFeeBps: number;
  skrDiscountBps: number;
  collectionsCreated: number;
  paramsVersion: number;
  vaultBump: number;
  bump: number;
  /** SEC-H2 hot pauser (`pause` only); `PublicKey.default` = none. */
  pauser: PublicKey;
}

/** `VaultLedger` (`["ledger", shard]`, #12): refund liabilities + $CG burn total of one shard. */
export interface VaultLedger {
  shard: number;
  liabLamports: bigint;
  liabUsdc: bigint;
  liabCg: bigint;
  liabSkr: bigint;
  burnedTotal: bigint;
  bump: number;
}

export function decodeVaultLedger(data: Uint8Array): VaultLedger {
  const r = expectDiscriminator(data, 'VaultLedger');
  return { shard: r.u8(), liabLamports: r.u64(), liabUsdc: r.u64(), liabCg: r.u64(), liabSkr: r.u64(), burnedTotal: r.u64(), bump: r.u8() };
}

/** Sum of all shards (missing shards count as zero — `init_ledger` not run yet). */
export function sumLedgers(shards: (VaultLedger | null | undefined)[]): Omit<VaultLedger, 'shard' | 'bump'> {
  const t = { liabLamports: 0n, liabUsdc: 0n, liabCg: 0n, liabSkr: 0n, burnedTotal: 0n };
  for (const l of shards) {
    if (!l) continue;
    t.liabLamports += l.liabLamports; t.liabUsdc += l.liabUsdc; t.liabCg += l.liabCg; t.liabSkr += l.liabSkr; t.burnedTotal += l.burnedTotal;
  }
  return t;
}

export function decodeGameConfig(data: Uint8Array): GameConfig {
  const r = expectDiscriminator(data, 'GameConfig');
  return {
    admin: r.pubkey(), pendingAdmin: r.pubkey(), treasury: r.pubkey(), buybackWallet: r.pubkey(),
    cgMint: r.pubkey(), usdcMint: r.pubkey(), skrMint: r.pubkey(), stakingProgram: r.pubkey(), pythSolUsdFeed: r.pubkey(), pythSkrUsdFeed: r.pubkey(),
    featuredCollection: r.u8(), paused: r.bool(),
    packs: r.array(4, () => readPackDef(r)),
    marketFeeBps: r.u16(), skrDiscountBps: r.u16(), collectionsCreated: r.u8(),
    paramsVersion: r.u32(), vaultBump: r.u8(), bump: r.u8(), pauser: r.pubkey(),
  };
}

export interface CollectionMeta {
  idx: number;
  coreCollection: PublicKey;
  symbol: string;
  element: number;
  minted: bigint;
  mintedByRarity: bigint[];
  bump: number;
}

export function decodeCollectionMeta(data: Uint8Array): CollectionMeta {
  const r = expectDiscriminator(data, 'CollectionMeta');
  return {
    idx: r.u8(), coreCollection: r.pubkey(), symbol: r.string(), element: r.u8(),
    minted: r.u64(), mintedByRarity: r.array(RARITY_COUNT, () => r.u64()), bump: r.u8(),
  };
}

/** `[\"bubblegum_tree\", collectionIdx]` — deployment binding for a V2 tree. */
export interface BubblegumTreeMeta {
  collectionIdx: number;
  coreCollection: PublicKey;
  merkleTree: PublicKey;
  treeConfig: PublicKey;
  treeAuthority: PublicKey;
  maxDepth: number;
  canopy: number;
  active: boolean;
  bump: number;
}

export function decodeBubblegumTreeMeta(data: Uint8Array): BubblegumTreeMeta {
  const r = expectDiscriminator(data, 'BubblegumTreeMeta');
  return {
    collectionIdx: r.u8(), coreCollection: r.pubkey(), merkleTree: r.pubkey(), treeConfig: r.pubkey(),
    treeAuthority: r.pubkey(), maxDepth: r.u8(), canopy: r.u8(), active: r.bool(), bump: r.u8(),
  };
}

export const CHIP_FLAG = { STAKED: 1, LISTED: 2, FUSING: 4, SOULBOUND: 8, FOUNDER: 16 } as const;

export interface ChipState {
  asset: PublicKey;
  collectionIdx: number;
  rarity: number;
  level: number;
  index: bigint;
  flags: number;
  lockUntil: bigint;
  mintedAt: bigint;
  bump: number;
}

export function decodeChipState(data: Uint8Array): ChipState {
  const r = expectDiscriminator(data, 'ChipState');
  return {
    asset: r.pubkey(), collectionIdx: r.u8(), rarity: r.u8(), level: r.u8(), index: r.u64(),
    flags: r.u8(), lockUntil: r.i64(), mintedAt: r.i64(), bump: r.u8(),
  };
}

export const chipIsFree = (c: ChipState, nowSec = Math.floor(Date.now() / 1000)) =>
  (c.flags & (CHIP_FLAG.STAKED | CHIP_FLAG.LISTED | CHIP_FLAG.FUSING)) === 0 && BigInt(nowSec) >= c.lockUntil;

/** Core-owned projection for a Bubblegum V2 leaf (`["compressed_chip", asset]`). */
export interface CompressedChipState {
  asset: PublicKey;
  claim: PublicKey;
  collectionIdx: number;
  merkleTree: PublicKey;
  leafIndex: number;
  leafNonce: bigint;
  dataHash: Uint8Array;
  creatorHash: Uint8Array;
  collectionHash: Uint8Array;
  assetDataHash: Uint8Array;
  leafFlags: number;
  rarity: number;
  level: number;
  index: bigint;
  flags: number;
  lockUntil: bigint;
  mintedAt: bigint;
  bump: number;
}

export function decodeCompressedChipState(data: Uint8Array): CompressedChipState {
  const r = expectDiscriminator(data, 'CompressedChipState');
  return {
    asset: r.pubkey(), claim: r.pubkey(), collectionIdx: r.u8(), merkleTree: r.pubkey(), leafIndex: r.u32(), leafNonce: r.u64(),
    dataHash: r.bytes(32), creatorHash: r.bytes(32), collectionHash: r.bytes(32), assetDataHash: r.bytes(32),
    leafFlags: r.u8(), rarity: r.u8(), level: r.u8(), index: r.u64(), flags: r.u8(), lockUntil: r.i64(), mintedAt: r.i64(), bump: r.u8(),
  };
}

export interface CompressedMintClaim {
  buyer: PublicKey;
  collectionIdx: number;
  rarity: number;
  level: number;
  gameIndex: bigint;
  expiresAt: bigint;
  settlement: PublicKey;
  indexReserved: boolean;
  minted: boolean;
  registered: boolean;
  consumed: boolean;
  listed: boolean;
  bump: number;
  staked: boolean;
  origin: PublicKey;
  /** H1: unix timestamp until which the claim's chip cannot be listed (Starter packs: +7 days; 0 = tradeable at once). */
  lockUntil: bigint;
  /** pre-sale origin: the registered chip gets the founder frame (docs/preorder-beta.md). */
  founder: boolean;
}

export function decodeCompressedMintClaim(data: Uint8Array): CompressedMintClaim {
  const r = expectDiscriminator(data, 'CompressedMintClaim');
  return {
    buyer: r.pubkey(), collectionIdx: r.u8(), rarity: r.u8(), level: r.u8(), gameIndex: r.u64(), expiresAt: r.i64(),
    settlement: r.pubkey(), indexReserved: r.bool(), minted: r.bool(), registered: r.bool(), consumed: r.bool(), listed: r.bool(), bump: r.u8(), staked: r.bool(), origin: r.pubkey(), lockUntil: r.i64(),
    founder: r.remaining >= 1 ? r.bool() : false,
  };
}

/** A claim is listable only when it is free AND its soulbound window has passed (H1). */
export const claimIsListable = (c: CompressedMintClaim, nowSec = Math.floor(Date.now() / 1000)) =>
  c.registered && !c.consumed && !c.listed && !c.staked && BigInt(nowSec) >= c.lockUntil;

export interface CompressedAssetListing {
  asset: PublicKey; claim: PublicKey; seller: PublicKey; merkleTree: PublicKey; treeConfig: PublicKey; coreCollection: PublicKey;
  collectionIdx: number; price: bigint; currency: number; createdAt: bigint; bump: number;
}
export function decodeCompressedAssetListing(data: Uint8Array): CompressedAssetListing {
  const r = expectDiscriminator(data, 'CompressedAssetListing');
  return {
    asset: r.pubkey(), claim: r.pubkey(), seller: r.pubkey(), merkleTree: r.pubkey(), treeConfig: r.pubkey(), coreCollection: r.pubkey(),
    collectionIdx: r.u8(), price: r.u64(), currency: r.u8(), createdAt: r.i64(), bump: r.u8(),
  };
}

export interface CompressedPackSettlement {
  buyer: PublicKey; pending: PublicKey; nonce: bigint; totalClaims: number; registeredClaims: number; cancelledClaims: number; bump: number;
}
export function decodeCompressedPackSettlement(data: Uint8Array): CompressedPackSettlement {
  const r = expectDiscriminator(data, 'CompressedPackSettlement');
  return { buyer: r.pubkey(), pending: r.pubkey(), nonce: r.u64(), totalClaims: r.u16(), registeredClaims: r.u16(), cancelledClaims: r.u16(), bump: r.u8() };
}

export interface PlayerPity {
  owner: PublicKey;
  counters: number[];
  dayStart: bigint;
  boughtToday: number[];
  starterClaimed: boolean;
  bump: number;
}

export function decodePlayerPity(data: Uint8Array): PlayerPity {
  const r = expectDiscriminator(data, 'PlayerPity');
  return {
    owner: r.pubkey(), counters: r.array(4, () => r.u16()), dayStart: r.i64(),
    boughtToday: r.array(4, () => r.u8()), starterClaimed: r.bool(), bump: r.u8(),
  };
}

export interface PendingPack {
  buyer: PublicKey;
  sku: number;
  qty: number;
  opened: number;
  randomness: PublicKey;
  commitSlot: bigint;
  paidLamports: bigint;
  paidUsdc: bigint;
  paidCg: bigint;
  paidSkr: bigint;
  pitySnapshot: number;
  nonce: bigint;
  bump: number;
  /** set by the first open_pack of the purchase (SEC-C2): packs 2…N reuse `value`, never the oracle account */
  revealed: boolean;
  value: Uint8Array;
  /** (#28) quest chip voucher (issued by staking `claim_chip_root`): ONE chip rolled with `voucherOdds`, soulbound `soulboundDays` */
  voucher: boolean;
  voucherOdds: number[];
  soulboundDays: number;
  /** pre-sale origin (docs/preorder-beta.md): chips minted from this pack carry the founder frame */
  preorder: boolean;
}

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
  const preorder = r.remaining >= 1 ? r.bool() : false;
  return { ...head, voucher, voucherOdds, soulboundDays, preorder };
}

export interface PendingFusion {
  owner: PublicKey;
  recipe: number;
  materials: PublicKey[];
  resultCollectionIdx: number;
  boosted: boolean;
  randomness: PublicKey;
  commitSlot: bigint;
  nonce: bigint;
  bump: number;
  /** SEC-M3: recipe fee parked in the vault $CG ATA until reveal (burn) / cancel (refund) */
  feeEscrowed: bigint;
}

export function decodePendingFusion(data: Uint8Array): PendingFusion {
  const r = expectDiscriminator(data, 'PendingFusion');
  return {
    owner: r.pubkey(), recipe: r.u8(), materials: r.array(MATERIALS_PER_FUSION, () => r.pubkey()),
    resultCollectionIdx: r.u8(), boosted: r.bool(), randomness: r.pubkey(), commitSlot: r.u64(), nonce: r.u64(), bump: r.u8(),
    feeEscrowed: r.u64(),
  };
}

/** Randomized claim fusion (H3) — same layout as PendingFusion, claim PDAs as materials. */
export interface PendingClaimFusion extends PendingFusion {}
export function decodePendingClaimFusion(data: Uint8Array): PendingClaimFusion {
  const r = expectDiscriminator(data, 'PendingClaimFusion');
  return {
    owner: r.pubkey(), recipe: r.u8(), materials: r.array(MATERIALS_PER_FUSION, () => r.pubkey()),
    resultCollectionIdx: r.u8(), boosted: r.bool(), randomness: r.pubkey(), commitSlot: r.u64(), nonce: r.u64(), bump: r.u8(),
    feeEscrowed: r.u64(),
  };
}

export interface PlayerItems { owner: PublicKey; boosters: number; bump: number }
export function decodePlayerItems(data: Uint8Array): PlayerItems {
  const r = expectDiscriminator(data, 'PlayerItems');
  return { owner: r.pubkey(), boosters: r.u16(), bump: r.u8() };
}

// events
export interface PackOpenedEvent {
  buyer: PublicKey; sku: number; nonce: bigint; assets: PublicKey[]; rarities: number[]; collections: number[];
  count: number; roll: Uint8Array; pityBefore: number; pityAfter: number;
}
export function readPackOpened(r: BorshReader): PackOpenedEvent {
  const e = {
    buyer: r.pubkey(), sku: r.u8(), nonce: r.u64(),
    assets: r.array(MAX_CHIPS_PER_PACK, () => r.pubkey()),
    rarities: r.array(MAX_CHIPS_PER_PACK, () => r.u8()),
    collections: r.array(MAX_CHIPS_PER_PACK, () => r.u8()),
    count: r.u8(), roll: r.bytes(32), pityBefore: r.u16(), pityAfter: r.u16(),
  };
  return { ...e, assets: e.assets.slice(0, e.count), rarities: e.rarities.slice(0, e.count), collections: e.collections.slice(0, e.count) };
}

export interface CompressedClaimsCreatedEvent {
  buyer: PublicKey; nonce: bigint; packNo: number; claimNonces: bigint[]; count: number;
}
export function readCompressedClaimsCreated(r: BorshReader): CompressedClaimsCreatedEvent {
  const e = {
    buyer: r.pubkey(), nonce: r.u64(), packNo: r.u8(),
    claimNonces: r.array(MAX_CHIPS_PER_PACK, () => r.u64()), count: r.u8(),
  };
  return { ...e, claimNonces: e.claimNonces.slice(0, e.count) };
}

interface CompressedPackSettledEvent { buyer: PublicKey; nonce: bigint; refunded: boolean }
export function readCompressedPackSettled(r: BorshReader): CompressedPackSettledEvent {
  return { buyer: r.pubkey(), nonce: r.u64(), refunded: r.bool() };
}

interface ClaimFusionCommittedEvent { owner: PublicKey; nonce: bigint; recipe: number; materials: PublicKey[] }
export function readClaimFusionCommitted(r: BorshReader): ClaimFusionCommittedEvent {
  return { owner: r.pubkey(), nonce: r.u64(), recipe: r.u8(), materials: r.array(MATERIALS_PER_FUSION, () => r.pubkey()) };
}

export interface ClaimFusionRevealedEvent {
  owner: PublicKey; nonce: bigint; recipe: number; materials: PublicKey[]; resultClaim: PublicKey;
  success: boolean; rollBps: number; thresholdBps: number; feeBurned: bigint;
}
export function readClaimFusionRevealed(r: BorshReader): ClaimFusionRevealedEvent {
  return {
    owner: r.pubkey(), nonce: r.u64(), recipe: r.u8(), materials: r.array(MATERIALS_PER_FUSION, () => r.pubkey()),
    resultClaim: r.pubkey(), success: r.bool(), rollBps: r.u16(), thresholdBps: r.u16(), feeBurned: r.u64(),
  };
}

export interface ChipFusedEvent {
  owner: PublicKey; recipe: number; materials: PublicKey[]; result: PublicKey; success: boolean;
  rollBps: number; thresholdBps: number; feeBurned: bigint;
}
export function readChipFused(r: BorshReader): ChipFusedEvent {
  return {
    owner: r.pubkey(), recipe: r.u8(), materials: r.array(MATERIALS_PER_FUSION, () => r.pubkey()), result: r.pubkey(),
    success: r.bool(), rollBps: r.u16(), thresholdBps: r.u16(), feeBurned: r.u64(),
  };
}

// ---------------------------------------------------------------- market
export interface Listing { asset: PublicKey; seller: PublicKey; price: bigint; currency: number; createdAt: bigint; bump: number }
export function decodeListing(data: Uint8Array): Listing {
  const r = expectDiscriminator(data, 'Listing');
  return { asset: r.pubkey(), seller: r.pubkey(), price: r.u64(), currency: r.u8(), createdAt: r.i64(), bump: r.u8() };
}
export interface Offer { asset: PublicKey; bidder: PublicKey; amountUsdc: bigint; expiresAt: bigint; bump: number }

// ---------------------------------------------------------------- staking
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
    paused: r.bool(), bump: r.u8(), pauser: r.pubkey(), burnOracle: r.pubkey(), recycledTotal: r.u64(), recycledMinted: r.u64(),
  };
}

export interface Pool { kind: number; totalWeight: bigint; accRewardPerWeight: bigint; budgetPerSec: bigint; budgetRemaining: bigint; lastUpdate: bigint; bump: number }
export function decodePool(data: Uint8Array): Pool {
  const r = expectDiscriminator(data, 'Pool');
  return { kind: r.u8(), totalWeight: r.u128(), accRewardPerWeight: r.u128(), budgetPerSec: r.u64(), budgetRemaining: r.u64(), lastUpdate: r.i64(), bump: r.u8() };
}

export interface TokenStake { owner: PublicKey; tier: number; amount: bigint; weight: bigint; rewardDebt: bigint; unlockAt: bigint; bump: number }
export function decodeTokenStake(data: Uint8Array): TokenStake {
  const r = expectDiscriminator(data, 'TokenStake');
  return { owner: r.pubkey(), tier: r.u8(), amount: r.u64(), weight: r.u128(), rewardDebt: r.u128(), unlockAt: r.i64(), bump: r.u8() };
}

export interface ChipStake { owner: PublicKey; asset: PublicKey; weight: bigint; rewardDebt: bigint; stakedAt: bigint; bump: number }

export interface CompressedChipStake { owner: PublicKey; claim: PublicKey; weight: bigint; rewardDebt: bigint; stakedAt: bigint; bump: number }
export function decodeCompressedChipStake(data: Uint8Array): CompressedChipStake {
  const r = expectDiscriminator(data, 'CompressedChipStake');
  return { owner: r.pubkey(), claim: r.pubkey(), weight: r.u128(), rewardDebt: r.u128(), stakedAt: r.i64(), bump: r.u8() };
}

export interface SetBonus { owner: PublicKey; completedSets: number; updatedAt: bigint; bump: number }
export function decodeSetBonus(data: Uint8Array): SetBonus {
  const r = expectDiscriminator(data, 'SetBonus');
  return { owner: r.pubkey(), completedSets: r.u8(), updatedAt: r.i64(), bump: r.u8() };
}

export interface RewardRoot { kind: number; epoch: number; root: Uint8Array; budget: bigint; claimed: bigint; publishedAt: bigint; publisher: PublicKey; revoked: boolean; bump: number }
export function decodeRewardRoot(data: Uint8Array): RewardRoot {
  const r = expectDiscriminator(data, 'RewardRoot');
  return { kind: r.u8(), epoch: r.u32(), root: r.bytes(32), budget: r.u64(), claimed: r.u64(), publishedAt: r.i64(), publisher: r.pubkey(), revoked: r.bool(), bump: r.u8() };
}

/** `["skr_pool"]` — treasury-funded SKR prize pool; invariant vault ≥ budget + reserved. */
export interface SkrPool { skrMint: PublicKey; vault: PublicKey; budget: bigint; reserved: bigint; fundedTotal: bigint; paidTotal: bigint; maxRootBudget: bigint; paused: boolean; bump: number; lastWithdrawSlot: bigint; withdrawDayStart: bigint; withdrawnToday: bigint }
export function decodeSkrPool(data: Uint8Array): SkrPool {
  const r = expectDiscriminator(data, 'SkrPool');
  return { skrMint: r.pubkey(), vault: r.pubkey(), budget: r.u64(), reserved: r.u64(), fundedTotal: r.u64(), paidTotal: r.u64(), maxRootBudget: r.u64(), paused: r.bool(), bump: r.u8(), lastWithdrawSlot: r.u64(), withdrawDayStart: r.i64(), withdrawnToday: r.u64() };
}

/** MasterChef pending = weight × acc / 1e12 − debt */
const ACC_PRECISION = 1_000_000_000_000n;
export function pendingReward(weight: bigint, acc: bigint, debt: bigint): bigint {
  const v = (weight * acc) / ACC_PRECISION - debt;
  return v > 0n ? v : 0n;
}

// ---------------------------------------------------------------- arena
export const BATTLE_STATUS = ['open', 'accepted', 'resolved', 'cancelled'] as const;
export interface ArenaConfig { admin: PublicKey; battleOracle: PublicKey; cgMint: PublicKey; seasonPool: PublicKey; treasuryCg: PublicKey; oracleDailyCap: bigint; oraclePaidToday: bigint; oracleDayStart: bigint; paused: boolean; bump: number; pauser: PublicKey }
export function decodeArenaConfig(data: Uint8Array): ArenaConfig {
  const r = expectDiscriminator(data, 'ArenaConfig');
  return { admin: r.pubkey(), battleOracle: r.pubkey(), cgMint: r.pubkey(), seasonPool: r.pubkey(), treasuryCg: r.pubkey(), oracleDailyCap: r.u64(), oraclePaidToday: r.u64(), oracleDayStart: r.i64(), paused: r.bool(), bump: r.u8(), pauser: r.pubkey() };
}
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

// ---------------------------------------------------------------- Metaplex Core (collection header)
/** Reads name + update authority from a Core collection account (Key::CollectionV1 = 5 in the crate-era
 * program — the enum is Uninitialized=0, AssetV1=1, HashedAssetV1=2, PluginHeaderV1=3, PluginRegistryV1=4,
 * CollectionV1=5, GroupV1=6) — the layout the admin spec checks after create_collection (name, update
 * authority = the collection meta PDA). */
export function decodeCoreCollectionHeader(data: Uint8Array): { updateAuthority: PublicKey; name: string; uri: string; numMinted: number; currentSize: number } {
  const r = new BorshReader(data);
  const key = r.u8();
  if (key !== 5) throw new Error('Not a Core CollectionV1');
  // unlike the asset header, a collection's update authority is a PLAIN Pubkey — no Option tag byte
  // (state/collection.rs in the crate-era program); reading the tag here shifts everything and the
  // trailing reads run past the end of the account
  const updateAuthority = r.pubkey();
  const name = r.string();
  const uri = r.string();
  const numMinted = r.u32();
  const currentSize = r.u32();
  return { updateAuthority, name, uri, numMinted, currentSize };
}

// ---------------------------------------------------------------- SPL token account (amount only)
export function decodeTokenAmount(data: Uint8Array): bigint {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return dv.getBigUint64(64, true);
}
