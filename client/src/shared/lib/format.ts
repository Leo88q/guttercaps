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
  const w = whole.toLocaleString('en-US');
  return `${neg ? '−' : ''}${w}${frac ? `.${frac}` : ''}`;
}

export const fmtSol = (lamports: bigint | string | number | undefined | null, maxFrac = 3) => `${fmtUnits(lamports, 9, maxFrac)} SOL`;
export const fmtUsdc = (micro: bigint | string | number | undefined | null) => `${fmtUnits(micro, 6, 2, 2)} USDC`;
export const fmtCg = (micro: bigint | string | number | undefined | null, maxFrac = 2) => `${fmtUnits(micro, 6, maxFrac)} $CG`;
export const fmtSkr = (micro: bigint | string | number | undefined | null, maxFrac = 2) => `${fmtUnits(micro, 6, maxFrac)} SKR`;

export type CurrencySymbol = 'SOL' | 'USDC' | 'CG' | 'SKR';
/** Currency codes shared with the programs: 0 SOL · 1 USDC · 2 CG · 3 SKR. */
export const CURRENCY_SYMBOLS: Record<number, CurrencySymbol> = { 0: 'SOL', 1: 'USDC', 2: 'CG', 3: 'SKR' };
export const CURRENCY_CODES: Record<CurrencySymbol, number> = { SOL: 0, USDC: 1, CG: 2, SKR: 3 };
export const CURRENCY_DECIMALS: Record<CurrencySymbol, number> = { SOL: 9, USDC: 6, CG: 6, SKR: 6 };
export const fmtUsd = (usd: number | undefined | null) => (usd === undefined || usd === null ? '—' : `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
export const fmtCents = (cents: number) => fmtUsd(cents / 100);
export const fmtPct = (bps: number, frac = 2) => `${(bps / 100).toFixed(frac)}%`;
export const fmtProb = (p: number, frac = 1) => `${(p * 100).toFixed(frac)}%`;

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
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export function countdown(toIso: string | number | Date): string {
  const t = typeof toIso === 'number' ? toIso : new Date(toIso).getTime();
  let s = Math.max(0, Math.round((t - Date.now()) / 1000));
  const d = Math.floor(s / 86_400); s -= d * 86_400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function parseUnits(input: string, decimals: number): bigint | null {
  const s = input.trim().replace(',', '.');
  if (!/^\d*(\.\d*)?$/.test(s) || s === '' || s === '.') return null;
  const [w, f = ''] = s.split('.');
  const frac = (f + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(w || '0') * 10n ** BigInt(decimals) + BigInt(frac || '0');
}

export const secondsToHuman = (sec: number) => (sec === 0 ? 'none' : sec < 3600 ? `${sec / 60} min` : sec < 86_400 ? `${sec / 3600} h` : `${sec / 86_400} d`);

/**
 * Mint number of a chip (`Name #N`). `chips.game_index` is resolved on chain — the API reports
 * `index: null` until it is (see SEC-B3 / shape #27 in SECURITY-AUDIT-2026-09-26.md), and `#null`
 * or a placeholder `#0` would both be lies: `#0` is the first chip ever minted in that district.
 * Returns `null` so the caller can drop the fragment instead of rendering it.
 */
export const chipIndexText = (index: number | null | undefined): string | null =>
  index === null || index === undefined ? null : `#${index}`;
