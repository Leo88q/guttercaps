// On-chain event → the wire frame the client already knows how to consume
// (`client/src/api/ws.ts`, whose INVALIDATE table is the real spec here).
//
// Two rules this file exists to keep:
//  1. The type names are the client's, not ours: the program emits `ChipSold`, the UI invalidates on
//     `sale`. A WS frame is a cache-invalidation hint, so it must match what the client filters on or
//     the socket silently does nothing and the app degrades to polling with nobody noticing.
//  2. Only fields the client reads are copied, plus raw amounts. Payloads travel over a socket that
//     is open to any address in the world, so this is the allowlist — never `...event.data`.
import type { Db } from './db.ts';
import type { RawEvent } from './events.ts';
import { walletsOf, type BusMessage } from './bus.ts';
// Same conversion the REST market read-model uses, so a toast can never disagree with the market page.
import { prices } from './services.ts';
import { toUsd } from './queries.ts';

/** Event name → the client's invalidation key. Anything not listed still ships under its snake_case name. */
export const WIRE_TYPE: Record<string, string> = {
  PackOpened: 'pack_opened',
  ChipFused: 'chip_fused',
  CompressedClaimsFused: 'chip_fused',
  ClaimFusionRevealed: 'chip_fused',
  ChipListed: 'listing_changed',
  OfferCancelled: 'offer',
  ListingUpdated: 'listing_changed',
  ListingCancelled: 'listing_changed',
  ChipSold: 'sale',
  // SEC-B35: the two compressed markets, on the same client vocabulary as the Core path. They used to ship
  // under their snake_case names, which no INVALIDATE entry knows: a compressed listing or sale invalidated
  // nothing, so the market page silently degraded to polling exactly the way this file's header warns about.
  // `CompressedClaimListedSet(false)` is the cancel (chip_core emits it and the market emits nothing), so it
  // maps to the listing cache too; `CompressedClaimTransferred` deliberately stays raw — it is an ownership
  // move with no money, and the client has no ownership invalidation key to route it to.
  CompressedClaimListed: 'listing_changed',
  CompressedAssetListed: 'listing_changed',
  CompressedClaimListedSet: 'listing_changed',
  CompressedClaimSold: 'sale',
  CompressedAssetSold: 'sale',
  CompressedClaimStakedSet: 'stake_changed',
  OfferMade: 'offer',
  Staked: 'stake_changed',
  Unstaked: 'stake_changed',
  Claimed: 'reward_claimed',
  RootClaimed: 'reward_claimed',
  VoucherIssued: 'quest_progress',
  BattleCreated: 'match_found',
  BattleAccepted: 'match_found',
  BattleResolved: 'match_resolved',
  BattleCancelled: 'match_resolved',
  DayClosed: 'day_closed',
  ParamsChanged: 'params_changed',
  // SEC-B22: same wire type as ParamsChanged (the client invalidates the same caches and the extra
  // payload keys carry the diff) — no new event type for a client to learn, nothing to break.
  ParamsPatched: 'params_changed',
  PauseChanged: 'params_changed',
  PauserChanged: 'params_changed',
  AdminProposed: 'params_changed',
  AdminAccepted: 'params_changed',
  ArenaConfigChanged: 'params_changed',
  OraclesChanged: 'params_changed',
  CollectionCreated: 'params_changed',
};

export const snake = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? undefined : String(v));
const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : undefined);

/**
 * The frame for one event, or null when nothing should be sent. `db` is only read for the display
 * price of a market trade (the same `oracle_prices` cache REST uses, so the toast cannot disagree
 * with the market page).
 */
export function wireEvent(db: Db, e: RawEvent, ctx: { slot?: number } = {}): BusMessage | null {
  const type = WIRE_TYPE[e.name] ?? snake(e.name);
  const d = (e.data ?? {}) as Record<string, unknown>;
  const wallets = walletsOf(d);
  // Field names below are the decoded event fields (`backend/src/events.ts` is the schema, mirrored
  // from the Rust `#[event]` structs) — not the DB column names. A payload built from the wrong one is
  // a frame that looks fine and invalidates nothing.
  let payload: Record<string, unknown> = {};
  const s_ = (k: string) => str(d[k]);
  const n_ = (k: string) => num(d[k]);
  switch (e.name) {
    case 'ChipListed':
      payload = { asset: s_('asset'), seller: s_('seller'), price: s_('price'), currency: n_('currency') ?? 0 };
      break;
    case 'ListingUpdated':
      payload = { asset: s_('asset'), price: s_('price') };
      break;
    case 'ListingCancelled':
      payload = { asset: s_('asset') };
      break;
    case 'ChipSold': {
      const currency = n_('currency') ?? 0;
      const price = s_('price');
      payload = { asset: s_('asset'), seller: s_('seller'), buyer: s_('buyer'), price, currency, viaOffer: Boolean(d.viaOffer) };
      if (price !== undefined) {
        try { payload.priceUsd = Number(toUsd(price, currency, prices(db)).toFixed(2)); } catch { /* no price cache yet → the toast shows no USD, which beats a wrong one */ }
      }
      break;
    }
    // SEC-B35: a compressed trade in the same shape as `ChipSold` (so the seller toast and the market /
    // grid / balances invalidation are one client code path). `asset` is set only when the leaf exists —
    // on the claim market `asset` is absent and the identity is the claim PDA, which is not a chip route
    // the client can fetch; `claim` is always carried so a client can still key its own cache by it.
    case 'CompressedClaimListed':
    case 'CompressedAssetListed':
      payload = { asset: s_('asset'), claim: s_('claim'), seller: s_('seller'), price: s_('price'), currency: n_('currency') ?? 0 };
      break;
    case 'CompressedClaimSold':
    case 'CompressedAssetSold': {
      const price = s_('price');
      // the claim market settles in lamports only (SEC-B28), so the display price is SOL for both events
      payload = { asset: s_('asset'), claim: s_('claim'), seller: s_('seller'), buyer: s_('buyer'), price, currency: 0 };
      if (price !== undefined) {
        try { payload.priceUsd = Number(toUsd(price, 0, prices(db)).toFixed(2)); } catch { /* no price cache yet → no USD in the toast */ }
      }
      break;
    }
    // the claim's own state flips: the cancel path has no market event at all, the staking CPI has no
    // `Staked`/`Unstaked` row to hang a client refresh on when only the flag moved
    case 'CompressedClaimListedSet': payload = { claim: s_('claim'), listed: Boolean(d.listed) }; break;
    case 'CompressedClaimStakedSet': payload = { claim: s_('claim'), staked: Boolean(d.staked) }; break;
    case 'OfferMade': payload = { asset: s_('asset'), bidder: s_('bidder'), amount: s_('amount'), expiresAt: s_('expiresAt') }; break;
    case 'OfferCancelled': payload = { asset: s_('asset'), bidder: s_('bidder') }; break;
    case 'BattleCreated': payload = { id: s_('battle'), challenger: s_('challenger'), wager: s_('wager') }; break;
    case 'BattleAccepted': payload = { id: s_('battle'), opponent: s_('opponent') }; break;
    case 'BattleResolved': payload = { id: s_('battle'), winner: s_('winner'), pot: s_('pot') }; break;
    case 'BattleCancelled': payload = { id: s_('battle'), status: 'cancelled' }; break;
    case 'PackOpened': payload = { buyer: s_('buyer'), nonce: s_('nonce'), sku: n_('sku'), count: n_('count'), pityAfter: n_('pityAfter') }; break;
    case 'PackCancelled': payload = { buyer: s_('buyer'), nonce: s_('nonce'), refunded: s_('refunded') }; break;
    case 'ChipFused': payload = { owner: s_('owner'), result: s_('result'), recipe: n_('recipe'), success: Boolean(d.success) }; break;
    // SEC-G04: same wire shape as ChipFused so the fusion toast / invalidation is one client code path.
    case 'CompressedClaimsFused': payload = { owner: s_('owner'), result: s_('resultClaim'), recipe: n_('recipe'), success: true }; break;
    // H3: same again, but the roll is real — `success` comes from the chain, `resultClaim` is the default pubkey on failure.
    case 'ClaimFusionRevealed': payload = { owner: s_('owner'), result: s_('resultClaim'), recipe: n_('recipe'), success: Boolean(d.success) }; break;
    case 'VoucherIssued': payload = { wallet: s_('wallet'), nonce: s_('nonce'), template: n_('template') }; break;
    case 'Staked': payload = { owner: s_('owner'), kind: n_('kind'), key: s_('key'), amount: s_('amount') }; break;
    case 'Unstaked': payload = { owner: s_('owner'), kind: n_('kind'), key: s_('key'), amount: s_('amount'), penaltyBurned: s_('penaltyBurned') }; break;
    case 'Claimed': payload = { owner: s_('owner'), kind: n_('kind'), amount: s_('amount') }; break;
    case 'RootClaimed': payload = { wallet: s_('wallet'), kind: n_('kind'), epoch: n_('epoch'), amount: s_('amount') }; break;
    case 'RootPublished': payload = { kind: n_('kind'), epoch: n_('epoch'), budget: s_('budget') }; break;
    case 'ParamsChanged': payload = { admin: s_('admin'), version: n_('version') }; break;
    // SEC-B22: carries what changed, so the admin log channel can show the diff, not just the version.
    case 'ParamsPatched': payload = {
      admin: s_('admin'), version: n_('version'), changed: n_('changed'),
      treasury: s_('treasury'), buybackWallet: s_('buybackWallet'),
      pythSolUsdFeed: s_('pythSolUsdFeed'), pythSkrUsdFeed: s_('pythSkrUsdFeed'),
      skrMint: s_('skrMint'), marketFeeBps: n_('marketFeeBps'), skrDiscountBps: n_('skrDiscountBps'),
      featuredCollection: n_('featuredCollection'), packs: Boolean(d.packs),
    }; break;
    case 'PauseChanged': payload = { by: s_('by'), paused: Boolean(d.paused) }; break;
    case 'DayClosed': payload = { dayIndex: n_('dayIndex'), year: n_('year'), guarded: s_('guarded') }; break;
    default: {
      // Unknown (a program event that shipped before the client learned it): scalars only. The client
      // ignores an unlisted type, so this is forward-compat for a program release, not a data channel.
      for (const [k, v] of Object.entries(d).slice(0, 16)) if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') payload[k] = v;
    }
  }
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
  return { wallets, type, payload, slot: ctx.slot };
}
