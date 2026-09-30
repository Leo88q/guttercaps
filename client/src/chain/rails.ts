// Which payment rails this build can actually settle — and, when one is off, *why*.
//
// This gate used to be written out verbatim in two places (Shop.tsx and Services.tsx) and it was
// wrong in both. It looked for the SKR mint in only two of the three sources that can name one:
// VITE_SKR_MINT, the on-chain GameConfig, and the mock universe. `useGameConfig` is declared
// `enabled: !isMock()`, so in demo/E2E the second source never resolves; with no `.env` the first
// is empty too; and the third was never consulted. The result was that SKR vanished from packs
// *and* cosmetics with no placeholder, no note, nothing — the shop simply rendered fewer options
// than it had, and a player with SKR in their wallet had no way to know the rail existed.
//
// One implementation, and a reason for every rail that is off, so the shop can say why instead of
// quietly dropping a line. The reason is a MessageKey: the UI must not invent its own English.
import { PublicKey } from '@solana/web3.js';
import { FEES } from '@guttercaps/economy';
import { isMock } from '@/api/client';
import { MINTS } from '@/app/config';
import { useGameConfig } from './hooks';

export interface PaymentRails {
  /** SKR can be settled on this build/cluster. */
  skr: boolean;
  /** The Seeker discount to advertise, in bps. Applies only when `skr` is true. */
  skrDiscountBps: number;
  /** Why SKR is absent. `undefined` when `skr` is true. */
  skrWhy?: 'shop.skrNoMint';
}

export function usePaymentRails(): PaymentRails {
  const cfg = useGameConfig();
  // Three sources, all of them real: the deployment's env, the on-chain config (the authority — an
  // unset mint there is an admin decision, not an oversight), and the mock universe, which ships a
  // SKR mint *and* a SKR/USD price on purpose. Ignoring the third is what broke the demo build.
  const skr = isMock() || !!MINTS.skr || (cfg.data ? !cfg.data.skrMint.equals(PublicKey.default) : false);
  const skrDiscountBps = cfg.data?.skrDiscountBps ?? FEES.skrPackDiscountBps;
  return skr ? { skr, skrDiscountBps } : { skr, skrDiscountBps, skrWhy: 'shop.skrNoMint' };
}
