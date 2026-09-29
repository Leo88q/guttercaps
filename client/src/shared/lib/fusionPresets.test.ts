// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { LOCALES, setLocale, t, type MessageKey } from '@/shared/i18n';
import { loadPresets, savePresets, presetName, type FusionPreset } from './fusionPresets';
import legacyNames from './presetLegacyNames.json';

const fixture: FusionPreset = { slots: ['asset-a', 'asset-b', 'asset-c'], resultCol: 7, savedAt: 1234, nameKind: 'auto', rarity: 0 };
afterEach(async () => { vi.restoreAllMocks(); localStorage.clear(); await setLocale('en'); });

it('new presets persist IDs, not translated labels, and survive a language change and reload', async () => {
  savePresets('wallet-a', [fixture]);
  const bytes = localStorage.getItem('caps.presets.wallet-a');
  expect(bytes).not.toContain('Common');
  for (const locale of LOCALES) {
    await setLocale(locale);
    const loaded = loadPresets('wallet-a');
    expect(loaded).toEqual([fixture]);
    expect(presetName(loaded[0])).toBe(`${t('ui.rarity0')} ×3`);
    expect(localStorage.getItem('caps.presets.wallet-a')).toBe(bytes);
  }
  expect(loadPresets('wallet-b')).toEqual([]);
  expect(loadPresets(undefined)).toEqual([]);
});

for (const [language, names] of legacyNames.entries()) it(`historical label set ${language}: all nine old automatic names migrate without changing the selection`, async () => {
  const records = names.map(name => ({ name: `${name} ×3`, slots: fixture.slots, resultCol: fixture.resultCol, savedAt: fixture.savedAt }));
  const bytes = JSON.stringify(records);
  localStorage.setItem('caps.presets.w', bytes);
  const loaded = loadPresets('w');
  expect(loaded).toHaveLength(9);
  for (const locale of LOCALES) {
    await setLocale(locale);
    loaded.forEach((preset, rarity) => {
      expect(preset).toEqual({ ...records[rarity], nameKind: 'auto', rarity });
      expect(presetName(preset)).toBe(`${t(`ui.rarity${rarity}` as MessageKey)} ×3`);
    });
  }
  expect(localStorage.getItem('caps.presets.w')).toBe(bytes); // migration never destructively rewrites on read
  savePresets('w', loaded);
  expect(loadPresets('w')).toEqual(loaded);
});

it('custom names, unknown old names and future name kinds are preserved, never guessed from inventory', async () => {
  const records: FusionPreset[] = [
    { ...fixture, nameKind: 'custom', name: 'Common ×3' },
    { ...fixture, nameKind: undefined, name: '<b>мой набор</b>' },
    { ...fixture, nameKind: undefined, name: 'Common ×30' },
    { ...fixture, nameKind: undefined, name: 'constructor' },
    { ...fixture, nameKind: 'future-v3', name: 'Do not reinterpret' } as unknown as FusionPreset,
  ];
  savePresets('w', records);
  for (const locale of LOCALES) {
    await setLocale(locale);
    expect(loadPresets('w').map(presetName)).toEqual(records.map(p => p.name));
  }
});

it('invalid caches fail closed without losing the untouched storage or crashing private-mode reads/writes', () => {
  for (const raw of ['{bad', '{}', 'null', '[null]', JSON.stringify([{ ...fixture, slots: [42, null, null] }]), JSON.stringify([{ ...fixture, rarity: 99 }]), JSON.stringify([{ ...fixture, resultCol: -1 }])]) {
    localStorage.setItem('caps.presets.w', raw);
    expect(loadPresets('w')).toEqual([]);
    expect(localStorage.getItem('caps.presets.w')).toBe(raw);
  }
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full'); });
  expect(loadPresets('w')).toEqual([]);
  expect(() => savePresets('w', [fixture])).not.toThrow();
});
