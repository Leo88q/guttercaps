// @vitest-environment happy-dom
// Регрессия находки 29: награды soft-стейкинга фишек начислялись, но забрать их из продукта было нельзя —
// `POST /staking/soft/claim` не вызывался ни из одного экрана, `pending_micro` рос вечно, а кранк платил
// только по заявкам, которых никто не создавал.
//
// Здесь рендерится реальная карточка: накопленное видно, заявка уходит ровно одним вызовом claim, и
// игрок сразу видит, что выплата в очереди (деньги выводит кранк, кошелёк ничего не подписывает).
// Отдельно проверяется, что карточка действительно стоит на экране стейкинга.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useUiStore } from '@/app/store/ui';
import { setLocale, t } from '@/shared/i18n';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/api/client', () => ({
  isMock: () => false,
  api: { get: mocks.get, post: mocks.post },
}));
import { SoftStakingCard } from './SoftStakingCard';

const root = path.resolve(process.cwd(), process.cwd().endsWith('/client') ? '..' : '.');
const src = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

const me = {
  staked: [{ asset: 'Cap1', stakedAt: 1_700_000_000 }],
  pendingMicro: '125000000', // 125 $CG
  claimedMicro: '0',
  payouts: [] as { id: number; amountMicro: string; status: string; txSig: string | null }[],
};

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SoftStakingCard />
    </QueryClientProvider>,
  );
}

afterEach(async () => {
  cleanup();
  vi.clearAllMocks();
  useUiStore.setState({ toasts: [] });
  await act(() => setLocale('en'));
});

it('накопленное видно, заявка уходит одним вызовом claim и сообщает номер выплаты', async () => {
  await act(() => setLocale('en'));
  mocks.get.mockResolvedValue(me);
  mocks.post.mockResolvedValue({ payoutId: 7, amountMicro: '125000000', status: 'pending' });
  mount();

  await waitFor(() => expect(screen.getByText(t('staking.softPending'))).toBeTruthy());
  await waitFor(() => expect(document.body.textContent).toContain('125')); // накопленное показано
  expect(document.body.textContent).toContain('1'); // одна фишка в стейке
  expect(mocks.get).toHaveBeenCalledWith('/staking/soft/me');

  fireEvent.click(screen.getByRole('button', { name: t('staking.softClaim') }));
  await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/staking/soft/claim'));
  expect(mocks.post).toHaveBeenCalledTimes(1); // заявка одна: повторный клик не создаёт вторую выплату
  await waitFor(() => expect(useUiStore.getState().toasts.length).toBeGreaterThan(0));
  const toast = useUiStore.getState().toasts.at(-1)!;
  // игрок видит, что выплата в очереди, и её номер — деньги уходят не по клику, а кранком
  expect((toast.body as { key: string }).key).toBe('staking.softQueued');
  expect((toast.body as { params: Record<string, unknown> }).params.id).toBe('7');
  // сумма — точное количество, а не «застывшая» строка формата: язык можно сменить после клика
  expect((toast.body as { params: Record<string, unknown> }).params.amount)
    .toEqual({ format: 'amount', atoms: '125000000', currency: 'CG' });
});

it('при нулевом накопленном заявка недоступна — кранк не должен платить «ноль»', async () => {
  await act(() => setLocale('en'));
  mocks.get.mockResolvedValue({ ...me, pendingMicro: '0' });
  mount();
  const btn = await screen.findByRole('button');
  await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(true));
  expect(btn.textContent).toBe(t('staking.softNothing'));
  fireEvent.click(btn);
  expect(mocks.post).not.toHaveBeenCalled();
});

it('карточка стоит на экране стейкинга и живёт только там, где эндпоинты включены', () => {
  const page = src('client/src/features/staking/Staking.tsx');
  expect(page).toContain("import { SoftStakingCard } from './SoftStakingCard';");
  expect(page).toContain('<SoftStakingCard />');
  // в полном запуске (launchPhase 'full') /staking/soft/* отвечает 410 — раздел не показываем
  expect(page).toContain("FLAGS.launchPhase !== 'full' && <SoftStakingCard />");
});
