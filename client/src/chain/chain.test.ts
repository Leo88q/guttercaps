import { describe, it, expect } from 'vitest';
import { AddressLookupTableAccount, Keypair, PublicKey } from '@solana/web3.js';
import { PACKS, expandRandomness, uniformBps } from '@guttercaps/economy';
import golden from '../../../packages/economy/golden/pack_expand.json';
import { BorshReader, BorshWriter, u64le } from './borsh';
import { accountDiscriminator, ixDiscriminator, eventsFromLogs, findEvent, optional, parseCustomError, concat, eventDiscriminator } from './anchor';
import {
  decodeChipState, decodeGameConfig, decodePendingPack, decodePendingClaimFusion, decodePlayerPity, decodeListing, decodeTokenStake, decodeVaultLedger, decodeCompressedAssetListing, decodeCompressedPackSettlement, decodeCompressedMintClaim, sumLedgers, readPackOpened, readCompressedClaimsCreated, readCompressedPackSettled, readClaimFusionRevealed, chipIsFree, claimIsListable, CHIP_FLAG,
} from './accounts';
import { vaultPda, assetPda, chipStatePda, collectionMetaPda, configPda, pendingPackPda, claimFusionPda, compressedMintClaimPda, compressedSettlementPda, bubblegumTreeConfigPda, pityPda, pendingFusionPda, battlePda, ata, freshNonce, rewardRootPda, rewarderPda, playerItemsPda, skrPoolPda, emissionPda, seasonPoolAuthPda, RNG_KIND, rngAuthPda, rngPda, sbLutPda, sbLutSignerPda, sbStatePda, sbOracleStatsPda, sbRewardEscrow, LEDGER_SHARDS, allLedgerPdas, ledgerPda, ledgerPdaOf, ledgerShardOf } from './pdas';
import { fitsInTx } from './tx';
import { buyPackIx, openPackIx, payServiceIx, Currency, fuseIx, mintCompressedChipIx, createBubblegumTreeIx, openCompressedPackIx, registerCompressedChipIx, cancelCompressedClaimIx, finalizeCompressedPackIx, fuseClaimsCommitIx, fuseClaimsRevealIx, cancelStaleClaimFusionIx, closeExpiredClaimIx } from './ix/chipCore';
import { v2LeafHash, foldCompressionProof, discoverLeafNonce, verifyBubblegumProofLocal } from './bubblegum';
import { DasClient } from './das';
import { initRandomnessIx, revealRandomnessIx, closeRandomnessIx, closeRandomnessLutIx, commitAccountMetas, rngAccounts } from './ix/rng';
import { createBattleIx } from './ix/arena';
import { buyCompressedAssetIx, cancelCompressedAssetIx, listCompressedAssetIx, saleSplit } from './ix/market';
import type { BubblegumProof } from './bubblegum';
import { wagerSplit, leagueOf } from './ix/arena';
import { unstakePenalty, claimRootIx, claimSkrRootIx, claimItemRootIx, claimChipRootIx, claimAnyRootIx, fundSliceIx, SLICE_PVP_SEASON } from './ix/staking';
import { usdCentsToUnits, usdCentsToLamports, usdCentsToMicroSkr, priceUsd, assertFeed, pushOracleAccount, isFresh, priceAgeS, isConfident, PYTH_MAX_AGE_S, PYTH_MAX_CONF_BPS, PythConfidenceError } from './pyth';
import { ADDRESS_LOOKUP_TABLE_PROGRAM_ID, PYTH_SOL_USD_FEED_ID_HEX, PYTH_SKR_USD_FEED_ID_HEX, PYTH_SHARD_ID, PYTH_PRICE_ACCOUNTS, PYTH_SPONSORED_SOL_USD, SWITCHBOARD_PROGRAM_ID, SWITCHBOARD_ON_DEMAND_ID, ARENA_ID, SYSVAR_SLOT_HASHES_ID, WSOL_MINT, MPL_BUBBLEGUM_V2_ID, MPL_NOOP_ID, MPL_ACCOUNT_COMPRESSION_ID, MPL_CORE_ID, SYSTEM_PROGRAM_ID } from './ids';
import { packSeed } from './flows/packFlow';
import { describeProgramError, humanizeTxError } from './errors';
import { revealValueFromIx, revealPayloadFromIx } from './switchboard';
import { buildRewardTree, rewardLeaf, verifyRewardProof, hashPair, toHex, fromHex, MAX_PROOF_LEN } from './merkle';
import { TransactionInstruction } from '@solana/web3.js';
import { CHIP_CORE_ID, MARKET_ID } from './ids';
import { base58Encode } from '@/shared/lib/base58';
import { fmtUnits, parseUnits } from '@/shared/lib/format';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

describe('borsh', () => {
  it('round-trips scalar types', () => {
    const k = Keypair.generate().publicKey;
    const w = new BorshWriter().u8(7).u16(65_000).u32(4_000_000_000).u64(2n ** 63n + 5n).i64(-42n).u128(2n ** 100n + 1n).bool(true).pubkey(k).string('héllo');
    w.option(9, (x) => w.u8(x)).vec([1, 2, 3], (x) => w.u16(x));
    const r = new BorshReader(w.toBytes());
    expect(r.u8()).toBe(7); expect(r.u16()).toBe(65_000); expect(r.u32()).toBe(4_000_000_000); expect(r.u64()).toBe(2n ** 63n + 5n); expect(r.i64()).toBe(-42n);
    expect(r.u128()).toBe(2n ** 100n + 1n); expect(r.bool()).toBe(true); expect(r.pubkey().equals(k)).toBe(true); expect(r.string()).toBe('héllo');
    expect(r.option(() => r.u8())).toBe(9); expect(r.vec(() => r.u16())).toEqual([1, 2, 3]); expect(r.remaining).toBe(0);
  });
  it('u64le matches Rust to_le_bytes', () => {
    expect(hex(u64le(1n))).toBe('0100000000000000');
    expect(hex(u64le(0x0102030405060708n))).toBe('0807060504030201');
  });
});

describe('anchor conventions', () => {
  it('discriminators are sha256 prefixes', () => {
    // well-known Anchor values
    expect(hex(ixDiscriminator('initialize'))).toBe('afaf6d1f0d989bed');
    expect(hex(accountDiscriminator('GameConfig'))).toHaveLength(16);
    expect(hex(accountDiscriminator('GameConfig'))).not.toBe(hex(accountDiscriminator('ChipState')));
  });
  it('optional account = program id readonly', () => {
    const m = optional(undefined, CHIP_CORE_ID);
    expect(m.pubkey.equals(CHIP_CORE_ID)).toBe(true); expect(m.isWritable).toBe(false); expect(m.isSigner).toBe(false);
    const k = Keypair.generate().publicKey;
    expect(optional(k, CHIP_CORE_ID).isWritable).toBe(true);
  });
  it('parses custom program errors from messages and logs', () => {
    expect(parseCustomError({ message: 'failed: custom program error: 0x1776' })).toEqual({ code: 6006, programId: undefined });
    const logs = [`Program ${CHIP_CORE_ID.toBase58()} invoke [1]`, `Program ${CHIP_CORE_ID.toBase58()} failed: custom program error: 0x1770`];
    expect(parseCustomError({ message: 'x', logs })?.programId).toBe(CHIP_CORE_ID.toBase58());
    // CPI failure: chip_core (inner) raises 0x1777 ChipNotFree, market (outer) re-logs it — the inner table applies
    const cpiLogs = [`Program ${MARKET_ID.toBase58()} invoke [1]`, `Program ${CHIP_CORE_ID.toBase58()} invoke [2]`, `Program ${CHIP_CORE_ID.toBase58()} failed: custom program error: 0x1777`, `Program ${MARKET_ID.toBase58()} failed: custom program error: 0x1777`];
    expect(parseCustomError({ message: 'custom program error: 0x1777', logs: cpiLogs })?.programId).toBe(CHIP_CORE_ID.toBase58());
    expect(humanizeTxError({ message: 'custom program error: 0x1777', logs: cpiLogs })).toMatch(/^chip_core: /);
    expect(describeProgramError(6006, CHIP_CORE_ID.toBase58())).toBe('chip_core: Daily purchase cap reached for this SKU');
    expect(humanizeTxError({ message: 'custom program error: 0x1770', logs })).toBe('chip_core: Game is paused');
    expect(humanizeTxError(new Error('User rejected the request.'))).toBe('Signature rejected in wallet');
  });
  it('extracts events from logs and decodes PackOpened', () => {
    const buyer = Keypair.generate().publicKey;
    const assets = Array.from({ length: 5 }, () => Keypair.generate().publicKey);
    const roll = new Uint8Array(32).fill(0xab);
    const w = new BorshWriter().pubkey(buyer).u8(1).u64(77n);
    for (const a of assets) w.pubkey(a);
    w.bytes(Uint8Array.from([0, 2, 1, 0, 0])).bytes(Uint8Array.from([3, 7, 1, 0, 0])).u8(3).bytes(roll).u16(22).u16(23);
    const payload = concat(eventDiscriminator('PackOpened'), w.toBytes());
    const b64 = btoa(String.fromCharCode(...payload));
    const logs = ['Program log: Instruction: OpenPack', `Program data: ${b64}`, 'Program log: done'];
    expect(eventsFromLogs(logs)).toHaveLength(1);
    const ev = findEvent(logs, 'PackOpened', readPackOpened)!;
    expect(ev.buyer.equals(buyer)).toBe(true); expect(ev.nonce).toBe(77n); expect(ev.count).toBe(3);
    expect(ev.assets).toHaveLength(3); expect(ev.rarities).toEqual([0, 2, 1]); expect(ev.collections).toEqual([3, 7, 1]);
    expect(hex(ev.roll)).toBe('ab'.repeat(32)); expect(ev.pityBefore).toBe(22); expect(ev.pityAfter).toBe(23);
  });
});

describe('account layouts (sizes = 8 + INIT_SPACE)', () => {
  const pk = () => Keypair.generate().publicKey;
  it('ChipState = 8 + 32+1+1+1+8+1+8+8+1 = 69', () => {
    const w = new BorshWriter().bytes(accountDiscriminator('ChipState')).pubkey(pk()).u8(3).u8(4).u8(2).u64(1234n).u8(CHIP_FLAG.LISTED).i64(0n).i64(1_700_000_000n).u8(254);
    const buf = w.toBytes();
    expect(buf.length).toBe(69);
    const c = decodeChipState(buf);
    expect(c.rarity).toBe(4); expect(c.level).toBe(2); expect(c.index).toBe(1234n); expect(c.flags & CHIP_FLAG.LISTED).toBeTruthy();
    expect(chipIsFree(c)).toBe(false);
    expect(chipIsFree({ ...c, flags: 0 })).toBe(true);
    expect(chipIsFree({ ...c, flags: 0, lockUntil: BigInt(Math.floor(Date.now() / 1000) + 100) })).toBe(false);
  });
  it('PlayerPity = 8 + 32+8+8+4+1+1 = 62', () => {
    const w = new BorshWriter().bytes(accountDiscriminator('PlayerPity')).pubkey(pk());
    [0, 23, 4, 0].forEach((c) => w.u16(c)); w.i64(1n); [0, 1, 0, 0].forEach((b) => w.u8(b)); w.bool(true).u8(255);
    const buf = w.toBytes(); expect(buf.length).toBe(62);
    const p = decodePlayerPity(buf); expect(p.counters).toEqual([0, 23, 4, 0]); expect(p.starterClaimed).toBe(true);
  });
  it('PendingPack = 8 + 32+1+1+1+32+8+8+8+8+8+2+8+1 + 1+32 + 1+18+1 = 179 (revealed + value SEC-C2, voucher fields #28)', () => {
    const w = new BorshWriter().bytes(accountDiscriminator('PendingPack')).pubkey(pk()).u8(2).u8(5).u8(1).pubkey(pk()).u64(1000n).u64(0n).u64(0n).u64(1_950_000_000n).u64(7_000_000n).u16(19).u64(42n).u8(250).bool(true).bytes(new Uint8Array(32).fill(9));
    w.bool(false); new Array(9).fill(0).forEach((o) => w.u16(o)); w.u8(0);
    const buf = w.toBytes(); expect(buf.length).toBe(179);
    const p = decodePendingPack(buf); expect(p.qty).toBe(5); expect(p.opened).toBe(1); expect(p.paidCg).toBe(1_950_000_000n); expect(p.paidSkr).toBe(7_000_000n); expect(p.nonce).toBe(42n);
    expect(p.revealed).toBe(true); expect(Array.from(p.value)).toEqual(new Array(32).fill(9));
    expect(p.voucher).toBe(false); expect(p.soulboundDays).toBe(0);
  });
  it('PendingPack voucher (#28): sku 0, paid 0, template odds + soulbound days; a pre-#28 159-byte account decodes as a purchase', () => {
    const w = new BorshWriter().bytes(accountDiscriminator('PendingPack')).pubkey(pk()).u8(0).u8(1).u8(0).pubkey(pk()).u64(1000n).u64(0n).u64(0n).u64(0n).u64(0n).u16(0).u64(7n).u8(250).bool(false).bytes(new Uint8Array(32));
    w.bool(true); [3000, 5000, 1800, 200, 0, 0, 0, 0, 0].forEach((o) => w.u16(o)); w.u8(7);
    const p = decodePendingPack(w.toBytes());
    expect(p.voucher).toBe(true); expect(p.voucherOdds).toEqual([3000, 5000, 1800, 200, 0, 0, 0, 0, 0]); expect(p.soulboundDays).toBe(7); expect(p.paidCg).toBe(0n);
    const legacy = new BorshWriter().bytes(accountDiscriminator('PendingPack')).pubkey(pk()).u8(1).u8(1).u8(0).pubkey(pk()).u64(1000n).u64(0n).u64(4_990_000n).u64(0n).u64(0n).u16(3).u64(8n).u8(250).bool(false).bytes(new Uint8Array(32)).toBytes();
    expect(legacy.length).toBe(159);
    const q = decodePendingPack(legacy); expect(q.voucher).toBe(false); expect(q.voucherOdds).toEqual(new Array(9).fill(0)); expect(q.soulboundDays).toBe(0); expect(q.paidUsdc).toBe(4_990_000n);
  });
  it('GameConfig decodes with 4 PackDefs (PackDef = 1+4+8+18+1+1+1+2+2+2+1+1 = 42)', () => {
    const w = new BorshWriter().bytes(accountDiscriminator('GameConfig'));
    for (let i = 0; i < 10; i++) w.pubkey(pk()); // admin, pending_admin, treasury, buyback, cg, usdc, skr, staking_program, pyth_sol, pyth_skr
    w.u8(4).bool(false);
    for (let s = 0; s < 4; s++) {
      w.u8(3).u32(499).u64(750_000_000n);
      [4500, 2500, 1500, 800, 450, 180, 50, 18, 2].forEach((o) => w.u16(o));
      w.u8(1).u8(0).u8(6).u16(60).u16(30).u16(25).bool(false).bool(s !== 3);
    }
    const pauser = pk();
    w.u16(750).u16(500).u8(10).u32(1).u8(255).u8(254).pubkey(pauser); // #12: no liab_* / burned_total in GameConfig
    const buf = w.toBytes();
    expect(buf.length).toBe(8 + 32 * 10 + 1 + 1 + 42 * 4 + 2 + 2 + 1 + 4 + 1 + 1 + 32);
    const g = decodeGameConfig(buf);
    expect(g.packs).toHaveLength(4); expect(g.packs[1].oddsBps[0]).toBe(4500); expect(g.packs[3].enabled).toBe(false); expect(g.collectionsCreated).toBe(10); expect(g.marketFeeBps).toBe(750); expect(g.skrDiscountBps).toBe(500);
    expect(g.paramsVersion).toBe(1); expect(g.vaultBump).toBe(255); expect(g.bump).toBe(254);
    expect(g.pauser.equals(pauser)).toBe(true);
  });
  it('VaultLedger (#12): 8 + 1 + 40 + 1 bytes; shard = wallet[0] % 4; sumLedgers treats missing shards as zero', () => {
    const buf = new BorshWriter().bytes(accountDiscriminator('VaultLedger')).u8(2).u64(5n).u64(6n).u64(7n).u64(8n).u64(9n).u8(253).toBytes();
    expect(buf.length).toBe(50);
    const l = decodeVaultLedger(buf);
    expect(l).toEqual({ shard: 2, liabLamports: 5n, liabUsdc: 6n, liabCg: 7n, liabSkr: 8n, burnedTotal: 9n, bump: 253 });
    expect(() => decodeVaultLedger(new BorshWriter().bytes(accountDiscriminator('GameConfig')).u8(0).toBytes())).toThrow(/VaultLedger/);
    const w0 = new PublicKey(new Uint8Array(32).fill(0)); const w5 = new PublicKey(Uint8Array.from([5, ...new Array(31).fill(1)]));
    expect(ledgerShardOf(w0)).toBe(0); expect(ledgerShardOf(w5)).toBe(1); expect(ledgerShardOf(new PublicKey(Uint8Array.from([255, ...new Array(31).fill(1)])))).toBe(3);
    expect(ledgerPdaOf(w5)[0].equals(ledgerPda(1)[0])).toBe(true);
    expect(allLedgerPdas()).toHaveLength(LEDGER_SHARDS);
    expect(new Set(allLedgerPdas().map((k) => k.toBase58())).size).toBe(LEDGER_SHARDS);
    const t = sumLedgers([l, null, { ...l, shard: 3, liabCg: 100n }]);
    expect(t).toEqual({ liabLamports: 10n, liabUsdc: 12n, liabCg: 107n, liabSkr: 16n, burnedTotal: 18n });
  });
  it('Listing / TokenStake decode', () => {
    const l = decodeListing(new BorshWriter().bytes(accountDiscriminator('Listing')).pubkey(pk()).pubkey(pk()).u64(250_000_000n).u8(0).i64(1n).u8(1).toBytes());
    expect(l.price).toBe(250_000_000n); expect(l.currency).toBe(0);
    const t = decodeTokenStake(new BorshWriter().bytes(accountDiscriminator('TokenStake')).pubkey(pk()).u8(1).u64(500_000_000n).u128(750_000_000n).u128(0n).i64(99n).u8(1).toBytes());
    expect(t.weight).toBe(750_000_000n); expect(t.tier).toBe(1);
  });
  it('rejects wrong discriminator', () => {
    expect(() => decodeChipState(new Uint8Array(69))).toThrow(/discriminator/);
  });
});

describe('compressed settlement layouts', () => {
  it('decodes the post-mint asset listing layout without shifting the fixed hashes', () => {
    const asset = Keypair.generate().publicKey;
    const claim = Keypair.generate().publicKey;
    const seller = Keypair.generate().publicKey;
    const tree = Keypair.generate().publicKey;
    const treeConfig = Keypair.generate().publicKey;
    const collection = Keypair.generate().publicKey;
    const data = new BorshWriter()
      .bytes(accountDiscriminator('CompressedAssetListing'))
      .pubkey(asset).pubkey(claim).pubkey(seller).pubkey(tree).pubkey(treeConfig).pubkey(collection)
      .u8(4).u64(2_000_000n).u8(0).i64(123n).u8(7).toBytes();
    const listing = decodeCompressedAssetListing(data);
    expect(listing.asset.equals(asset)).toBe(true);
    expect(listing.claim.equals(claim)).toBe(true);
    expect(listing.seller.equals(seller)).toBe(true);
    expect(listing.merkleTree.equals(tree)).toBe(true);
    expect(listing.treeConfig.equals(treeConfig)).toBe(true);
    expect(listing.coreCollection.equals(collection)).toBe(true);
    expect(listing.collectionIdx).toBe(4);
    expect(listing.price).toBe(2_000_000n);
    expect(listing.createdAt).toBe(123n);
    expect(listing.bump).toBe(7);
  });

  it('initializes and decodes cancelled_claims as zero', () => {
    const buyer = Keypair.generate().publicKey;
    const pending = Keypair.generate().publicKey;
    const buf = new BorshWriter()
      .bytes(accountDiscriminator('CompressedPackSettlement'))
      .pubkey(buyer).pubkey(pending).u64(42n).u16(5).u16(2).u16(0).u8(251).toBytes();
    expect(buf.length).toBe(87);
    const settlement = decodeCompressedPackSettlement(buf);
    expect(settlement.buyer.equals(buyer)).toBe(true);
    expect(settlement.totalClaims).toBe(5);
    expect(settlement.registeredClaims).toBe(2);
    expect(settlement.cancelledClaims).toBe(0);
  });

  it('decodes compressed claim-created events without inventing asset ids', () => {
    const buyer = Keypair.generate().publicKey;
    const w = new BorshWriter().pubkey(buyer).u64(42n).u8(1);
    [100n, 101n, 102n, 0n, 0n].forEach((n) => w.u64(n));
    w.u8(3);
    const payload = concat(eventDiscriminator('CompressedClaimsCreated'), w.toBytes());
    const logs = [`Program data: ${btoa(String.fromCharCode(...payload))}`];
    const event = findEvent(logs, 'CompressedClaimsCreated', readCompressedClaimsCreated)!;
    expect(event.count).toBe(3);
    expect(event.claimNonces).toEqual([100n, 101n, 102n]);
    expect(event.buyer.equals(buyer)).toBe(true);
  });
});

describe('PDAs', () => {
  it('are deterministic and program-owned', () => {
    const [cfg, bump] = configPda();
    expect(PublicKey.isOnCurve(cfg.toBytes())).toBe(false); expect(bump).toBeLessThanOrEqual(255);
    const buyer = Keypair.generate().publicKey;
    const [p1] = pendingPackPda(buyer, 5n); const [p2] = pendingPackPda(buyer, 6n);
    expect(p1.equals(p2)).toBe(false);
    const [a0] = assetPda(p1, 0, 0); const [a1] = assetPda(p1, 0, 1);
    expect(a0.equals(a1)).toBe(false);
    expect(chipStatePda(a0)[0].equals(chipStatePda(a0)[0])).toBe(true);
    expect(rewardRootPda(2, 143)[0]).toBeInstanceOf(PublicKey);
  });
  it('ATA derivation matches spl-token', () => {
    const mint = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
    const owner = new PublicKey('11111111111111111111111111111112');
    const [expected] = PublicKey.findProgramAddressSync([owner.toBuffer(), new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBuffer(), mint.toBuffer()], new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'));
    expect(ata(mint, owner).equals(expected)).toBe(true);
  });
  it('fresh nonces are unique and fit u64', () => {
    const a = freshNonce(); const b = freshNonce();
    expect(a).not.toBe(b); expect(a < 2n ** 64n).toBe(true);
  });
});

describe('instruction builders', () => {
  const buyer = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const queue = Keypair.generate().publicKey;
  const oracle = Keypair.generate().publicKey;
  it('buy_pack has 17 accounts (config ro, ledger shard rw, 5 commit-CPI slots after the rng PDA), optional slots collapse to program id', () => {
    const rng = rngPda(RNG_KIND.PACK, buyer, 9n)[0];
    const ix = buyPackIx({ buyer, sku: 1, qty: 5, currency: Currency.SOL, nonce: 9n, maxLamports: 1_000n, randomness: rng, queue, oracle, priceUpdate: Keypair.generate().publicKey, usdcMint: mint, cgMint: mint });
    expect(ix.keys).toHaveLength(17);
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[1].pubkey.equals(configPda()[0]) && !ix.keys[1].isWritable).toBe(true); // #12: config never written by players
    expect(ix.keys[2].pubkey.equals(ledgerPdaOf(buyer)[0]) && ix.keys[2].isWritable).toBe(true); // buyer's liability shard
    expect(ix.keys[5].pubkey.equals(rng) && ix.keys[5].isWritable).toBe(true); // randomness is mut (commit CPI)
    expect(ix.keys[6].pubkey.equals(rngAuthPda(RNG_KIND.PACK)[0])).toBe(true);
    expect(ix.keys[7].pubkey.equals(SWITCHBOARD_ON_DEMAND_ID)).toBe(true);
    expect(ix.keys[8].pubkey.equals(queue) && !ix.keys[8].isWritable).toBe(true);
    expect(ix.keys[9].pubkey.equals(oracle) && ix.keys[9].isWritable).toBe(true);
    expect(ix.keys[10].pubkey.equals(SYSVAR_SLOT_HASHES_ID)).toBe(true);
    expect(ix.keys[11].pubkey.equals(vaultPda()[0]) && ix.keys[11].isWritable).toBe(true); // SOL path: vault receives lamports
    expect(ix.keys[13].pubkey.equals(CHIP_CORE_ID)).toBe(true); // buyer_token absent for SOL
    expect(ix.keys[12].pubkey.equals(CHIP_CORE_ID)).toBe(false); // price_update present
    expect(hex(new Uint8Array(ix.data).slice(0, 8))).toBe(hex(ixDiscriminator('buy_pack')));
    const r = new BorshReader(new Uint8Array(ix.data), 8);
    expect(r.u8()).toBe(1); expect(r.u8()).toBe(5); expect(r.u8()).toBe(0); expect(r.u64()).toBe(9n); expect(r.u64()).toBe(1_000n);
    // SKR: price_update present AND token legs present; vault read-only (SPL purchases never lock the vault)
    const skr = Keypair.generate().publicKey;
    const ix2 = buyPackIx({ buyer, sku: 1, qty: 1, currency: Currency.SKR, nonce: 1n, maxLamports: 500_000_000n, randomness: rng, queue, oracle, priceUpdate: Keypair.generate().publicKey, usdcMint: mint, cgMint: mint, skrMint: skr });
    expect(ix2.keys[11].isWritable).toBe(false);
    expect(ix2.keys[12].pubkey.equals(CHIP_CORE_ID)).toBe(false);
    expect(ix2.keys[13].pubkey.equals(CHIP_CORE_ID)).toBe(false);
    expect(new Uint8Array(ix2.data)[10]).toBe(3);
  });
  it('pay_service: 12 accounts (#12 adds the burn shard after the service ledger); $CG path burns (cg_mint present, treasury ATA absent)', () => {
    const ref = new Uint8Array(32).fill(7);
    const cg = payServiceIx({ buyer, kind: 0, currency: Currency.CG, maxUnits: 0n, refHash: ref, treasury: mint, usdcMint: mint, cgMint: mint });
    expect(cg.keys).toHaveLength(12);
    expect(cg.keys[1].isWritable).toBe(false);
    expect(cg.keys[3].pubkey.equals(ledgerPdaOf(buyer)[0]) && cg.keys[3].isWritable).toBe(true);
    expect(cg.keys[8].pubkey.equals(CHIP_CORE_ID)).toBe(true); // treasury_token absent
    expect(cg.keys[9].pubkey.equals(mint)).toBe(true); // cg_mint present
    const usdc = payServiceIx({ buyer, kind: 6, currency: Currency.USDC, maxUnits: 0n, refHash: ref, treasury: mint, usdcMint: mint, cgMint: mint });
    expect(usdc.keys[8].pubkey.equals(CHIP_CORE_ID)).toBe(false);
    expect(usdc.keys[9].pubkey.equals(CHIP_CORE_ID)).toBe(true);
    expect(hex(new Uint8Array(usdc.data).slice(0, 8))).toBe(hex(ixDiscriminator('pay_service')));
    expect(new Uint8Array(usdc.data).length).toBe(8 + 1 + 1 + 8 + 32);
    expect(() => payServiceIx({ buyer, kind: 0, currency: Currency.CG, maxUnits: 0n, refHash: new Uint8Array(4), treasury: mint, usdcMint: mint, cgMint: mint })).toThrow(/32 bytes/);
  });
  it('create_bubblegum_tree: collection PDA is the CPI tree creator and fixed program accounts are pinned', () => {
    const merkleTree = Keypair.generate().publicKey;
    const treeConfig = Keypair.generate().publicKey;
    const ix = createBubblegumTreeIx({ admin: buyer, collectionIdx: 2, merkleTree, treeConfig, maxDepth: 20, canopy: 13, maxBufferSize: 1024 });
    expect(ix.keys).toHaveLength(10);
    expect(ix.keys[0].pubkey.equals(buyer) && ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[3].isWritable).toBe(true); // registry PDA
    expect(ix.keys[4].pubkey.equals(merkleTree) && ix.keys[4].isWritable).toBe(true);
    expect(ix.keys[5].pubkey.equals(treeConfig) && ix.keys[5].isWritable).toBe(true);
    expect(ix.keys[6].pubkey.equals(MPL_BUBBLEGUM_V2_ID)).toBe(true);
    expect(ix.keys[7].pubkey.equals(MPL_NOOP_ID)).toBe(true);
    expect(ix.keys[8].pubkey.equals(MPL_ACCOUNT_COMPRESSION_ID)).toBe(true);
    expect(ix.keys[9].pubkey.equals(SYSTEM_PROGRAM_ID)).toBe(true);
    const r = new BorshReader(new Uint8Array(ix.data), 8);
    expect(r.u8()).toBe(2); expect(r.u8()).toBe(20); expect(r.u8()).toBe(13); expect(r.u32()).toBe(1024);
  });
  it('open_compressed_pack: pending-to-claim account order and deterministic claim PDAs', () => {
    const randomness = Keypair.generate().publicKey;
    const ix = openCompressedPackIx({ payer: buyer, buyer, nonce: 9n, packNo: 1, chips: 3, collectionIdx: [0, 2, 2], randomness });
    expect(ix.keys).toHaveLength(8 + 3 * 3);
    expect(ix.keys[0].pubkey.equals(buyer) && ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[2].pubkey.equals(pendingPackPda(buyer, 9n)[0]) && ix.keys[2].isWritable).toBe(true);
    expect(ix.keys[5].pubkey.equals(compressedSettlementPda(buyer, 9n)[0]) && ix.keys[5].isWritable).toBe(true);
    expect(ix.keys[8].pubkey.equals(compressedMintClaimPda(buyer, 9n * 128n + 5n)[0])).toBe(true);
    expect(ix.keys[9].pubkey.equals(collectionMetaPda(0)[0])).toBe(true);
    expect(ix.keys[14].pubkey.equals(compressedMintClaimPda(buyer, 9n * 128n + 7n)[0])).toBe(true);
  });
  it('cancel/finalize compressed claims: timeout and refund account layouts stay explicit', () => {
    const cancel = cancelCompressedClaimIx({ buyer, claimNonce: 9n * 128n + 5n, nonce: 9n });
    expect(cancel.keys).toHaveLength(5);
    expect(cancel.keys[0].isSigner && cancel.keys[0].isWritable).toBe(true);
    expect(cancel.keys[1].pubkey.equals(compressedSettlementPda(buyer, 9n)[0]) && cancel.keys[1].isWritable).toBe(true);
    expect(cancel.keys[2].pubkey.equals(pendingPackPda(buyer, 9n)[0])).toBe(true);
    expect(cancel.keys[3].pubkey.equals(compressedMintClaimPda(buyer, 9n * 128n + 5n)[0])).toBe(true);
    expect(new Uint8Array(cancel.data).length).toBe(8 + 8 + 8);
    const finalize = finalizeCompressedPackIx({ payer: buyer, buyer, nonce: 9n, refundToken: { vault: Keypair.generate().publicKey, buyer: Keypair.generate().publicKey } });
    expect(finalize.keys).toHaveLength(14);
    expect(finalize.keys[2].pubkey.equals(compressedSettlementPda(buyer, 9n)[0]) && finalize.keys[2].isWritable).toBe(true);
    expect(finalize.keys[6].isWritable).toBe(true); // SOL refund debits the vault PDA
    expect(finalize.keys[10].isWritable).toBe(true);
    expect(finalize.keys[11].isWritable).toBe(true);
    expect(finalize.keys[13].pubkey.equals(SYSTEM_PROGRAM_ID)).toBe(true);
  });
  it('mint_compressed_chip: claim-bound Bubblegum V2 CPI account order and fixed programs', () => {
    const treeConfig = Keypair.generate().publicKey;
    const merkleTree = Keypair.generate().publicKey;
    const coreCollection = Keypair.generate().publicKey;
    const ix = mintCompressedChipIx({ payer: buyer, buyer, collectionIdx: 2, claimNonce: 17n, treeConfig, merkleTree, coreCollection });
    expect(ix.keys).toHaveLength(16);
    expect(ix.keys[0].pubkey.equals(buyer) && ix.keys[0].isSigner && ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[4].isWritable).toBe(true); // one-time claim is consumed only after CPI success
    expect(ix.keys[6].pubkey.equals(treeConfig) && ix.keys[6].isWritable).toBe(true);
    expect(ix.keys[7].pubkey.equals(merkleTree) && ix.keys[7].isWritable).toBe(true);
    expect(ix.keys[8].pubkey.equals(collectionMetaPda(2)[0]) && !ix.keys[8].isWritable).toBe(true); // tree authority / delegate
    expect(ix.keys[9].pubkey.equals(coreCollection) && ix.keys[9].isWritable).toBe(true);
    expect(ix.keys[10].pubkey.equals(PublicKey.findProgramAddressSync([Buffer.from('collection_cpi')], MPL_BUBBLEGUM_V2_ID)[0])).toBe(true);
    expect(ix.keys[11].pubkey.equals(MPL_BUBBLEGUM_V2_ID)).toBe(true);
    expect(ix.keys[12].pubkey.equals(MPL_NOOP_ID)).toBe(true);
    expect(ix.keys[13].pubkey.equals(MPL_ACCOUNT_COMPRESSION_ID)).toBe(true);
    expect(ix.keys[14].pubkey.equals(MPL_CORE_ID)).toBe(true);
    expect(ix.keys[15].pubkey.equals(SYSTEM_PROGRAM_ID)).toBe(true);
    expect(new Uint8Array(ix.data).length).toBe(8 + 32 + 1 + 8);
  });
  it('register_compressed_chip marks settlement writable for counter updates', () => {
    const settlement = compressedSettlementPda(buyer, 9n)[0];
    const proof = { root: new Uint8Array(32), dataHash: new Uint8Array(32), creatorHash: new Uint8Array(32), collectionHash: new Uint8Array(32), assetDataHash: new Uint8Array(32), flags: 0, nonce: 0n, index: 3, proofNodes: [] };
    const ix = registerCompressedChipIx({ payer: buyer, buyer, claimNonce: 17n, asset: Keypair.generate().publicKey, merkleTree: Keypair.generate().publicKey, treeConfig: Keypair.generate().publicKey, collectionIdx: 2, owner: buyer, delegate: buyer, proof, rarity: 1, level: 1, gameIndex: 4n, settlement });
    expect(ix.keys[5].pubkey.equals(settlement)).toBe(true);
    expect(ix.keys[5].isWritable).toBe(true);
  });
  it('open_pack: 14 fixed accounts + 4 per chip; the ledger shard is writable only on the settling pack (#12)', () => {
    const core = Keypair.generate().publicKey;
    const ix = openPackIx({ payer: buyer, buyer, nonce: 9n, packNo: 2, qty: 5, randomness: Keypair.generate().publicKey, rolledCollections: [0, 3, 3], coreCollectionOf: () => core });
    expect(ix.keys).toHaveLength(14 + 12);
    expect(ix.keys[1].pubkey.equals(configPda()[0]) && !ix.keys[1].isWritable).toBe(true);
    expect(ix.keys[2].pubkey.equals(ledgerPdaOf(buyer)[0]) && !ix.keys[2].isWritable).toBe(true); // pack 3 of 5: read-only shard, no write lock
    expect(ix.keys[7].pubkey.equals(vaultPda()[0]) && !ix.keys[7].isWritable).toBe(true);        // vault only signs
    expect(ix.keys[14 + 2].pubkey.equals(chipStatePda(ix.keys[14 + 0].pubkey)[0])).toBe(false); // [asset, state, meta, core]
    expect(ix.keys[14 + 1].pubkey.equals(chipStatePda(ix.keys[14].pubkey)[0])).toBe(true);
    const last = openPackIx({ payer: buyer, buyer, nonce: 9n, packNo: 4, qty: 5, randomness: Keypair.generate().publicKey, rolledCollections: [0], coreCollectionOf: () => core });
    expect(last.keys[2].isWritable).toBe(true); // settling pack releases the liability
    const single = openPackIx({ payer: buyer, buyer, nonce: 9n, packNo: 0, randomness: Keypair.generate().publicKey, rolledCollections: [0], coreCollectionOf: () => core });
    expect(single.keys[2].isWritable).toBe(true); // qty defaults to 1 → pack 0 settles
  });
  it('fuse: 22 named accounts (SEC-M3 vault + vault_cg, #12 ledger shard), [asset,state]×3 then [meta,core]×3; atomic recipes collapse the 5 optional rng slots', () => {
    const mats = Array.from({ length: 3 }, (_, i) => ({ asset: Keypair.generate().publicKey, collectionIdx: i }));
    const ix = fuseIx({ owner: buyer, nonce: 1n, useBooster: true, materials: mats, resultCollectionIdx: 0, cgMint: mint, coreCollectionOf: () => mint });
    expect(ix.keys).toHaveLength(22 + 12);
    expect(ix.keys[1].isWritable).toBe(false);
    expect(ix.keys[2].pubkey.equals(ledgerPdaOf(buyer)[0]) && ix.keys[2].isWritable).toBe(true);
    for (const i of [4, 6, 7, 8, 9]) expect(ix.keys[i].pubkey.equals(CHIP_CORE_ID)).toBe(true); // randomness, switchboard, queue, oracle, slot_hashes = None
    expect(ix.keys[5].pubkey.equals(rngAuthPda(RNG_KIND.FUSION)[0])).toBe(true); // rng_auth always present (PDA constraint)
    expect(ix.keys[17].pubkey.equals(vaultPda()[0])).toBe(true);                 // SEC-M3 fee escrow authority
    expect(ix.keys[18].pubkey.equals(ata(mint, vaultPda()[0])) && ix.keys[18].isWritable).toBe(true);
    expect(ix.keys[22].pubkey.equals(mats[0].asset)).toBe(true);
    expect(ix.keys[22 + 6 + 1].pubkey.equals(mint)).toBe(true);
    const r = new BorshReader(new Uint8Array(ix.data), 8); expect(r.u64()).toBe(1n); expect(r.bool()).toBe(true);
    // randomized recipe: rng PDA + commit accounts present
    const rng = rngPda(RNG_KIND.FUSION, buyer, 1n)[0];
    const ix2 = fuseIx({ owner: buyer, nonce: 1n, useBooster: false, rng: { randomness: rng, queue, oracle }, materials: mats, resultCollectionIdx: 0, cgMint: mint, coreCollectionOf: () => mint });
    expect(ix2.keys[4].pubkey.equals(rng) && ix2.keys[4].isWritable).toBe(true);
    expect(ix2.keys[6].pubkey.equals(SWITCHBOARD_ON_DEMAND_ID)).toBe(true);
    expect(ix2.keys[7].pubkey.equals(queue)).toBe(true);
    expect(ix2.keys[8].pubkey.equals(oracle) && ix2.keys[8].isWritable).toBe(true);
    expect(ix2.keys[9].pubkey.equals(SYSVAR_SLOT_HASHES_ID)).toBe(true);
  });
  it('create_battle: rng PDA (mut) + 5 commit slots before cg_mint, squad appended', () => {
    const rng = rngPda(RNG_KIND.BATTLE, buyer, 7n)[0];
    const squad = [1, 2, 3].map(() => Keypair.generate().publicKey);
    const ix = createBattleIx({ challenger: buyer, nonce: 7n, wager: 5_000_000n, randomness: rng, queue, oracle, squad, cgMint: mint });
    expect(ix.programId.equals(ARENA_ID)).toBe(true);
    expect(ix.keys).toHaveLength(15 + 6);
    expect(ix.keys[3].pubkey.equals(rng) && ix.keys[3].isWritable).toBe(true);
    expect(ix.keys[4].pubkey.equals(rngAuthPda(RNG_KIND.BATTLE)[0])).toBe(true);
    expect(rngAuthPda(RNG_KIND.BATTLE)[0].equals(rngAuthPda(RNG_KIND.PACK)[0])).toBe(false); // per-program authority
    expect(ix.keys[9].pubkey.equals(mint)).toBe(true);
    expect(ix.keys[15].pubkey.equals(squad[0])).toBe(true);
  });
});

describe('program-owned randomness (SEC-C3 part 2)', () => {
  const owner = Keypair.generate().publicKey;
  const queue = Keypair.generate().publicKey;
  it('PDAs: ["rng", kind, owner, nonce] per program; ["rng_auth"] per program; Switchboard side PDAs', () => {
    const [pack] = rngPda(RNG_KIND.PACK, owner, 1n);
    const [fusion] = rngPda(RNG_KIND.FUSION, owner, 1n);
    const [battle] = rngPda(RNG_KIND.BATTLE, owner, 1n);
    expect(new Set([pack, fusion, battle].map((k) => k.toBase58())).size).toBe(3);
    expect(pack.equals(PublicKey.findProgramAddressSync([Buffer.from('rng'), Buffer.from([0]), owner.toBuffer(), Buffer.from(u64le(1n))], CHIP_CORE_ID)[0])).toBe(true);
    expect(battle.equals(PublicKey.findProgramAddressSync([Buffer.from('rng'), Buffer.from([2]), owner.toBuffer(), Buffer.from(u64le(1n))], ARENA_ID)[0])).toBe(true);
    expect(rngAuthPda(RNG_KIND.PACK)[0].equals(PublicKey.findProgramAddressSync([Buffer.from('rng_auth')], CHIP_CORE_ID)[0])).toBe(true);
    expect(rngAuthPda(RNG_KIND.BATTLE)[0].equals(PublicKey.findProgramAddressSync([Buffer.from('rng_auth')], ARENA_ID)[0])).toBe(true);
    // Switchboard PDAs mirror the SDK (State.keyFromSeed / getLutSigner / getLutKey / stats)
    expect(sbStatePda()[0].equals(PublicKey.findProgramAddressSync([Buffer.from('STATE')], SWITCHBOARD_ON_DEMAND_ID)[0])).toBe(true);
    const lutSigner = sbLutSignerPda(pack)[0];
    expect(lutSigner.equals(PublicKey.findProgramAddressSync([Buffer.from('LutSigner'), pack.toBuffer()], SWITCHBOARD_ON_DEMAND_ID)[0])).toBe(true);
    const slot = 123_456_789n;
    const viaWeb3 = PublicKey.findProgramAddressSync([lutSigner.toBuffer(), Buffer.from(u64le(slot))], new PublicKey('AddressLookupTab1e1111111111111111111111111'))[0];
    expect(sbLutPda(lutSigner, slot)[0].equals(viaWeb3)).toBe(true);
    expect(sbOracleStatsPda(queue)[0].equals(PublicKey.findProgramAddressSync([Buffer.from('OracleRandomnessStats'), queue.toBuffer()], SWITCHBOARD_ON_DEMAND_ID)[0])).toBe(true);
    expect(sbRewardEscrow(pack).equals(ata(WSOL_MINT, pack))).toBe(true);
  });
  it('init_randomness: 14 accounts in IDL-mirroring order, data = kind ‖ nonce ‖ recent_slot; arena variant drops kind', () => {
    const acc = rngAccounts(RNG_KIND.PACK, owner, 42n);
    const ix = initRandomnessIx({ ...acc, queue, recentSlot: 1_000n });
    expect(ix.programId.equals(CHIP_CORE_ID)).toBe(true);
    expect(ix.keys).toHaveLength(14);
    expect(ix.keys[0].isSigner && ix.keys[0].pubkey.equals(owner)).toBe(true);
    expect(ix.keys[1].pubkey.equals(acc.randomness) && ix.keys[1].isWritable && !ix.keys[1].isSigner).toBe(true); // PDA: signs inside the program
    expect(ix.keys[2].pubkey.equals(acc.rngAuth)).toBe(true);
    expect(ix.keys[3].pubkey.equals(sbRewardEscrow(acc.randomness))).toBe(true);
    expect(ix.keys[4].pubkey.equals(queue) && ix.keys[4].isWritable).toBe(true);
    expect(ix.keys[7].pubkey.equals(sbLutPda(sbLutSignerPda(acc.randomness)[0], 1_000n)[0]) && ix.keys[7].isWritable).toBe(true);
    expect(hex(new Uint8Array(ix.data).slice(0, 8))).toBe(hex(ixDiscriminator('init_randomness')));
    const r = new BorshReader(new Uint8Array(ix.data), 8); expect(r.u8()).toBe(0); expect(r.u64()).toBe(42n); expect(r.u64()).toBe(1_000n);
    const b = initRandomnessIx({ ...rngAccounts(RNG_KIND.BATTLE, owner, 42n), queue, recentSlot: 1_000n });
    expect(b.programId.equals(ARENA_ID)).toBe(true);
    expect(hex(new Uint8Array(b.data).slice(0, 8))).toBe(hex(ixDiscriminator('init_battle_randomness')));
    expect(new Uint8Array(b.data).length).toBe(8 + 8 + 8);
  });
  it('commit metas: rng_auth, switchboard, queue (ro), oracle (rw), slot_hashes', () => {
    const oracle = Keypair.generate().publicKey;
    const m = commitAccountMetas({ kind: RNG_KIND.FUSION, queue, oracle });
    expect(m.map((k) => k.pubkey.toBase58())).toEqual([rngAuthPda(RNG_KIND.FUSION)[0], SWITCHBOARD_ON_DEMAND_ID, queue, oracle, SYSVAR_SLOT_HASHES_ID].map((k) => k.toBase58()));
    expect(m.map((k) => k.isWritable)).toEqual([false, false, false, true, false]);
  });
  it('reveal_randomness re-wraps the SDK payload (signature ‖ recovery_id ‖ value) behind our PDA-signed CPI', () => {
    const sig = crypto.getRandomValues(new Uint8Array(64));
    const value = crypto.getRandomValues(new Uint8Array(32));
    const sdkData = concat(new Uint8Array(8), sig, Uint8Array.of(1), value);
    const sdkIx = new TransactionInstruction({ programId: SWITCHBOARD_ON_DEMAND_ID, keys: [], data: Buffer.from(sdkData) });
    const p = revealPayloadFromIx(sdkIx);
    expect(hex(p.signature)).toBe(hex(sig)); expect(p.recoveryId).toBe(1); expect(hex(p.value)).toBe(hex(value));
    const oracle = Keypair.generate().publicKey;
    const rng = rngPda(RNG_KIND.PACK, owner, 1n)[0];
    const ix = revealRandomnessIx({ kind: RNG_KIND.PACK, payer: owner, randomness: rng, oracle, queue, ...p });
    expect(ix.programId.equals(CHIP_CORE_ID)).toBe(true);
    expect(ix.keys).toHaveLength(13);
    expect(ix.keys[1].pubkey.equals(rng) && ix.keys[1].isWritable).toBe(true);
    expect(ix.keys[5].pubkey.equals(sbOracleStatsPda(oracle)[0]) && ix.keys[5].isWritable).toBe(true);
    expect(ix.keys[6].pubkey.equals(sbRewardEscrow(rng)) && ix.keys[6].isWritable).toBe(true);
    // same payload layout as Switchboard's own instruction → `revealValueFromIx` works on both
    expect(hex(new Uint8Array(ix.data).slice(0, 8))).toBe(hex(ixDiscriminator('reveal_randomness')));
    expect(hex(revealValueFromIx(ix))).toBe(hex(value));
    expect(new Uint8Array(ix.data).length).toBe(8 + 64 + 1 + 32);
    expect(() => revealRandomnessIx({ kind: RNG_KIND.PACK, payer: owner, randomness: rng, oracle, queue, signature: new Uint8Array(10), recoveryId: 0, value })).toThrow(/64 bytes/);
    const b = revealRandomnessIx({ kind: RNG_KIND.BATTLE, payer: owner, randomness: rng, oracle, queue, ...p });
    expect(b.programId.equals(ARENA_ID)).toBe(true);
    expect(hex(new Uint8Array(b.data).slice(0, 8))).toBe(hex(ixDiscriminator('reveal_battle_randomness')));
  });
  it('close_randomness pins the pending / battle PDA that must be gone and pays rent to the owner', () => {
    const payer = Keypair.generate().publicKey;
    const acc = rngAccounts(RNG_KIND.PACK, owner, 5n);
    const ix = closeRandomnessIx({ ...acc, payer, lutSlot: 77n });
    expect(ix.keys).toHaveLength(14);
    expect(ix.keys[0].pubkey.equals(payer) && ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[1].pubkey.equals(owner) && ix.keys[1].isWritable && !ix.keys[1].isSigner).toBe(true); // permissionless, rent → owner
    expect(ix.keys[3].pubkey.equals(acc.rngAuth) && ix.keys[3].isWritable).toBe(true);
    expect(ix.keys[4].pubkey.equals(pendingPackPda(owner, 5n)[0])).toBe(true);
    expect(ix.keys[7].pubkey.equals(sbLutPda(sbLutSignerPda(acc.randomness)[0], 77n)[0])).toBe(true);
    const r = new BorshReader(new Uint8Array(ix.data), 8); expect(r.u8()).toBe(0); expect(r.u64()).toBe(5n);
    const b = closeRandomnessIx({ ...rngAccounts(RNG_KIND.BATTLE, owner, 5n), payer, lutSlot: 77n });
    expect(b.programId.equals(ARENA_ID)).toBe(true);
    expect(hex(new Uint8Array(b.data).slice(0, 8))).toBe(hex(ixDiscriminator('close_battle_randomness')));
    expect(new Uint8Array(b.data).length).toBe(8 + 8);
  });
});

describe('reward Merkle tree (mirrors staking::verify_proof)', () => {
  // Golden vector — the same numbers are asserted in programs/staking/src/lib.rs (`merkle_golden_vector`).
  const w = (b: number) => new Uint8Array(32).fill(b);
  const leaves = [
    { wallet: w(1), amountMicro: 1_500_000n, kind: 2, epoch: 7 },
    { wallet: w(2), amountMicro: 12_500_000n, kind: 5, epoch: 7 },
    { wallet: w(3), amountMicro: 1n, kind: 6, epoch: 1 },
  ];
  it('leaf = keccak(0x00 ‖ wallet ‖ amount_le ‖ kind ‖ epoch_le)', () => {
    expect(toHex(rewardLeaf(leaves[0]))).toBe('3d0d922cddaa7e75b60963bd999a604e5c858d5996620351b1857bc242a0259f');
    expect(toHex(rewardLeaf(leaves[1]))).toBe('3a27eed74dbc6ba29f5ed01add35e3e8f65abd55b131524fc1d62bab72c3f390');
    expect(toHex(rewardLeaf(leaves[2]))).toBe('336bae46ed31ed8c92d7c24cf5b9a5198429de1836830e92e3229a2e89a636b6');
  });
  it('node = keccak(0x01 ‖ min ‖ max); odd layer promotes the last node; root pinned', () => {
    expect(toHex(hashPair(rewardLeaf(leaves[0]), rewardLeaf(leaves[1])))).toBe('7f8ee1caec715d020b43c5887cbaa71c543171c2dec8317b73866d4bb1326fb9');
    expect(toHex(hashPair(rewardLeaf(leaves[1]), rewardLeaf(leaves[0])))).toBe('7f8ee1caec715d020b43c5887cbaa71c543171c2dec8317b73866d4bb1326fb9'); // order-independent
    const t = buildRewardTree(leaves);
    expect(toHex(t.root)).toBe('08a5f93435e89ae1fb9ea8821bf61eb469008c475d327b0a0114dd1e980b5027');
    expect(t.proofs[2].map(toHex)).toEqual(['7f8ee1caec715d020b43c5887cbaa71c543171c2dec8317b73866d4bb1326fb9']);
    leaves.forEach((l, i) => expect(verifyRewardProof(l, t.proofs[i], t.root)).toBe(true));
  });
  it('rejects: wrong amount / kind (cross-currency replay) / epoch / wallet / proof > 24', () => {
    const t = buildRewardTree(leaves);
    expect(verifyRewardProof({ ...leaves[0], amountMicro: 1_500_001n }, t.proofs[0], t.root)).toBe(false);
    expect(verifyRewardProof({ ...leaves[0], kind: 5 }, t.proofs[0], t.root)).toBe(false);
    expect(verifyRewardProof({ ...leaves[0], epoch: 8 }, t.proofs[0], t.root)).toBe(false);
    expect(verifyRewardProof({ ...leaves[0], wallet: w(9) }, t.proofs[0], t.root)).toBe(false);
    expect(verifyRewardProof(leaves[0], t.proofs[1], t.root)).toBe(false);
    expect(verifyRewardProof(leaves[0], Array.from({ length: MAX_PROOF_LEN + 1 }, () => w(0)), t.root)).toBe(false);
    // a leaf hash can never be presented as an inner node (domain separation 0x00 vs 0x01)
    expect(toHex(hashPair(w(1), w(2)))).not.toBe(toHex(rewardLeaf({ wallet: w(1), amountMicro: 0n, kind: 0, epoch: 0 })));
  });
  it('large tree: every leaf verifies, proofs ≤ 24 for 2^24 capacity, hex round-trip', () => {
    const many = Array.from({ length: 1_001 }, (_, i) => ({ wallet: Keypair.generate().publicKey, amountMicro: BigInt(i + 1) * 1_000_000n, kind: 2 + (i % 3), epoch: 42 }));
    const t = buildRewardTree(many);
    expect(t.proofs.every((p) => p.length <= 10)).toBe(true);
    for (let i = 0; i < many.length; i += 97) expect(verifyRewardProof(many[i], t.proofs[i], t.root)).toBe(true);
    expect(toHex(fromHex(toHex(t.root)))).toBe(toHex(t.root));
  });
});

describe('compressed Bubblegum V2 market builders', () => {
  it('keeps list/cancel account order and serializes the custom asset listing args', () => {
    const seller = Keypair.generate().publicKey;
    const asset = Keypair.generate().publicKey;
    const claim = Keypair.generate().publicKey;
    const listed = listCompressedAssetIx({ seller, asset, collectionIdx: 4, claim, price: 2_000_000n, currency: 0 });
    expect(listed.keys.slice(0, 3).map((k) => k.pubkey.toBase58())).toEqual([seller.toBase58(), listed.keys[1].pubkey.toBase58(), asset.toBase58()]);
    expect(listed.data.subarray(0, 8)).toEqual(Buffer.from(ixDiscriminator('list_compressed_asset')));
    const cancelled = cancelCompressedAssetIx({ seller, asset, claim });
    expect(cancelled.keys.map((k) => k.pubkey.toBase58()).slice(0, 3)).toEqual([seller.toBase58(), cancelled.keys[1].pubkey.toBase58(), claim.toBase58()]);
    expect(cancelled.data.subarray(0, 8)).toEqual(Buffer.from(ixDiscriminator('cancel_compressed_asset')));
  });

  it('fails closed when owner, delegate, or tree does not match the proof input', () => {
    const seller = Keypair.generate().publicKey;
    const buyer = Keypair.generate().publicKey;
    const asset = Keypair.generate().publicKey;
    const delegate = Keypair.generate().publicKey;
    const proof: BubblegumProof = {
      assetId: asset, leafOwner: seller, leafDelegate: delegate, merkleTree: Keypair.generate().publicKey,
      root: new Uint8Array(32), dataHash: new Uint8Array(32), creatorHash: new Uint8Array(32), collectionHash: new Uint8Array(32), assetDataHash: new Uint8Array(32), flags: 0, leafNonce: 1n, leafIndex: 2n, proof: [],
    };
    const args = { buyer, asset, claim: Keypair.generate().publicKey, seller, proof, delegate, treeConfig: Keypair.generate().publicKey, merkleTree: proof.merkleTree, coreCollection: Keypair.generate().publicKey, treasury: Keypair.generate().publicKey, buyback: Keypair.generate().publicKey, expectedPrice: 1n };
    expect(() => buyCompressedAssetIx({ ...args, seller: Keypair.generate().publicKey })).toThrow('proof does not match');
    expect(() => buyCompressedAssetIx({ ...args, merkleTree: Keypair.generate().publicKey })).toThrow('proof tree');
  });

  it('uses the exact market account order and raw LeafProofArgs bytes', () => {
    const seller = Keypair.generate().publicKey;
    const buyer = Keypair.generate().publicKey;
    const asset = Keypair.generate().publicKey;
    const delegate = Keypair.generate().publicKey;
    const tree = Keypair.generate().publicKey;
    const proof: BubblegumProof = {
      assetId: asset, leafOwner: seller, leafDelegate: delegate, merkleTree: tree,
      root: new Uint8Array(32).fill(1), dataHash: new Uint8Array(32).fill(2), creatorHash: new Uint8Array(32).fill(3), collectionHash: new Uint8Array(32).fill(4), assetDataHash: new Uint8Array(32).fill(5), flags: 7, leafNonce: 8n, leafIndex: 9n, proof: [Keypair.generate().publicKey, Keypair.generate().publicKey],
    };
    const ix = buyCompressedAssetIx({ buyer, asset, claim: Keypair.generate().publicKey, seller, proof, delegate, treeConfig: bubblegumTreeConfigPda(tree)[0], merkleTree: tree, coreCollection: Keypair.generate().publicKey, treasury: Keypair.generate().publicKey, buyback: Keypair.generate().publicKey, expectedPrice: 1_234_567n });
    expect(ix.keys[0].pubkey.equals(buyer)).toBe(true);
    expect(ix.keys[7].pubkey.equals(seller)).toBe(true);
    expect(ix.keys[8].pubkey.equals(seller)).toBe(true);
    expect(ix.keys[9].pubkey.equals(delegate)).toBe(true);
    expect(ix.keys[11].pubkey.equals(tree)).toBe(true);
    expect(ix.keys.slice(-2).map((k) => k.pubkey.toBase58())).toEqual(proof.proof.map((k) => k.toBase58()));
    const proofOffset = 8 + 32;
    expect(ix.data.subarray(proofOffset, proofOffset + 32)).toEqual(Buffer.from(proof.root));
    expect(ix.data[proofOffset + 32 * 5]).toBe(proof.flags);
    expect(ix.data.readBigUInt64LE(proofOffset + 32 * 5 + 1)).toBe(8n);
    expect(ix.data.readUInt32LE(proofOffset + 32 * 5 + 1 + 8)).toBe(9);
    // SEC-F5: the quoted price trails the proof args and ends the instruction data
    expect(ix.data.length).toBe(proofOffset + 32 * 5 + 1 + 8 + 4 + 8);
    expect(ix.data.readBigUInt64LE(proofOffset + 32 * 5 + 1 + 8 + 4)).toBe(1_234_567n);
  });
});

describe('economy glue', () => {
  it('golden vectors: expandRandomness matches Rust-verified fixtures', () => {
    const skus = ['starter', 'standard', 'premium', 'limited'] as const;
    for (const v of golden.vectors) {
      const vrf = Uint8Array.from(v.vrf);
      expect([0, 1, 2, 3, 4].map((s) => uniformBps(vrf, s))).toEqual(v.uniform);
      const out = expandRandomness(vrf, PACKS[skus[v.sku]], v.pity, v.pool).map((r) => [r.rarity, r.collectionIdx]);
      expect(out).toEqual(v.out);
    }
  });
  it('bundle sub-seed = keccak(value ‖ pack_no), single pack = value', () => {
    const v = new Uint8Array(32).fill(1);
    expect(packSeed(v, 1, 0)).toBe(v);
    expect(hex(packSeed(v, 5, 0))).not.toBe(hex(v));
    expect(hex(packSeed(v, 5, 0))).not.toBe(hex(packSeed(v, 5, 1)));
    expect(hex(packSeed(v, 5, 1))).toBe(hex(packSeed(v, 5, 1)));
  });
  it('sale split 90 / 2.5 royalty / 7.5 fee (⅓ buyback-burn, ⅔ treasury); live fee override', () => {
    const s = saleSplit(1_000_000n);
    expect(s.seller).toBe(900_000n); expect(s.royalty).toBe(25_000n); expect(s.fee).toBe(75_000n); expect(s.buyback).toBe(24_997n); expect(s.treasury).toBe(50_003n);
    expect(s.fee + s.royalty + s.seller).toBe(1_000_000n);
    const live = saleSplit(1_000_000n, 600); expect(live.fee).toBe(60_000n); expect(live.seller).toBe(915_000n);
    expect(saleSplit(1_000_000n, 5_000).fee).toBe(100_000n); // hard cap 10 %
  });
  it('wager split (5 % rake → 40 treasury / 40 burn / 20 pool) & leagues', () => {
    const w = wagerSplit(100_000_000n);
    expect(w.pot).toBe(200_000_000n); expect(w.rake).toBe(10_000_000n); expect(w.payout).toBe(190_000_000n);
    expect(w.treasury).toBe(4_000_000n); expect(w.seasonPool).toBe(2_000_000n); expect(w.burn).toBe(4_000_000n);
    expect(w.treasury + w.seasonPool + w.burn).toBe(w.rake);
    expect(leagueOf(799)).toBe(0); expect(leagueOf(800)).toBe(1); expect(leagueOf(7000)).toBe(5);
  });
  it('reward claims route by root kind: 2..4 → claim_root ($CG mint), 5..7 → claim_skr_root (prize-pool vault)', () => {
    const wallet = Keypair.generate().publicKey, cgMint = Keypair.generate().publicKey, skrMint = Keypair.generate().publicKey;
    const base = { wallet, epoch: 7, amount: 12_500_000n, proof: [new Uint8Array(32).fill(1)] };
    const cg = claimAnyRootIx({ ...base, kind: 2, cgMint, skrMint });
    const skr = claimAnyRootIx({ ...base, kind: 5, cgMint, skrMint });
    expect(cg.data.subarray(0, 8)).toEqual(Buffer.from(ixDiscriminator('claim_root')));
    expect(skr.data.subarray(0, 8)).toEqual(Buffer.from(ixDiscriminator('claim_skr_root')));
    expect(cg.data.subarray(8)).toEqual(skr.data.subarray(8)); // identical args: amount + proof
    // $CG path: 8 accounts, mints to ata(cg, wallet); emission is writable (minted_total)
    expect(cg.keys).toHaveLength(8);
    expect(cg.keys[1].pubkey.equals(emissionPda()[0]) && cg.keys[1].isWritable).toBe(true);
    expect(cg.keys[5].pubkey.equals(ata(cgMint, wallet))).toBe(true);
    // SKR path: 9 accounts — emission read-only, skr_pool + its vault writable, wallet SKR ATA
    expect(skr.keys).toHaveLength(9);
    expect(skr.keys[1].isWritable).toBe(false);
    const [pool] = skrPoolPda();
    expect(skr.keys[2].pubkey.equals(pool)).toBe(true);
    expect(skr.keys[5].pubkey.equals(ata(skrMint, pool))).toBe(true);
    expect(skr.keys[6].pubkey.equals(ata(skrMint, wallet))).toBe(true);
    expect(skr.keys[3].pubkey.equals(rewardRootPda(5, 7)[0])).toBe(true);
    // cross-currency misuse is rejected client-side (and on-chain by WrongRootCurrency)
    expect(() => claimRootIx({ ...base, kind: 5, cgMint })).toThrow(/SKR root/);
    expect(() => claimSkrRootIx({ ...base, kind: 3, skrMint })).toThrow(/\$CG root/);
    expect(() => claimAnyRootIx({ ...base, kind: 6, cgMint })).toThrow(/SKR mint/);
    // item path (kind 8, backlog #27): claim_item_root — no mints, ["rewarder"] + chip_core config + ["items", wallet] for the grant_booster CPI
    const item = claimAnyRootIx({ ...base, kind: 8, amount: 2n });
    expect(item.data.subarray(0, 8)).toEqual(Buffer.from(ixDiscriminator('claim_item_root')));
    expect(item.data.readBigUInt64LE(8)).toBe(2n);
    expect(item.keys).toHaveLength(9);
    expect(item.keys[1].isWritable).toBe(false);                                        // emission read-only (nothing minted)
    expect(item.keys[2].pubkey.equals(rewardRootPda(8, 7)[0])).toBe(true);
    expect(item.keys[4].pubkey.equals(rewarderPda()[0]) && !item.keys[4].isWritable).toBe(true);
    expect(item.keys[5].pubkey.equals(configPda()[0])).toBe(true);
    expect(item.keys[6].pubkey.equals(playerItemsPda(wallet)[0]) && item.keys[6].isWritable).toBe(true);
    expect(item.keys[7].pubkey.equals(CHIP_CORE_ID)).toBe(true);
    expect(() => claimItemRootIx({ ...base, kind: 8, amount: 11n })).toThrow(/1\.\.10/);  // chip_core grant_booster cap
    expect(() => claimItemRootIx({ ...base, kind: 2 })).toThrow(/not an item root/);
    expect(() => claimRootIx({ ...base, kind: 8, cgMint })).toThrow(/item root/);
    // chip voucher path (kind 9, backlog #28): claim_chip_root — amount = template id, args + nonce; 16 accounts incl. the
    // chip_core pending / pity / randomness PDAs of (wallet, nonce) and the Switchboard commit accounts (open_voucher CPI)
    const queue = Keypair.generate().publicKey, oracle = Keypair.generate().publicKey;
    const chip = claimChipRootIx({ ...base, kind: 9, amount: 1n, nonce: 42n, queue, oracle });
    expect(chip.data.subarray(0, 8)).toEqual(Buffer.from(ixDiscriminator('claim_chip_root')));
    expect(chip.data.readBigUInt64LE(8)).toBe(1n);                                       // template
    expect(chip.data.readUInt32LE(16)).toBe(1);                                          // proof len
    expect(chip.data.readBigUInt64LE(8 + 8 + 4 + 32)).toBe(42n);                          // nonce after the proof
    expect(chip.keys).toHaveLength(16);
    expect(chip.keys[1].isWritable).toBe(false);
    expect(chip.keys[2].pubkey.equals(rewardRootPda(9, 7)[0])).toBe(true);
    expect(chip.keys[4].pubkey.equals(rewarderPda()[0])).toBe(true);
    expect(chip.keys[5].pubkey.equals(configPda()[0])).toBe(true);
    expect(chip.keys[6].pubkey.equals(pityPda(wallet)[0]) && chip.keys[6].isWritable).toBe(true);
    expect(chip.keys[7].pubkey.equals(pendingPackPda(wallet, 42n)[0]) && chip.keys[7].isWritable).toBe(true);
    expect(chip.keys[8].pubkey.equals(rngPda(RNG_KIND.PACK, wallet, 42n)[0]) && chip.keys[8].isWritable).toBe(true);
    expect(chip.keys[9].pubkey.equals(rngAuthPda(RNG_KIND.PACK)[0])).toBe(true);
    expect(chip.keys[11].pubkey.equals(queue) && chip.keys[12].pubkey.equals(oracle) && chip.keys[12].isWritable).toBe(true);
    expect(chip.keys[14].pubkey.equals(CHIP_CORE_ID)).toBe(true);
    expect(() => claimChipRootIx({ ...base, kind: 9, amount: 4n, nonce: 1n, queue, oracle })).toThrow(/0\.\.3/);
    expect(() => claimChipRootIx({ ...base, kind: 8, amount: 1n, nonce: 1n, queue, oracle })).toThrow(/not a chip voucher root/);
    expect(() => claimAnyRootIx({ ...base, kind: 9, cgMint })).toThrow(/claimChipRootIx/);
  });
  it('early exit penalty only while locked', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(unstakePenalty(1_000_000n, 2, BigInt(now + 10), now)).toBe(100_000n);
    expect(unstakePenalty(1_000_000n, 2, BigInt(now - 10), now)).toBe(0n);
    // SEC-F3: rounded up like the program — dust chunks still burn ≥ 1 micro, flex never does
    expect(unstakePenalty(19n, 1, BigInt(now + 10), now)).toBe(1n);
    expect(unstakePenalty(1n, 3, BigInt(now + 10), now)).toBe(1n);
    expect(unstakePenalty(201n, 1, BigInt(now + 10), now)).toBe(11n);
    expect(unstakePenalty(19n, 0, BigInt(now + 10), now)).toBe(0n);
  });
  it('SEC-L5 fund_slice: 6 accounts in program order (authority, emission, cg_mint, ["season_pool"] auth, its $CG ATA, token program), args kind u8 = 3 + amount u64', () => {
    const authority = Keypair.generate().publicKey, cgMint = Keypair.generate().publicKey;
    const ix = fundSliceIx({ authority, amount: 4_000_000n, cgMint });
    const [auth] = seasonPoolAuthPda();
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([authority, emissionPda()[0], cgMint, auth, ata(cgMint, auth), new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')].map((k) => k.toBase58()));
    expect(ix.keys.map((k) => [k.isSigner, k.isWritable])).toEqual([[true, false], [false, true], [false, true], [false, false], [false, true], [false, false]]);
    expect(Buffer.from(ix.data.subarray(0, 8)).toString('hex')).toBe(Buffer.from(ixDiscriminator('fund_slice')).toString('hex'));
    expect(ix.data.length).toBe(8 + 1 + 8);
    expect(ix.data[8]).toBe(SLICE_PVP_SEASON);
    expect(new BorshReader(ix.data.subarray(9)).u64()).toBe(4_000_000n);
    // the season pool the arena was initialised with must be this exact ATA (setup.ts / localnet env)
    expect(auth.equals(emissionPda()[0])).toBe(false);
  });
});

describe('switchboard reveal parsing', () => {
  it('extracts the 32-byte value at offset 73', () => {
    const value = crypto.getRandomValues(new Uint8Array(32));
    const data = concat(new Uint8Array(8), new Uint8Array(64), Uint8Array.of(1), value);
    const ix = new TransactionInstruction({ programId: CHIP_CORE_ID, keys: [], data: Buffer.from(data) });
    expect(hex(revealValueFromIx(ix))).toBe(hex(value));
  });
});

describe('formatting', () => {
  it('base58 matches web3 PublicKey encoding', () => {
    const k = Keypair.generate().publicKey;
    expect(base58Encode(k.toBytes())).toBe(k.toBase58());
    expect(base58Encode(new Uint8Array([0, 0, 1]))).toBe('112');
  });
  it('units', () => {
    expect(fmtUnits(1_234_567_890n, 9, 3)).toBe('1.234');
    expect(fmtUnits(1_000_000n, 6, 2, 2)).toBe('1.00');
    expect(parseUnits('0.25', 9)).toBe(250_000_000n);
    expect(parseUnits('12', 6)).toBe(12_000_000n);
    expect(parseUnits('abc', 6)).toBeNull();
  });
});

describe('pyth quoting (SOL + SKR rails)', () => {
  const feedSol = { price: 15_000_000_000n, conf: 0n, exponent: -8, publishTime: 0n, feedIdHex: PYTH_SOL_USD_FEED_ID_HEX }; // $150.00
  const feedSkr = { price: 1_740_000n, conf: 0n, exponent: -8, publishTime: 0n, feedIdHex: PYTH_SKR_USD_FEED_ID_HEX };       // $0.0174
  it('usdCentsToUnits matches the on-chain integer formula for both decimals', () => {
    expect(usdCentsToLamports(499n, feedSol)).toBe((499n * 1_000_000_000n * 100_000_000n) / 100n / 15_000_000_000n); // 4.99 USD → 0.03326666 SOL
    expect(usdCentsToLamports(499n, feedSol)).toBe(33_266_666n);
    expect(usdCentsToMicroSkr(499n, feedSkr)).toBe((499n * 1_000_000n * 100_000_000n) / 100n / 1_740_000n);            // 4.99 USD → 286.78 SKR
    expect(usdCentsToMicroSkr(499n, feedSkr)).toBe(286_781_609n);
    expect(usdCentsToUnits(100n, feedSol, 9)).toBe(usdCentsToLamports(100n, feedSol));
    // SEC-M2: charged at price − conf; conf/price > 2 % is refused exactly like chip_core (PriceUncertain)
    expect(usdCentsToLamports(499n, { ...feedSol, conf: 7_500_000n })).toBe(33_283_308n);
    expect(isConfident({ ...feedSol, conf: 300_000_000n })).toBe(true);
    expect(isConfident({ ...feedSol, conf: 300_000_001n })).toBe(false);
    expect(() => usdCentsToLamports(499n, { ...feedSol, conf: 300_000_001n })).toThrow(PythConfidenceError);
    expect(PYTH_MAX_CONF_BPS).toBe(200);
  });
  it('display price and feed guard', () => {
    expect(priceUsd(feedSol)).toBeCloseTo(150, 6);
    expect(priceUsd(feedSkr)).toBeCloseTo(0.0174, 8);
    expect(() => assertFeed(feedSkr, PYTH_SOL_USD_FEED_ID_HEX, 'SOL/USD')).toThrow(/SOL\/USD/);
    expect(() => assertFeed(feedSkr, PYTH_SKR_USD_FEED_ID_HEX, 'SKR/USD')).not.toThrow();
    expect(() => usdCentsToUnits(1n, { ...feedSol, price: 0n }, 9)).toThrow();
  });
  it('push-oracle PDAs for our shard 0xCA75 match ids.ts / backend / ops (owner decision Q7)', () => {
    expect(PYTH_SHARD_ID).toBe(0xca75);
    expect(pushOracleAccount(PYTH_SOL_USD_FEED_ID_HEX).toBase58()).toBe(PYTH_PRICE_ACCOUNTS.SOL.toBase58());
    expect(pushOracleAccount(PYTH_SKR_USD_FEED_ID_HEX).toBase58()).toBe(PYTH_PRICE_ACCOUNTS.SKR.toBase58());
    expect(PYTH_PRICE_ACCOUNTS.SOL.toBase58()).toBe('ELp9x5sFxGJ7zTurykU2p6A9nKDx72b3xzPxfsB5S8GB');
    expect(pushOracleAccount(PYTH_SOL_USD_FEED_ID_HEX, 0).toBase58()).toBe(PYTH_SPONSORED_SOL_USD.toBase58()); // Pyth's own shard 0
  });
  it('freshness mirrors the program window (60 s) with the 45 s alert margin', () => {
    const p = { ...feedSol, publishTime: 1_000n };
    expect(priceAgeS(p, 1_030)).toBe(30);
    expect(isFresh(p, undefined, 1_045)).toBe(true);
    expect(isFresh(p, undefined, 1_046)).toBe(false);
    expect(isFresh(p, PYTH_MAX_AGE_S, 1_060)).toBe(true);
    expect(isFresh(p, PYTH_MAX_AGE_S, 1_061)).toBe(false);
  });
});

describe('transaction sizing (docs/06 §4.2 вывод 3)', () => {
  const payer = Keypair.generate().publicKey, oracle = Keypair.generate().publicKey, queue = Keypair.generate().publicKey;
  const cores = Array.from({ length: 10 }, () => Keypair.generate().publicKey);
  const rng = rngPda(RNG_KIND.PACK, payer, 1n)[0];
  const reveal = revealRandomnessIx({ kind: RNG_KIND.PACK, payer, randomness: rng, oracle, queue, signature: new Uint8Array(64), recoveryId: 0, value: new Uint8Array(32) });
  const open3 = openPackIx({ payer, buyer: payer, nonce: 1n, packNo: 0, randomness: rng, rolledCollections: [0, 1, 2], coreCollectionOf: (i) => cores[i] });
  const open5cg = openPackIx({ payer, buyer: payer, nonce: 1n, packNo: 0, randomness: rng, rolledCollections: [0, 1, 2, 3, 4], coreCollectionOf: (i) => cores[i], cg: { cgMint: Keypair.generate().publicKey, treasury: Keypair.generate().publicKey } });
  it('open_pack alone fits; reveal + open_pack does NOT fit without a lookup table (→ flows split into two transactions)', () => {
    expect(fitsInTx(payer, [open3])).toBe(true);
    expect(fitsInTx(payer, [open5cg])).toBe(false); // 5-chip $CG open needs the LUT even on its own (~1 300 B)
    expect(fitsInTx(payer, [reveal, open3])).toBe(false);
    expect(fitsInTx(payer, [reveal, open5cg])).toBe(false);
  });
  it('with the static LUT from scripts/create-lut.ts both variants fit in one transaction', () => {
    const lut = new AddressLookupTableAccount({ key: Keypair.generate().publicKey, state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [
      CHIP_CORE_ID, SWITCHBOARD_ON_DEMAND_ID, SYSVAR_SLOT_HASHES_ID, WSOL_MINT, PublicKey.default, sbStatePda()[0], rngAuthPda(RNG_KIND.PACK)[0], configPda()[0], queue,
      ...cores, ...cores.map((_, i) => collectionMetaPda(i)[0]),
      ...allLedgerPdas(), // #12 ledger shards live in the static LUT too
      ...open5cg.keys.slice(5, 14).map((k) => k.pubkey), // pity/buyer/vault/cg optionals/programs
    ] } });
    expect(fitsInTx(payer, [reveal, open3], [lut])).toBe(true);
    expect(fitsInTx(payer, [reveal, open5cg], [lut])).toBe(true);
  });
});

describe('Switchboard program id per cluster (SEC-H1)', () => {
  it('devnet and mainnet are different programs and the localnet mock is a third one', () => {
    const keys = Object.values(SWITCHBOARD_PROGRAM_ID).map((k) => k.toBase58());
    expect(new Set(keys).size).toBe(3);
    expect(SWITCHBOARD_PROGRAM_ID['mainnet-beta'].toBase58()).toBe('SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv');
    expect(SWITCHBOARD_PROGRAM_ID.devnet.toBase58()).toBe('Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2');
  });
});

describe('H3 claim fusion (client mirror)', () => {
  const owner = Keypair.generate().publicKey;
  const cgMint = Keypair.generate().publicKey;
  const materials = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];

  it('RNG_KIND.CLAIM_FUSION = 3 and the claim_fusion PDA is deterministic', () => {
    expect(RNG_KIND.CLAIM_FUSION).toBe(3);
    const [a] = claimFusionPda(owner, 7n);
    const [b] = claimFusionPda(owner, 7n);
    const [c] = claimFusionPda(owner, 8n);
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
    expect(PublicKey.isOnCurve(a.toBytes())).toBe(false);
  });

  it('close_randomness_lut (backlog #23): derived table, rent to the owner, payer signs and only pays the fee', () => {
    const payer = Keypair.generate().publicKey;
    for (const kind of [RNG_KIND.PACK, RNG_KIND.FUSION, RNG_KIND.CLAIM_FUSION, RNG_KIND.BATTLE] as const) {
      const acc = rngAccounts(kind, owner, 5n);
      const ix = closeRandomnessLutIx({ ...acc, payer, lutSlot: 77n });
      const lutSigner = sbLutSignerPda(acc.randomness)[0];
      expect(ix.programId.equals(kind === RNG_KIND.BATTLE ? ARENA_ID : CHIP_CORE_ID)).toBe(true);
      expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([
        payer.toBase58(), owner.toBase58(), acc.randomness.toBase58(),
        (kind === RNG_KIND.PACK ? pendingPackPda(owner, 5n)[0] : kind === RNG_KIND.FUSION ? pendingFusionPda(owner, 5n)[0] : kind === RNG_KIND.CLAIM_FUSION ? claimFusionPda(owner, 5n)[0] : battlePda(owner, 5n)[0]).toBase58(),
        lutSigner.toBase58(), sbLutPda(lutSigner, 77n)[0].toBase58(), SWITCHBOARD_ON_DEMAND_ID.toBase58(),
        ADDRESS_LOOKUP_TABLE_PROGRAM_ID.toBase58(), SYSTEM_PROGRAM_ID.toBase58(),
      ]);
      expect(ix.keys[0].isSigner).toBe(true);
      // exactly three writable accounts: the relayer (fee only), the owner (rent) and the table.
      // The rent destination is Switchboard's `recipient`, pinned to `owner` by the program — the
      // builder cannot redirect it, which is what the SEC-M8 gate keeps proving on the Rust side.
      expect(ix.keys.filter((k) => k.isWritable).map((k) => k.pubkey.toBase58()))
        .toEqual([payer.toBase58(), owner.toBase58(), sbLutPda(lutSigner, 77n)[0].toBase58()]);
      const name = kind === RNG_KIND.BATTLE ? 'close_battle_randomness_lut' : 'close_randomness_lut';
      expect(hex(new Uint8Array(ix.data).slice(0, 8))).toBe(hex(ixDiscriminator(name)));
      const r = new BorshReader(new Uint8Array(ix.data), 8);
      if (kind !== RNG_KIND.BATTLE) expect(r.u8()).toBe(kind);
      expect(r.u64()).toBe(5n); expect(r.u64()).toBe(77n); // nonce, then the slot the table is derived from
    }
  });

  it('close_randomness kind 3 pins the claim_fusion PDA (rent still goes to the owner)', () => {
    const payer = Keypair.generate().publicKey;
    const acc = rngAccounts(RNG_KIND.CLAIM_FUSION, owner, 5n);
    const ix = closeRandomnessIx({ ...acc, payer, lutSlot: 77n });
    expect(ix.keys).toHaveLength(14);
    expect(ix.keys[0].pubkey.equals(payer) && ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[1].pubkey.equals(owner) && ix.keys[1].isWritable && !ix.keys[1].isSigner).toBe(true);
    expect(ix.keys[4].pubkey.equals(claimFusionPda(owner, 5n)[0])).toBe(true);
    const r = new BorshReader(new Uint8Array(ix.data), 8); expect(r.u8()).toBe(3); expect(r.u64()).toBe(5n);
  });

  it('fuse_claims_commit: 18 fixed + 3 materials, claim_fusion PDA writable, nonce + booster args', () => {
    const randomness = Keypair.generate().publicKey;
    const queue = Keypair.generate().publicKey;
    const oracle = Keypair.generate().publicKey;
    const ix = fuseClaimsCommitIx({ owner, nonce: 9n, resultCollectionIdx: 2, useBooster: true, randomness, queue, oracle, cgMint, materials });
    expect(ix.keys).toHaveLength(21);
    expect(ix.keys[0].pubkey.equals(owner) && ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[3].pubkey.equals(claimFusionPda(owner, 9n)[0]) && ix.keys[3].isWritable).toBe(true);
    expect(ix.keys[4].pubkey.equals(randomness) && ix.keys[4].isWritable).toBe(true);
    expect(ix.keys[5].pubkey.equals(rngAuthPda(RNG_KIND.CLAIM_FUSION)[0])).toBe(true);
    materials.forEach((m, i) => expect(ix.keys[18 + i].pubkey.equals(m)).toBe(true));
    expect(hex(new Uint8Array(ix.data).slice(0, 8))).toBe(hex(ixDiscriminator('fuse_claims_commit')));
    const r = new BorshReader(new Uint8Array(ix.data), 8); expect(r.u64()).toBe(9n); expect(r.bool()).toBe(true);
    expect(() => fuseClaimsCommitIx({ owner, nonce: 9n, resultCollectionIdx: 2, useBooster: false, randomness, queue, oracle, cgMint, materials: materials.slice(0, 2) })).toThrowError(/exactly 3/);
  });

  it('fuse_claims_reveal: result claim PDA = ["compressed_claim", owner, resultClaimNonce], both nonces in args', () => {
    const payer = Keypair.generate().publicKey;
    const randomness = Keypair.generate().publicKey;
    const ix = fuseClaimsRevealIx({ payer, owner, nonce: 9n, resultClaimNonce: 9n, resultCollectionIdx: 2, randomness, cgMint, materials });
    expect(ix.keys[0].pubkey.equals(payer) && ix.keys[0].isSigner).toBe(true); // permissionless: anyone can reveal
    expect(ix.keys[3].pubkey.equals(claimFusionPda(owner, 9n)[0]) && ix.keys[3].isWritable).toBe(true);
    expect(ix.keys[7].pubkey.equals(compressedMintClaimPda(owner, 9n)[0]) && ix.keys[7].isWritable).toBe(true);
    expect(hex(new Uint8Array(ix.data).slice(0, 8))).toBe(hex(ixDiscriminator('fuse_claims_reveal')));
    const r = new BorshReader(new Uint8Array(ix.data), 8); expect(r.u64()).toBe(9n); expect(r.u64()).toBe(9n);
  });

  it('cancel_stale_claim_fusion / close_expired_claim layouts', () => {
    const randomness = Keypair.generate().publicKey;
    const c = cancelStaleClaimFusionIx({ owner, nonce: 9n, randomness, cgMint, materials });
    expect(c.keys[3].pubkey.equals(claimFusionPda(owner, 9n)[0]) && c.keys[3].isWritable).toBe(true);
    expect(hex(new Uint8Array(c.data).slice(0, 8))).toBe(hex(ixDiscriminator('cancel_stale_claim_fusion')));
    expect(new BorshReader(new Uint8Array(c.data), 8).u64()).toBe(9n);
    const x = closeExpiredClaimIx({ buyer: owner, claimNonce: 41n });
    expect(x.keys).toHaveLength(3);
    expect(x.keys[1].pubkey.equals(compressedMintClaimPda(owner, 41n)[0]) && x.keys[1].isWritable).toBe(true);
    expect(hex(new Uint8Array(x.data).slice(0, 8))).toBe(hex(ixDiscriminator('close_expired_claim')));
    expect(new BorshReader(new Uint8Array(x.data), 8).u64()).toBe(41n);
  });

  it('decodes PendingClaimFusion (same layout as PendingFusion, own discriminator)', () => {
    const randomness = Keypair.generate().publicKey;
    const buf = new BorshWriter()
      .bytes(accountDiscriminator('PendingClaimFusion'))
      .pubkey(owner).u8(3).pubkey(materials[0]).pubkey(materials[1]).pubkey(materials[2])
      .u8(2).bool(true).pubkey(randomness).u64(777n).u64(9n).u8(250).u64(500_000n).toBytes();
    const p = decodePendingClaimFusion(buf);
    expect(p.owner.equals(owner)).toBe(true);
    expect(p.materials.map((m: PublicKey) => m.toBase58())).toEqual(materials.map((m) => m.toBase58()));
    expect(p.resultCollectionIdx).toBe(2);
    expect(p.boosted).toBe(true);
    expect(p.commitSlot).toBe(777n);
    expect(p.nonce).toBe(9n);
    expect(p.feeEscrowed).toBe(500_000n);
  });

  it('claimIsListable (H1): registered + free + soulbound window passed', () => {
    const buyer = Keypair.generate().publicKey;
    const settlement = Keypair.generate().publicKey;
    const origin = Keypair.generate().publicKey;
    const buf = (lockUntil: bigint, registered: boolean) => new BorshWriter()
      .bytes(accountDiscriminator('CompressedMintClaim'))
      .pubkey(buyer).u8(0).u8(4).u8(1).u64(9n).i64(9_999_999_999n)
      .pubkey(settlement).bool(true).bool(true).bool(registered).bool(false).bool(false).u8(1).bool(false).pubkey(origin).i64(lockUntil).toBytes();
    expect(claimIsListable(decodeCompressedMintClaim(buf(0n, true)), 1_000)).toBe(true);
    expect(claimIsListable(decodeCompressedMintClaim(buf(2_000n, true)), 1_000)).toBe(false); // Starter window
    expect(claimIsListable(decodeCompressedMintClaim(buf(2_000n, true)), 2_000)).toBe(true);
    expect(claimIsListable(decodeCompressedMintClaim(buf(0n, false)), 1_000)).toBe(false); // unregistered
  });

  it('decodes the CompressedPackSettled and ClaimFusionRevealed events', () => {
    const buyer = Keypair.generate().publicKey;
    const log = (name: string, body: Uint8Array) => [`Program data: ${btoa(String.fromCharCode(...concat(eventDiscriminator(name), body)))}`];
    const settled = findEvent(log('CompressedPackSettled', new BorshWriter().pubkey(buyer).u64(11n).bool(true).toBytes()), 'CompressedPackSettled', readCompressedPackSettled)!;
    expect(settled.nonce).toBe(11n);
    expect(settled.refunded).toBe(true);
    const resultClaim = Keypair.generate().publicKey;
    const revealed = findEvent(log('ClaimFusionRevealed',
      new BorshWriter().pubkey(buyer).u64(9n).u8(3).pubkey(materials[0]).pubkey(materials[1]).pubkey(materials[2]).pubkey(resultClaim).bool(true).u16(4200).u16(5000).u64(500_000n).toBytes()),
      'ClaimFusionRevealed', readClaimFusionRevealed)!;
    expect(revealed.resultClaim.equals(resultClaim)).toBe(true);
    expect(revealed.success).toBe(true);
    expect(revealed.rollBps).toBe(4200);
    expect(revealed.feeBurned).toBe(500_000n);
  });
});

describe('local V2 leaf verification (client mirror of backend/test/das.test.ts)', () => {
  const h = (n: number) => { const b = new Uint8Array(32); for (let i = 0; i < 32; i++) b[i] = (n * 31 + i * 7) & 0xff; return b; };
  const assetId = new PublicKey('11111111111111111111111111111111');
  const buyer = new PublicKey('HPMr5r9sS5ApWsPNJytZRLbm2jz1veFxTn1wepjAhtho');
  const preimage = { assetId, owner: buyer, delegate: buyer, nonce: 5n, dataHash: h(1), creatorHash: h(2), collectionHash: h(3), assetDataHash: h(4), flags: 0 };

  it('v2LeafHash pins the exact preimage (same golden as the backend)', () => {
    expect(hex(v2LeafHash(preimage))).toBe('25f95abfa2123c24fe9a62bd1de5787ee4b210418b56bf1e32f9d57b248dcee9');
    expect(hex(v2LeafHash({ ...preimage, nonce: 6n }))).toBe('66900117e571570342ab4998e3aff5db6e4c1fc74883d0179b96aed2d62651f8');
    expect(() => v2LeafHash({ ...preimage, flags: 256 })).toThrowError(/flags/);
    expect(() => v2LeafHash({ ...preimage, dataHash: h(1).subarray(1) })).toThrowError(/32 bytes/);
  });

  it('foldCompressionProof is index-directed (same golden as the backend)', () => {
    const leaf = v2LeafHash(preimage);
    const sibs = [h(11), h(12), h(13)];
    expect(hex(foldCompressionProof(leaf, 5n, sibs))).toBe('52844f837f5cbdd6f6be88b697ff8d1ff5d5ca45e8cfd7bd8f81dd75c6f4e2db');
    expect(hex(foldCompressionProof(leaf, 4n, sibs))).not.toBe('52844f837f5cbdd6f6be88b697ff8d1ff5d5ca45e8cfd7bd8f81dd75c6f4e2db');
  });

  const proofFor = (nonce: bigint, ownerOverride?: PublicKey, rootOverride?: Uint8Array): import('./bubblegum').BubblegumProof => {
    const o = ownerOverride ?? buyer;
    const sibs = [new PublicKey(h(11)), new PublicKey(h(12)), new PublicKey(h(13))];
    const leaf = v2LeafHash({ ...preimage, owner: o, delegate: o, nonce });
    const root = rootOverride ?? foldCompressionProof(leaf, 5n, sibs.map((s) => Uint8Array.from(s.toBytes())));
    return {
      assetId, leafOwner: o, leafDelegate: o, merkleTree: new PublicKey(h(9)), root,
      dataHash: preimage.dataHash, creatorHash: preimage.creatorHash, collectionHash: preimage.collectionHash,
      assetDataHash: preimage.assetDataHash, flags: 0, leafNonce: 5n, leafIndex: 5n, proof: sibs,
    };
  };

  it('discoverLeafNonce verifies a fresh mint and a raced leaf (window boundary included)', () => {
    expect(discoverLeafNonce(proofFor(5n), 3, 8, buyer)).toBe(5n);
    expect(discoverLeafNonce(proofFor(6n), 3, 8, buyer)).toBe(6n);
    expect(discoverLeafNonce(proofFor(13n), 3, 8, buyer)).toBe(13n);
    expect(() => discoverLeafNonce(proofFor(14n), 3, 8, buyer)).toThrowError(/does not fold/);
    expect(verifyBubblegumProofLocal(proofFor(5n), 3, buyer)).toBe(5n);
    expect(() => verifyBubblegumProofLocal(proofFor(6n), 3, buyer)).toThrowError(/does not fold/); // zero window
  });

  it('fails closed on owner drift and on inconsistent pairs; short proofs defer to on-chain verify_leaf', () => {
    expect(() => discoverLeafNonce(proofFor(5n, Keypair.generate().publicKey), 3, 8, buyer)).toThrowError(/owner\/delegate/);
    expect(() => discoverLeafNonce(proofFor(5n, undefined, h(21)), 3, 8, buyer)).toThrowError(/does not fold/);
    const short = proofFor(5n);
    expect(discoverLeafNonce({ ...short, proof: short.proof.slice(0, 2) }, 3, 8, buyer)).toBe(5n); // canopied: unchecked locally
  });
});

describe('client DAS resolveClaimAsset (mint → register bridge)', () => {
  const buyer = Keypair.generate().publicKey;
  const core = Keypair.generate().publicKey;
  const assetPk = Keypair.generate().publicKey;
  const treePk = Keypair.generate().publicKey;
  const h = (n: number) => { const b = new Uint8Array(32); for (let i = 0; i < 32; i++) b[i] = (n * 13 + i) & 0xff; return new PublicKey(b).toBase58(); };
  const stubFetch = (itemsByPoll: unknown[][]) => {
    const calls: string[] = [];
    let polls = 0;
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      const req = JSON.parse(init.body) as { id: number; method: string };
      calls.push(req.method);
      if (req.method === 'getAssetsByOwner') {
        const items = itemsByPoll[Math.min(polls, itemsByPoll.length - 1)];
        polls++;
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: req.id, result: { total: items.length, limit: 1000, page: 1, items } }) };
      }
      if (req.method === 'getAsset') {
        return {
          ok: true, json: async () => ({
            result: {
              id: assetPk.toBase58(), interface: 'MplBubblegum', ownership: { owner: buyer.toBase58(), delegate: buyer.toBase58() },
              compression: { compressed: true, tree: treePk.toBase58(), leaf_id: 5, data_hash: h(1), creator_hash: h(2), collection_hash: h(3), asset_data_hash: h(4), flags: 0 },
            },
          }),
        };
      }
      if (req.method === 'getAssetProof') {
        return { ok: true, json: async () => ({ result: { root: h(7), proof: [], tree_id: treePk.toBase58(), node_index: 1_000_005, leaf_id: 5 } }) };
      }
      throw new Error(`unexpected DAS method ${req.method}`);
    }) as unknown as typeof fetch;
    return { fetchImpl, calls, polls: () => polls };
  };
  const hit = { id: assetPk.toBase58(), grouping: [{ group_key: 'collection', group_value: core.toBase58() }], content: { metadata: { name: 'COL2 #9' } }, compression: { compressed: true } };

  it('polls getAssetsByOwner until the indexed name appears, then fetches asset + proof', async () => {
    const other = { ...hit, id: Keypair.generate().publicKey.toBase58(), content: { metadata: { name: 'COL2 #8' } } };
    const uncompressed = { ...hit, id: Keypair.generate().publicKey.toBase58(), compression: { compressed: false } };
    const { fetchImpl, calls, polls } = stubFetch([[], [other, uncompressed], [other, hit]]);
    const sleeps: number[] = [];
    const das = new DasClient({ endpoint: 'http://fake-das', fetchImpl });
    const proof = await das.resolveClaimAsset(buyer, core, 'COL2 #9', { tries: 5, delayMs: 2500, sleep: async (ms) => { sleeps.push(ms); } });
    expect(proof.assetId.equals(assetPk)).toBe(true);
    expect(proof.leafIndex).toBe(5n);
    expect(proof.leafOwner.equals(buyer)).toBe(true);
    expect(polls()).toBe(3);
    expect(sleeps).toEqual([2500, 2500]);
    expect(calls.filter((m) => m === 'getAssetsByOwner').length).toBe(3);
    expect(calls).toContain('getAsset');
    expect(calls).toContain('getAssetProof');
  });

  it('gives up with a transport error after `tries` empty polls (never a phantom asset)', async () => {
    const { fetchImpl, polls } = stubFetch([[]]);
    const das = new DasClient({ endpoint: 'http://fake-das', fetchImpl });
    await expect(das.resolveClaimAsset(buyer, core, 'COL2 #9', { tries: 3, delayMs: 1, sleep: async () => {} })).rejects.toThrowError(/did not index COL2 #9/);
    expect(polls()).toBe(3);
  });
});
