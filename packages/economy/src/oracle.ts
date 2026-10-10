// =============================================================================
// GUTTERCAPS economy — Pyth (monitoring / pusher only)
// -----------------------------------------------------------------------------
// Checkout no longer reads Pyth. Packs, paid services and the founder presale
// convert USD cents at the frozen rates in `./fx.ts` (SOL = $110, SKR = $0.016)
// inside the transaction. The `price_update` account slot stays on buy_pack /
// pay_service so the IDL does not break; the handler ignores it.
//
// This file is the leftover of owner decision Q7 (own pusher, 60 s max age):
// `/prices`, the pusher yaml and GameConfig feed pubkeys still exist for ops
// display. They must not gate a purchase. Feed ids stay pinned by sync-check
// against the unused rust constants so a later revival cannot drift.
// =============================================================================

export interface PythFeed {
  symbol: 'SOL' | 'SKR';
  pair: string;
  /** 32-byte Pyth price feed id (Hermes id), lower-case hex without 0x. */
  feedIdHex: string;
  decimals: number;
  /** Payment rail code (tokenomics.CURRENCIES). */
  currency: 0 | 3;
}

export const PYTH_FEEDS: Record<'SOL' | 'SKR', PythFeed> = {
  SOL: { symbol: 'SOL', pair: 'Crypto.SOL/USD', feedIdHex: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d', decimals: 9, currency: 0 },
  SKR: { symbol: 'SKR', pair: 'Crypto.SKR/USD', feedIdHex: '38846ec4d0dbe808091817f5c0d6ab8058e25422348ddf97db52b6c378a93bf9', decimals: 6, currency: 3 },
} as const;

/** Pyth programs on Solana (same ids on mainnet-beta and devnet). */
export const PYTH_PROGRAMS = {
  /** Verifies Wormhole VAAs and owns every PriceUpdateV2 account. */
  receiver: 'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ',
  /** Push oracle: PDA per (shard u16 LE, feed id); `update_price_feed` is permissionless. */
  pushOracle: 'pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT',
} as const;

/** Max age of the price the program accepts — chip_core::economy::SOL_PRICE_MAX_AGE_SECS. */
export const PYTH_MAX_AGE_SECS = 60;
/** Slippage guard applied to the quote (max_lamports / max_units) — chip_core::economy::SLIPPAGE_BPS. */
export const PYTH_SLIPPAGE_BPS = 100;
/**
 * SEC-M2 confidence guard — chip_core::economy::PYTH_MAX_CONF_BPS. The program refuses a price whose
 * `conf / price` exceeds 2 % (`PriceUncertain`) and charges at `price − conf` (the protocol-favouring
 * edge of the interval). SOL normally sits at ≈ 0.05 %, SKR at 0.1–0.5 %; 2 % means the publishers
 * disagree and the number is not a price. The API returns 503 `price_unavailable` in that state.
 */
export const PYTH_MAX_CONF_BPS = 200;
/**
 * Our push-oracle shard ("CAPS" in hex). Shard 0 is the Pyth-sponsored one;
 * any other u16 is free to use — the accounts are created by the first push.
 * Derived accounts (mainnet-beta and devnet, same program ids):
 *   SOL/USD  ELp9x5sFxGJ7zTurykU2p6A9nKDx72b3xzPxfsB5S8GB
 *   SKR/USD  9bCSdQVWckgKipe4G3G66aYU9yq2ZdDn8kRPZB9Nihbc
 */
export const PYTH_SHARD_ID = 0xca75;
/** Pyth-sponsored shard-0 accounts (SOL/USD only is sponsored; 55 s heartbeat / 0.5 % deviation). */
export const PYTH_SPONSORED_SHARD_ID = 0;

/**
 * price_pusher configuration (apps/price_pusher, Solana mode). Trigger = ANY of
 * timeDifference / priceDeviation / confidenceRatio per feed; both feeds are
 * batched into one push when either triggers.
 */
export const PYTH_PUSHER = {
  /** push when the on-chain price is older than this many seconds */
  timeDifferenceS: 30,
  /** …or moved more than this many percent vs. the on-chain price */
  priceDeviationPct: 0.5,
  /** …or conf/price exceeds this many percent (kept high on purpose: thin SKR book) */
  confidenceRatioPct: 50,
  /** how often the pusher evaluates the triggers */
  pushingFrequencyS: 10,
  pollingFrequencyS: 5,
  /** priority fee — our accounts are uncontended, base fee usually lands; raise when age alerts fire */
  computeUnitPriceMicroLamports: 200,
  /** ops alert: on-chain price older than this ⇒ pusher unhealthy (still 15 s of margin for buyers) */
  alertAgeS: 45,
  /** quotes stop being issued when less than this much validity is left (buyer needs time to sign) */
  quoteMinRemainingS: 15,
} as const;

/** Worst-case on-chain price age with the pusher policy above (seconds). */
export const PYTH_WORST_CASE_AGE_S = PYTH_PUSHER.timeDifferenceS + PYTH_PUSHER.pushingFrequencyS + 5;

/**
 * Token base units for `usdCents` at a Pyth price — the SAME integer formula as
 * chip_core::instructions::packs::units_for_cents:
 *   units = cents × 10^decimals × 10^|expo| / 100 / price     (floor division)
 * SOL: decimals 9 → lamports; SKR: decimals 6 → micro-SKR.
 */
export function unitsForCents(usdCents: bigint | number, price: bigint, exponent: number, decimals: number): bigint {
  if (price <= 0n) throw new Error('Pyth price must be positive');
  const cents = BigInt(usdCents);
  if (cents < 0n) throw new Error('negative amount');
  const scale = 10n ** BigInt(Math.abs(exponent));
  return (cents * 10n ** BigInt(decimals) * scale) / 100n / price;
}

/**
 * The price the program actually charges at (SEC-M2): rejects conf/price > PYTH_MAX_CONF_BPS and
 * returns `price − conf` — bit-for-bit what `chip_core::instructions::packs::oracle_price` does.
 */
export function effectivePythPrice(price: bigint, conf: bigint, maxConfBps: number = PYTH_MAX_CONF_BPS): bigint {
  if (price <= 0n) throw new PythConfidenceError('Pyth price must be positive');
  if (conf * 10_000n > price * BigInt(maxConfBps)) throw new PythConfidenceError(`Pyth confidence ${Number((conf * 10_000n) / price) / 100} % exceeds ${maxConfBps / 100} %`);
  const eff = price - conf;
  if (eff <= 0n) throw new PythConfidenceError('Pyth confidence swallows the price');
  return eff;
}
export class PythConfidenceError extends Error {}
/** conf / price in basis points (monitoring / /prices). */
export const confBps = (price: bigint, conf: bigint): number => (price <= 0n ? 10_000 : Number((conf * 10_000n) / price));

/** Slippage guard passed to buy_pack / pay_service: units × (1 + PYTH_SLIPPAGE_BPS). */
export function maxUnitsWithSlippage(units: bigint, slippageBps: number = PYTH_SLIPPAGE_BPS): bigint {
  return (units * BigInt(10_000 + slippageBps)) / 10_000n;
}

/** Human price (USD per unit) for display only — never for on-chain amounts. */
export function pythPriceToUsd(price: bigint, exponent: number): number {
  return Number(price) * Math.pow(10, exponent);
}

/**
 * Monthly SOL cost of running the pusher. One push with FULL verification (what
 * chip_core requires) is ≈ 3 transactions / 4 signatures (init + write encoded
 * VAA, write + verify, update_price_feed × 2 + close) and ≈ 600 k CU. The base
 * fee (5 000 lamports per signature) dominates; the priority fee is noise.
 * Cadence: the pusher re-evaluates every pushingFrequencyS, so pushes land every
 * timeDifferenceS + pushingFrequencyS/2 on average, plus ≈ 15 % deviation pushes.
 * ⇒ ≈ 2 SOL / month at the default policy (≈ $300 at $150/SOL).
 */
export function pusherCostSolPerMonth(opts: { cuPriceMicroLamports?: number; cuPerPush?: number; signaturesPerPush?: number; pushesPerDay?: number } = {}): number {
  const cuPrice = opts.cuPriceMicroLamports ?? PYTH_PUSHER.computeUnitPriceMicroLamports;
  const cu = opts.cuPerPush ?? 600_000;
  const sigs = opts.signaturesPerPush ?? 4;
  const intervalS = PYTH_PUSHER.timeDifferenceS + PYTH_PUSHER.pushingFrequencyS / 2;
  const pushes = opts.pushesPerDay ?? (86_400 / intervalS) * 1.15;
  const lamportsPerPush = sigs * 5_000 + (cu * cuPrice) / 1_000_000;
  return (lamportsPerPush * pushes * 30) / 1e9;
}
