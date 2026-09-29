import { PublicKey } from '@solana/web3.js';
import { buyIx, marketMintFor, MarketCurrency, type BuyArgs } from '@/chain/ix/market';
import { createAtaIdempotentIx } from '@/chain/ix/spl';

// Protocol codes and decimal precision are independent of the display language.
const PAYMENTS = {
  SOL: { symbol: 'SOL', code: MarketCurrency.SOL, decimals: 9 },
  USDC: { symbol: 'USDC', code: MarketCurrency.USDC, decimals: 6 },
  SKR: { symbol: 'SKR', code: MarketCurrency.SKR, decimals: 6 },
} as const;
export function marketPayment(symbol?: string) {
  return symbol && Object.hasOwn(PAYMENTS, symbol) ? PAYMENTS[symbol as keyof typeof PAYMENTS] : undefined;
}

/** Market's code 2 is SKR, unlike the API's general currency enum (2 = CG). */
export const marketPaymentByCode = (code: number) => Object.values(PAYMENTS).find(p => p.code === code);

export function listingBuyIxs(a: Omit<BuyArgs, 'expectedCurrency'> & { currency?: string }) {
  const payment = marketPayment(a.currency);
  if (!payment) throw new Error('This currency is not enabled on this cluster');
  const args: BuyArgs = { ...a, expectedCurrency: payment.code };
  const mint = marketMintFor(payment.code, args);
  if (payment.code !== MarketCurrency.SOL && (!mint || mint.equals(PublicKey.default))) {
    throw new Error('This currency is not enabled on this cluster');
  }
  const prepare = mint ? [a.seller, a.treasury, a.buybackWallet].map((owner) => createAtaIdempotentIx(a.buyer, owner, mint)) : [];
  return [...prepare, buyIx(args)];
}
