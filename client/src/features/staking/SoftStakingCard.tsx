// Находка 29: soft-стейкинг фишек (§5, без кастоди) начислял награды в ledger бэкенда, а забрать их
// из продукта было нельзя — `POST /staking/soft/claim` не вызывался ни из одного экрана. Начисленное
// копилось вечно, а кранк платил только по заявкам, которых никто не создавал.
//
// Здесь единственное место, где награда превращается в заявку на выплату: сумма уходит из `pending`
// в payout-строку на бэкенде (одна заявка на кошелёк, повторный клик не платит дважды), а саму выплату
// делает кранк — в кошельке игрок ничего не подписывает и $CG мы не держим.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { useUiStore } from '@/app/store/ui';
import { useT } from '@/shared/i18n';
import { fmtCg } from '@/shared/lib/format';
import { amountText } from '@/shared/i18n/message';
import { CleanZone, KV } from '@/shared/ui/primitives';

type SoftMe = {
  staked: { asset: string; stakedAt: number }[];
  pendingMicro: string;
  claimedMicro: string;
  payouts: { id: number; amountMicro: string; status: string; txSig: string | null }[];
};

export function SoftStakingCard() {
  const t = useT();
  const qc = useQueryClient();
  const toast = useUiStore((s) => s.toast);
  const soft = useQuery<SoftMe>({ queryKey: ['phaseg', 'soft-me'], queryFn: () => api.get('/staking/soft/me') as unknown as Promise<SoftMe>, retry: false });
  const pending = BigInt(soft.data?.pendingMicro ?? '0');
  const claim = useMutation({
    mutationFn: () => api.post('/staking/soft/claim'),
    onSuccess: (r) => {
      toast({
        kind: 'money',
        title: { key: 'staking.softClaim' },
        // Деньги не проходят через переводчик: в уведомление кладём точное количество в микрогородских
        // единицах (находка 12/40 — «замороженный» формат в тосте ломает смену языка).
        body: { key: 'staking.softQueued', params: { amount: amountText(BigInt(r.amountMicro ?? '0'), 'CG'), id: String(r.payoutId ?? '') } },
      });
      void qc.invalidateQueries({ queryKey: ['phaseg', 'soft-me'] });
    },
    onError: (e: unknown) => toast({ kind: 'error', title: { key: 'staking.softFailed' }, error: e as Error }),
  });
  const lastSent = (soft.data?.payouts ?? []).find((p) => p.status === 'sent');
  return (
    <div className="card stack-sm">
      <div className="strong">{t('staking.softTitle')}</div>
      <div className="tiny muted">{t('staking.softSub')}</div>
      <CleanZone>
        <KV k={t('staking.softPending')} v={soft.isLoading ? '…' : fmtCg(pending, 3)} accent={pending > 0n} />
        <KV k={t('staking.softClaimed')} v={soft.isLoading ? '…' : fmtCg(BigInt(soft.data?.claimedMicro ?? '0'), 2)} />
        <KV k={t('staking.softStaked')} v={String(soft.data?.staked.length ?? 0)} />
      </CleanZone>
      {lastSent && <div className="tiny muted">{t('staking.softLastPaid', { amount: fmtCg(BigInt(lastSent.amountMicro), 2) })}</div>}
      <button
        className="btn btn-sm"
        type="button"
        disabled={claim.isPending || soft.isLoading || pending <= 0n}
        onClick={() => claim.mutate()}
      >
        {pending > 0n ? t('staking.softClaim') : t('staking.softNothing')}
      </button>
    </div>
  );
}
