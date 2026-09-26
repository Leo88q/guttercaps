import { describe, it, expect, beforeEach } from 'vitest';
import { AddressLookupTableAccount, Connection, Keypair, PublicKey } from '@solana/web3.js';
import { expandRandomness, PACKS, STALE_PACK_SLOTS } from '@guttercaps/economy';
import { Db } from '../src/db.ts';
import { ingestTx } from '../src/ingest.ts';
import { crankStatus } from '../src/queries.ts';
import {
  Crank, CU, GatewayError, fetchGatewayReveal, jobKey, toEconPack, voucherEconPack, type FetchLike,
} from '../src/crank.ts';
import {
  ARENA_ID, ASSOCIATED_TOKEN_PROGRAM_ID, CHIP_CORE_ID, MPL_ACCOUNT_COMPRESSION_ID, MPL_BUBBLEGUM_V2_ID, MPL_CORE_ID, MPL_NOOP_ID, RNG_KIND,
  SYSTEM_PROGRAM_ID, SYSVAR_SLOT_HASHES_ID, TOKEN_PROGRAM_ID, WSOL_MINT, assetPda, battlePda, bubblegumTreeMetaPda, chipStatePda, claimFusionPda,
  ADDRESS_LOOKUP_TABLE_PROGRAM_ID, closeRandomnessIx, closeRandomnessLutIx, collectionMetaPda, compressedClaimNonce, compressedMintClaimPda, compressedSettlementPda, configPda, decodeCompressedMintClaim,
  decodeCompressedPackSettlement, decodeGameConfig, decodeOracleGateway, decodePendingPack, decodePlayerPity, decodeRandomness, finalizeCompressedPackIx, fuseClaimsRevealIx, fuseRevealIx,
  ixDiscriminator, mintCompressedChipIx, openCompressedPackIx, packSeed, pendingFusionPda, pendingPackPda, pityPda, registerCompressedChipIx,
  revealRandomnessIx, rngAuthPda, rngPda, sbLutPda, sbLutSignerPda, sbOracleStatsPda, sbRewardEscrow, sbStatePda, customErrorCode, vaultPda,
  allLedgerPdas, ledgerPdaOf,
} from '../src/chain.ts';
import { DasClient, foldCompressionProof, v2LeafHash, type DasAssetWithProof } from '../src/das.ts';
import { SWITCHBOARD_PROGRAM_ID } from '../src/config.ts';
import { clampCuPrice } from '../src/tx.ts';
import {
  DEFAULT_PACK, FakeConnection, ProgramError, SB_OWNER, encodeBubblegumTreeMeta, encodeChipState, encodeCollectionMeta, encodeCompressedMintClaim,
  encodeCompressedPackSettlement, encodeGameConfig, encodeOracle, encodePendingClaimFusion, encodePendingFusion, encodePendingPack, encodePlayerPity,
  encodeRandomness, encodeWagerBattle, pk,
} from './chainFixtures.ts';
import { tx } from './fixtures.ts';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const asConn = (c: FakeConnection) => c as unknown as Connection;

// instruction discriminators (sha256("global:<name>")[0:8])
const D = {
  reveal: '1e8255dcd0501ca9', openC: '8272be34bdd75c5e', mint: 'e2086aa387b49dd4', register: '36687c0c79f6ba6f',
  finalize: '5971c36575c5a83e', close: 'f8105307bf85afac', fuse: '67b5437253112c85', fuseClaims: 'e7496af9fe07b8f5',
  revealB: 'b74978e7ef0abd5a', closeB: '1bd71150ab869e2e', legacyOpen: '4bcb90413ffd6755',
  closeLut: '6d5639e87d8e7b31', closeLutB: '05b091cb8fe503c8',
};

// ------------------------------------------------------------------ fake oracle gateway
const ORACLE_VALUE = new Uint8Array(32).map((_, i) => (i * 37 + 11) & 0xff);
const ORACLE_SIG = new Uint8Array(64).map((_, i) => (255 - i) & 0xff);
type Gateway = FetchLike & { calls: number };
function gateway(opts: { fail?: number | 'network'; onCall?: (url: string, body: unknown) => void } = {}): Gateway {
  const f: Gateway = Object.assign(async (url: string, init: { body: string }) => {
    f.calls++;
    opts.onCall?.(url, JSON.parse(init.body));
    if (opts.fail === 'network') throw new Error('ECONNREFUSED');
    if (typeof opts.fail === 'number') return { ok: false, status: opts.fail, text: async () => 'randomness not yet finalized' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ signature: Buffer.from(ORACLE_SIG).toString('base64'), recovery_id: 1, value: Array.from(ORACLE_VALUE) }) };
  }, { calls: 0 });
  return f;
}

// ------------------------------------------------------------------ a world with one pending pack
interface World {
  conn: FakeConnection; db: Db; payer: Keypair; buyer: PublicKey; nonce: bigint; pending: PublicKey; randomness: PublicKey;
  oracle: PublicKey; queue: PublicKey; treasury: PublicKey; cgMint: PublicKey; cores: PublicKey[];
  trees: { merkleTree: PublicKey; treeConfig: PublicKey; maxDepth: number }[]; commitSlot: bigint;
}
function world(o: { qty?: number; sku?: number; paidCg?: bigint; revealed?: boolean; withDbRow?: boolean; voucher?: { template: number; odds: number[]; soulboundDays: number } } = {}): World {
  const conn = new FakeConnection();
  const db = new Db(':memory:');
  const payer = Keypair.generate();
  const buyer = pk(), nonce = 7n, oracle = pk(), queue = pk(), treasury = pk(), cgMint = pk();
  const cores = Array.from({ length: 10 }, () => pk());
  conn.set(configPda()[0], encodeGameConfig({ treasury, cgMint, collectionsCreated: 10 }));
  cores.forEach((c, i) => conn.set(collectionMetaPda(i)[0], encodeCollectionMeta(i, c)));
  const trees = cores.map((core, i) => {
    const merkleTree = pk(), treeConfig = pk(), maxDepth = 3;
    conn.set(bubblegumTreeMetaPda(i)[0], encodeBubblegumTreeMeta(i, { coreCollection: core, merkleTree, treeConfig, maxDepth, canopy: 0 }));
    return { merkleTree, treeConfig, maxDepth };
  });
  conn.set(pityPda(buyer)[0], encodePlayerPity(buyer, [0, 4, 0, 0]));
  const [pending] = pendingPackPda(buyer, nonce);
  const [randomness] = rngPda(RNG_KIND.PACK, buyer, nonce);
  const commitSlot = 4_000n;
  conn.set(pending, encodePendingPack({ buyer, sku: o.voucher ? 0 : o.sku ?? 1, qty: o.voucher ? 1 : o.qty ?? 1, opened: 0, randomness, commitSlot, paidCg: o.paidCg, nonce, revealed: o.revealed, value: o.revealed ? ORACLE_VALUE : undefined, voucher: o.voucher }));
  conn.set(randomness, encodeRandomness({ authority: rngAuthPda(RNG_KIND.PACK)[0], queue, oracle, seedSlot: commitSlot, revealSlot: o.revealed ? commitSlot + 3n : 0n, value: o.revealed ? ORACLE_VALUE : undefined }), SB_OWNER);
  conn.set(oracle, encodeOracle('https://oracle-1.example.com'), SB_OWNER);
  if (o.withDbRow !== false) {
    if (o.voucher) ingestTx(tx([{ program: 'chip_core', name: 'VoucherIssued', data: { wallet: buyer.toBase58(), nonce: nonce.toString(), template: o.voucher.template, randomness: randomness.toBase58() } }]), db);
    else ingestTx(tx([{ program: 'chip_core', name: 'PackBought', data: { buyer: buyer.toBase58(), sku: o.sku ?? 1, qty: o.qty ?? 1, currency: 0, amount: '33000000', nonce: nonce.toString(), randomness: randomness.toBase58() } }]), db);
  }
  return { conn, db, payer, buyer, nonce, pending, randomness, oracle, queue, treasury, cgMint, cores, trees, commitSlot };
}

/** Seed the claims + settlement of an already-opened pack_no (shared by the runtime and race/resume tests). */
function emulateOpen(w: World, buyer: PublicKey, nonce: bigint, packNo: number, collectionIdxs: number[]) {
  const [settlementKey] = compressedSettlementPda(buyer, nonce);
  const [pendingKey] = pendingPackPda(buyer, nonce);
  const prev = w.conn.get(settlementKey);
  const s = prev ? decodeCompressedPackSettlement(prev) : null;
  w.conn.set(settlementKey, encodeCompressedPackSettlement({
    buyer, pending: pendingKey, nonce, totalClaims: (s?.totalClaims ?? 0) + collectionIdxs.length,
    registeredClaims: s?.registeredClaims ?? 0, cancelledClaims: s?.cancelledClaims ?? 0,
  }));
  collectionIdxs.forEach((collectionIdx, i) => {
    const claimNonce = compressedClaimNonce(nonce, packNo, i);
    w.conn.set(compressedMintClaimPda(buyer, claimNonce)[0], encodeCompressedMintClaim({
      buyer, collectionIdx, gameIndex: BigInt(packNo * 5 + i + 1), settlement: settlementKey,
    }));
  });
}

/** A DAS stub that returns a LOCALLY-CONSISTENT proof: the crank's V2 preflight recomputes the root for real. */
function fakeDas(o: { leafId?: bigint; depth?: number } = {}) {
  const das = new DasClient({ endpoint: 'http://fake-das' });
  const seen: { owner: string; collection: string; name: string }[] = [];
  const leafId = o.leafId ?? 5n;
  const depth = o.depth ?? 3;
  das.resolveClaimAssetId = (async (owner, coreCollection, expectedName) => {
    const buyer = typeof owner === 'string' ? new PublicKey(owner) : owner;
    seen.push({ owner: buyer.toBase58(), collection: coreCollection.toBase58(), name: expectedName });
    const assetId = pk(), merkleTree = pk();
    const dataHash = pk().toBytes(), creatorHash = pk().toBytes(), collectionHash = pk().toBytes(), assetDataHash = pk().toBytes();
    const siblings = Array.from({ length: depth }, () => pk());
    const leaf = v2LeafHash({ assetId, owner: buyer, delegate: buyer, nonce: leafId, dataHash, creatorHash, collectionHash, assetDataHash, flags: 0 });
    const root = foldCompressionProof(leaf, leafId, siblings.map((s) => Uint8Array.from(s.toBytes())));
    return {
      asset: {
        assetId, interface: 'MplBubblegum', owner: buyer, delegate: buyer, frozen: false, merkleTree, leafId, sequence: undefined,
        dataHash, creatorHash, collectionHash, assetDataHash, flags: 0, jsonUri: undefined, raw: {} as never,
      },
      proof: { root, treeId: merkleTree, nodeIndex: (1n << BigInt(depth)) + leafId, leafIndex: leafId, proof: siblings, raw: {} as never },
      proofAccounts: siblings,
    } satisfies DasAssetWithProof;
  }) as DasClient['resolveClaimAssetId'];
  return { das, seen };
}

/**
 * Minimal chip_core/arena "runtime" for the fake chain: reveal writes reveal_slot+value,
 * open_compressed_pack bumps `opened` and materializes claims + settlement (finalize closes),
 * mint/register flip claim flags, fuse/close delete. The legacy `open_pack` fails loudly —
 * the crank must never send it.
 */
function runtime(w: World, opts: { failOpenWith?: number; onOpen?: (packNo: number) => void } = {}) {
  const REVEAL = D.reveal, OPEN_C = D.openC, MINT = D.mint, REGISTER = D.register, FINALIZE = D.finalize;
  const CLOSE = D.close, FUSE = D.fuse, FUSE_C = D.fuseClaims, REVEAL_B = D.revealB, CLOSE_B = D.closeB, LEGACY = D.legacyOpen;
  w.conn.onTx = (ixs) => {
    ixs.forEach((ix, i) => {
      if (!ix.programId.equals(CHIP_CORE_ID) && !ix.programId.equals(ARENA_ID)) return;
      const d = hex(ix.data.subarray(0, 8));
      if (d === REVEAL || d === REVEAL_B) {
        const key = ix.keys[1];
        const cur = decodeRandomness(w.conn.get(key)!);
        w.conn.set(key, encodeRandomness({ authority: cur.authority, queue: cur.queue, oracle: cur.oracle, seedSlot: cur.seedSlot, revealSlot: BigInt(w.conn.slot), value: ix.data.subarray(8 + 64 + 1, 8 + 64 + 1 + 32), lutSlot: cur.lutSlot }), SB_OWNER);
      } else if (d === OPEN_C) {
        const pendingKey = ix.keys[2]; // [payer, config, pending, randomness, pity, settlement, buyer, system, …]
        const cur = w.conn.get(pendingKey);
        if (!cur) throw new ProgramError(0xbc4 /* AccountNotInitialized */, i);
        const p = decodePendingPack(cur);
        const nonce = ix.data.readBigUInt64LE(8);
        const packNo = ix.data[16];
        if (packNo !== p.opened) throw new ProgramError(6005 /* InvalidQuantity */, i);
        const chips = (ix.keys.length - 8) / 3;
        if (!Number.isInteger(chips) || chips < 1 || chips > 5) throw new ProgramError(6005, i);
        const rnd = decodeRandomness(w.conn.get(p.randomness)!);
        if (rnd.revealSlot === 0n) throw new ProgramError(6016 /* RandomnessNotResolved */, i);
        if (opts.failOpenWith) throw new ProgramError(opts.failOpenWith, i);
        opts.onOpen?.(packNo);
        const idxs: number[] = [];
        for (let c = 0; c < chips; c++) {
          const colKey = ix.keys[8 + c * 3 + 1];
          let found = -1;
          for (let j = 0; j < 10; j++) if (collectionMetaPda(j)[0].equals(colKey)) { found = j; break; }
          if (found < 0 || !ix.keys[8 + c * 3 + 2].equals(bubblegumTreeMetaPda(found)[0])) throw new ProgramError(6019 /* InvalidCollection */, i);
          idxs.push(found);
        }
        emulateOpen(w, p.buyer, nonce, packNo, idxs);
        w.conn.set(pendingKey, encodePendingPack({
          buyer: p.buyer, sku: p.sku, qty: p.qty, opened: p.opened + 1, randomness: p.randomness, commitSlot: p.commitSlot,
          paidLamports: p.paidLamports, paidCg: p.paidCg, nonce: p.nonce, revealed: true, value: rnd.value,
          voucher: p.voucher ? { odds: p.voucherOdds, soulboundDays: p.soulboundDays } : undefined,
        }));
      } else if (d === MINT) {
        const claimKey = ix.keys[4]; // [payer, config, collection, tree_meta, claim, …]
        const cur = w.conn.get(claimKey);
        if (!cur) throw new ProgramError(0xbc4, i);
        const c = decodeCompressedMintClaim(cur);
        if (c.minted) throw new ProgramError(6030, i);
        w.conn.set(claimKey, encodeCompressedMintClaim({ ...claimFields(c), minted: true }));
      } else if (d === REGISTER) {
        const claimKey = ix.keys[4], settlementKey = ix.keys[5];
        const cur = w.conn.get(claimKey);
        if (!cur) throw new ProgramError(0xbc4, i);
        const c = decodeCompressedMintClaim(cur);
        if (!c.minted || c.registered) throw new ProgramError(6030, i);
        w.conn.set(claimKey, encodeCompressedMintClaim({ ...claimFields(c), registered: true }));
        const s = decodeCompressedPackSettlement(w.conn.get(settlementKey)!);
        w.conn.set(settlementKey, encodeCompressedPackSettlement({ buyer: s.buyer, pending: s.pending, nonce: s.nonce, totalClaims: s.totalClaims, registeredClaims: s.registeredClaims + 1, cancelledClaims: s.cancelledClaims }));
      } else if (d === FINALIZE) {
        const settlementKey = ix.keys[2], pendingKey = ix.keys[3];
        const s = decodeCompressedPackSettlement(w.conn.get(settlementKey)!);
        const p = decodePendingPack(w.conn.get(pendingKey)!);
        if (p.opened !== p.qty || s.registeredClaims + s.cancelledClaims !== s.totalClaims) throw new ProgramError(6024 /* InvalidChipState */, i);
        w.conn.del(pendingKey); w.conn.del(settlementKey);
      } else if (d === FUSE) {
        w.conn.del(ix.keys[3]); // #12: [payer, config, ledger, pending, …]
      } else if (d === FUSE_C) {
        w.conn.del(ix.keys[3]); // [payer, config, ledger, pending, …]
      } else if (d === LEGACY) {
        throw new ProgramError(6001, i); // fail-closed legacy path — must never be sent
      } else if (d === CLOSE) {
        if (w.conn.get(ix.keys[4])) throw new ProgramError(6024 /* InvalidChipState */, i); // pinned PendingPack/PendingFusion/PendingClaimFusion must be gone
        w.conn.del(ix.keys[2]);
      } else if (d === CLOSE_B) {
        const battle = w.conn.get(ix.keys[4]);
        const status = battle?.[8 + 32 + 32 + 8 + 6 * 32 + 4 + 4 + 32 + 8]; // WagerBattle.status
        if (status !== 2 && status !== 3) throw new ProgramError(6003 /* BadStatus */, i); // battle must be Resolved/Cancelled
        w.conn.del(ix.keys[2]);
      }
    });
  };
}
const claimFields = (c: ReturnType<typeof decodeCompressedMintClaim>) => ({
  buyer: c.buyer, collectionIdx: c.collectionIdx, rarity: c.rarity, level: c.level, gameIndex: c.gameIndex, expiresAt: c.expiresAt,
  settlement: c.settlement, indexReserved: c.indexReserved, minted: c.minted, registered: c.registered, consumed: c.consumed,
  listed: c.listed, staked: c.staked, origin: c.origin, lockUntil: c.lockUntil,
});

/**
 * LUT-blind runtime variant: `FakeConnection` resolves compiled key indexes against the static
 * key list only, so decoded account keys are garbage whenever a lookup table is used — but
 * instruction DATA survives byte-for-byte. This runtime therefore applies effects purely from
 * discriminators + data, recomputing every PDA from the world's (buyer, nonce) and recomputing
 * the rolls from the pity account exactly like `open_compressed_pack` does on chain.
 */
function runtimeLut(w: World) {
  w.conn.onTx = (ixs) => {
    ixs.forEach((ix, i) => {
      const d = hex(ix.data.subarray(0, 8));
      const buyer = w.buyer, nonce = w.nonce;
      if (d === D.reveal) {
        const key = rngPda(RNG_KIND.PACK, buyer, nonce)[0];
        const cur = decodeRandomness(w.conn.get(key)!);
        w.conn.set(key, encodeRandomness({ authority: cur.authority, queue: cur.queue, oracle: cur.oracle, seedSlot: cur.seedSlot, revealSlot: BigInt(w.conn.slot), value: ix.data.subarray(73, 105), lutSlot: cur.lutSlot }), SB_OWNER);
      } else if (d === D.openC) {
        const packNo = ix.data[16];
        const pendingKey = pendingPackPda(buyer, nonce)[0];
        const p = decodePendingPack(w.conn.get(pendingKey)!);
        if (packNo !== p.opened) throw new ProgramError(6005, i);
        const rnd = decodeRandomness(w.conn.get(p.randomness)!);
        if (rnd.revealSlot === 0n) throw new ProgramError(6016, i);
        const cfg = decodeGameConfig(w.conn.get(configPda()[0])!);
        const econ = toEconPack(p.sku, cfg.packs[p.sku]);
        const pool = cfg.packs[p.sku].featuredOnly ? [cfg.featuredCollection] : Array.from({ length: cfg.collectionsCreated }, (_, j) => j);
        const pity = decodePlayerPity(w.conn.get(pityPda(buyer)[0])!).counters[p.sku];
        const rolls = expandRandomness(packSeed(rnd.value, p.qty, packNo), econ, pity, pool.length);
        emulateOpen(w, buyer, nonce, packNo, rolls.map((r) => pool[r.collectionIdx]));
        w.conn.set(pendingKey, encodePendingPack({
          buyer: p.buyer, sku: p.sku, qty: p.qty, opened: p.opened + 1, randomness: p.randomness, commitSlot: p.commitSlot,
          paidLamports: p.paidLamports, paidCg: p.paidCg, nonce: p.nonce, revealed: true, value: rnd.value,
          voucher: p.voucher ? { odds: p.voucherOdds, soulboundDays: p.soulboundDays } : undefined,
        }));
      } else if (d === D.mint) {
        const claimNonce = ix.data.readBigUInt64LE(8 + 32 + 1);
        const claimKey = compressedMintClaimPda(buyer, claimNonce)[0];
        const c = decodeCompressedMintClaim(w.conn.get(claimKey)!);
        w.conn.set(claimKey, encodeCompressedMintClaim({ ...claimFields(c), minted: true }));
      } else if (d === D.register) {
        const claimNonce = ix.data.readBigUInt64LE(8 + 32 + 1 + 32 + 32 + 32);
        const claimKey = compressedMintClaimPda(buyer, claimNonce)[0];
        const c = decodeCompressedMintClaim(w.conn.get(claimKey)!);
        w.conn.set(claimKey, encodeCompressedMintClaim({ ...claimFields(c), registered: true }));
        const settlementKey = compressedSettlementPda(buyer, nonce)[0];
        const s = decodeCompressedPackSettlement(w.conn.get(settlementKey)!);
        w.conn.set(settlementKey, encodeCompressedPackSettlement({ buyer: s.buyer, pending: s.pending, nonce: s.nonce, totalClaims: s.totalClaims, registeredClaims: s.registeredClaims + 1, cancelledClaims: s.cancelledClaims }));
      } else if (d === D.finalize) {
        const settlementKey = compressedSettlementPda(buyer, nonce)[0], pendingKey = pendingPackPda(buyer, nonce)[0];
        const s = decodeCompressedPackSettlement(w.conn.get(settlementKey)!);
        const p = decodePendingPack(w.conn.get(pendingKey)!);
        if (p.opened !== p.qty || s.registeredClaims + s.cancelledClaims !== s.totalClaims) throw new ProgramError(6024, i);
        w.conn.del(pendingKey); w.conn.del(settlementKey);
      } else if (d === D.close) {
        w.conn.del(rngPda(RNG_KIND.PACK, buyer, nonce)[0]);
      }
    });
  };
}

describe('crank · instruction layouts (mirror programs/chip_core/src/instructions/{rng,compressed,fusion}.rs)', () => {
  const payer = pk(), owner = pk(), nonce = 7n, oracle = pk(), queue = pk();
  it('reveal_randomness: 13 accounts in program order, data = disc ‖ sig[64] ‖ recovery_id ‖ value[32]', () => {
    const randomness = rngPda(RNG_KIND.PACK, owner, nonce)[0];
    const ix = revealRandomnessIx({ kind: RNG_KIND.PACK, payer, randomness, oracle, queue, signature: ORACLE_SIG, recoveryId: 1, value: ORACLE_VALUE });
    expect(ix.programId.equals(CHIP_CORE_ID)).toBe(true);
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([
      payer, randomness, rngAuthPda(RNG_KIND.PACK)[0], oracle, queue, sbOracleStatsPda(oracle)[0], sbRewardEscrow(randomness), sbStatePda()[0],
      new PublicKey('SysvarS1otHashes111111111111111111111111111'), SB_OWNER, new PublicKey('So11111111111111111111111111111111111111112'),
      new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), PublicKey.default,
    ].map((k) => k.toBase58()));
    expect(ix.keys.map((k) => (k.isSigner ? 's' : '') + (k.isWritable ? 'w' : 'r')).join(',')).toBe('sw,w,r,r,r,w,w,r,r,r,r,r,r');
    expect(ix.data.length).toBe(8 + 64 + 1 + 32);
    expect(hex(ix.data.subarray(0, 8))).toBe(D.reveal);
    expect(hex(ix.data.subarray(8, 72))).toBe(hex(ORACLE_SIG));
    expect(ix.data[72]).toBe(1);
    expect(hex(ix.data.subarray(73))).toBe(hex(ORACLE_VALUE));
    // arena twin
    const b = revealRandomnessIx({ kind: RNG_KIND.BATTLE, payer, randomness: rngPda(RNG_KIND.BATTLE, owner, nonce)[0], oracle, queue, signature: ORACLE_SIG, recoveryId: 0, value: ORACLE_VALUE });
    expect(b.programId.equals(ARENA_ID)).toBe(true);
    expect(hex(b.data.subarray(0, 8))).toBe(D.revealB);
    expect(b.keys[2].pubkey.equals(rngAuthPda(RNG_KIND.BATTLE)[0])).toBe(true);
    expect(() => revealRandomnessIx({ kind: RNG_KIND.PACK, payer, randomness, oracle, queue, signature: ORACLE_SIG.subarray(1), recoveryId: 1, value: ORACLE_VALUE })).toThrow(/64 bytes/);
  });
  it('close_randomness: pinned PDA per kind (pack / fusion / claim fusion / battle), LUT from lut_slot, data kind‖nonce (chip_core) / nonce (arena)', () => {
    const ix = closeRandomnessIx({ kind: RNG_KIND.PACK, payer, owner, nonce, lutSlot: 3_990n });
    const randomness = rngPda(RNG_KIND.PACK, owner, nonce)[0];
    const lutSigner = sbLutSignerPda(randomness)[0];
    expect(ix.keys.length).toBe(14);
    expect(ix.keys[1].pubkey.equals(owner)).toBe(true);
    expect(ix.keys[2].pubkey.equals(randomness)).toBe(true);
    expect(ix.keys[3].pubkey.equals(rngAuthPda(RNG_KIND.PACK)[0]) && ix.keys[3].isWritable).toBe(true);
    expect(ix.keys[4].pubkey.equals(pendingPackPda(owner, nonce)[0])).toBe(true);
    expect(ix.keys[7].pubkey.equals(sbLutPda(lutSigner, 3_990n)[0])).toBe(true);
    expect(ix.keys[8].pubkey.equals(lutSigner)).toBe(true);
    expect(hex(ix.data)).toBe(D.close + '00' + '0700000000000000');
    expect(closeRandomnessIx({ kind: RNG_KIND.FUSION, payer, owner, nonce, lutSlot: 1n }).keys[4].pubkey.equals(pendingFusionPda(owner, nonce)[0])).toBe(true);
    const cf = closeRandomnessIx({ kind: RNG_KIND.CLAIM_FUSION, payer, owner, nonce, lutSlot: 1n });
    expect(cf.programId.equals(CHIP_CORE_ID)).toBe(true);
    expect(cf.keys[4].pubkey.equals(claimFusionPda(owner, nonce)[0])).toBe(true);
    expect(hex(cf.data)).toBe(D.close + '03' + '0700000000000000');
    const b = closeRandomnessIx({ kind: RNG_KIND.BATTLE, payer, owner, nonce, lutSlot: 1n });
    expect(b.keys[4].pubkey.equals(battlePda(owner, nonce)[0])).toBe(true);
    expect(hex(b.data)).toBe(D.closeB + '0700000000000000');
  });
  it('open_compressed_pack: 8 fixed accounts + 3 per chip (claim, collection_meta[rolled], tree_meta); data = disc ‖ nonce ‖ pack_no', () => {
    const randomness = rngPda(RNG_KIND.PACK, owner, nonce)[0];
    const ix = openCompressedPackIx({ payer, buyer: owner, nonce, packNo: 2, chips: 3, collectionIdx: [2, 0, 2], randomness });
    expect(ix.keys.length).toBe(8 + 9);
    const pending = pendingPackPda(owner, nonce)[0];
    expect(ix.keys[0].pubkey.equals(payer) && ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[1].pubkey.equals(configPda()[0]) && !ix.keys[1].isWritable).toBe(true);
    expect(ix.keys[2].pubkey.equals(pending) && ix.keys[2].isWritable).toBe(true);
    expect(ix.keys[3].pubkey.equals(randomness)).toBe(true);
    expect(ix.keys[4].pubkey.equals(pityPda(owner)[0]) && ix.keys[4].isWritable).toBe(true);
    expect(ix.keys[5].pubkey.equals(compressedSettlementPda(owner, nonce)[0]) && ix.keys[5].isWritable).toBe(true);
    expect(ix.keys[6].pubkey.equals(owner)).toBe(true);
    expect(ix.keys[8].pubkey.equals(compressedMintClaimPda(owner, compressedClaimNonce(nonce, 2, 0))[0])).toBe(true);
    expect(ix.keys[9].pubkey.equals(collectionMetaPda(2)[0])).toBe(true);
    expect(ix.keys[10].pubkey.equals(bubblegumTreeMetaPda(2)[0])).toBe(true);
    expect(ix.keys[11].pubkey.equals(compressedMintClaimPda(owner, compressedClaimNonce(nonce, 2, 1))[0])).toBe(true);
    expect(ix.keys[12].pubkey.equals(collectionMetaPda(0)[0])).toBe(true);
    expect(hex(ix.data)).toBe(D.openC + '0700000000000000' + '02');
    expect(compressedClaimNonce(nonce, 2, 1)).toBe(nonce * 128n + 2n * 5n + 1n);
    expect(() => openCompressedPackIx({ payer, buyer: owner, nonce, packNo: 0, chips: 2, collectionIdx: [0], randomness })).toThrow(/chip count/);
  });
  it('mint_compressed_chip: 16 accounts (claim @4, collection twice: config @2 + tree authority @8, Bubblegum V2 CPIs); register: 16 + proof nodes; finalize: 14 with $CG/refund optionals', () => {
    const claimNonce = compressedClaimNonce(nonce, 0, 0);
    const treeConfig = pk(), merkleTree = pk(), coreCollection = pk();
    const mint = mintCompressedChipIx({ payer, buyer: owner, claimNonce, collectionIdx: 2, treeConfig, merkleTree, coreCollection });
    expect(mint.keys.length).toBe(16);
    expect(mint.keys[2].pubkey.equals(collectionMetaPda(2)[0])).toBe(true);
    expect(mint.keys[4].pubkey.equals(compressedMintClaimPda(owner, claimNonce)[0])).toBe(true);
    expect(mint.keys[6].pubkey.equals(treeConfig) && mint.keys[7].pubkey.equals(merkleTree)).toBe(true);
    expect(mint.keys[8].pubkey.equals(collectionMetaPda(2)[0])).toBe(true); // tree_creator_or_delegate = the collection PDA
    expect(mint.keys[11].pubkey.equals(MPL_BUBBLEGUM_V2_ID)).toBe(true);
    expect(mint.keys[12].pubkey.equals(MPL_NOOP_ID) && mint.keys[13].pubkey.equals(MPL_ACCOUNT_COMPRESSION_ID)).toBe(true);
    expect(mint.data.length).toBe(8 + 32 + 1 + 8);
    expect(hex(mint.data.subarray(0, 8))).toBe(D.mint);
    const nodes = [pk(), pk(), pk()];
    const asset = pk();
    const register = registerCompressedChipIx({
      payer, buyer: owner, claimNonce, asset, merkleTree, treeConfig, collectionIdx: 2, owner, delegate: owner,
      proof: { root: new Uint8Array(32), dataHash: new Uint8Array(32), creatorHash: new Uint8Array(32), collectionHash: new Uint8Array(32), assetDataHash: new Uint8Array(32), flags: 0, nonce: 5n, index: 5, proofNodes: nodes },
      rarity: 0, level: 1, gameIndex: 9n, settlement: compressedSettlementPda(owner, nonce)[0],
    });
    expect(register.keys.length).toBe(16 + 3);
    expect(register.keys[4].pubkey.equals(compressedMintClaimPda(owner, claimNonce)[0])).toBe(true);
    expect(register.keys[5].pubkey.equals(compressedSettlementPda(owner, nonce)[0])).toBe(true);
    expect(register.keys.slice(16).map((k) => k.pubkey.toBase58())).toEqual(nodes.map((n) => n.toBase58()));
    expect(hex(register.data.subarray(0, 8))).toBe(D.register);
    expect(() => registerCompressedChipIx({
      payer, buyer: owner, claimNonce, asset, merkleTree, treeConfig, collectionIdx: 2, owner, delegate: owner,
      proof: { root: new Uint8Array(31), dataHash: new Uint8Array(32), creatorHash: new Uint8Array(32), collectionHash: new Uint8Array(32), assetDataHash: new Uint8Array(32), flags: 0, nonce: 5n, index: 5, proofNodes: [] },
      rarity: 0, level: 1, gameIndex: 9n,
    })).toThrow(/32 bytes/);
    const fin = finalizeCompressedPackIx({ payer, buyer: owner, nonce });
    expect(fin.keys.length).toBe(14);
    expect(fin.keys[2].pubkey.equals(compressedSettlementPda(owner, nonce)[0])).toBe(true);
    expect(fin.keys[3].pubkey.equals(pendingPackPda(owner, nonce)[0])).toBe(true);
    expect(fin.keys[6].pubkey.equals(vaultPda()[0]) && fin.keys[6].isWritable).toBe(true);
    expect(fin.keys[7].pubkey.equals(CHIP_CORE_ID)).toBe(true); // absent optionals = program id
    expect(hex(fin.data)).toBe(D.finalize + '0700000000000000');
    const cgMint = pk(), treasury = pk();
    const finCg = finalizeCompressedPackIx({ payer, buyer: owner, nonce, cg: { cgMint, vaultCg: pk(), treasuryCg: pk() }, refundToken: { vault: pk(), buyer: pk() } });
    expect(finCg.keys[7].pubkey.equals(cgMint)).toBe(true);
    expect(finCg.keys[10].isWritable && finCg.keys[11].isWritable).toBe(true);
  });
  it('fuse_claims_reveal: 13 fixed accounts + 3 material claims; result claim PDA reuses the commit nonce; data = disc ‖ nonce ‖ result_nonce', () => {
    const mats = [pk(), pk(), pk()];
    const ix = fuseClaimsRevealIx({ payer, owner, nonce, resultClaimNonce: nonce, resultCollectionIdx: 2, randomness: rngPda(RNG_KIND.CLAIM_FUSION, owner, nonce)[0], cgMint: pk(), materials: mats });
    expect(ix.keys.length).toBe(13 + 3);
    expect(ix.keys[3].pubkey.equals(claimFusionPda(owner, nonce)[0])).toBe(true);
    expect(ix.keys[7].pubkey.equals(compressedMintClaimPda(owner, nonce)[0])).toBe(true);
    expect(ix.keys.slice(13).map((k) => k.pubkey.toBase58())).toEqual(mats.map((m) => m.toBase58()));
    expect(hex(ix.data)).toBe(D.fuseClaims + '0700000000000000' + '0700000000000000');
    expect(() => fuseClaimsRevealIx({ payer, owner, nonce, resultClaimNonce: nonce, resultCollectionIdx: 2, randomness: pk(), cgMint: pk(), materials: mats.slice(0, 2) })).toThrow(/exactly 3/);
  });
  it('fuse_reveal: 16 fixed accounts (11 + #12 ledger shard + vault / cg_mint / vault_cg / token program for the SEC-M3 fee burn) + 4 per material; result asset = ["asset", pending, 0, 0]', () => {
    const randomness = rngPda(RNG_KIND.FUSION, owner, nonce)[0];
    const mats = [pk(), pk(), pk()].map((asset, i) => ({ asset, collectionIdx: i === 2 ? 4 : 3 }));
    const core = new Map([[3, pk()], [4, pk()]]);
    const cgMint = pk();
    const ix = fuseRevealIx({ payer, owner, nonce, randomness, resultCollectionIdx: 3, materials: mats, coreCollectionOf: (i) => core.get(i)!, cgMint });
    const pending = pendingFusionPda(owner, nonce)[0];
    expect(ix.keys.length).toBe(16 + 12);
    expect(ix.keys[1].isWritable).toBe(false);
    expect(ix.keys[2].pubkey.equals(ledgerPdaOf(owner)[0]) && ix.keys[2].isWritable).toBe(true);
    expect(ix.keys[8].pubkey.equals(assetPda(pending, 0, 0)[0])).toBe(true);
    expect(ix.keys[12].pubkey.equals(vaultPda()[0]) && ix.keys[12].isWritable).toBe(true);
    expect(ix.keys[13].pubkey.equals(cgMint)).toBe(true);
    expect(ix.keys[16].pubkey.equals(mats[0].asset)).toBe(true);
    expect(ix.keys[26].pubkey.equals(collectionMetaPda(4)[0])).toBe(true);
    expect(ix.keys[27].pubkey.equals(core.get(4)!)).toBe(true);
    expect(hex(ix.data)).toBe(D.fuse + '0700000000000000');
  });
  it('PDAs match the client / on-chain seeds', () => {
    // Derived addresses are pinned by their SEEDS, not by a literal address: `npm run program-ids
    // -- apply` (docs/09 §2) rotates every program id at the freeze commit and with it every
    // address any PDA touches — a golden address would break there without meaning anything, while
    // the seed strings below ARE the contract with the Rust `seeds::` module and with
    // client/src/chain/pdas.ts, so a seed or program-slot rename still fails hard.
    const o = new PublicKey('HPMr5r9sS5ApWsPNJytZRLbm2jz1veFxTn1wepjAhtho');
    const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
    const pda = (seeds: (string | Uint8Array)[], program: PublicKey) =>
      PublicKey.findProgramAddressSync(seeds.map((x) => (typeof x === 'string' ? Buffer.from(x) : Buffer.from(x))), program)[0];
    const CHIP = CHIP_CORE_ID, ARENA = ARENA_ID, SB = SWITCHBOARD_PROGRAM_ID;

    expect(rngAuthPda(RNG_KIND.PACK)[0]).toEqual(pda(['rng_auth'], CHIP));
    expect(rngAuthPda(RNG_KIND.BATTLE)[0]).toEqual(pda(['rng_auth'], ARENA)); // battle randomness lives in arena
    expect(rngPda(RNG_KIND.PACK, o, 7n)[0]).toEqual(pda(['rng', Uint8Array.of(0), o.toBytes(), u64(7n)], CHIP));
    expect(rngPda(RNG_KIND.CLAIM_FUSION, o, 7n)[0]).toEqual(pda(['rng', Uint8Array.of(3), o.toBytes(), u64(7n)], CHIP));
    expect(rngPda(RNG_KIND.BATTLE, o, 7n)[0]).toEqual(pda(['rng', Uint8Array.of(2), o.toBytes(), u64(7n)], ARENA));
    expect(pendingPackPda(o, 7n)[0]).toEqual(pda(['pending', o.toBytes(), u64(7n)], CHIP));
    expect(claimFusionPda(o, 7n)[0]).toEqual(pda(['claim_fusion', o.toBytes(), u64(7n)], CHIP));
    expect(compressedMintClaimPda(o, 7n)[0]).toEqual(pda(['compressed_claim', o.toBytes(), u64(7n)], CHIP));
    expect(compressedSettlementPda(o, 7n)[0]).toEqual(pda(['compressed_settlement', o.toBytes(), u64(7n)], CHIP));
    expect(bubblegumTreeMetaPda(2)[0]).toEqual(pda(['bubblegum_tree', Uint8Array.of(2)], CHIP));
    expect(configPda()[0]).toEqual(pda(['config'], CHIP));
    expect(sbStatePda()[0]).toEqual(pda(['STATE'], SB)); // on-chain seed of Switchboard's state account
  });
  it('raw Switchboard decoders: RandomnessAccountData offsets + OracleAccountData.gateway_uri @3584 (NUL-trimmed)', () => {
    const data = encodeRandomness({ authority: rngAuthPda(RNG_KIND.PACK)[0], queue: pk(), oracle: pk(), seedSlot: 123n, revealSlot: 130n, value: ORACLE_VALUE, lutSlot: 100n });
    expect(hex(data.subarray(0, 8))).toBe('0a42e587dcefd972');
    expect(data.length).toBe(480);
    const r = decodeRandomness(data);
    expect(r.seedSlot).toBe(123n); expect(r.revealSlot).toBe(130n); expect(r.lutSlot).toBe(100n); expect(hex(r.value)).toBe(hex(ORACLE_VALUE));
    expect(r.authority.equals(rngAuthPda(RNG_KIND.PACK)[0])).toBe(true);
    expect(decodeOracleGateway(encodeOracle('https://xyz.switchboard.xyz/'))).toBe('https://xyz.switchboard.xyz/');
    expect(() => decodeOracleGateway(data)).toThrow(/OracleAccountData/);
    expect(() => decodeRandomness(encodeOracle('x'))).toThrow(/RandomnessAccountData/);
  });
  it('packSeed / toEconPack mirror packs.rs open_pack (keccak(value ‖ pack_no) only for bundles; LIVE odds)', () => {
    expect(hex(packSeed(ORACLE_VALUE, 1, 0))).toBe(hex(ORACLE_VALUE));
    expect(hex(packSeed(ORACLE_VALUE, 5, 0))).not.toBe(hex(ORACLE_VALUE));
    expect(hex(packSeed(ORACLE_VALUE, 5, 1))).not.toBe(hex(packSeed(ORACLE_VALUE, 5, 0)));
    const e = toEconPack(1, { ...DEFAULT_PACK, oddsBps: [9_000, 1_000, 0, 0, 0, 0, 0, 0, 0], pityTier: 0 });
    expect(e.oddsBps).toEqual([9_000, 1_000, 0, 0, 0, 0, 0, 0, 0]); expect(e.pity).toBeNull(); expect(e.id).toBe('standard');
    expect(toEconPack(2, DEFAULT_PACK).pity).toEqual({ tier: 6, hardAt: 60, softStart: 30, softStepBps: 25 });
    expect(toEconPack(0, { ...DEFAULT_PACK, dailyCap: 1 }).dailyCap).toBe(1);
    expect(PACKS.standard.chips).toBe(3);
  });
  it('customErrorCode parses messages, logs and confirmTransaction errors; clampCuPrice keeps fee ≤ 0.001 SOL', () => {
    expect(customErrorCode(new Error('failed: custom program error: 0x1775'))).toBe(6005);
    expect(customErrorCode({ message: 'x', logs: ['Program GC failed: custom program error: 0x1780'] })).toBe(6016);
    expect(customErrorCode({ message: '{"InstructionError":[1,{"Custom":6015}]}' })).toBe(6015);
    expect(customErrorCode(new Error('blockhash expired'))).toBeUndefined();
    expect(clampCuPrice(7_000, 700_000)).toBe(7_000);
    expect(clampCuPrice(500, 700_000)).toBe(1_000); // floor
    expect(clampCuPrice(5_000_000, 700_000)).toBe(200_000); // hard cap (200k µlam/CU × 700k CU = 0.00014 SOL, under the budget)
    expect(clampCuPrice(5_000_000, 700_000, { floor: 1_000, cap: 200_000, maxFeeLamports: 100_000 })).toBe(Math.floor((100_000 * 1_000_000) / 700_000)); // budget cap binds
  });
});

describe('crank · oracle gateway', () => {
  it('POSTs the SDK payload {slothash[], randomness_key hex, slot, rpc} and decodes {signature b64, recovery_id, value[]}', async () => {
    let seen: { url: string; body: Record<string, unknown> } | undefined;
    const f = gateway({ onCall: (url, body) => { seen = { url, body: body as Record<string, unknown> }; } });
    const randomness = pk();
    const rnd = decodeRandomness(encodeRandomness({ authority: pk(), queue: pk(), oracle: pk(), seedSlot: 4_000n, seedSlothash: new Uint8Array(32).fill(7) }));
    const r = await fetchGatewayReveal(f, 'https://oracle-1.example.com/', randomness, rnd, 'https://api.devnet.solana.com');
    expect(seen!.url).toBe('https://oracle-1.example.com/gateway/api/v1/randomness_reveal');
    expect(seen!.body).toEqual({ slothash: Array(32).fill(7), randomness_key: hex(randomness.toBytes()), slot: 4000, rpc: 'https://api.devnet.solana.com' });
    expect(hex(r.signature)).toBe(hex(ORACLE_SIG)); expect(r.recoveryId).toBe(1); expect(hex(r.value)).toBe(hex(ORACLE_VALUE));
  });
  it('HTTP / network / malformed answers → GatewayError (retryable, never a tx)', async () => {
    const rnd = decodeRandomness(encodeRandomness({ authority: pk(), queue: pk(), oracle: pk(), seedSlot: 1n }));
    await expect(fetchGatewayReveal(gateway({ fail: 500 }), 'https://g', pk(), rnd, 'r')).rejects.toBeInstanceOf(GatewayError);
    await expect(fetchGatewayReveal(gateway({ fail: 'network' }), 'https://g', pk(), rnd, 'r')).rejects.toThrow(/unreachable/);
    const bad: FetchLike = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ signature: 'AAAA', recovery_id: 0, value: [1, 2] }) });
    await expect(fetchGatewayReveal(bad, 'https://g', pk(), rnd, 'r')).rejects.toThrow(/malformed/);
  });
});

describe('crank · pack pipeline (V2)', () => {
  let w: World;
  beforeEach(() => { w = world(); });

  it('discovers the purchase from the indexer DB, reveals, opens, mints + registers every claim (DAS name match + local V2 preflight), finalizes, reclaims rent', async () => {
    runtime(w);
    const f = gateway();
    const { das, seen } = fakeDas();
    const log: string[] = [];
    const c = new Crank({ connection: asConn(w.conn), payer: w.payer, db: w.db, fetch: f, log: (s) => log.push(s), das });
    expect(await c.tick()).toBe(1);
    expect(f.calls).toBe(1);
    const discs = w.conn.sent.map((t) => t.ixs.slice(2).map((ix) => hex(ix.data.subarray(0, 8))));
    expect(discs[0]).toEqual([D.reveal, D.openC]); // 3-chip open is small enough to ride with the reveal, no LUT needed
    expect(discs.slice(1, 7)).toEqual([[D.mint], [D.register], [D.mint], [D.register], [D.mint], [D.register]]); // per-chip settle
    expect(discs[7]).toEqual([D.finalize]);
    expect(discs[8]).toEqual([D.close]);
    expect(w.conn.sent.length).toBe(9);
    expect(w.conn.sent[0].skipPreflight).toBe(true);
    expect(w.conn.sent[1].skipPreflight).toBe(false);
    const open = w.conn.sent[0].ixs[3];
    // collections passed == expandRandomness(value, live pack, pity=4, pool=10) — what open_compressed_pack re-derives
    const rolls = expandRandomness(ORACLE_VALUE, toEconPack(1, DEFAULT_PACK), 4, 10);
    expect([open.keys[9], open.keys[12], open.keys[15]].map((k) => k.toBase58())).toEqual(rolls.map((r) => collectionMetaPda(r.collectionIdx)[0].toBase58()));
    expect(open.keys[10].equals(bubblegumTreeMetaPda(rolls[0].collectionIdx)[0])).toBe(true);
    // DAS: one resolve per chip, name `{symbol} #{game_index}`, collection = the rolled core
    expect(seen.length).toBe(3);
    expect(seen[0]).toEqual({ owner: w.buyer.toBase58(), collection: w.cores[rolls[0].collectionIdx].toBase58(), name: `COL${rolls[0].collectionIdx} #1` });
    expect(seen[1].name).toBe(`COL${rolls[1].collectionIdx} #2`);
    // register carries the DAS proof (3 nodes) + leaf_index nonce
    const reg = w.conn.sent[2].ixs[2];
    expect(reg.keys.length).toBe(16 + 3);
    expect(reg.keys[4].equals(compressedMintClaimPda(w.buyer, compressedClaimNonce(w.nonce, 0, 0))[0])).toBe(true);
    // state machine
    const job = c.job(jobKey(RNG_KIND.PACK, w.buyer, w.nonce))!;
    expect(job.phase).toBe('closed');
    expect(job.reveal_sig).toBe(w.conn.sent[0].signature);
    expect(JSON.parse(job.settle_sigs).length).toBe(8); // open + 3 mint + 3 register + finalize
    expect(job.close_sig).toBe(w.conn.sent[8].signature);
    expect(w.conn.get(w.pending)).toBeUndefined();
    expect(w.conn.get(compressedSettlementPda(w.buyer, w.nonce)[0])).toBeUndefined();
    expect(w.conn.get(w.randomness)).toBeUndefined();
    expect(c.stats).toMatchObject({ reveals: 1, opens: 1, mints: 3, registers: 3, finalizes: 1, closes: 1, errors: 0 });
    expect(log.some((l) => l.includes('open_compressed_pack') && l.includes('#1/1'))).toBe(true);
    expect(log.some((l) => l.includes('finalize_compressed_pack'))).toBe(true);
    // idempotent: nothing left to do
    expect(await c.tick()).toBe(0);
    expect(w.conn.sent.length).toBe(9);
    expect(crankStatus(w.db)).toMatchObject({ pending: 0, closed: 1, abandoned: 0, healthy: true });
  });

  it('#28 quest chip voucher: discovered from the vouchers table, ONE chip rolled from the template odds (pity ignored); reveal + open share one tx', async () => {
    const voucher = { template: 1, odds: [3000, 5000, 1800, 200, 0, 0, 0, 0, 0], soulboundDays: 7 };
    w = world({ voucher });
    expect(w.db.get(`SELECT status FROM vouchers WHERE wallet = ? AND nonce = '7'`, w.buyer.toBase58())).toEqual({ status: 'pending' });
    expect(w.db.get(`SELECT 1 FROM pack_purchases WHERE buyer = ?`, w.buyer.toBase58())).toBeUndefined(); // never a "purchase"
    runtime(w);
    const { das } = fakeDas();
    const c = new Crank({ connection: asConn(w.conn), payer: w.payer, db: w.db, fetch: gateway(), das });
    expect(await c.tick()).toBe(1);
    // one chip: reveal + open fit ONE tx even without a LUT → [reveal+open, mint, register, finalize, close]
    expect(w.conn.sent.length).toBe(5);
    expect(hex(w.conn.sent[0].ixs[2].data.subarray(0, 8))).toBe(D.reveal);
    const open = w.conn.sent[0].ixs[3];
    expect(hex(open.data.subarray(0, 8))).toBe(D.openC);
    expect(open.keys.length).toBe(8 + 3); // exactly one chip
    // the collection passed == expandRandomness(value, synthetic voucher def, pity irrelevant, pool = all 10)
    const [roll] = expandRandomness(ORACLE_VALUE, voucherEconPack({ voucherOdds: voucher.odds }), 999, 10);
    expect(open.keys[9].equals(collectionMetaPda(roll.collectionIdx)[0])).toBe(true);
    expect(open.keys[10].equals(bubblegumTreeMetaPda(roll.collectionIdx)[0])).toBe(true);
    expect(roll.rarity).toBeLessThanOrEqual(3); // template 1 never rolls above Rare+
    expect(w.conn.sent[0].ixs[0].data.readUInt32LE(1)).toBe(CU.OPEN_COMPRESSED + CU.REVEAL_ONLY); // setComputeUnitLimit(units) = [0x02, u32 le]; combined tx = open budget + reveal
    expect(w.conn.sent[4].ixs.slice(2).map((ix) => hex(ix.data.subarray(0, 8)))).toEqual([D.close]);
    expect(c.job(jobKey(RNG_KIND.PACK, w.buyer, w.nonce))!.phase).toBe('closed');
    expect(c.stats).toMatchObject({ reveals: 1, opens: 1, mints: 1, registers: 1, finalizes: 1, closes: 1, errors: 0 });
    expect(await c.tick()).toBe(0);
  });

  it('bundle ×3 ($CG): reveal only in the first tx, sub-seeds per pack_no, pity re-read between packs, treasury ATA on the finalize', async () => {
    w = world({ qty: 3, paidCg: 750_000_000n });
    const opened: number[] = [];
    runtime(w, { onOpen: (n) => { opened.push(n); w.conn.set(pityPda(w.buyer)[0], encodePlayerPity(w.buyer, [0, 4 + n + 1, 0, 0])); } });
    const { das } = fakeDas();
    const c = new Crank({ connection: asConn(w.conn), payer: w.payer, db: w.db, fetch: gateway(), das });
    await c.tick();
    expect(opened).toEqual([0, 1, 2]);
    expect(w.conn.sent.length).toBe(1 + 2 + 9 + 9 + 1 + 1); // [reveal+open] + 2 opens + 9 mints + 9 registers + finalize + close
    expect(w.conn.sent[0].ixs.slice(2).map((ix) => hex(ix.data.subarray(0, 8)))).toEqual([D.reveal, D.openC]);
    const opens = [w.conn.sent[0].ixs[3], w.conn.sent[1].ixs[2], w.conn.sent[2].ixs[2]];
    expect(w.conn.sent[1].ixs.length).toBe(2 + 1); // open only (no $CG optionals on opens any more)
    expect(w.conn.sent[2].ixs.length).toBe(2 + 1);
    // per-pack seed + pity: pack 1 uses pity 4, pack 2 pity 5 (as the runtime advanced it), pack 3 pity 6
    const econ = toEconPack(1, DEFAULT_PACK);
    for (const [i, openIx] of opens.entries()) {
      expect(openIx.data[16]).toBe(i);
      const rolls = expandRandomness(packSeed(ORACLE_VALUE, 3, i), econ, 4 + i, 10);
      expect(openIx.keys[9].equals(collectionMetaPda(rolls[0].collectionIdx)[0])).toBe(true);
    }
    const fin = w.conn.sent[w.conn.sent.length - 2];
    expect(fin.ixs.length).toBe(2 + 2); // create ATA (treasury $CG) + finalize
    expect(fin.ixs[2].programId.toBase58()).toBe('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    expect(hex(fin.ixs[3].data.subarray(0, 8))).toBe(D.finalize);
    expect(c.job(jobKey(RNG_KIND.PACK, w.buyer, w.nonce))!.phase).toBe('closed');
    expect(c.stats).toMatchObject({ opens: 3, mints: 9, registers: 9, finalizes: 1 });
  });

  it('resumes a half-opened bundle from PendingPack.value without touching the oracle (SEC-C2)', async () => {
    w = world({ qty: 2, revealed: true });
    w.conn.set(w.pending, encodePendingPack({ buyer: w.buyer, sku: 1, qty: 2, opened: 1, randomness: w.randomness, commitSlot: w.commitSlot, nonce: w.nonce, revealed: true, value: ORACLE_VALUE }));
    emulateOpen(w, w.buyer, w.nonce, 0, [1, 1, 1]); // pack 0 was opened before the crank existed…
    for (let i = 0; i < 3; i++) { // …and its claims already registered
      const ck = compressedMintClaimPda(w.buyer, compressedClaimNonce(w.nonce, 0, i))[0];
      w.conn.set(ck, encodeCompressedMintClaim({ ...claimFields(decodeCompressedMintClaim(w.conn.get(ck)!)), minted: true, registered: true }));
    }
    const sk = compressedSettlementPda(w.buyer, w.nonce)[0];
    w.conn.set(sk, encodeCompressedPackSettlement({ buyer: w.buyer, pending: w.pending, nonce: w.nonce, totalClaims: 3, registeredClaims: 3 }));
    runtime(w);
    const f = gateway();
    const { das } = fakeDas();
    const c = new Crank({ connection: asConn(w.conn), payer: w.payer, db: w.db, fetch: f, das });
    await c.tick();
    expect(f.calls).toBe(0);
    expect(w.conn.sent[0].ixs.length).toBe(2 + 1);
    expect(w.conn.sent[0].ixs[2].data[16]).toBe(1); // pack_no 1
    expect(w.conn.sent[0].skipPreflight).toBe(false);
    expect(c.stats).toMatchObject({ reveals: 0, opens: 1, mints: 3, registers: 3, finalizes: 1, closes: 1 });
  });

  it('already revealed on chain (player / other worker) → no gateway call, straight into the V2 pipeline', async () => {
    w.conn.set(w.randomness, encodeRandomness({ authority: rngAuthPda(RNG_KIND.PACK)[0], queue: w.queue, oracle: w.oracle, seedSlot: w.commitSlot, revealSlot: 4_005n, value: ORACLE_VALUE }), SB_OWNER);
    runtime(w);
    const f = gateway();
    const { das } = fakeDas();
    const c = new Crank({ connection: asConn(w.conn), payer: w.payer, db: w.db, fetch: f, das });
    await c.tick();
    expect(f.calls).toBe(0);
    expect(hex(w.conn.sent[0].ixs[2].data.subarray(0, 8))).toBe(D.openC);
    expect(c.job(jobKey(RNG_KIND.PACK, w.buyer, w.nonce))!.phase).toBe('closed');
  });

  it('finalize waits (no burned attempts) while a claim is expired-unminted; proceeds after the buyer cancels', async () => {
    w.conn.set(w.pending, encodePendingPack({ buyer: w.buyer, sku: 1, qty: 1, opened: 1, randomness: w.randomness, commitSlot: w.commitSlot, nonce: w.nonce, revealed: true, value: ORACLE_VALUE }));
    emulateOpen(w, w.buyer, w.nonce, 0, [1, 2, 3]);
    for (const i of [0, 2]) { // two claims registered; the middle one expired before anyone minted it
      const ck = compressedMintClaimPda(w.buyer, compressedClaimNonce(w.nonce, 0, i))[0];
      w.conn.set(ck, encodeCompressedMintClaim({ ...claimFields(decodeCompressedMintClaim(w.conn.get(ck)!)), minted: true, registered: true }));
    }
    const expiredKey = compressedMintClaimPda(w.buyer, compressedClaimNonce(w.nonce, 0, 1))[0];
    w.conn.set(expiredKey, encodeCompressedMintClaim({ ...claimFields(decodeCompressedMintClaim(w.conn.get(expiredKey)!)), expiresAt: 1_000n }));
    const sk = compressedSettlementPda(w.buyer, w.nonce)[0];
    w.conn.set(sk, encodeCompressedPackSettlement({ buyer: w.buyer, pending: w.pending, nonce: w.nonce, totalClaims: 3, registeredClaims: 2 }));
    runtime(w);
    const { das, seen } = fakeDas();
    let now = 11_000_000_000; // 2008 in ms → way past expires_at 1000 s
    const log: string[] = [];
    const c = new Crank({ connection: asConn(w.conn), payer: w.payer, db: w.db, fetch: gateway(), das, log: (s) => log.push(s), now: () => now });
    expect(await c.tick()).toBe(1);
    let job = c.job(jobKey(RNG_KIND.PACK, w.buyer, w.nonce))!;
    expect(job.phase).toBe('pending'); // NOT settled: finalize is gated on the outstanding claim
    expect(job.attempts).toBe(0); // waiting is not failing
    expect(job.next_at).toBe(now + 30_000);
    expect(seen.length).toBe(0); // no mint, no DAS resolve for the expired claim
    expect(w.conn.sent.length).toBe(0);
    expect(log.some((l) => l.includes('2/3 claims settled'))).toBe(true);
    // the buyer cancels the expired claim from the app → claim closed, cancelled +1
    w.conn.del(expiredKey);
    w.conn.set(sk, encodeCompressedPackSettlement({ buyer: w.buyer, pending: w.pending, nonce: w.nonce, totalClaims: 3, registeredClaims: 2, cancelledClaims: 1 }));
    now += 30_001;
    await c.tick();
    job = c.job(job.key)!;
    expect(job.phase).toBe('closed');
    expect(w.conn.sent.map((t) => hex(t.ixs[2].data.subarray(0, 8)))).toEqual([D.finalize, D.close]);
    expect(c.stats).toMatchObject({ finalizes: 1, closes: 1, errors: 0 });
  });

  it('oracle not ready → GatewayError, exponential backoff, no transaction; later success', async () => {
    runtime(w);
    let now = 1_000_000;
    let ready = false;
    const f: FetchLike = async (url, init) => (ready ? gateway()(url, init) : { ok: false, status: 404, text: async () => 'not yet' });
    const { das } = fakeDas();
    const log: string[] = [];
    const c = new Crank({ connection: asConn(w.conn), payer: w.payer, db: w.db, fetch: f, das, log: (s) => log.push(s), now: () => now });
    await c.tick();
    let job = c.job(jobKey(RNG_KIND.PACK, w.buyer, w.nonce))!;
    expect(job.phase).toBe('pending'); expect(job.attempts).toBe(1); expect(job.next_at).toBe(now + 1_000); expect(job.last_error).toMatch(/gateway 404/);
    expect(w.conn.sent.length).toBe(0);
    expect(await c.tick()).toBe(0); // not due yet
    now += 1_001;
    await c.tick();
    job = c.job(job.key)!;
    expect(job.attempts).toBe(2); expect(job.next_at).toBe(now + 2_000);
    expect(c.stats.gatewayErrors).toBe(2);
    now += 2_001; ready = true;
    await c.tick();
    expect(c.job(job.key)!.phase).toBe('closed');
    expect(crankStatus(w.db, now)).toMatchObject({ closed: 1, healthy: true });
  });

  it('refund window open + oracle silent → phase stale (never cancels for the player), re-checked later; rent reclaimed after the refund', async () => {
    runtime(w);
    w.conn.slot = Number(w.commitSlot) + STALE_PACK_SLOTS + 1;
    let now = 5_000_000;
    const log: string[] = [];
    const { das } = fakeDas();
    const c = new Crank({ connection: asConn(w.conn), payer: w.payer, db: w.db, fetch: gateway({ fail: 404 }), das, log: (s) => log.push(s), now: () => now });
    await c.tick();
    let job = c.job(jobKey(RNG_KIND.PACK, w.buyer, w.nonce))!;
    expect(job.phase).toBe('stale');
    expect(job.next_at).toBe(now + 10 * 60_000);
    expect(w.conn.sent.length).toBe(0);
    expect(log.some((l) => /stale/.test(l))).toBe(true);
    // the buyer calls cancel_stale_pack from the app → PendingPack gone; the crank returns rent
    w.conn.del(w.pending);
    now += 10 * 60_000 + 1;
    await c.tick();
    job = c.job(job.key)!;
    expect(job.phase).toBe('closed');
    expect(w.conn.sent.length).toBe(1);
    expect(hex(w.conn.sent[0].ixs[2].data.subarray(0, 8))).toBe(D.close);
    expect(w.conn.get(w.randomness)).toBeUndefined();
  });

  it('lost the race: another opener ran open_compressed_pack(0) (InvalidQuantity) → re-reads and finishes the rest of the bundle', async () => {
    w = world({ qty: 2 });
    runtime(w);
    const { das } = fakeDas();
    const c = new Crank({ connection: asConn(w.conn), payer: w.payer, db: w.db, fetch: gateway(), das });
    // between our reveal and our open(0), "someone" opened pack 0 → our open fails with InvalidQuantity
    const realOnTx = w.conn.onTx;
    let injected = false;
    w.conn.onTx = (ixs) => {
      const isOpen = ixs.some((ix) => ix.data.subarray(0, 8).equals(ixDiscriminator('open_compressed_pack')));
      if (isOpen && !injected) {
        injected = true;
        // "someone" revealed and opened pack 0 between our read and our send
        const cur = decodeRandomness(w.conn.get(w.randomness)!);
        w.conn.set(w.randomness, encodeRandomness({ authority: cur.authority, queue: cur.queue, oracle: cur.oracle, seedSlot: cur.seedSlot, revealSlot: BigInt(w.conn.slot), value: ORACLE_VALUE, lutSlot: cur.lutSlot }), SB_OWNER);
        w.conn.set(w.pending, encodePendingPack({ buyer: w.buyer, sku: 1, qty: 2, opened: 1, randomness: w.randomness, commitSlot: w.commitSlot, nonce: w.nonce, revealed: true, value: ORACLE_VALUE }));
        emulateOpen(w, w.buyer, w.nonce, 0, [1, 2, 3]); // their open materialized pack-0 claims
        throw new ProgramError(6005, 2);
      }
      realOnTx(ixs);
    };
    await c.tick();
    const job = c.job(jobKey(RNG_KIND.PACK, w.buyer, w.nonce))!;
    expect(job.phase).toBe('closed');
    expect(c.stats.errors).toBe(0);
    // sent: failed [reveal+open] (pack 0), open pack 1, 6× (mint+register), finalize, close
    expect(w.conn.sent.length).toBe(1 + 1 + 12 + 1 + 1);
    expect(w.conn.sent[0].err?.code).toBe(6005);
    expect(w.conn.sent[1].ixs[2].data[16]).toBe(1);
    expect(c.stats.opens).toBe(1); // our open; pack 0 was theirs
    expect(c.stats).toMatchObject({ mints: 6, registers: 6, finalizes: 1 });
  });

  it('a genuine program error backs off, and repeated failure parks the job as abandoned with an alert', async () => {
    runtime(w, { failOpenWith: 6019 /* InvalidCollection */ });
    let now = 9_000_000;
    const log: string[] = [];
    const { das } = fakeDas();
    const c = new Crank({ connection: asConn(w.conn), payer: w.payer, db: w.db, fetch: gateway(), das, log: (s) => log.push(s), now: () => now });
    await c.tick();
    let job = c.job(jobKey(RNG_KIND.PACK, w.buyer, w.nonce))!;
    expect(job.phase).toBe('pending'); expect(job.attempts).toBe(1); expect(job.last_error).toMatch(/custom 6019/);
    for (let i = 0; i < 70 && job.phase !== 'abandoned'; i++) { now = job.next_at + 1; await c.tick(); job = c.job(job.key)!; }
    expect(job.phase).toBe('abandoned');
    expect(job.attempts).toBe(60);
    expect(log.some((l) => l.includes('ALERT') && l.includes('abandoned'))).toBe(true);
    expect(crankStatus(w.db, now).healthy).toBe(false);
    // abandoned jobs are retried once an hour (the parked next_at) — the program may have been fixed
    now = job.next_at + 1;
    runtime(w);
    await c.tick();
    expect(c.job(job.key)!.phase).toBe('closed');
  });

  it('payer below the hard floor → nothing is sent and the gateway is not called; job parked 30 s; alert once below the soft threshold', async () => {
    runtime(w);
    w.conn.balanceLamports = 10_000_000; // 0.01 SOL < 0.05 floor
    const log: string[] = [];
    const f = gateway();
    const { das } = fakeDas();
    let now = 3_000_000;
    const c = new Crank({ connection: asConn(w.conn), payer: w.payer, db: w.db, fetch: f, das, log: (s) => log.push(s), now: () => now });
    await c.tick();
    expect(w.conn.sent.length).toBe(0);
    expect(f.calls).toBe(0);
    const job = c.job(jobKey(RNG_KIND.PACK, w.buyer, w.nonce))!;
    expect(job.phase).toBe('pending');
    expect(job.next_at).toBe(now + 30_000);
    expect(log.filter((l) => l.includes('ALERT payer')).length).toBe(1);
    // topped up → proceeds normally
    w.conn.balanceLamports = 1_000_000_000; now += 60_001;
    await c.tick();
    expect(c.job(job.key)!.phase).toBe('closed');
  });

  it('on-chain sweep discovers packs/fusions/battles the DB never saw, and history rows only get a rent reclaim', async () => {
    w = world({ withDbRow: false });
    runtime(w);
    const { das } = fakeDas();
    // an old purchase in the DB that was opened before the crank existed: randomness still on chain → close only
    const oldBuyer = pk(), oldNonce = 3n;
    const [oldRng] = rngPda(RNG_KIND.PACK, oldBuyer, oldNonce);
    w.conn.set(oldRng, encodeRandomness({ authority: rngAuthPda(RNG_KIND.PACK)[0], queue: w.queue, oracle: w.oracle, seedSlot: 100n, revealSlot: 105n, value: ORACLE_VALUE, lutSlot: 90n }), SB_OWNER);
    ingestTx(tx([{ program: 'chip_core', name: 'PackBought', data: { buyer: oldBuyer.toBase58(), sku: 1, qty: 1, currency: 0, amount: '1', nonce: '3', randomness: oldRng.toBase58() } }]), w.db);
    ingestTx(tx([{ program: 'chip_core', name: 'PackOpened', data: { buyer: oldBuyer.toBase58(), sku: 1, nonce: '3', assets: [pk().toBase58(), pk().toBase58(), pk().toBase58(), PublicKey.default.toBase58(), PublicKey.default.toBase58()], rarities: [0, 0, 1, 0, 0], collections: [1, 2, 3, 0, 0], count: 3, roll: 'ab'.repeat(32), pityBefore: 0, pityAfter: 1 } }]), w.db);
    const c = new Crank({ connection: asConn(w.conn), payer: w.payer, db: w.db, fetch: gateway(), das });
    expect(await c.tick()).toBe(1); // only the history row (no sweep yet) → close_randomness
    expect(w.conn.get(oldRng)).toBeUndefined();
    expect(c.job(jobKey(RNG_KIND.PACK, oldBuyer, oldNonce))!.phase).toBe('closed');
    // with the sweep, the DB-less pending pack is found and opened
    await c.tick({ sweep: true });
    expect(c.job(jobKey(RNG_KIND.PACK, w.buyer, w.nonce))!.phase).toBe('closed');
    expect(c.stats.opens).toBe(1);
  });
});

describe('crank · fusions and wagers', () => {
  it('fusion: reveal + fuse_reveal with materials\' collections from ChipState, then rent reclaim', async () => {
    const w = world({ withDbRow: false });
    runtime(w);
    w.conn.del(w.pending); w.conn.del(w.randomness);
    const owner = pk(), nonce = 11n;
    const [pending] = pendingFusionPda(owner, nonce);
    const [randomness] = rngPda(RNG_KIND.FUSION, owner, nonce);
    const mats = [pk(), pk(), pk()];
    mats.forEach((m, i) => w.conn.set(chipStatePda(m)[0], encodeChipState(m, i === 1 ? 5 : 2, 4)));
    w.conn.set(pending, encodePendingFusion({ owner, recipe: 4, materials: mats, resultCollectionIdx: 2, randomness, commitSlot: 4_100n, nonce }));
    w.conn.set(randomness, encodeRandomness({ authority: rngAuthPda(RNG_KIND.FUSION)[0], queue: w.queue, oracle: w.oracle, seedSlot: 4_100n }), SB_OWNER);
    const c = new Crank({ connection: asConn(w.conn), payer: w.payer, db: w.db, fetch: gateway() });
    await c.tick({ sweep: true });
    const job = c.job(jobKey(RNG_KIND.FUSION, owner, nonce))!;
    expect(job.phase).toBe('closed');
    const fuseTxs = w.conn.sent.filter((t) => t.ixs.some((ix) => hex(ix.data.subarray(0, 8)) === D.fuse));
    expect(fuseTxs.length).toBe(1);
    const fuse = fuseTxs[0].ixs[2];
    const revealIdx = w.conn.sent.findIndex((t) => hex(t.ixs[2].data.subarray(0, 8)) === D.reveal);
    expect(revealIdx).toBeGreaterThanOrEqual(0);
    expect(revealIdx).toBeLessThan(w.conn.sent.indexOf(fuseTxs[0])); // reveal lands before the settle
    expect(fuse.keys[6].equals(collectionMetaPda(2)[0])).toBe(true);
    expect(fuse.keys[7].equals(w.cores[2])).toBe(true);
    expect(fuse.keys[16 + 4 + 2].equals(collectionMetaPda(5)[0])).toBe(true); // material 1 in collection 5 (16 fixed keys since SEC-M3 + #12)
    expect(fuse.keys[16 + 4 + 3].equals(w.cores[5])).toBe(true);
    expect(c.stats.fusions).toBe(1);
    expect(w.conn.get(randomness)).toBeUndefined();
  });

  it('claim fusion: sweep discovers PendingClaimFusion, reveal (kind 3) + fuse_claims_reveal with result nonce == commit nonce, then rent reclaim', async () => {
    const w = world({ withDbRow: false });
    runtime(w);
    w.conn.del(w.pending); w.conn.del(w.randomness);
    const owner = pk(), nonce = 11n;
    const [pending] = claimFusionPda(owner, nonce);
    const [randomness] = rngPda(RNG_KIND.CLAIM_FUSION, owner, nonce);
    const mats = [compressedMintClaimPda(owner, 101n)[0], compressedMintClaimPda(owner, 102n)[0], compressedMintClaimPda(owner, 103n)[0]];
    mats.forEach((m, i) => w.conn.set(m, encodeCompressedMintClaim({ buyer: owner, collectionIdx: i, minted: true, registered: true })));
    w.conn.set(pending, encodePendingClaimFusion({ owner, recipe: 4, materials: mats, resultCollectionIdx: 2, randomness, commitSlot: 4_100n, nonce }));
    w.conn.set(randomness, encodeRandomness({ authority: rngAuthPda(RNG_KIND.CLAIM_FUSION)[0], queue: w.queue, oracle: w.oracle, seedSlot: 4_100n }), SB_OWNER);
    const c = new Crank({ connection: asConn(w.conn), payer: w.payer, db: w.db, fetch: gateway() });
    await c.tick({ sweep: true });
    const job = c.job(jobKey(RNG_KIND.CLAIM_FUSION, owner, nonce))!;
    expect(job.phase).toBe('closed');
    const fuseTxs = w.conn.sent.filter((t) => t.ixs.some((ix) => hex(ix.data.subarray(0, 8)) === D.fuseClaims));
    expect(fuseTxs.length).toBe(1);
    const fuse = fuseTxs[0].ixs.find((ix) => hex(ix.data.subarray(0, 8)) === D.fuseClaims)!; // rides with the reveal in tx 0
    expect(hex(fuse.data)).toBe(D.fuseClaims + '0b00000000000000' + '0b00000000000000'); // result nonce == commit nonce
    expect(fuse.keys[3].equals(pending)).toBe(true);
    expect(fuse.keys[7].equals(compressedMintClaimPda(owner, nonce)[0])).toBe(true);
    expect(c.stats.claimFusions).toBe(1);
    expect(w.conn.get(randomness)).toBeUndefined();
  });

  it('wager: reveal_battle_randomness only (the battle oracle resolves), then close after Resolved/Cancelled', async () => {
    const w = world({ withDbRow: false });
    runtime(w);
    w.conn.del(w.pending); w.conn.del(w.randomness);
    const challenger = pk(), nonce = 21n;
    const [battle] = battlePda(challenger, nonce);
    const [randomness] = rngPda(RNG_KIND.BATTLE, challenger, nonce);
    w.conn.set(battle, encodeWagerBattle({ challenger, opponent: pk(), randomness, commitSlot: 4_200n, status: 1, nonce }), ARENA_ID);
    w.conn.set(randomness, encodeRandomness({ authority: rngAuthPda(RNG_KIND.BATTLE)[0], queue: w.queue, oracle: w.oracle, seedSlot: 4_200n }), SB_OWNER);
    let now = 7_000_000;
    const c = new Crank({ connection: asConn(w.conn), payer: w.payer, db: w.db, fetch: gateway(), now: () => now });
    await c.tick({ sweep: true });
    let job = c.job(jobKey(RNG_KIND.BATTLE, challenger, nonce))!;
    expect(job.phase).toBe('pending');
    expect(w.conn.sent.length).toBe(1);
    expect(hex(w.conn.sent[0].ixs[2].data.subarray(0, 8))).toBe(D.revealB);
    expect(w.conn.sent[0].ixs[2].programId.equals(ARENA_ID)).toBe(true);
    expect(decodeRandomness(w.conn.get(randomness)!).revealSlot).toBeGreaterThan(0n);
    expect(job.next_at).toBe(now + 30_000);
    // still Accepted → nothing more (no cancel: only the players may)
    now += 30_001; await c.tick();
    expect(w.conn.sent.length).toBe(1);
    // oracle resolved it
    w.conn.set(battle, encodeWagerBattle({ challenger, opponent: pk(), randomness, commitSlot: 4_200n, status: 2, nonce }), ARENA_ID);
    now += 30_001; await c.tick();
    job = c.job(job.key)!;
    expect(job.phase).toBe('closed');
    expect(hex(w.conn.sent[1].ixs[2].data.subarray(0, 8))).toBe(D.closeB);
    expect(w.conn.get(randomness)).toBeUndefined();
  });

  it('with our static lookup table reveal + open_compressed_pack ×5 fit one transaction; without it they are split (docs/06 §4.2 вывод 3)', async () => {
    const w = world({ qty: 1, sku: 2, paidCg: 1_000_000n });
    runtimeLut(w); // data-driven emulation: the fake chain cannot resolve LUT account keys
    const { das } = fakeDas();
    const lut = new AddressLookupTableAccount({ key: pk(), state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [
      CHIP_CORE_ID, MPL_CORE_ID, MPL_BUBBLEGUM_V2_ID, MPL_ACCOUNT_COMPRESSION_ID, MPL_NOOP_ID, TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, SYSVAR_SLOT_HASHES_ID, WSOL_MINT, ASSOCIATED_TOKEN_PROGRAM_ID, SB_OWNER, sbStatePda()[0], rngAuthPda(RNG_KIND.PACK)[0],
      configPda()[0], vaultPda()[0], ...allLedgerPdas(), w.queue, w.treasury, w.cgMint, ...w.cores, ...w.cores.map((_, i) => collectionMetaPda(i)[0]),
    ] } });
    const c = new Crank({ connection: asConn(w.conn), payer: w.payer, db: w.db, fetch: gateway(), das, lookupTables: [lut] });
    await c.tick();
    const t = w.conn.sent[0];
    expect(t.skipPreflight).toBe(true);
    expect(t.ixs.map((ix) => hex(ix.data.subarray(0, 8)).slice(0, 16))).toEqual(expect.arrayContaining([D.reveal, D.openC]));
    expect(c.job(jobKey(RNG_KIND.PACK, w.buyer, w.nonce))!.phase).toBe('closed');
    expect(c.stats).toMatchObject({ opens: 1, mints: 5, registers: 5, finalizes: 1 });
    // without a LUT a 5-chip open does not fit with the reveal → split, everything still closes
    const w2 = world({ qty: 1, sku: 2, paidCg: 1_000_000n });
    runtime(w2);
    const d2 = fakeDas();
    const c2 = new Crank({ connection: asConn(w2.conn), payer: w2.payer, db: w2.db, fetch: gateway(), das: d2.das });
    await c2.tick();
    expect(hex(w2.conn.sent[0].ixs[2].data.subarray(0, 8))).toBe(D.reveal);
    expect(hex(w2.conn.sent[1].ixs[2].data.subarray(0, 8))).toBe(D.openC);
    expect(c2.job(jobKey(RNG_KIND.PACK, w2.buyer, w2.nonce))!.phase).toBe('closed');
  });

  it('a register with a 30-node proof does not fit without a LUT → clear, retryable LOOKUP_TABLE error (never a silent stall)', async () => {
    const w = world({ qty: 1, sku: 1 });
    runtime(w);
    const { das } = fakeDas({ depth: 30 }); // canopied path: local preflight skips (30 ≠ maxDepth 3), the tx still must fit
    const log: string[] = [];
    const c = new Crank({ connection: asConn(w.conn), payer: w.payer, db: w.db, fetch: gateway(), das, log: (s) => log.push(s) });
    await c.tick();
    const discs = w.conn.sent.map((t) => t.ixs.slice(2).map((ix) => hex(ix.data.subarray(0, 8))));
    expect(discs[0]).toEqual([D.reveal, D.openC]);
    expect(discs[1]).toEqual([D.mint]); // chip 0 mints, then its 46-key register does not fit
    expect(w.conn.sent.length).toBe(2); // the oversized register is never sent
    const job = c.job(jobKey(RNG_KIND.PACK, w.buyer, w.nonce))!;
    expect(job.phase).toBe('pending');
    expect(job.last_error).toMatch(/LOOKUP_TABLE/);
    expect(job.reveal_sig).toBe(w.conn.sent[0].signature);
  });

  it('CU limits: compressed open is the largest step; reveal-only and close are small', () => {
    expect(CU.OPEN_COMPRESSED).toBeLessThanOrEqual(1_400_000);
    expect(CU.REGISTER_COMPRESSED).toBeLessThanOrEqual(CU.OPEN_COMPRESSED);
    expect(CU.MINT_COMPRESSED).toBeLessThanOrEqual(CU.OPEN_COMPRESSED);
    expect(CU.FINALIZE_COMPRESSED).toBeLessThan(CU.REGISTER_COMPRESSED);
    expect(CU.REVEAL_ONLY).toBeLessThan(CU.FUSE_REVEAL);
    expect(CU.CLAIM_FUSION_REVEAL).toBe(CU.FUSE_REVEAL);
    expect(CU.CLOSE).toBeLessThanOrEqual(200_000);
  });
  // ------------------------------------------------------------------ backlog #23: the lookup-table half
  it('close_randomness_lut: pins the LutSigner + ALT addresses, copies the slot into the data, keeps the payer out of the rent', () => {
    const kind = RNG_KIND.PACK;
    const player = pk(), payer = Keypair.generate().publicKey, owner = player, nonce = 5n;
    const lutSlot = 77n;
    const ix = closeRandomnessLutIx({ kind, payer, owner, nonce, lutSlot });
    const randomness = rngPda(kind, owner, nonce)[0];
    const lutSigner = sbLutSignerPda(randomness)[0];
    expect(ix.programId.equals(CHIP_CORE_ID)).toBe(true);
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([
      payer.toBase58(), owner.toBase58(), randomness.toBase58(), pendingPackPda(owner, nonce)[0].toBase58(),
      lutSigner.toBase58(), sbLutPda(lutSigner, lutSlot)[0].toBase58(), SWITCHBOARD_PROGRAM_ID.toBase58(),
      ADDRESS_LOOKUP_TABLE_PROGRAM_ID.toBase58(),
    ]);
    expect(ix.keys[0].isSigner).toBe(true);
    // the only account that receives lamports on chain is `owner` (Switchboard's `recipient`)
    expect(ix.keys[1].isWritable).toBe(true);
    expect(ix.keys[5].isWritable).toBe(true); // the ALT (closed → rent to recipient)
    expect(ix.keys[4].isWritable).toBe(false);
    expect(hex(ix.data)).toBe(D.closeLut + '00' + '0500000000000000' + '4d00000000000000');
    const battle = closeRandomnessLutIx({ kind: RNG_KIND.BATTLE, payer, owner, nonce, lutSlot });
    expect(battle.programId.equals(ARENA_ID)).toBe(true);
    expect(battle.keys[3].pubkey.equals(battlePda(owner, nonce)[0])).toBe(true); // arena pins the settled battle instead
    expect(hex(battle.data)).toBe(D.closeLutB + '0500000000000000' + '4d00000000000000');
    expect(() => closeRandomnessLutIx({ kind, payer, owner, nonce, lutSlot })).not.toThrow();
  });

  it('the crank records the lookup-table slot while the randomness account still exists', async () => {
    const w = world();
    runtime(w);
    const c = new Crank({ connection: asConn(w.conn), payer: w.payer, db: w.db, fetch: gateway(), das: fakeDas().das });
    c.upsertJob(RNG_KIND.PACK, w.buyer, w.nonce, w.randomness, w.pending, 'pending', Number(w.commitSlot));
    expect(c.job(jobKey(RNG_KIND.PACK, w.buyer, w.nonce))!.lut_slot).toBeNull();
    const expected = Number(w.commitSlot - 10n); // encodeRandomness defaults lutSlot = seedSlot − 10
    expect(await c.recordLutSlot(c.job(jobKey(RNG_KIND.PACK, w.buyer, w.nonce))!)).toBe(expected);
    expect(c.job(jobKey(RNG_KIND.PACK, w.buyer, w.nonce))!.lut_slot).toBe(expected);
    // a request whose account is already gone records nothing (and must not throw)
    w.conn.del(w.randomness);
    const job = { ...c.job(jobKey(RNG_KIND.PACK, w.buyer, w.nonce))!, lut_slot: null };
    expect(await c.recordLutSlot(job)).toBeNull();
  });

  it('reclaimLuts closes the table of finished jobs only: after the cooldown, once, and never for live work', async () => {
    const w = world();
    runtime(w);
    let now = 1_000_000_000;
    const c = new Crank({ connection: asConn(w.conn), payer: w.payer, db: w.db, fetch: gateway(), das: fakeDas().das, now: () => now, log: (s) => log.push(s) });
    const log: string[] = [];
    // three closed jobs: one old enough, one inside the cooldown, one without a recorded slot
    const mk = (buyer: PublicKey, n: bigint, lutSlot: number | null, older: boolean) => {
      c.upsertJob(RNG_KIND.PACK, buyer, n, pk(), pendingPackPda(buyer, n)[0], 'closed', 10, lutSlot);
      if (older) w.db.run(`UPDATE crank_jobs SET updated_at = ? WHERE key = ?`, now - 90_000_000, jobKey(RNG_KIND.PACK, buyer, n));
    };
    const b1 = pk(), b2 = pk(), b3 = pk();
    mk(b1, 1n, 9, true);
    mk(b2, 2n, 9, false);   // just closed → cooldown not over
    mk(b3, 3n, null, true); // slot unknown → nothing to close
    const before = w.conn.sent.length;
    expect(await c.reclaimLuts(25, 43_200_000)).toBe(1);
    const sent = w.conn.sent.slice(before);
    expect(sent.length).toBe(1);
    const ix0 = sent[0].ixs.find((ix) => hex(ix.data.subarray(0, 8)) === D.closeLut)!;
    expect(ix0).toBeDefined();
    expect(ix0.keys[1].equals(b1)).toBe(true); // rent recipient = the player
    const j1 = c.job(jobKey(RNG_KIND.PACK, b1, 1n))!;
    expect(j1.lut_closed_at).toBe(now);
    expect(c.job(jobKey(RNG_KIND.PACK, b2, 2n))!.lut_closed_at).toBeNull();
    expect(c.job(jobKey(RNG_KIND.PACK, b3, 3n))!.lut_closed_at).toBeNull();
    expect(c.stats.lutCloses).toBe(1);
    // idempotent: the reclaimed job is never attempted again
    expect(await c.reclaimLuts(25, 43_200_000)).toBe(0);
    // a rejection (cooldown still running on the ALT) only re-queues the job
    now += 90_000_000;
    w.conn.onTx = (ixs) => { if (ixs.some((ix) => hex(ix.data.subarray(0, 8)) === D.closeLut)) throw new ProgramError(3005 /* ALT: slot still active */, 0); };
    expect(await c.reclaimLuts(25, 43_200_000)).toBe(0);
    expect(c.job(jobKey(RNG_KIND.PACK, b2, 2n))!.lut_closed_at).toBeNull();
    expect(log.some((l) => l.includes('close_randomness_lut') && l.includes('deferred'))).toBe(true);
  });

  it('the sweep runs the reclaim pass alongside the rest of the maintenance work', async () => {
    const w = world();
    runtime(w);
    let now = 1_000_000_000;
    const log: string[] = [];
    const c = new Crank({ connection: asConn(w.conn), payer: w.payer, db: w.db, fetch: gateway(), das: fakeDas().das, now: () => now, log: (s) => log.push(s) });
    const b = pk();
    c.upsertJob(RNG_KIND.PACK, b, 5n, pk(), pendingPackPda(b, 5n)[0], 'closed', 10, 12);
    w.db.run(`UPDATE crank_jobs SET updated_at = ? WHERE key = ?`, now - 90_000_000, jobKey(RNG_KIND.PACK, b, 5n));
    w.conn.set(configPda()[0], encodeGameConfig({ treasury: pk(), cgMint: pk(), collectionsCreated: 10 }));
    await c.tick({ sweep: true });
    const data = w.conn.sent.flatMap((t) => t.ixs.map((ix) => hex(ix.data.subarray(0, 8))));
    expect(data).toContain(D.closeLut);
    expect(log.some((l) => l.includes('reclaimed 1 lookup table'))).toBe(true);
    now += 1_000;
  });

});
