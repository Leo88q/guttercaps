// Ranked queue hunt: radar + live countdown to bot fill. No ticket hash.
import { useEffect, useState } from 'react';
import { MATCHMAKING } from '@guttercaps/economy';
import { useT } from '@/shared/i18n';

export function huntRemaining(startedAt: number, now: number, fillAfterSec = MATCHMAKING.botFillAfterSec): number {
  if (!Number.isFinite(startedAt) || startedAt <= 0) return fillAfterSec;
  return Math.max(0, fillAfterSec - Math.floor((now - startedAt) / 1000));
}

export function QueueHunt({
  league,
  startedAt,
  onLeave,
  style,
}: {
  league: string;
  startedAt: number;
  onLeave: () => void;
  style?: React.CSSProperties;
}) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);
  const left = huntRemaining(startedAt, now);
  return (
    <div className="hunt-card" style={style} role="status">
      <div className="hunt-radar" aria-hidden="true" />
      <div className="hunt-copy">
        <div className="hunt-title">{t('arena.hunting')}</div>
        <div className="hunt-league">{league}</div>
        <div className="tiny muted">{left > 0 ? t('arena.huntBot') : t('arena.huntFill')}</div>
      </div>
      <div className="hunt-clock" aria-live="polite">{left}</div>
      <button type="button" className="btn btn-sm hunt-leave" onClick={onLeave}>{t('ui.leave')}</button>
    </div>
  );
}
