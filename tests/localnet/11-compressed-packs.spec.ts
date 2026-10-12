// Bubblegum V2 phase-2 localnet coverage: pack rolls become claim-bound
// settlement records before any asynchronous mint/DAS registration occurs.
import { beforeAll, describe, expect, it } from 'vitest';
import { PACKS } from '@guttercaps/economy';
import {
  decodeCompressedMintClaim,
  decodeCompressedPackSettlement,
} from '@/chain/accounts';
import { CHIP_CORE_ID } from '@/chain/ids';
import { finalizeCompressedPackIx, cancelCompressedClaimIx } from '@/chain/ix/chipCore';
import { compressedMintClaimPda, compressedSettlementPda, pendingPackPda, ata, vaultPda } from '@/chain/pdas';
import { Currency, SKU, buyPack, loadPending, openCompressedPack, revealPack, valueOf } from './helpers/flows';
import { binariesPresent, getEnv, type Env, setPausedIx } from './helpers/env';

const bins = binariesPresent();
const suite = describe.skipIf(!bins.ok && !process.env.LOCALNET_RPC);
if (!bins.ok && !process.env.LOCALNET_RPC) {
  console.warn(`[tests/localnet] compressed pack scenarios skipped — missing program binaries:\n  ${bins.missing.join('\n  ')}`);
}

suite('T-L-V Bubblegum V2 compressed pack settlement', () => {
  let env: Env;

  beforeAll(async () => {
    env = await getEnv();
  });

  it('rolls to claims while paused, binds every claim to one settlement, then recovers an expired purchase', async () => {
    // The expiry cleanup requires LiteSVM clock control. The validator suite
    // has no safe way to advance a real clock without sleeping for seven days.
    if (!env.chain.canWarp) return;

    const buyer = await env.player({ usdc: 1_000_000_000n });
    const purchase = await buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.USDC });

    await env.chain.send([setPausedIx(env.admin.publicKey, true)], { signers: [env.admin] });
    try {
      await revealPack(env, purchase, valueOf('compressed-pack'));
      const opened = await openCompressedPack(
        env,
        buyer.publicKey,
        purchase.nonce,
        0,
        valueOf('compressed-pack'),
        env.admin,
      );

      expect(opened.event.buyer.equals(buyer.publicKey)).toBe(true);
      expect(opened.event.nonce).toBe(purchase.nonce);
      expect(opened.event.packNo).toBe(0);
      expect(opened.event.count).toBe(PACKS.standard.chips);
      expect(opened.event.claimNonces).toHaveLength(PACKS.standard.chips);

      const pending = await loadPending(env.chain, pendingPackPda(buyer.publicKey, purchase.nonce)[0]);
      expect(pending?.opened).toBe(1);

      const settlementKey = compressedSettlementPda(buyer.publicKey, purchase.nonce)[0];
      const settlementAccount = await env.chain.getAccount(settlementKey);
      expect(settlementAccount).not.toBeNull();
      const settlement = decodeCompressedPackSettlement(settlementAccount!.data);
      expect(settlement.buyer.equals(buyer.publicKey)).toBe(true);
      expect(settlement.totalClaims).toBe(PACKS.standard.chips);
      expect(settlement.registeredClaims).toBe(0);
      expect(settlement.cancelledClaims).toBe(0);

      for (const claimNonce of opened.event.claimNonces) {
        const claimKey = compressedMintClaimPda(buyer.publicKey, claimNonce)[0];
        const claimAccount = await env.chain.getAccount(claimKey);
        expect(claimAccount).not.toBeNull();
        const claim = decodeCompressedMintClaim(claimAccount!.data);
        expect(claim.buyer.equals(buyer.publicKey)).toBe(true);
        expect(claim.settlement.equals(settlementKey)).toBe(true);
        expect(claim.minted).toBe(false);
      }
    } finally {
      // A failed compressed assertion must not poison the rest of the shared
      // worker with a paused config.
      await env.chain.send([setPausedIx(env.admin.publicKey, false)], { signers: [env.admin] });
    }

    await env.chain.warpSeconds(7n * 86_400n + 1n);
    const openedSettlement = compressedSettlementPda(buyer.publicKey, purchase.nonce)[0];
    const settlement = decodeCompressedPackSettlement((await env.chain.getAccount(openedSettlement))!.data);
    for (let i = 0; i < settlement.totalClaims; i++) {
      const claimNonce = purchase.nonce * 128n + BigInt(i);
      await env.chain.send(
        [cancelCompressedClaimIx({ buyer: buyer.publicKey, claimNonce, nonce: purchase.nonce })],
        { signers: [buyer], label: `cancel compressed claim ${i}` },
      );
    }

    await env.chain.send([
      finalizeCompressedPackIx({
        payer: env.admin.publicKey,
        buyer: buyer.publicKey,
        nonce: purchase.nonce,
        refundToken: {
          vault: ata(env.mints.usdc, vaultPda()[0]),
          buyer: ata(env.mints.usdc, buyer.publicKey),
        },
      }),
    ], { signers: [env.admin], label: 'finalize expired compressed pack' });

    expect(await loadPending(env.chain, pendingPackPda(buyer.publicKey, purchase.nonce)[0])).toBeNull();
    expect(await env.chain.getAccount(openedSettlement)).toBeNull();
    for (let i = 0; i < settlement.totalClaims; i++) {
      expect(await env.chain.getAccount(compressedMintClaimPda(buyer.publicKey, purchase.nonce * 128n + BigInt(i))[0])).toBeNull();
    }
  });

  // Anchor 3003 regression — the full history is in the note above H3b in 20-fusion.spec.ts.
  // A pack claim is the worst case for a short account: cancelling it is the ONLY way its share of
  // an expired purchase gets refunded, so a strict decode locked that value in the settlement
  // forever — while every fixture round-trip stayed green, because those use the forgiving decoder.
  it('cancels a pre-`founder` pack claim (1 byte short) — Anchor 3003 regression', async () => {
    if (!env.chain.canWarp) return;
    const buyer = await env.player({ usdc: 1_000_000_000n });
    const purchase = await buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.USDC });
    await revealPack(env, purchase, valueOf('compat-short-claim'));
    await openCompressedPack(env, buyer.publicKey, purchase.nonce, 0, valueOf('compat-short-claim'), env.admin);

    const claimNonce = purchase.nonce * 128n; // claim 0 of the pack
    const key = compressedMintClaimPda(buyer.publicKey, claimNonce)[0];
    const settlementKey = compressedSettlementPda(buyer.publicKey, purchase.nonce)[0];

    // truncate the trailing `founder` byte of the REAL account — a live pre-`founder` allocation,
    // not a hand-built fixture that could drift away from the layout it is supposed to reproduce
    const full = (await env.chain.getAccount(key))!;
    await env.chain.setAccount(key, {
      owner: CHIP_CORE_ID,
      data: Uint8Array.from(full.data.subarray(0, full.data.length - 1)),
      lamports: full.lamports,
    });
    const short = (await env.chain.getAccount(key))!;
    expect(short.data.length).toBe(full.data.length - 1);
    const decoded = decodeCompressedMintClaim(short.data);
    expect(decoded.founder).toBe(false); // the missing byte, defaulted by the forgiving reader
    expect(decoded.minted).toBe(false);
    expect(decoded.settlement.equals(settlementKey)).toBe(true);

    await env.chain.warpSeconds(7n * 86_400n + 1n);
    await env.chain.send(
      [cancelCompressedClaimIx({ buyer: buyer.publicKey, claimNonce, nonce: purchase.nonce })],
      { signers: [buyer], label: 'cancel a pre-founder (1-byte-short) claim' },
    );
    // cancelled, not 3003: the claim is gone and its share is counted in the settlement
    expect(await env.chain.getAccount(key)).toBeNull();
    const settlement = decodeCompressedPackSettlement((await env.chain.getAccount(settlementKey))!.data);
    expect(settlement.cancelledClaims).toBe(1);
    // one short account must not disturb the rest of the pack
    expect(await env.chain.getAccount(compressedMintClaimPda(buyer.publicKey, purchase.nonce * 128n + 1n)[0])).not.toBeNull();
  });
});
