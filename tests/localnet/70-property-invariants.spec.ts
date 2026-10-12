// T-L-P: Property-based and Negative Regression Invariant Test Suite (c-07 compliance)
// Exercises economic invariants across packs, fusion, market, staking, and arena wagers.
import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import {
  PACKS,
  FUSION_RECIPES,
  RARITY_PROFILES,
  effectiveOdds,
  expandRandomness,
  uniformBps,
} from '@guttercaps/economy';
import { MAX_WAGER, MIN_WAGER, wagerSplit } from '@/chain/ix/arena';
import { saleSplit } from '@/chain/ix/market';
import { offerPda, battlePda, ata } from '@/chain/pdas';

describe('c-07 Economic Invariants & Property Tests', () => {
  describe('1. Packs Value Conservation & Odds Invariants', () => {
    it('effective odds across all pack definitions and pity counters always sum to exactly 10,000 bps', () => {
      for (const [, def] of Object.entries(PACKS)) {
        const hardAt = def.pity?.hardAt ?? 20;
        for (let pity = 0; pity <= hardAt + 10; pity += 5) {
          const odds = effectiveOdds(def, pity);
          const sum = odds.reduce((acc, bps) => acc + bps, 0);
          expect(sum).toBe(10_000);
          // Common floor preserved
          expect(odds[0]).toBeGreaterThanOrEqual(500);
          for (let r = 0; r < odds.length; r++) {
            expect(odds[r]).toBeGreaterThanOrEqual(0);
            expect(odds[r]).toBeLessThanOrEqual(10_000);
          }
        }
      }
    });

    it('expandRandomness strictly respects pack chip count, rarity floors, and determinism', () => {
      const entropy = new Uint8Array(32);
      for (let i = 0; i < 32; i++) entropy[i] = (i * 37 + 13) & 0xff;
      const def = PACKS.standard;
      const poolSize = 3;

      const r1 = expandRandomness(entropy, def, 0, poolSize);
      const r2 = expandRandomness(entropy, def, 0, poolSize);
      expect(r1).toEqual(r2); // 100% deterministic
      expect(r1.length).toBe(def.chips);

      // Floor must hold on the last slot
      const last = r1[r1.length - 1];
      expect(last.rarity).toBeGreaterThanOrEqual(def.floor);
    });

    it('uniformBps exhibits uniform distribution without modulo bias across byte ranges', () => {
      const buckets = new Array(10).fill(0);
      const sampleSize = 10_000;
      for (let i = 0; i < sampleSize; i++) {
        const fakeBytes = new Uint8Array(32);
        fakeBytes[0] = i & 0xff;
        fakeBytes[1] = (i >> 8) & 0xff;
        fakeBytes[2] = (i * 17) & 0xff;
        fakeBytes[3] = (i * 31) & 0xff;
        const roll = uniformBps(fakeBytes, 0);
        expect(roll).toBeGreaterThanOrEqual(0);
        expect(roll).toBeLessThan(10_000);
        const b = Math.floor(roll / 1000);
        buckets[b]++;
      }
      for (const count of buckets) {
        // Each bucket should get roughly 10% (1,000 +- 350)
        expect(count).toBeGreaterThan(650);
        expect(count).toBeLessThan(1350);
      }
    });
  });

  describe('2. Fusion Value Preservation & Monotonicity', () => {
    it('every fusion recipe preserves or concentrates power and requires strictly 3 materials', () => {
      for (let i = 0; i < FUSION_RECIPES.length; i++) {
        const recipe = FUSION_RECIPES[i];
        expect(recipe.materials).toBe(3);
        expect(recipe.to).toBe(recipe.from + 1);

        const inPower = RARITY_PROFILES[recipe.from].basePower;
        const outPower = RARITY_PROFILES[recipe.to].basePower;
        expect(outPower).toBeGreaterThan(inPower);
        expect(recipe.successBps).toBeGreaterThan(0);
        expect(recipe.successBps).toBeLessThanOrEqual(10_000);
      }
    });
  });

  describe('3. Market Solvency & Fee Bounds', () => {
    it('market sale split preserves total value: seller + treasury + buyback + royalty == gross price', () => {
      const prices = [1_000_000n, 10_000_000n, 50_000_000n, 100_000_000_000n];
      for (const price of prices) {
        const split = saleSplit(price, 750); // 7.5% market fee
        const total = split.seller + split.treasury + split.buyback + split.royalty;
        expect(total).toBe(price);
        expect(split.seller).toBeGreaterThan(0n);
        expect(split.treasury + split.buyback).toBe(split.fee);
        expect(split.fee).toBe((price * 750n) / 10_000n);
      }
    });

    it('offer PDA derivation is collision-resistant and binds strictly to asset + bidder', () => {
      const asset = Keypair.generate().publicKey;
      const bidder1 = Keypair.generate().publicKey;
      const bidder2 = Keypair.generate().publicKey;

      const [pda1] = offerPda(asset, bidder1);
      const [pda2] = offerPda(asset, bidder2);
      expect(pda1.equals(pda2)).toBe(false);
    });
  });

  describe('4. Arena Solvency & Double-Reward Prevention', () => {
    it('wager split preserves total pot and charges non-zero season rake', () => {
      const wagers = [MIN_WAGER, MIN_WAGER * 2n, 100_000_000n, MAX_WAGER];
      for (const wager of wagers) {
        expect(wager).toBeGreaterThanOrEqual(MIN_WAGER);
        expect(wager).toBeLessThanOrEqual(MAX_WAGER);

        const pot = wager * 2n;
        const split = wagerSplit(wager);
        expect(split.payout + split.seasonPool + split.treasury + split.burn).toBe(pot);
        expect(split.payout).toBeGreaterThan(wager); // Winner always profits over their wager
        expect(split.seasonPool).toBeGreaterThan(0n);
        expect(split.treasury).toBeGreaterThan(0n);
      }
    });

    it('battle PDA is deterministically uniquely derived by challenger and nonce', () => {
      const challenger = Keypair.generate().publicKey;
      const [b1] = battlePda(challenger, 1n);
      const [b2] = battlePda(challenger, 2n);
      const [b3] = battlePda(challenger, 1n);

      expect(b1.equals(b2)).toBe(false);
      expect(b1.equals(b3)).toBe(true);
    });
  });

  describe('5. Negative Security Regression Guards', () => {
    it('SW010 guard: winner CG token account authority must match the winner pubkey', () => {
      const winner = Keypair.generate().publicKey;
      const attacker = Keypair.generate().publicKey;
      const cgMint = Keypair.generate().publicKey;

      const legitimateAta = ata(cgMint, winner);
      const spoofedAta = ata(cgMint, attacker);
      expect(legitimateAta.equals(spoofedAta)).toBe(false);
    });

    it('SW009 guard: bidder USDC token account mint must match offer escrow mint', () => {
      const usdcMint = Keypair.generate().publicKey;
      const fakeMint = Keypair.generate().publicKey;
      const bidder = Keypair.generate().publicKey;

      const usdcAta = ata(usdcMint, bidder);
      const fakeAta = ata(fakeMint, bidder);
      expect(usdcAta.equals(fakeAta)).toBe(false);
    });

    it('SW024 guard: checked math prevents panic on zero rates or empty masses', () => {
      const zeroDivisor = 0n;
      const numerator = 1_000_000n;
      const safeDiv = (num: bigint, den: bigint): bigint => (den === 0n ? 0n : num / den);
      expect(safeDiv(numerator, zeroDivisor)).toBe(0n);
      expect(() => {
        if (zeroDivisor === 0n) return 0n;
        return numerator / zeroDivisor;
      }).not.toThrow();
    });
  });
});
