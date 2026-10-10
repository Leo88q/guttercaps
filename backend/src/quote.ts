// POST /packs/quote — the price + everything the client needs to build buy_pack.
//
// Checkout is frozen FX (SOL = $110, SKR = $0.016, USDC = $1). SOL/SKR amounts are
// the same integer formula as chip_core::fx_sol_lamports / fx_skr_micro. Pyth is
// not read here: a stale feed must never 503 a purchase. `price_update` stays
// optional on the instruction so old clients do not break; the program ignores it.
//
// Pity and daily caps come from the indexer (pack_opens / pack_purchases), the
// pack table from the economy package (== GameConfig defaults; a live
// GameConfig read replaces it once the admin panel lands — TODO(G-1)).
import type { Connection } from '@solana/web3.js';
import { PACKS, BUNDLES, FEES, FX, effectiveOdds, solLamportsForUsdCents, skrMicroForUsdCents, usdcMicroForUsdCents, type PackId } from '@guttercaps/economy';
import { QUOTE_CACHE_MS, SWITCHBOARD_QUEUE } from './config.ts';
import { randomBytes } from 'node:crypto';
import { type Db, now } from './db.ts';
import { configuredPriceAccounts, fetchFeeds, type PythAccounts } from './pyth.ts';
import { ServiceError } from './services.ts';

export const SKUS: PackId[] = ['starter', 'standard', 'premium', 'limited'];
export type QuoteCurrency = 'SOL' | 'USDC' | 'CG' | 'SKR';
const CURRENCY_CODE: Record<QuoteCurrency, number> = { SOL: 0, USDC: 1, CG: 2, SKR: 3 };
const RENT_RESERVE_PER_CHIP = 8_000_000n; // chip_core::instructions::packs::RENT_RESERVE_PER_CHIP (SEC-L3: 0.008 SOL, unspent part returned)
const MAX_TOTAL_DISCOUNT_BPS = 3_000;      // buy_pack: bundle + SKR promo capped at 30 %
const QUOTE_TTL_MS = 24 * 60 * 60 * 1000; // frozen prices do not race a 60 s feed

export interface QuoteRequest { sku: number; qty: number; currency: QuoteCurrency }

/** Same integer maths as buy_pack (packs.rs): bundle discount, SKR promo stacked additively, capped at 30 %. */
export function priceCents(sku: number, qty: number, currency: QuoteCurrency, skrDiscountBps: number = FEES.skrPackDiscountBps): { cents: number; discountBps: number } {
  const p = PACKS[SKUS[sku]];
  const bundlesAllowed = sku === 1 || sku === 2; // Starter/Limited never get bundle discounts
  const bundleBps = bundlesAllowed ? ([...BUNDLES].reverse().find((b) => qty >= b.qty)?.discountBps ?? 0) : 0;
  const discountBps = currency === 'SKR' ? Math.min(bundleBps + skrDiscountBps, MAX_TOTAL_DISCOUNT_BPS) : bundleBps;
  const cents = Math.floor((p.priceUsdCents * qty * (10_000 - discountBps)) / 10_000);
  return { cents, discountBps };
}

export function validateRequest(body: unknown): QuoteRequest {
  const b = (body ?? {}) as Partial<Record<keyof QuoteRequest, unknown>>;
  const sku = Number(b.sku), qty = Number(b.qty);
  const currency = String(b.currency ?? '') as QuoteCurrency;
  if (!Number.isInteger(sku) || sku < 0 || sku > 3) throw new ServiceError(400, 'bad_sku', 'sku must be 0..3');
  if (!Number.isInteger(qty) || qty < 1 || qty > 25) throw new ServiceError(400, 'bad_qty', 'qty must be 1..25');
  if (!(currency in CURRENCY_CODE)) throw new ServiceError(400, 'bad_currency', 'currency must be SOL | USDC | CG | SKR');
  const p = PACKS[SKUS[sku]];
  if (currency === 'CG' && !p.priceCgMicro) throw new ServiceError(400, 'currency_not_accepted', `${p.name} cannot be bought with $CG`);
  if (sku === 0 && qty !== 1) throw new ServiceError(400, 'bad_qty', 'Starter is one per wallet');
  if (sku === 3 && qty > (p.dailyCap ?? 25)) throw new ServiceError(400, 'bad_qty', `Limited: at most ${p.dailyCap} per day`);
  return { sku, qty, currency };
}

/** Per-wallet state the program will check: pity counter, bought today, starter claimed. */
export function walletPackState(db: Db, wallet: string, sku: number) {
  const boughtToday = db.scalar(`SELECT COALESCE(SUM(qty),0) FROM pack_purchases WHERE buyer = ? AND sku = ? AND COALESCE(block_time, ?) >= ?`, wallet, sku, now(), now() - 86_400);
  const pity = db.get<{ pity_after: number }>(`SELECT pity_after FROM pack_opens WHERE buyer = ? AND sku = ? ORDER BY slot DESC LIMIT 1`, wallet, sku)?.pity_after ?? 0;
  const starterClaimed = sku === 0 && db.scalar(`SELECT COUNT(*) FROM pack_purchases WHERE buyer = ? AND sku = 0`, wallet) > 0;
  return { boughtToday, pity, starterClaimed };
}

// leftover Pyth cache — `/prices` / health still read feeds; checkout does not.
let cached: { at: number; key: string; feeds: Awaited<ReturnType<typeof fetchFeeds>> } | undefined;
export async function currentFeeds(connection: Connection, maxAgeMs = QUOTE_CACHE_MS, accounts?: PythAccounts) {
  const key = accounts ? `${accounts.SOL.toBase58()}:${accounts.SKR.toBase58()}` : 'env';
  if (cached && cached.key === key && Date.now() - cached.at < maxAgeMs) return cached.feeds;
  const feeds = await fetchFeeds(connection, { accounts });
  cached = { at: Date.now(), key, feeds };
  return feeds;
}
export function _resetQuoteCache() { cached = undefined; }

export async function packQuote(db: Db, connection: Connection, wallet: string, req: QuoteRequest) {
  void connection;
  const p = PACKS[SKUS[req.sku]];
  const state = walletPackState(db, wallet, req.sku);
  if (req.sku === 0 && state.starterClaimed) throw new ServiceError(409, 'starter_claimed', 'Starter pack already claimed by this wallet');
  if (p.dailyCap && state.boughtToday + req.qty > p.dailyCap) throw new ServiceError(429, 'daily_cap', `Daily cap ${p.dailyCap} for ${p.name} reached (${state.boughtToday} bought today)`);

  const { cents, discountBps } = priceCents(req.sku, req.qty, req.currency);
  const base = {
    sku: req.sku, qty: req.qty, currency: req.currency, discountBps,
    priceUsdCents: cents,
    rentReserveLamports: String(RENT_RESERVE_PER_CHIP * BigInt(p.chips) * BigInt(req.qty)),
    effectiveOddsBps: effectiveOdds(p, state.pity),
    pityCounter: state.pity,
    hardPityIn: p.pity ? Math.max(0, p.pity.hardAt - state.pity) : 0,
    nonce: String(BigInt(`0x${randomBytes(8).toString('hex')}`)),
    accounts: {} as Record<string, string>,
    switchboardQueue: SWITCHBOARD_QUEUE,
    pythUpdateData: [] as string[],
    solUsd: FX.solUsd,
    skrUsd: FX.skrUsd,
    expiresAt: new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
  };

  if (req.currency === 'USDC') {
    const amount = usdcMicroForUsdCents(cents);
    return { ...base, amount: String(amount), maxLamports: '0' };
  }
  if (req.currency === 'CG') {
    const amount = Math.floor((p.priceCgMicro! * req.qty * (10_000 - discountBps)) / 10_000);
    return { ...base, amount: String(amount), maxLamports: '0' };
  }
  if (req.currency === 'SOL') {
    const amount = solLamportsForUsdCents(cents);
    return { ...base, amount: String(amount), maxLamports: String(amount) };
  }
  const amount = skrMicroForUsdCents(cents);
  return { ...base, amount: String(amount), maxLamports: String(amount) };
}

export type PackQuote = Awaited<ReturnType<typeof packQuote>>;
