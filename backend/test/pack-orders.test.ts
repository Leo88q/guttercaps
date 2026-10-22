// Phase-G pack orders (docs/MINIMAL-LAUNCH-CHECKLIST.md §2): creation/commitment,
// payment confirmation via the preorder payment rule, deterministic commit-reveal
// rolls with floor + pity, and the public journal/verify recompute.
import { beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { Db } from '../src/db.ts';
import * as orders from '../src/pack-orders.ts';
import type { ParsedPaymentTx } from '../src/preorders.ts';

const TREASURY = Keypair.generate().publicKey.toBase58();
const WALLET = Keypair.generate().publicKey.toBase58();
const T0 = 1_800_000_000;

let db: Db;
beforeEach(() => { db = new Db(':memory:'); });

const mk = (sku = 1, qty = 1, currency = 'SOL') =>
  orders.createOrder(db, WALLET, { sku, qty, currency }, T0, { treasury: TREASURY, seedHex: 'ab'.repeat(32) });

describe('order creation (§2.1, §2.3)', () => {
  it('prices like the program quote and commits the seed hash before payment', () => {
    const o = mk();
    expect(o.amount).toBe('54454545'); // $5.99 at frozen SOL $110 → floor(599*1e6/11)
    expect(o.memo).toBe(`GC-ORD|${o.orderId}`);
    expect(o.seedHash).toBe(orders.sha256Hex('ab'.repeat(32)));
    const view = orders.getOrder(db, WALLET, o.orderId, T0);
    expect(view.status).toBe('created');
    expect(view.seed).toBeNull(); // never revealed pre-mint
  });

  it('rejects SKR, double starter, and daily-cap overflow', () => {
    expect(() => mk(1, 1, 'SKR')).toThrow(/SOL \| USDC \| CG/);
    mk(0, 1);
    expect(() => mk(0, 1)).toThrow(/one per wallet/);
    mk(3, 5);
    expect(() => mk(3, 1)).toThrow(/At most 5 per day/);
  });

  it('expires unpaid orders', () => {
    const o = mk();
    const later = T0 + 1801;
    expect(orders.getOrder(db, WALLET, o.orderId, later).status).toBe('expired');
  });
});

const payTx = (o: { payTo: string; amount: string; orderId: number }, overrides: Partial<ParsedPaymentTx> = {}): ParsedPaymentTx => ({
  ok: true,
  transfers: [{ source: WALLET, destination: o.payTo, lamports: BigInt(o.amount) }],
  memos: [`GC-ORD|${o.orderId}`],
  ...overrides,
});

describe('payment confirmation (§2.2)', () => {
  it('exact payment with memo marks paid; re-confirm is idempotent', async () => {
    const o = mk();
    const fetcher = async () => payTx(o);
    const v = await orders.confirmOrder(db, WALLET, o.orderId, 'sig'.padEnd(40, 'x'), fetcher, T0);
    expect(v.status).toBe('paid');
    const again = await orders.confirmOrder(db, WALLET, o.orderId, 'sig'.padEnd(40, 'x'), fetcher, T0);
    expect(again.status).toBe('paid');
  });

  it('rejects underpayment, wrong memo, foreign wallet, reused signature', async () => {
    const o = mk();
    await expect(orders.confirmOrder(db, WALLET, o.orderId, 's1'.padEnd(40, 'x'), async () => payTx(o, {
      transfers: [{ source: WALLET, destination: o.payTo, lamports: BigInt(o.amount) - 1n }],
    }), T0)).rejects.toThrow(/Payment check failed: amount_low/);
    await expect(orders.confirmOrder(db, WALLET, o.orderId, 's2'.padEnd(40, 'x'), async () => payTx(o, { memos: ['GC-ORD|999'] }), T0)).rejects.toThrow(/Payment check failed: memo_mismatch/);
    await expect(orders.confirmOrder(db, Keypair.generate().publicKey.toBase58(), o.orderId, 's3'.padEnd(40, 'x'), async () => payTx(o), T0)).rejects.toThrow(/another wallet/);
    await orders.confirmOrder(db, WALLET, o.orderId, 's4'.padEnd(40, 'x'), async () => payTx(o), T0);
    const o2 = mk();
    await expect(orders.confirmOrder(db, WALLET, o2.orderId, 's4'.padEnd(40, 'x'), async () => payTx(o2), T0)).rejects.toThrow(/already credited/);
  });
});

describe('rolls: determinism, floor, pity (§2.3)', () => {
  it('same seed → same roll; last chip of each pack respects the floor', () => {
    const a = orders.rollPack('ab'.repeat(32), 7, 1, 3, 0);
    const b = orders.rollPack('ab'.repeat(32), 7, 1, 3, 0);
    expect(a).toEqual(b);
    expect(a.rarities).toHaveLength(15);
    for (let p = 0; p < 3; p++) expect(a.rarities[(p + 1) * 5 - 1]).toBeGreaterThanOrEqual(1); // standard floor = Uncommon idx1
  });

  it('hard pity forces the tier chip at hardAt', () => {
    // standard: pity tier 5, hardAt 60 → the 60th dry pack must contain rarity 5
    const r = orders.rollPack('cd'.repeat(32), 9, 1, 1, 59);
    expect(Math.max(...r.rarities)).toBeGreaterThanOrEqual(5);
    expect(r.pityAfter).toBe(0);
  });

  it('distribution roughly matches published odds (standard pack)', () => {
    const counts = new Array(9).fill(0);
    const N = 4_000;
    for (let i = 0; i < N; i++) {
      const r = orders.rollPack('ef'.repeat(32), 1000 + i, 1, 1, 0);
      // exclude the floored last chip: sample slot 0 only
      counts[r.rarities[0]]++;
    }
    expect(counts[0] / N).toBeGreaterThan(0.38);
    expect(counts[0] / N).toBeLessThan(0.46); // Common 42%
    expect(counts[5] / N).toBeGreaterThan(0.015);
    expect(counts[5] / N).toBeLessThan(0.05); // Epic+ 3%
  });
});

describe('journal + verify (§3.3)', () => {
  it('verify recomputes the roll from the revealed seed; journal exposes it', () => {
    const o = mk(1, 2);
    // simulate the mint crank output
    const roll = orders.rollPack('ab'.repeat(32), o.orderId, 1, 2, 0);
    const assets = roll.rarities.map((rarity, i) => ({
      assetId: `asset${i}`, collectionIdx: roll.collections[i], rarity, gameIndex: i + 1,
    }));
    db.run(`UPDATE pack_orders SET status='minted', assets=?, minted_at=? WHERE id=?`, JSON.stringify(assets), T0, o.orderId);
    const v = orders.verifyOrder(db, o.orderId);
    expect(v?.matches).toBe(true);
    const journal = orders.mintJournal(db);
    expect(journal).toHaveLength(1);
    expect(journal[0].seed).toBe('ab'.repeat(32));
    // tampered asset must fail verification
    assets[0].rarity = 8;
    db.run(`UPDATE pack_orders SET assets=? WHERE id=?`, JSON.stringify(assets), o.orderId);
    expect(orders.verifyOrder(db, o.orderId)?.matches).toBe(false);
  });
});

describe('audit fixes: featured pool, CG discount, expired revival', () => {
  it('Limited rolls only the featured collection', () => {
    const r = orders.rollPack('ab'.repeat(32), 5, 3, 2, 0, 6);
    expect(new Set(r.collections)).toEqual(new Set([6]));
    // featured snapshot defaults to 0
    const r0 = orders.rollPack('ab'.repeat(32), 5, 3, 1, 0);
    expect(new Set(r0.collections)).toEqual(new Set([0]));
  });

  it('$CG price carries the bundle discount like the program quote', () => {
    process.env.CG_MINT = 'So11111111111111111111111111111111111111112';
    const single = orders.createOrder(db, WALLET, { sku: 1, qty: 1, currency: 'CG' }, T0, { treasury: TREASURY, seedHex: 'ab'.repeat(32) });
    const bundle = orders.createOrder(db, WALLET, { sku: 1, qty: 5, currency: 'CG' }, T0, { treasury: TREASURY, seedHex: 'ab'.repeat(32) });
    // standard $CG list 2_700_000_000 per pack; x5 bundle gets the BUNDLES discount (>0)
    expect(BigInt(bundle.amount)).toBeLessThan(2_700_000_000n * 5n);
    expect(BigInt(single.amount)).toBe(2_700_000_000n);
    delete process.env.CG_MINT;
  });

  it('a real payment revives an expired order instead of stranding the money', async () => {
    const o = mk();
    // let the TTL lapse, then pay with a valid in-window payment proof
    const v = await orders.confirmOrder(db, WALLET, o.orderId, 'sig'.padEnd(40, 'y'), async () => payTx(o), T0 + 7200);
    expect(v.status).toBe('paid');
  });
});
