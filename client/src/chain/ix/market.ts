// Instruction builders for programs/market (freeze-in-place listings in SOL/USDC/SKR + USDC offers).
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { BorshWriter } from '../borsh';
import { ixData, optional, ro, rw, signer } from '../anchor';
import { ASSOCIATED_TOKEN_PROGRAM_ID, CHIP_CORE_ID, MARKET_ID, MPL_ACCOUNT_COMPRESSION_ID, MPL_BUBBLEGUM_V2_ID, MPL_CORE_ID, MPL_NOOP_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../ids';
import { assertFreshProof, bubblegumProofMetas, type BubblegumProof } from '../bubblegum';
import { ata, bubblegumTreeConfigPda, chipStatePda, collectionMetaPda, compressedAssetListingPda, compressedChipStatePda, compressedListingPda, configPda, listingPda, marketAuthPda, offerPda } from '../pdas';

// SKR is 2, not 3: market::Currency is a three-variant enum, and borsh puts the variant INDEX on the
// wire (see the comment on the Rust side); 3 was chip_core's four-variant code.
export const MarketCurrency = { SOL: 0, USDC: 1, SKR: 2 } as const;
export type MarketCurrencyCode = (typeof MarketCurrency)[keyof typeof MarketCurrency];

/**
 * SEC-F11: translate the shared API currency code (packages/economy `CURRENCIES`: SOL 0 / USDC 1 /
 * $CG 2 / SKR 3) into the market wire enum above. Passing the API code straight into `listIx` sends
 * borsh variant index 3 to a three-variant enum and fails every SKR listing — this boundary is where
 * the translation must live. `$CG` (2) is not listable at all and throws.
 */
export function marketCurrencyOfApi(apiCode: number): MarketCurrencyCode {
  switch (apiCode) {
    case 0: return MarketCurrency.SOL;
    case 1: return MarketCurrency.USDC;
    case 3: return MarketCurrency.SKR;
    default: throw new Error(`currency code ${apiCode} is not listable on the market`);
  }
}
export const LISTING_FEE_CG = 500_000n; // 0.5 $CG burned on list
/** Default protocol fee; the live value is GameConfig.marketFeeBps (≤ 10 %). */
export const MARKET_FEE_BPS = 750;
export const FEE_BUYBACK_SHARE_BPS = 3_333;
export const ROYALTY_BPS = 250;
export const MIN_PRICE_LAMPORTS = 1_000_000n;
export const MIN_PRICE_USDC = 100_000n;
export const MIN_PRICE_SKR = 5_000_000n;
export const minPriceFor = (c: MarketCurrencyCode) => (c === MarketCurrency.SOL ? MIN_PRICE_LAMPORTS : c === MarketCurrency.USDC ? MIN_PRICE_USDC : MIN_PRICE_SKR);
export const marketMintFor = (c: MarketCurrencyCode, cfg: { usdcMint: PublicKey; skrMint?: PublicKey }) => (c === MarketCurrency.USDC ? cfg.usdcMint : c === MarketCurrency.SKR ? cfg.skrMint : undefined);

/**
 * SEC-B28: the *claim* market (both the pre-mint claim listing and the V2 asset listing) settles by
 * lamport transfers — `buy_compressed` / `buy_compressed_asset` have no SPL legs — so a listing in USDC or
 * SKR can never be bought. The program now refuses it at list time, and this refuses it before the wallet
 * pays a fee. Refusing only in the program was not enough: the transaction reverts, but the user learns
 * why only after paying, and any UI that offered the currencies the docs listed would build it anyway.
 */
const CLAIM_MARKET_SOL_ONLY = 'the claim market settles in SOL only — list the claim in SOL';
export function assertSolClaimListing(currency: MarketCurrencyCode): void {
  if (currency !== MarketCurrency.SOL) throw new Error(CLAIM_MARKET_SOL_ONLY);
}

interface ChipRef { asset: PublicKey; collectionIdx: number; coreCollection: PublicKey }

export function listIx(a: ChipRef & { seller: PublicKey; price: bigint; currency: MarketCurrencyCode; cgMint: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: MARKET_ID,
    keys: [
      signer(a.seller),
      rw(listingPda(a.asset)[0]),
      ro(marketAuthPda()[0]),
      rw(a.asset),
      rw(chipStatePda(a.asset)[0]),
      ro(collectionMetaPda(a.collectionIdx)[0]),
      rw(a.coreCollection),
      ro(configPda()[0]),
      rw(a.cgMint),
      rw(ata(a.cgMint, a.seller)),
      ro(CHIP_CORE_ID),
      ro(MPL_CORE_ID),
      ro(TOKEN_PROGRAM_ID),
      ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('list', new BorshWriter().u64(a.price).u8(a.currency).toBytes())),
  });
}

export function updatePriceIx(a: { seller: PublicKey; asset: PublicKey; price: bigint }): TransactionInstruction {
  return new TransactionInstruction({
    programId: MARKET_ID,
    keys: [signer(a.seller, false), rw(listingPda(a.asset)[0])],
    data: Buffer.from(ixData('update_price', new BorshWriter().u64(a.price).toBytes())),
  });
}

export function cancelListingIx(a: ChipRef & { seller: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: MARKET_ID,
    keys: [
      signer(a.seller),
      rw(listingPda(a.asset)[0]),
      ro(marketAuthPda()[0]),
      rw(a.asset),
      rw(chipStatePda(a.asset)[0]),
      ro(collectionMetaPda(a.collectionIdx)[0]),
      rw(a.coreCollection),
      ro(configPda()[0]),
      ro(CHIP_CORE_ID),
      ro(MPL_CORE_ID),
      ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('cancel')),
  });
}

export interface BuyArgs extends ChipRef {
  buyer: PublicKey;
  seller: PublicKey;
  expectedPrice: bigint;
  expectedCurrency: MarketCurrencyCode;
  treasury: PublicKey;
  buybackWallet: PublicKey;
  usdcMint: PublicKey;
  skrMint?: PublicKey;
}

export function buyIx(a: BuyArgs): TransactionInstruction {
  const mint = marketMintFor(a.expectedCurrency, a);
  if (a.expectedCurrency !== MarketCurrency.SOL && !mint) throw new Error('mint for this currency is not configured');
  return new TransactionInstruction({
    programId: MARKET_ID,
    keys: [
      signer(a.buyer),
      rw(a.seller),
      rw(listingPda(a.asset)[0]),
      ro(marketAuthPda()[0]),
      rw(a.asset),
      rw(chipStatePda(a.asset)[0]),
      ro(collectionMetaPda(a.collectionIdx)[0]),
      rw(a.coreCollection),
      ro(configPda()[0]),
      rw(a.treasury),
      rw(a.buybackWallet),
      optional(mint ? ata(mint, a.buyer) : undefined, MARKET_ID),
      optional(mint ? ata(mint, a.seller) : undefined, MARKET_ID),
      optional(mint ? ata(mint, a.treasury) : undefined, MARKET_ID),
      optional(mint ? ata(mint, a.buybackWallet) : undefined, MARKET_ID),
      ro(CHIP_CORE_ID),
      ro(MPL_CORE_ID),
      ro(TOKEN_PROGRAM_ID),
      ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('buy', new BorshWriter().u64(a.expectedPrice).u8(a.expectedCurrency).toBytes())),
  });
}

export function makeOfferIx(a: { bidder: PublicKey; asset: PublicKey; amountUsdc: bigint; ttlSecs: bigint; usdcMint: PublicKey }): TransactionInstruction {
  const [offer] = offerPda(a.asset, a.bidder);
  return new TransactionInstruction({
    programId: MARKET_ID,
    keys: [
      signer(a.bidder),
      ro(a.asset),
      rw(offer),
      ro(configPda()[0]),
      ro(a.usdcMint),
      rw(ata(a.usdcMint, a.bidder)),
      rw(ata(a.usdcMint, offer)),
      ro(TOKEN_PROGRAM_ID),
      ro(ASSOCIATED_TOKEN_PROGRAM_ID),
      ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('make_offer', new BorshWriter().u64(a.amountUsdc).i64(a.ttlSecs).toBytes())),
  });
}

export function cancelOfferIx(a: { bidder: PublicKey; asset: PublicKey; usdcMint: PublicKey }): TransactionInstruction {
  const [offer] = offerPda(a.asset, a.bidder);
  return new TransactionInstruction({
    programId: MARKET_ID,
    keys: [signer(a.bidder), rw(offer), rw(ata(a.usdcMint, offer)), rw(ata(a.usdcMint, a.bidder)), ro(TOKEN_PROGRAM_ID)],
    data: Buffer.from(ixData('cancel_offer')),
  });
}

export function acceptOfferIx(a: ChipRef & { seller: PublicKey; bidder: PublicKey; treasury: PublicKey; buybackWallet: PublicKey; usdcMint: PublicKey }): TransactionInstruction {
  const [offer] = offerPda(a.asset, a.bidder);
  return new TransactionInstruction({
    programId: MARKET_ID,
    keys: [
      signer(a.seller),
      rw(a.bidder),
      rw(offer),
      rw(ata(a.usdcMint, offer)),
      ro(marketAuthPda()[0]),
      rw(a.asset),
      rw(chipStatePda(a.asset)[0]),
      ro(collectionMetaPda(a.collectionIdx)[0]),
      rw(a.coreCollection),
      ro(configPda()[0]),
      ro(a.treasury),
      ro(a.buybackWallet),
      rw(ata(a.usdcMint, a.seller)),
      rw(ata(a.usdcMint, a.treasury)),
      rw(ata(a.usdcMint, a.buybackWallet)),
      ro(CHIP_CORE_ID),
      ro(MPL_CORE_ID),
      ro(TOKEN_PROGRAM_ID),
      ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('accept_offer')),
  });
}

/** Sale split shown before signing (matches market::split). */
/** Same integer math as market::split. `feeBps` = GameConfig.marketFeeBps (live), default 7.5 %. */
export function saleSplit(price: bigint, feeBps: number = MARKET_FEE_BPS) {
  const fee = (price * BigInt(Math.min(feeBps, 1_000))) / 10_000n;
  const royalty = (price * BigInt(ROYALTY_BPS)) / 10_000n;
  const buyback = (fee * BigInt(FEE_BUYBACK_SHARE_BPS)) / 10_000n;
  const treasury = fee - buyback;
  return { fee, royalty, buyback, treasury, seller: price - fee - royalty, feeBps };
}

export function listCompressedIx(a: { seller: PublicKey; claim: PublicKey; price: bigint; currency: MarketCurrencyCode }): TransactionInstruction {
  assertSolClaimListing(a.currency);
  const [listing] = compressedListingPda(a.claim);
  const data = new BorshWriter().u64(a.price).u8(a.currency).toBytes();
  return new TransactionInstruction({
    programId: MARKET_ID,
    keys: [signer(a.seller), rw(listing), rw(a.claim), ro(marketAuthPda()[0]), ro(CHIP_CORE_ID), ro(SYSTEM_PROGRAM_ID)],
    data: Buffer.from(ixData('list_compressed', data)),
  });
}

/** Cancel a custom compressed listing and clear the chip_core-owned claim flag. */
export function cancelCompressedIx(a: { seller: PublicKey; claim: PublicKey }): TransactionInstruction {
  const [listing] = compressedListingPda(a.claim);
  return new TransactionInstruction({
    programId: MARKET_ID,
    keys: [signer(a.seller), rw(listing), rw(a.claim), ro(marketAuthPda()[0]), ro(CHIP_CORE_ID), ro(SYSTEM_PROGRAM_ID)],
    data: Buffer.from(ixData('cancel_compressed')),
  });
}

/** Custom marketplace settlement for a claim-bound compressed chip. */
/** `expectedPrice` = the listing price the buyer was shown (lamports); a relisted / repriced claim fails with ListingPriceChanged (SEC-F5). */
export function buyCompressedSolIx(a: { buyer: PublicKey; claim: PublicKey; seller: PublicKey; treasury: PublicKey; buyback: PublicKey; expectedPrice: bigint }): TransactionInstruction {
  const [listing] = compressedListingPda(a.claim);
  return new TransactionInstruction({
    programId: MARKET_ID,
    keys: [
      signer(a.buyer), rw(listing), rw(a.claim), rw(a.seller), rw(a.treasury), rw(a.buyback),
      ro(configPda()[0]), ro(marketAuthPda()[0]), ro(CHIP_CORE_ID), ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('buy_compressed', new BorshWriter().u64(a.expectedPrice).toBytes())),
  });
}

/** Create a custom listing for the actual registered Bubblegum V2 leaf. */
export function listCompressedAssetIx(a: { seller: PublicKey; asset: PublicKey; collectionIdx: number; claim: PublicKey; price: bigint; currency: MarketCurrencyCode }): TransactionInstruction {
  assertSolClaimListing(a.currency);
  const [listing] = compressedAssetListingPda(a.asset);
  return new TransactionInstruction({
    programId: MARKET_ID,
    keys: [
      signer(a.seller), rw(listing), rw(a.asset), rw(compressedChipStatePda(a.asset)[0]),
      ro(collectionMetaPda(a.collectionIdx)[0]), rw(a.claim), ro(marketAuthPda()[0]), ro(CHIP_CORE_ID), ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('list_compressed_asset', new BorshWriter().u64(a.price).u8(a.currency).toBytes())),
  });
}

export function cancelCompressedAssetIx(a: { seller: PublicKey; asset: PublicKey; claim: PublicKey }): TransactionInstruction {
  const [listing] = compressedAssetListingPda(a.asset);
  return new TransactionInstruction({
    programId: MARKET_ID,
    keys: [signer(a.seller), rw(listing), rw(a.claim), ro(marketAuthPda()[0]), ro(CHIP_CORE_ID), ro(SYSTEM_PROGRAM_ID)],
    data: Buffer.from(ixData('cancel_compressed_asset')),
  });
}

/** Buy and atomically Bubblegum-transfer a registered V2 leaf. The DAS proof is
 * serialized into the market instruction and its nodes are passed in order. */
export function buyCompressedAssetIx(a: { buyer: PublicKey; asset: PublicKey; claim: PublicKey; seller: PublicKey; proof: BubblegumProof; delegate: PublicKey; treeConfig: PublicKey; merkleTree: PublicKey; coreCollection: PublicKey; treasury: PublicKey; buyback: PublicKey; expectedPrice: bigint }): TransactionInstruction {
  assertFreshProof(a.proof);
  if (!a.proof.assetId.equals(a.asset) || !a.proof.leafOwner.equals(a.seller) || !a.proof.leafDelegate.equals(a.delegate)) throw new Error('Bubblegum proof does not match compressed listing');
  if (a.proof.leafIndex > 0xffff_ffffn) throw new Error('Bubblegum leaf index exceeds u32');
  if (!a.proof.merkleTree.equals(a.merkleTree)) throw new Error('Bubblegum proof tree does not match listing');
  if (!bubblegumTreeConfigPda(a.merkleTree)[0].equals(a.treeConfig)) throw new Error('Bubblegum tree config does not match merkle tree');
  const [listing] = compressedAssetListingPda(a.asset);
  const data = new BorshWriter()
    .pubkey(a.delegate)
    .bytes(a.proof.root)
    .bytes(a.proof.dataHash)
    .bytes(a.proof.creatorHash)
    .bytes(a.proof.collectionHash)
    .bytes(a.proof.assetDataHash)
    .u8(a.proof.flags)
    .u64(a.proof.leafNonce)
    .u32(Number(a.proof.leafIndex))
    .u64(a.expectedPrice) // SEC-F5 front-running guard
    .toBytes();
  return new TransactionInstruction({
    programId: MARKET_ID,
    keys: [
      signer(a.buyer), rw(listing), rw(a.claim), rw(compressedChipStatePda(a.asset)[0]), ro(configPda()[0]),
      rw(a.treasury), rw(a.buyback), rw(a.seller), ro(a.seller), ro(a.delegate),
      rw(a.treeConfig), rw(a.merkleTree), ro(a.coreCollection), ro(marketAuthPda()[0]),
      ro(MPL_BUBBLEGUM_V2_ID), ro(MPL_NOOP_ID), ro(MPL_ACCOUNT_COMPRESSION_ID), ro(CHIP_CORE_ID), ro(SYSTEM_PROGRAM_ID),
      ...bubblegumProofMetas(a.proof),
    ],
    data: Buffer.from(ixData('buy_compressed_asset', data)),
  });
}
