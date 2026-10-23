// Phase-G direct mint (docs/MINIMAL-LAUNCH-CHECKLIST.md §3): MetadataArgsV2
// byte layout pinned against chip_core, mint_v2 instruction shape, and the
// mint crank's resume/no-double-mint semantics with an injected sender.
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { Db } from '../src/db.ts';
import * as mint from '../src/bubblegum-mint.ts';
import * as orders from '../src/pack-orders.ts';

const TREE = Keypair.generate().publicKey;
const AUTH = Keypair.generate();

describe('metadata + instruction layout (§3.1)', () => {
  it('chip metadata follows the program convention', () => {
    const m = mint.chipMetadata(0, 3, 42);
    expect(m.name).toBe('NIGHTMOTH #42');
    expect(m.uri).toBe('https://cdn.guttercaps.gg/m/0/3.json');
  });

  it('MetadataArgsV2 layout: strings, 250bps, flags, token standard, creator, no collection', () => {
    const data = mint.serializeMetadataV2({ name: 'NIGHTMOTH #1', symbol: 'NIGHTMOTH', uri: 'u', creator: AUTH.publicKey });
    let pos = 0;
    const readStr = () => { const n = data.readUInt32LE(pos); pos += 4; const s = data.subarray(pos, pos + n).toString(); pos += n; return s; };
    expect(readStr()).toBe('NIGHTMOTH #1');
    expect(readStr()).toBe('NIGHTMOTH');
    expect(readStr()).toBe('u');
    expect(data.readUInt16LE(pos)).toBe(250); pos += 2;
    expect(data[pos++]).toBe(0); // primary_sale_happened
    expect(data[pos++]).toBe(0); // is_mutable
    expect(data[pos++]).toBe(1); expect(data[pos++]).toBe(0); // Some(NonFungible)
    expect(data.readUInt32LE(pos)).toBe(1); pos += 4; // one creator
    expect(new PublicKey(data.subarray(pos, pos + 32)).equals(AUTH.publicKey)).toBe(true); pos += 32;
    expect(data[pos++]).toBe(1); // verified
    expect(data[pos++]).toBe(100); // share
    expect(data[pos++]).toBe(0); // collection None
    expect(pos).toBe(data.length);
  });

  it('mint_v2 ix: discriminator, account order, writable tree/config', () => {
    const owner = Keypair.generate().publicKey;
    const ix = mint.buildMintV2Ix({
      merkleTree: TREE, payer: AUTH.publicKey, treeAuthority: AUTH.publicKey, leafOwner: owner,
      metadata: mint.chipMetadata(1, 2, 7),
    });
    expect(ix.programId.equals(mint.BUBBLEGUM_PROGRAM)).toBe(true);
    // Canonical mint_v2: 13 metas. No collection → Bubblegum program-id
    // sentinels in the optional slots (3, 7, 8); mpl_core_program at 11.
    expect(ix.keys).toHaveLength(13);
    expect(ix.keys[0].pubkey.equals(mint.treeConfigPda(TREE))).toBe(true);
    expect(ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[3].pubkey.equals(mint.BUBBLEGUM_PROGRAM)).toBe(true);
    expect(ix.keys[4].pubkey.equals(owner)).toBe(true); // leaf owner
    expect(ix.keys[6].pubkey.equals(TREE)).toBe(true);
    expect(ix.keys[6].isWritable).toBe(true);
    expect(ix.keys[7].pubkey.equals(mint.BUBBLEGUM_PROGRAM)).toBe(true);
    expect(ix.keys[11].pubkey.equals(mint.MPL_CORE)).toBe(true);
    expect(ix.keys[12].pubkey.equals(SystemProgram.programId)).toBe(true);
    expect(ix.data.length).toBeGreaterThan(8);
  });

  it('with a Core collection: real collection + cpi signer slots, metadata carries it', () => {
    const owner = Keypair.generate().publicKey;
    const core = Keypair.generate().publicKey;
    const ix = mint.buildMintV2Ix({
      merkleTree: TREE, payer: AUTH.publicKey, treeAuthority: AUTH.publicKey, leafOwner: owner,
      metadata: mint.chipMetadata(1, 2, 7), coreCollection: core,
    });
    expect(ix.keys).toHaveLength(13);
    expect(ix.keys[3].pubkey.equals(AUTH.publicKey)).toBe(true); // collection authority signs
    expect(ix.keys[3].isSigner).toBe(true);
    expect(ix.keys[7].pubkey.equals(core)).toBe(true);
    expect(ix.keys[7].isWritable).toBe(true);
    expect(ix.keys[8].pubkey.equals(mint.MPL_CORE_CPI_SIGNER)).toBe(true);
    // MetadataArgsV2 ends with Some(collection)
    expect(ix.data.subarray(ix.data.length - 33, ix.data.length - 32)).toEqual(Buffer.of(1));
    expect(ix.data.subarray(ix.data.length - 32).equals(Buffer.from(core.toBytes()))).toBe(true);
  });

  it('nextLeafIndex reads the tree header like das.ts', () => {
    const buf = Buffer.alloc(56 + 24 + 100);
    buf.writeBigUInt64LE(123n, 56 + 8);
    expect(mint.nextLeafIndex(buf)).toBe(123);
  });
});

describe('mint crank (§3.2)', () => {
  it('mints paid orders once, resumes after a mid-order failure', async () => {
    const db = new Db(':memory:');
    const wallet = Keypair.generate().publicKey.toBase58();
    const o = orders.createOrder(db, wallet, { sku: 1, qty: 1, currency: 'SOL' }, 1_800_000_000, {
      treasury: Keypair.generate().publicKey.toBase58(), seedHex: 'ab'.repeat(32),
    });
    db.run(`UPDATE pack_orders SET status='paid', tx_sig='x' WHERE id=?`, o.orderId);
    const sent: string[] = [];
    let failAt = 2;
    const sendMint = async (_ord: unknown, chip: mint.ChipToMint) => {
      if (sent.length === failAt) throw new Error('rpc down');
      sent.push(chip.assetId);
    };
    // the chain's next leaf advances with every mint — the stub mirrors chainFirstLeafIndex
    const deps = { sendMint, firstLeafIndex: async () => sent.length, tree: TREE };
    const r1 = await mint.processPaidOrders(db, deps);
    expect(r1.mintedOrders).toBe(0);
    expect(sent).toHaveLength(2); // two chips minted, third failed
    failAt = 99; // RPC recovered
    const r2 = await mint.processPaidOrders(db, deps);
    expect(r2.mintedOrders).toBe(1);
    expect(sent).toHaveLength(5);
    expect(new Set(sent).size).toBe(5); // no double mint
    const row = db.get<{ status: string; assets: string }>(`SELECT status, assets FROM pack_orders WHERE id=?`, o.orderId);
    expect(row?.status).toBe('minted');
    expect(JSON.parse(row!.assets)).toHaveLength(5);
    // verify recomputes from the revealed seed
    expect(orders.verifyOrder(db, o.orderId)?.matches).toBe(true);
  });
});
