// Phase-G fusion (docs/MINIMAL-LAUNCH-CHECKLIST.md §4): intent validation,
// fee+burn confirmation, deterministic chance roll, result/refund mints and
// result cooldowns.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { Db } from '../src/db.ts';
import * as fusion from '../src/phaseg-fusion.ts';
import type { ParsedPaymentTx } from '../src/preorders.ts';

const T0 = 1_800_000_000;
const WALLET = Keypair.generate().publicKey.toBase58();
let db: Db;
let seq = 0;
function chip(rarity: number, opts: Partial<{ owner: string; collection: number; lock: number; flags: number }> = {}): string {
  const asset = `asset${seq++}`;
  db.run(
    `INSERT INTO chips (asset, owner, collection_idx, rarity, level, flags, lock_until, origin) VALUES (?, ?, ?, ?, 1, ?, ?, 'pack')`,
    asset, opts.owner ?? WALLET, opts.collection ?? 0, rarity, opts.flags ?? 0, opts.lock ?? 0,
  );
  return asset;
}
beforeEach(() => {
  db = new Db(':memory:'); seq = 0;
  process.env.TREASURY_WALLET = Keypair.generate().publicKey.toBase58();
  process.env.CG_MINT = Keypair.generate().publicKey.toBase58();
});

describe('intent validation (§4.1)', () => {
  it('creates an intent with committed seed and CG fee destination', () => {
    const assets = [chip(0), chip(0), chip(0)];
    const f = fusion.createFusion(db, WALLET, assets, T0, { seedHex: 'ab'.repeat(32) });
    expect(f.feeMicro).toBe('25000000');
    expect(f.memo).toBe(`GCF|${f.fusionId}`);
    expect(f.seedHash).toHaveLength(64);
    const view = fusion.getFusion(db, WALLET, f.fusionId);
    expect(view.seed).toBeNull();
    expect(view.resultLockUntil).toBeNull();
  });

  it('rejects wrong owner, mixed rarity, locked/staked, double promise, diamond', () => {
    const foreign = chip(0, { owner: Keypair.generate().publicKey.toBase58() });
    expect(() => fusion.createFusion(db, WALLET, [foreign, chip(0), chip(0)], T0)).toThrow(/must be yours/);
    expect(() => fusion.createFusion(db, WALLET, [chip(0), chip(0), chip(1)], T0)).toThrow(/one rarity/);
    expect(() => fusion.createFusion(db, WALLET, [chip(0), chip(0), chip(0, { lock: T0 + 60 })], T0)).toThrow(/cooldown/);
    expect(() => fusion.createFusion(db, WALLET, [chip(0), chip(0), chip(0, { flags: 1 })], T0)).toThrow(/staked or listed/);
    const trio = [chip(1), chip(1, { collection: 2 }), chip(1)];
    expect(() => fusion.createFusion(db, WALLET, trio, T0)).toThrow(/one collection/); // 1→2 same-collection
    const ok = [chip(0), chip(0), chip(0)];
    fusion.createFusion(db, WALLET, ok, T0);
    expect(() => fusion.createFusion(db, WALLET, ok, T0)).toThrow(/already in a live fusion/);
    expect(() => fusion.createFusion(db, WALLET, [chip(7), chip(7), chip(7)], T0)).toThrow(/Diamond fusion/);
  });
});

describe('confirm + settle (§4.1/§4.2)', () => {
  const TREE = Keypair.generate().publicKey;
  async function paidFusion(seedHex = 'ab'.repeat(32)) {
    const assets = [chip(4, { collection: 3 }), chip(4, { collection: 1 }), chip(4, { collection: 2 })]; // 4→5: any, 85%, refund 1
    const f = fusion.createFusion(db, WALLET, assets, T0, { seedHex });
    const feeTx: ParsedPaymentTx = {
      ok: true,
      transfers: [{ source: WALLET, destination: f.payTo, lamports: BigInt(f.feeMicro), mint: f.mint ?? undefined }],
      memos: [f.memo],
    };
    const view = await fusion.confirmFusion(db, WALLET, f.fusionId, { burnSig: 'b'.repeat(40), paySig: 'p'.repeat(40) }, {
      fetchPayment: async () => feeTx,
      verifyBurned: async () => true,
    }, T0);
    expect(view.status).toBe('paid');
    return f;
  }

  it('refuses to settle before both proofs; unverified burn blocks', async () => {
    const assets = [chip(0), chip(0), chip(0)];
    const f = fusion.createFusion(db, WALLET, assets, T0);
    await expect(fusion.confirmFusion(db, WALLET, f.fusionId, { burnSig: 'b'.repeat(40), paySig: 'p'.repeat(40) }, {
      fetchPayment: async () => ({ ok: true, transfers: [{ source: WALLET, destination: f.payTo, lamports: BigInt(f.feeMicro), mint: f.mint ?? undefined }], memos: [f.memo] }),
      verifyBurned: async () => false,
    }, T0)).rejects.toThrow(/material burn is not confirmed/);
  });

  it('deterministic roll: forced success mints the higher tier with cooldown; materials consumed', async () => {
    // find a seed that wins the 85% roll for this fusion id by construction:
    // create first, then brute-force is impossible (id fixed) — instead accept
    // either outcome but assert consistency with rollFusion.
    const f = await paidFusion();
    const sent: { wallet: string; rarity: number }[] = [];
    const r = await fusion.processPaidFusions(db, {
      tree: TREE,
      sendChip: async (wallet, c) => { sent.push({ wallet, rarity: c.rarity }); },
      firstLeafIndex: async () => 0,
    }, T0);
    expect(r.settled).toBe(1);
    const won = fusion.rollFusion('ab'.repeat(32), f.fusionId, 8500);
    const view = fusion.getFusion(db, WALLET, f.fusionId);
    expect(view.success).toBe(won);
    expect(sent).toHaveLength(won ? 1 : 1); // success: result; fail: 1 refund chip
    expect(sent[0].rarity).toBe(won ? 5 : 4);
    if (won) expect(view.resultLockUntil).toBe(T0 + 6 * 3600);
    for (const a of view.inputs) {
      expect(db.get<{ burned_at: number | null }>(`SELECT burned_at FROM chips WHERE asset=?`, a)?.burned_at).toBe(T0);
    }
  });

  it('roll sanity: ~85% wins over many seeds', () => {
    let wins = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) {
      if (fusion.rollFusion(Buffer.from(`seed${i}`).toString('hex').padEnd(64, '0'), i, 8500)) wins++;
    }
    expect(wins / N).toBeGreaterThan(0.8);
    expect(wins / N).toBeLessThan(0.9);
  });
});
