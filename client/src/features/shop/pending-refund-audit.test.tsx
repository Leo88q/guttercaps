// @vitest-environment happy-dom
// Регрессия находки 46 (клиентская половина): аварийного возврата залипшей покупки не было НИ В ОДНОМ экране.
//
// `cancel_stale_pack` требует подписи покупателя — кранк за игрока его подписать не может, значит кнопка
// обязана быть в продукте. Здесь рендерится реальная карточка: у залипшей покупки (`status: 'stale'`, так
// бэкенд помечает её по слоту `commit + STALE_PACK_SLOTS`) появляется возврат, у свежей — нет, у бесплатного
// ваучера — нет (возвращать нечего), а собранная инструкция — именно `cancel_stale_pack` с валютным минтом.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Keypair } from '@solana/web3.js';
import { ixDiscriminator } from '@/chain/anchor';
import { ata, vaultPda } from '@/chain/pdas';
import { useUiStore } from '@/app/store/ui';
import { useTxStore } from '@/app/store/txs';
import { setLocale, t } from '@/shared/i18n';

const BUYER = Keypair.generate().publicKey;
const RANDOMNESS = Keypair.generate().publicKey;

const mocks = vi.hoisted(() => ({
  pending: undefined as unknown,
  send: vi.fn(),
  invalidate: vi.fn(),
  cancelStale: vi.fn(),
  cancelClaimStale: vi.fn(),
}));

vi.mock('@/api/hooks', () => ({ usePendingOps: () => ({ data: mocks.pending, isLoading: false }) }));
vi.mock('@/api/client', () => ({ isMock: () => false, api: { get: vi.fn(), post: vi.fn() } }));
vi.mock('@/chain/hooks', () => ({
  useGameConfig: () => ({ data: null }),
  useWalletLike: () => ({ publicKey: BUYER, signTransaction: vi.fn() }),
}));
vi.mock('@solana/wallet-adapter-react', () => ({ useConnection: () => ({ connection: {} }) }));
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tanstack/react-query')>(),
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
}));
vi.mock('@/chain/tx', () => ({ sendTx: mocks.send }));
// Фьюжн-возврат идёт через реальный `FusionFlow` (он собирает `cancel_stale_fusion` и подписывает у владельца);
// в этом тесте проверяется именно ПОДКЛЮЧЕНИЕ: карточка появляется у залипшей записи и нажимает `cancelStale`.
vi.mock('@/chain/flows/fusionFlow', () => ({
  FusionFlow: class {
    state: Record<string, unknown>;
    constructor(_deps: unknown, init: Record<string, unknown>) { this.state = { phase: 'stale', ...init }; }
    cancelStale = mocks.cancelStale;
  },
}));
vi.mock('@/chain/flows/claimFusionFlow', () => ({
  ClaimFusionFlow: class {
    state: Record<string, unknown>;
    constructor(_deps: unknown, init: Record<string, unknown>) { this.state = { phase: 'stale', ...init }; }
    cancelStale = mocks.cancelClaimStale;
  },
}));
import { MINTS } from '@/app/config';
import { PendingOps, refundableCount, slotsUntilRefund } from './PendingOps';

const root = path.resolve(process.cwd(), process.cwd().endsWith('/client') ? '..' : '.');
const src = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

const pack = (over: Record<string, unknown>) => ({
  nonce: '12', sku: 1, qty: 3, opened: 0, commitSlot: 4_989_200, currentSlot: 5_000_000,
  refundSlot: 5_000_000, randomness: RANDOMNESS.toBase58(), status: 'awaiting_reveal',
  staleAt: '2026-11-03T00:00:00.000Z', currency: 'SOL', voucher: null, ...over,
});

afterEach(async () => {
  cleanup();
  vi.clearAllMocks();
  useUiStore.setState({ toasts: [] });
  await setLocale('en');
});

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><PendingOps /></QueryClientProvider>);
}

it('залипшая покупка возвращает деньги инструкцией cancel_stale_pack с валютным минтом', async () => {
  await setLocale('en');
  mocks.pending = { packs: [pack({ status: 'stale', currency: 'USDC' })], compressed: [], fusions: [] };
  mocks.send.mockResolvedValue({ signature: 'REFUNDSIG', logs: [] });
  mount();

  const btn = await screen.findByRole('button', { name: t('shop.refund') });
  fireEvent.click(btn);
  await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
  const ix = (mocks.send.mock.calls[0] as unknown[])[2] as { data: Uint8Array; keys: { pubkey: { toBase58(): string } }[] }[];
  expect(ix).toHaveLength(1);
  expect(Buffer.from(ix[0].data.subarray(0, 8)).toString('hex')).toBe(Buffer.from(ixDiscriminator('cancel_stale_pack')).toString('hex'));
  expect(ix[0].keys[0].pubkey.toBase58()).toBe(BUYER.toBase58());           // подписывает покупатель
  // SPL-оплата: возврат идёт на ATA покупателя из ATA хранилища — оба аккаунта в инструкции
  const usdc = MINTS.usdc!; // конфигурация сборки: devnet-минт USDC
  const vaultAta = ata(usdc, vaultPda()[0]);
  const buyerAta = ata(usdc, BUYER);
  const keys = ix[0].keys.map((k) => k.pubkey.toBase58());
  expect(keys).toContain(vaultAta.toBase58());
  expect(keys).toContain(buyerAta.toBase58());
  await waitFor(() => expect(useUiStore.getState().toasts.length).toBeGreaterThan(0));
  expect((useUiStore.getState().toasts.at(-1)!.title as { key: string }).key).toBe('shop.refunded');
  expect(mocks.invalidate).toHaveBeenCalled();
});

it('свежая покупка и бесплатный ваучер возврата не предлагают', async () => {
  await setLocale('en');
  mocks.pending = {
    packs: [pack({ nonce: 'a', status: 'awaiting_reveal' }), pack({ nonce: 'b', status: 'stale', sku: 0, voucher: { template: 1, odds: [], soulboundDays: 3 } })],
    compressed: [], fusions: [],
  };
  mount();
  await screen.findByText(t('shop.pendingTitle'));
  expect(screen.queryByRole('button', { name: t('shop.refund') })).toBeNull();
  expect(document.body.textContent).toContain(t('shop.pendingNoRefundYet'));
});

it('счётчики совпадают с границей контракта, а карточка стоит на витрине', () => {
  expect(refundableCount([{ status: 'stale' }, { status: 'stale', voucher: { template: 1 } }, { status: 'awaiting_reveal' }])).toBe(1);
  expect(slotsUntilRefund({ commitSlot: 100, currentSlot: 100 })).toBe(10_800); // 100 + 10 800 − 100
  expect(slotsUntilRefund({ commitSlot: 100, currentSlot: 20_000 })).toBe(0);
  const shop = src('client/src/features/shop/Shop.tsx');
  expect(shop).toContain("import { PendingOps } from './PendingOps';");
  expect(shop).toContain('<PendingOps />');
});

it('залипший фьюжн возвращает комиссию через cancel_stale_fusion и снимает запись из реестра', async () => {
  await setLocale('en');
  mocks.pending = { packs: [], compressed: [], fusions: [] };
  mocks.cancelStale.mockResolvedValue('FUSIONREFUND');
  const buyer = BUYER.toBase58();
  useTxStore.setState({
    packs: {},
    fusions: {
      [`fusion:${buyer}:7`]: {
        id: `fusion:${buyer}:7`, wallet: buyer, createdAt: 1, updatedAt: 1, phase: 'stale', nonce: '7',
        recipe: 1, boosted: true, resultCollectionIdx: 2, signatures: ['COMMITSIG'],
        randomness: RANDOMNESS.toBase58(),
        materials: [{ asset: Keypair.generate().publicKey.toBase58(), collectionIdx: 1 }],
      },
    },
  } as never);
  mount();

  const btn = await screen.findByRole('button', { name: t('shop.refund') });
  expect(document.body.textContent).toContain(t('shop.pendingFusion')); // строка карточки до возврата
  fireEvent.click(btn);
  await waitFor(() => expect(mocks.cancelStale).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(useTxStore.getState().fusions[`fusion:${buyer}:7`]).toBeUndefined());
  expect((useUiStore.getState().toasts.at(-1)!.title as { key: string }).key).toBe('shop.refunded');
  expect((useUiStore.getState().toasts.at(-1)!.body as { key: string }).key).toBe('shop.refundedFusion');
});

it('залипший claim-фьюжн возвращает комиссию через cancel_stale_claim_fusion', async () => {
  await setLocale('en');
  mocks.pending = { packs: [], compressed: [], fusions: [] };
  mocks.cancelClaimStale.mockResolvedValue('CLAIMFUSIONREFUND');
  const buyer = BUYER.toBase58();
  const materials = [0, 1, 2].map(() => Keypair.generate().publicKey.toBase58());
  useTxStore.setState({
    packs: {},
    fusions: {},
    claimFusions: {
      [`claimFusion:${buyer}:9`]: {
        id: `claimFusion:${buyer}:9`, wallet: buyer, createdAt: 1, updatedAt: 1, phase: 'stale', nonce: '9',
        recipe: 0, boosted: false, resultCollectionIdx: 1, materials, signatures: ['CLAIMCOMMIT'],
      },
    },
  } as never);
  mount();

  const btn = await screen.findByRole('button', { name: t('shop.refund') });
  fireEvent.click(btn);
  await waitFor(() => expect(mocks.cancelClaimStale).toHaveBeenCalledTimes(1));
  // запись уходит из реестра только после подтверждённого возврата
  await waitFor(() => expect(useTxStore.getState().claimFusions[`claimFusion:${buyer}:9`]).toBeUndefined());
  expect((useUiStore.getState().toasts.at(-1)!.title as { key: string }).key).toBe('shop.refunded');
  expect((useUiStore.getState().toasts.at(-1)!.body as { key: string }).key).toBe('shop.refundedFusion');
});
