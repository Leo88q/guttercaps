// Phase V backend (docs/PHASED-ONCHAIN-PLAN.md §3): byte-twins of the settle
// program (specsHash / MintAuth message / PackOrder account), oracle signing,
// and the settle-auth issuance rules (escrow must match the committed order,
// specs are issued exactly once).
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { Keypair, PublicKey } from '@solana/web3.js';
import { Db } from '../src/db.ts';
import * as orders from '../src/pack-orders.ts';
import { base58Decode } from '../src/base58.ts';
import type { MintAuth } from '../src/phasev.ts';

let pv: typeof import('../src/phasev.ts');
beforeAll(async () => {
  vi.resetModules();
  process.env.SHARED_MERKLE_TREE = Keypair.generate().publicKey.toBase58();
  pv = await import('../src/phasev.ts');
});

const TREASURY = Keypair.generate().publicKey.toBase58();
const BUYER = Keypair.generate();
const T0 = 1_800_000_000;

describe('byte twins of programs/settle', () => {
  it('specsHash matches the documented serialization', () => {
    const specs = [{
      collection: Keypair.generate().publicKey, name: 'NIGHTMOTH #1', symbol: 'NIGHTMOTH', uri: 'https://cdn.guttercaps.gg/m/0/1.json',
    }];
    const buf = Buffer.concat([
      Buffer.from(specs[0].collection.toBytes()),
      ...['NIGHTMOTH #1', 'NIGHTMOTH', 'https://cdn.guttercaps.gg/m/0/1.json'].flatMap((v) => {
        const b = Buffer.from(v); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return [l, b];
      }),
    ]);
    expect(pv.specsHash(specs).equals(createHash('sha256').update(buf).digest())).toBe(true);
  });

  it('MintAuth message layout + oracle signature verifies', () => {
    const oracle = Keypair.generate();
    const auth: MintAuth = {
      wallet: BUYER.publicKey, orderId: 42n, specsHash: Buffer.alloc(32, 7), nonce: 42n, expiresAtSlot: 999n,
    };
    const msg = pv.mintAuthMessage(auth);
    expect(msg.subarray(0, 18).toString()).toBe('GUTCAP/MINTAUTH/V1');
    expect(msg.length).toBe(18 + 32 + 8 + 32 + 8 + 8);
    expect(msg.subarray(18, 50).equals(Buffer.from(BUYER.publicKey.toBytes()))).toBe(true);
    const sig = pv.signMintAuth(oracle, auth);
    expect(ed25519.verify(base58Decode(sig), msg, oracle.publicKey.toBytes())).toBe(true);
  });

  it('PackOrder account decode reads the Anchor layout', () => {
    const data = Buffer.alloc(8 + 59);
    BUYER.publicKey.toBuffer().copy(data, 8);
    data.writeBigUInt64LE(77n, 40);
    data[48] = 2;
    data.writeBigUInt64LE(123_000n, 49);
    data[57] = 0;
    data.writeBigUInt64LE(555n, 58);
    const o = pv.decodePackOrder(data);
    expect(o.buyer.equals(BUYER.publicKey)).toBe(true);
    expect(o.orderId).toBe(77n);
    expect(o.currency).toBe(2);
    expect(o.amount).toBe(123_000n);
    expect(o.status).toBe(0);
  });

  it('PDAs match the program seeds', () => {
    expect(pv.orderPda(BUYER.publicKey, 5n).toBase58())
      .toBe(PublicKey.findProgramAddressSync(
        [Buffer.from('order'), BUYER.publicKey.toBuffer(), (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(5n); return b; })()],
        pv.SETTLE_PROGRAM,
      )[0].toBase58());
    expect(pv.grantReceiptPda(pv.GRANT_ID_BASE + 3n)).toBeInstanceOf(PublicKey);
  });
});

describe('settle-auth issuance', () => {
  it('refuses when no on-chain escrow exists, issues matching specs when it does', async () => {
    const db = new Db(':memory:');
    const o = orders.createOrder(db, BUYER.publicKey.toBase58(), { sku: 1, qty: 1, currency: 'SOL' }, T0, { treasury: TREASURY, seedHex: 'ab'.repeat(32) });
    const oracle = Keypair.generate();
    const emptyConn = { getAccountInfo: async () => null, getSlot: async () => 1000 } as never;
    await expect(pv.settleAuthForOrder(db, BUYER.publicKey.toBase58(), o.orderId, { connection: emptyConn, oracle }))
      .rejects.toThrow(/buy_pack escrow/);

    // Fabricate the escrow account the program would have created.
    const acct = Buffer.alloc(8 + 59);
    BUYER.publicKey.toBuffer().copy(acct, 8);
    acct.writeBigUInt64LE(BigInt(o.orderId), 40);
    acct[48] = 0;
    acct.writeBigUInt64LE(BigInt(o.amount), 49);
    acct[57] = 0;
    const conn = {
      getAccountInfo: async () => ({ owner: pv.SETTLE_PROGRAM, data: acct }),
      getSlot: async () => 2000,
    } as never;
    const p1 = await pv.settleAuthForOrder(db, BUYER.publicKey.toBase58(), o.orderId, { connection: conn, oracle });
    expect(p1.status).toBe('paid');
    expect(p1.specs).toHaveLength(5);
    expect(p1.auth.expiresAtSlot).toBe('3500');
    // signature binds the payload's specs
    const auth: MintAuth = {
      wallet: BUYER.publicKey, orderId: BigInt(o.orderId),
      specsHash: pv.specsHash(p1.specs.map((x) => ({ ...x, collection: new PublicKey(x.collection) }))),
      nonce: BigInt(o.orderId), expiresAtSlot: 3500n,
    };
    expect(ed25519.verify(base58Decode(p1.signature), pv.mintAuthMessage(auth), oracle.publicKey.toBytes())).toBe(true);
    // re-issue: identical specs (names are the DAS registration key)
    const p2 = await pv.settleAuthForOrder(db, BUYER.publicKey.toBase58(), o.orderId, { connection: conn, oracle });
    expect(p2.specs.map((x) => x.name)).toEqual(p1.specs.map((x) => x.name));
  });
});
