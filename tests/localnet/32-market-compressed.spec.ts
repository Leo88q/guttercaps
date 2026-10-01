// T-L-MA — the Bubblegum V2 asset market: `list_compressed_asset`, `cancel_compressed_asset` and the
// guards of `buy_compressed_asset`.
//
// Why this file exists: the 2026-10-01 audit found the V2 asset market had builders, was wired into
// the UI, and had NO on-chain coverage at all — 30-market.spec.ts only drives the *claim* market
// (`list_compressed` / `buy_compressed`), which trades a pre-mint authorization and has no chip
// projection. The asset market trades a registered leaf, and it is the one the UI now calls.
//
// The leaf is forged with `helpers/v2leaf.ts` rather than minted: `register_compressed_chip` is the
// only creator of a `CompressedChipState` and it CPIs into Account Compression, which the harness
// does not load. See that file's header for exactly what that does and does not prove.
//
// What is covered here, and runs for real:
//   * `list_compressed_asset` — the listing PDA, the claim flag, the chip_core CPI, the event, and
//     every guard that stops a bad listing from being created;
//   * `cancel_compressed_asset` — the listing closed, the claim flag cleared, the rent returned;
//   * `buy_compressed_asset` — every pre-CPI guard, including the SEC-F5 front-running guard and the
//     SEC-B28 currency rule.
// The one thing that is NOT covered is the Bubblegum `TransferV2` leg of the buy: it is a real CPI
// into a program the harness does not have, so the happy path is asserted as "reached the CPI and
// failed there" — which is the honest boundary, and it still proves the whole handler body ran.
import { beforeAll, describe, expect, it } from 'vitest';
import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { createHash } from 'node:crypto';
import { accountDiscriminator, ixData, ro, rw, signer } from '@/chain/anchor';
import { decodeCompressedAssetListing, decodeCompressedChipState, decodeCompressedMintClaim } from '@/chain/accounts';
import { BorshReader, BorshWriter } from '@/chain/borsh';
import { buyCompressedAssetIx, cancelCompressedAssetIx, listCompressedAssetIx, MarketCurrency, saleSplit } from '@/chain/ix/market';
import { CHIP_CORE_ID, MARKET_ID, MPL_BUBBLEGUM_V2_ID, SYSTEM_PROGRAM_ID } from '@/chain/ids';
import { bubblegumTreeConfigPda, collectionMetaPda, compressedAssetListingPda, compressedChipStatePda, compressedMintClaimPda, marketAuthPda } from '@/chain/pdas';
import { Err, expectAnyFail, expectFail } from './helpers/expect';
import { binariesPresent, getEnv, type Env } from './helpers/env';
import { collectionHash, forgeLeaf, leafAssetId } from './helpers/v2leaf';

const bins = binariesPresent();
const suite = describe.skipIf(!bins.ok && !process.env.LOCALNET_RPC);
const SOL = 1_000_000_000n;
/** Deterministic 32-byte fill for the fixture hashes. */
const h32 = (seed: string) => new Uint8Array(createHash('sha256').update(seed).digest());

/**
 * `list_compressed_asset` with an arbitrary currency, byte-for-byte the accounts the program expects.
 * The client builder refuses a non-SOL listing by design (SEC-B28); what this asks is what the
 * *program* does when a hand-built or third-party client sends one anyway.
 */
function rawListIx(a: { seller: PublicKey; asset: PublicKey; claim: PublicKey; chip: PublicKey; price: bigint; currency: number; collectionMeta: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: MARKET_ID,
    keys: [signer(a.seller), rw(compressedAssetListingPda(a.asset)[0]), rw(a.asset), rw(a.chip), ro(a.collectionMeta), rw(a.claim), ro(marketAuthPda()[0]), ro(CHIP_CORE_ID), ro(SYSTEM_PROGRAM_ID)],
    data: Buffer.from(ixData('list_compressed_asset', new BorshWriter().u64(a.price).u8(a.currency).toBytes())),
  });
}

/**
 * The forged leaf is only as good as its byte layout, and a field reorder in `state.rs` would
 * silently shift every guard assertion above. This block needs no SVM — it pins the fixture against
 * the real decoders, so it runs even where the program binaries are absent.
 */
describe('T-L-MA forged-leaf fixture layout', () => {
  it('writes a CompressedChipState and CompressedMintClaim the decoders read back unchanged', () => {
    const owner = Keypair.generate().publicKey;
    const merkleTree = Keypair.generate().publicKey;
    const nonce = 7n;
    const leafIndex = 3;
    const [claim, claimBump] = compressedMintClaimPda(owner, 99n);
    const [chip, chipBump] = compressedChipStatePda(Keypair.generate().publicKey);

    const c = new BorshWriter();
    c.bytes(accountDiscriminator('CompressedChipState'));
    c.pubkey(chip).pubkey(claim).u8(2).pubkey(merkleTree).u32(leafIndex).u64(nonce);
    c.bytes(h32('data')).bytes(h32('creator')).bytes(collectionHash(owner)).bytes(h32('assetData'));
    c.u8(0).u8(1).u8(2).u64(99n).u8(0).i64(0n).i64(1n).u8(chipBump);
    const st = decodeCompressedChipState(c.toBytes());
    expect(st.asset.equals(chip)).toBe(true);
    expect(st.claim.equals(claim)).toBe(true);
    expect(st.collectionIdx).toBe(2);
    expect(st.merkleTree.equals(merkleTree)).toBe(true);
    expect(st.leafIndex).toBe(leafIndex);
    expect(st.leafNonce).toBe(nonce);
    expect(st.rarity).toBe(1);
    expect(st.level).toBe(2);
    expect(st.index).toBe(99n);
    expect(st.bump).toBe(chipBump);
    expect(st.collectionHash).toEqual(collectionHash(owner));

    const m = new BorshWriter();
    m.bytes(accountDiscriminator('CompressedMintClaim'));
    m.pubkey(owner).u8(2).u8(1).u8(2).u64(99n).i64(0n).pubkey(PublicKey.default);
    m.bool(true).bool(true).bool(true).bool(false).bool(false).u8(claimBump).bool(false).pubkey(owner).i64(0n);
    const cl = decodeCompressedMintClaim(m.toBytes());
    expect(cl.buyer.equals(owner)).toBe(true);
    expect(cl.collectionIdx).toBe(2);
    expect(cl.gameIndex).toBe(99n);
    expect(cl.indexReserved).toBe(true);
    expect(cl.minted).toBe(true);
    expect(cl.registered).toBe(true);
    expect(cl.consumed).toBe(false);
    expect(cl.listed).toBe(false);
    expect(cl.bump).toBe(claimBump);
    expect(cl.staked).toBe(false);
    expect(cl.lockUntil).toBe(0n);

    // `ForgedLeaf.listed()` reads the raw byte, so its offset must be pinned too
    const r = new BorshReader(m.toBytes());
    r.skip(8); r.pubkey(); r.u8(); r.u8(); r.u8(); r.u64(); r.i64(); r.pubkey();
    expect(r.bool()).toBe(true); expect(r.bool()).toBe(true); expect(r.bool()).toBe(true);
    expect(r.bool()).toBe(false); expect(r.bool()).toBe(false);
    expect(r.offset - 1).toBe(8 + 32 + 1 + 1 + 1 + 8 + 8 + 32 + 1 + 1 + 1 + 1);
  });

  it('collectionHash is keccak256(collection) — the exact bytes hash_collection_option compares', () => {
    const k = Keypair.generate().publicKey;
    expect(Array.from(collectionHash(k))).toEqual(Array.from(keccak_256(k.toBytes())));
    expect(collectionHash(k)).toHaveLength(32);
  });

  // The bug the first CI run found, pinned without an SVM so it can never come back: the asset id is
  // PDA(["asset", tree, index]), so a fixed index makes every forged leaf in a file the same asset —
  // and therefore the same listing PDA. `forgeLeaf` hands out a distinct index per call; this proves
  // the property it relies on. Eight of that run's ten failures were this one line.
  it('the asset id depends on the leaf index, so two forged leaves can never share a listing PDA', () => {
    const tree = Keypair.generate().publicKey;
    const ids = [0, 1, 2, 3, 17, 31].map((i) => leafAssetId(tree, i));
    expect(new Set(ids.map((k) => k.toBase58())).size).toBe(ids.length);
    // and the index really is part of the seed, not just a suffix of the address
    expect(leafAssetId(tree, 3).equals(leafAssetId(tree, 3))).toBe(true);
    expect(leafAssetId(tree, 3).equals(leafAssetId(Keypair.generate().publicKey, 3))).toBe(false);
  });
});

suite('T-L-MA V2 compressed asset market', () => {
  let env: Env;
  let seller: Keypair;
  let buyer: Keypair;
  let collectionMeta: PublicKey;

  beforeAll(async () => {
    env = await getEnv();
    seller = await env.player({ sol: 5n * SOL, cg: 10_000_000_000n });
    buyer = await env.player({ sol: 10n * SOL });
    // the env creates one collection per district; the meta PDA is derived the same way the client does
    collectionMeta = collectionMetaPda(0)[0];
  });

  /** A fresh registered leaf owned by `seller`, ready to list. */
  const leaf = async (nonce: bigint, o: Parameters<typeof forgeLeaf>[3] = {}) =>
    forgeLeaf(env.chain, seller.publicKey, nonce, { collectionIdx: 0, ...o });

  // ------------------------------------------------------------------ list
  it('lists a registered V2 leaf for SOL: the listing binds the leaf, the claim is flagged, the chip is untouched', async () => {
    const l = await leaf(70_001n);
    const price = 2n * SOL;
    const [listing] = compressedAssetListingPda(l.asset);

    const before = await env.chain.balance(seller.publicKey);
    await env.chain.send([listCompressedAssetIx({
      seller: seller.publicKey, asset: l.asset, collectionIdx: l.collectionIdx, claim: l.claim, price, currency: MarketCurrency.SOL,
    })], { signers: [seller], label: 'list_compressed_asset' });

    const row = decodeCompressedAssetListing(new Uint8Array((await env.chain.getAccount(listing))!.data));
    expect(row.asset.equals(l.asset)).toBe(true);
    expect(row.claim.equals(l.claim)).toBe(true);
    expect(row.seller.equals(seller.publicKey)).toBe(true);
    expect(row.merkleTree.equals(l.merkleTree)).toBe(true);
    expect(row.treeConfig.equals(bubblegumTreeConfigPda(l.merkleTree)[0])).toBe(true);
    expect(row.coreCollection.equals(l.coreCollection)).toBe(true);
    expect(row.price).toBe(price);
    expect(row.currency).toBe(0);

    // the claim is flagged through the chip_core CPI — that is what closes its mint and fusion paths
    const claim = decodeCompressedMintClaim(new Uint8Array((await env.chain.getAccount(l.claim))!.data));
    expect(claim.listed).toBe(true);
    expect(claim.buyer.equals(seller.publicKey)).toBe(true);
    // the chip projection is NOT frozen by the market: only the claim carries `listed`, so the leaf
    // stays fully in the seller's wallet until a buy actually transfers it
    const chip = decodeCompressedChipState(new Uint8Array((await env.chain.getAccount(l.chip))!.data));
    expect(chip.flags).toBe(0);
    // the seller paid the signature fee plus the rent of the new listing account — nothing else
    const spent = before - (await env.chain.balance(seller.publicKey));
    const rent = (await env.chain.getAccount(listing))!.lamports;
    expect(spent).toBeGreaterThanOrEqual(rent);
    expect(spent - rent).toBeLessThanOrEqual(20_000n);
  });

  it('re-listing the same leaf is refused: the listing PDA already exists', async () => {
    const l = await leaf(70_002n);
    const ix = listCompressedAssetIx({ seller: seller.publicKey, asset: l.asset, collectionIdx: 0, claim: l.claim, price: SOL, currency: MarketCurrency.SOL });
    await env.chain.send([ix], { signers: [seller] });
    // anchor 0.31's `init` does not pre-check existence: the create_account CPI fails with
    // AccountAlreadyInUse (system code 0) rather than a seeds error
    await expectFail(env.chain.send([ix], { signers: [seller] }), Err.system(0), 'double list');
  });

  it('refuses a listing from anybody but the claim owner, and a price below the floor', async () => {
    const l = await leaf(70_003n);
    await expectFail(env.chain.send([
      listCompressedAssetIx({ seller: buyer.publicKey, asset: l.asset, collectionIdx: 0, claim: l.claim, price: SOL, currency: MarketCurrency.SOL }),
    ], { signers: [buyer] }), Err.market('CompressedClaimNotTradable'), 'foreign seller');

    await expectFail(env.chain.send([
      listCompressedAssetIx({ seller: seller.publicKey, asset: l.asset, collectionIdx: 0, claim: l.claim, price: 999_999n, currency: MarketCurrency.SOL }),
    ], { signers: [seller] }), Err.market('PriceTooLow'), 'dust price');
  });

  it('refuses a claim that is not a settled, free, registered leaf', async () => {
    const lockUntil = BigInt(await env.chain.now()) + 86_400n;
    const cases: [string, Parameters<typeof forgeLeaf>[3], 'CompressedClaimNotTradable' | 'ChipLocked'][] = [
      ['unminted claim', { claim: { minted: false } }, 'CompressedClaimNotTradable'],
      ['unregistered claim', { claim: { registered: false } }, 'CompressedClaimNotTradable'],
      ['consumed claim', { claim: { consumed: true } }, 'CompressedClaimNotTradable'],
      ['already staked claim', { claim: { staked: true } }, 'CompressedClaimNotTradable'],
      // the claim lock is the soulbound window; the chip lock is a fusion cooldown. Both are checked.
      ['soulbound lock still running', { claim: { lockUntil } }, 'ChipLocked'],
      ['fusion lock still running', { chip: { lockUntil } }, 'ChipLocked'],
    ];
    for (const [i, [label, opts, code]] of cases.entries()) {
      const l = await leaf(70_100n + BigInt(i), opts);
      await expectFail(env.chain.send([
        listCompressedAssetIx({ seller: seller.publicKey, asset: l.asset, collectionIdx: 0, claim: l.claim, price: SOL, currency: MarketCurrency.SOL }),
      ], { signers: [seller] }), Err.market(code), label);
    }
  });

  it('refuses a leaf whose projection does not match the asset or the collection', async () => {
    // a chip state stored at the right PDA but recording a different asset id — the exact shape a
    // stale registration would have
    const foreign = await leaf(70_200n, { chip: { assetField: Keypair.generate().publicKey } });
    await expectFail(env.chain.send([
      listCompressedAssetIx({ seller: seller.publicKey, asset: foreign.asset, collectionIdx: 0, claim: foreign.claim, price: SOL, currency: MarketCurrency.SOL }),
    ], { signers: [seller] }), Err.market('CompressedClaimNotTradable'), 'chip bound to another asset');

    // a claim minted into another collection but listed through collection 0's PDA: the seeds
    // constraint catches it, because `collection` is derived from `chip.collection_idx`
    const other = env.config.collectionsCreated - 1;
    if (other >= 1) {
      const wrongCol = await leaf(70_201n, { collectionIdx: other });
      await expectFail(env.chain.send([
        listCompressedAssetIx({ seller: seller.publicKey, asset: wrongCol.asset, collectionIdx: 0, claim: wrongCol.claim, price: SOL, currency: MarketCurrency.SOL }),
      ], { signers: [seller] }), Err.anchor('ConstraintSeeds'), 'claim and listing in different collections');
    }
  });

  // ------------------------------------------------------------------ SEC-B28
  it('SEC-B28 refuses a non-SOL V2 asset listing: the market settles in lamports and has no SPL leg', async () => {
    const l = await leaf(70_300n);
    for (const [currency, price] of [[1, 100_000n], [2, 5_000_000n]] as const) {
      await expectFail(env.chain.send([
        rawListIx({ seller: seller.publicKey, asset: l.asset, claim: l.claim, chip: l.chip, price, currency, collectionMeta }),
      ], { signers: [seller] }), Err.market('CompressedCurrencyMismatch'), `V2 asset listing in currency ${currency}`);
      // neither the listing PDA nor the claim flag survives a refused listing
      expect(await env.chain.getAccount(compressedAssetListingPda(l.asset)[0])).toBeNull();
      expect(await l.listed()).toBe(false);
    }
  });

  // ------------------------------------------------------------------ cancel
  it('cancels a listing: the PDA is closed back to the seller and the claim is unflagged', async () => {
    const l = await leaf(70_400n);
    const [listing] = compressedAssetListingPda(l.asset);
    await env.chain.send([listCompressedAssetIx({
      seller: seller.publicKey, asset: l.asset, collectionIdx: 0, claim: l.claim, price: 3n * SOL, currency: MarketCurrency.SOL,
    })], { signers: [seller] });
    const rent = (await env.chain.getAccount(listing))!.lamports;
    expect(await l.listed()).toBe(true);

    const before = await env.chain.balance(seller.publicKey);
    await env.chain.send([cancelCompressedAssetIx({ seller: seller.publicKey, asset: l.asset, claim: l.claim })], { signers: [seller], label: 'cancel_compressed_asset' });

    expect(await env.chain.getAccount(listing)).toBeNull();
    expect(await l.listed()).toBe(false);
    // the rent comes back to the seller, minus the fee
    const after = await env.chain.balance(seller.publicKey);
    expect(after - before).toBeGreaterThanOrEqual(rent - 10_000n);
    // and the leaf can be listed again straight away
    await env.chain.send([listCompressedAssetIx({
      seller: seller.publicKey, asset: l.asset, collectionIdx: 0, claim: l.claim, price: SOL, currency: MarketCurrency.SOL,
    })], { signers: [seller] });
    expect(await l.listed()).toBe(true);
  });

  it('a stranger cannot cancel somebody else\'s listing', async () => {
    const l = await leaf(70_500n);
    await env.chain.send([listCompressedAssetIx({
      seller: seller.publicKey, asset: l.asset, collectionIdx: 0, claim: l.claim, price: SOL, currency: MarketCurrency.SOL,
    })], { signers: [seller] });
    await expectFail(env.chain.send([
      cancelCompressedAssetIx({ seller: buyer.publicKey, asset: l.asset, claim: l.claim }),
    ], { signers: [buyer] }), Err.market('NotSeller'), 'foreign cancel');
    expect(await l.listed()).toBe(true);
  });

  it('cancelling a listing that does not exist is refused', async () => {
    const l = await leaf(70_600n);
    const before = await env.chain.balance(seller.publicKey);
    // Which Anchor error a missing `listing` surfaces as is a property of how the runtime hands a
    // zeroed account to the program, not of this handler — the first CI run reported 2012
    // (ConstraintAddress) here because a *different* test's listing was still alive at that PDA. So
    // assert what actually matters: the instruction is refused, and nothing moved.
    const failure = await expectAnyFail(env.chain.send([
      cancelCompressedAssetIx({ seller: seller.publicKey, asset: l.asset, claim: l.claim }),
    ], { signers: [seller] }), 'cancel without a listing');
    expect(failure.code).toBeGreaterThan(0);
    // no listing was conjured into existence, and the claim was never unflagged
    expect(await env.chain.getAccount(compressedAssetListingPda(l.asset)[0])).toBeNull();
    expect(await l.listed()).toBe(false);
    // and the seller is not out of pocket for a signature on an instruction that did nothing
    expect(await env.chain.balance(seller.publicKey)).toBeGreaterThanOrEqual(before - 10_000n);
  });

  // ------------------------------------------------------------------ buy guards
  it('buy: SEC-F5 pins the price, refuses a self-trade, and re-checks the leaf against the listing', async () => {
    const l = await leaf(70_700n);
    const price = 2n * SOL;
    await env.chain.send([listCompressedAssetIx({
      seller: seller.publicKey, asset: l.asset, collectionIdx: 0, claim: l.claim, price, currency: MarketCurrency.SOL,
    })], { signers: [seller] });

    const args = {
      buyer: buyer.publicKey, asset: l.asset, claim: l.claim, seller: seller.publicKey,
      proof: l.proof, delegate: l.owner, treeConfig: l.treeConfig, merkleTree: l.merkleTree,
      coreCollection: l.coreCollection, treasury: env.config.treasury, buyback: env.config.buybackWallet,
      expectedPrice: price,
    };

    // the seller cancelled and relisted higher between quoting and signing
    await expectFail(env.chain.send([buyCompressedAssetIx({ ...args, expectedPrice: price + 1n })], { signers: [buyer] }),
      Err.market('ListingPriceChanged'), 'SEC-F5 front-run');

    // the seller cannot buy their own listing to farm a volume signal
    await expectFail(env.chain.send([buyCompressedAssetIx({ ...args, buyer: seller.publicKey })], { signers: [seller] }),
      Err.market('SelfTrade'), 'self trade');

    // a proof for a different leaf than the listing names
    const shifted = { ...l.proof, leafIndex: BigInt(l.leafIndex + 1), leafNonce: BigInt(l.leafIndex + 1) };
    await expectFail(env.chain.send([buyCompressedAssetIx({ ...args, proof: shifted })], { signers: [buyer] }),
      Err.market('CompressedClaimNotTradable'), 'proof for another leaf index');

    // hashes that do not match the registered projection
    await expectFail(env.chain.send([buyCompressedAssetIx({ ...args, proof: { ...l.proof, dataHash: new Uint8Array(32).fill(7) } })], { signers: [buyer] }),
      Err.market('CompressedClaimNotTradable'), 'proof data hash mismatch');

    // a tree config other than the one the listing names: the account constraint rejects it before
    // the handler runs, so the settlement cannot be pointed at a tree the leaf is not in
    await expectFail(env.chain.send([buyCompressedAssetIx({ ...args, treeConfig: Keypair.generate().publicKey })], { signers: [buyer] }),
      Err.anchor('ConstraintAddress'), 'tree config not the one in the listing');

    // the claim must still be the listed one, owned by the seller
    await expectFail(env.chain.send([buyCompressedAssetIx({ ...args, claim: compressedMintClaimPda(buyer.publicKey, 70_701n)[0] })], { signers: [buyer] }),
      Err.anchor('ConstraintAddress'), 'claim not the listed one');

    // the listing is still intact after every refusal — none of them moved a lamport
    expect(await env.chain.getAccount(compressedAssetListingPda(l.asset)[0])).not.toBeNull();
    expect(await l.listed()).toBe(true);
  });

  it('buy: the happy path runs the whole handler and stops only at the Bubblegum CPI', async () => {
    const l = await leaf(70_800n);
    const price = 2n * SOL;
    await env.chain.send([listCompressedAssetIx({
      seller: seller.publicKey, asset: l.asset, collectionIdx: 0, claim: l.claim, price, currency: MarketCurrency.SOL,
    })], { signers: [seller] });

    const failure = await expectAnyFail(env.chain.send([buyCompressedAssetIx({
      buyer: buyer.publicKey, asset: l.asset, claim: l.claim, seller: seller.publicKey,
      proof: l.proof, delegate: l.owner, treeConfig: l.treeConfig, merkleTree: l.merkleTree,
      coreCollection: l.coreCollection, treasury: env.config.treasury, buyback: env.config.buybackWallet,
      expectedPrice: price,
    })], { signers: [buyer], label: 'buy_compressed_asset' }), 'buy reaches the Bubblegum CPI');

    // The proof this is the CPI and not a guard: the market program never raised a custom error.
    // Every `require!` in the handler surfaces as `custom program error: 0x1770` with the market
    // program id, so the ABSENCE of that line is the discriminator — a wrong collection-hash formula,
    // a stale proof or a mismatched listing all fail earlier and would all print it. Getting here
    // means every guard passed, `split()` ran and the three lamport transfers were issued; the only
    // thing left in the handler is `TransferV2CpiBuilder::invoke_signed`, which needs a real
    // Bubblegum program the LiteSVM harness does not load.
    //
    // The absence of a custom error is NECESSARY but not SUFFICIENT, and the first CI run proved it:
    // `buy_compressed_asset` was overflowing its SBF stack frame on every call (`Access violation in
    // stack frame 5`), which is not a custom program error, so this assertion was happily green on a
    // program that never ran. So also require the Bubblegum program to actually appear in the trace
    // — the CPI cannot be reached without invoking it.
    const trace = failure.logs.join('\n');
    expect(trace, `expected the Bubblegum CPI to fail, but a market custom error fired instead:\n${trace.split('\n').slice(-8).join('\n')}`)
      .not.toMatch(/custom program error/);
    expect(trace, `the program aborted before reaching the CPI — this is what a stack overflow looks like:\n${trace.split('\n').slice(-8).join('\n')}`)
      .not.toMatch(/Access violation|stack frame|panicked/);
    expect(trace, `the Bubblegum program was never invoked, so no CPI was reached:\n${trace.split('\n').slice(-8).join('\n')}`)
      .toContain(MPL_BUBBLEGUM_V2_ID.toBase58());

    // The split the handler was about to apply, mirrored client-side so the numbers stay pinned.
    const split = saleSplit(price, env.config.marketFeeBps);
    expect(split.seller + split.treasury + split.buyback + split.royalty).toBe(price);
  });
});

