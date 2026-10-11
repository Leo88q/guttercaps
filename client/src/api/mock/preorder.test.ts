// The demo/e2e backend answers /preorder/intent with the same pay-to rules as backend `preorderPayTo`:
// SOL pays the treasury wallet, USDC/SKR pay the treasury's token account for that mint (and say which mint).
import { describe, expect, it } from 'vitest';
import { mockRequest } from './index';
import { usdcMicroForUsdCents, usdCentsFromSolLamports } from '@guttercaps/economy';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SKR_MINT = 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3';

const intent = (currency: 'SOL' | 'USDC' | 'SKR') =>
  mockRequest('post', '/preorder/intent', { body: { offer: 'pack', qty: 1, currency } }) as Promise<Record<string, unknown>>;

describe('mock pre-sale intent', () => {
  it('SOL pays the treasury wallet directly, with no mint', async () => {
    const r = await intent('SOL');
    expect(r.payTo).toBe(r.treasury);
    expect(r.mint).toBeUndefined();
    expect(r.amount).toBe(r.lamports);
  });

  it('USDC pays a token account that is not the SOL treasury, and names the USDC mint', async () => {
    const r = await intent('USDC');
    expect(r.payTo).not.toBe(r.treasury);
    expect(r.mint).toBe(USDC_MINT);
    // amount is the sticker converted at frozen FX, in USDC micro-units
    expect(r.amount).toBe(usdcMicroForUsdCents(usdCentsFromSolLamports(300_000_000n)).toString());
  });

  it('SKR pays its own token account and names the SKR mint', async () => {
    const r = await intent('SKR');
    expect(r.payTo).not.toBe(r.treasury);
    expect(r.payTo).not.toBe((await intent('USDC')).payTo);
    expect(r.mint).toBe(SKR_MINT);
  });
});
