// T-L-SEC — adversarial transactions against the live programs (SECURITY-AUDIT-2026-09-25.md).
//
// Pattern: build a VALID instruction with the production client builders, change exactly ONE
// detail an attacker controls (drop a signature, swap a program id, substitute an account they
// own, repeat an account, forge a lookalike PDA), assert the precise error, then send the
// unmodified original and assert it succeeds — so every rejection is attributable to the single
// mutation and not to a broken fixture.
//
// Checklist mapping: A1 PDA spoofing, A2 wrong-owner / type cosplay, A3 missing signer, A4 fake
// program, A6 re-initialisation, C16 treasury / vault substitution, D23 writable enforcement,
// E28 rent to the wrong account, E29 duplicate accounts (SEC-F2 regression), C20 admin-only paths.
import { beforeAll, describe, expect, it } from 'vitest';
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { ACCOUNT_SIZE, AccountLayout, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createInitializeAccount3Instruction } from '@solana/spl-token';
import { findEvent } from '@/chain/anchor';
import { decodeCompressedMintClaim, decodeGameConfig } from '@/chain/accounts';
import { buyPackIx, cancelStalePackIx, fuseCompressedClaimsIx, stageCompressedChipIx } from '@/chain/ix/chipCore';
import { buyCompressedSolIx, cancelCompressedIx, listCompressedIx, MarketCurrency } from '@/chain/ix/market';
import { closeRandomnessIx, initRandomnessIx, rngAccounts } from '@/chain/ix/rng';
import { CHIP_CORE_ID } from '@/chain/ids';
import { LEDGER_SHARDS, RNG_KIND, compressedMintClaimPda, configPda, ledgerPda, ledgerShardOf, pendingPackPda } from '@/chain/pdas';
import { BUYBACK, SB_ORACLE, SB_QUEUE, TREASURY, binariesPresent, getEnv, initializeIx, sweepVaultIx, tokenBalance, type Env } from './helpers/env';
import { ANCHOR, Err, expectAnyFail, expectFail } from './helpers/expect';
import { Currency, SKU, ataOf, nextNonce, revealPack, vaultKey } from './helpers/flows';
import { randomnessAccount } from './helpers/sbmock';

const bins = binariesPresent();
const suite = describe.skipIf(!bins.ok && !process.env.LOCALNET_RPC);
const litesvmOnly = !!process.env.LOCALNET_RPC;
const SOL = 1_000_000_000n;
const STALE_PACK_SLOTS = 10_800n;
const USDC_STANDARD = 5_990_000n;
const SYSTEM_PROGRAM_ID = SystemProgram.programId;

/** a USDC Standard pack purchase, exactly as the client sends it: [init_randomness, buy_pack] */
async function usdcBuy(env: Env, buyer: PublicKey, nonce = BigInt(nextNonce())) {
  const rng = rngAccounts(RNG_KIND.PACK, buyer, nonce);
  const init = initRandomnessIx({ ...rng, queue: SB_QUEUE, recentSlot: (await env.chain.slot()) - 1n });
  const buy = buyPackIx({
    buyer, sku: SKU.STANDARD, qty: 1, currency: Currency.USDC, nonce, maxLamports: 0n,
    randomness: rng.randomness, queue: SB_QUEUE, oracle: SB_ORACLE,
    usdcMint: env.mints.usdc, cgMint: env.mints.cg, skrMint: env.mints.skr,
  });
  return { nonce, randomness: rng.randomness, init, buy };
}

/** copy of `ix` with every occurrence of `from` replaced (and optionally new signer / writable flags) */
function swapKey(ix: TransactionInstruction, from: PublicKey, to: PublicKey, flags: { isSigner?: boolean; isWritable?: boolean } = {}): TransactionInstruction {
  let hits = 0;
  const keys = ix.keys.map((k) => {
    if (!k.pubkey.equals(from)) return { ...k };
    hits++;
    return { pubkey: to, isSigner: flags.isSigner ?? k.isSigner, isWritable: flags.isWritable ?? k.isWritable };
  });
  if (!hits) throw new Error(`swapKey: ${from.toBase58()} not in the instruction`);
  return new TransactionInstruction({ programId: ix.programId, keys, data: ix.data });
}
/** copy of `ix` with the meta at `index` replaced */
function swapAt(ix: TransactionInstruction, index: number, meta: Partial<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>): TransactionInstruction {
  const keys = ix.keys.map((k, i) => (i === index ? { ...k, ...meta } : { ...k }));
  return new TransactionInstruction({ programId: ix.programId, keys, data: ix.data });
}
const idx = (ix: TransactionInstruction, key: PublicKey) => ix.keys.findIndex((k) => k.pubkey.equals(key));

async function stageClaim(env: Env, owner: PublicKey, nonce: bigint, rarity: number, collectionIdx: number): Promise<{ claim: PublicKey; logs: string[] }> {
  const tx = await env.chain.send([
    stageCompressedChipIx({
      admin: env.admin.publicKey, buyer: owner, collectionIdx, claimNonce: nonce, rarity, level: 1, gameIndex: nonce,
      expiresAt: (await env.chain.now()) + 7n * 86_400n,
    }),
  ], { signers: [env.admin], label: `stage security claim ${nonce}` });
  return { claim: compressedMintClaimPda(owner, nonce)[0], logs: tx.logs };
}
const claimOf = async (env: Env, key: PublicKey) => decodeCompressedMintClaim((await env.chain.getAccount(key))!.data);
const rawTokenAmount = async (env: Env, key: PublicKey) => AccountLayout.decode((await env.chain.getAccount(key))!.data).amount;

suite('T-L-SEC adversarial transactions', () => {
  let env: Env;
  beforeAll(async () => { env = await getEnv(); });

  // ------------------------------------------------------------------ E29 / SEC-F2
  it('SEC-F2 (E29) atomic claim fusion: the same claim repeated in remaining_accounts → DuplicateMaterial; nothing burned or consumed', async () => {
    const owner = await env.player({ cg: 100_000_000n });
    const a = (await stageClaim(env, owner.publicKey, 80_001n, 0, 0)).claim;
    const b = (await stageClaim(env, owner.publicKey, 80_002n, 0, 0)).claim;
    const c = (await stageClaim(env, owner.publicKey, 80_003n, 0, 0)).claim;
    const cg0 = await tokenBalance(env.chain, env.mints.cg, owner.publicKey);
    const burned0 = (await env.ledger()).burnedTotal;
    const fuse = (materialClaims: PublicKey[], resultClaimNonce: bigint) =>
      env.chain.send([fuseCompressedClaimsIx({ owner: owner.publicKey, resultClaimNonce, resultCollectionIdx: 0, cgMint: env.mints.cg, materialClaims })], { signers: [owner], label: 'fuse_compressed_claims' });

    // before the fix each of these minted a Common+ claim out of ONE (or two) Common claims
    await expectFail(fuse([a, a, a], 80_010n), Err.chip('DuplicateMaterial'), '[a, a, a]');
    await expectFail(fuse([a, a, b], 80_011n), Err.chip('DuplicateMaterial'), '[a, a, b]');
    await expectFail(fuse([a, b, a], 80_012n), Err.chip('DuplicateMaterial'), '[a, b, a]');
    await expectFail(fuse([b, a, a], 80_013n), Err.chip('DuplicateMaterial'), '[b, a, a]');
    expect(await tokenBalance(env.chain, env.mints.cg, owner.publicKey)).toBe(cg0);
    expect((await env.ledger()).burnedTotal).toBe(burned0);
    for (const k of [a, b, c]) expect((await claimOf(env, k)).consumed).toBe(false);
    for (const n of [80_010n, 80_011n, 80_012n, 80_013n]) expect(await env.chain.getAccount(compressedMintClaimPda(owner.publicKey, n)[0])).toBeNull();

    // control: three distinct materials fuse (proves the fixture was valid)
    await fuse([a, b, c], 80_020n);
    const r = compressedMintClaimPda(owner.publicKey, 80_020n)[0];
    expect((await claimOf(env, r)).rarity).toBe(1);
    // the amplification chain the bug enabled: one settlement-free fusion result, repeated ×3
    await expectFail(fuse([r, r, r], 80_021n), Err.chip('DuplicateMaterial'), 'fusion result repeated ×3');
    expect((await claimOf(env, r)).consumed).toBe(false);
  });

  // ------------------------------------------------------------------ A3 signer
  it('A3 missing signer: buy_pack with the buyer NOT signing (fee paid by the attacker) → AccountNotSigner', async () => {
    const victim = await env.player({ usdc: 100_000_000n });
    const attacker = await env.player({ sol: 2n * SOL });
    const { buy } = await usdcBuy(env, victim.publicKey);
    const forged = swapKey(buy, victim.publicKey, victim.publicKey, { isSigner: false });
    await expectFail(env.chain.send([forged], { signers: [attacker] }), Err.anchor('AccountNotSigner', CHIP_CORE_ID.toBase58()), 'unsigned buyer');
    expect(await tokenBalance(env.chain, env.mints.usdc, victim.publicKey)).toBe(100_000_000n);
  });

  // ------------------------------------------------------------------ A4 fake programs, D23 writable
  it('A4 fake programs: System / Token program ids swapped in buy_pack → InvalidProgramId; D23 read-only vault token account → ConstraintMut; original succeeds', async () => {
    const buyer = await env.player({ usdc: 100_000_000n });
    const fakeProgram = CHIP_CORE_ID; // an executable the attacker can name, but not the System/Token program
    {
      const { init, buy } = await usdcBuy(env, buyer.publicKey);
      const sys = idx(buy, SYSTEM_PROGRAM_ID);
      await expectFail(env.chain.send([init, swapAt(buy, sys, { pubkey: fakeProgram })], { signers: [buyer] }), Err.anchor('InvalidProgramId', CHIP_CORE_ID.toBase58()), 'fake system program');
    }
    {
      const { init, buy } = await usdcBuy(env, buyer.publicKey);
      await expectFail(env.chain.send([init, swapKey(buy, TOKEN_PROGRAM_ID, fakeProgram)], { signers: [buyer] }), Err.anchor('InvalidProgramId', CHIP_CORE_ID.toBase58()), 'fake token program');
    }
    {
      const { init, buy } = await usdcBuy(env, buyer.publicKey);
      const vaultUsdc = ataOf(env.mints.usdc, vaultKey());
      await expectFail(env.chain.send([init, swapKey(buy, vaultUsdc, vaultUsdc, { isWritable: false })], { signers: [buyer] }), Err.anchor('ConstraintMut', CHIP_CORE_ID.toBase58()), 'read-only vault token');
    }
    const before = await tokenBalance(env.chain, env.mints.usdc, buyer.publicKey);
    const ok = await usdcBuy(env, buyer.publicKey);
    await env.chain.send([ok.init, ok.buy], { signers: [buyer], label: 'control buy' });
    expect(before - (await tokenBalance(env.chain, env.mints.usdc, buyer.publicKey))).toBe(USDC_STANDARD);
  });

  // ------------------------------------------------------------------ C16 vault substitution
  it('C16 payment redirect: the buyer passes HIS OWN token account as the vault → ConstraintTokenOwner (money never leaves him for free)', async () => {
    const buyer = await env.player({ usdc: 100_000_000n });
    const accomplice = await env.player({ usdc: 1n });
    const { init, buy } = await usdcBuy(env, buyer.publicKey);
    const vaultUsdc = ataOf(env.mints.usdc, vaultKey());
    for (const [label, sink] of [['own ATA', ataOf(env.mints.usdc, buyer.publicKey)], ['accomplice ATA', ataOf(env.mints.usdc, accomplice.publicKey)]] as const) {
      await expectFail(env.chain.send([init, swapKey(buy, vaultUsdc, sink)], { signers: [buyer] }), Err.anchor('ConstraintTokenOwner', CHIP_CORE_ID.toBase58()), label);
    }
    expect(await tokenBalance(env.chain, env.mints.usdc, buyer.publicKey)).toBe(100_000_000n);
  });

  // ------------------------------------------------------------------ A1 / A2 PDA spoofing, type cosplay
  it('A1/A2 lookalike accounts at the config slot: byte-identical copy (non-PDA) → ConstraintSeeds; wrong owner → AccountOwnedByWrongProgram; other chip_core type → AccountDiscriminatorMismatch', async () => {
    if (litesvmOnly) return; // setAccount forges state — LiteSVM only
    const buyer = await env.player({ usdc: 100_000_000n });
    const [config] = configPda();
    const real = (await env.chain.getAccount(config))!;
    // the attacker's copy: identical bytes, but treasury → attacker
    const attacker = Keypair.generate();
    const forged = new Uint8Array(real.data);
    const cfg = decodeGameConfig(real.data);
    const tOff = Buffer.from(forged).indexOf(Buffer.from(cfg.treasury.toBytes()));
    expect(tOff).toBeGreaterThan(8);
    forged.set(attacker.publicKey.toBytes(), tOff);
    const sameOwner = Keypair.generate().publicKey;
    await env.chain.setAccount(sameOwner, { owner: CHIP_CORE_ID, data: forged, lamports: real.lamports });
    const foreignOwner = Keypair.generate().publicKey;
    await env.chain.setAccount(foreignOwner, { owner: SYSTEM_PROGRAM_ID, data: forged, lamports: real.lamports });
    const otherType = ledgerPda(0)[0]; // a live chip_core account of a different type

    const cases: [string, PublicKey, keyof typeof ANCHOR][] = [
      ['non-canonical copy', sameOwner, 'ConstraintSeeds'],
      ['system-owned copy', foreignOwner, 'AccountOwnedByWrongProgram'],
      ['VaultLedger as GameConfig', otherType, 'AccountDiscriminatorMismatch'],
    ];
    for (const [label, key, code] of cases) {
      const { init, buy } = await usdcBuy(env, buyer.publicKey);
      await expectFail(env.chain.send([init, swapKey(buy, config, key)], { signers: [buyer] }), Err.anchor(code, CHIP_CORE_ID.toBase58()), label);
    }
    // a foreign ledger shard (wrong seeds for this buyer) is refused as well
    const mine = ledgerShardOf(buyer.publicKey);
    const { init, buy } = await usdcBuy(env, buyer.publicKey);
    await expectFail(env.chain.send([init, swapKey(buy, ledgerPda(mine)[0], ledgerPda((mine + 1) % LEDGER_SHARDS)[0])], { signers: [buyer] }), Err.anchor('ConstraintSeeds', CHIP_CORE_ID.toBase58()), 'foreign ledger shard');
  });

  // ------------------------------------------------------------------ E28 rent / refund theft
  it('E28 stale-pack refund theft: a stranger cannot cancel someone else\'s pending pack (seeds / has_one / signer); the owner can', async () => {
    if (litesvmOnly) return; // needs warpSlots
    const victim = await env.player({ usdc: 100_000_000n });
    const thief = await env.player({ sol: 2n * SOL, usdc: 1n });
    const b = await usdcBuy(env, victim.publicKey);
    await env.chain.send([b.init, b.buy], { signers: [victim], label: 'victim buys' });
    const pending = pendingPackPda(victim.publicKey, b.nonce)[0];
    await env.chain.warpSlots(STALE_PACK_SLOTS + 10n); // the only remaining obstacle is identity
    const usdc0 = await tokenBalance(env.chain, env.mints.usdc, thief.publicKey);

    // 1) thief signs as `buyer` and points at the victim's pending PDA (refund to the thief's ATA)
    const asThief = swapKey(cancelStalePackIx({ buyer: thief.publicKey, nonce: b.nonce, randomness: b.randomness, paidMint: env.mints.usdc }), pendingPackPda(thief.publicKey, b.nonce)[0], pending);
    const f1 = await expectAnyFail(env.chain.send([asThief], { signers: [thief] }), 'thief as buyer');
    expect([ANCHOR.ConstraintSeeds, Err.chip('Unauthorized').code]).toContain(f1.code);
    // 2) thief names the victim as buyer without the victim's signature
    const unsigned = swapKey(cancelStalePackIx({ buyer: victim.publicKey, nonce: b.nonce, randomness: b.randomness, paidMint: env.mints.usdc }), victim.publicKey, victim.publicKey, { isSigner: false });
    await expectFail(env.chain.send([unsigned], { signers: [thief] }), Err.anchor('AccountNotSigner', CHIP_CORE_ID.toBase58()), 'victim not signing');
    expect(await tokenBalance(env.chain, env.mints.usdc, thief.publicKey)).toBe(usdc0);
    expect(await env.chain.getAccount(pending)).not.toBeNull();

    // control: the victim gets the full refund and the rent back
    const v0 = await tokenBalance(env.chain, env.mints.usdc, victim.publicKey);
    await env.chain.send([cancelStalePackIx({ buyer: victim.publicKey, nonce: b.nonce, randomness: b.randomness, paidMint: env.mints.usdc })], { signers: [victim], label: 'victim cancels' });
    expect((await tokenBalance(env.chain, env.mints.usdc, victim.publicKey)) - v0).toBe(USDC_STANDARD);
    expect(await env.chain.getAccount(pending)).toBeNull();
  });

  // ------------------------------------------------------------------ E28 / SEC-F8
  it('SEC-F8 lamport-donation grief: SOL sent to the closed pending PDA no longer pins the owner\'s Switchboard rent; close_randomness still refunds the owner', async () => {
    if (litesvmOnly) return; // needs warpSlots
    const victim = await env.player({ usdc: 100_000_000n });
    const griefer = await env.player({ sol: 2n * SOL });
    const b = await usdcBuy(env, victim.publicKey);
    await env.chain.send([b.init, b.buy], { signers: [victim], label: 'victim buys' });
    const pending = pendingPackPda(victim.publicKey, b.nonce)[0];
    await env.chain.warpSlots(STALE_PACK_SLOTS + 10n);
    await env.chain.send([cancelStalePackIx({ buyer: victim.publicKey, nonce: b.nonce, randomness: b.randomness, paidMint: env.mints.usdc })], { signers: [victim], label: 'victim cancels' });
    expect(await env.chain.getAccount(pending)).toBeNull();

    // the grief: park rent-exempt SOL on the now-empty PDA address (system-owned, no data)
    const donation = await env.chain.rentExempt(0);
    await env.chain.send([SystemProgram.transfer({ fromPubkey: griefer.publicKey, toPubkey: pending, lamports: donation })], { signers: [griefer], label: 'griefer donates' });
    const parked = await env.chain.getAccount(pending);
    expect(parked).not.toBeNull();
    expect(parked!.data.length).toBe(0);
    expect(parked!.owner.equals(SYSTEM_PROGRAM_ID)).toBe(true);

    // before the fix this was InvalidChipState forever (lamports() == 0); now the rent comes back
    await revealPack(env, { randomness: b.randomness });
    const lutSlot = (await randomnessAccount(env.chain, b.randomness))!.lutSlot;
    const v0 = await env.chain.balance(victim.publicKey);
    await env.chain.send([closeRandomnessIx({ ...rngAccounts(RNG_KIND.PACK, victim.publicKey, b.nonce), payer: griefer.publicKey, lutSlot })], { signers: [griefer], label: 'close randomness' });
    expect(await env.chain.getAccount(b.randomness)).toBeNull();
    expect((await env.chain.balance(victim.publicKey)) - v0).toBe(await env.chain.rentExempt(480));
  });

  // ------------------------------------------------------------------ C16 sweep conservation
  it('C16 sweep_vault conservation: a payment parked in a second vault-owned token account never lets the admin sweep liabilities', async () => {
    const buyer = await env.player({ usdc: 100_000_000n });
    const vault = vaultKey();
    const side = Keypair.generate();
    await env.chain.send([
      SystemProgram.createAccount({ fromPubkey: buyer.publicKey, newAccountPubkey: side.publicKey, lamports: Number(await env.chain.rentExempt(ACCOUNT_SIZE)), space: ACCOUNT_SIZE, programId: TOKEN_PROGRAM_ID }),
      createInitializeAccount3Instruction(side.publicKey, env.mints.usdc, vault),
    ], { signers: [buyer, side], label: 'side vault token account' });
    const vaultUsdc = ataOf(env.mints.usdc, vault);
    const b = await usdcBuy(env, buyer.publicKey);
    await env.chain.send([b.init, swapKey(b.buy, vaultUsdc, side.publicKey)], { signers: [buyer], label: 'pay into the side account' });
    expect(await rawTokenAmount(env, side.publicKey)).toBe(USDC_STANDARD);

    const treasuryUsdc = ataOf(env.mints.usdc, TREASURY.publicKey);
    await env.chain.send([createAssociatedTokenAccountIdempotentInstruction(env.admin.publicKey, treasuryUsdc, TREASURY.publicKey, env.mints.usdc)], { signers: [env.admin], label: 'treasury USDC ATA' });
    const t0 = await rawTokenAmount(env, treasuryUsdc);
    const held0 = (await tokenBalance(env.chain, env.mints.usdc, vault)) + (await rawTokenAmount(env, side.publicKey));
    const sweepAta = sweepVaultIx({ admin: env.admin.publicKey, treasury: TREASURY.publicKey, mint: env.mints.usdc });
    await env.chain.send([sweepAta], { signers: [env.admin], label: 'sweep vault ATA' });
    await env.chain.send([swapKey(sweepAta, vaultUsdc, side.publicKey)], { signers: [env.admin], label: 'sweep side account' });
    const liab = (await env.ledger()).liabUsdc;
    const held = (await tokenBalance(env.chain, env.mints.usdc, vault)) + (await rawTokenAmount(env, side.publicKey));
    expect(held).toBeGreaterThanOrEqual(liab);
    // whatever left the vault went to the pinned treasury, and never more than the surplus
    expect((await rawTokenAmount(env, treasuryUsdc)) - t0).toBe(held0 - held);
    expect(held0 - held).toBeLessThanOrEqual(held0 > liab ? held0 - liab : 0n);
  });

  // ------------------------------------------------------------------ C16 market treasury / buyback / seller
  it('C16 market settlement: attacker-supplied treasury / buyback / seller → InvalidTreasury / InvalidBuyback / ConstraintAddress; the honest settlement succeeds', async () => {
    const seller = await env.player({ sol: 5n * SOL });
    const buyer = await env.player({ sol: 10n * SOL });
    const attacker = Keypair.generate().publicKey;
    const claim = (await stageClaim(env, seller.publicKey, 80_101n, 0, 1)).claim;
    await env.chain.send([listCompressedIx({ seller: seller.publicKey, claim, price: 1n * SOL, currency: MarketCurrency.SOL })], { signers: [seller] });
    const honest = { buyer: buyer.publicKey, claim, seller: seller.publicKey, treasury: TREASURY.publicKey, buyback: BUYBACK.publicKey, expectedPrice: 1n * SOL };
    await expectFail(env.chain.send([buyCompressedSolIx({ ...honest, treasury: attacker })], { signers: [buyer] }), Err.market('InvalidTreasury'), 'treasury → attacker');
    await expectFail(env.chain.send([buyCompressedSolIx({ ...honest, buyback: attacker })], { signers: [buyer] }), Err.market('InvalidBuyback'), 'buyback → attacker');
    await expectFail(env.chain.send([buyCompressedSolIx({ ...honest, seller: attacker })], { signers: [buyer] }), Err.anchor('ConstraintAddress'), 'seller → attacker');
    expect((await claimOf(env, claim)).buyer.equals(seller.publicKey)).toBe(true);
    await env.chain.send([buyCompressedSolIx(honest)], { signers: [buyer], label: 'honest settlement' });
    expect((await claimOf(env, claim)).buyer.equals(buyer.publicKey)).toBe(true);
  });

  // ------------------------------------------------------------------ C17 front-running / SEC-F5
  it('SEC-F5 (C17) seller front-run: cancel + relist ×3 in one tx ahead of the buyer → ListingPriceChanged; the buyer pays nothing and can re-quote', async () => {
    const seller = await env.player({ sol: 5n * SOL });
    const buyer = await env.player({ sol: 10n * SOL });
    const claim = (await stageClaim(env, seller.publicKey, 80_151n, 0, 2)).claim;
    await env.chain.send([listCompressedIx({ seller: seller.publicKey, claim, price: 1n * SOL, currency: MarketCurrency.SOL })], { signers: [seller], label: 'list at 1 SOL' });
    // the buyer signs for the 1 SOL they saw …
    const quoted = buyCompressedSolIx({ buyer: buyer.publicKey, claim, seller: seller.publicKey, treasury: TREASURY.publicKey, buyback: BUYBACK.publicKey, expectedPrice: 1n * SOL });
    // … the seller lands first: cancel + relist at 3 SOL atomically (same claim, same listing PDA)
    await env.chain.send([
      cancelCompressedIx({ seller: seller.publicKey, claim }),
      listCompressedIx({ seller: seller.publicKey, claim, price: 3n * SOL, currency: MarketCurrency.SOL }),
    ], { signers: [seller], label: 'front-run relist at 3 SOL' });
    const b0 = await env.chain.balance(buyer.publicKey);
    await expectFail(env.chain.send([quoted], { signers: [buyer] }), Err.market('ListingPriceChanged'), 'stale quote');
    expect(b0 - (await env.chain.balance(buyer.publicKey))).toBeLessThanOrEqual(10_000n); // tx fee only
    expect((await claimOf(env, claim)).buyer.equals(seller.publicKey)).toBe(true);
    // an explicit re-quote at the new price settles
    await env.chain.send([buyCompressedSolIx({ buyer: buyer.publicKey, claim, seller: seller.publicKey, treasury: TREASURY.publicKey, buyback: BUYBACK.publicKey, expectedPrice: 3n * SOL })], { signers: [buyer], label: 're-quoted buy' });
    expect((await claimOf(env, claim)).buyer.equals(buyer.publicKey)).toBe(true);
  });

  // ------------------------------------------------------------------ C20 admin-only minting, A6 re-init
  it('C20 stage_compressed_chip (admin mints any rarity) is admin-only and now leaves a CompressedChipStaged audit event', async () => {
    const stranger = await env.player({ sol: 2n * SOL });
    const expiresAt = (await env.chain.now()) + 86_400n;
    const forged = stageCompressedChipIx({ admin: stranger.publicKey, buyer: stranger.publicKey, collectionIdx: 0, claimNonce: 80_201n, rarity: 7, level: 1, gameIndex: 1n, expiresAt });
    await expectFail(env.chain.send([forged], { signers: [stranger] }), Err.chip('Unauthorized'), 'stranger stages a Diamond');
    expect(await env.chain.getAccount(compressedMintClaimPda(stranger.publicKey, 80_201n)[0])).toBeNull();

    const { claim, logs } = await stageClaim(env, stranger.publicKey, 80_202n, 3, 1);
    const ev = findEvent(logs, 'CompressedChipStaged', (r) => ({ admin: r.pubkey(), buyer: r.pubkey(), claim: r.pubkey(), collectionIdx: r.u8(), rarity: r.u8(), level: r.u8(), gameIndex: r.u64(), expiresAt: r.i64() }));
    expect(ev, 'CompressedChipStaged event').toBeDefined();
    expect(ev!.admin.equals(env.admin.publicKey)).toBe(true);
    expect(ev!.buyer.equals(stranger.publicKey)).toBe(true);
    expect(ev!.claim.equals(claim)).toBe(true);
    expect([ev!.collectionIdx, ev!.rarity, ev!.level, ev!.gameIndex]).toEqual([1, 3, 1, 80_202n]);
  });

  it('A6 re-initialisation: a second `initialize` by an attacker fails and the config (admin, treasury) is unchanged', async () => {
    const attacker = await env.player({ sol: 2n * SOL });
    const [config] = configPda();
    const before = Buffer.from((await env.chain.getAccount(config))!.data);
    const evil = attacker.publicKey;
    await expectAnyFail(env.chain.send([initializeIx({ admin: evil, treasury: evil, buyback: evil, cg: env.mints.cg, usdc: env.mints.usdc, skr: env.mints.skr, pythSol: env.pyth.sol.account, pythSkr: env.pyth.skr.account })], { signers: [attacker] }), 're-initialize');
    const after = Buffer.from((await env.chain.getAccount(config))!.data);
    expect(after.equals(before)).toBe(true);
    expect(decodeGameConfig(after).admin.equals(env.admin.publicKey)).toBe(true);
  });
});
