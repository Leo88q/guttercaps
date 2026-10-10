import { PublicKey } from '@solana/web3.js';
import { CLUSTER, PROGRAM_IDS } from '@/app/config';

export const CHIP_CORE_ID = PROGRAM_IDS.chipCore;
export const MARKET_ID = PROGRAM_IDS.market;
export const STAKING_ID = PROGRAM_IDS.staking;
export const ARENA_ID = PROGRAM_IDS.arena;

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

/**
 * Pyth leftover (pusher / GameConfig feed pubkeys). Checkout does not read these:
 * packs, services and the founder presale convert at frozen FX (SOL = $110, SKR = $0.016).
 * `price_update` on buy_pack / pay_service is unused and may be omitted.
 */
export const PYTH_RECEIVER_ID = new PublicKey('rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ');
export const PYTH_PUSH_ORACLE_ID = new PublicKey('pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT');
export const PYTH_SOL_USD_FEED_ID_HEX = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
/** Pyth `Crypto.SKR/USD` (Hermes id). The configured PriceUpdateV2 account carries this feed. */
export const PYTH_SKR_USD_FEED_ID_HEX = '38846ec4d0dbe808091817f5c0d6ab8058e25422348ddf97db52b6c378a93bf9';
/** Our push-oracle shard (0xCA75 = "CAPS") and its two PDAs: [shard u16 LE, feed_id] under the push-oracle program. */
export const PYTH_SHARD_ID = 0xca75;
export const PYTH_PRICE_ACCOUNTS = {
  SOL: new PublicKey('ELp9x5sFxGJ7zTurykU2p6A9nKDx72b3xzPxfsB5S8GB'),
  SKR: new PublicKey('9bCSdQVWckgKipe4G3G66aYU9yq2ZdDn8kRPZB9Nihbc'),
} as const;
/** Pyth-sponsored shard-0 SOL/USD account (55 s heartbeat — too slow for a 60 s window; incident fallback only). */
export const PYTH_SPONSORED_SOL_USD = new PublicKey('7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE');

/**
 * Switchboard On-Demand is a DIFFERENT program per cluster (SEC-H1): mainnet `SBond…`, devnet
 * `Aio4…`, localnet our `sb_mock` (tests/localnet). The on-chain programs enforce
 * `randomness.owner == chip_core::randomness::SB_PROGRAM_ID` for the cluster they were built for,
 * so these three tables must stay in sync with `programs/chip_core/src/randomness.rs`.
 */
export const SWITCHBOARD_PROGRAM_ID = {
  'mainnet-beta': new PublicKey('SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv'),
  devnet: new PublicKey('Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2'),
  localnet: new PublicKey('ApDh35vcLCxXc5ivaRGFhayn1HduJ9b2nXbfR6WMpVKH'), // programs/sb_mock, keypair in tests/localnet/fixtures
} as const;
export const SWITCHBOARD_QUEUE = {
  'mainnet-beta': new PublicKey('A43DyUGA7s8eXPxqEjJY6EBu1KKbNgfxF8h17VAHn13w'),
  devnet: new PublicKey('EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7'),
  localnet: new PublicKey('EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7'), // sb_mock ignores the queue; any key works
} as const;
export const SWITCHBOARD_ON_DEMAND_ID = SWITCHBOARD_PROGRAM_ID[CLUSTER];
