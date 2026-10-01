// T-L-MC — the Core-NFT half of the market.
//
// Why this file exists: the 2026-10-01 audit found `list` / `buy` / `cancel` / `make_offer` had
// builders, were wired into the UI, and had NO LiteSVM coverage at all — 30-market.spec.ts only
// ever touched the compressed-claim paths. Adding a `list` happy path turns out to be impossible
// on a live deployment, and that is worth pinning with a test of its own (M6):
//
//   `open_pack` — the only instruction that ever minted a Core asset — is fail-closed. It
//   requires `config.paramsVersion == 0`, and `initialize` writes 1 while `set_params` only
//   increments (admin.rs:80 / admin.rs:517). So on any config this suite can build, no Core NFT
//   can come into existence, and `list` / `buy` / `cancel` can only be reached through a
//   hand-forged asset account. M6 pins the one-way gate that makes that true.
//
// What IS fully reachable, and is covered here: `make_offer` and `cancel_offer`. The Offer PDA is
// seeded by ["offer", asset, bidder] and the asset account is only checked for
// `owner = mpl_core::ID` — never parsed — so an offer can be made and cancelled against any
// account owned by the Core program, with a real USDC escrow, a real refund and real rent
// reclamation. M1–M4 cover exactly that, plus the guards that stop a bad offer from escrowing.
// M5 covers the one `list` guard that is reachable without an asset: the owner constraint.
import { beforeAll, describe, expect, it } from 'vitest';
import { TransactionInstruction } from '@solana/web3.js';
import { Keypair, PublicKey } from '@solana/web3.js';
import { makeOfferIx, cancelOfferIx, listIx, MIN_PRICE_USDC } from '@/chain/ix/market';
import { MARKET_ID, MPL_CORE_ID, TOKEN_PROGRAM_ID } from '@/chain/ids';
import { ixData, ro, rw, signer as signerMeta } from '@/chain/anchor';
import { ata, configPda, listingPda, marketAuthPda, offerPda } from '@/chain/pdas';
import { decodeGameConfig, decodeOffer } from '@/chain/accounts';
import { Err, expectFail } from './helpers/expect';
import { binariesPresent, getEnv, setParamsIx, tokenBalance, type Env } from './helpers/env';

const bins = binariesPresent();
const suite = describe.skipIf(!bins.ok && !process.env.LOCALNET_RPC);
const USDC = 1_000_000n; // 1 USDC, 6 decimals
const SOL = 1_000_000_000n;

// Amount held by an SPL token account. `tokenBalance` derives an ATA from an OWNER, so it cannot be
// used on an ATA itself: the offer escrow IS an ATA, and reading it through `tokenBalance` silently
// derives `ATA(mint, escrow)` and answers 0. Found by the first real CI run of this file (M1).
const held = async (chain: Env['chain'], tokenAccount: PublicKey): Promise<bigint> => {
  const a = await chain.getAccount(tokenAccount);
  if (!a) return 0n;
  return new DataView(a.data.buffer, a.data.byteOffset + 64, 8).getBigUint64(0, true);
};

// `cancel_offer` against a real Offer PDA, signed by somebody else. `cancelOfferIx` derives the PDA
// from the bidder it is given, so it cannot express this case; the program still has to refuse it.
function rawCancelOfferIx(signer: PublicKey, offer: PublicKey, usdcMint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MARKET_ID,
    keys: [signerMeta(signer), rw(offer), rw(ata(usdcMint, offer)), rw(ata(usdcMint, signer)), ro(TOKEN_PROGRAM_ID)],
    data: Buffer.from(ixData('cancel_offer')),
  });
}

suite('T-L-MC Core-NFT market', () => {
  let env: Env;
  /** Any key works: `make_offer` never parses the asset, it only requires owner = mpl_core::ID. */
  let asset: PublicKey;

  beforeAll(async () => {
    env = await getEnv();
    asset = Keypair.generate().publicKey;
    // An account owned by the Core program. This is NOT a real asset — see the header: no Core NFT
    // can be minted on a live config, so the offer path is the only Core-market path a test can
    // drive honestly, and it needs nothing beyond the owner byte.
    await env.chain.setAccount(asset, { owner: MPL_CORE_ID, data: new Uint8Array(0), lamports: 1_000_000n });
  });

  it('M1 make_offer: USDC moves into the offer PDA escrow and the Offer binds asset + bidder + ttl', async () => {
    const bidder = await env.player({ sol: 2n * SOL, usdc: 1_000_000_000n });
    const before = await tokenBalance(env.chain, env.mints.usdc, bidder.publicKey);

    await env.chain.send([makeOfferIx({
      bidder: bidder.publicKey, asset, amountUsdc: USDC, ttlSecs: 3600n, usdcMint: env.mints.usdc,
    })], { signers: [bidder], label: 'make_offer' });

    const [offer] = offerPda(asset, bidder.publicKey);
    const escrow = ata(env.mints.usdc, offer);
    expect(await held(env.chain, escrow)).toBe(USDC);
    expect(await tokenBalance(env.chain, env.mints.usdc, bidder.publicKey)).toBe(before - USDC);

    const o = decodeOffer(new Uint8Array((await env.chain.getAccount(offer))!.data));
    expect(o.asset.equals(asset)).toBe(true);
    expect(o.bidder.equals(bidder.publicKey)).toBe(true);
    expect(o.amountUsdc).toBe(USDC);
    expect(o.expiresAt > 0n).toBe(true);
    // the escrow is owned by the offer PDA, so only the program can ever move it back
    const escrowInfo = (await env.chain.getAccount(escrow))!;
    expect(new PublicKey(escrowInfo.data.subarray(32, 64)).equals(offer)).toBe(true);
  });

  it('M2 cancel_offer: the whole escrow returns to the bidder and both accounts are reclaimed', async () => {
    const bidder = await env.player({ sol: 2n * SOL, usdc: 1_000_000_000n });
    const start = await tokenBalance(env.chain, env.mints.usdc, bidder.publicKey);
    await env.chain.send([makeOfferIx({
      bidder: bidder.publicKey, asset, amountUsdc: USDC, ttlSecs: 3600n, usdcMint: env.mints.usdc,
    })], { signers: [bidder], label: 'make_offer M2' });
    const [offer] = offerPda(asset, bidder.publicKey);
    const escrow = ata(env.mints.usdc, offer);
    const rentBefore = (await env.chain.getAccount(bidder.publicKey))!.lamports;

    await env.chain.send([cancelOfferIx({ bidder: bidder.publicKey, asset, usdcMint: env.mints.usdc })],
      { signers: [bidder], label: 'cancel_offer' });

    // no dust: the whole amount comes back, and the closed escrow + offer hand their rent back too
    expect(await tokenBalance(env.chain, env.mints.usdc, bidder.publicKey)).toBe(start);
    expect(await env.chain.getAccount(escrow)).toBeNull();
    expect(await env.chain.getAccount(offer)).toBeNull();
    expect((await env.chain.getAccount(bidder.publicKey))!.lamports > rentBefore).toBe(true);
  });

  it('M3 make_offer guards: below the USDC floor and past the ttl cap, both refuse before escrowing', async () => {
    const bidder = await env.player({ sol: 2n * SOL, usdc: 1_000_000_000n });
    const start = await tokenBalance(env.chain, env.mints.usdc, bidder.publicKey);

    await expectFail(env.chain.send([makeOfferIx({
      bidder: bidder.publicKey, asset, amountUsdc: MIN_PRICE_USDC - 1n, ttlSecs: 60n, usdcMint: env.mints.usdc,
    })], { signers: [bidder], label: 'offer below floor' }), Err.market('PriceTooLow'), 'offer below floor');

    await expectFail(env.chain.send([makeOfferIx({
      bidder: bidder.publicKey, asset, amountUsdc: USDC, ttlSecs: 8_000_000n, usdcMint: env.mints.usdc,
    })], { signers: [bidder], label: 'offer ttl too long' }), Err.market('TtlTooLong'), 'offer ttl too long');

    // neither attempt escrowed anything, and no Offer account was left behind
    expect(await tokenBalance(env.chain, env.mints.usdc, bidder.publicKey)).toBe(start);
    expect(await env.chain.getAccount(offerPda(asset, bidder.publicKey)[0])).toBeNull();
  });

  it('M4 cancel_offer by anyone but the bidder is refused and the escrow stays put', async () => {
    const bidder = await env.player({ sol: 2n * SOL, usdc: 1_000_000_000n });
    const stranger = await env.player({ sol: 2n * SOL, usdc: 1_000_000n });
    await env.chain.send([makeOfferIx({
      bidder: bidder.publicKey, asset, amountUsdc: USDC, ttlSecs: 3600n, usdcMint: env.mints.usdc,
    })], { signers: [bidder], label: 'make_offer M4' });
    const [offer] = offerPda(asset, bidder.publicKey);
    const escrow = ata(env.mints.usdc, offer);

    // the real Offer PDA with a stranger's signature: the offer seeds and `has_one = bidder` both
    // have to hold, and neither does
    await expectFail(env.chain.send([rawCancelOfferIx(stranger.publicKey, offer, env.mints.usdc)],
      { signers: [stranger], label: 'cancel_offer by stranger' }), Err.anchor('ConstraintSeeds'), 'cancel_offer by stranger');

    expect(await held(env.chain, escrow)).toBe(USDC);
  });

  it('M5 list: an asset with no ChipState is refused before any fee is burned', async () => {
    const seller = await env.player({ sol: 2n * SOL, cg: 10_000_000_000n });
    const start = await tokenBalance(env.chain, env.mints.cg, seller.publicKey);
    // A keypair standing in for "an asset the caller owns". The account that actually blocks the
    // instruction is `chip` — the ["chip", asset] ChipState PDA — and it fails deserialising before
    // anything else runs. That is the §5.4 point in one line: a ChipState can only be created by
    // `open_pack`, and `open_pack` is fail-closed, so there is no input that gets past here.
    const notAnAsset = Keypair.generate().publicKey;

    await expectFail(env.chain.send([listIx({
      asset: notAnAsset, collectionIdx: 0, coreCollection: env.coreCollections.get(0)!,
      seller: seller.publicKey, price: 1_000_000_000n, currency: 0, cgMint: env.mints.cg,
    })], { signers: [seller], label: 'list an asset with no ChipState' }), Err.anchor('AccountNotInitialized'), 'list an asset with no ChipState');

    // refused before the 0.5 $CG listing fee is burned, and nothing is left behind either
    expect(await tokenBalance(env.chain, env.mints.cg, seller.publicKey)).toBe(start);
    expect(await env.chain.getAccount(listingPda(notAnAsset)[0])).toBeNull();
    // market_auth is a seed-only PDA — it is never created, so a refused list leaves nothing at all
    expect(await env.chain.getAccount(marketAuthPda()[0])).toBeNull();
  });

  it('M6 the migration gate is one-way: set_params only ever raises params_version', async () => {
    // This is why M1–M4 are offers and not listings. `open_pack` used to mint Core assets and is the
    // only instruction that ever could; it now requires `params_version == 0`, which `initialize`
    // (writes 1) and `set_params` (checked increment) make unreachable. If the version can ever go
    // backwards, the Core-NFT market above becomes live again — and so does everything the
    // compressed migration was meant to retire. So: read it, bump it twice, assert it only rose.
    const cfg0 = decodeGameConfig(new Uint8Array((await env.chain.getAccount(configPda()[0]))!.data));
    expect(cfg0.paramsVersion).toBeGreaterThanOrEqual(1);

    await env.chain.send([setParamsIx(env.admin.publicKey, {})], { signers: [env.admin], label: 'set_params (bump)' });
    const cfg1 = decodeGameConfig(new Uint8Array((await env.chain.getAccount(configPda()[0]))!.data));
    expect(cfg1.paramsVersion).toBe(cfg0.paramsVersion + 1);

    await env.chain.send([setParamsIx(env.admin.publicKey, {})], { signers: [env.admin], label: 'set_params (bump 2)' });
    const cfg2 = decodeGameConfig(new Uint8Array((await env.chain.getAccount(configPda()[0]))!.data));
    expect(cfg2.paramsVersion).toBe(cfg1.paramsVersion + 1);
  });
});
