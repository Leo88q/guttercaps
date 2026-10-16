// docs/16 §4.7 — Достижения.
//
// Два правила, которые видны в интерфейсе. Первое: награда — косметика или
// существующий предмет, никогда не $CG (docs/02), поэтому здесь нет ни одной
// суммы. Второе: прогресс не хранится и не «накапливается» клиентом — его
// считает сервер из таблиц, которые игра и так ведёт, так что достижение не
// может разойтись с состоянием, которое его заслужило.
//
// Значки — настоящие файлы из client/public/icons/gen, а не нарисованные глифы.
import { GenBadge } from '@/shared/ui/GenBadge';
import { Empty, Pill, Progress, Skeleton } from '@/shared/ui/primitives';
import { useAchievements, useClaimAchievement, type Achievement } from '@/api/hooks';
import { useUiStore } from '@/app/store/ui';
import { fmtLocale, useLocale, useT, type MessageKey, type TFn } from '@/shared/i18n';

/** Ключ перевода — id достижения с подчёркиванием: точка в ключе ломает обход дерева. */
const itemKey = (id: string) => `achievements.item.${id.replace(/\./g, '_')}` as const;

/** Человеческая подпись награды: вид косметики, а не其内部 id. */
function rewardText(a: Achievement, t: TFn): string {
  const r = a.reward as { kind: string; n?: number | null };
  const label = t(`achievements.rw.${r.kind}` as MessageKey, r.kind === 'hints' ? { n: r.n ?? 0 } : undefined);
  if (r.kind === 'banner' && a.bannerCollection !== null && a.bannerCollection !== undefined) {
    return `${label} · #${a.bannerCollection + 1}`;
  }
  return label;
}

export function AchievementCard({ a, busy, onClaim }: { a: Achievement; busy: boolean; onClaim: (id: string) => void }) {
  const t = useT();
  const { locale } = useLocale();
  const done = a.done === true;
  const claimed = a.claimed === true;
  return (
    <div
      className={`ach-card${done ? ' is-done' : ''}${claimed ? ' is-claimed' : ''}`}
      data-testid="achievement"
      data-id={a.id}
      data-done={done ? '1' : '0'}
      data-claimed={claimed ? '1' : '0'}
    >
      <span className="ach-badge">
        <GenBadge name={String(a.icon ?? 'item-mark')} size={30} />
      </span>
      <div className="ach-body">
        <b>{t(`${itemKey(String(a.id))}.name` as MessageKey)}</b>
        <span className="tiny muted">{t(`${itemKey(String(a.id))}.desc` as MessageKey)}</span>
        <Progress value={Number(a.have ?? 0)} max={Math.max(1, Number(a.target ?? 1))} tone={done ? 'acid' : undefined} />
        <span className="tiny muted" data-testid="ach-progress">
          {t('achievements.progress', { have: Number(a.have ?? 0), target: Number(a.target ?? 1) })}
        </span>
        <span className="tiny muted">{t('achievements.reward')}: {rewardText(a, t)}</span>
      </div>
      <div className="ach-act">
        {claimed
          ? <Pill tone="ok">{t('achievements.claimed', { date: a.claimedAt ? fmtLocale.date(a.claimedAt, locale) : '' })}</Pill>
          : done
            ? <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onClaim(String(a.id))}>{t('achievements.claim')}</button>
            : <span className="tiny muted">{t('achievements.pending')}</span>}
      </div>
    </div>
  );
}

export default function Achievements() {
  const t = useT();
  const toast = useUiStore((s) => s.toast);
  const q = useAchievements();
  const claim = useClaimAchievement();
  const items = (q.data?.items ?? []).filter((a): a is Achievement => !!a);

  return (
    <div className="page page-bg stack">
      <div>
        <h1 className="page-title">{t('achievements.title')}</h1>
        <p className="page-sub">{t('achievements.intro')}</p>
      </div>
      {q.isLoading && <Skeleton h={160} />}
      {!!q.error && <div className="warn">{t('achievements.failed')}</div>}
      {!q.isLoading && !q.error && items.length === 0 && <Empty>{t('achievements.empty')}</Empty>}
      <div className="ach-grid">
        {items.map((a) => (
          <AchievementCard
            key={String(a.id)}
            a={a}
            busy={claim.isPending}
            onClaim={(id) => claim.mutate(id, {
              onError: () => toast({ kind: 'error', title: { key: 'achievements.title' }, body: { key: 'achievements.failed' } }),
            })}
          />
        ))}
      </div>
    </div>
  );
}
