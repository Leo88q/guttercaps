// Reproducer: the Phase-G mint crank tracks the tree's leaf index locally and never re-reads it
// after a mint that landed but reported failure (backend/src/bubblegum-mint.ts:162-210, esp. 168,
// 175-205), so the *next* order in the same tick is registered against a leaf that already belongs
// to somebody else.
//
// `processPaidOrders` reads `firstLeafIndex()` once per tick (line 168) and increments a local `leaf`
// only on the success path (line 195). `sendAndConfirmTransaction` can throw after the transaction
// landed — a confirm timeout, an RPC 5xx on the confirm poll, the process going away and coming back
// on the next loop iteration (the same window as п. 61) — and the chip is then neither in
// `pack_orders.assets` nor in `chips`, while the chain has consumed the leaf.
//
// The order that follows in the same tick still uses the stale `leaf`, so the `chips` row it writes
// (`upsert ... ON CONFLICT(asset) DO UPDATE SET owner = excluded.owner`, lines 190-193) names the leaf
// that the failed chip occupies. The backend then believes wallet B owns leaf N and wallet A does not,
// while the tree says the opposite: market, staking, fusion and DAS verification all read `chips`.
import { describe, expect, it } from 'vitest';
import { Db } from '../src/db.ts';
import * as mint from '../src/bubblegum-mint.ts';
import { deriveBubblegumLeafAssetId } from '../src/das.ts';
import * as orders from '../src/pack-orders.ts';
import { PublicKey } from '@solana/web3.js';

const TREE = new PublicKey('9xS7fT8eZQ2mZ5b1oQZfQ2W7fF7f9y9y9y9y9y9y9y9y');

describe('phase-g mint crank leaf accounting', () => {
  it('a landed-but-errored mint desynchronises every later order in the same tick', async () => {
    const db = new Db(':memory:');
    const treasury = PublicKey.unique().toBase58();
    const walletA = PublicKey.unique().toBase58();
    const walletB = PublicKey.unique().toBase58();

    const a = orders.createOrder(db, walletA, { sku: 1, qty: 2, currency: 'SOL' }, 1_800_000_000, { treasury, seedHex: 'aa'.repeat(32) });
    const b = orders.createOrder(db, walletB, { sku: 1, qty: 1, currency: 'SOL' }, 1_800_000_100, { treasury, seedHex: 'bb'.repeat(32) });
    db.run(`UPDATE pack_orders SET status='paid', tx_sig='sigA' WHERE id=?`, a.orderId);
    db.run(`UPDATE pack_orders SET status='paid', tx_sig='sigB' WHERE id=?`, b.orderId);

    // The chain: every landed mint consumes one leaf. The second mint of order A lands and then the
    // sender throws (confirm timeout) — exactly the window in which the transaction is on chain.
    let chainMinted = 100;
    const landed: { leaf: number; assetId: string; wallet: string }[] = [];
    const sendMint: mint.MintSender = async (order, chip) => {
      const leaf = chainMinted++;
      landed.push({ leaf, assetId: chip.assetId, wallet: order.wallet });
      if (landed.length === 2) throw new Error('confirm timed out — transaction confirmed anyway');
    };
    const deps = { sendMint, firstLeafIndex: async () => chainMinted, tree: TREE };

    const r = await mint.processPaidOrders(db, deps);

    const chips = db.all<{ asset: string; owner: string }>(`SELECT asset, owner FROM chips ORDER BY rowid`);
    const assetOf = (leaf: number) => deriveBubblegumLeafAssetId(TREE, leaf).toBase58();

    // A standard pack is five chips: order A lands leaf 100 (registered), leaf 101 (landed, then the
    // sender threw, so it is registered nowhere), and the tick moves on to order B.
    expect(landed.map((l) => l.leaf)).toEqual([100, 101, 102, 103, 104, 105, 106]);
    expect(landed.slice(0, 2).every((l) => l.wallet === walletA)).toBe(true);
    expect(landed.slice(2).every((l) => l.wallet === walletB)).toBe(true);

    // The chain gave leaf 101 to wallet A's second chip...
    expect(landed[1].assetId).toBe(assetOf(101));
    // ...and the backend gave the same leaf to order B's first chip.
    const rowsB = chips.filter((c) => c.owner === walletB);
    expect(rowsB).toHaveLength(5);
    expect(rowsB[0].asset).toBe(assetOf(101));
    // The leaf wallet B actually owns on chain (106) is registered to nobody.
    expect(chips.some((c) => c.asset === assetOf(106))).toBe(false);
    // Wallet A's landed chip (leaf 101) is missing from the projection: it cannot be sold or staked.
    expect(chips.filter((c) => c.owner === walletA)).toHaveLength(1);

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      chainLeaf101BelongsTo: landed[1].wallet === walletA ? 'walletA' : '?',
      dbLeaf101BelongsTo: rowsB[0].owner === walletB ? 'walletB' : '?',
      dbRowsForWalletA: chips.filter((c) => c.owner === walletA).length,
      leaf106Registered: chips.some((c) => c.asset === assetOf(106)),
      mintedOrders: r.mintedOrders,
    }));

    db.raw.close();
  });
});
