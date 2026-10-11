// Scenario building blocks on top of the REAL client builders (client/src/chain/ix/*):
// buy a pack, reveal through the mock, open every pack of a bundle, fuse, etc. Each helper
// returns what the specs assert on (accounts, events, balances) and nothing is cached across
// calls, so scenarios stay independent.
import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import { FUSION_RECIPES, PACKS, expandRandomness, skrMicroForUsdCents, solLamportsForUsdCents, uniformBps } from '@guttercaps/economy';
import { findEvent } from '@/chain/anchor';
import { decodePendingPack, decodePlayerPity, readPackOpened, readCompressedClaimsCreated, readClaimFusionRevealed, decodeChipState, decodeCompressedMintClaim, decodePendingClaimFusion, type PackOpenedEvent, type CompressedClaimsCreatedEvent, type ClaimFusionRevealedEvent, type PendingPack, type PendingClaimFusion, type ChipState, type CompressedMintClaim } from '@/chain/accounts';
import { Currency, buyPackIx, openPackIx, openCompressedPackIx, cancelStalePackIx, stageCompressedChipIx, fuseClaimsCommitIx, fuseClaimsRevealIx, cancelStaleClaimFusionIx, type CurrencyCode } from '@/chain/ix/chipCore';
import { initRandomnessIx, rngAccounts } from '@/chain/ix/rng';
import { createAtaIdempotentIx } from '@/chain/ix/spl';
import { RNG_KIND, assetPda, chipStatePda, claimFusionPda, compressedMintClaimPda, pendingPackPda, pityPda, vaultPda } from '@/chain/pdas';
import { packSeed, toEconPack, voucherEconPack } from '@/chain/flows/packFlow';
import type { Chain, TxResult } from './chain';
import { SB_ORACLE, SB_QUEUE, type Env } from './env';
import { revealIx, valueOf } from './sbmock';

export const SKU = { STARTER: 0, STANDARD: 1, PREMIUM: 2, LIMITED: 3 } as const;
export { Currency };

let nonceCounter = 1_000n;
export const nextNonce = () => ++nonceCounter;

export interface BuyResult { nonce: bigint; randomness: PublicKey; pending: PublicKey; tx: TxResult; paid: bigint }

/**
 * Expected units for a purchase at the fixture prices — the program's own math: the bundle / SKR
 * discount applies to the USD cents first, then the frozen checkout FX converts them
 * (SOL = $110, SKR = $0.016, USDC = $1; packages/economy `fx.ts` ↔ chip_core `economy::fx_*`).
 */
export function quoteUnits(env: Env, sku: number, qty: number, currency: CurrencyCode): bigint {
  const def = env.config.packs[sku];
  const bundle = qty >= 25 ? 1800 : qty >= 10 ? 1200 : qty >= 5 ? 700 : 0;
  let discount = sku === SKU.LIMITED || sku === SKU.STARTER ? 0 : bundle;
  if (currency === Currency.SKR) discount = Math.min(discount + env.config.skrDiscountBps, 3000);
  const cents = (BigInt(def.priceUsdCents) * BigInt(qty) * BigInt(10_000 - discount)) / 10_000n;
  if (currency === Currency.SOL) return solLamportsForUsdCents(cents);
  if (currency === Currency.SKR) return skrMicroForUsdCents(cents);
  if (currency === Currency.USDC) return cents * 10_000n;
  return (def.priceCgMicro * BigInt(qty) * BigInt(10_000 - discount)) / 10_000n;
}

/**
 * `init_randomness + buy_pack` in ONE transaction (exactly what PackFlow.buy sends). Checkout is
 * frozen FX: no Pyth account is passed or read, and the SOL / SKR cap defaults to the exact price
 * (the client's `frozenCheckoutCap`, the backend quote's `maxLamports`).
 */
export async function buyPack(env: Env, buyer: Keypair, o: { sku: number; qty?: number; currency?: CurrencyCode; nonce?: bigint; maxUnits?: bigint; extraIxs?: TransactionInstruction[]; skipInit?: boolean; randomness?: PublicKey }): Promise<BuyResult> {
  const { chain } = env;
  const qty = o.qty ?? 1;
  const currency = o.currency ?? Currency.SOL;
  const nonce = o.nonce ?? nextNonce();
  const rng = rngAccounts(RNG_KIND.PACK, buyer.publicKey, nonce);
  const randomness = o.randomness ?? rng.randomness;
  const volatile = currency === Currency.SOL || currency === Currency.SKR;
  const quoted = volatile ? quoteUnits(env, o.sku, qty, currency) : 0n;
  const ixs: TransactionInstruction[] = [...(o.extraIxs ?? [])];
  if (!o.skipInit) ixs.push(initRandomnessIx({ ...rng, queue: SB_QUEUE, recentSlot: (await chain.slot()) - 1n }));
  ixs.push(buyPackIx({
    buyer: buyer.publicKey, sku: o.sku, qty, currency, nonce,
    maxLamports: volatile ? (o.maxUnits ?? quoted) : 0n,
    randomness, queue: SB_QUEUE, oracle: SB_ORACLE,
    usdcMint: env.mints.usdc, cgMint: env.mints.cg, skrMint: env.mints.skr,
  }));
  const tx = await chain.send(ixs, { signers: [buyer], label: `buy_pack sku=${o.sku} qty=${qty} cur=${currency}` });
  const pending = pendingPackPda(buyer.publicKey, nonce)[0];
  return { nonce, randomness, pending, tx, paid: volatile ? quoted : quoteUnits(env, o.sku, qty, currency) };
}

export async function loadPending(chain: Chain, key: PublicKey): Promise<PendingPack | null> {
  const a = await chain.getAccount(key);
  return a && a.data.length ? decodePendingPack(a.data) : null;
}

export async function loadPity(chain: Chain, wallet: PublicKey) {
  const a = await chain.getAccount(pityPda(wallet)[0]);
  return a ? decodePlayerPity(a.data) : null;
}

export async function loadChip(chain: Chain, asset: PublicKey): Promise<ChipState | null> {
  const a = await chain.getAccount(chipStatePda(asset)[0]);
  return a && a.data.length ? decodeChipState(a.data) : null;
}

/** Permissionless reveal of a pack randomness account with a chosen value (defaults to a label-derived one). */
export async function revealPack(env: Env, b: { randomness: PublicKey }, value: Uint8Array = valueOf('pack'), payer: Keypair = env.admin): Promise<TxResult> {
  return env.chain.send([revealIx({ kind: RNG_KIND.PACK, payer: payer.publicKey, randomness: b.randomness, value })], { signers: [payer], label: 'reveal_randomness' });
}

export interface OpenResult { tx: TxResult; event: PackOpenedEvent; rolled: { rarity: number; collectionIdx: number }[]; assets: PublicKey[] }

/**
 * Build the `open_pack` instruction for pack `packNo` — simulates `expandRandomness` off-chain
 * (with the live PackDef + pity counter) to know which collection accounts to pass, as the crank does.
 */
export async function openPackInstruction(env: Env, buyer: PublicKey, nonce: bigint, packNo: number, value: Uint8Array, payer: PublicKey, opts: { pityOverride?: number; rolledOverride?: number[] } = {}): Promise<{ ix: TransactionInstruction; rolled: { rarity: number; collectionIdx: number }[] }> {
  const { chain } = env;
  const pending = (await loadPending(chain, pendingPackPda(buyer, nonce)[0]))!;
  const cfg = await env.refreshConfig();
  const def = cfg.packs[pending.sku];
  // (#28) a quest chip voucher: 1 chip, template odds, no floor / pity, every district — same as the crank's voucherEconPack
  const econ = pending.voucher ? voucherEconPack(pending) : toEconPack(pending.sku, def);
  const pool = !pending.voucher && def.featuredOnly ? [cfg.featuredCollection] : Array.from({ length: cfg.collectionsCreated }, (_, i) => i);
  const pity = opts.pityOverride ?? (await loadPity(chain, buyer))?.counters[pending.sku] ?? 0;
  const rolls = expandRandomness(packSeed(value, pending.qty, packNo), econ, pity, pool.length);
  const rolled = rolls.map((r) => ({ rarity: r.rarity as number, collectionIdx: pool[r.collectionIdx] }));
  const rolledCollections = opts.rolledOverride ?? rolled.map((r) => r.collectionIdx);
  const ix = openPackIx({
    payer, buyer, nonce, packNo, qty: pending.qty, randomness: pending.randomness, rolledCollections, coreCollectionOf: env.coreOf,
    cg: pending.paidCg > 0n ? { cgMint: env.mints.cg, treasury: env.config.treasury } : undefined,
  });
  return { ix, rolled };
}

/** Open one pack of a purchase (value must already be revealed or persisted). */
export async function openPack(env: Env, buyer: PublicKey, nonce: bigint, packNo: number, value: Uint8Array, payer: Keypair = env.admin, opts: { pityOverride?: number; rolledOverride?: number[]; prepend?: TransactionInstruction[] } = {}): Promise<OpenResult> {
  const { ix, rolled } = await openPackInstruction(env, buyer, nonce, packNo, value, payer.publicKey, opts);
  const tx = await env.chain.send([...(opts.prepend ?? []), ix], { signers: [payer], label: `open_pack #${packNo}` });
  const event = findEvent(tx.logs, 'PackOpened', readPackOpened);
  if (!event) throw new Error(`PackOpened event missing:\n${tx.logs.join('\n')}`);
  const pending = pendingPackPda(buyer, nonce)[0];
  const assets = rolled.map((_, i) => assetPda(pending, packNo, i)[0]);
  return { tx, event, rolled, assets };
}

export interface CompressedOpenResult {
  tx: TxResult;
  event: CompressedClaimsCreatedEvent;
  rolled: { rarity: number; collectionIdx: number }[];
}

/** Build the compressed roll-to-claim instruction without sending it. The
 * collection accounts are caller-supplied transport data; the program
 * recomputes the roll and rejects a mismatched account, which is useful for
 * negative localnet coverage as well as cranker clients. */
export async function openCompressedPackInstruction(
  env: Env,
  buyer: PublicKey,
  nonce: bigint,
  packNo: number,
  value: Uint8Array,
  payer: PublicKey,
  opts: { pityOverride?: number; collectionOverride?: number[] } = {},
): Promise<{ ix: TransactionInstruction; rolled: { rarity: number; collectionIdx: number }[] }> {
  const pending = (await loadPending(env.chain, pendingPackPda(buyer, nonce)[0]))!;
  const cfg = await env.refreshConfig();
  const def = pending.voucher ? voucherEconPack(pending) : toEconPack(pending.sku, cfg.packs[pending.sku]);
  const pool = !pending.voucher && cfg.packs[pending.sku].featuredOnly
    ? [cfg.featuredCollection]
    : Array.from({ length: cfg.collectionsCreated }, (_, i) => i);
  const pity = opts.pityOverride ?? (await loadPity(env.chain, buyer))?.counters[pending.sku] ?? 0;
  const rolls = expandRandomness(packSeed(value, pending.qty, packNo), def, pity, pool.length);
  const rolled = rolls.map((r) => ({ rarity: r.rarity as number, collectionIdx: pool[r.collectionIdx] }));
  const ix = openCompressedPackIx({
    payer,
    buyer,
    nonce,
    packNo,
    chips: rolled.length,
    collectionIdx: opts.collectionOverride ?? rolled.map((r) => r.collectionIdx),
    randomness: pending.randomness,
  });
  return { ix, rolled };
}

/**
 * V2 replacement for `openPack`: resolve the deterministic roll into
 * claim-bound compressed chips without pretending that DAS has already
 * returned an asset id or proof. Bubblegum minting and registration are
 * deliberately separate follow-up transactions.
 */
export async function openCompressedPack(
  env: Env,
  buyer: PublicKey,
  nonce: bigint,
  packNo: number,
  value: Uint8Array,
  payer: Keypair = env.admin,
  opts: { pityOverride?: number; collectionOverride?: number[] } = {},
): Promise<CompressedOpenResult> {
  const { ix, rolled } = await openCompressedPackInstruction(env, buyer, nonce, packNo, value, payer.publicKey, opts);
  const tx = await env.chain.send([ix], { signers: [payer], label: `open_compressed_pack #${packNo}` });
  const event = findEvent(tx.logs, 'CompressedClaimsCreated', readCompressedClaimsCreated);
  if (!event) throw new Error(`CompressedClaimsCreated event missing:\n${tx.logs.join('\\n')}`);
  return { tx, event, rolled };
}

/** Reveal + open every pack of a purchase through the compressed claim path.
 * The purchase remains open until Bubblegum mint/registration settles each
 * claim; this helper intentionally does not finalize the settlement. */
export async function revealAndOpenCompressedAll(env: Env, buyer: Keypair, b: { nonce: bigint; randomness: PublicKey }, value: Uint8Array = valueOf('pack'), payer: Keypair = env.admin): Promise<CompressedOpenResult[]> {
  await revealPack(env, b, value, payer);
  const pending = (await loadPending(env.chain, pendingPackPda(buyer.publicKey, b.nonce)[0]))!;
  const out: CompressedOpenResult[] = [];
  for (let i = pending.opened; i < pending.qty; i++) {
    out.push(await openCompressedPack(env, buyer.publicKey, b.nonce, i, value, payer));
  }
  return out;
}

/** Reveal + open every pack of a purchase; returns one OpenResult per pack. */
export async function revealAndOpenAll(env: Env, buyer: Keypair, b: { nonce: bigint; randomness: PublicKey }, value: Uint8Array = valueOf('pack'), payer: Keypair = env.admin): Promise<OpenResult[]> {
  await revealPack(env, b, value, payer);
  const pending = (await loadPending(env.chain, pendingPackPda(buyer.publicKey, b.nonce)[0]))!;
  const out: OpenResult[] = [];
  for (let i = pending.opened; i < pending.qty; i++) {
    const prepend = i === pending.qty - 1 && pending.paidCg > 0n
      ? [createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ataOf(env.mints.cg, env.config.treasury), env.config.treasury, env.mints.cg)]
      : [];
    out.push(await openPack(env, buyer.publicKey, b.nonce, i, value, payer, { prepend }));
  }
  return out;
}

/** A wallet with freshly opened Bubblegum V2 claim accounts. The claim PDA is the
 * economic handle until the asynchronous DAS mint/registration step completes. */
/**
 * An admin-staged pack claim: `settlement == default`, no settlement to brick.
 *
 * This is the shape every scenario needs when a claim must be **listable**. Since SEC-F01
 * (`set_compressed_claim_listed`, `chip_core/src/instructions/compressed.rs`) a claim still bound to a live
 * `CompressedPackSettlement` may only trade once it is `minted && registered` — selling it earlier locks the
 * purchase liability in the vault forever (60-cross X08 pins the refusal). A pack-flow claim from
 * `mintCompressedChips` above *is* settlement-bound and therefore not listable; staged claims are exempt and
 * list/buy/stake against them exactly like the market specs do.
 */
export async function stageClaim(
  env: Env,
  owner: Keypair,
  nonce: bigint,
  rarity = 0,
  collectionIdx = 0,
): Promise<{ claim: PublicKey; claimNonce: bigint }> {
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
  ], { signers: [env.admin], label: `stage claim ${nonce}` });
  return { claim, claimNonce: nonce };
}

export async function mintCompressedChips(
  env: Env,
  owner: Keypair,
  packs = 1,
  value?: Uint8Array,
): Promise<{ claim: PublicKey; claimNonce: bigint; collectionIdx: number; rarity: number; state: CompressedMintClaim }[]> {
  const out: { claim: PublicKey; claimNonce: bigint; collectionIdx: number; rarity: number; state: CompressedMintClaim }[] = [];
  for (let p = 0; p < packs; p++) {
    const b = await buyPack(env, owner, { sku: SKU.STANDARD, qty: 1, currency: Currency.USDC });
    const [r] = await revealAndOpenCompressedAll(env, owner, b, value ?? valueOf('mintCompressedChips', Number(b.nonce)));
    for (const claimNonce of r.event.claimNonces) {
      const claim = compressedMintClaimPda(owner.publicKey, claimNonce)[0];
      const state = decodeCompressedMintClaim((await env.chain.getAccount(claim))!.data);
      out.push({ claim, claimNonce, collectionIdx: state.collectionIdx, rarity: state.rarity, state });
    }
  }
  return out;
}

export function cancelStale(env: Env, buyer: Keypair, b: { nonce: bigint; randomness: PublicKey }, paidMint?: PublicKey) {
  return env.chain.send([cancelStalePackIx({ buyer: buyer.publicKey, nonce: b.nonce, randomness: b.randomness, paidMint })], { signers: [buyer], label: 'cancel_stale_pack' });
}

// ---------------------------------------------------------------------------
// H3 randomized claim fusion (fuse_claims_commit / fuse_claims_reveal)
// ---------------------------------------------------------------------------

export interface ClaimFusionCommit { nonce: bigint; randomness: PublicKey; pending: PublicKey; tx: TxResult }

/**
 * `init_randomness (kind 3) + fuse_claims_commit` in ONE transaction (exactly what
 * ClaimFusionFlow.fuse sends). The nonce doubles as the result claim nonce at reveal, so it must
 * not collide with a live claim PDA of the owner — `nextNonce()` (~1xxx) never overlaps staged
 * (50_0xx+) or pack-claim (`purchase * 128 + …`) nonces.
 */
export async function commitClaimFusion(env: Env, owner: Keypair, o: { materials: PublicKey[]; resultCollectionIdx: number; useBooster?: boolean; nonce?: bigint }): Promise<ClaimFusionCommit> {
  const nonce = o.nonce ?? nextNonce();
  const rng = rngAccounts(RNG_KIND.CLAIM_FUSION, owner.publicKey, nonce);
  const tx = await env.chain.send([
    initRandomnessIx({ ...rng, queue: SB_QUEUE, recentSlot: (await env.chain.slot()) - 1n }),
    fuseClaimsCommitIx({
      owner: owner.publicKey, nonce, resultCollectionIdx: o.resultCollectionIdx, useBooster: o.useBooster ?? false,
      randomness: rng.randomness, queue: SB_QUEUE, oracle: SB_ORACLE, cgMint: env.mints.cg, materials: o.materials,
    }),
  ], { signers: [owner], label: `fuse_claims_commit nonce=${nonce}` });
  return { nonce, randomness: rng.randomness, pending: claimFusionPda(owner.publicKey, nonce)[0], tx };
}

export async function loadPendingClaimFusion(chain: Chain, key: PublicKey): Promise<PendingClaimFusion | null> {
  const a = await chain.getAccount(key);
  return a && a.data.length ? decodePendingClaimFusion(a.data) : null;
}

/**
 * Mine a deterministic oracle value whose roll succeeds/fails `recipe`
 * (`uniformBps(value, 0)` vs `FUSION_RECIPES[recipe].successBps` — the same comparison
 * `fuse_claims_reveal` makes). Returns the value and the expected roll for the event assertion.
 */
export function mineFusionValue(label: string, recipe: number, wantSuccess: boolean): { value: Uint8Array; roll: number } {
  const threshold = FUSION_RECIPES[recipe].successBps;
  for (let salt = 0; salt < 10_000; salt++) {
    const value = valueOf(label, salt);
    const roll = uniformBps(value, 0);
    if (wantSuccess ? roll < threshold : roll >= threshold) return { value, roll };
  }
  throw new Error(`no ${wantSuccess ? 'success' : 'failure'} value for recipe ${recipe} in 10k salts`);
}

export interface ClaimFusionReveal { tx: TxResult; event: ClaimFusionRevealedEvent }

/**
 * Permissionless reveal through the mock, then `fuse_claims_reveal` as `payer` (two sends, like
 * `revealAndOpenCompressedAll`). `resultClaimNonce == commit nonce` by protocol convention.
 */
export async function revealClaimFusion(
  env: Env, owner: PublicKey, c: { nonce: bigint; randomness: PublicKey }, materials: PublicKey[], value: Uint8Array, payer: Keypair = env.admin,
): Promise<ClaimFusionReveal> {
  const pending = (await loadPendingClaimFusion(env.chain, claimFusionPda(owner, c.nonce)[0]))!;
  await env.chain.send(
    [revealIx({ kind: RNG_KIND.CLAIM_FUSION, payer: payer.publicKey, randomness: c.randomness, value })],
    { signers: [payer], label: 'reveal_randomness (kind 3)' },
  );
  const tx = await env.chain.send([
    fuseClaimsRevealIx({
      payer: payer.publicKey, owner, nonce: c.nonce, resultClaimNonce: c.nonce,
      resultCollectionIdx: pending.resultCollectionIdx, randomness: c.randomness, cgMint: env.mints.cg, materials,
    }),
  ], { signers: [payer], label: `fuse_claims_reveal nonce=${c.nonce}` });
  const event = findEvent(tx.logs, 'ClaimFusionRevealed', readClaimFusionRevealed);
  if (!event) throw new Error(`ClaimFusionRevealed event missing:\n${tx.logs.join('\n')}`);
  return { tx, event };
}

/** Refund path for an un-revealed fusion past `STALE_PACK_SLOTS` (fee back, materials un-consumed). */
export function cancelStaleClaimFusion(env: Env, owner: Keypair, c: { nonce: bigint; randomness: PublicKey }, materials: PublicKey[]) {
  return env.chain.send(
    [cancelStaleClaimFusionIx({ owner: owner.publicKey, nonce: c.nonce, randomness: c.randomness, cgMint: env.mints.cg, materials })],
    { signers: [owner], label: 'cancel_stale_claim_fusion' },
  );
}

export const vaultKey = () => vaultPda()[0];
export const ataOf = (mint: PublicKey, owner: PublicKey) => createAtaIdempotentIx(owner, owner, mint).keys[1].pubkey;
export { PACKS, RNG_KIND, valueOf };
