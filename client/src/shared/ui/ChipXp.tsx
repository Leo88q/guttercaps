import { CHIP_XP, RARITY_PROFILES, xpToNext } from '@guttercaps/economy';
import { useT } from '@/shared/i18n';

export function ChipXpMeter({
  level,
  rarity,
  xp,
  xpToNext: need,
  maxLevel,
  xpToday,
  xpDailyCap,
  compact,
}: {
  level?: number | null;
  rarity: number;
  xp?: number | null;
  xpToNext?: number | null;
  maxLevel?: number | null;
  xpToday?: number | null;
  xpDailyCap?: number | null;
  compact?: boolean;
}) {
  const t = useT();
  const cap = maxLevel ?? RARITY_PROFILES[rarity]?.maxLevel ?? 12;
  const lvl = level ?? 1;
  const unspent = xp ?? 0;
  const cost = need ?? xpToNext(lvl, cap);
  const today = (
    <div className="tiny muted">{t('ui.xpToday', { xp: xpToday ?? 0, cap: xpDailyCap ?? CHIP_XP.dailyCap })}</div>
  );
  if (cost == null) {
    return (
      <div className="stack-sm">
        <div className="tiny muted">{t('ui.levelMaxed', { max: cap })}</div>
        {!compact && today}
      </div>
    );
  }
  const pct = Math.min(100, Math.round((unspent / cost) * 100));
  return (
    <div className="stack-sm">
      <div className="tiny muted">{t('ui.xpToNext', { xp: unspent, need: cost })}</div>
      <div className="progress magenta" role="meter" aria-valuemin={0} aria-valuemax={cost} aria-valuenow={unspent}>
        <i style={{ width: `${pct}%` }} />
      </div>
      {!compact && <div className="tiny muted">{t('ui.levelHint', { win: CHIP_XP.win, loss: CHIP_XP.loss, cost, max: cap })}</div>}
      {!compact && today}
    </div>
  );
}
