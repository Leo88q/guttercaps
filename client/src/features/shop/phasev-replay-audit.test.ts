// One paid-mint payload, two mints. `settle_pack` and `grant_mint` verify the same Ed25519 message
// (GUTCAP/MINTAUTH/V2 ‖ wallet ‖ order_id ‖ amount ‖ currency ‖ specs_hash ‖ nonce ‖ expires_at_slot) and neither binds an
// operation type, while their receipts live in different PDAs: ["order", buyer, id] and ["grant", id].
// This test builds both instructions from the *same* paid-order payload and records that the grant path
// accepts it unchanged and consumes its own (free) receipt PDA. What the Rust side does with it is read
// from programs/settle/src/lib.rs: settle_pack_handler (883-980) and grant_mint_handler (1113-1180) both
// check only auth.wallet / auth.order_id / auth.nonce, and grant_mint never checks the 2^63 fusion namespace.
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { grantMintIx, oracleAuthIx, orderPda, settlePackIx, type SettlePayloadLike } from './phaseV';
import { base58Encode } from '@/shared/lib/base58';

const buyer = Keypair.generate().publicKey;
const oracle = Keypair.generate().publicKey;
const tree = Keypair.generate().publicKey;
const ORDER_ID = 7n; // a real paid order id, far below the 2^63 fusion namespace
const PROGRAM = new PublicKey('B9ousNDpe29G45KFHyndvHXpLigBtxCh9xbboWuCeXyP');

const grantReceiptPda = (orderId: bigint) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from('grant'), Buffer.from(new Uint8Array(new BigUint64Array([orderId]).buffer))],
    PROGRAM,
  )[0];

function paidOrderPayload(): SettlePayloadLike {
  return {
    program: PROGRAM.toBase58(),
    oracle: oracle.toBase58(),
    config: Keypair.generate().publicKey.toBase58(),
    treeAuth: Keypair.generate().publicKey.toBase58(),
    tree: tree.toBase58(),
    treeConfig: Keypair.generate().publicKey.toBase58(),
    orderPda: orderPda(buyer, ORDER_ID).toBase58(),
    grantReceipt: null,
    auth: {
      wallet: buyer.toBase58(), orderId: ORDER_ID.toString(),
      amount: '5990000', currency: 0, // находка 55: подпись покрывает сумму и валюту эскроу
      specsHash: Buffer.alloc(32, 3).toString('hex'), nonce: ORDER_ID.toString(), expiresAtSlot: '5000',
    },
    signature: base58Encode(new Uint8Array(64).fill(9)),
    specs: [{ collection: '11111111111111111111111111111111', name: 'NIGHTMOTH #1', symbol: 'NIGHTMOTH', uri: 'https://x/0/1.json' }],
  };
}

describe('phase-V mint authorization domain', () => {
  it('the paid order payload also builds a grant_mint with its own receipt PDA', () => {
    const p = paidOrderPayload();
    const settle = settlePackIx(p, { relayer: buyer, treasury: Keypair.generate().publicKey });
    const receipt = grantReceiptPda(ORDER_ID); // public derivation — no secret needed to occupy it
    const grant = grantMintIx({ ...p, grantReceipt: receipt.toBase58() }, { relayer: buyer });

    // the Ed25519 instruction is byte-identical for both paths: no operation tag anywhere in the message
    const auth = Buffer.from(oracleAuthIx(p).data);
    // header 16 ‖ signature 64 ‖ pubkey 32 ‖ message N; the message is exactly the mint-auth layout below
    const msg = auth.subarray(112);
    // prefix + wallet + order_id + amount + currency + specs_hash + nonce + expiry (находка 55)
    expect(msg.length).toBe(18 + 32 + 8 + 8 + 1 + 32 + 8 + 8);
    expect(msg.subarray(0, 18).toString('latin1')).toBe('GUTCAP/MINTAUTH/V2');
    expect(msg.readBigUInt64LE(50)).toBe(ORDER_ID);              // order_id at prefix(18)+wallet(32)
    expect(msg.readBigUInt64LE(58)).toBe(5_990_000n);            // amount, из payload'а
    expect(msg[66]).toBe(0);                                     // currency (SOL)
    expect(msg.readBigUInt64LE(99)).toBe(ORDER_ID);              // nonce at prefix+wallet+order_id+amount+currency+hash

    // settle consumes the order escrow; grant consumes a different, unoccupied PDA
    expect(settle.keys[1]!.pubkey.equals(orderPda(buyer, ORDER_ID))).toBe(true);
    expect(grant.keys[1]!.pubkey.equals(receipt)).toBe(true);
    expect(grant.keys[2]!.pubkey.equals(buyer)).toBe(true); // the grant pays this wallet again
    expect(receipt.equals(orderPda(buyer, ORDER_ID))).toBe(false);
    // and the grant carries the same specs (hence the same specsHash the oracle signed)
    expect(Buffer.from(grant.data).length).toBeGreaterThan(0);
    console.log(JSON.stringify({
      orderId: ORDER_ID.toString(),
      fusionNamespaceStartsAt: (1n << 63n).toString(),
      settleAccount1: settle.keys[1]!.pubkey.toBase58(),
      grantAccount1: receipt.toBase58(),
      authMessageBytes: msg.length,
      ed25519IxBytes: auth.length,
      rustCheck: 'settle lib.rs:883-980 and 1113-1180 accept the same (wallet, order_id, nonce) message',
    }));
  });
});
