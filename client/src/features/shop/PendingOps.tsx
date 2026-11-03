// Находка 46: аварийный выход для залипшей покупки. Пока оракул не раскрыл случайность, деньги лежат в
// `PendingPack`, а единственный способ их вернуть — `cancel_stale_pack`, который требует ПОДПИСИ покупателя
// (кранк за игрока его подписать не может). В продукте этой кнопки не было: покупка «зависала» навсегда,
// и вернуть средства можно было только руками через explorer.
//
// Здесь она есть, и появляется ровно тогда, когда её примет цепь: `status === 'stale'` бэкенд выставляет по
// слоту (`commit_slot + STALE_PACK_SLOTS` позади головы индексатора) — та же граница, что проверяет
// `assert_refundable`. Часы процесса на это не влияют.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { isMock } from '@/api/client';
import { usePendingOps } from '@/api/hooks';
import { useGameConfig, useWalletLike } from '@/chain/hooks';
import { cancelStalePackIx } from '@/chain/ix/chipCore';
import { FusionFlow } from '@/chain/flows/fusionFlow';
import { fusionId, useActiveOps, useTxStore } from '@/app/store/txs';
import { sendTx } from '@/chain/tx';
import { EXPLORER, MINTS } from '@/app/config';
import { useUiStore } from '@/app/store/ui';
import { qk } from '@/api/keys';
import { useT } from '@/shared/i18n';
import { fmtCg } from '@/shared/lib/format';
import { CleanZone, KV } from '@/shared/ui/primitives';

type PendingPack = NonNullable<NonNullable<ReturnType<typeof usePendingOps>['data']>['packs']>[number];

/** Минт, которым платили: `cancel_stale_pack` возвращает SPL-оплату на ATA покупателя, для SOL минт не нужен. */
function paidMintOf(currency: string | undefined, cgMint: PublicKey | undefined): PublicKey | undefined {
  if (currency === 'USDC') return MINTS.usdc;
  if (currency === 'SKR') return MINTS.skr;
  if (currency === 'CG') return cgMint ?? MINTS.cg;
  return undefined;
}

/**
 * Находка 46, вторая половина: залипший фьюжн. Комиссия в $CG лежит в `PendingFusion`, материалы заморожены,
 * а бустер уже сожжён; вернуть их может только `cancel_stale_fusion` с подписью владельца. Владелец известен
 * из локального реестра операций (`gc.txs`) — той же записи, по которой экран Fusion умеет продолжить заход.
 * Здесь она даёт кнопку возврата вместо тупика: до этого «фаза stale» только показывала тост о таймауте.
 */
export function PendingOps() {
  const t = useT();
  const qc = useQueryClient();
  const pending = usePendingOps();
  const { connection } = useConnection();
  const wallet = useWalletLike();
  const active = useActiveOps(wallet?.publicKey?.toBase58());
  const upsertFusion = useTxStore((s) => s.upsertFusion);
  const removeOp = useTxStore((s) => s.remove);
  const cfg = useGameConfig();
  const toast = useUiStore((s) => s.toast);

  const refund = useMutation({
    mutationFn: async (p: PendingPack) => {
      if (isMock()) return { signature: 'mock-refund' };
      if (!wallet) throw new Error(t('shop.walletRequired'));
      return sendTx(connection, wallet, [cancelStalePackIx({
        buyer: wallet.publicKey,
        nonce: BigInt(p.nonce!),
        randomness: new PublicKey(String(p.randomness)),
        paidMint: paidMintOf(p.currency, cfg.data?.cgMint),
      })], { cuLimit: 120_000 });
    },
    onSuccess: (r, p) => {
      toast({
        kind: 'money',
        title: { key: 'shop.refunded' },
        body: { key: 'shop.refundedBody', params: { sku: p.sku ?? 0 } },
        href: r.signature === 'mock-refund' ? undefined : EXPLORER.tx(r.signature),
      });
      void qc.invalidateQueries({ queryKey: qk.pending });
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (e: unknown) => toast({ kind: 'error', title: { key: 'shop.refundFailed' }, error: e as Error }),
  });

  const staleFusions = active.fusions.filter((f) => f.phase === 'stale');

  const refundFusion = useMutation({
    mutationFn: async (f: (typeof staleFusions)[number]) => {
      if (isMock()) return { signature: 'mock-fusion-refund' };
      if (!wallet) throw new Error(t('shop.walletRequired'));
      const flow = new FusionFlow(
        {
          connection,
          wallet,
          onState: (st) => upsertFusion({
            id: fusionId(wallet.publicKey.toBase58(), st.nonce), wallet: wallet.publicKey.toBase58(),
            createdAt: Date.now(), updatedAt: Date.now(), phase: st.phase, nonce: st.nonce.toString(),
            recipe: st.recipe, boosted: st.boosted, resultCollectionIdx: st.resultCollectionIdx,
            signatures: st.signatures, randomness: st.randomness?.toBase58(),
            materials: st.materials.map((m) => ({ asset: m.asset.toBase58(), collectionIdx: m.collectionIdx })),
            error: st.error, errorDiagnostic: st.errorDiagnostic,
          }),
        },
        {
          recipe: f.recipe, boosted: f.boosted, nonce: BigInt(f.nonce), resultCollectionIdx: f.resultCollectionIdx,
          materials: f.materials.map((m) => ({ asset: new PublicKey(m.asset), collectionIdx: m.collectionIdx })),
        },
      );
      flow.state = { ...flow.state, randomness: f.randomness ? new PublicKey(f.randomness) : undefined };
      const signature = await flow.cancelStale();
      return { signature };
    },
    onSuccess: (r, f) => {
      toast({
        kind: 'money',
        title: { key: 'shop.refunded' },
        body: { key: 'shop.refundedFusion', params: { recipe: f.recipe } },
        href: r.signature === 'mock-fusion-refund' ? undefined : EXPLORER.tx(r.signature),
      });
      removeOp(fusionId(wallet?.publicKey.toBase58() ?? f.wallet, BigInt(f.nonce)));
      void qc.invalidateQueries({ queryKey: qk.pending });
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (e: unknown) => toast({ kind: 'error', title: { key: 'shop.refundFailed' }, error: e as Error }),
  });

  const packs = pending.data?.packs ?? [];
  if (packs.length === 0 && staleFusions.length === 0) return null;
  const refundable = packs.filter((p) => p.status === 'stale' && !p.voucher);

  return (
    <div className="card stack-sm" data-testid="pending-ops">
      <div className="strong">{t('shop.pendingTitle')}</div>
      <div className="tiny muted">{t('shop.pendingSub')}</div>
      <CleanZone>
        {packs.map((p) => (
          <div key={p.nonce} className="row between" style={{ gap: 8 }}>
            <KV
              k={`${t('shop.pendingPack')} #${p.nonce}`}
              v={p.status === 'stale' ? t('shop.pendingStale') : t('shop.pendingWaiting')}
              accent={p.status === 'stale'}
            />
            {p.status === 'stale' && !p.voucher && (
              <button
                className="btn btn-sm"
                type="button"
                disabled={refund.isPending}
                onClick={() => refund.mutate(p)}
              >
                {t('shop.refund')}
              </button>
            )}
          </div>
        ))}
        {refundable.length === 0 && <div className="tiny muted">{t('shop.pendingNoRefundYet')}</div>}
        {refundable.length > 0 && <div className="tiny muted">{t('shop.refundHint')}</div>}
        {staleFusions.map((f) => (
          <div key={f.id} className="row between" style={{ gap: 8 }}>
            <KV k={`${t('shop.pendingFusion')} #${f.nonce}`} v={t('shop.pendingStale')} accent />
            <button className="btn btn-sm" type="button" disabled={refundFusion.isPending} onClick={() => refundFusion.mutate(f)}>
              {t('shop.refund')}
            </button>
          </div>
        ))}
      </CleanZone>
    </div>
  );
}

/** Сколько залипших покупок можно вернуть прямо сейчас (для бейджа в баннере незавершённых операций). */
export const refundableCount = (packs: { status?: string; voucher?: unknown }[] | undefined): number =>
  (packs ?? []).filter((p) => p.status === 'stale' && !p.voucher).length;

/** Используется в тестах и в подсказке: сколько слотов осталось до возврата (0 — уже можно). */
export const slotsUntilRefund = (p: { commitSlot?: number; currentSlot?: number; refundSlot?: number }): number =>
  Math.max(0, (p.refundSlot ?? (p.commitSlot ?? 0) + 10_800) - (p.currentSlot ?? 0));

/** Сумма к возврату печатается как есть — деньги не проходят через переводчик. */
export const refundAmountText = (micro: bigint) => fmtCg(micro, 2);

export type { PendingPack };
