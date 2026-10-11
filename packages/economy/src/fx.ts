// =============================================================================
// Frozen checkout FX — packs, paid services, founder presale.
// -----------------------------------------------------------------------------
// Shop prices are USD cents. Conversion at pay time is integer and floor, with
// no third-party oracle (Pyth is not in the checkout path).
//
//   SOL  = $110     → lamports   = usd_cents × 1_000_000 / 11
//   SKR  = $0.016   → micro-SKR  = usd_cents × 625_000
//   USDC = $1       → micro-USDC = usd_cents × 10_000
//
// Discount bps (bundle, SKR 5 %) apply to `usd_cents` first, then convert.
// Market P2P stays SOL-only and does not use these rates.
// Mirrored in `chip_core::economy` (`FX_SOL_USD`, `FX_SKR_MICRO_PER_USD_CENT`)
// and pinned by `economy:check`.
// =============================================================================

export const FX = {
  solUsd: 110,
  /** Display-only. Never use a float for amounts — see `skrMicroForUsdCents`. */
  skrUsd: 0.016,
  /** 1 USD cent buys 0.625 SKR at $0.016 → 625_000 micro-SKR. */
  skrMicroPerUsdCent: 625_000,
  usdcMicroPerUsdCent: 10_000,
} as const;

/** Lamports charged for `usdCents` at SOL = $110. Floor division. */
export function solLamportsForUsdCents(usdCents: number | bigint): bigint {
  return BigInt(usdCents) * 1_000_000n / 11n;
}

/** Micro-SKR charged for `usdCents` at SKR = $0.016. Floor (the multiply is exact). */
export function skrMicroForUsdCents(usdCents: number | bigint): bigint {
  return BigInt(usdCents) * BigInt(FX.skrMicroPerUsdCent);
}

/** Micro-USDC charged for `usdCents` at USDC = $1. */
export function usdcMicroForUsdCents(usdCents: number | bigint): bigint {
  return BigInt(usdCents) * BigInt(FX.usdcMicroPerUsdCent);
}

/**
 * USD cents implied by a SOL lamport price at $110 (floor).
 * Founder presale keeps its SOL sticker (0.30 / 0.999) and derives USDC/SKR from this.
 */
export function usdCentsFromSolLamports(lamports: number | bigint): bigint {
  return BigInt(lamports) * 11n / 1_000_000n;
}
