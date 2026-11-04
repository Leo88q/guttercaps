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
import { Keypair, PublicKey } from '@solana/web3.js';
import { BorshWriter } from '@/chain/borsh';
import { accountDiscriminator } from '@/chain/anchor';
import { compressedMintClaimPda } from '@/chain/pdas';
import { orderPda } from '@/chain/ix/settle';
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
  // цепь для «истёкшего клейма»: карточка читает claim-аккаунты по PDA из реестра операций
  getAccounts: vi.fn(async (): Promise<unknown[]> => []),
  // аккаунт заказа фазы V (находка 80) читается по PDA из `/me/pending`
  getOrder: vi.fn(async (): Promise<unknown> => null),
  slot: vi.fn(async () => 0),
}));

vi.mock('@/api/hooks', () => ({ usePendingOps: () => ({ data: mocks.pending, isLoading: false }) }));
vi.mock('@/api/client', () => ({ isMock: () => false, api: { get: vi.fn(), post: vi.fn() } }));
// минт $CG из конфигурации: без него клиент не соберёт возврат ставки (бой играется только в $CG)
const CG_MINT = '11111111111111111111111111111111';
vi.mock('@/chain/hooks', async () => {
  const { PublicKey } = await import('@solana/web3.js');
  return {
    useGameConfig: () => ({ data: { cgMint: new PublicKey(CG_MINT) } }),
    useWalletLike: () => ({ publicKey: BUYER, signTransaction: vi.fn() }),
  };
});
vi.mock('@solana/wallet-adapter-react', () => ({ useConnection: () => ({ connection: { getMultipleAccountsInfo: mocks.getAccounts, getAccountInfo: mocks.getOrder, getSlot: mocks.slot } }) }));
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
import { PendingOps, refundableBattleCount, refundableCount, slotsUntilRefund } from './PendingOps';

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
  // реализации моков живут дольше одного теста (`clearAllMocks` чистит только вызовы): без сброса
  // «истёкший клейм» из предыдущего теста продолжал бы рисовать свою карточку в следующем
  mocks.getAccounts.mockResolvedValue([]);
  mocks.getOrder.mockResolvedValue(null);
  mocks.slot.mockResolvedValue(0);
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

// Находка 46, четвёртая половина: залипший бой. Ставка сторон лежит в эскроу на PDA боя, а снять её может
// только `cancel_stale_battle` с ПОДПИСЬЮ стороны — до этого о таком бое игрок не узнавал нигде, и деньги
// оставались запертыми, если `resolve_battle` не прошёл (кранк упал, сила отряда разошлась с записанной).
it('залипший бой возвращает ставку через cancel_stale_battle по адресу из индексатора', async () => {
  await setLocale('en');
  const battle = Keypair.generate().publicKey;
  const opponent = Keypair.generate().publicKey;
  mocks.pending = {
    packs: [], compressed: [], fusions: [],
    battles: [{
      battle: battle.toBase58(), challenger: BUYER.toBase58(), opponent: opponent.toBase58(), wager: '1000000',
      status: 'accepted', powerA: 10, powerB: 12, refundable: true, reason: 'timeout',
      refundAt: null, acceptedAt: '2026-11-03T00:00:00.000Z',
    }],
  };
  mocks.send.mockResolvedValue({ signature: 'BATTLEREFUND', logs: [] });
  mount();

  expect(document.body.textContent).toContain(t('shop.pendingBattle'));
  const btn = await screen.findByRole('button', { name: t('shop.refund') });
  fireEvent.click(btn);
  await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
  const ix = (mocks.send.mock.calls[0] as unknown[])[2] as { data: Uint8Array; keys: { pubkey: { toBase58(): string } }[] }[];
  expect(ix).toHaveLength(1);
  expect(Buffer.from(ix[0].data.subarray(0, 8)).toString('hex')).toBe(Buffer.from(ixDiscriminator('cancel_stale_battle')).toString('hex'));
  const keys = ix[0].keys.map((k) => k.pubkey.toBase58());
  expect(keys[0]).toBe(BUYER.toBase58());                        // подписывает сторона боя
  // адрес боя берётся из индексатора: `nonce` в событиях боя нет, из PDA его не восстановить
  expect(keys[2]).toBe(battle.toBase58());
  const cg = new PublicKey(CG_MINT);
  expect(keys).toContain(ata(cg, battle).toBase58());             // эскроу = ATA боя
  expect(keys).toContain(ata(cg, BUYER).toBase58());              // возврат идёт на ATA заявителя
  expect(keys).toContain(ata(cg, opponent).toBase58());           // и у оппонента есть свой ATA в аккаунтах
  await waitFor(() => expect(useUiStore.getState().toasts.length).toBeGreaterThan(0));
  expect((useUiStore.getState().toasts.at(-1)!.body as { key: string }).key).toBe('shop.refundedBattle');
  expect(mocks.invalidate).toHaveBeenCalled();
});

it('бой, у которого окно возврата закрыто, кнопку не показывает', async () => {
  await setLocale('en');
  mocks.pending = {
    packs: [], compressed: [], fusions: [],
    battles: [{
      battle: Keypair.generate().publicKey.toBase58(), challenger: BUYER.toBase58(), opponent: null, wager: '5',
      status: 'accepted', powerA: 1, powerB: null, refundable: false, reason: 'not_stale',
      refundAt: '2026-11-04T00:30:00.000Z', acceptedAt: '2026-11-04T00:00:00.000Z',
    }],
  };
  mount();
  await screen.findByText(t('shop.pendingTitle'));
  expect(screen.queryByRole('button', { name: t('shop.refund') })).toBeNull();
  expect(document.body.textContent).toContain(t('shop.pendingBattleWaiting'));
  expect(refundableBattleCount([{ refundable: true }, { refundable: false }])).toBe(1);
});

// Находка 46, пятая половина: истёкший незабранный клейм (результат фьюжна, админская выдача) держал ренту
// покупателя на своём аккаунте. `close_expired_claim` существовал только билдером — кнопки не было нигде,
// и рента оставалась там навсегда. Карточка находит такой клейм по реестру операций и возвращает ренту.
it('истёкший незабранный клейм возвращает ренту через close_expired_claim', async () => {
  await setLocale('en');
  mocks.pending = { packs: [], compressed: [], fusions: [], battles: [] };
  const expiry = BigInt(Math.floor(Date.now() / 1000) - 60);
  const data = new BorshWriter()
    .bytes(accountDiscriminator('CompressedMintClaim'))
    .pubkey(BUYER).u8(0).u8(4).u8(1).u64(3n).i64(expiry)
    .pubkey(PublicKey.default).bool(false).bool(false).bool(false).bool(false).bool(false).u8(1).bool(false).pubkey(BUYER).i64(0n)
    .toBytes();
  mocks.getAccounts.mockResolvedValue([{ data: new Uint8Array(data), lamports: 2_039_280 }]);
  mocks.send.mockResolvedValue({ signature: 'RENTSIG', logs: [] });
  const buyer = BUYER.toBase58();
  useTxStore.setState({
    packs: {}, fusions: {},
    claimFusions: {
      [`claimFusion:${buyer}:9`]: {
        id: `claimFusion:${buyer}:9`, wallet: buyer, createdAt: 1, updatedAt: 1, phase: 'done', nonce: '9',
        recipe: 0, boosted: false, resultCollectionIdx: 1, materials: [], signatures: ['REVEAL'],
      },
    },
  } as never);
  mount();

  // клейм читается с цепи, поэтому карточка появляется асинхронно
  await screen.findByText(t('shop.claimRent'));
  const btn = await screen.findByRole('button', { name: t('shop.refund') });
  fireEvent.click(btn);
  await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
  const ix = (mocks.send.mock.calls[0] as unknown[])[2] as { data: Uint8Array; keys: { pubkey: { toBase58(): string } }[] }[];
  expect(Buffer.from(ix[0].data.subarray(0, 8)).toString('hex')).toBe(Buffer.from(ixDiscriminator('close_expired_claim')).toString('hex'));
  // подписывает покупатель, закрывается именно его клейм (PDA из nonce записи)
  expect(ix[0].keys[0].pubkey.toBase58()).toBe(BUYER.toBase58());
  expect(ix[0].keys[1].pubkey.toBase58()).toBe(compressedMintClaimPda(BUYER, 9n)[0].toBase58());
  await waitFor(() => expect((useUiStore.getState().toasts.at(-1)!.body as { key: string }).key).toBe('shop.claimRentBack'));
});

// Находка 80: оплата фазы V в эскроу. `refund_pack` разрешён цепью только после
// `created_slot + REFUND_AFTER_SLOTS`, и до этой правки билдера возврата не было в продукте вовсе: оплаченный,
// но не выданный заказ (оракул не подписал выпуск) можно было вернуть только руками через explorer.
// Находка 82: отказ `refund_pack` обязан быть НАЗВАН. `settle` не было в клиентской таблице ошибок,
// поэтому `RefundTooEarly` (окно открылось по часам сервера, но цепь ещё на предыдущем слоте) выходил
// сырым числом — игрок видел «ошибка» без причины и не понимал, что делать.
it('отказ refund_pack называется по имени, а не показывается сырым кодом', async () => {
  await setLocale('en');
  mocks.pending = { packs: [], compressed: [], fusions: [], battles: [], phaseV: [{
    orderId: '4343', sku: 1, qty: 1, currency: 'SOL', amount: '5990000', mint: null,
    escrowSig: 'ESCROWSIG2', createdAt: '2026-11-01T00:00:00.000Z', paidAt: '2026-11-01T00:00:00.000Z',
  }] };
  const { PACK_ORDER_STATUS, REFUND_AFTER_SLOTS } = await import('@/chain/ix/settle');
  const { SETTLE_ID } = await import('@/chain/ids');
  const { humanizeTxError } = await import('@/chain/errors');
  const createdSlot = 2_000n;
  const body = new BorshWriter()
    .bytes(accountDiscriminator('PackOrder'))
    .pubkey(BUYER).u64(4343n).u8(0).u64(5_990_000n).u8(PACK_ORDER_STATUS.PAID).u64(createdSlot).u8(1)
    .toBytes();
  mocks.getOrder.mockResolvedValue({ data: new Uint8Array(body), lamports: 6_200_000 });
  mocks.slot.mockResolvedValue(Number(createdSlot + REFUND_AFTER_SLOTS));
  // цепь отказала 6004 = RefundTooEarly (четвёртый вариант SettleError, 6000 + 4)
  const failure = Object.assign(new Error('Transaction simulation failed'), {
    logs: [`Program ${SETTLE_ID.toBase58()} failed: custom program error: 0x1774`],
  });
  mocks.send.mockRejectedValue(failure);
  mount();

  const btn = await screen.findByRole('button', { name: t('shop.refund') });
  fireEvent.click(btn);
  await waitFor(() => expect(useUiStore.getState().toasts.some((x) => x.kind === 'error')).toBe(true));
  const toast = useUiStore.getState().toasts.filter((x) => x.kind === 'error').at(-1)!;
  expect(humanizeTxError(toast.error)).toContain('RefundTooEarly');
  expect(humanizeTxError(toast.error)).toMatch(/^settle: /);
  // заказ остался в списке: возврат не состоялся, и запись нельзя терять
  await waitFor(() => expect(useUiStore.getState().toasts.at(-1)!.kind).toBe('error'));
});

it('оплаченный и невыданный заказ фазы V возвращает деньги через refund_pack', async () => {
  await setLocale('en');
  mocks.pending = { packs: [], compressed: [], fusions: [], battles: [], phaseV: [{
    orderId: '4242', sku: 1, qty: 1, currency: 'SOL', amount: '5990000', mint: null,
    escrowSig: 'ESCROWSIG', createdAt: '2026-11-01T00:00:00.000Z', paidAt: '2026-11-01T00:00:00.000Z',
  }] };
  const { PACK_ORDER_STATUS, REFUND_AFTER_SLOTS } = await import('@/chain/ix/settle');
  const createdSlot = 1_000n;
  const body = new BorshWriter()
    .bytes(accountDiscriminator('PackOrder'))
    .pubkey(BUYER).u64(4242n).u8(0).u64(5_990_000n).u8(PACK_ORDER_STATUS.PAID).u64(createdSlot).u8(1)
    .toBytes();
  // цепь: слот уже за окном возврата
  mocks.getOrder.mockResolvedValue({ data: new Uint8Array(body), lamports: 6_200_000 });
  mocks.send.mockResolvedValue({ signature: 'PHASEVREFUND', logs: [] });
  mocks.slot.mockResolvedValue(Number(createdSlot + REFUND_AFTER_SLOTS));
  mount();

  await waitFor(() => expect(document.body.textContent).toContain(t('shop.pendingPhaseV')));
  const btn = await screen.findByRole('button', { name: t('shop.refund') });
  fireEvent.click(btn);
  await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
  const ix = (mocks.send.mock.calls[0] as unknown[])[2] as { data: Uint8Array; keys: { pubkey: { toBase58(): string } }[] }[];
  expect(Buffer.from(ix[0].data.subarray(0, 8)).toString('hex')).toBe(Buffer.from(ixDiscriminator('refund_pack')).toString('hex'));
  expect(ix[0].keys[1].pubkey.toBase58()).toBe(BUYER.toBase58());        // подписывает покупатель
  expect(ix[0].keys[2].pubkey.toBase58()).toBe(orderPda(BUYER, 4242n).toBase58()); // и закрывает свой PDA заказа
  // аргумент инструкции — номер заказа
  const dv = new DataView(ix[0].data.buffer, ix[0].data.byteOffset, ix[0].data.byteLength);
  expect(dv.getBigUint64(8, true)).toBe(4242n);
  await waitFor(() => expect((useUiStore.getState().toasts.at(-1)!.body as { key: string }).key).toBe('shop.refundedPhaseV'));
});
