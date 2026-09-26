// T-L-C — packs: buy / reveal / open / refund / randomness PDA (docs/06 §3.5 "Паки").
import { beforeAll, describe, expect, it } from 'vitest';
import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { PACKS, expandRandomness } from '@guttercaps/economy';
import { decodeCollectionMeta, decodeCompressedMintClaim, decodeCompressedPackSettlement, readCompressedClaimsCreated } from '@/chain/accounts';
import { buyPackIx, openCompressedPackIx } from '@/chain/ix/chipCore';
import { findEvent } from '@/chain/anchor';
import { closeRandomnessIx, closeRandomnessLutIx, initRandomnessIx, rngAccounts } from '@/chain/ix/rng';
import { LEDGER_SHARDS, RNG_KIND, compressedMintClaimPda, compressedSettlementPda, collectionMetaPda, ledgerShardOf, pendingPackPda, rngAuthPda } from '@/chain/pdas';
import { packSeed, toEconPack } from '@/chain/flows/packFlow';
import { PYTH_RECEIVER_ID } from '@/chain/ids';
import { sbLutPda, sbLutSignerPda } from '@/chain/pdas';
import { SB_MOCK_ID, SB_ORACLE, SB_QUEUE, TREASURY, binariesPresent, encodePacks, getEnv, setParamsIx, setPausedIx, tokenBalance, type Env } from './helpers/env';
import { Err, expectAnyFail, expectFail, lamportsClose } from './helpers/expect';
import { Currency, SKU, ataOf, buyPack, cancelStale, loadPending, loadPity, openCompressedPack, openCompressedPackInstruction, quoteUnits, revealAndOpenCompressedAll, revealPack, valueOf, vaultKey } from './helpers/flows';
import { forgePriceAccount, refreshPyth } from './helpers/pyth';
import { encodeRandomnessPayload, forgeRandomness, mockInitIx, randomnessAccount, revealIx, setRawIx } from './helpers/sbmock';

const bins = binariesPresent();
const suite = describe.skipIf(!bins.ok && !process.env.LOCALNET_RPC);
/** scenarios that forge accounts or move the clock — LiteSVM back-end only (RPC = LOCALNET_RPC set) */
const svmOnly = it.skipIf(!!process.env.LOCALNET_RPC);
const STALE = 10_800n;
const RENT_RESERVE_PER_CHIP = 8_000_000n; // SEC-L3
const DAY = 86_400n;

suite('T-L-C packs', () => {
  let env: Env;
  const warp = () => env.chain.canWarp;
  beforeAll(async () => { env = await getEnv(); });

  it('C01 Starter: 1 per wallet, 3 Bubblegum V2 claims expire after 7 d; registration values are bound before mint', async () => {
    const buyer = await env.player();
    const b = await buyPack(env, buyer, { sku: SKU.STARTER, currency: Currency.SOL });
    expect((await loadPity(env.chain, buyer.publicKey))!.starterClaimed).toBe(true);
    await expectFail(buyPack(env, buyer, { sku: SKU.STARTER, currency: Currency.SOL }), Err.chip('StarterAlreadyClaimed'), 'second starter');
    await expectFail(buyPack(env, buyer, { sku: SKU.STARTER, qty: 2, currency: Currency.USDC }), Err.chip('StarterAlreadyClaimed'), 'starter qty 2');
    const [open] = await revealAndOpenCompressedAll(env, buyer, b, valueOf('C01'));
    expect(open.event.count).toBe(3);
    const settlementKey = compressedSettlementPda(buyer.publicKey, b.nonce)[0];
    const now = await env.chain.now();
    for (let i = 0; i < open.event.count; i++) {
      const claimKey = compressedMintClaimPda(buyer.publicKey, open.event.claimNonces[i])[0];
      const claim = decodeCompressedMintClaim((await env.chain.getAccount(claimKey))!.data);
      expect(claim.buyer.equals(buyer.publicKey)).toBe(true);
      expect(claim.settlement.equals(settlementKey)).toBe(true);
      expect(claim.collectionIdx).toBe(open.rolled[i].collectionIdx);
      expect(claim.rarity).toBe(open.rolled[i].rarity);
      expect(claim.level).toBe(1);
      expect(claim.expiresAt).toBeGreaterThanOrEqual(now + 7n * DAY - 60n);
      expect(claim.indexReserved).toBe(true);
      expect(claim.minted).toBe(false);
    }
  });

  it('C02 Standard in SOL through Pyth: lamports = units_for_cents(price − conf) ± 1; max_lamports below quote → Slippage; stale price → StalePrice; conf > 2 % → PriceUncertain (SEC-M2); foreign owner → rejected', async () => {
    const buyer = await env.player();
    const vault = vaultKey();
    const vaultBefore = await env.chain.balance(vault);
    const b = await buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.SOL });
    const expected = quoteUnits(env, SKU.STANDARD, 1, Currency.SOL);
    // $4.99 at $150.00 with the fixture's 0.1 % conf → charged at $149.85 (price − conf): 0.033299966 SOL
    expect(expected).toBe((499n * 1_000_000_000n * 100_000_000n) / 100n / (15_000_000_000n - 15_000_000n));
    expect(expected).toBeGreaterThan((499n * 1_000_000_000n * 100_000_000n) / 100n / 15_000_000_000n); // the buyer never gets the optimistic edge
    expect(lamportsClose(await env.chain.balance(vault), vaultBefore + expected, 1n)).toBe(true);
    const pending = (await loadPending(env.chain, b.pending))!;
    expect(pending.paidLamports).toBe(expected);
    expect(await env.chain.balance(b.pending)).toBeGreaterThanOrEqual(3n * RENT_RESERVE_PER_CHIP);
    await expectFail(buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.SOL, maxUnits: expected - 1n }), Err.chip('Slippage'), 'max below quote');
    if (warp()) {
      await expectFail(buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.SOL, stalePrice: 61n }), Err.chip('StalePrice'), 'price 61 s old');
      // SEC-M2: conf/price = 2 % + 1 unit → PriceUncertain; exactly 2 % → accepted (and priced at price − conf)
      await expectFail(buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.SOL, conf: { sol: 300_000_001n } }), Err.chip('PriceUncertain'), 'conf 2 % + 1');
      const wide = await buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.SOL, conf: { sol: 300_000_000n }, maxUnits: (expected * 105n) / 100n });
      expect((await loadPending(env.chain, wide.pending))!.paidLamports).toBe((499n * 1_000_000_000n * 100_000_000n) / 100n / (15_000_000_000n - 300_000_000n));
      const fake = await forgePriceAccount(env.chain, env.pyth.sol, Keypair.generate().publicKey);
      await expectFail(buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.SOL, priceUpdate: fake }), Err.chip('StalePrice'), 'foreign price owner');
      await refreshPyth(env.chain, env.pyth);
    }
    // SKR feed passed for a SOL purchase → feed id mismatch → StalePrice
    await expectFail(buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.SOL, priceUpdate: env.pyth.skr.account }), Err.chip('StalePrice'), 'wrong feed');
    expect(PYTH_RECEIVER_ID.toBase58()).toBe('rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ');
  });

  it('C03 USDC / $CG / SKR: exact amounts, liab_* accounting, SKR promo discount stacks', async () => {
    const buyer = await env.player({ usdc: 1_000_000_000n, cg: 10_000_000_000n, skr: 100_000_000_000n });
    const vault = vaultKey();
    const led0 = await env.ledger();
    const shards0 = await Promise.all(Array.from({ length: LEDGER_SHARDS }, (_, i) => env.ledgerShard(i)));
    const before = { usdc: await tokenBalance(env.chain, env.mints.usdc, vault), cg: await tokenBalance(env.chain, env.mints.cg, vault), skr: await tokenBalance(env.chain, env.mints.skr, vault) };
    const u = await buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.USDC });
    expect(u.paid).toBe(4_990_000n);
    const c = await buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.CG });
    expect(c.paid).toBe(750_000_000n);
    const s = await buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.SKR });
    // $4.99 − 5 % SKR promo = $4.7405 → 474 cents (integer) at $0.0174 − 0.1 % conf (SEC-M2: price − conf) → 272 686 479 micro-SKR
    expect(s.paid).toBe((474n * 1_000_000n * 100_000_000n) / 100n / (1_740_000n - 1_740n));
    expect(s.paid).toBe(quoteUnits(env, SKU.STANDARD, 1, Currency.SKR));
    expect(await tokenBalance(env.chain, env.mints.usdc, vault)).toBe(before.usdc + u.paid);
    expect(await tokenBalance(env.chain, env.mints.cg, vault)).toBe(before.cg + c.paid);
    expect(await tokenBalance(env.chain, env.mints.skr, vault)).toBe(before.skr + s.paid);
    const led = await env.ledger();
    expect(led.liabUsdc - led0.liabUsdc).toBe(u.paid);
    expect(led.liabCg - led0.liabCg).toBe(c.paid);
    expect(led.liabSkr - led0.liabSkr).toBe(s.paid);
    // #12: all three landed in the buyer's own shard and nowhere else
    const mine = ledgerShardOf(buyer.publicKey);
    for (let i = 0; i < LEDGER_SHARDS; i++) {
      const sh = await env.ledgerShard(i);
      const exp = i === mine ? [u.paid, c.paid, s.paid] : [0n, 0n, 0n];
      expect([sh.liabUsdc - shards0[i].liabUsdc, sh.liabCg - shards0[i].liabCg, sh.liabSkr - shards0[i].liabSkr]).toEqual(exp);
    }
    for (const b of [u, c, s]) {
      const p = (await loadPending(env.chain, b.pending))!;
      expect([p.paidUsdc, p.paidCg, p.paidSkr].filter((x) => x > 0n)).toHaveLength(1);
    }
    // Starter and Limited cannot be paid in $CG (price_cg_micro = 0)
    await expectFail(buyPack(env, (await env.player({ cg: 1_000_000_000n })), { sku: SKU.STARTER, currency: Currency.CG }), Err.chip('CurrencyNotAccepted'), 'starter in $CG');
    // mint mismatch: buyer passes his USDC ATA for a $CG purchase
    const wrong = await env.player({ usdc: 1_000_000_000n });
    await expectFail(env.chain.send([
      initRandomnessIx({ ...rngAccounts(RNG_KIND.PACK, wrong.publicKey, 7n), queue: SB_QUEUE, recentSlot: (await env.chain.slot()) - 1n }),
      buyPackIx({ buyer: wrong.publicKey, sku: SKU.STANDARD, qty: 1, currency: Currency.CG, nonce: 7n, maxLamports: 0n, randomness: rngAccounts(RNG_KIND.PACK, wrong.publicKey, 7n).randomness, queue: SB_QUEUE, oracle: SB_ORACLE, usdcMint: env.mints.usdc, cgMint: env.mints.usdc, skrMint: env.mints.skr }),
    ], { signers: [wrong] }), Err.chip('CurrencyNotAccepted'), 'wrong mint');
  });

  it('C04 bundles ×5 / ×10 / ×25: price with discount, PendingPack.qty, rent reserve × chips × qty; qty 0 / 26 rejected', async () => {
    const buyer = await env.player({ usdc: 10_000_000_000n });
    for (const [qty, disc] of [[5, 700], [10, 1200], [25, 1800]] as const) {
      const b = await buyPack(env, buyer, { sku: SKU.STANDARD, qty, currency: Currency.USDC });
      const cents = (499n * BigInt(qty) * BigInt(10_000 - disc)) / 10_000n;
      expect(b.paid).toBe(cents * 10_000n);
      const p = (await loadPending(env.chain, b.pending))!;
      expect(p.qty).toBe(qty);
      expect(p.opened).toBe(0);
      expect(await env.chain.balance(b.pending)).toBeGreaterThanOrEqual(RENT_RESERVE_PER_CHIP * 3n * BigInt(qty));
    }
    await expectFail(buyPack(env, buyer, { sku: SKU.STANDARD, qty: 26, currency: Currency.USDC }), Err.chip('InvalidQuantity'), 'qty 26');
    await expectFail(buyPack(env, buyer, { sku: SKU.STANDARD, qty: 0, currency: Currency.USDC }), Err.chip('InvalidQuantity'), 'qty 0');
    // Limited never gets a bundle discount
    const lim = await env.player({ usdc: 10_000_000_000n });
    await env.chain.send([setParamsIx(env.admin.publicKey, { packs: encodePacks(env, { 3: { enabled: true } }) })], { signers: [env.admin] });
    env.config = await env.refreshConfig();
    const l = await buyPack(env, lim, { sku: SKU.LIMITED, qty: 5, currency: Currency.USDC });
    expect(l.paid).toBe(2499n * 5n * 10_000n);
  });

  it('C05 Limited: daily_cap 5 → the 6th of the day → DailyCapReached, resets after 24 h; disabled SKU → SkuDisabled', async () => {
    const buyer = await env.player({ usdc: 100_000_000_000n });
    await env.chain.send([setParamsIx(env.admin.publicKey, { packs: encodePacks(env, { 3: { enabled: true } }) })], { signers: [env.admin] });
    env.config = await env.refreshConfig();
    await buyPack(env, buyer, { sku: SKU.LIMITED, qty: 3, currency: Currency.USDC });
    await buyPack(env, buyer, { sku: SKU.LIMITED, qty: 2, currency: Currency.USDC });
    await expectFail(buyPack(env, buyer, { sku: SKU.LIMITED, qty: 1, currency: Currency.USDC }), Err.chip('DailyCapReached'), '6th limited');
    expect((await loadPity(env.chain, buyer.publicKey))!.boughtToday[SKU.LIMITED]).toBe(5);
    if (warp()) {
      await env.chain.warpSeconds(DAY + 1n);
      await buyPack(env, buyer, { sku: SKU.LIMITED, qty: 1, currency: Currency.USDC });
      expect((await loadPity(env.chain, buyer.publicKey))!.boughtToday[SKU.LIMITED]).toBe(1);
    }
    await env.chain.send([setParamsIx(env.admin.publicKey, { packs: encodePacks(env, { 3: { enabled: false } }) })], { signers: [env.admin] });
    env.config = await env.refreshConfig();
    await expectFail(buyPack(env, buyer, { sku: SKU.LIMITED, qty: 1, currency: Currency.USDC }), Err.chip('SkuDisabled'), 'disabled');
  });

  it('C06 paused: buy → Paused, but an already-paid purchase opens into V2 claims', async () => {
    const buyer = await env.player({ usdc: 1_000_000_000n });
    const b = await buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.USDC });
    await env.chain.send([setPausedIx(env.admin.publicKey, true)], { signers: [env.admin] });
    try {
      await expectFail(buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.USDC }), Err.chip('Paused'));
      const [open] = await revealAndOpenCompressedAll(env, buyer, b, valueOf('C06'));
      expect(open.event.count).toBe(3);
      expect((await loadPending(env.chain, b.pending))!.opened).toBe(1);
      const settlement = decodeCompressedPackSettlement((await env.chain.getAccount(compressedSettlementPda(buyer.publicKey, b.nonce)[0]))!.data);
      expect(settlement.totalClaims).toBe(3);
    } finally {
      await env.chain.send([setPausedIx(env.admin.publicKey, false)], { signers: [env.admin] });
    }
  });

  it('C07 open ×3: reveal + open_compressed_pack in ONE tx → deterministic V2 claims, pity, collection reservations, and pending settlement', async () => {
    const buyer = await env.player({ usdc: 1_000_000_000n });
    const b = await buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.USDC });
    const value = valueOf('C07');
    const pityBefore = (await loadPity(env.chain, buyer.publicKey))!.counters[SKU.STANDARD];
    const cfg = await env.refreshConfig();
    const led = await env.ledger();
    const metasBefore = await Promise.all(Array.from({ length: cfg.collectionsCreated }, async (_, i) => decodeCollectionMeta((await env.chain.getAccount(collectionMetaPda(i)[0]))!.data).minted));
    const { ix, rolled } = await openCompressedPackInstruction(env, buyer.publicKey, b.nonce, 0, value, buyer.publicKey);
    const tx = await env.chain.send([revealIx({ kind: RNG_KIND.PACK, payer: buyer.publicKey, randomness: b.randomness, value }), ix], { signers: [buyer], label: 'reveal+open_compressed' });
    const ev = findEvent(tx.logs, 'CompressedClaimsCreated', readCompressedClaimsCreated)!;
    expect(ev.count).toBe(3);
    expect(rolled.map((r) => r.collectionIdx)).toEqual(expect.any(Array));
    expect((await loadPity(env.chain, buyer.publicKey))!.counters[SKU.STANDARD]).toBe(pityBefore + (rolled.some((r) => r.rarity >= 6) ? 0 : 1));
    for (let i = 0; i < ev.count; i++) {
      const claim = decodeCompressedMintClaim((await env.chain.getAccount(compressedMintClaimPda(buyer.publicKey, ev.claimNonces[i])[0]))!.data);
      expect(claim.collectionIdx).toBe(rolled[i].collectionIdx);
      expect(claim.rarity).toBe(rolled[i].rarity);
      expect(claim.level).toBe(1);
      expect(claim.indexReserved).toBe(true);
      expect(claim.minted).toBe(false);
    }
    const metasAfter = await Promise.all(Array.from({ length: cfg.collectionsCreated }, async (_, i) => decodeCollectionMeta((await env.chain.getAccount(collectionMetaPda(i)[0]))!.data).minted));
    const delta = metasAfter.map((m, i) => m - metasBefore[i]);
    rolled.forEach((r) => { delta[r.collectionIdx] -= 1n; });
    expect(delta.every((d) => d === 0n)).toBe(true);
    expect((await loadPending(env.chain, b.pending))!.opened).toBe(1);
    expect(decodeCompressedPackSettlement((await env.chain.getAccount(compressedSettlementPda(buyer.publicKey, b.nonce)[0]))!.data).totalClaims).toBe(3);
    expect((await env.ledger()).liabUsdc).toBe(led.liabUsdc);
    const rnd = (await randomnessAccount(env.chain, b.randomness))!;
    expect(rnd.revealSlot).toBeGreaterThan(0n);
    expect(Array.from(rnd.value)).toEqual(Array.from(value));
    expect(tx.cu).toBeLessThan(1_400_000n);
  });

  it('C08 bundle ×5 opened in 5 separate transactions / slots: revealed value persists and each slot binds claims to the same settlement', async () => {
    const buyer = await env.player({ usdc: 1_000_000_000n });
    const b = await buyPack(env, buyer, { sku: SKU.STANDARD, qty: 5, currency: Currency.USDC });
    const value = valueOf('C08');
    await revealPack(env, b, value);
    const cfg = await env.refreshConfig();
    for (let packNo = 0; packNo < 5; packNo++) {
      if (warp()) await env.chain.warpSlots(50n);
      const pity = (await loadPity(env.chain, buyer.publicKey))!.counters[SKU.STANDARD];
      const r = await openCompressedPack(env, buyer.publicKey, b.nonce, packNo, value);
      const expected = expandRandomness(packSeed(value, 5, packNo), toEconPack(SKU.STANDARD, cfg.packs[SKU.STANDARD]), pity, cfg.collectionsCreated);
      expect(r.rolled.map((x) => x.rarity)).toEqual(expected.map((x) => x.rarity));
      expect(r.rolled.map((x) => x.collectionIdx)).toEqual(expected.map((x) => x.collectionIdx));
      const p = await loadPending(env.chain, b.pending);
      expect(p!.opened).toBe(packNo + 1);
      expect(p!.revealed).toBe(true);
      expect(Array.from(p!.value)).toEqual(Array.from(value));
      const settlement = decodeCompressedPackSettlement((await env.chain.getAccount(compressedSettlementPda(buyer.publicKey, b.nonce)[0]))!.data);
      expect(settlement.totalClaims).toBe((packNo + 1) * 3);
      for (const claimNonce of r.event.claimNonces) {
        const claim = decodeCompressedMintClaim((await env.chain.getAccount(compressedMintClaimPda(buyer.publicKey, claimNonce)[0]))!.data);
        expect(claim.settlement.equals(compressedSettlementPda(buyer.publicKey, b.nonce)[0])).toBe(true);
      }
    }
    // Claims still await Bubblegum mint/DAS registration; the compressed path
    // must not close the paid purchase or release its liability early.
    expect(await loadPending(env.chain, b.pending)).not.toBeNull();
    await expectAnyFail(env.chain.send([openCompressedPackIx({ payer: env.admin.publicKey, buyer: buyer.publicKey, nonce: b.nonce, packNo: 5, chips: 3, randomness: rngAccounts(RNG_KIND.PACK, buyer.publicKey, b.nonce).randomness, collectionIdx: [0, 0, 0] })], { signers: [env.admin] }), 'open after qty');
  });

  it('C09 bundle ×25 Premium: 25 compressed opens, each ≤ 400 k CU, reserve remains until async settlement', async () => {
    const buyer = await env.player({ usdc: 10_000_000_000n });
    const b = await buyPack(env, buyer, { sku: SKU.PREMIUM, qty: 25, currency: Currency.USDC });
    expect(b.paid).toBe(((1299n * 25n * 8200n) / 10_000n) * 10_000n);
    const value = valueOf('C09');
    await revealPack(env, b, value);
    const cranker = await env.player();
    const crankerBefore = await env.chain.balance(cranker.publicKey);
    let maxCu = 0n;
    let claims = 0;
    for (let i = 0; i < 25; i++) {
      const r = await openCompressedPack(env, buyer.publicKey, b.nonce, i, value, cranker);
      expect(r.event.count).toBe(5);
      claims += r.event.count;
      if (r.tx.cu > maxCu) maxCu = r.tx.cu;
    }
    expect(maxCu).toBeLessThanOrEqual(400_000n);
    // A third-party cranker is reimbursed from the pending reserve for claim rent.
    const crankerAfter = await env.chain.balance(cranker.publicKey);
    expect(crankerBefore - crankerAfter).toBeLessThan(25n * 200_000n);
    expect(claims).toBe(125);
    expect((await loadPending(env.chain, b.pending))!.opened).toBe(25);
    expect(decodeCompressedPackSettlement((await env.chain.getAccount(compressedSettlementPda(buyer.publicKey, b.nonce)[0]))!.data).totalClaims).toBe(125);
    console.info(`[T-L-C09] max open_compressed_pack CU (5 claims) = ${maxCu}`);
  });

  svmOnly('C10 fake randomness (SEC-C1): a byte-identical RandomnessAccountData under a foreign owner → RandomnessMismatch at buy and at open', async () => {
    if (!warp()) return;
    const buyer = await env.player({ usdc: 1_000_000_000n });
    // (a) at buy: the PDA address is fixed by seeds, so plant the forged account AT the PDA address under a foreign owner
    const nonce = 4242n;
    const rng = rngAccounts(RNG_KIND.PACK, buyer.publicKey, nonce);
    await forgeRandomness(env.chain, { owner: Keypair.generate().publicKey, kind: RNG_KIND.PACK, seedSlot: 0n, revealSlot: 0n, value: valueOf('C10'), address: rng.randomness });
    await expectFail(buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.USDC, nonce, skipInit: true }), Err.chip('RandomnessMismatch'), 'forged owner at buy');
    // (b) at open: a legit purchase, but the pending account is pinned to ITS randomness — a forged revealed account elsewhere is rejected by the pin
    const b = await buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.USDC });
    const forged = await forgeRandomness(env.chain, { owner: Keypair.generate().publicKey, kind: RNG_KIND.PACK, seedSlot: (await loadPending(env.chain, b.pending))!.commitSlot, revealSlot: await env.chain.slot(), value: valueOf('C10') });
    const { ix } = await openCompressedPackInstruction(env, buyer.publicKey, b.nonce, 0, valueOf('C10'), buyer.publicKey, { collectionOverride: [0, 0, 0] });
    ix.keys[3] = { ...ix.keys[3], pubkey: forged };
    await expectFail(env.chain.send([ix], { signers: [buyer] }), Err.chip('RandomnessMismatch'), 'forged at open');
    // (c) even the REAL pinned address, if its owner were swapped, fails the owner check
    const real = (await env.chain.getAccount(b.randomness))!;
    await env.chain.setAccount(b.randomness, { owner: Keypair.generate().publicKey, data: real.data, lamports: real.lamports });
    await expectFail(openCompressedPack(env, buyer.publicKey, b.nonce, 0, valueOf('C10')), Err.chip('RandomnessMismatch'), 'owner swapped on the pinned account');
    await env.chain.setAccount(b.randomness, { owner: SB_MOCK_ID, data: real.data, lamports: real.lamports });
  });

  it('C11 cancel_stale_pack before STALE_PACK_SLOTS → NotStale', async () => {
    const buyer = await env.player({ usdc: 1_000_000_000n });
    const b = await buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.USDC });
    await expectFail(cancelStale(env, buyer, b, env.mints.usdc), Err.chip('NotStale'), 'immediately');
    if (!warp()) return;
    await env.chain.warpSlots(STALE - 5n);
    await expectFail(cancelStale(env, buyer, b, env.mints.usdc), Err.chip('NotStale'), 'one slot short');
  });

  svmOnly('C12 after reveal: cancel → RandomnessAlreadyRevealed even past the window; open still OK 1 000 slots later (C2)', async () => {
    if (!warp()) return;
    const buyer = await env.player({ usdc: 1_000_000_000n });
    const b = await buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.USDC });
    await revealPack(env, b, valueOf('C12'));
    await env.chain.warpSlots(STALE + 10n);
    await expectFail(cancelStale(env, buyer, b, env.mints.usdc), Err.chip('RandomnessAlreadyRevealed'), 'cancel after reveal');
    await env.chain.warpSlots(1_000n);
    const r = await openCompressedPack(env, buyer.publicKey, b.nonce, 0, valueOf('C12'));
    expect(r.event.count).toBe(3);
    expect((await loadPending(env.chain, b.pending))!.opened).toBe(1);
  });

  svmOnly('C13 no reveal after STALE_PACK_SLOTS → 100 % refund in all four currencies, liab_* back to baseline, PendingPack closed', async () => {
    if (!warp()) return;
    const buyer = await env.player({ usdc: 1_000_000_000n, cg: 10_000_000_000n, skr: 100_000_000_000n });
    const led0 = await env.ledger();
    const sol = await buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.SOL });
    const usdc = await buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.USDC });
    const cg = await buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.CG });
    const skr = await buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.SKR });
    await env.chain.warpSlots(STALE + 1n);
    const solBefore = await env.chain.balance(buyer.publicKey);
    const reserve = await env.chain.balance(sol.pending);
    await cancelStale(env, buyer, sol);
    const solAfter = await env.chain.balance(buyer.publicKey);
    expect(lamportsClose(solAfter - solBefore, sol.paid + reserve, 20_000n)).toBe(true); // refund + reserve + rent − fee
    const tok = async (m: PublicKey) => tokenBalance(env.chain, m, buyer.publicKey);
    const u0 = await tok(env.mints.usdc); await cancelStale(env, buyer, usdc, env.mints.usdc); expect((await tok(env.mints.usdc)) - u0).toBe(usdc.paid);
    const c0 = await tok(env.mints.cg); await cancelStale(env, buyer, cg, env.mints.cg); expect((await tok(env.mints.cg)) - c0).toBe(cg.paid);
    const s0 = await tok(env.mints.skr); await cancelStale(env, buyer, skr, env.mints.skr); expect((await tok(env.mints.skr)) - s0).toBe(skr.paid);
    const led = await env.ledger();
    expect(led.liabLamports).toBe(led0.liabLamports);
    expect(led.liabUsdc).toBe(led0.liabUsdc);
    expect(led.liabCg).toBe(led0.liabCg);
    expect(led.liabSkr).toBe(led0.liabSkr);
    for (const b of [sol, usdc, cg, skr]) expect(await loadPending(env.chain, b.pending)).toBeNull();
    // the reveal is refused afterwards? No — the oracle account is still un-revealed; a late reveal is harmless (nothing pins it) and close_randomness returns the rent
    await revealPack(env, sol, valueOf('late'));
    const lut = (await randomnessAccount(env.chain, sol.randomness))!.lutSlot;
    const ownerBefore = await env.chain.balance(buyer.publicKey);
    await env.chain.send([closeRandomnessIx({ ...rngAccounts(RNG_KIND.PACK, buyer.publicKey, sol.nonce), payer: env.admin.publicKey, lutSlot: lut })], { signers: [env.admin] });
    expect(await env.chain.getAccount(sol.randomness)).toBeNull();
    expect((await env.chain.balance(buyer.publicKey)) - ownerBefore).toBe(await env.chain.rentExempt(480));
  });

  svmOnly('C13b close_randomness_lut (backlog #23): refused while the request is live, then pays the lookup table rent to the player, never to the relayer', async () => {
    if (!warp()) return;
    const buyer = await env.player({ usdc: 1_000_000_000n });
    const b = await buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.USDC });
    const rng = rngAccounts(RNG_KIND.PACK, buyer.publicKey, b.nonce);
    // Read the slot BEFORE any close: the randomness account (the only record of it) is deleted by close_randomness.
    const lutSlot = (await randomnessAccount(env.chain, b.randomness))!.lutSlot;
    const lutSigner = sbLutSignerPda(rng.randomness)[0];
    const lutKey = sbLutPda(lutSigner, lutSlot)[0];
    // The harness cannot deploy the Address Lookup Table program, and only an account's OWNER may debit
    // it — so in the localnet build `LUT_OWNER_PROGRAM_ID` is the sb_mock, exactly as `SB_PROGRAM_ID`
    // already is (randomness.rs). The address itself stays the real ALT PDA derivation in every build.
    const LUT_RENT = 1_500_000n;
    const table = (owner: PublicKey = SB_MOCK_ID) => ({ owner, data: new Uint8Array(56), lamports: LUT_RENT });
    await env.chain.setAccount(lutKey, table());
    const lutIx = (payer: Keypair) => closeRandomnessLutIx({ ...rng, payer: payer.publicKey, lutSlot });
    // 1. the request still pins the randomness → same rule as close_randomness
    await expectFail(env.chain.send([lutIx(env.admin)], { signers: [env.admin] }), Err.chip('InvalidChipState'), 'pending still open');
    // 2. unsettled → settle by refunding after the stale window
    await env.chain.warpSlots(STALE + 1n);
    await cancelStale(env, buyer, b, env.mints.usdc);
    expect(await loadPending(env.chain, b.pending)).toBeNull();
    // 3. close_randomness first: it deactivates the table (and deletes the account that names it)
    await env.chain.send([closeRandomnessIx({ ...rng, payer: env.admin.publicKey, lutSlot })], { signers: [env.admin] });
    expect(await env.chain.getAccount(rng.randomness)).toBeNull();
    // 4. the relayer (admin) pays the fee; the PLAYER receives the table's rent
    const playerBefore = await env.chain.balance(buyer.publicKey);
    const relayerBefore = await env.chain.balance(env.admin.publicKey);
    await env.chain.send([lutIx(env.admin)], { signers: [env.admin] });
    expect(await env.chain.getAccount(lutKey)).toBeNull();
    expect((await env.chain.balance(buyer.publicKey)) - playerBefore).toBe(LUT_RENT);
    expect((await env.chain.balance(env.admin.publicKey)) - relayerBefore).toBeLessThan(0n); // fee only
    // 5. the caller cannot aim the CPI at an account of its own: `lut` must be the derivation of
    //    [lutSigner, lut_slot], and lut_signer must be the derivation of this randomness. Same
    //    instruction, one key swapped — nothing is paid out.
    const attackerLut = Keypair.generate().publicKey;
    await env.chain.setAccount(attackerLut, table());
    const good = lutIx(env.admin);
    const keys = [...good.keys];
    keys[5] = { pubkey: attackerLut, isSigner: false, isWritable: true };
    const forged = new TransactionInstruction({ programId: good.programId, keys, data: good.data });
    await expectFail(env.chain.send([forged], { signers: [env.admin] }), Err.chip('RandomnessMismatch'), 'caller-chosen table');
    expect(await env.chain.balance(attackerLut)).toBe(LUT_RENT);
    // 6. and a second run over the closed request fails closed: the table is gone (system-owned), so
    //    the ownership pin rejects it before any CPI — nothing is sent to Switchboard twice
    await expectFail(env.chain.send([lutIx(env.admin)], { signers: [env.admin] }), Err.chip('RandomnessMismatch'), 'already reclaimed');
  });

  it('C14 crank race: two open_compressed_pack calls for the same pack_no — the second fails and claims remain consistent', async () => {
    const buyer = await env.player({ usdc: 1_000_000_000n });
    const b = await buyPack(env, buyer, { sku: SKU.STANDARD, qty: 2, currency: Currency.USDC });
    const value = valueOf('C14');
    await revealPack(env, b, value);
    const { ix } = await openCompressedPackInstruction(env, buyer.publicKey, b.nonce, 0, value, env.admin.publicKey);
    await env.chain.send([ix], { signers: [env.admin] });
    await expectFail(env.chain.send([ix], { signers: [env.admin] }), Err.chip('InvalidQuantity'), 'replayed pack_no 0');
    expect((await loadPending(env.chain, b.pending))!.opened).toBe(1);
    await openCompressedPack(env, buyer.publicKey, b.nonce, 1, value);
    expect((await loadPending(env.chain, b.pending))!.opened).toBe(2);
    expect(decodeCompressedPackSettlement((await env.chain.getAccount(compressedSettlementPda(buyer.publicKey, b.nonce)[0]))!.data).totalClaims).toBe(6);
  });

  it('C15 wrong remaining_accounts: a collection/tree account that does not match the roll → InvalidCollection; wrong count → InvalidQuantity', async () => {
    const buyer = await env.player({ usdc: 1_000_000_000n });
    const b = await buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.USDC });
    const value = valueOf('C15');
    await revealPack(env, b, value);
    const { rolled } = await openCompressedPackInstruction(env, buyer.publicKey, b.nonce, 0, value, env.admin.publicKey);
    const wrong = rolled.map((r) => (r.collectionIdx + 1) % env.config.collectionsCreated);
    await expectFail(openCompressedPack(env, buyer.publicKey, b.nonce, 0, value, env.admin, { collectionOverride: wrong }), Err.chip('InvalidCollection'), 'shifted collections');
    const short = openCompressedPackIx({ payer: env.admin.publicKey, buyer: buyer.publicKey, nonce: b.nonce, packNo: 0, chips: 2, randomness: b.randomness, collectionIdx: rolled.slice(0, 2).map((r) => r.collectionIdx) });
    await expectFail(env.chain.send([short], { signers: [env.admin] }), Err.chip('InvalidQuantity'), '2 of 3 claims');
    await openCompressedPack(env, buyer.publicKey, b.nonce, 0, value);
  });

  it('C16 pity: after hard_at − 1 Standard packs without a Legend the next one guarantees ≥ Legend on the last slot (pity counter pre-seeded by earlier opens in this run)', async () => {
    const buyer = await env.player({ usdc: 100_000_000_000n });
    const hardAt = env.config.packs[SKU.STANDARD].pityHardAt; // 60
    // drive the counter up with a value that never rolls ≥ Legend: pick per-pack values by search
    const econ = toEconPack(SKU.STANDARD, env.config.packs[SKU.STANDARD]);
    const noLegend = (pity: number) => { for (let s = 0; s < 5000; s++) { const v = valueOf('C16-none', s); if (expandRandomness(v, econ, pity, 10).every((r) => r.rarity < 6)) return v; } throw new Error('no value'); };
    // bundles of 25 + 25 + 9 = 59 opens; the same 32-byte value serves a whole bundle because sub-seeds are keccak-derived → search per pack instead
    let counter = (await loadPity(env.chain, buyer.publicKey))?.counters[SKU.STANDARD] ?? 0;
    const need = hardAt - 1 - counter;
    for (let done = 0; done < need;) {
      const qty = Math.min(25, need - done);
      const b = await buyPack(env, buyer, { sku: SKU.STANDARD, qty, currency: Currency.USDC });
      // find one base value whose every sub-seed avoids Legend at the counters it will see
      let base: Uint8Array | undefined;
      for (let s = 0; s < 20_000 && !base; s++) {
        const v = valueOf('C16-bundle', s);
        let ok = true;
        for (let p = 0; p < qty && ok; p++) ok = expandRandomness(packSeed(v, qty, p), econ, counter + p, 10).every((r) => r.rarity < 6);
        if (ok) base = v;
      }
      if (!base) throw new Error('no bundle value without Legend');
      await revealPack(env, b, base);
      for (let p = 0; p < qty; p++) await openCompressedPack(env, buyer.publicKey, b.nonce, p, base);
      done += qty; counter += qty;
    }
    expect((await loadPity(env.chain, buyer.publicKey))!.counters[SKU.STANDARD]).toBe(hardAt - 1);
    // the 60th: pick a value whose raw roll is < Legend on the last slot → program must lift it to Legend
    const b = await buyPack(env, buyer, { sku: SKU.STANDARD, qty: 1, currency: Currency.USDC });
    const v = noLegend(0);
    const raw = expandRandomness(v, { ...econ, pity: null }, 0, 10);
    expect(raw[2].rarity).toBeLessThan(6);
    const [r] = await revealAndOpenCompressedAll(env, buyer, b, v);
    expect(r.rolled[2].rarity).toBeGreaterThanOrEqual(6);
    expect((await loadPity(env.chain, buyer.publicKey))!.counters[SKU.STANDARD]).toBe(0);
    expect(PACKS.standard.pity?.hardAt).toBe(hardAt);
  }, 600_000);

  it('C17 rng PDA (SEC-C3 part 2): authority ≠ rng_auth → RandomnessAuthority; already committed → RandomnessUsed; non-PDA address → seeds error', async () => {
    const buyer = await env.player({ usdc: 1_000_000_000n });
    const mk = (randomness: PublicKey, nonce: bigint) => buyPackIx({ buyer: buyer.publicKey, sku: SKU.STANDARD, qty: 1, currency: Currency.USDC, nonce, maxLamports: 0n, randomness, queue: SB_QUEUE, oracle: SB_ORACLE, usdcMint: env.mints.usdc, cgMint: env.mints.cg, skrMint: env.mints.skr });
    // (a) a mock account created directly with the buyer as authority, at a non-PDA address → Anchor seeds constraint
    const stray = Keypair.generate();
    await env.chain.send([mockInitIx({ payer: buyer.publicKey, randomness: stray.publicKey, authority: buyer.publicKey, recentSlot: (await env.chain.slot()) - 1n })], { signers: [buyer, stray] });
    await expectFail(env.chain.send([mk(stray.publicKey, 9001n)], { signers: [buyer] }), Err.anchor('ConstraintSeeds'), 'non-PDA randomness');
    // (b) the right PDA address but authority ≠ rng_auth (forged via set_raw on a legit init) → RandomnessAuthority
    if (warp()) {
      const nonce = 9002n;
      const rng = rngAccounts(RNG_KIND.PACK, buyer.publicKey, nonce);
      await env.chain.send([initRandomnessIx({ ...rng, queue: SB_QUEUE, recentSlot: (await env.chain.slot()) - 1n })], { signers: [buyer] });
      await env.chain.send([setRawIx({ payer: buyer.publicKey, randomness: rng.randomness, payload: encodeRandomnessPayload({ authority: buyer.publicKey }) })], { signers: [buyer] });
      await expectFail(env.chain.send([mk(rng.randomness, nonce)], { signers: [buyer] }), Err.chip('RandomnessAuthority'), 'authority ≠ rng_auth');
      // (c) already committed (seed_slot > 0) → RandomnessUsed
      const nonce2 = 9003n;
      const rng2 = rngAccounts(RNG_KIND.PACK, buyer.publicKey, nonce2);
      await env.chain.send([initRandomnessIx({ ...rng2, queue: SB_QUEUE, recentSlot: (await env.chain.slot()) - 1n })], { signers: [buyer] });
      await env.chain.send([setRawIx({ payer: buyer.publicKey, randomness: rng2.randomness, payload: encodeRandomnessPayload({ authority: rngAuthPda(RNG_KIND.PACK)[0], seedSlot: 5n }) })], { signers: [buyer] });
      await expectFail(env.chain.send([mk(rng2.randomness, nonce2)], { signers: [buyer] }), Err.chip('RandomnessUsed'), 'seed_slot > 0');
    }
  });

  it('C18 init_randomness + buy_pack in one tx: seed_slot == slot − 1, authority == rng_auth, PendingPack.randomness == rngPda; re-init same nonce → RandomnessUsed', async () => {
    const buyer = await env.player({ usdc: 1_000_000_000n });
    const b = await buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.USDC });
    const rnd = (await randomnessAccount(env.chain, b.randomness))!;
    const p = (await loadPending(env.chain, b.pending))!;
    expect(rnd.authority.equals(rngAuthPda(RNG_KIND.PACK)[0])).toBe(true);
    expect(rnd.queue.equals(SB_QUEUE)).toBe(true);
    expect(rnd.revealSlot).toBe(0n);
    expect(p.commitSlot).toBe(rnd.seedSlot);
    expect(p.randomness.equals(rngAccounts(RNG_KIND.PACK, buyer.publicKey, b.nonce).randomness)).toBe(true);
    expect(rnd.seedSlot).toBeGreaterThan(0n);
    const acc = (await env.chain.getAccount(b.randomness))!;
    expect(acc.owner.equals(SB_MOCK_ID)).toBe(true);
    expect(acc.data.length).toBe(480);
    await expectFail(env.chain.send([initRandomnessIx({ ...rngAccounts(RNG_KIND.PACK, buyer.publicKey, b.nonce), queue: SB_QUEUE, recentSlot: (await env.chain.slot()) - 1n })], { signers: [buyer] }), Err.chip('RandomnessUsed'), 're-init');
    // kind 2 (battle) is arena-only in chip_core
    const bad = initRandomnessIx({ ...rngAccounts(RNG_KIND.PACK, buyer.publicKey, 777n), queue: SB_QUEUE, recentSlot: 1n });
    bad.data = Buffer.from(bad.data); bad.data[8] = 2; // kind byte
    await expectAnyFail(env.chain.send([bad], { signers: [buyer] }), 'kind 2 via chip_core');
  });

  it('C19 reveal_randomness by a stranger with the (mock) oracle signature → reveal_slot > 0; open by any payer; reveal twice → error', async () => {
    const buyer = await env.player({ usdc: 1_000_000_000n });
    const b = await buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.USDC });
    const stranger = await env.player();
    await revealPack(env, b, valueOf('C19'), stranger);
    const rnd = (await randomnessAccount(env.chain, b.randomness))!;
    expect(rnd.revealSlot).toBeGreaterThan(0n);
    expect(Array.from(rnd.value)).toEqual(Array.from(valueOf('C19')));
    await expectFail(revealPack(env, b, valueOf('other'), stranger), Err.chip('RandomnessAlreadyRevealed'), 'second reveal');
    const r = await openCompressedPack(env, buyer.publicKey, b.nonce, 0, valueOf('C19'), stranger);
    expect(r.event.count).toBe(3);
    expect((await loadPending(env.chain, b.pending))!.opened).toBe(1);
    // a reveal for a never-committed account (init only) → RandomnessExpired (seed_slot == 0)
    const nonce = 4711n;
    const rng = rngAccounts(RNG_KIND.PACK, buyer.publicKey, nonce);
    await env.chain.send([initRandomnessIx({ ...rng, queue: SB_QUEUE, recentSlot: (await env.chain.slot()) - 1n })], { signers: [buyer] });
    await expectFail(env.chain.send([revealIx({ kind: RNG_KIND.PACK, payer: stranger.publicKey, randomness: rng.randomness, value: valueOf('x') })], { signers: [stranger] }), Err.chip('RandomnessExpired'), 'reveal before commit');
  });

  it('C20 close_randomness: compressed claims keep PendingPack and randomness alive until asynchronous settlement', async () => {
    const buyer = await env.player({ usdc: 1_000_000_000n });
    const b = await buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.USDC });
    const rng = rngAccounts(RNG_KIND.PACK, buyer.publicKey, b.nonce);
    const lut = (await randomnessAccount(env.chain, b.randomness))!.lutSlot;
    const close = (payer: Keypair) => env.chain.send([closeRandomnessIx({ ...rng, payer: payer.publicKey, lutSlot: lut })], { signers: [payer] });
    await expectFail(close(env.admin), Err.chip('InvalidChipState'), 'pending still open');
    await revealAndOpenCompressedAll(env, buyer, b, valueOf('C20'));
    // Unlike the legacy path, opening compressed claims does not close the
    // purchase: mint/DAS registration must settle every claim first. Closing
    // randomness while that settlement is pending remains forbidden.
    await expectFail(close(env.admin), Err.chip('InvalidChipState'), 'compressed settlement still pending');
    const other = await buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.USDC });
    const bad = closeRandomnessIx({ ...rngAccounts(RNG_KIND.PACK, buyer.publicKey, other.nonce), payer: env.admin.publicKey, lutSlot: lut });
    bad.keys[4] = { pubkey: pendingPackPda(buyer.publicKey, b.nonce)[0], isSigner: false, isWritable: false };
    await expectFail(env.chain.send([bad], { signers: [env.admin] }), Err.chip('RandomnessMismatch'), 'wrong pending');
    expect(ataOf(env.mints.cg, TREASURY.publicKey)).toBeInstanceOf(PublicKey);
  });
});
