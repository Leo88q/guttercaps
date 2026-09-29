// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Keypair } from '@solana/web3.js';
import { LOCALES, setLocale, t } from '@/shared/i18n';
import { useUiStore } from '@/app/store/ui';
import { SERVICE_BY_ID } from '@guttercaps/economy';
import { handleRefHash, quoteService } from '@/chain/flows/serviceFlow';

const mocks = vi.hoisted(() => ({
  check: vi.fn(), put: vi.fn(), pay: vi.fn(), invalidate: vi.fn(), mock: false,
  wallet: undefined as unknown, cfg: undefined as unknown, me: { handle: 'old_name' } as { handle?: string },
  response: { data: { available: true, reason: undefined as string | undefined }, isFetching: false, error: undefined as unknown },
}));
vi.mock('@/api/hooks', () => ({ useHandleCheck: (name: string) => { mocks.check(name); return mocks.response; }, useMe: () => ({ data: mocks.me }), useFloor: () => ({ data: { solUsd: 100, skrUsd: 0.1 } }) }));
vi.mock('@/api/client', async original => ({ ...await original<typeof import('@/api/client')>(), isMock: () => mocks.mock, api: { put: mocks.put }, claimWithRetry: (fn: () => Promise<unknown>) => fn() }));
vi.mock('@/chain/hooks', () => ({ useWalletLike: () => mocks.wallet, useGameConfig: () => ({ data: mocks.cfg }) }));
vi.mock('@solana/wallet-adapter-react', () => ({ useConnection: () => ({ connection: {} }) }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: mocks.invalidate }) }));
vi.mock('@/chain/flows/serviceFlow', async original => ({ ...await original<typeof import('@/chain/flows/serviceFlow')>(), payForService: mocks.pay }));
import { HandleModal } from './HandleModal';

const wallet = { publicKey: Keypair.generate().publicKey };
afterEach(async () => { cleanup(); vi.clearAllMocks(); mocks.mock = false; mocks.me = { handle: 'old_name' }; mocks.response = { data: { available: true, reason: undefined }, isFetching: false, error: undefined }; useUiStore.setState({ toasts: [] }); await act(() => setLocale('en')); });

for (const locale of LOCALES) it(`${locale}: service labels switch live and an old availability result cannot authorize a new handle`, async () => {
  await act(() => setLocale(locale));
  mocks.wallet = wallet; mocks.cfg = { skrMint: Keypair.generate().publicKey };
  mocks.pay.mockResolvedValue({ signature: 'test-signature' }); mocks.put.mockResolvedValue({ ok: true });
  const close = vi.fn();
  render(<HandleModal onClose={close} />);
  expect(screen.getByText(t('services.names.handleChange'))).toBeTruthy();
  const input = screen.getByRole('textbox', { name: t('profile.handle.label') }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'first_name' } });
  expect((screen.getByRole('button', { name: t('profile.handle.cta') }) as HTMLButtonElement).disabled).toBe(true);
  await waitFor(() => expect((screen.getByRole('button', { name: t('profile.handle.cta') }) as HTMLButtonElement).disabled).toBe(false));
  expect(mocks.check).toHaveBeenLastCalledWith('first_name');
  fireEvent.change(input, { target: { value: 'second_name' } });
  expect((screen.getByRole('button', { name: t('profile.handle.cta') }) as HTMLButtonElement).disabled).toBe(true);
  await act(() => setLocale(locale === 'en' ? 'ru' : 'en'));
  expect(input.value).toBe('second_name');
  expect(screen.getByText(t('services.names.handleChange'))).toBeTruthy();
  expect(mocks.pay).not.toHaveBeenCalled();
  await waitFor(() => expect((screen.getByRole('button', { name: t('profile.handle.cta') }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: t('profile.handle.cta') }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(mocks.pay).toHaveBeenCalledOnce();
  expect(mocks.pay.mock.calls[0][0]).toMatchObject({ id: 'handleChange', currency: 2, quote: quoteService('handleChange', 2, { solUsd: 100, skrUsd: 0.1 }), refHash: handleRefHash(1, wallet.publicKey, 'second_name') });
  expect(mocks.put).toHaveBeenCalledWith('/me/handle', { handle: 'second_name', signature: 'test-signature' });
});

it('first purchase uses the translated service, handles failed mock requests and permits retry', async () => {
  mocks.mock = true; mocks.me = {}; mocks.wallet = wallet; mocks.cfg = { skrMint: Keypair.generate().publicKey };
  mocks.put.mockRejectedValueOnce(new Error('test failure')).mockResolvedValueOnce({ ok: true });
  await act(() => setLocale('ru'));
  const close = vi.fn(); render(<HandleModal onClose={close} />);
  expect(screen.getByText(t('services.names.handle'))).toBeTruthy();
  expect(screen.queryByText(SERVICE_BY_ID.handle.name)).toBeNull();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'first_name' } });
  const button = () => screen.getByRole('button', { name: t('profile.handle.cta') }) as HTMLButtonElement;
  await waitFor(() => expect(button().disabled).toBe(false));
  fireEvent.click(button());
  await waitFor(() => expect(useUiStore.getState().toasts).toHaveLength(1));
  expect(useUiStore.getState().toasts[0].title).toEqual({ key: 'profile.handle.failed' });
  expect(close).not.toHaveBeenCalled();
  await waitFor(() => expect(button().disabled).toBe(false));
  fireEvent.click(button());
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(mocks.pay).not.toHaveBeenCalled();
});

for (const locale of LOCALES) it(`${locale}: availability reasons, refetching and failed checks never enable payment`, async () => {
  const { humanizeTxError } = await import('@/chain/errors');
  await act(() => setLocale(locale));
  mocks.wallet = wallet; mocks.cfg = { skrMint: Keypair.generate().publicKey };
  mocks.response.data = { available: false, reason: 'taken' };
  const close = vi.fn(), view = render(<HandleModal onClose={close} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'valid_name' } });
  await screen.findByText(t('profile.handle.reason.taken'));
  for (const reason of ['taken', 'reserved', 'blocked', 'cooldown', 'invalid'] as const) {
    mocks.response.data = { available: false, reason };
    view.rerender(<HandleModal onClose={close} />);
    expect(screen.getByText(t(`profile.handle.reason.${reason}`))).toBeTruthy();
    expect((screen.getByRole('button', { name: t('profile.handle.cta') }) as HTMLButtonElement).disabled).toBe(true);
  }
  mocks.response.data = { available: true, reason: undefined };
  mocks.response.isFetching = true;
  view.rerender(<HandleModal onClose={close} />);
  expect(screen.getByText(t('common.checking'))).toBeTruthy();
  expect((screen.getByRole('button', { name: t('profile.handle.cta') }) as HTMLButtonElement).disabled).toBe(true);
  mocks.response.error = new Error('Failed to fetch'); mocks.response.isFetching = false;
  view.rerender(<HandleModal onClose={close} />);
  expect(screen.getByText(humanizeTxError(mocks.response.error))).toBeTruthy();
  expect((screen.getByRole('button', { name: t('profile.handle.cta') }) as HTMLButtonElement).disabled).toBe(true);
  expect(mocks.pay).not.toHaveBeenCalled(); expect(mocks.put).not.toHaveBeenCalled();
});
