// Reproducer: the checkout price, the limits and the "is this SKU on sale" decision come from the
// compiled `@guttercaps/economy` constants, while `chip_core::buy_pack` recomputes all three from the
// on-chain `GameConfig.packs[sku]` (programs/chip_core/src/instructions/packs.rs:174-300).
//
// `backend/src/quote.ts` says so itself — "the pack table from the economy package (== GameConfig
// defaults; a live GameConfig read replaces it once the admin panel lands — TODO(G-1))" — and
// `packQuote` never touches the connection (`void connection`, line 72). But `set_params` is a
// supported admin operation with its own guard rails (backend/src/admin.ts:105-160, ×½–2× per step),
// so the two tables drift as soon as anybody uses it:
//
//   * price raised on chain  → the quote's `maxLamports` is below what the program wants and the
//     purchase fails with `Slippage` (packs.rs:296-299) until the API image is rebuilt;
//   * price lowered on chain → the buyer pays the new (lower) price, but the UI advertised the old one;
//   * `enabled = false` on chain → the storefront still shows the SKU, `validateRequest` accepts it,
//     and the transaction fails with `SkuDisabled`;
//   * `daily_cap` on chain ≠ the package's `dailyCap` → the quote refuses purchases the chain would
//     allow, or lets through one the chain rejects with `DailyCapReached`.
//
// The decoder that would read the truth already exists (`backend/src/chain.ts:decodeGameConfig`,
// used by `admin.paramsApi`); the purchase path just does not use it.
import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { PACKS } from '@guttercaps/economy';
import { Db } from '../src/db.ts';
import { BorshWriter } from '../src/borsh.ts';
import { accountDiscriminator, decodeGameConfig } from '../src/chain.ts';
import { packQuote, validateRequest } from '../src/quote.ts';

interface PackDefBytes {
  chips: number; priceUsdCents: number; priceCgMicro: bigint; oddsBps: number[]; floor: number;
  dailyCap: number; pityTier: number; pityHardAt: number; pitySoftStart: number; pitySoftStepBps: number;
  featuredOnly: boolean; enabled: boolean;
}

function packDef(w: BorshWriter, p: PackDefBytes) {
  w.u8(p.chips).u32(p.priceUsdCents).u64(p.priceCgMicro);
  for (const o of p.oddsBps) w.u16(o);
  w.u8(p.floor).u8(p.dailyCap).u8(p.pityTier).u16(p.pityHardAt).u16(p.pitySoftStart).u16(p.pitySoftStepBps)
    .bool(p.featuredOnly).bool(p.enabled);
}

/** A GameConfig with `standard` repriced to $9.99, disabled, and capped at 1/day. */
function gameConfigBytes(): Uint8Array {
  const w = new BorshWriter();
  w.bytes(accountDiscriminator('GameConfig'));
  for (let i = 0; i < 10; i++) w.pubkey(PublicKey.unique());
  w.u8(0).bool(false);
  const d = (priceUsdCents: number, enabled: boolean, dailyCap: number): PackDefBytes => ({
    chips: 5, priceUsdCents, priceCgMicro: 1_000_000_000n, oddsBps: Array(9).fill(1_111),
    floor: 1, dailyCap, pityTier: 0, pityHardAt: 0, pitySoftStart: 0, pitySoftStepBps: 0,
    featuredOnly: false, enabled,
  });
  packDef(w, d(199, true, 1));      // starter
  packDef(w, d(999, false, 1));     // standard — the SKU this test buys
  packDef(w, d(1499, true, 0));     // premium
  packDef(w, d(2999, true, 5));     // limited
  w.u16(500).u16(1000).u8(0).u32(7).u8(255).u8(254).pubkey(PublicKey.default);
  return w.toBytes();
}

describe('checkout quote vs on-chain GameConfig', () => {
  it('quotes the compiled package price for a SKU the chain has repriced and disabled', async () => {
    const bytes = gameConfigBytes();
    const onChain = decodeGameConfig(bytes); // proof the buffer really is a GameConfig
    expect(onChain.packs[1].priceUsdCents).toBe(999);
    expect(onChain.packs[1].enabled).toBe(false);
    expect(onChain.packs[1].dailyCap).toBe(1);

    const db = new Db(':memory:');
    const wallet = PublicKey.unique().toBase58();
    const req = validateRequest({ sku: 1, qty: 2, currency: 'SOL' }); // identical to the package's 599
    const quote = await packQuote(db, { getAccountInfo: async () => ({ data: bytes }) } as never, wallet, req);

    // The storefront advertises (and signs `max_lamports` for) the package price, not the chain's.
    expect(quote.priceUsdCents).toBe(Math.floor((PACKS.standard.priceUsdCents * 2 * 10_000) / 10_000));
    expect(quote.priceUsdCents).not.toBe(onChain.packs[1].priceUsdCents * 2);
    // The chain's `daily_cap = 1` would reject qty 2, while the package has no cap for `standard`.
    expect(PACKS.standard.dailyCap).toBeNull();
    // Nothing in the path consults `enabled`: a disabled SKU is a normal, sellable SKU here.
    expect(() => validateRequest({ sku: 1, qty: 1, currency: 'SOL' })).not.toThrow();

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      chainPriceCents: onChain.packs[1].priceUsdCents,
      chainEnabled: onChain.packs[1].enabled,
      chainDailyCap: onChain.packs[1].dailyCap,
      quotePriceCentsForQty2: quote.priceUsdCents,
      quoteMaxLamports: quote.maxLamports,
      packagePriceCents: PACKS.standard.priceUsdCents,
    }));
    db.raw.close();
  });
});
