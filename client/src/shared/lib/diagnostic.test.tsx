// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { LOCALES, LOCALE_META, setLocale, t } from '@/shared/i18n';
import { ProposalView } from '@/features/admin/Admin';
import { diagnosticText, warningText, fraudSignalLabel } from './diagnostic';
import english from '@/shared/i18n/diagnostics/en.json';
import type { components } from '@/api/schema';

type Diagnostic = components['schemas']['AdminDiagnostic'];
afterEach(async () => { cleanup(); await act(() => setLocale('en')); });

describe('stable server diagnostics', () => {
  for (const locale of LOCALES) {
    it(`${locale}: all 46 known diagnostics, complete parameters, unknown text preserved`, async () => {
      await act(() => setLocale(locale));
      for (const [code, template] of Object.entries(english)) {
        const params = Object.fromEntries([...template.matchAll(/\{(\w+)\}/g)].map(([, key]) =>
          [key, key === 'nextAt' ? Date.UTC(2026, 8, 29) : key.endsWith('Micro') ? '18446744073709551615' : key === 'program' ? 'chip_core' : key === 'field' ? 'treasury' : 1234.5],
        ));
        const text = diagnosticText({ code, params }, 'untranslated sentinel');
        expect(text).not.toBe('untranslated sentinel');
        expect(text).not.toMatch(/\{\w+\}|diagnostics\./);
      }
      expect(diagnosticText({ code: 'future_code' }, 'RPC 9901: original detail')).toBe('RPC 9901: original detail');
      expect(diagnosticText({ code: 'constructor' }, 'original')).toBe('original');
      expect(diagnosticText({ code: 'marketCap' }, 'missing values')).toBe('missing values');
      expect(diagnosticText({ code: 'cgCap', params: { maxMicro: '18446744073709551615' } }, 'bad')).toContain(new Intl.NumberFormat(LOCALE_META[locale].tag).format(18446744073709551615n));
      expect(fraudSignalLabel('win_trading')).toBe(t('diagnostics.win_trading'));
      expect(fraudSignalLabel('future_signal')).toBe('future_signal');
    });

    it(`${locale}: proposal violations and warnings render in the selected language without changing instruction bytes`, async () => {
      await act(() => setLocale(locale));
      const original = 'market fee below the modelled 750 bps';
      const proposal = {
        ok: true,
        violations: [{ path: 'marketFeeBps', rule: 'FeeTooHigh', message: 'market fee is capped at 1000 bps', i18n: { code: 'marketCap', params: { max: 1000 } } }],
        warnings: [original], warningDetails: [{ code: 'lowMarketFee', params: { bps: 750 }, message: original }],
        instructions: [{ program: 'chip_core', name: 'set_params', data: 'AQIDBA==', accounts: [] }],
      };
      const before = JSON.stringify(proposal);
      render(<ProposalView p={proposal} />);
      expect(screen.getByTestId('proposal').textContent).toContain(t('diagnostics.marketCap', { max: 1000 }));
      expect(screen.getByTestId('proposal').textContent).toContain(t('diagnostics.lowMarketFee', { bps: 750 }));
      expect(screen.getByTestId('proposal').textContent).not.toContain(original);
      expect(screen.getByTestId('proposal').textContent).toContain('AQIDBA==');
      expect(JSON.stringify(proposal)).toBe(before);
    });
  }

  it('retranslates an already displayed proposal and a retained error after switching language', async () => {
    render(<ProposalView p={{ ok: false, error: new Error('User rejected'), violations: [{ path: 'packs', rule: 'OddsSumInvalid', message: 'old English', i18n: { code: 'oddsSum', params: { sum: 9000 } } }] }} />);
    await act(() => setLocale('ru'));
    expect(screen.getByTestId('proposal').textContent).toContain(t('diagnostics.oddsSum', { sum: 9000 }));
    expect(screen.getByTestId('proposal').textContent).toContain(t('errors.rejected'));
    expect(screen.getByTestId('proposal').textContent).not.toContain('old English');
  });

  it('never hides unknown codes, mismatched warning metadata or malformed values', () => {
    const original = 'Unrecognized backend detail — keep this intact';
    expect(warningText(original, { code: 'empty', message: 'some different message' })).toBe(original);
    expect(warningText(original, { code: 'new_code', message: original })).toBe(original);
    expect(diagnosticText({ code: 'splitCooldown', params: { hours: 1, nextAt: Number.NaN } }, original)).toBe(original);
    expect(diagnosticText({ code: 'cgCap', params: { maxMicro: '1.2' } }, original)).toBe(original);
    expect(diagnosticText({ code: 'marketCap', params: { max: null } } as unknown as Diagnostic, original)).toBe(original);
  });
});
