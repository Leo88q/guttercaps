import type { components } from '@/api/schema';
import { t, getLocale, LOCALE_META, type MessageKey } from '@/shared/i18n';
import english from '@/shared/i18n/diagnostics/en.json';

type Diagnostic = components['schemas']['AdminDiagnostic'];

/** Translate stable API codes, never parse arbitrary server prose. Preserve unknown/malformed diagnostics. */
export function diagnosticText(diagnostic: Diagnostic | undefined, fallback: string): string {
  if (!diagnostic || !Object.hasOwn(english, diagnostic.code)) return fallback;
  const code = diagnostic.code as keyof typeof english;
  const expected = [...english[code].matchAll(/\{(\w+)\}/g)].map(m => m[1]);
  const params: Record<string, string | number> = {};
  const tag = LOCALE_META[getLocale()].tag;
  for (const key of expected) {
    const value = diagnostic.params?.[key];
    if ((typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'number' && !Number.isFinite(value))) return fallback;
    if (key === 'nextAt') {
      if (typeof value !== 'number' || !Number.isFinite(new Date(value).getTime())) return fallback;
      params[key] = new Intl.DateTimeFormat(tag, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(value) + ' UTC';
    } else if (key.endsWith('Micro')) {
      // Monetary atoms arrive as strings; never round them through Number.
      if (typeof value !== 'string' || !/^\d+$/.test(value)) return fallback;
      params[key] = new Intl.NumberFormat(tag).format(BigInt(value));
    } else params[key] = value;
  }
  const text = t(`diagnostics.${code}` as MessageKey, params);
  return diagnostic.context ? `${diagnostic.context}: ${text}` : text;
}

export function warningText(original: string, diagnostic: Diagnostic | undefined): string {
  // Avoid pairing a newer/older server's warning with mismatched parallel metadata.
  return diagnostic?.message === original ? diagnosticText(diagnostic, original) : original;
}

const SIGNALS = ['win_trading', 'wash_trade', 'quest_bot', 'multi_account', 'device_ring'];
export function fraudSignalLabel(kind: string): string {
  return SIGNALS.includes(kind) ? t(`diagnostics.${kind}` as MessageKey) : kind;
}
