// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LOCALES, setLocale, t } from '@/shared/i18n';
import { ApiError } from '@/api/client';
import { useUiStore } from '@/app/store/ui';
import { CHIP_CORE_ID } from '@/chain/ids';
import { ErrorNotice } from './ErrorNotice';
import { Toasts } from './primitives';
import { PackStepper } from '@/features/shop/PackStepper';
import { errorSnapshot } from '@/chain/errorSnapshot';
import { Currency } from '@/chain/ix/chipCore';

afterEach(async () => { cleanup(); useUiStore.setState({ toasts: [] }); await act(() => setLocale('en')); });

it('all seven locales update the same live error toast, including its action, detail control and close label', async () => {
  const error = new ApiError(409, 'payment_pending', 'Original pending message', { atoms: '18446744073709551615' });
  useUiStore.getState().toast({ kind: 'error', title: { key: 'screens.transactionFailed', params: { action: { key: 'market.buy' } } }, error, ttlMs: 0 });
  render(<Toasts />);
  for (const locale of LOCALES) {
    await act(() => setLocale(locale));
    expect(screen.getByText(t('screens.transactionFailed', { action: t('market.buy') }))).toBeTruthy();
    expect(screen.getByText(t('failures.paymentPending'))).toBeTruthy();
    fireEvent.click(screen.getByText(t('failures.details')));
    expect(useUiStore.getState().toasts).toHaveLength(1); // expanding details does not dismiss the toast
    expect(screen.getByText(/18446744073709551615/)).toBeTruthy();
    expect(screen.getByRole('button', { name: t('common.close') })).toBeTruthy();
  }
  fireEvent.click(screen.getByRole('button', { name: t('common.close') }));
  expect(useUiStore.getState().toasts).toHaveLength(0);
});

it('renders server markup as text, retains full unknown diagnostics and never invokes server HTML', () => {
  render(<ErrorNotice error={new ApiError(500, 'unknown_new_code', '<script>window.infected=true</script>' + 'x'.repeat(300))} />);
  expect(document.querySelector('script')).toBeNull();
  expect(screen.getAllByText(/window.infected/).length).toBeGreaterThan(0);
  expect(document.body.textContent).toContain('x'.repeat(300));
});

it('a restored pack error retains its program identity and follows locale switching', async () => {
  const diagnostic = JSON.parse(JSON.stringify(errorSnapshot({ message: 'commit failed', logs: [`Program ${CHIP_CORE_ID} failed: custom program error: 6006`] })));
  render(<PackStepper state={{ phase: 'error', error: diagnostic.message, errorDiagnostic: diagnostic, nonce: 1n, sku: 1, qty: 1, currency: Currency.SOL, opened: [], openSignatures: [] }} />);
  for (const locale of LOCALES) {
    await act(() => setLocale(locale));
    expect(document.body.textContent).toContain(t('failures.chip_core_DailyCapReached'));
    expect(document.body.textContent).toContain('6006 · DailyCapReached');
  }
});
