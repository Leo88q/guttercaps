// Bubblegum V2 phase-2 localnet coverage: pack rolls become claim-bound
// settlement records before any asynchronous mint/DAS registration occurs.
import { beforeAll, describe, expect, it } from 'vitest';
import {
  decodeCompressedMintClaim,
  decodeCompressedPackSettlement,
} from '@/chain/accounts';
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
      expect(opened.event.count).toBe(4);
      expect(opened.event.claimNonces).toHaveLength(4);

      const pending = await loadPending(env.chain, pendingPackPda(buyer.publicKey, purchase.nonce)[0]);
      expect(pending?.opened).toBe(1);

      const settlementKey = compressedSettlementPda(buyer.publicKey, purchase.nonce)[0];
      const settlementAccount = await env.chain.getAccount(settlementKey);
      expect(settlementAccount).not.toBeNull();
      const settlement = decodeCompressedPackSettlement(settlementAccount!.data);
      expect(settlement.buyer.equals(buyer.publicKey)).toBe(true);
      expect(settlement.totalClaims).toBe(4);
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
    for (let i = 0; i < 3; i++) {
      expect(await env.chain.getAccount(compressedMintClaimPda(buyer.publicKey, purchase.nonce * 128n + BigInt(i))[0])).toBeNull();
    }
  });
});
