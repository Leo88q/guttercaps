import { describe, it, expect } from 'vitest';
import { interpolate, LOCALES, LOCALE_META, loadLocale, detectLocale } from './index';
import en from './locales/en';
import pt from './locales/pt';
import es from './locales/es';
import vi from './locales/vi';
import id from './locales/id';
import fil from './locales/fil';
import ru from './locales/ru';

const bundles = { en, pt, es, vi, id, fil, ru } as const;

function leaves(obj: unknown, prefix = ''): string[] {
  if (typeof obj === 'string') return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
}
function get(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}
const placeholders = (s: string) => Array.from(s.matchAll(/\{(\w+)(?:,\s*plural)?/g)).map((m) => m[1]).sort();

describe('i18n runtime', () => {
  it('interpolates variables and formats numbers per locale', () => {
    expect(interpolate('Season {id}', { id: 7 }, 'en')).toBe('Season 7');
    expect(interpolate('{n} caps', { n: 12345 }, 'en')).toBe('12,345 caps');
    expect(interpolate('{n} caps', { n: 12345 }, 'ru')).toMatch(/12\s345 caps/);
    expect(interpolate('{n} caps', { n: 12345 }, 'pt-BR')).toBe('12.345 caps');
  });
  it('picks CLDR plural categories (en one/other, ru one/few/many)', () => {
    const enT = '{n, plural, one{# day} other{# days}}';
    expect(interpolate(enT, { n: 1 }, 'en')).toBe('1 day');
    expect(interpolate(enT, { n: 2 }, 'en')).toBe('2 days');
    const ruT = '{n, plural, one{# день} few{# дня} many{# дней} other{# дня}}';
    expect(interpolate(ruT, { n: 1 }, 'ru')).toBe('1 день');
    expect(interpolate(ruT, { n: 3 }, 'ru')).toBe('3 дня');
    expect(interpolate(ruT, { n: 5 }, 'ru')).toBe('5 дней');
    expect(interpolate(ruT, { n: 21 }, 'ru')).toBe('21 день');
    // vi/id have no plural forms: `other` only
    expect(interpolate('{n, plural, other{# gói}}', { n: 1 }, 'vi')).toBe('1 gói');
  });
  it('accepts bigint vars and leaves unknown placeholders visible', () => {
    expect(interpolate('{n, plural, one{# pack} other{# packs}}', { n: 5n }, 'en')).toBe('5 packs');
    expect(interpolate('Hi {name}', {}, 'en')).toBe('Hi {name}');
  });
  it('detectLocale maps legacy tags', () => {
    expect(typeof detectLocale()).toBe('string');
  });
  it('every locale loads lazily', async () => {
    for (const l of LOCALES) await loadLocale(l);
  });
});

describe('locale bundles', () => {
  const enKeys = leaves(en);
  it('EN has no empty strings', () => {
    for (const k of enKeys) expect((get(en, k) as string).length, k).toBeGreaterThan(0);
  });
  for (const l of LOCALES.filter((x) => x !== 'en')) {
    const b = bundles[l];
    it(`${l}: no unknown keys, placeholders preserved, 100 % coverage`, () => {
      const keys = leaves(b);
      const unknown = keys.filter((k) => get(en, k) === undefined);
      expect(unknown, `unknown keys in ${l}`).toEqual([]);
      const coverage = keys.length / enKeys.length;
      expect(coverage, `${l} coverage ${(coverage * 100).toFixed(1)} %`).toBe(1);
      expect(keys.sort()).toEqual([...enKeys].sort());
      for (const k of keys) {
        const src = get(en, k) as string; const dst = get(b, k) as string;
        expect(placeholders(dst), `${l}:${k} placeholders`).toEqual(placeholders(src));
        expect(dst.length, `${l}:${k} empty`).toBeGreaterThan(0);
      }
    });
    // Every nav label must fit the bar: 9 tabs across 360 px is 40 px each, and the mobile rules
    // let a label wrap to two lines but not grow. Swept over the whole `nav` block, not just the
    // nine entries Shell.tsx currently mounts, so a label added for a future tab is checked before
    // it is wired up. It used to say "7-tab bar" and exempt `nav.language` — both stale: the bar
    // has nine tabs, and the language label moved to the header (where it renders as a 2-letter
    // code, not this word), so the key is gone rather than exempted.
    it(`${l}: nav labels fit the tab bar (≤ 10 chars)`, () => {
      for (const [k, v] of Object.entries(b.nav ?? {})) expect((v as string).length, `${l}:nav.${k}`).toBeLessThanOrEqual(10);
    });
  }
  it('locale meta is complete and Cyrillic/Vietnamese use the alt display font', () => {
    for (const l of LOCALES) expect(LOCALE_META[l].code).toBe(l);
    expect(LOCALE_META.ru.displayFontOk).toBe(false);
    expect(LOCALE_META.vi.displayFontOk).toBe(false);
    expect(LOCALE_META.en.displayFontOk).toBe(true);
  });
});


describe('complete game catalog', () => {
  for (const locale of LOCALES) {
    it(`${locale}: all 8 districts and 72 caps have localized presentation`, () => {
      for (let ci = 0; ci < 8; ci++) {
        for (const field of ['name', 'district', 'theme', 'history']) {
          const key = `catalog.d${ci}.${field}`;
          expect(get(bundles[locale], key), key).toBeTruthy();
          if (locale !== 'en') expect(get(bundles[locale], key), key).not.toBe(get(en, key));
        }
        for (let ri = 0; ri < 9; ri++) {
          for (const field of ['name', 'desc']) {
            const key = `catalog.c${ci}r${ri}.${field}`;
            expect(get(bundles[locale], key), key).toBeTruthy();
            if (locale !== 'en') expect(get(bundles[locale], key), key).not.toBe(get(en, key));
          }
        }
      }
    });
  }
  it('supports exact plural branches before CLDR categories', () => {
    const message = '{n, plural, =0{Nothing} one{# cap} other{# caps}}';
    expect(interpolate(message, { n: 0 }, 'en')).toBe('Nothing');
    expect(interpolate(message, { n: 1 }, 'en')).toBe('1 cap');
    expect(interpolate(message, { n: 2 }, 'en')).toBe('2 caps');
  });
});

describe('locale selection safety', () => {
  it('the latest language selection wins concurrent loads', async () => {
    const { setLocale, getLocale } = await import('./index');
    await Promise.all([setLocale('ru'), setLocale('pt'), setLocale('en')]);
    expect(getLocale()).toBe('en');
  });
  it('invalid persisted locales cannot crash translators', async () => {
    const { useUiStore } = await import('@/app/store/ui');
    const { getLocale, initI18n, isLocale } = await import('./index');
    useUiStore.setState({ locale: 'invalid' as never, localeExplicit: true });
    expect(getLocale()).toBe('en');
    expect(isLocale(await initI18n())).toBe(true);
    expect(isLocale(useUiStore.getState().locale)).toBe(true);
  });
});


describe('catalog maintenance', () => {
  it('English presentation remains aligned with canonical economy lore', async () => {
    const { COLLECTIONS } = await import('@guttercaps/economy');
    for (const [ci, collection] of COLLECTIONS.entries()) {
      for (const field of ['name', 'district', 'theme', 'history'] as const) {
        expect(get(en, `catalog.d${ci}.${field}`)).toBe(collection[field]);
      }
      for (const [ri, cap] of collection.caps.entries()) {
        expect(get(en, `catalog.c${ci}r${ri}.name`)).toBe(cap.name);
        expect(get(en, `catalog.c${ci}r${ri}.desc`)).toBe(cap.desc);
      }
    }
  });
  it('painting a bottle cap is not translated as painting a hat', () => {
    const wrong = /кепк|gorra|boné|bonés|topi|mũ/i;
    for (const locale of LOCALES) {
      expect(bundles[locale].services.pickCap).not.toMatch(wrong);
      expect(bundles[locale].services.noFreeCaps).not.toMatch(wrong);
      expect(bundles[locale].pass.pickCap).not.toMatch(wrong);
    }
  });
});
