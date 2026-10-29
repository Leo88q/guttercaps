import { describe, expect, it } from 'vitest';
import { Keypair, SystemProgram } from '@solana/web3.js';
import { associatedTokenAddress, buildPaymentInstructions, createAtaIdempotentIx, memoInstruction, SPL_MEMO_PROGRAM, TOKEN_PROGRAM, tokenTransferIx, waitForOrderMinted, type PackOrder } from './phaseG';

const TREASURY = Keypair.generate().publicKey.toBase58();
const USDC = Keypair.generate().publicKey.toBase58();

describe('phase-G payment instructions', () => {
  it('SOL: transfer to treasury + memo GC-ORD|id', () => {
    const buyer = Keypair.generate().publicKey;
    const ixs = buildPaymentInstructions({
      orderId: 7, memo: 'GC-ORD|7', payTo: TREASURY, payToOwner: TREASURY, mint: null,
      amount: '54454545', currency: 'SOL', seedHash: 'x', expiresAt: 0,
    }, buyer);
    expect(ixs).toHaveLength(2);
    expect(ixs[0].programId.equals(SystemProgram.programId)).toBe(true);
    expect(ixs[1].programId.equals(SPL_MEMO_PROGRAM)).toBe(true);
    expect(ixs[1].data.toString()).toBe('GC-ORD|7');
  });

  it('USDC: idempotent treasury ATA + token transfer + memo', () => {
    const buyer = Keypair.generate().publicKey;
    const ata = Keypair.generate().publicKey.toBase58();
    const ixs = buildPaymentInstructions({
      orderId: 9, memo: 'GC-ORD|9', payTo: ata, payToOwner: TREASURY, mint: USDC,
      amount: '5990000', currency: 'USDC', seedHash: 'x', expiresAt: 0,
    }, buyer);
    expect(ixs).toHaveLength(3);
    expect(ixs[1].programId.equals(TOKEN_PROGRAM)).toBe(true);
    expect(ixs[1].data).toEqual(Buffer.concat([Buffer.of(3), (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(5990000n); return b; })()]));
    expect(ixs[2].data.toString()).toBe('GC-ORD|9');
  });

  it('ATA derivation + idempotent create layout', () => {
    const owner = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const a1 = associatedTokenAddress(mint, owner);
    expect(a1.equals(associatedTokenAddress(mint, owner))).toBe(true);
    const ix = createAtaIdempotentIx(owner, a1, owner, mint);
    expect(ix.data).toEqual(Buffer.of(1));
    expect(ix.keys[1].pubkey.equals(a1)).toBe(true);
    const tr = tokenTransferIx(a1, a1, owner, 5n);
    expect(tr.data.readBigUInt64LE(1)).toBe(5n);
  });

  it('memo instruction is unsigned plain utf8', () => {
    const ix = memoInstruction('GCF|3');
    expect(ix.keys).toHaveLength(0);
    expect(ix.data.toString()).toBe('GCF|3');
  });
});

describe('waitForOrderMinted', () => {
  const order = (status: string): PackOrder => ({ orderId: 1, status } as PackOrder);
  it('polls until minted', async () => {
    const seq = ['paid', 'paid', 'minted'];
    let i = 0;
    const out = await waitForOrderMinted(async () => order(seq[Math.min(i++, seq.length - 1)]), { sleep: async () => {}, tries: 10 });
    expect(out.status).toBe('minted');
    expect(i).toBe(3);
  });
  it('stops on expired and never loops forever', async () => {
    const out = await waitForOrderMinted(async () => order('expired'), { sleep: async () => {}, tries: 5 });
    expect(out.status).toBe('expired');
    const stuck = await waitForOrderMinted(async () => order('paid'), { sleep: async () => {}, tries: 3 });
    expect(stuck.status).toBe('paid');
  });
});
