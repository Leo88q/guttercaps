import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { buyPackIx, grantMintIx, oracleAuthIx, settlePackIx, orderPda, type SettlePayloadLike } from './phaseV';
import { base58Encode } from '@/shared/lib/base58';
import { base58Decode } from '@/shared/lib/base58Decode';

const buyer = Keypair.generate().publicKey;
const oracle = Keypair.generate().publicKey;
const tree = Keypair.generate().publicKey;

function payload(): SettlePayloadLike {
  return {
    program: 'B9ousNDpe29G45KFHyndvHXpLigBtxCh9xbboWuCeXyP',
    oracle: oracle.toBase58(),
    config: Keypair.generate().publicKey.toBase58(),
    treeAuth: Keypair.generate().publicKey.toBase58(),
    tree: tree.toBase58(),
    treeConfig: Keypair.generate().publicKey.toBase58(),
    orderPda: orderPda(buyer, 7n).toBase58(),
    grantReceipt: null,
    auth: {
      wallet: buyer.toBase58(), orderId: '7',
      specsHash: Buffer.alloc(32, 3).toString('hex'), nonce: '7', expiresAtSlot: '5000',
    },
    signature: base58Encode(new Uint8Array(64).fill(9)),
    specs: [{ collection: '11111111111111111111111111111111', name: 'NIGHTMOTH #1', symbol: 'NIGHTMOTH', uri: 'https://x/0/1.json' }],
  };
}

describe('phase-V instruction builders', () => {
  it('base58 roundtrip (signatures)', () => {
    const bytes = new Uint8Array(64);
    for (let i = 0; i < 64; i++) bytes[i] = (i * 37) % 256;
    expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
    expect(base58Decode('11111111111111111111111111111111')).toEqual(new Uint8Array(32));
  });

  it('buy_pack: accounts + args layout', () => {
    const ix = buyPackIx({ buyer, orderId: 7n, currency: 'SOL', amount: 54454545n });
    expect(ix.keys).toHaveLength(7);
    expect(ix.keys[2].pubkey.equals(orderPda(buyer, 7n))).toBe(true);
    expect(ix.data.readBigUInt64LE(8)).toBe(7n);
    expect(ix.data[16]).toBe(0);
    expect(ix.data.readBigUInt64LE(17)).toBe(54454545n);
  });

  it('settle_pack: canonical accounts, args = order_id + auth + specs', () => {
    const p = payload();
    const ix = settlePackIx(p, { relayer: buyer, treasury: Keypair.generate().publicKey });
    // 18 fixed accounts, no collections referenced by these specs
    expect(ix.keys).toHaveLength(18);
    expect(ix.keys[1].pubkey.equals(orderPda(buyer, 7n))).toBe(true);
    expect(ix.data.readBigUInt64LE(8)).toBe(7n);
    // auth.wallet right after the order id arg
    expect(ix.data.subarray(16, 48).equals(Buffer.from(buyer.toBytes()))).toBe(true);
  });

  it('oracle ed25519 ix carries prefix, message and signature', () => {
    const p = payload();
    const ix = oracleAuthIx(p);
    expect(ix.programId.toBase58()).toBe('Ed25519SigVerify111111111111111111111111111');
    const text = Buffer.from(ix.data).toString('latin1');
    expect(text).toContain('GUTCAP/MINTAUTH/V1');
    // header: 1 signature, sig @16, pubkey @80, message @112, self-indexed
    expect(ix.data[0]).toBe(1);
    expect(ix.data.readUInt16LE(2)).toBe(16);
    expect(ix.data.readUInt16LE(4)).toBe(0xffff);
    expect(ix.data.readUInt16LE(6)).toBe(80);
    expect(ix.data.readUInt16LE(10)).toBe(112);
  });

  it('grant_mint: receipt account and args without order prefix', () => {
    const p = { ...payload(), orderPda: null, grantReceipt: Keypair.generate().publicKey.toBase58(), auth: { ...payload().auth, orderId: (1n << 63n).toString() } };
    const ix = grantMintIx(p, { relayer: buyer });
    expect(ix.keys).toHaveLength(14);
    expect(ix.data.subarray(8, 40).equals(Buffer.from(buyer.toBytes()))).toBe(true);
  });
});
