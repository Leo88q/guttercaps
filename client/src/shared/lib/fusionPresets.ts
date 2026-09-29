import { t } from '@/shared/i18n';
import { rarityName } from './rarity';
import legacyNames from './presetLegacyNames.json';

export interface FusionPreset {
  /** Legacy auto-label or a user-authored name. Custom names are never translated. */
  name?: string;
  nameKind?: 'auto' | 'custom';
  /** Protocol rarity ID, independent of language and current inventory. */
  rarity?: number;
  slots: (string | null)[];
  resultCol: number | null;
  savedAt: number;
}
const validRarity = (r: unknown): r is number => typeof r === 'number' && Number.isInteger(r) && r >= 0 && r <= 8;
// Keep historical spellings even when current copy changes. Do not import all locale bundles.
const legacyRarity = new Map(legacyNames.flatMap(names => names.map((name, rarity) => [`${name} ×3`, rarity] as const)));

export function presetName(preset: FusionPreset): string {
  return preset.nameKind === 'auto' && validRarity(preset.rarity)
    ? `${rarityName(preset.rarity)} ×3` : preset.name ?? t('ui.presets');
}

export function loadPresets(wallet: string | undefined): FusionPreset[] {
  if (!wallet) return [];
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(`caps.presets.${wallet}`) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((p): FusionPreset[] => {
      if (!p || typeof p !== 'object' || !Array.isArray(p.slots) || p.slots.length !== 3
        || !p.slots.every((slot: unknown) => slot === null || typeof slot === 'string')
        || !(p.resultCol === null || (Number.isInteger(p.resultCol) && p.resultCol >= 0 && p.resultCol < 8))
        || typeof p.savedAt !== 'number' || !Number.isFinite(p.savedAt)
        || (p.name !== undefined && typeof p.name !== 'string')) return [];
      if (p.nameKind === 'auto') return validRarity(p.rarity) ? [p] : [];
      if (typeof p.name !== 'string') return [];
      // Old UI had no rename control. Migrate exact known automatic labels only;
      // keep custom/unknown/future versions intact and never infer from changing inventory.
      const rarity = p.nameKind === undefined ? legacyRarity.get(p.name) : undefined;
      return [rarity === undefined ? p : { ...p, nameKind: 'auto', rarity }];
    });
  } catch { return []; }
}

export function savePresets(wallet: string | undefined, presets: FusionPreset[]) {
  if (!wallet) return;
  try { localStorage.setItem(`caps.presets.${wallet}`, JSON.stringify(presets)); } catch { /* unavailable/full storage */ }
}
export function deletePreset(wallet: string | undefined, name: string) {
  if (wallet) savePresets(wallet, loadPresets(wallet).filter(p => p.name !== name));
}
