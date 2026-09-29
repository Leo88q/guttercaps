// Local build assets only: no wallet, API, RPC, translation service or cross-origin request.
import type { Locale } from '@/shared/i18n';
import { formatLegalCopy, LEGAL_REVISION, type LegalCopy } from './legal';
import english from './legal-copy/en.json';
import source from './legal-copy/source.json';

const loaders = {
  pt: () => import('./legal-copy/pt.json'),
  es: () => import('./legal-copy/es.json'),
  vi: () => import('./legal-copy/vi.json'),
  id: () => import('./legal-copy/id.json'),
  fil: () => import('./legal-copy/fil.json'),
  ru: () => import('./legal-copy/ru.json'),
};

/** Exact paragraph/placeholder parity, rather than a silently partial English fallback. */
export function validateLegalCopy(bundle: unknown): LegalCopy {
  const b = bundle as { revision?: string; sha256?: string; docs?: unknown } | null;
  if (!b || b.revision !== LEGAL_REVISION || source.revision !== LEGAL_REVISION || b.sha256 !== source.sha256) {
    throw new Error('Legal translation revision/source mismatch');
  }
  const walk = (actual: unknown, expected: unknown, path: string) => {
    if (typeof expected === 'string') {
      if (typeof actual !== 'string' || !actual.trim() || (/<\/?[a-z]/i.test(actual) || /\b(?:TODO|TBD)\b/.test(actual))) {
        throw new Error(`Invalid legal text: ${path}`);
      }
      const vars = (s: string) => JSON.stringify((s.match(/\{\w+\}/g) ?? []).sort());
      if (vars(actual) !== vars(expected) || (path.endsWith('.slug') && actual !== expected)) {
        throw new Error(`Legal placeholder/slug mismatch: ${path}`);
      }
      return;
    }
    if (expected === null || typeof expected !== 'object' || actual === null || typeof actual !== 'object'
      || Array.isArray(actual) !== Array.isArray(expected)) throw new Error(`Invalid legal structure: ${path}`);
    const a = actual as Record<string, unknown>, e = expected as Record<string, unknown>;
    if (JSON.stringify(Object.keys(a).sort()) !== JSON.stringify(Object.keys(e).sort())) {
      throw new Error(`Legal section/paragraph mismatch: ${path}`);
    }
    for (const key of Object.keys(e)) walk(a[key], e[key], `${path}.${key}`);
  };
  walk(b.docs, english, 'docs');
  return b.docs as LegalCopy;
}

const pending = new Map<Locale, Promise<LegalCopy>>();
export function loadLegalCopy(locale: Locale): Promise<LegalCopy> {
  const existing = pending.get(locale);
  if (existing) return existing;
  const request = (locale === 'en'
    ? Promise.resolve(english as LegalCopy)
    : loaders[locale]().then(module => validateLegalCopy(module.default)))
    .then(copy => formatLegalCopy(copy, locale))
    .catch(error => { pending.delete(locale); throw error; });
  pending.set(locale, request);
  return request;
}
