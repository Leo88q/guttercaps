import { useT } from '@/shared/i18n';
// Header balance — clean zone (mono, trust blue accent, no wobble).
import { useGameConfig, useBalances } from '@/chain/hooks';
import { useMe } from '@/api/hooks';
import { MINTS } from '../config';
import { fmtUnits } from '@/shared/lib/format';
import { CgCoinIcon } from '@/shared/ui/reward-icons';

export function BalanceChip() {
  const t = useT();
  const cfg = useGameConfig();
  const cgMint = cfg.data?.cgMint ?? MINTS.cg;
  const usdcMint = cfg.data?.usdcMint ?? MINTS.usdc;
  const chain = useBalances(cgMint, usdcMint);
  const me = useMe();
  // prefer live chain numbers; fall back to indexer/mock
  const lamports = chain.data?.lamports ?? (me.data?.balances?.lamports ? BigInt(me.data.balances.lamports) : undefined);
  const cg = chain.data && cgMint ? chain.data.cg : me.data?.balances?.cg ? BigInt(me.data.balances.cg) : undefined;
  return (
    <div className="cg-clean-zone balance-chip" title={t('profile.balances')}>
      <span>◎ <b>{fmtUnits(lamports, 9, 3)}</b></span>
      <span className="row" style={{ gap: 5 }}><CgCoinIcon size={14} /> <b>{fmtUnits(cg, 6, 0)}</b></span>
    </div>
  );
}
