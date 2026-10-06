// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { clearWait, resetWaitForTest, setWait, TX_PHASES } from '@/shared/lib/waitStatus';
import { t } from '@/shared/i18n';
import { WaitStatusPill } from './WaitStatusPill';

afterEach(() => { cleanup(); resetWaitForTest(); });

it('renders nothing while no wallet step is in flight', () => {
  const { container } = render(<WaitStatusPill />);
  expect(container.innerHTML).toBe('');
});

it('explains the wallet-popup pause for the connect phase', () => {
  render(<WaitStatusPill />);
  act(() => setWait('connect'));
  expect(screen.getByRole('status').textContent).toContain(t('wait.connect'));
  expect(screen.getByRole('status').textContent).toContain(t('wait.connectHint'));
});

it('explains the signing pause and the on-chain wait, linking the explorer once signed', () => {
  render(<WaitStatusPill />);
  act(() => setWait('wallet'));
  expect(screen.getByRole('status').textContent).toContain(t('wait.wallet'));
  expect(screen.getByRole('status').textContent).toContain(t('wait.walletHint'));
  expect(screen.queryByRole('link')).toBeNull();
  act(() => setWait('confirm', 'sig9Abc'));
  expect(screen.getByRole('status').textContent).toContain(t('wait.confirm'));
  expect(screen.getByRole('status').textContent).toContain(t('wait.confirmHint'));
  const link = screen.getByRole('link', { name: t('common.viewTx') });
  expect(link.getAttribute('href')).toContain('sig9Abc');
  act(() => clearWait(...TX_PHASES));
  expect(screen.queryByRole('status')).toBeNull();
});
