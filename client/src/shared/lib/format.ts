import { getLocale, LOCALE_META, t } from '@/shared/i18n';

const localeTag = () => LOCALE_META[getLocale()].tag;

// All money is bigint in base units until it hits the screen.
export const LAMPORTS = 1_000_000_000n;
export const MICRO = 1_000_000n;

export function fmtUnits(v: bigint | string | number | undefined | null, decimals: number, maxFrac = 2, minFrac = 0): string {
  if (v === undefined || v === null || v === '') return '—';
  const n = BigInt(typeof v === 'number' ? Math.round(v) : v);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let frac = (abs % base).toString().padStart(decimals, '0').slice(0, maxFrac);
  frac = frac.replace(/0+$/, '');
  while (frac.length < minFrac) frac += '0';
  const nf = new Intl.NumberFormat(localeTag());
  const w = nf.format(whole);
  const decimal = nf.formatToParts(1.1).find((p) => p.type === 'decimal')?.value ?? '.';
  return `${neg ? '−' : ''}${w}${frac ? `${decimal}${frac}` : ''}`;
}

export const fmtSol = (lamports: bigint | string | number | undefined | null, maxFrac = 3) => `${fmtUnits(lamports, 9, maxFrac)} SOL`;
const fmtUsdc = (micro: bigint | string | number | undefined | null) => `${fmtUnits(micro, 6, 2, 2)} USDC`;
export const fmtCg = (micro: bigint | string | number | undefined | null, maxFrac = 2) => `${fmtUnits(micro, 6, maxFrac)} $CG`;
export const fmtSkr = (micro: bigint | string | number | undefined | null, maxFrac = 2) => `${fmtUnits(micro, 6, maxFrac)} SKR`;

export type CurrencySymbol = 'SOL' | 'USDC' | 'CG' | 'SKR';
/** Currency codes shared with the programs: 0 SOL · 1 USDC · 2 CG · 3 SKR. */
export const CURRENCY_SYMBOLS: Record<number, CurrencySymbol> = { 0: 'SOL', 1: 'USDC', 2: 'CG', 3: 'SKR' };
/** Display-only decimal metrics (multipliers, power, counts). Never use this to build an instruction. */
export const fmtDecimal = (value: number | undefined | null, maxFrac = 2, minFrac = maxFrac): string =>
  value == null || !Number.isFinite(value) ? '—' : new Intl.NumberFormat(localeTag(), {
    minimumFractionDigits: minFrac, maximumFractionDigits: maxFrac,
  }).format(value);

export const fmtUsd = (usd: number | undefined | null, fraction = 2) => (usd === undefined || usd === null || !Number.isFinite(usd) ? '—' : new Intl.NumberFormat(localeTag(), { style: 'currency', currency: 'USD', minimumFractionDigits: fraction, maximumFractionDigits: fraction }).format(usd));
export const fmtCents = (cents: number) => fmtUsd(cents / 100);
export const fmtPct = (bps: number, frac = 2) => new Intl.NumberFormat(localeTag(), { style: 'percent', minimumFractionDigits: frac, maximumFractionDigits: frac }).format(bps / 10000);
export const fmtProb = (p: number, frac = 1) => new Intl.NumberFormat(localeTag(), { style: 'percent', minimumFractionDigits: frac, maximumFractionDigits: frac }).format(p);

export function fmtAmount(amount: bigint | string | number, currency: CurrencySymbol | number): string {
  const c = typeof currency === 'number' ? CURRENCY_SYMBOLS[currency] ?? 'SOL' : currency;
  return c === 'SOL' ? fmtSol(amount) : c === 'USDC' ? fmtUsdc(amount) : c === 'SKR' ? fmtSkr(amount) : fmtCg(amount);
}

export function shortKey(k: string | undefined | null, n = 4): string {
  if (!k) return '—';
  return k.length <= n * 2 + 1 ? k : `${k.slice(0, n)}…${k.slice(-n)}`;
}

export function timeAgo(iso: string | number | Date): string {
  const t = typeof iso === 'number' ? iso : new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  const rtf = new Intl.RelativeTimeFormat(localeTag(), { numeric: 'auto' });
  if (s < 60) return rtf.format(-s, 'second');
  if (s < 3600) return rtf.format(-Math.floor(s / 60), 'minute');
  if (s < 86_400) return rtf.format(-Math.floor(s / 3600), 'hour');
  return rtf.format(-Math.floor(s / 86_400), 'day');
}

export function countdown(toIso: string | number | Date): string {
  const t = typeof toIso === 'number' ? toIso : new Date(toIso).getTime();
  let s = Math.max(0, Math.round((t - Date.now()) / 1000));
  const d = Math.floor(s / 86_400); s -= d * 86_400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d > 0) return `${durationUnit(d, 'day')} ${durationUnit(h, 'hour')}`;
  if (h > 0) return `${durationUnit(h, 'hour')} ${durationUnit(m, 'minute')}`;
  return durationUnit(m, 'minute');
}

export function parseUnits(input: string, decimals: number): bigint | null {
  const s = input.trim().replace(',', '.');
  if (!/^\d*(\.\d*)?$/.test(s) || s === '' || s === '.') return null;
  const [w, f = ''] = s.split('.');
  const frac = (f + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(w || '0') * 10n ** BigInt(decimals) + BigInt(frac || '0');
}

function durationUnit(value: number, unit: 'day' | 'hour' | 'minute'): string {
  return new Intl.NumberFormat(localeTag(), { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: 2 }).format(value);
}
export const secondsToHuman = (sec: number) => sec === 0 ? t('common.none')
  : sec < 3600 ? durationUnit(sec / 60, 'minute')
  : sec < 86_400 ? durationUnit(sec / 3600, 'hour') : durationUnit(sec / 86_400, 'day');


/**
 * Mint number of a chip (`Name #N`). `chips.game_index` is resolved on chain — the API reports
 * `index: null` until it is (see SEC-B3 / shape #27 in SECURITY-AUDIT-2026-09-26.md), and `#null`
 * or a placeholder `#0` would both be lies: `#0` is the first chip ever minted in that district.
 * Returns `null` so the caller can drop the fragment instead of rendering it.
 */
export const chipIndexText = (index: number | null | undefined): string | null =>
  index === null || index === undefined ? null : `#${index}`;

/** Unlocalized, ungrouped editing value. Display formatting must NEVER be parsed
 * back into a transaction amount (e.g. pt-BR 1.234,56 is not 1.23456). */
export function inputUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const n = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const fraction = (n % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${n / base}${fraction ? `.${fraction}` : ''}`;
}
