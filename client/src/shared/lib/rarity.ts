import type { UiText } from '@/shared/i18n/message';
import { t, type MessageKey } from '@/shared/i18n';
// UI-side rarity helpers: names, colours (from the design tokens).
// Rarity reads through colour/labels — chips have no rings or glow around them.
import { RARITIES, RARITY_PROFILES, levelMult, type RarityIndex } from '@guttercaps/economy';
import { COLLECTIONS } from './lore';

export { RARITIES, RARITY_PROFILES };
export type { RarityIndex };

export const RARITY_SHORT = ['C', 'C+', 'R', 'R+', 'E', 'E+', 'L', 'L+', 'D'] as const;

/** Glow / accent per tier — reuses the fixed palette (no new colours).
 *  Values are the *soft* variants (see theme.css): rarity names render as
 *  coloured text in grids and drawers, and the raw neon hexes vibrated on
 *  the asphalt background. Paint shapes still get full neon elsewhere. */
export const RARITY_COLOR = [
  '#9B97A3',  // Common — zinc
  '#5AD0C4',  // Common+ — cyan (soft)
  '#5AD0C4',  // Rare
  '#9AD9FF',  // Rare+ (steel/oil-slick chrome tone; trust-blue is money-only)
  '#E86CA4',  // Epic — magenta (soft)
  '#F09A56',  // Epic+ — orange (soft)
  '#F09A56',  // Legend
  '#C4E37A',  // Legend+ — acid (soft)
  '#D8D8DC',  // Diamond — chrome/prism
] as const;

// Rare+ must not use trust-blue (money-only). Override with a steel/oil-slick tone from the chrome family.
(RARITY_COLOR as unknown as string[])[3] = '#9AD9FF';

export const rarityName = (r: number) => r >= 0 && r <= 8 ? t(`ui.rarity${r}` as MessageKey) : `T${r}`;
export const rarityColor = (r: number) => RARITY_COLOR[r] ?? RARITY_COLOR[0];
// Kept for compatibility (CSS classes are no-ops now — no rings around chips).
export const rimClass = (r: number) => `rim-${RARITY_PROFILES[r]?.rim ?? 'zinc-scratched'}`;
export const vfxTier = (r: number) => RARITY_PROFILES[r]?.vfxTier ?? 0;

/** Collection colour tokens map to the real palette values (lore.ts uses site var names). */
const COLLECTION_HEX: Record<string, string> = {
  'var(--cyan)': '#16E5D9', 'var(--orange)': '#FF7A1A', 'var(--magenta)': '#FF2E8A', 'var(--trust)': '#9AD9FF', 'var(--acid)': '#B6FF3C',
};
export const collectionColor = (idx: number) => COLLECTION_HEX[COLLECTIONS[idx]?.color ?? ''] ?? '#D8D8DC';
export const collectionName = (idx: number) => COLLECTIONS[idx] ? t(`catalog.d${idx}.name` as MessageKey) : `#${idx + 1}`;
export const collectionSymbol = (idx: number) => COLLECTIONS[idx]?.symbol ?? `C${idx}`;
export const chipName = (collectionIdx: number, rarity: number) => COLLECTIONS[collectionIdx]?.caps[rarity] ? t(`catalog.c${collectionIdx}r${rarity}.name` as MessageKey) : `${collectionName(collectionIdx)} ${rarityName(rarity)}`;

/** Deterministic local master for an archetype — the same files the Codex shows
 *  (`client/public/art/{district}-{rarity}-{256,512}.webp`, all 72 exist).
 *  256 for small tiles (up to ~150 px on screen), 512 for hero displays. */
export const chipArtUrl = (collectionIdx: number, rarity: number, size: 256 | 512 = 256) =>
  `/art/${COLLECTIONS[collectionIdx]?.num ?? '01'}-${rarity}-${size}.webp`;

/** Real art for a chip object: indexer URL first, local master as fallback. */
export const chipImageOf = (
  c: { collection?: number | null; rarity?: number | null; art?: { image?: string | null } | null },
  size: 256 | 512 = 256,
) => c.art?.image || chipArtUrl(c.collection ?? 0, c.rarity ?? 0, size);
export const chipLore = (collectionIdx: number, rarity: number) => COLLECTIONS[collectionIdx]?.caps[rarity] ? t(`catalog.c${collectionIdx}r${rarity}.desc` as MessageKey) : '';

export const ELEMENT_OF_COLLECTION = ['shadow', 'wheels', 'steel', 'wheels', 'noise', 'shadow', 'noise', 'wheels', 'paint', 'paint'] as const;
export type Element = (typeof ELEMENT_OF_COLLECTION)[number];
// The emoji map that used to live here (🎨 ⚙️ 🛞 🔊 🌑) moved to
// shared/ui/element-icons.tsx as real vector glyphs (ElementGlyph).
/** ring: paint > steel > wheels > noise > shadow > paint */
const RING: Element[] = ['paint', 'steel', 'wheels', 'noise', 'shadow'];
export function elementEdge(a: Element, b: Element): number {
  if (a === b) return 0;
  const ia = RING.indexOf(a), ib = RING.indexOf(b);
  if ((ia + 1) % 5 === ib) return 0.15;
  if ((ib + 1) % 5 === ia) return -0.13;
  return 0;
}

export const chipPower = (rarity: number, level: number) => Math.round((RARITY_PROFILES[rarity]?.basePower ?? 0) * levelMult(level));
export function squadPower(chips: { rarity: number; level: number }[]): number {
  return chips.reduce((s, c) => s + chipPower(c.rarity, c.level), 0);
}
export function squadSynergy(chips: { collection: number }[]): number {
  const els = chips.map((c) => ELEMENT_OF_COLLECTION[c.collection]);
  let pairs = 0;
  for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) if (els[i] === els[j]) pairs++;
  return 1 + 0.08 * pairs;
}

/** Display names only; SKU/rarity IDs sent to the chain never change. */
export const packName = (sku: number) => sku >= 0 && sku < 4 ? t(`ui.pack${sku}` as MessageKey) : `#${sku}`;

export const leagueName = (league: number) => league >= 0 && league < 6 ? t(`ui.league${league}` as MessageKey) : `#${league}`;

/** Same catalog IDs as the immediate labels, deferred for long-lived notifications. */
export const rarityText = (r: number): UiText => Number.isInteger(r) && r >= 0 && r <= 8 ? { key: `ui.rarity${r}` as MessageKey } : `T${r}`;
export const leagueText = (league: number): UiText => Number.isInteger(league) && league >= 0 && league < 6 ? { key: `ui.league${league}` as MessageKey } : `#${league}`;
export const chipNameText = (collection: number, rarity: number): UiText => COLLECTIONS[collection]?.caps[rarity]
  ? { key: `catalog.c${collection}r${rarity}.name` as MessageKey }
  : { parts: [COLLECTIONS[collection] ? { key: `catalog.d${collection}.name` as MessageKey } : `#${collection + 1}`, ' ', rarityText(rarity)] };
