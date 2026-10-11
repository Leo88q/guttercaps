import { PublicKey } from '@solana/web3.js';
import { DasClient } from '@/chain/das';
import { rpcEndpoints } from '@/app/rpcEndpoints';
import { useUiStore } from '@/app/store/ui';
import { type ResolvedCompressedChip } from '@/chain/flows/compressedChip';
import { buyCompressedAssetIx } from '@/chain/ix/market';

/** The indexer endpoint the DAS client talks to. Overridable so tests can pin it. */
export const dasEndpoint = (override?: string) => override ?? rpcEndpoints(useUiStore.getState().rpcOverride).das;

/** A DAS client for one call. Stateless, so it is cheaper to build than to memoize wrongly. */
export const dasClient = (override?: string) => new DasClient({ endpoint: dasEndpoint(override) });

/**
 * SEC-B28: the claim market — both the pre-mint claim listing and the V2 asset listing — settles by
 * lamport transfers. `buy_compressed_asset` has no SPL legs, so a listing in USDC or SKR can never be
 * bought. The program refuses it at list time; this refuses it before the wallet pays a fee.
 */
const CLAIM_MARKET_SOL_ONLY = 'the market settles in SOL only — list and buy in SOL';

/**
 * The buy path for a registered V2 leaf. No ATA preparation is needed — there is no SPL leg.
 *
 * The listing's currency is checked here rather than trusted: an old USDC/SKR row would otherwise
 * reach a program that has no way to pay it.
 */
export function listingBuyIxs(a: {
  buyer: PublicKey;
  seller: PublicKey;
  asset: PublicKey;
  resolved: ResolvedCompressedChip;
  treasury: PublicKey;
  buyback: PublicKey;
  expectedPrice: bigint;
  /** the currency the listing row claims, so a legacy row is refused instead of silently bought in SOL */
  listingCurrency?: number;
}): ReturnType<typeof buyCompressedAssetIx>[] {
  if (a.listingCurrency !== undefined && a.listingCurrency !== 0) throw new Error(CLAIM_MARKET_SOL_ONLY);
  return [buyCompressedAssetIx({
    buyer: a.buyer, asset: a.asset, claim: a.resolved.claim, seller: a.seller,
    proof: a.resolved.proof, delegate: a.resolved.delegate, treeConfig: a.resolved.treeConfig,
    merkleTree: a.resolved.merkleTree, coreCollection: a.resolved.coreCollection,
    treasury: a.treasury, buyback: a.buyback, expectedPrice: a.expectedPrice,
  })];
}
