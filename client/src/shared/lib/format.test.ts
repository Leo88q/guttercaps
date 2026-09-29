import { afterEach, describe, expect, it } from 'vitest';
import { LOCALES, LOCALE_META, setLocale, fmtLocale } from '@/shared/i18n';
import { fmtUnits, fmtDecimal, fmtUsd, fmtProb, inputUnits, parseUnits, secondsToHuman, timeAgo } from './format';

afterEach(() => setLocale('en'));
describe('locale-safe money and time', () => {
  for (const locale of LOCALES) {
    it(`${locale}: preserves bigint precision and input round-trips`, async () => {
      await setLocale(locale);
      const value = 9007199254740993123456n;
      const whole = 9007199254740993n;
      const nf = new Intl.NumberFormat(LOCALE_META[locale].tag);
      const decimal = nf.formatToParts(1.1).find((p) => p.type === 'decimal')!.value;
      expect(fmtUnits(value, 6, 6)).toBe(`${nf.format(whole)}${decimal}123456`);
      expect(inputUnits(value, 6)).toBe('9007199254740993.123456');
      expect(parseUnits(inputUnits(value, 6), 6)).toBe(value);
      expect(parseUnits('1234,56', 6)).toBe(1234560000n);
      expect(parseUnits('1.234,56', 6)).toBeNull(); // never guess ambiguous grouped money
      expect(secondsToHuman(3600)).toBe(new Intl.NumberFormat(LOCALE_META[locale].tag, { style: 'unit', unit: 'hour', unitDisplay: 'short' }).format(1));
      expect(timeAgo(Date.now() - 86400000)).not.toContain('undefined');
    });
  }
  it('does not round or change token precision when localizing', async () => {
    await setLocale('ru');
    expect(fmtUnits(123456789n, 6, 2)).toBe('123,45');
    expect(fmtUnits(-123456789n, 6, 2)).toBe('−123,45');
    expect(fmtUnits(0n, 6, 2, 2)).toBe('0,00');
  });
});


describe('display-only metrics and USD', () => {
  for (const locale of LOCALES) it(`${locale}: precision, percent scale, missing/zero data and dates`, async () => {
    await setLocale(locale);
    const tag = LOCALE_META[locale].tag;
    for (const value of [0, 1.08, 1.255, -1234.567, 1234567.89]) {
      expect(fmtDecimal(value)).toBe(new Intl.NumberFormat(tag, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value));
      expect(fmtUsd(value)).toBe(new Intl.NumberFormat(tag, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value));
    }
    expect(fmtProb(58.6 / 100, 1)).toBe(new Intl.NumberFormat(tag, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(0.586));
    for (const value of [undefined, null, NaN, Infinity, -Infinity]) {
      expect(fmtDecimal(value)).toBe('—');
      expect(fmtUsd(value)).toBe('—');
    }
    const time = Date.UTC(2026, 8, 29, 12, 34, 56);
    expect(fmtLocale.date(time, undefined, { dateStyle: 'short', timeZone: 'UTC' })).toBe(new Intl.DateTimeFormat(tag, { dateStyle: 'short', timeZone: 'UTC' }).format(time));
    expect(fmtDecimal(1.2, 2, 0)).toBe(new Intl.NumberFormat(tag, { maximumFractionDigits: 2 }).format(1.2));
    expect(fmtDecimal(1234.56, 0)).toBe(new Intl.NumberFormat(tag, { maximumFractionDigits: 0 }).format(1234.56));
  });
});
