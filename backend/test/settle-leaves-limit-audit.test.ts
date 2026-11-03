// Reproducer (находка 25): `settle_pack` принимает не больше `MAX_SPECS = 10` спецификаций
// (programs/settle/src/lib.rs:62,931), а магазин продаёт бандлы ×5/×10/×25 — по 5 чипов на standard и
// premium это 25/50/125 листьев. `settleAuthForOrder` выписывал подпись и на 25 спецификаций: эскроу
// оплачен, доставить его одной инструкцией нельзя, пути частичного settle нет. Здесь проверяется, что
// лимит объявлен один раз (packages/economy) и совпадает с контрактом, что backend отказывает ДО
// подписи и ничего не пишет в `settle_specs`, и что граница (×2 = 10 листьев) по-прежнему проходит.
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import {
  BUNDLES, MAX_LEAVES_PER_TX, PACKS, assertSettleableLeaves, leavesForPurchase, maxQtyPerSettle,
} from '@guttercaps/economy';
import { SKUS } from '../src/quote.ts';
import { Db } from '../src/db.ts';
import * as orders from '../src/pack-orders.ts';

let pv: typeof import('../src/phasev.ts');
beforeAll(async () => {
  vi.resetModules();
  process.env.SHARED_MERKLE_TREE = Keypair.generate().publicKey.toBase58();
  pv = await import('../src/phasev.ts');
});

const T0 = 1_800_000_000;
const TREASURY = Keypair.generate().publicKey.toBase58();
const BUYER = Keypair.generate();

/** Фальшивый эскроу-аккаунт `PackEscrow`-формы, который «находит» RPC (как в backend/test/phasev.test.ts). */
function escrowConn(orderId: number, amount: string) {
  const acct = Buffer.alloc(8 + 59);
  BUYER.publicKey.toBuffer().copy(acct, 8);
  acct.writeBigUInt64LE(BigInt(orderId), 40);
  acct[48] = 0; // SOL
  acct.writeBigUInt64LE(BigInt(amount), 49);
  acct[57] = 0;
  return { getAccountInfo: async () => ({ owner: pv.SETTLE_PROGRAM, data: acct }), getSlot: async () => 2000 } as never;
}

describe('settle leaf limit (находка 25)', () => {
  it('MAX_LEAVES_PER_TX is the contract value and is declared once', () => {
    const rust = readFileSync(new URL('../../programs/settle/src/lib.rs', import.meta.url), 'utf8');
    const m = /pub const MAX_SPECS: usize = (\d+);/.exec(rust)!;
    expect(Number(m[1])).toBe(MAX_LEAVES_PER_TX);
  });

  it('the shop really sells bundles above the contract limit', () => {
    const perSku = SKUS.map((id) => {
      const pack = PACKS[id];
      return {
        sku: id,
        chips: pack.chips,
        bundles: BUNDLES.map((b) => ({ qty: b.qty, leaves: leavesForPurchase(pack, b.qty) })),
        maxQty: maxQtyPerSettle(pack),
      };
    });
    // воспроизведение находки: standard ×5 = 25 листьев при лимите 10
    expect(perSku.find((p) => p.sku === 'standard')!.bundles.find((b) => b.qty === 5)!.leaves).toBe(25);
    expect(perSku.find((p) => p.sku === 'premium')!.bundles.find((b) => b.qty === 25)!.leaves).toBe(125);
    // и граница «сколько ещё можно купить одной инструкцией»
    for (const p of perSku) {
      expect(leavesForPurchase(PACKS[p.sku], p.maxQty)).toBeLessThanOrEqual(MAX_LEAVES_PER_TX);
      expect(leavesForPurchase(PACKS[p.sku], p.maxQty + 1)).toBeGreaterThan(MAX_LEAVES_PER_TX);
    }
    expect(maxQtyPerSettle(PACKS.standard)).toBe(2);
    expect(() => assertSettleableLeaves(25, 'Bundle x5')).toThrow(/at most 10/);
    expect(() => assertSettleableLeaves(MAX_LEAVES_PER_TX)).not.toThrow();
  });

  it('refuses an unsettleable order before signing and writes no specs', async () => {
    const db = new Db(':memory:');
    const oracle = Keypair.generate();
    const big = orders.createOrder(db, BUYER.publicKey.toBase58(), { sku: 1, qty: 5, currency: 'SOL' }, T0, { treasury: TREASURY, seedHex: 'cd'.repeat(32) });
    await expect(pv.settleAuthForOrder(db, BUYER.publicKey.toBase58(), big.orderId, { connection: escrowConn(big.orderId, big.amount), oracle }))
      .rejects.toThrow(/at most 10/);
    // ничего не подписано и не зафиксировано: заказ можно разобрать (возврат/частичный settle)
    expect(db.get<{ settle_specs: string | null; status: string }>(`SELECT settle_specs, status FROM pack_orders WHERE id = ?`, big.orderId))
      .toEqual({ settle_specs: null, status: 'created' });

    // граница проходит: ×2 = ровно 10 листьев
    const ok = orders.createOrder(db, BUYER.publicKey.toBase58(), { sku: 1, qty: 2, currency: 'SOL' }, T0, { treasury: TREASURY, seedHex: 'ce'.repeat(32) });
    const payload = await pv.settleAuthForOrder(db, BUYER.publicKey.toBase58(), ok.orderId, { connection: escrowConn(ok.orderId, ok.amount), oracle });
    expect(payload.specs).toHaveLength(MAX_LEAVES_PER_TX);
  });
});
