import { afterEach, describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { LOCALES, setLocale } from '@/shared/i18n';
import { parseUnits } from '@/shared/lib/format';
import { ata } from '@/chain/pdas';
import { MARKET_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@/chain/ids';
import { updatePriceIx } from '@/chain/ix/market';
import { listingBuyIxs, marketPayment } from './payment';

const pk = () => Keypair.generate().publicKey;
const args = { buyer: pk(), seller: pk(), asset: pk(), collectionIdx: 2, coreCollection: pk(), treasury: pk(), buybackWallet: pk(), usdcMint: pk(), skrMint: pk(), expectedPrice: 12_345_678n };
afterEach(async () => { await setLocale('en'); });
describe('market payment precision and token accounts', () => {
  for (const locale of LOCALES) {
    it(`${locale}: SKR stays wire code 2 with six decimals, not SOL or API code 3`, async () => {
      await setLocale(locale);
      const payment = marketPayment('SKR')!;
      expect(payment).toEqual({ symbol: 'SKR', code: 2, decimals: 6 });
      const ixs = listingBuyIxs({ ...args, currency: 'SKR' });
      expect(ixs).toHaveLength(4);
      for (const [i, owner] of [args.seller, args.treasury, args.buybackWallet].entries()) {
        expect(ixs[i].programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
        expect(ixs[i].keys[1].pubkey.equals(ata(args.skrMint, owner))).toBe(true);
        expect(ixs[i].keys[3].pubkey.equals(args.skrMint)).toBe(true);
      }
      const buy = ixs[3];
      expect(buy.data.readBigUInt64LE(8)).toBe(args.expectedPrice);
      expect(buy.data[16]).toBe(2);
      for (const [i, owner] of [args.buyer, args.seller, args.treasury, args.buybackWallet].entries()) {
        expect(buy.keys[11 + i].pubkey.equals(ata(args.skrMint, owner))).toBe(true);
      }
      for (const input of ['12.345678', '12,345678']) {
        const price = parseUnits(input, payment.decimals)!;
        expect(price).toBe(12_345_678n);
        expect(updatePriceIx({ seller: args.seller, asset: args.asset, price }).data.readBigUInt64LE(8)).toBe(price);
      }
    });
  }
  it('SOL has no SPL preparation; USDC uses its own mint', () => {
    const sol = listingBuyIxs({ ...args, currency: 'SOL' });
    expect(sol).toHaveLength(1);
    expect(sol[0].data[16]).toBe(0);
    expect(sol[0].keys[11].pubkey.equals(MARKET_ID)).toBe(true);
    const usdc = listingBuyIxs({ ...args, currency: 'USDC' });
    expect(usdc[3].data[16]).toBe(1);
    expect(usdc[3].keys[11].pubkey.equals(ata(args.usdcMint, args.buyer))).toBe(true);
    expect(marketPayment('SOL')!.decimals).toBe(9);
  });
  it('unknown currencies and missing/zero SKR mint fail closed, never fall back to SOL', () => {
    for (const currency of [undefined, '$CG', 'skr', 'constructor']) {
      expect(marketPayment(currency)).toBeUndefined();
      expect(() => listingBuyIxs({ ...args, currency })).toThrow('This currency is not enabled');
    }
    expect(() => listingBuyIxs({ ...args, currency: 'SKR', skrMint: undefined })).toThrow();
    expect(() => listingBuyIxs({ ...args, currency: 'SKR', skrMint: PublicKey.default })).toThrow();
  });
});
