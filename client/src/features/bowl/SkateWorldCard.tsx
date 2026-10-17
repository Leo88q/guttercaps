import { Link } from 'react-router-dom';
import { isMock } from '@/api/client';
import { useT } from '@/shared/i18n';
import { ChevronRightIcon } from '@/shared/ui/action-icons';

/**
 * Видимая точка входа в скейт-мир (PR #66/#67, docs/16).
 *
 * Раньше /bowl был достижим только ссылкой в футере: новый игрок, открывший
 * главную, не видел ни бассейна, ни стены, ни Линии. Эта карточка — не
 * декорация: каждая строка ведёт на рабочий маршрут, рядом подписано, что
 * там происходит, а доступность (просмотр без кошелька / нужен кошелёк /
 * демо-режим) показана до клика, а не выясняется по ошибке после него.
 */
export default function SkateWorldCard() {
  const t = useT();
  const entries: { to: string; title: string; hint: string; testId: string }[] = [
    { to: '/bowl/line', title: t('bowl.lineTitle'), hint: t('skate.lineHint'), testId: 'skate-entry-line' },
    { to: '/bowl/line', title: t('skate.tournament'), hint: t('line.tournament.intro', { cg: 30 }), testId: 'skate-entry-tournament' },
    { to: '/bowl/wall/0', title: t('bowl.wallTitle'), hint: t('skate.wallHint'), testId: 'skate-entry-wall' },
    { to: '/bowl/builder', title: t('builder.title'), hint: t('skate.builderHint'), testId: 'skate-entry-builder' },
    { to: '/bowl/crew', title: t('crew.title'), hint: t('skate.crewHint'), testId: 'skate-entry-crew' },
    { to: '/bowl/board', title: t('board.title'), hint: t('skate.boardHint'), testId: 'skate-entry-board' },
  ];
  return (
    <section className="card stack-sm" data-testid="skate-world-card" aria-label={t('bowl.title')}>
      <img
        src="/art/skate/bowl-hero.webp"
        alt=""
        aria-hidden
        loading="lazy"
        decoding="async"
        style={{ width: '100%', height: 140, objectFit: 'cover', borderRadius: 10, display: 'block' }}
      />
      <div className="row between" style={{ gap: 8, flexWrap: 'wrap' }}>
        <span className="pill pill-ok">{t('skate.kicker')}</span>
        <span className="tiny muted">{t('skate.browse')}</span>
      </div>
      <div>
        <div className="strong" style={{ fontSize: 20 }}>{t('bowl.title')}</div>
        <div className="small muted">{t('skate.intro')}</div>
      </div>
      <div className="stack-sm">
        {entries.map((e) => (
          <Link
            key={e.testId}
            to={e.to}
            data-testid={e.testId}
            className="row"
            style={{ textDecoration: 'none', gap: 10, alignItems: 'center' }}
          >
            <span className="grow">
              <span className="strong" style={{ display: 'block' }}>{e.title}</span>
              <span className="tiny muted" style={{ display: 'block' }}>{e.hint}</span>
            </span>
            <ChevronRightIcon size={14} />
          </Link>
        ))}
      </div>
      <div className="tiny muted">{t('skate.wallet')}</div>
      {isMock() && <div className="warn tiny" data-testid="skate-mock-note">{t('skate.mock')}</div>}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Link to="/bowl" className="btn" data-testid="skate-enter-bowl">{t('skate.cta')}</Link>
        <Link to="/grid" className="btn btn-ghost" data-testid="skate-enter-grid">{t('grid.title')}</Link>
      </div>
    </section>
  );
}
