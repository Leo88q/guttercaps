// T-L-F — compressed fusion: Bubblegum V2 claims are the only material
// representation. No test in this suite creates or opens an MPL-Core asset.
import { beforeAll, describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { FUSION_RECIPES } from '@guttercaps/economy';
import { findEvent } from '@/chain/anchor';
import { decodeCompressedMintClaim, readClaimFusionCommitted } from '@/chain/accounts';
import { closeExpiredClaimIx, fuseCompressedClaimsIx, stageCompressedChipIx } from '@/chain/ix/chipCore';
import { compressedMintClaimPda } from '@/chain/pdas';
import { Err, expectFail } from './helpers/expect';
import { binariesPresent, getEnv, tokenBalance, type Env } from './helpers/env';
import {
  Currency, SKU, buyPack, cancelStaleClaimFusion, commitClaimFusion, loadPendingClaimFusion,
  mineFusionValue, revealAndOpenCompressedAll, revealClaimFusion, valueOf,
} from './helpers/flows';
import { RNG_KIND, closeRandomnessIx, randomnessAccount, revealIx, rngAccounts } from './helpers/sbmock';

const bins = binariesPresent();
const suite = describe.skipIf(!bins.ok && !process.env.LOCALNET_RPC);
const STALE = 10_800n; // STALE_PACK_SLOTS
const DAY = 86_400n;

async function stageClaim(env: Env, owner: Keypair, nonce: bigint, rarity: number, collectionIdx: number): Promise<PublicKey> {
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
  ], { signers: [env.admin], label: `stage compressed fusion material ${nonce}` });
  return claim;
}

suite('T-L-F compressed fusion', () => {
  let env: Env;
  beforeAll(async () => { env = await getEnv(); });

  it('fuses three claim-bound Common chips into a new V2 claim and burns the fee', async () => {
    const owner = await env.player({ cg: 100_000_000n });
    const materials = await Promise.all([
      stageClaim(env, owner, 50_001n, 0, 0),
      stageClaim(env, owner, 50_002n, 0, 2),
      stageClaim(env, owner, 50_003n, 0, 4),
    ]);
    const resultNonce = 50_004n;
    const result = compressedMintClaimPda(owner.publicKey, resultNonce)[0];
    const cgBefore = await tokenBalance(env.chain, env.mints.cg, owner.publicKey);
    const burnedBefore = (await env.ledger()).burnedTotal;

    await env.chain.send([
      fuseCompressedClaimsIx({
        owner: owner.publicKey,
        resultClaimNonce: resultNonce,
        resultCollectionIdx: 2,
        cgMint: env.mints.cg,
        materialClaims: materials,
      }),
    ], { signers: [owner], label: 'fuse compressed claims' });

    const claim = decodeCompressedMintClaim((await env.chain.getAccount(result))!.data);
    expect(claim.buyer.equals(owner.publicKey)).toBe(true);
    expect(claim.collectionIdx).toBe(2);
    expect(claim.rarity).toBe(1);
    expect(claim.level).toBe(1);
    expect(claim.settlement.equals(PublicKey.default)).toBe(true);
    expect(claim.indexReserved).toBe(false);
    expect(claim.minted).toBe(false);
    expect(claim.consumed).toBe(false);
    expect(cgBefore - (await tokenBalance(env.chain, env.mints.cg, owner.publicKey))).toBe(5_000_000n);
    expect((await env.ledger()).burnedTotal - burnedBefore).toBe(5_000_000n);
    for (const material of materials) {
      expect(decodeCompressedMintClaim((await env.chain.getAccount(material))!.data).consumed).toBe(true);
    }

    // A consumed claim cannot be used a second time, even if the caller still
    // has the original DAS/claim transport record.
    await expectFail(env.chain.send([
      fuseCompressedClaimsIx({ owner: owner.publicKey, resultClaimNonce: 50_005n, resultCollectionIdx: 2, cgMint: env.mints.cg, materialClaims: materials }),
    ], { signers: [owner] }), Err.chip('InvalidChipState'), 'consumed compressed material');
  });

  it('enforces rarity and same-collection rules before charging compressed fusion', async () => {
    const owner = await env.player({ cg: 100_000_000n });
    const mixed = await Promise.all([
      stageClaim(env, owner, 51_001n, 0, 0),
      stageClaim(env, owner, 51_002n, 1, 0),
      stageClaim(env, owner, 51_003n, 0, 0),
    ]);
    await expectFail(env.chain.send([
      fuseCompressedClaimsIx({ owner: owner.publicKey, resultClaimNonce: 51_004n, resultCollectionIdx: 0, cgMint: env.mints.cg, materialClaims: mixed }),
    ], { signers: [owner] }), Err.chip('MaterialRarityMismatch'), 'mixed compressed rarities');

    const same = await Promise.all([
      stageClaim(env, owner, 51_101n, 1, 3),
      stageClaim(env, owner, 51_102n, 1, 3),
      stageClaim(env, owner, 51_103n, 1, 3),
    ]);
    await expectFail(env.chain.send([
      fuseCompressedClaimsIx({ owner: owner.publicKey, resultClaimNonce: 51_104n, resultCollectionIdx: 4, cgMint: env.mints.cg, materialClaims: same }),
    ], { signers: [owner] }), Err.chip('MaterialCollectionMismatch'), 'wrong compressed result collection');

  });

  it('H3 commit → reveal success (recipe 4): fee escrowed then burned once, settlement-free result with a 6 h lock, kind-3 rent reclaimed', async () => {
    const owner = await env.player({ cg: 1_000_000_000n });
    const mats = await Promise.all([
      stageClaim(env, owner, 52_001n, 4, 0),
      stageClaim(env, owner, 52_002n, 4, 2),
      stageClaim(env, owner, 52_003n, 4, 4),
    ]);
    const fee = BigInt(FUSION_RECIPES[4].feeCgMicro);
    const cgBefore = await tokenBalance(env.chain, env.mints.cg, owner.publicKey);
    const burnedBefore = (await env.ledger()).burnedTotal;

    const c = await commitClaimFusion(env, owner, { materials: mats, resultCollectionIdx: 2 });
    const pending = (await loadPendingClaimFusion(env.chain, c.pending))!;
    expect(pending.owner.equals(owner.publicKey)).toBe(true);
    expect(pending.nonce).toBe(c.nonce);
    expect(pending.recipe).toBe(4);
    expect(pending.boosted).toBe(false);
    expect(pending.feeEscrowed).toBe(fee);
    expect(pending.materials.map((m) => m.toBase58())).toEqual(mats.map((m) => m.toBase58()));
    expect(cgBefore - (await tokenBalance(env.chain, env.mints.cg, owner.publicKey))).toBe(fee); // escrowed, not burned yet
    expect((await env.ledger()).burnedTotal - burnedBefore).toBe(0n);
    for (const m of mats) expect(decodeCompressedMintClaim((await env.chain.getAccount(m))!.data).consumed).toBe(true);
    const committed = findEvent(c.tx.logs, 'ClaimFusionCommitted', readClaimFusionCommitted)!;
    expect(committed.nonce).toBe(c.nonce);
    expect(committed.recipe).toBe(4);

    // randomness cannot close while the fusion is pending (same pin rule as packs, C20)
    const rng = rngAccounts(RNG_KIND.CLAIM_FUSION, owner.publicKey, c.nonce);
    const lut = (await randomnessAccount(env.chain, c.randomness))!.lutSlot;
    await expectFail(
      env.chain.send([closeRandomnessIx({ ...rng, payer: env.admin.publicKey, lutSlot: lut })], { signers: [env.admin] }),
      Err.chip('InvalidChipState'), 'close kind-3 randomness while pending',
    );

    const { value, roll } = mineFusionValue('H3-success', 4, true);
    const r = await revealClaimFusion(env, owner.publicKey, c, mats, value);
    expect(r.event.success).toBe(true);
    expect(r.event.rollBps).toBe(roll);
    expect(r.event.thresholdBps).toBe(FUSION_RECIPES[4].successBps);
    expect(r.event.feeBurned).toBe(fee);
    const resultKey = compressedMintClaimPda(owner.publicKey, c.nonce)[0];
    expect(r.event.resultClaim.equals(resultKey)).toBe(true);

    const now = await env.chain.now();
    const result = decodeCompressedMintClaim((await env.chain.getAccount(resultKey))!.data);
    expect(result.buyer.equals(owner.publicKey)).toBe(true);
    expect(result.collectionIdx).toBe(2);
    expect(result.rarity).toBe(5);
    expect(result.level).toBe(1);
    expect(result.settlement.equals(PublicKey.default)).toBe(true);
    expect(result.consumed).toBe(false);
    expect(result.minted).toBe(false);
    expect(result.lockUntil).toBeGreaterThanOrEqual(now + 6n * 3600n - 120n);
    expect(result.lockUntil).toBeLessThanOrEqual(now + 6n * 3600n);
    expect(result.expiresAt).toBeGreaterThanOrEqual(now + 7n * DAY - 120n);

    // fee burned exactly once: escrow → burn, no second charge at reveal
    expect((await env.ledger()).burnedTotal - burnedBefore).toBe(fee);
    expect(cgBefore - (await tokenBalance(env.chain, env.mints.cg, owner.publicKey))).toBe(fee);
    expect(await loadPendingClaimFusion(env.chain, c.pending)).toBeNull();

    // permissionless close now works and pays the rent to the owner (SEC-M7)
    const ownerLamports = await env.chain.balance(owner.publicKey);
    await env.chain.send([closeRandomnessIx({ ...rng, payer: env.admin.publicKey, lutSlot: lut })], { signers: [env.admin], label: 'close kind-3 randomness' });
    expect(await env.chain.getAccount(c.randomness)).toBeNull();
    expect((await env.chain.balance(owner.publicKey)) - ownerLamports).toBeGreaterThan(0n);
  });

  it('H3 failure: default-pubkey result with no account, lowest-key survivor un-consumed and reusable, fee still burned', async () => {
    const owner = await env.player({ cg: 2_000_000_000n });
    const mats = await Promise.all([
      stageClaim(env, owner, 53_001n, 4, 1),
      stageClaim(env, owner, 53_002n, 4, 2),
      stageClaim(env, owner, 53_003n, 4, 3),
    ]);
    const fee = BigInt(FUSION_RECIPES[4].feeCgMicro);
    const burnedBefore = (await env.ledger()).burnedTotal;
    const c = await commitClaimFusion(env, owner, { materials: mats, resultCollectionIdx: 2 });

    const { value, roll } = mineFusionValue('H3-fail', 4, false);
    const r = await revealClaimFusion(env, owner.publicKey, c, mats, value);
    expect(r.event.success).toBe(false);
    expect(r.event.rollBps).toBe(roll);
    expect(r.event.resultClaim.equals(PublicKey.default)).toBe(true);
    expect(await env.chain.getAccount(compressedMintClaimPda(owner.publicKey, c.nonce)[0])).toBeNull();
    expect((await env.ledger()).burnedTotal - burnedBefore).toBe(fee); // lost rolls still burn

    // refund_on_fail = 1: the lowest claim key survives, mirrors Core fuse_reveal
    const sorted = [...mats].sort((a, b) => Buffer.compare(a.toBytes(), b.toBytes()));
    for (const m of mats) {
      expect(decodeCompressedMintClaim((await env.chain.getAccount(m))!.data).consumed, m.toBase58()).toBe(!m.equals(sorted[0]));
    }
    // the survivor fuses again with two fresh materials
    const fresh = await Promise.all([stageClaim(env, owner, 53_101n, 4, 1), stageClaim(env, owner, 53_102n, 4, 1)]);
    await commitClaimFusion(env, owner, { materials: [sorted[0], fresh[0], fresh[1]], resultCollectionIdx: 1 });
  });

  it('H3 commit gates: atomic recipes, duplicates, consumed and settlement-bound materials refused before any charge', async () => {
    const owner = await env.player({ usdc: 5_000_000_000n, cg: 1_000_000_000n });
    const cgBefore = await tokenBalance(env.chain, env.mints.cg, owner.publicKey);
    // deterministic (100 %) recipes resolve atomically — the randomized path refuses them
    const commons = await Promise.all([
      stageClaim(env, owner, 54_001n, 0, 0),
      stageClaim(env, owner, 54_002n, 0, 0),
      stageClaim(env, owner, 54_003n, 0, 0),
    ]);
    await expectFail(commitClaimFusion(env, owner, { materials: commons, resultCollectionIdx: 0 }), Err.chip('NoRecipe'), 'atomic recipe via H3');

    const mats = await Promise.all([
      stageClaim(env, owner, 54_101n, 4, 0),
      stageClaim(env, owner, 54_102n, 4, 1),
      stageClaim(env, owner, 54_103n, 4, 2),
    ]);
    await expectFail(
      commitClaimFusion(env, owner, { materials: [mats[0], mats[0], mats[1]], resultCollectionIdx: 0 }),
      Err.chip('DuplicateMaterial'), 'same claim twice',
    );
    const mixed = await stageClaim(env, owner, 54_104n, 5, 0);
    await expectFail(
      commitClaimFusion(env, owner, { materials: [mats[0], mats[1], mixed], resultCollectionIdx: 0 }),
      Err.chip('MaterialRarityMismatch'), 'mixed rarities',
    );
    // same-collection recipes pin materials AND the result (recipe 5, Legendary → Mythic)
    const legendary = await Promise.all([
      stageClaim(env, owner, 54_201n, 5, 0),
      stageClaim(env, owner, 54_202n, 5, 1),
      stageClaim(env, owner, 54_203n, 5, 0),
    ]);
    await expectFail(
      commitClaimFusion(env, owner, { materials: legendary, resultCollectionIdx: 0 }),
      Err.chip('MaterialCollectionMismatch'), 'split collections on a same-collection recipe',
    );

    // consumed shells: commit once, then the same materials are dead for a second commit
    await commitClaimFusion(env, owner, { materials: mats, resultCollectionIdx: 1 });
    await expectFail(
      commitClaimFusion(env, owner, { materials: mats, resultCollectionIdx: 1 }),
      Err.chip('InvalidChipState'), 'consumed materials',
    );
    // H3 mirror of X11 (SEC-G03): a pack claim bound to an open settlement is not fusion material
    const b = await buyPack(env, owner, { sku: SKU.STANDARD, qty: 1, currency: Currency.USDC });
    const [opened] = await revealAndOpenCompressedAll(env, owner, b, valueOf('H3-gates'));
    const packClaim = compressedMintClaimPda(owner.publicKey, opened.event.claimNonces[0])[0];
    await expectFail(
      commitClaimFusion(env, owner, { materials: [packClaim, mats[0], mats[1]], resultCollectionIdx: 1 }),
      Err.chip('InvalidChipState'), 'settlement-bound pack claim',
    );
    // every refusal happened before the fee transfer
    expect(cgBefore - (await tokenBalance(env.chain, env.mints.cg, owner.publicKey))).toBe(BigInt(FUSION_RECIPES[4].feeCgMicro));
  });

  it('H3 stale: cancel before the window → NotStale; past it the fee refunds 100 % and materials un-consume; revealed randomness cannot cancel', async () => {
    if (!env.chain.canWarp) return;
    const owner = await env.player({ cg: 1_000_000_000n });
    const fee = BigInt(FUSION_RECIPES[4].feeCgMicro);
    const mats = await Promise.all([
      stageClaim(env, owner, 55_001n, 4, 0),
      stageClaim(env, owner, 55_002n, 4, 0),
      stageClaim(env, owner, 55_003n, 4, 0),
    ]);
    const c = await commitClaimFusion(env, owner, { materials: mats, resultCollectionIdx: 0 });
    await expectFail(cancelStaleClaimFusion(env, owner, c, mats), Err.chip('NotStale'), 'immediately');
    await env.chain.warpSlots(STALE + 1n);
    const cgBefore = await tokenBalance(env.chain, env.mints.cg, owner.publicKey);
    await cancelStaleClaimFusion(env, owner, c, mats);
    expect((await tokenBalance(env.chain, env.mints.cg, owner.publicKey)) - cgBefore).toBe(fee);
    for (const m of mats) expect(decodeCompressedMintClaim((await env.chain.getAccount(m))!.data).consumed).toBe(false);
    expect(await loadPendingClaimFusion(env.chain, c.pending)).toBeNull();
    // clean state: the same materials commit again under a fresh nonce
    await commitClaimFusion(env, owner, { materials: mats, resultCollectionIdx: 0 });

    // a revealed (but unsettled) fusion is not refundable
    const mats2 = await Promise.all([
      stageClaim(env, owner, 55_101n, 4, 1),
      stageClaim(env, owner, 55_102n, 4, 1),
      stageClaim(env, owner, 55_103n, 4, 1),
    ]);
    const c2 = await commitClaimFusion(env, owner, { materials: mats2, resultCollectionIdx: 1 });
    await env.chain.send(
      [revealIx({ kind: RNG_KIND.CLAIM_FUSION, payer: env.admin.publicKey, randomness: c2.randomness, value: valueOf('H3-stale') })],
      { signers: [env.admin], label: 'reveal without settle' },
    );
    await env.chain.warpSlots(STALE + 1n);
    await expectFail(cancelStaleClaimFusion(env, owner, c2, mats2), Err.chip('RandomnessAlreadyRevealed'), 'cancel after reveal');
  });

  it('H3 close_expired_claim: live and consumed shells refused; an expired settlement-free shell closes and pays rent to the buyer', async () => {
    if (!env.chain.canWarp) return;
    const owner = await env.player({ cg: 1_000_000_000n });
    const live = await stageClaim(env, owner, 56_001n, 4, 1);
    const liveNonce = 56_001n;
    const shellNonce = 56_004n;
    await stageClaim(env, owner, shellNonce, 0, 0);
    const close = (claimNonce: bigint) =>
      env.chain.send([closeExpiredClaimIx({ buyer: owner.publicKey, claimNonce })], { signers: [owner] });
    await expectFail(close(liveNonce), Err.chip('InvalidChipState'), 'not expired yet');
    // consume the live shell through a real commit so the consumed gate is pinned, not just the deadline
    const coMats = await Promise.all([stageClaim(env, owner, 56_002n, 4, 1), stageClaim(env, owner, 56_003n, 4, 1)]);
    await commitClaimFusion(env, owner, { materials: [live, coMats[0], coMats[1]], resultCollectionIdx: 1 });
    await env.chain.warpSeconds(7n * DAY + 1n);
    await expectFail(close(liveNonce), Err.chip('InvalidChipState'), 'consumed shell past its deadline');

    const shellKey = compressedMintClaimPda(owner.publicKey, shellNonce)[0];
    const rent = (await env.chain.getAccount(shellKey))!.lamports;
    const before = await env.chain.balance(owner.publicKey);
    await close(shellNonce);
    expect(await env.chain.getAccount(shellKey)).toBeNull();
    const gain = (await env.chain.balance(owner.publicKey)) - before;
    expect(gain).toBeGreaterThan(0n);
    expect(gain).toBeGreaterThanOrEqual(rent - 50_000n); // rent minus the close tx fee
    expect(gain).toBeLessThanOrEqual(rent);
  });
});
