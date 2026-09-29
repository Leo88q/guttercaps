import { t, type MessageKey } from '@/shared/i18n';
// Cosmetic ownership + display-choice helpers. Variants are bound at PURCHASE
// time (the payload hashed into ref_hash): what you own is read from
// entitlement payloads, and the wallet only chooses which owned variant to
// display (persisted per wallet in localStorage).
import { PROFILE_THEMES as ECONOMY_THEMES } from '@guttercaps/economy';

/** economy service kinds for the cosmetic/convenience entitlements. */
export const KIND = { skin: 2, theme: 3, emotePack: 4, bench: 5, pass: 6, skip: 8, banner: 9 } as const;

export interface EntitlementLike { kind?: number; payload?: Record<string, unknown> | null; expiresAt?: string | null }

export function owns(ents: EntitlementLike[] | undefined, kind: number): boolean {
  return (ents ?? []).some((e) => e.kind === kind && (e.expiresAt === null || e.expiresAt === undefined || new Date(e.expiresAt).getTime() > Date.now()));
}

/** Owned theme ids (kind-3 payloads). A payload-less grant (early buyers) unlocks every theme. */
export function ownedThemes(ents: EntitlementLike[] | undefined): string[] {
  const list = (ents ?? []).filter((e) => e.kind === KIND.theme);
  if (list.length === 0) return [];
  const ids = list.map((e) => (e.payload as { theme?: unknown } | null | undefined)?.theme).filter((x): x is string => typeof x === 'string');
  if (ids.length < list.length) return ECONOMY_THEMES.map((t) => t.id);
  return [...new Set(ids)];
}

/** Owned banner districts (kind-9 payloads). Payload-less grants fall back to every completed district. */
export function ownedBanners(ents: EntitlementLike[] | undefined, completed: number[]): number[] {
  const list = (ents ?? []).filter((e) => e.kind === KIND.banner);
  if (list.length === 0) return [];
  const ids = list.map((e) => (e.payload as { collection?: unknown } | null | undefined)?.collection).filter((x): x is number => typeof x === 'number');
  if (ids.length < list.length) return completed;
  return [...new Set(ids)].filter((c) => completed.includes(c));
}

/** Owned emote-pack ids (kind-4 payloads). Payload-less grants unlock nothing (packs are always named at claim). */
export function ownedPacks(ents: EntitlementLike[] | undefined): string[] {
  return [...new Set((ents ?? []).filter((e) => e.kind === KIND.emotePack).map((e) => (e.payload as { pack?: unknown } | null | undefined)?.pack).filter((x): x is string => typeof x === 'string'))];
}

export interface ProfileTheme { id: string; label: string; desc: string; hex: string }
export const PROFILE_THEMES: ProfileTheme[] = ECONOMY_THEMES.map((t) => ({ id: t.id, get label() { return themeText(t.id); }, get desc() { return themeText(t.id, true); }, hex: t.hex }));
export function themeById(id: string | null | undefined): ProfileTheme {
  return PROFILE_THEMES.find((t) => t.id === id) ?? PROFILE_THEMES[0];
}

// ------------------------------------------------------- display choices
function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, val: string) {
  try { localStorage.setItem(key, val); } catch { /* private mode */ }
}
function remove(key: string) {
  try { localStorage.removeItem(key); } catch { /* private mode */ }
}

export function loadTheme(wallet: string | undefined): string | null {
  return wallet ? read(`caps.theme.${wallet}`) : null;
}
export function saveTheme(wallet: string | undefined, id: string) {
  if (wallet) write(`caps.theme.${wallet}`, id);
}
export function loadBanner(wallet: string | undefined): number | null {
  if (!wallet) return null;
  const v = read(`caps.banner.${wallet}`);
  return v === null ? null : Number(v);
}
export function saveBanner(wallet: string | undefined, collection: number | null) {
  if (!wallet) return;
  if (collection === null) remove(`caps.banner.${wallet}`);
  else write(`caps.banner.${wallet}`, String(collection));
}

// ------------------------------------------------------- fusion bench presets
export { loadPresets, savePresets, deletePreset, presetName, type FusionPreset } from './fusionPresets';
export function benchSlots(ents: EntitlementLike[] | undefined): number {
  return owns(ents, KIND.bench) ? 3 : 1;
}


const SKIN_KEYS: Record<string, MessageKey> = {
  'gold-rim': 'ui.skinGold', 'spray-drip': 'ui.skinSpray', hologlow: 'ui.skinHolo',
  'blood-drip': 'ui.skinBlood', 'frost-rim': 'ui.skinFrost', 'toxic-glow': 'ui.skinToxic',
};
const THEME_KEYS: Record<string, MessageKey> = { magenta: 'ui.themeMagenta', cyan: 'ui.themeCyan', acid: 'ui.themeAcid' };
const EMOTE_KEYS: Record<string, MessageKey> = {
  gg: 'ui.emoteGg', ez: 'ui.emoteEz', wow: 'ui.emoteWow', rip: 'ui.emoteRip', lit: 'ui.emoteLit', rekt: 'ui.emoteRekt',
  ghost: 'ui.emoteGhost', vandal: 'ui.emoteVandal', midnite: 'ui.emoteMidnite', howl: 'ui.emoteHowl', fog: 'ui.emoteFog', zero: 'ui.emoteZero',
};
export function skinText(id: string, description = false): string {
  const key = SKIN_KEYS[id];
  return key ? t((description ? `${key}Desc` : key) as MessageKey) : t('common.unavailable');
}
export function themeText(id: string, description = false): string {
  const key = THEME_KEYS[id];
  return key ? t((description ? `${key}Desc` : key) as MessageKey) : t('common.unavailable');
}
export const emotePackName = (id: string) => t(id === 'tags-v1' ? 'ui.streetTags' : id === 'tags-v2' ? 'ui.nightTags' : 'common.unavailable');
export const emoteLabel = (id: string) => t(EMOTE_KEYS[id] ?? 'common.unavailable');
