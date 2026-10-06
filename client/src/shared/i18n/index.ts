// =============================================================================
// GUTTERCAPS i18n — 7 locales, zero dependencies.
// -----------------------------------------------------------------------------
// Design decisions (docs/04-frontend.md §11):
//  * Keys are dotted paths; EN is the source of truth and the type oracle.
//    Missing keys in other locales fall back to EN (and are reported in dev),
//    so a partially translated locale never crashes the UI.
//  * `{name}` placeholders; plural via `{n, plural, one{…} other{…}}`-lite:
//    we use ICU-style select with Intl.PluralRules so RU (one/few/many) works.
//  * Money never goes through the translator. Amounts are formatted by
//    `format.ts` (bigint-safe) and only the *grouping/decimal separators*
//    follow the locale (`fmtLocale`), which keeps the clean-zone rule intact.
//  * Layout adaptation per language: <html lang>, `data-lang`, a text-expansion
//    class (`.lang-long` for PT/ES/ID/FIL/RU/VI that run 20–35 % longer than EN),
//    and a display-font fallback for scripts Permanent Marker does not cover
//    (Cyrillic, Vietnamese diacritics) — see theme.css `[data-lang]` rules.
//  * Locale is persisted in the ui store (`gc.ui`) and detected once from
//    navigator.languages on first visit.
// =============================================================================
import { useCallback, useSyncExternalStore } from 'react';
import { useUiStore } from '@/app/store/ui';
import en from './locales/en';

export const LOCALES = ['en', 'pt', 'es', 'vi', 'id', 'fil', 'ru'] as const;
export type Locale = (typeof LOCALES)[number];

interface LocaleMeta {
  code: Locale;
  /** BCP-47 tag handed to <html lang> and Intl */
  tag: string;
  /** endonym shown in the language tab */
  native: string;
  english: string;
  flag: string;
  /** average text expansion vs EN — drives `.lang-long` layout adaptations */
  expansion: number;
  /** display font (graffiti) covers this script? if not, theme.css swaps to a fallback with the same vibe */
  displayFontOk: boolean;
}

export const LOCALE_META: Record<Locale, LocaleMeta> = {
  en:  { code: 'en',  tag: 'en',    native: 'English',          english: 'English',    flag: '🇬🇧', expansion: 1.0,  displayFontOk: true },
  pt:  { code: 'pt',  tag: 'pt-BR', native: 'Português',        english: 'Portuguese', flag: '🇧🇷', expansion: 1.25, displayFontOk: true },
  es:  { code: 'es',  tag: 'es',    native: 'Español',          english: 'Spanish',    flag: '🇪🇸', expansion: 1.25, displayFontOk: true },
  vi:  { code: 'vi',  tag: 'vi',    native: 'Tiếng Việt',       english: 'Vietnamese', flag: '🇻🇳', expansion: 1.15, displayFontOk: false },
  id:  { code: 'id',  tag: 'id',    native: 'Bahasa Indonesia', english: 'Indonesian', flag: '🇮🇩', expansion: 1.2,  displayFontOk: true },
  fil: { code: 'fil', tag: 'fil',   native: 'Filipino',         english: 'Filipino',   flag: '🇵🇭', expansion: 1.3,  displayFontOk: true },
  ru:  { code: 'ru',  tag: 'ru',    native: 'Русский',          english: 'Russian',    flag: '🇷🇺', expansion: 1.3,  displayFontOk: false },
};

// ---------------------------------------------------------------- messages
type Leaves<T, P extends string = ''> = T extends string
  ? P
  : { [K in keyof T & string]: Leaves<T[K], P extends '' ? K : `${P}.${K}`> }[keyof T & string];
export type MessageKey = Leaves<typeof en>;
export type Messages = { [K in keyof typeof en]: Widen<(typeof en)[K]> };
type Widen<T> = T extends string ? string : { [K in keyof T]: Widen<T[K]> };
/** Runtime fallback shape for loading/recovery. Authored locale bundles use the complete Messages type. */
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends string ? string : DeepPartial<T[K]> };
type PartialMessages = DeepPartial<Messages>;

const loaders: Record<Locale, () => Promise<{ default: PartialMessages }>> = {
  en: () => Promise.resolve({ default: en }),
  pt: () => import('./locales/pt'),
  es: () => import('./locales/es'),
  vi: () => import('./locales/vi'),
  id: () => import('./locales/id'),
  fil: () => import('./locales/fil'),
  ru: () => import('./locales/ru'),
};

const loading = new Map<Locale, Promise<void>>();
const loaded: Partial<Record<Locale, PartialMessages>> = { en };
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export async function loadLocale(l: Locale): Promise<void> {
  if (loaded[l]) return;
  let pending = loading.get(l);
  if (!pending) {
    pending = loaders[l]().then((mod) => {
      loaded[l] = mod.default;
      notify();
    }).finally(() => { loading.delete(l); });
    loading.set(l, pending);
  }
  await pending;
}

function lookup(obj: unknown, path: string): string | undefined {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(part in (cur as Record<string, unknown>))) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'string' ? cur : undefined;
}

const missing = new Set<string>();
function raw(locale: Locale, key: string): string {
  const hit = lookup(loaded[locale], key);
  if (hit !== undefined) return hit;
  if (locale !== 'en' && loaded[locale] && import.meta.env.DEV && !missing.has(`${locale}:${key}`)) {
    missing.add(`${locale}:${key}`);
    console.warn(`[i18n] ${locale} missing "${key}" — falling back to en`);
  }
  return lookup(en, key) ?? key;
}

export type Vars = Record<string, string | number | bigint | undefined>;

/**
 * Interpolate `{name}` and the plural form `{n, plural, one{# cap} few{# caps} other{# caps}}`.
 * `#` inside a plural branch is replaced by the locale-formatted number.
 */
export function interpolate(template: string, vars: Vars, tag: string): string {
  const pr = new Intl.PluralRules(tag);
  const nf = new Intl.NumberFormat(tag);
  let out = template.replace(/\{(\w+),\s*plural,\s*((?:\s*(?:=\d+|\w+)\s*\{[^{}]*\})+)\s*\}/g, (_m, name: string, branches: string) => {
    const v = vars[name];
    const n = typeof v === 'bigint' ? Number(v) : Number(v ?? 0);
    const forms: Record<string, string> = {};
    for (const b of branches.matchAll(/(=\d+|\w+)\s*\{([^{}]*)\}/g)) forms[b[1]] = b[2];
    const picked = forms[`=${n}`] ?? forms[pr.select(n)] ?? forms.other ?? '';
    return picked.replace(/#/g, nf.format(n));
  });
  out = out.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const v = vars[name];
    if (v === undefined) return `{${name}}`;
    return typeof v === 'number' ? nf.format(v) : String(v);
  });
  return out;
}

// ---------------------------------------------------------------- locale state
export function detectLocale(): Locale {
  if (typeof navigator === 'undefined') return 'en';
  for (const l of navigator.languages ?? [navigator.language]) {
    const base = l.toLowerCase().split('-')[0];
    if (base === 'tl') return 'fil';
    if (base === 'in') return 'id'; // legacy Java tag
    if ((LOCALES as readonly string[]).includes(base)) return base as Locale;
  }
  return 'en';
}

export function getLocale(): Locale {
  const locale = useUiStore.getState().locale;
  return isLocale(locale) ? locale : 'en';
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

let selection = 0;
export async function setLocale(l: Locale): Promise<void> {
  if (!isLocale(l)) return;
  const request = ++selection;
  await loadLocale(l);
  // A slow import must never overwrite a more recent language selection.
  if (request !== selection) return;
  useUiStore.getState().setLocale(l);
  applyDocumentLocale(l);
}

/** Side effects on <html>: lang, data-lang, text-expansion class, display-font class. */
function applyDocumentLocale(l: Locale): void {
  if (typeof document === 'undefined') return;
  const meta = LOCALE_META[l];
  const root = document.documentElement;
  root.lang = meta.tag;
  root.dataset.lang = l;
  root.classList.toggle('lang-long', meta.expansion >= 1.2);
  root.classList.toggle('lang-alt-display', !meta.displayFontOk);
}

// ---------------------------------------------------------------- React
const subscribe = (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); };
const version = { n: 0 };
listeners.add(() => { version.n++; });

export type TFn = (key: MessageKey, vars?: Vars) => string;

/** Translator bound to the current locale; re-renders on locale change and on lazy locale load. */
export function useT(): TFn {
  const locale = useUiStore((s) => isLocale(s.locale) ? s.locale : 'en');
  const revision = useSyncExternalStore(subscribe, () => version.n, () => 0);
  const tag = LOCALE_META[locale].tag;
  return useCallback<TFn>((key, vars) => {
    const tpl = raw(locale, key);
    return vars ? interpolate(tpl, vars, tag) : tpl;
  }, [locale, tag, revision]);
}

export function useLocale(): { locale: Locale; meta: LocaleMeta; setLocale: (l: Locale) => Promise<void> } {
  const locale = useUiStore((s) => isLocale(s.locale) ? s.locale : 'en');
  return { locale, meta: LOCALE_META[locale], setLocale };
}

/** Non-hook translator for toasts / flows outside React (uses the current locale). */
export function t(key: MessageKey, vars?: Vars): string {
  const locale = getLocale();
  const tpl = raw(locale, key);
  return vars ? interpolate(tpl, vars, LOCALE_META[locale].tag) : tpl;
}

/** Locale-aware formatting helpers that do NOT touch bigint money math. */
export const fmtLocale = {
  int: (n: number, l: Locale = getLocale()) => new Intl.NumberFormat(LOCALE_META[l].tag).format(n),
  date: (d: Date | string | number, l: Locale = getLocale(), opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }) => {
    const dt = typeof d === 'string' || typeof d === 'number' ? new Date(d) : d;
    if (!dt || Number.isNaN(dt.getTime())) return '—';
    return new Intl.DateTimeFormat(LOCALE_META[l].tag, opts).format(dt);
  },
  dateTime: (d: Date | string | number, l: Locale = getLocale()) => {
    const dt = typeof d === 'string' || typeof d === 'number' ? new Date(d) : d;
    if (!dt || Number.isNaN(dt.getTime())) return '—';
    return new Intl.DateTimeFormat(LOCALE_META[l].tag, { dateStyle: 'medium', timeStyle: 'short' }).format(dt);
  },
  relative: (fromMs: number, l: Locale = getLocale()) => {
    if (!Number.isFinite(fromMs)) return '—';
    const rtf = new Intl.RelativeTimeFormat(LOCALE_META[l].tag, { numeric: 'auto' });
    const s = Math.round((fromMs - Date.now()) / 1000);
    const abs = Math.abs(s);
    if (abs < 60) return rtf.format(s, 'second');
    if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
    if (abs < 86_400) return rtf.format(Math.round(s / 3600), 'hour');
    return rtf.format(Math.round(s / 86_400), 'day');
  },
};

/** Boot: pick persisted/detected locale, load it, apply to <html>. Call once from main.tsx. */
export async function initI18n(): Promise<Locale> {
  const st = useUiStore.getState();
  const query = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('lang');
  const l = isLocale(query) ? query : st.localeExplicit && isLocale(st.locale) ? st.locale : detectLocale();
  if (isLocale(query)) st.setLocale(query);
  if (l !== st.locale) useUiStore.setState({ locale: l });
  await loadLocale(l);
  applyDocumentLocale(l);
  return l;
}
