// Read a Pyth PriceUpdateV2 account so the client can quote SOL/SKR prices
// itself (fallback when /packs/quote is down) and sanity-check the backend.
// The prices are posted by OUR pusher into push-oracle shard 0xCA75 (owner
// decision Q7, ops/pyth-pusher/); the program only checks owner / feed id /
// Full verification / age ≤ 60 s, never the shard.
import { PublicKey } from '@solana/web3.js';
import { effectivePythPrice, PYTH_MAX_CONF_BPS, PythConfidenceError } from '@guttercaps/economy';
import { BorshReader } from './borsh';
import { PYTH_PUSH_ORACLE_ID, PYTH_SHARD_ID } from './ids';

/** Max age chip_core accepts (economy.rs SOL_PRICE_MAX_AGE_SECS) and the API's quote-refusal margin. */
export const PYTH_MAX_AGE_S = 60;
const PYTH_ALERT_AGE_S = 45;
export { PYTH_MAX_CONF_BPS, PythConfidenceError };

/** Push-oracle PriceUpdateV2 PDA: seeds [shard u16 LE, feed_id] under pythWSns… */
export function pushOracleAccount(feedIdHex: string, shard: number = PYTH_SHARD_ID): PublicKey {
  const seed = new Uint8Array([shard & 0xff, (shard >> 8) & 0xff]);
  const feed = Uint8Array.from(feedIdHex.match(/../g)!.map((h) => parseInt(h, 16)));
  return PublicKey.findProgramAddressSync([seed, feed], PYTH_PUSH_ORACLE_ID)[0];
}

export interface PythPrice { price: bigint; conf: bigint; exponent: number; publishTime: bigint; feedIdHex: string }

/** PriceUpdateV2: 8 disc ‖ write_authority[32] ‖ verification_level(enum) ‖ PriceFeedMessage ‖ posted_slot u64 */
export function decodePriceUpdateV2(data: Uint8Array): PythPrice {
  const r = new BorshReader(data, 8);
  r.skip(32); // write_authority
  const vl = r.u8(); // VerificationLevel: 0 Partial{num_signatures u8}, 1 Full
  if (vl === 0) r.skip(1);
  const feedId = r.bytes(32);
  const price = r.i64();
  const conf = r.u64();
  const exponent = new DataView(r.buf.buffer, r.buf.byteOffset + r.offset, 4).getInt32(0, true);
  r.skip(4);
  const publishTime = r.i64();
  return { price, conf, exponent, publishTime, feedIdHex: Array.from(feedId, (b) => b.toString(16).padStart(2, '0')).join('') };
}

/**
 * Same integer formula as chip_core::economy::usd_cents_to_units:
 * units = cents × 10^decimals × 10^|expo| / 100 / price. Works for any
 * Pyth-priced rail — SOL (9 dp) and SKR (6 dp).
 */
export function usdCentsToUnits(cents: bigint, p: PythPrice, decimals: number): bigint {
  if (p.price <= 0n) throw new Error('Pyth price must be positive');
  const scale = 10n ** BigInt(Math.abs(p.exponent));
  // SEC-M2: the program charges at price − conf and refuses conf/price > PYTH_MAX_CONF_BPS (PriceUncertain)
  return (cents * 10n ** BigInt(decimals) * scale) / 100n / effectivePythPrice(p.price, p.conf);
}
/** true when the program would accept this update's confidence (conf / price ≤ 2 %). */
export const isConfident = (p: PythPrice): boolean => p.price > 0n && p.conf < p.price && p.conf * 10_000n <= p.price * BigInt(PYTH_MAX_CONF_BPS);

/** lamports for a USD-cent amount (SOL/USD feed). */
export const usdCentsToLamports = (cents: bigint, p: PythPrice): bigint => usdCentsToUnits(cents, p, 9);
/** micro-SKR for a USD-cent amount (SKR/USD feed). */
export const usdCentsToMicroSkr = (cents: bigint, p: PythPrice): bigint => usdCentsToUnits(cents, p, 6);

/** Human price (USD per unit) — display only, never used for amounts. */
export function priceUsd(p: PythPrice): number {
  return Number(p.price) * Math.pow(10, p.exponent);
}
export const solUsd = priceUsd;

/** Guard: the account really carries the feed we expect (SOL vs SKR vs a counterfeit). */
export function assertFeed(p: PythPrice, feedIdHex: string, label: string) {
  if (p.feedIdHex !== feedIdHex.toLowerCase()) throw new Error(`Pyth account is not the ${label} feed`);
}

/** Seconds since publish — what the program compares against the 60 s window. */
export const priceAgeS = (p: PythPrice, nowS = Math.floor(Date.now() / 1000)) => nowS - Number(p.publishTime);
export const isFresh = (p: PythPrice, maxAgeS = PYTH_ALERT_AGE_S, nowS?: number) => priceAgeS(p, nowS) <= maxAgeS;
