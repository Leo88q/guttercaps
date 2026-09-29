// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { LOCALES, LOCALE_META, setLocale, t } from '@/shared/i18n';
import { amountText, joinText, percentText, resolveUiText, usdText, type UiText } from '@/shared/i18n/message';
import { fmtAmount, fmtPct, fmtUsd } from '@/shared/lib/format';
import { chipName, chipNameText, leagueName, leagueText } from '@/shared/lib/rarity';
import { phaseLabel, phaseText } from '@/shared/lib/presentation';
import { rewardText, rewardTotalText } from '@/shared/lib/rewardText';
import { useUiStore } from '@/app/store/ui';
import { Toasts } from './primitives';

afterEach(async () => { cleanup(); vi.useRealTimers(); useUiStore.setState({ toasts: [] }); await act(() => setLocale('en')); });

it('the same success/info/money/error notifications retranslate nested words, currencies and odds in every locale', async () => {
  const atoms = 18446744073709551615n;
  const body = joinText([chipNameText(0, 0), amountText(atoms, 'SKR'), percentText(8123), usdText(1234.56)], ' · ');
  const serialized = JSON.stringify(body);
  const notifications = [
    { kind: 'success' as const, title: { key: 'screens.transactionDone' as const, params: { action: { key: 'market.buy' as const } } }, body },
    { kind: 'info' as const, title: { key: 'screens.unfinishedPack' as const }, body: { key: 'screens.resumePack' as const, params: { nonce: '123456', phase: phaseText('revealing') } }, href: '/shop/opening/123456' },
    { kind: 'money' as const, title: { key: 'screens.wagerOpen' as const }, body: { key: 'screens.escrowWaiting' as const, params: { amount: amountText(atoms, 'CG') } }, href: 'https://explorer.solana.com/tx/test' },
    { kind: 'error' as const, title: { key: 'fusion.failed' as const }, body: { key: 'screens.fusionRoll' as const, params: { roll: percentText(8123), threshold: percentText(8000) } } },
  ];
  act(() => notifications.forEach(n => useUiStore.getState().toast({ ...n, ttlMs: 0 })));
  const saved = useUiStore.getState().toasts;
  render(<MemoryRouter><Toasts /></MemoryRouter>);
  for (const locale of LOCALES) {
    await act(() => setLocale(locale));
    expect(screen.getByText(t('screens.transactionDone', { action: t('market.buy') }))).toBeTruthy();
    expect(screen.getByText([chipName(0, 0), fmtAmount(atoms, 'SKR'), fmtPct(8123), fmtUsd(1234.56)].join(' · '), { normalizer: value => value })).toBeTruthy();
    expect(screen.getByText(t('screens.resumePack', { nonce: '123456', phase: phaseLabel('revealing') }))).toBeTruthy();
    expect(screen.getByText(t('screens.escrowWaiting', { amount: fmtAmount(atoms, 'CG') }), { normalizer: value => value })).toBeTruthy();
    expect(screen.getByText(t('screens.fusionRoll', { roll: fmtPct(8123), threshold: fmtPct(8000) }), { normalizer: value => value })).toBeTruthy();
    expect(screen.getByRole('link', { name: t('home.resume') }).getAttribute('target')).toBeNull();
    expect(screen.getByRole('link', { name: t('ui.explorer') }).getAttribute('href')).toBe('https://explorer.solana.com/tx/test');
    expect(useUiStore.getState().toasts).toBe(saved); // no event replay, no new IDs, no timer restart
    expect(JSON.stringify(body)).toBe(serialized);
  }
});

for (const locale of LOCALES) it(`${locale}: reward receipts keep token atoms, booster counts, voucher IDs and league IDs distinct`, async () => {
  await act(() => setLocale(locale));
  for (const currency of ['SOL', 'USDC', 'CG', 'SKR'] as const) {
    const descriptor = JSON.parse(JSON.stringify(amountText('18446744073709551615', currency))) as UiText;
    expect(resolveUiText(descriptor)).toBe(fmtAmount(18446744073709551615n, currency));
  }
  expect(resolveUiText(rewardText(2, '1234567890'))).toBe(fmtAmount(1234567890n, 'CG'));
  expect(resolveUiText(rewardText(5, '1234567890'))).toBe(fmtAmount(1234567890n, 'SKR'));
  expect(resolveUiText(rewardText(8, '18446744073709551615'))).toBe(t('quests.boosterLeaf', { n: 18446744073709551615n }));
  const voucher = resolveUiText(rewardText(9, '0'));
  expect(voucher).toContain(fmtPct(8000));
  expect(voucher).toContain(fmtPct(1800));
  expect(voucher).toContain(fmtPct(200));
  expect(voucher).not.toMatch(/SOL|USDC|SKR|\$CG/);
  expect(resolveUiText(rewardTotalText(1000000n, 2000000n, 3n))).toBe(`${fmtAmount(1000000n, 'CG')} + ${fmtAmount(2000000n, 'SKR')} + ${t('quests.boosterLeaf', { n: 3 })}`);
  expect(resolveUiText(rewardTotalText(0n, 0n, 0n))).toBe(fmtAmount(0n, 'CG'));
  expect(resolveUiText(leagueText(2))).toBe(leagueName(2));
  expect(resolveUiText(usdText(null))).toBe('—');
  expect(fmtUsd(0.0123, 4)).toBe(new Intl.NumberFormat(LOCALE_META[locale].tag, { style: 'currency', currency: 'USD', minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(0.0123));
});

it('locale changes do not extend the 4500ms notification lifetime', async () => {
  vi.useFakeTimers();
  act(() => { useUiStore.getState().toast({ kind: 'success', title: { key: 'common.copied' } }); });
  render(<Toasts />);
  act(() => vi.advanceTimersByTime(4000));
  await act(() => setLocale('ru'));
  expect(screen.getByText(t('common.copied'))).toBeTruthy();
  act(() => vi.advanceTimersByTime(499));
  expect(useUiStore.getState().toasts).toHaveLength(1);
  act(() => vi.advanceTimersByTime(1));
  expect(useUiStore.getState().toasts).toHaveLength(0);
});

it('resume links navigate inside the app, while user handles remain literal escaped data', async () => {
  function Location() { return <output data-testid="location">{useLocation().pathname}</output>; }
  act(() => { useUiStore.getState().toast({ kind: 'info', title: { key: 'screens.unfinishedFusion' }, body: '@<script>my_handle</script>', href: '/fusion', ttlMs: 0 }); });
  render(<MemoryRouter><Toasts /><Location /></MemoryRouter>);
  await act(() => setLocale('vi'));
  expect(screen.getByText('@<script>my_handle</script>')).toBeTruthy();
  expect(document.querySelector('script')).toBeNull();
  fireEvent.click(screen.getByRole('link', { name: t('home.resume') }));
  expect(screen.getByTestId('location').textContent).toBe('/fusion');
});
