// Cosmetic catalogs — cap skins, profile themes, arena emote packs, season-pass
// track. Single source of truth shared by the API (claim validation, pass
// rewards) and the client (purchase pickers, rendering). Cosmetics never touch
// odds, power or payouts: skins / themes / tags are presentation only.
export interface SkinDef { id: string; name: string; blurb: string; /** earn-only (Floodgrid gifts): never sold through Services */ exclusive?: boolean }

/** Cap skins — each purchase binds ONE skin to ONE cap (payload {asset, skin}); the skin travels with the cap when sold. */
export const SKINS: SkinDef[] = [
  { id: 'gold-rim', name: 'Gold Rim', blurb: 'Molten-gold ring around the cap.' },
  { id: 'spray-drip', name: 'Spray Drip', blurb: 'Fresh magenta drips, still wet.' },
  { id: 'hologlow', name: 'Hologlow', blurb: 'Shifting holographic sheen.' },
  { id: 'blood-drip', name: 'Blood Drip', blurb: 'Dark crimson drips. Menacing.' },
  { id: 'frost-rim', name: 'Frost Rim', blurb: 'Ice-blue frozen edge.' },
  { id: 'toxic-glow', name: 'Toxic Glow', blurb: 'Radioactive acid aura.' },
  { id: 'wet-rim', name: 'Wet Rim', blurb: 'Floodwater still dripping off the rim. Floodgrid depth gift.', exclusive: true },
  { id: 'perfect-flood', name: 'Perfect Flood', blurb: 'Every branch lit, not a drop wasted. 225-star Floodgrid gift.', exclusive: true },
];
export const SKIN_BY_ID: Record<string, SkinDef> = Object.fromEntries(SKINS.map((s) => [s.id, s]));

export interface ThemeDef { id: string; name: string; blurb: string; hex: string; /** earn-only (Floodgrid gifts): never sold through Services */ exclusive?: boolean }

/** Profile lamp themes — recolor the profile showcase and the arena intro banner. */
export const PROFILE_THEMES: ThemeDef[] = [
  { id: 'magenta', name: 'Neon Magenta', blurb: 'Hot-pink glow on your profile and arena intro.', hex: '#ff2d78' },
  { id: 'cyan', name: 'Cyan Circuit', blurb: 'Electric-blue glow on your profile and arena intro.', hex: '#22d3ee' },
  { id: 'acid', name: 'Acid Lime', blurb: 'Toxic-green glow on your profile and arena intro.', hex: '#a3e635' },
  { id: 'collector-heart', name: 'Collector Heart', blurb: 'Deep-water teal from the heart of the flood. Floodgrid depth gift.', hex: '#2dd4bf', exclusive: true },
];
export const PROFILE_THEME_BY_ID: Record<string, ThemeDef> = Object.fromEntries(PROFILE_THEMES.map((t) => [t.id, t]));

/** Floodgrid field themes — recolor the sector board only (pay_service kind 11, docs/12 phase 3). Presentation only. */
export const GRID_FIELD_THEMES: ThemeDef[] = [
  { id: 'field-magma', name: 'Magma Field', blurb: 'Molten orange flow lines on the Floodgrid board.', hex: '#fb923c' },
  { id: 'field-frost', name: 'Frost Field', blurb: 'Ice-blue flow lines on the Floodgrid board.', hex: '#38bdf8' },
  { id: 'field-toxic', name: 'Toxic Field', blurb: 'Acid-green flow lines on the Floodgrid board.', hex: '#a3e635' },
  { id: 'field-royal', name: 'Royal Field', blurb: 'Violet flow lines on the Floodgrid board.', hex: '#c4b5fd' },
];
export const GRID_FIELD_THEME_BY_ID: Record<string, ThemeDef> = Object.fromEntries(GRID_FIELD_THEMES.map((t) => [t.id, t]));

export interface EmoteDef { id: string; tag: string; color: string }
export interface EmotePackDef { id: string; name: string; blurb: string; emotes: EmoteDef[] }

/** Arena emote packs — spray-tags the owner can throw onto live and past matches. Emote ids are globally unique. */
export const EMOTE_PACKS: EmotePackDef[] = [
  {
    id: 'tags-v1', name: 'Street Tags', blurb: 'Six classic gutter tags.',
    emotes: [
      { id: 'gg', tag: 'GG', color: '#a3e635' },
      { id: 'ez', tag: 'EZ', color: '#22d3ee' },
      { id: 'wow', tag: 'WOW', color: '#ff2d78' },
      { id: 'rip', tag: 'RIP', color: '#a1a1aa' },
      { id: 'lit', tag: 'LIT', color: '#fbbf24' },
      { id: 'rekt', tag: 'REKT', color: '#f87171' },
    ],
  },
  {
    id: 'tags-v2', name: 'Night Tags', blurb: 'Six after-dark tags.',
    emotes: [
      { id: 'ghost', tag: 'GHOST', color: '#c4b5fd' },
      { id: 'vandal', tag: 'VANDAL', color: '#fb923c' },
      { id: 'midnite', tag: 'MIDNITE', color: '#818cf8' },
      { id: 'howl', tag: 'HOWL', color: '#5eead4' },
      { id: 'fog', tag: 'FOG', color: '#94a3b8' },
      { id: 'zero', tag: 'ZERO', color: '#f472b6' },
    ],
  },
];
export const EMOTE_PACK_BY_ID: Record<string, EmotePackDef> = Object.fromEntries(EMOTE_PACKS.map((p) => [p.id, p]));
/** emoteId → owning pack id (for validation: a tag is usable only from an owned pack). */
export const EMOTE_PACK_OF: Record<string, string> = Object.fromEntries(
  EMOTE_PACKS.flatMap((p) => p.emotes.map((e) => [e.id, p.id])),
);

/** Season-pass XP awards. Ranked play moves the track; nothing is bought. */
export const PASS_XP = { matchWin: 100, matchLoss: 40, packOpen: 20, floodDaily: 30 } as const;

export type PassReward =
  | { kind: 'skin'; skin: string }
  | { kind: 'theme'; theme: string }
  | { kind: 'emotes'; pack: string }
  | { kind: 'banner'; collection: number }
  | { kind: 'skip' };

export interface PassTier { tier: number; xp: number; reward: PassReward }

/**
 * The 20-tier cosmetic track for the 6-week season. `xp` is the cumulative XP
 * needed to unlock the tier. Rewards reference the catalogs above (plus the
 * instant-reveal skip). No odds, no power, no $CG — cosmetics only.
 */
export const PASS_TRACK: PassTier[] = [
  { tier: 1, xp: 100, reward: { kind: 'skin', skin: 'gold-rim' } },
  { tier: 2, xp: 220, reward: { kind: 'theme', theme: 'magenta' } },
  { tier: 3, xp: 360, reward: { kind: 'banner', collection: 0 } },
  { tier: 4, xp: 520, reward: { kind: 'emotes', pack: 'tags-v1' } },
  { tier: 5, xp: 700, reward: { kind: 'banner', collection: 1 } },
  { tier: 6, xp: 900, reward: { kind: 'skin', skin: 'spray-drip' } },
  { tier: 7, xp: 1120, reward: { kind: 'banner', collection: 2 } },
  { tier: 8, xp: 1360, reward: { kind: 'theme', theme: 'cyan' } },
  { tier: 9, xp: 1620, reward: { kind: 'banner', collection: 3 } },
  { tier: 10, xp: 1900, reward: { kind: 'skip' } },
  { tier: 11, xp: 2200, reward: { kind: 'skin', skin: 'hologlow' } },
  { tier: 12, xp: 2500, reward: { kind: 'banner', collection: 4 } },
  { tier: 13, xp: 2800, reward: { kind: 'theme', theme: 'acid' } },
  { tier: 14, xp: 3100, reward: { kind: 'banner', collection: 5 } },
  { tier: 15, xp: 3400, reward: { kind: 'skin', skin: 'blood-drip' } },
  { tier: 16, xp: 3700, reward: { kind: 'banner', collection: 6 } },
  { tier: 17, xp: 4000, reward: { kind: 'emotes', pack: 'tags-v2' } },
  { tier: 18, xp: 4350, reward: { kind: 'banner', collection: 7 } },
  { tier: 19, xp: 4700, reward: { kind: 'skin', skin: 'frost-rim' } },
  { tier: 20, xp: 5100, reward: { kind: 'skin', skin: 'toxic-glow' } },
];

/** Highest unlocked tier (0..20) for a cumulative XP total. */
export function passTierForXp(xp: number): number {
  let tier = 0;
  for (const t of PASS_TRACK) if (xp >= t.xp) tier = t.tier;
  return tier;
}
