import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import { ata, emissionPda } from '../pdas';
import { stakeCgIx, stakeCgIxs } from './staking';
import { fitsInTx } from '../tx';

const pk = () => Keypair.generate().publicKey;
describe('CG stake first-use accounts', () => {
  it.each([0, 1, 2, 3])('prepares both canonical ATAs atomically for tier %s', tier => {
    const owner = pk(), cgMint = pk(), amount = 1_000_000_000n;
    const args = { owner, cgMint, tier, amount };
    const [emission] = emissionPda();
    const ixs = stakeCgIxs(args);
    expect(ixs).toHaveLength(3);
    for (const [index, authority] of [owner, emission].entries()) {
      // Compare our byte-level builder with the SPL SDK (includes PDA/off-curve derivation).
      expect(ixs[index]).toEqual(createAssociatedTokenAccountIdempotentInstruction(owner, ata(cgMint, authority), authority, cgMint));
      expect(ixs[index].keys.filter(k => k.isSigner).map(k => k.pubkey)).toEqual([owner]);
    }
    expect(PublicKey.isOnCurve(emission.toBytes())).toBe(false);
    expect(ixs[2]).toEqual(stakeCgIx(args)); // unchanged amount, pool, tier and program
    expect(ixs[2].keys[5].pubkey).toEqual(ixs[0].keys[1].pubkey);
    expect(ixs[2].keys[6].pubkey).toEqual(ixs[1].keys[1].pubkey);
    expect(ixs[2].data.readBigUInt64LE(9)).toBe(amount);
    expect(fitsInTx(owner, ixs)).toBe(true); // includes both compute-budget instructions
  });
});
