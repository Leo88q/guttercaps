import { t, type MessageKey, type Vars } from './index';
import { fmtAmount, fmtPct, fmtUsd, type CurrencySymbol } from '@/shared/lib/format';

/** Language-neutral text. Keep values, not locale-formatted strings or callbacks, in UI state. */
export interface MessageRef {
  key: MessageKey;
  params?: Record<string, string | number | bigint | undefined | TextRef>;
}
export type TextRef = MessageRef
  | { parts: UiText[]; separator?: string }
  | { format: 'amount'; atoms: string; currency: CurrencySymbol }
  | { format: 'percent'; bps: number; fraction: number }
  | { format: 'usd'; value: number | null };
export type UiText = string | TextRef;

/** Monetary atoms remain exact decimal strings; these descriptors must never feed a transaction. */
export const amountText = (atoms: bigint | string, currency: CurrencySymbol): TextRef => ({ format: 'amount', atoms: String(atoms), currency });
export const percentText = (bps: number, fraction = 2): TextRef => ({ format: 'percent', bps, fraction });
export const usdText = (value: number | null | undefined): TextRef => ({ format: 'usd', value: value ?? null });
export const joinText = (parts: UiText[], separator = ''): TextRef => ({ parts, separator });

export function resolveUiText(value: UiText): string {
  if (typeof value === 'string') return value;
  if ('parts' in value) return value.parts.map(resolveUiText).join(value.separator ?? '');
  if ('format' in value) {
    switch (value.format) {
      case 'amount': return fmtAmount(value.atoms, value.currency);
      case 'percent': return fmtPct(value.bps, value.fraction);
      case 'usd': return fmtUsd(value.value);
    }
  }
  const vars: Vars = {};
  for (const [key, param] of Object.entries(value.params ?? {})) {
    vars[key] = param && typeof param === 'object' ? resolveUiText(param) : param;
  }
  return t(value.key, vars);
}
