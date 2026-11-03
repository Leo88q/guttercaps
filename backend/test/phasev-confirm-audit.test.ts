// Регрессия находки 9: подтверждение Phase-V не регистрировало чипы, а DAS читался одной страницей.
//
// (а) `confirmSettle` обновлял `settle_sig` в БД, но продолжал смотреть на строку в памяти, где
//     `settle_sig` ещё пустой: первое подтверждение уходило в ранний возврат «ещё индексируется» и
//     НЕ создавало строк `chips`. Регистрацию делал только повторный вызов или кранк — игрок видел
//     открытый заказ после успешного минта.
// (б) `registerSettledChips` читал только первую страницу `getAssetsByOwner` (до 1000 ассетов):
//     владелец большой коллекции не находил свои же чипы, и заказ оставался открытым навсегда.
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import { Db } from '../src/db.ts';
import { anchorDiscriminator } from '../src/assert-executed.ts';
import { confirmSettle, orderPda, registerSettledChips, SETTLE_PROGRAM } from '../src/phasev.ts';
import * as orders from '../src/pack-orders.ts';

const COLLECTION = Keypair.generate().publicKey;

/** DAS, отдающий заданное число страниц. */
function pagedDas(pages: { assetId: PublicKey; name: string; collection?: PublicKey }[][]) {
  const asked: number[] = [];
  return {
    asked,
    async getAssetsByOwner(_owner: string, page: number = 1) {
      asked.push(page);
      const items = pages[page - 1] ?? [];
      return { total: pages.flat().length, items: items.map((a) => ({ ...a, compressed: true })) };
    },
  } as unknown as Parameters<typeof registerSettledChips>[2] & { asked: number[] };
}

const spec = (name: string) => ({ name, collectionIdx: 1, rarity: 2, gameIndex: 5, collection: COLLECTION.toBase58() });

describe('находка 9б: поиск ассетов идёт по страницам', () => {
  it('finds the chip on a later page instead of giving up after the first 1000', async () => {
    const filler = Array.from({ length: 1000 }, () => ({ assetId: Keypair.generate().publicKey, name: 'other' }));
    const real = { assetId: Keypair.generate().publicKey, name: 'GUTTERCAP #5', collection: COLLECTION };
    const das = pagedDas([filler, [real]]);
    const db = new Db(':memory:');
    const found = await registerSettledChips(db, { wallet: Keypair.generate().publicKey.toBase58(), specs: [spec('GUTTERCAP #5')], origin: 'pack', originSig: 'sig' }, das);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ finding: 9, pagesAsked: das.asked, found: found.length }));
    expect(das.asked).toEqual([1, 2]);
    expect(found.map((f) => f.assetId)).toEqual([real.assetId.toBase58()]);
  });

  it('stops asking once everything is found', async () => {
    const real = { assetId: Keypair.generate().publicKey, name: 'GUTTERCAP #5', collection: COLLECTION };
    const das = pagedDas([[real], [real], [real]]);
    await registerSettledChips(new Db(':memory:'), { wallet: Keypair.generate().publicKey.toBase58(), specs: [spec('GUTTERCAP #5')], origin: 'pack', originSig: 'sig' }, das);
    expect(das.asked).toEqual([1]);
  });

  it('is bounded: a DAS that never returns the chip cannot loop forever', async () => {
    const das = pagedDas(Array.from({ length: 50 }, () => [{ assetId: Keypair.generate().publicKey, name: 'other' }]));
    const db = new Db(':memory:');
    const found = await registerSettledChips(db, { wallet: Keypair.generate().publicKey.toBase58(), specs: [spec('GUTTERCAP #5')], origin: 'pack', originSig: 'sig', maxPages: 3 }, das);
    expect(found).toEqual([]);
    expect(das.asked).toEqual([1, 2, 3]);
  });
});

/** RPC с исполненной `settle_pack` для конкретного order PDA. */
function settleConn(orderPdaKey: PublicKey): Connection {
  const keys = [orderPdaKey, SETTLE_PROGRAM];
  return {
    async getTransaction() {
      return {
        slot: 1,
        meta: { err: null, innerInstructions: [] },
        transaction: { message: {
          getAccountKeys: () => ({ get: (i: number) => keys[i], staticAccountKeys: keys }),
          compiledInstructions: [{ programIdIndex: 1, accountKeyIndexes: [0], data: anchorDiscriminator('settle_pack') }],
        } },
      };
    },
  } as unknown as Connection;
}

describe('находка 9а: первое подтверждение само регистрирует чипы', () => {
  it('registers chips in the same call that records settle_sig', async () => {
    const db = new Db(':memory:');
    const wallet = Keypair.generate().publicKey.toBase58();
    const o = orders.createOrder(db, wallet, { sku: 0, qty: 1, currency: 'SOL' }, 1_800_000_000, {
      treasury: Keypair.generate().publicKey.toBase58(), seedHex: 'dd'.repeat(32),
    });
    // заказ уже оплачен, спеки выпущены (settle-auth отработал), минт прошёл — в DAS появился чип
    const stored = [{ collection: COLLECTION.toBase58(), name: 'GUTTERCAP #1', symbol: 'GUTTERCAP', uri: 'u', collectionIdx: 1, rarity: 2, gameIndex: 1 }];
    db.run(`UPDATE pack_orders SET status = 'paid', settle_specs = ? WHERE id = ?`, JSON.stringify(stored), o.orderId);
    const real = { assetId: Keypair.generate().publicKey, name: stored[0]!.name, collection: COLLECTION };
    const das = pagedDas([[real]]);

    const view = await confirmSettle(db, wallet, o.orderId, 'S'.repeat(44), {
      connection: settleConn(orderPda(new PublicKey(wallet), BigInt(o.orderId))),
      das,
    }, 1_800_000_100);

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      finding: 9, status: view.status, chips: db.all(`SELECT asset, origin FROM chips`),
      settleSig: db.get<{ settle_sig: string }>(`SELECT settle_sig FROM pack_orders WHERE id = ?`, o.orderId)?.settle_sig,
    }));
    // один вызов: подпись записана И строка `chips` создана (раньше второе требовало повтора/кранка)
    expect(view.status).toBe('minted');
    expect(db.get<{ settle_sig: string }>(`SELECT settle_sig FROM pack_orders WHERE id = ?`, o.orderId)?.settle_sig).toBe('S'.repeat(44));
    expect(db.get<{ asset: string }>(`SELECT asset FROM chips`)?.asset).toBe(real.assetId.toBase58());
  });
});
