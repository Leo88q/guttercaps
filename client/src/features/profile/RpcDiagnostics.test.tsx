// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { diagnoseRpc } from '@/chain/rpcDiagnostics';
import { setLocale, t } from '@/shared/i18n';
import { RpcDiagnostics } from './RpcDiagnostics';
let endpoint = 'https://active.invalid?api-key=PRIVATE';
vi.mock('@solana/wallet-adapter-react', () => ({ useConnection: () => ({ connection: { rpcEndpoint: endpoint } }) }));
vi.mock('@/api/client', () => ({ isMock: () => false }));
vi.mock('@/chain/rpcDiagnostics', () => ({ diagnoseRpc: vi.fn() }));
beforeEach(async () => { vi.clearAllMocks(); endpoint = 'https://active.invalid?api-key=PRIVATE'; await setLocale('en'); });
afterEach(cleanup);

it('is opt-in and passes the active connection, not the configured default, to the read-only probe', async () => {
  vi.mocked(diagnoseRpc).mockResolvedValue({ version: 1 } as never);
  render(<RpcDiagnostics />);
  expect(diagnoseRpc).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: t('profile.rpcCheck') }));
  await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toContain('"version": 1'));
  expect(diagnoseRpc).toHaveBeenCalledWith(endpoint, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(document.body.textContent).not.toContain('PRIVATE');
  expect(screen.getByRole('button', { name: t('profile.rpcDownload') })).toBeTruthy();
});

it('cancels an in-flight probe on RPC change or unmount', async () => {
  vi.mocked(diagnoseRpc).mockImplementation(() => new Promise(() => {}));
  const view = render(<RpcDiagnostics />);
  fireEvent.click(screen.getByRole('button', { name: t('profile.rpcCheck') }));
  const first = vi.mocked(diagnoseRpc).mock.calls[0][1].signal;
  endpoint = 'https://different.invalid';
  view.rerender(<RpcDiagnostics />);
  expect(first.aborted).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: t('profile.rpcCheck') }));
  const second = vi.mocked(diagnoseRpc).mock.calls[1][1].signal;
  view.unmount();
  expect(second.aborted).toBe(true);
});

it('has an explicit cancel action and does not start a second simultaneous probe', async () => {
  vi.mocked(diagnoseRpc).mockImplementation(() => new Promise(() => {}));
  render(<RpcDiagnostics />);
  const button = screen.getByRole('button', { name: t('profile.rpcCheck') });
  fireEvent.click(button); fireEvent.click(button);
  expect(diagnoseRpc).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: t('common.cancel') }));
  expect(vi.mocked(diagnoseRpc).mock.calls[0][1].signal.aborted).toBe(true);
});
