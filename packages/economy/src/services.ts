// =============================================================================
// GUTTERCAPS economy — paid services (voluntary spend)
// -----------------------------------------------------------------------------
// The studio's second revenue line after pack sales and fees. Design rules:
//  1. Nothing here buys power. No odds, no PvP stats, no staking weight, no
//     extra $CG emission. (Boosters are the one gameplay item and they are
//     capped at 3 / wallet / day; a booster only trims variance on a fusion
//     the player was already going to do — see docs/02-economy.md §5.)
//  2. Every service can be paid in SOL / USDC / SKR (→ 100 % treasury) or
//     $CG (→ 100 % burned). Parity anchor: 1 US cent ≙ 1 $CG for services.
//  3. Prices are USD-denominated so they don't drift with SOL/SKR. Volatile
//     currencies are converted at checkout via Pyth (same path as packs).
//  4. Mirrored on-chain in programs/chip_core/src/economy.rs (ServiceKind);
//     scripts/sync-check.ts fails the build if the two diverge.
//
// Revenue model (why these prices): comparable F2P cosmetics sit at
// $0.99–$4.99 with 3–6 % of MAU buying ≥1 item/month. At 5 000 DAU / 15 000
// MAU and 4 % conversion × $3.20 avg basket ≈ $1 900/mo + season pass
// (8 % of MAU × $9.99) ≈ $12 000/season. Small next to packs (≈ $110 k/mo in
// the baseline flow model) but almost pure margin and it deepens retention
// (identity = handle + skins + banners).
// =============================================================================

export type ServiceId =
  | 'handle' | 'handleChange' | 'capSkin' | 'profileTheme' | 'arenaEmotePack'
  | 'extraBenchSlots' | 'seasonPass' | 'booster' | 'packSkipAnim' | 'districtBanner';

export interface ServiceDef {
  id: ServiceId;
  /** enum value shared with the program (`ServiceKind`) and the indexer */
  kind: number;
  rustName: string;
  priceUsdCents: number;
  /** purchases per wallet per rolling 24 h enforced on-chain */
  dailyCap: number;
  /** what the player gets; 'chain' = state on-chain (PlayerItems), 'entitlement' = backend record keyed by ServicePaid.ref_hash */
  fulfilment: 'chain' | 'entitlement';
  recurring: boolean;
  name: string;
  blurb: string;
}

export const CG_MICRO_PER_CENT = 1_000_000;

export const SERVICES: readonly ServiceDef[] = [
  { id: 'handle',          kind: 0, rustName: 'Handle',          priceUsdCents: 199, dailyCap: 1,  fulfilment: 'entitlement', recurring: false, name: '@handle',            blurb: 'Unique name on leaderboards, arena and your public profile URL.' },
  { id: 'handleChange',    kind: 1, rustName: 'HandleChange',    priceUsdCents: 99,  dailyCap: 1,  fulfilment: 'entitlement', recurring: false, name: 'Handle change',      blurb: 'Rename once per 30 days. Old handle is released after 90 days.' },
  { id: 'capSkin',         kind: 2, rustName: 'CapSkin',         priceUsdCents: 149, dailyCap: 10, fulfilment: 'entitlement', recurring: false, name: 'Cap skin',           blurb: 'Cosmetic rim / spray effect written as an attribute on one cap. Travels with the cap when sold.' },
  { id: 'profileTheme',    kind: 3, rustName: 'ProfileTheme',    priceUsdCents: 299, dailyCap: 10, fulfilment: 'entitlement', recurring: false, name: 'Profile theme',      blurb: 'Wall texture + lamp colour set for your profile and arena intro.' },
  { id: 'arenaEmotePack',  kind: 4, rustName: 'ArenaEmotePack',  priceUsdCents: 249, dailyCap: 10, fulfilment: 'entitlement', recurring: false, name: 'Arena emote pack',   blurb: '6 spray-tag emotes for Cap Slam replays.' },
  { id: 'extraBenchSlots', kind: 5, rustName: 'ExtraBenchSlots', priceUsdCents: 199, dailyCap: 10, fulfilment: 'entitlement', recurring: false, name: '+2 bench presets',   blurb: 'Save more fusion presets on the bench (convenience only).' },
  { id: 'seasonPass',      kind: 6, rustName: 'SeasonPass',      priceUsdCents: 999, dailyCap: 10, fulfilment: 'entitlement', recurring: true,  name: 'Season pass',        blurb: 'Cosmetic track for the 6-week season: 20 tiers of skins, banners, emotes. No odds, no power, no $CG.' },
  { id: 'booster',         kind: 7, rustName: 'Booster',         priceUsdCents: 79,  dailyCap: 0,  fulfilment: 'chain',       recurring: false, name: 'Fusion booster',     blurb: '+15 pp success on one fusion (cap 95 %). Earned from quests and PvP only — not sold.' },
  { id: 'packSkipAnim',    kind: 8, rustName: 'PackSkipAnim',    priceUsdCents: 99,  dailyCap: 10, fulfilment: 'entitlement', recurring: false, name: 'Instant reveal',     blurb: 'Permanent toggle to skip the reveal animation. Pure convenience.' },
  { id: 'districtBanner',  kind: 9, rustName: 'DistrictBanner',  priceUsdCents: 199, dailyCap: 10, fulfilment: 'entitlement', recurring: false, name: 'District banner',    blurb: 'Animated banner for a district you have completed.' },
] as const;

export const SERVICE_BY_ID = Object.fromEntries(SERVICES.map((s) => [s.id, s])) as Record<ServiceId, ServiceDef>;
export const SERVICE_BY_KIND = Object.fromEntries(SERVICES.map((s) => [s.kind, s])) as Record<number, ServiceDef>;

export const servicePriceCgMicro = (s: ServiceDef) => s.priceUsdCents * CG_MICRO_PER_CENT;

/** Textual form of the Rust `daily_cap` match arm — checked by sync-check.ts. */
export const SERVICES_DAILY_CAP_RUST = 'Self::Booster => 0, Self::Handle | Self::HandleChange => 1, _ => 10';

/**
 * Revenue projection for services (monthly, USD) — used by docs/05 and the
 * admin dashboard "what-if" panel.
 */
export function servicesMonthlyRevenueUsd(mau: number, conversion = 0.04, avgBasketUsd = 3.2, passShare = 0.08) {
  const cosmetics = mau * conversion * avgBasketUsd;
  const pass = (mau * passShare * 9.99) / 1.5; // one pass per 6-week season ≈ 1.5 months
  return { cosmetics: Math.round(cosmetics), seasonPass: Math.round(pass), total: Math.round(cosmetics + pass) };
}
