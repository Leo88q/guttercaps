// Pack wrapper art per SKU (docs/preorder-beta.md, the 2026-10 presale visual pass).
// The wrappers are the generated "foil graffiti" set in client/public/packs —
// the same art drives the shop cards and the tear-open reveal animation.
export const PACK_ART = ['/packs/starter.webp', '/packs/standard.webp', '/packs/premium.webp', '/packs/limited.webp'] as const;

/** undefined for unknown skus / non-pack reveals (fusion, quest) — the caller falls back to the plain pack visual. */
export const packArtUrl = (sku?: number | null): string | undefined =>
  sku != null && Number.isInteger(sku) && sku >= 0 && sku < PACK_ART.length ? PACK_ART[sku] : undefined;
