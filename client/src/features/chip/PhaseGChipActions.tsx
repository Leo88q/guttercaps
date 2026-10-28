// Phase-G chip actions (docs/MINIMAL-LAUNCH-CHECKLIST.md §6.3 + §5 UI):
// trading happens on external cNFT marketplaces (the in-app market is a
// program feature), and staking is the soft, no-custody record — the chip
// never leaves the wallet, it just has to stay there to keep earning.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { useMe } from '@/api/hooks';
import { useT } from '@/shared/i18n';

export const tensorItemUrl = (asset: string) => `https://www.tensor.trade/item/${asset}`;

export function PhaseGChipActions({ asset, owner }: { asset: string; owner?: string | null }) {
  const t = useT();
  const me = useMe();
  const qc = useQueryClient();
  const mine = Boolean(owner && me.data?.address && owner === me.data.address);
  const soft = useQuery({
    queryKey: ['phaseg', 'soft-me'],
    queryFn: () => api.get('/staking/soft/me'),
    enabled: mine,
    retry: false,
  });
  const staked = (soft.data?.staked ?? []).some((s) => s.asset === asset);
  const toggle = useMutation({
    mutationFn: () => (staked
      ? api.post('/staking/soft/unstake', { asset })
      : api.post('/staking/soft/stake', { asset })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['phaseg', 'soft-me'] }); },
  });
  return (
    <>
      <a className="btn btn-sm" href={tensorItemUrl(asset)} target="_blank" rel="noreferrer">{t('inspect.phasegTrade')}</a>
      {mine && (
        <button className="btn btn-sm" type="button" disabled={toggle.isPending || soft.isLoading} onClick={() => toggle.mutate()}>
          {staked ? t('inspect.phasegUnstake') : t('inspect.phasegStake')}
        </button>
      )}
    </>
  );
}
