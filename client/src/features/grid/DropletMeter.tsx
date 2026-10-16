// Droplet meter («капля заряда»). Показываем только там, где бэкенд отдаёт маршрут фишки:
// в Решётке и на странице фишки. В списках фишек поля нет (chipToApi его не отдаёт) — добавить
// его туда значит расширять API; по решению владельца капли живут в Решётке.
//
// Капля набирается так: каждые GRID.chargePerSectorStreak (5) секторов маршрута, закрытых на
// ≥2 звезды, дают +1 прогресс; 5 прогресса = капля. Максимум GRID.chargeMax (3), живут
// GRID.chargeStakeEvaporateDays (7) дней, каждая даёт +5 % веса в стейкинге (docs/13).
import { GRID } from '@guttercaps/economy';
import { GenBadge } from '@/shared/ui/GenBadge';
import { useT } from '@/shared/i18n';

export function DropletMeter({
  drops,
  progress = 0,
  size = 15,
  showProgress = true,
  title,
}: {
  drops: number;
  progress?: number;
  size?: number;
  showProgress?: boolean;
  title?: string;
}) {
  const t = useT();
  const full = Math.min(GRID.chargeMax, Math.max(0, drops));
  const toNext = Math.min(GRID.chargePerSectorStreak, Math.max(0, progress));
  return (
    <span
      className="row"
      style={{ gap: 3, alignItems: 'center', display: 'inline-flex' }}
      role="img"
      aria-label={t('grid.dropsMeter', { n: full, p: toNext })}
      title={title ?? t('grid.drops')}
    >
      {Array.from({ length: GRID.chargeMax }, (_, i) => (
        <span
          key={i}
          style={{ display: 'inline-flex', opacity: i < full ? 1 : 0.26, filter: i < full ? 'none' : 'grayscale(1)' }}
          aria-hidden
        >
          <GenBadge name="item-drop" size={size} />
        </span>
      ))}
      <span className="tiny muted" style={{ marginLeft: 2 }} aria-hidden>
        {full}/{GRID.chargeMax}
        {showProgress && full < GRID.chargeMax ? ` · ${toNext}/${GRID.chargePerSectorStreak}` : ''}
      </span>
    </span>
  );
}
