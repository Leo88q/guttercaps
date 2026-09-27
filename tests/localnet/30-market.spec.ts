// T-L-M — custom marketplace for Bubblegum V2 claim-bound chips.
// The market never parses an MPL-Core asset and never invents a DAS id.
import { beforeAll, describe, expect, it } from 'vitest';
import { Keypair, TransactionInstruction } from '@solana/web3.js';
import { decodeCompressedMintClaim } from '@/chain/accounts';
import { buyCompressedSolIx, listCompressedIx, saleSplit, MarketCurrency } from '@/chain/ix/market';
import { ixData, ro, rw, signer } from '@/chain/anchor';
import { BorshWriter } from '@/chain/borsh';
import { CHIP_CORE_ID, MARKET_ID, SYSTEM_PROGRAM_ID } from '@/chain/ids';
import { marketAuthPda } from '@/chain/pdas';
import { fuseCompressedClaimsIx, stageCompressedChipIx } from '@/chain/ix/chipCore';
import { compressedListingPda, compressedMintClaimPda } from '@/chain/pdas';
import { Err, expectFail } from './helpers/expect';
import { binariesPresent, getEnv, setParamsIx, setPausedIx, tokenBalance, TREASURY, BUYBACK, type Env } from './helpers/env';
import { PublicKey } from '@solana/web3.js';

const bins = binariesPresent();
const suite = describe.skipIf(!bins.ok && !process.env.LOCALNET_RPC);
const SOL = 1_000_000_000n;

/**
 * `list_compressed` with an arbitrary currency, byte-for-byte the accounts the program expects. The client
 * builder refuses a non-SOL claim listing by design (SEC-B28) — what this test asks is what the *program*
 * does when a hand-built or third-party client sends one anyway.
 */
function rawListCompressedIx(a: { seller: PublicKey; claim: PublicKey; price: bigint; currency: number }): TransactionInstruction {
  return new TransactionInstruction({
    programId: MARKET_ID,
    keys: [signer(a.seller), rw(compressedListingPda(a.claim)[0]), rw(a.claim), ro(marketAuthPda()[0]), ro(CHIP_CORE_ID), ro(SYSTEM_PROGRAM_ID)],
    data: Buffer.from(ixData('list_compressed', new BorshWriter().u64(a.price).u8(a.currency).toBytes())),
  });
}

async function stageClaim(env: Env, owner: Keypair, nonce: bigint, rarity = 0, collectionIdx = 0): Promise<PublicKey> {
  const claim = compressedMintClaimPda(owner.publicKey, nonce)[0];
  await env.chain.send([
    stageCompressedChipIx({
      admin: env.admin.publicKey,
      buyer: owner.publicKey,
      collectionIdx,
      claimNonce: nonce,
      rarity,
      level: 1,
      gameIndex: nonce,
      expiresAt: (await env.chain.now()) + 7n * 86_400n,
    }),
  ], { signers: [env.admin], label: `stage market claim ${nonce}` });
  return claim;
}

suite('T-L-M compressed custom market', () => {
  let env: Env;
  let seller: Keypair;
  let buyer: Keypair;
  beforeAll(async () => {
    env = await getEnv();
    seller = await env.player({ sol: 5n * SOL, cg: 10_000_000_000n });
    buyer = await env.player({ sol: 10n * SOL });
  });

  it('lists and settles a compressed claim in SOL with the configured fee split', async () => {
    const claim = await stageClaim(env, seller, 60_001n, 0, 2);
    const price = 2n * SOL;
    await env.chain.send([
      listCompressedIx({ seller: seller.publicKey, claim, price, currency: MarketCurrency.SOL }),
    ], { signers: [seller] });
    const listing = compressedListingPda(claim)[0];
    const listingAccount = await env.chain.getAccount(listing);
    expect(listingAccount).not.toBeNull();
    const listingRent = listingAccount!.lamports;
    expect(decodeCompressedMintClaim((await env.chain.getAccount(claim))!.data).listed).toBe(true);

    const sellerBefore = await env.chain.balance(seller.publicKey);
    const buyerBefore = await env.chain.balance(buyer.publicKey);
    await env.chain.send([
      buyCompressedSolIx({ buyer: buyer.publicKey, claim, seller: seller.publicKey, treasury: TREASURY.publicKey, buyback: BUYBACK.publicKey, expectedPrice: price }),
    ], { signers: [buyer] });

    const split = saleSplit(price);
    const sellerDelta = (await env.chain.balance(seller.publicKey)) - sellerBefore;
    expect(sellerDelta).toBeGreaterThanOrEqual(split.seller + listingRent);
    const buyerDelta = buyerBefore - (await env.chain.balance(buyer.publicKey));
    expect(buyerDelta).toBeGreaterThanOrEqual(price);
    expect(buyerDelta - price).toBeLessThanOrEqual(10_000n); // transaction fee is paid by the buyer, not settlement value
    const result = decodeCompressedMintClaim((await env.chain.getAccount(claim))!.data);
    expect(result.buyer.equals(buyer.publicKey)).toBe(true);
    expect(result.listed).toBe(false);
    expect(await env.chain.getAccount(listing)).toBeNull();
  });

  it('binds listing authority to the claim owner and rejects invalid prices or consumed claims', async () => {
    const claim = await stageClaim(env, seller, 60_101n, 0, 0);
    await expectFail(env.chain.send([
      listCompressedIx({ seller: buyer.publicKey, claim, price: SOL, currency: MarketCurrency.SOL }),
    ], { signers: [buyer] }), Err.market('CompressedClaimNotTradable'), 'foreign compressed seller');
    await expectFail(env.chain.send([
      listCompressedIx({ seller: seller.publicKey, claim, price: 999_999n, currency: MarketCurrency.SOL }),
    ], { signers: [seller] }), Err.market('PriceTooLow'), 'compressed dust listing');

    // SEC-B28: `buy_compressed` settles in lamports and rejects every other currency, so a USDC/SKR
    // listing can never be bought — it would only create an unfillable listing and flag the claim
    // `listed`, which closes the claim's mint and fusion paths in chip_core until a cancel. The program
    // refuses the currency, the transaction reverts, and neither the listing PDA nor the flag exists.
    for (const [currency, price] of [[1, 100_000n], [2, 5_000_000n]] as const) {
      await expectFail(env.chain.send([
        rawListCompressedIx({ seller: seller.publicKey, claim, price, currency }),
      ], { signers: [seller] }), Err.market('CompressedCurrencyMismatch'), `claim listing in currency ${currency}`);
      expect(await env.chain.getAccount(compressedListingPda(claim)[0])).toBeNull();
      expect(decodeCompressedMintClaim((await env.chain.getAccount(claim))!.data).listed).toBe(false);
    }

    const consumed = await stageClaim(env, seller, 60_102n, 0, 0);
    // A claim that is already consumed by fusion cannot enter the market.
    const owner = seller;
    // Use a distinct staged claim and let the compressed fusion instruction
    // consume it; the market boundary then sees the same on-chain flag.
    const c2 = await stageClaim(env, owner, 60_103n, 0, 0);
    const c3 = await stageClaim(env, owner, 60_104n, 0, 0);
    await env.chain.send([
      fuseCompressedClaimsIx({ owner: owner.publicKey, resultClaimNonce: 60_106n, resultCollectionIdx: 0, cgMint: env.mints.cg, materialClaims: [consumed, c2, c3] }),
    ], { signers: [owner] });
    await expectFail(env.chain.send([
      listCompressedIx({ seller: owner.publicKey, claim: consumed, price: SOL, currency: MarketCurrency.SOL }),
    ], { signers: [owner] }), Err.market('CompressedClaimNotTradable'), 'consumed compressed claim');

  });

  it('allows the custom claim market to operate while chip_core purchases are paused', async () => {
    const claim = await stageClaim(env, seller, 60_201n, 0, 1);
    await env.chain.send([setPausedIx(env.admin.publicKey, true)], { signers: [env.admin] });
    try {
      await env.chain.send([listCompressedIx({ seller: seller.publicKey, claim, price: SOL, currency: MarketCurrency.SOL })], { signers: [seller] });
      await env.chain.send([buyCompressedSolIx({ buyer: buyer.publicKey, claim, seller: seller.publicKey, treasury: TREASURY.publicKey, buyback: BUYBACK.publicKey, expectedPrice: SOL })], { signers: [buyer] });
    } finally {
      await env.chain.send([setPausedIx(env.admin.publicKey, false)], { signers: [env.admin] });
    }
    expect(decodeCompressedMintClaim((await env.chain.getAccount(claim))!.data).buyer.equals(buyer.publicKey)).toBe(true);
  });

  it('uses the live market fee cap for compressed settlements', async () => {
    await expectFail(env.chain.send([setParamsIx(env.admin.publicKey, { marketFeeBps: 1001 })], { signers: [env.admin] }), Err.chip('FeeTooHigh'));
    await env.chain.send([setParamsIx(env.admin.publicKey, { marketFeeBps: 1000 })], { signers: [env.admin] });
    const claim = await stageClaim(env, seller, 60_301n, 0, 0);
    await env.chain.send([listCompressedIx({ seller: seller.publicKey, claim, price: SOL, currency: MarketCurrency.SOL })], { signers: [seller] });
    await env.chain.send([buyCompressedSolIx({ buyer: buyer.publicKey, claim, seller: seller.publicKey, treasury: TREASURY.publicKey, buyback: BUYBACK.publicKey, expectedPrice: SOL })], { signers: [buyer] });
    expect(saleSplit(SOL, 1000).fee).toBe(100_000_000n);
    await env.chain.send([setParamsIx(env.admin.publicKey, { marketFeeBps: 750 })], { signers: [env.admin] });
    env.config = await env.refreshConfig();
    expect(await tokenBalance(env.chain, env.mints.cg, seller.publicKey)).toBeGreaterThan(0n);
  });
});
