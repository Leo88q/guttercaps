// Бассейн — хаб скейт-мира (docs/16 §4.1).
//
// Графика здесь не рисуется кодом: это сгенерированные файлы из
// client/public/art/skate (состав, промпты и sha256 — в MANIFEST.json рядом
// с ними, собирает scripts/skate-art-build.py). Код отвечает за раскладку,
// движение и состояние — и ни за одну линию в самой картинке.
//
// Стек намеренно без WebGL и без новых зависимостей: параллакс — два слоя с
// разной скоростью на CSS, и он целиком гасится prefers-reduced-motion
// (класс .reduced-motion вешает Shell на <html>).
//
// Хаб — только витрина и навигация: игровые действия живут на подмаршрутах
// (/bowl/wall/:district, /bowl/builder, /bowl/crew, …) и во Floodgrid, и ходят
// в реальный API (в демо-режиме — в in-browser mock, что подписано ниже).
// Ничего из показанного здесь не влияет на шансы, фьюжн, стейкинг и маркет —
// инварианты docs/16 §9.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { isMock } from '@/api/client';
import { useUiStore } from '@/app/store/ui';
import { useT } from '@/shared/i18n';
import { collectionColor, collectionName } from '@/shared/lib/rarity';
import './bowl.css';

const ART = '/art/skate';

export default function Bowl() {
  const t = useT();
  const reducedMotion = useUiStore((s) => s.reducedMotion);
  const [boardDistrict, setBoardDistrict] = useState(1);

  return (
    <div className="page stack">
      <div>
        <h1 className="page-title">{t('bowl.title')}</h1>
        <p className="page-sub">{t('bowl.subtitle')}</p>
      </div>

      {/* Городская панорама района. При prefers-reduced-motion слой стоит
          (см. bowl.css). Райдер убран 2026-10-19: без заездов он осиротел. */}
      <section
        className={`bowl-hero${reducedMotion ? ' bowl-still' : ''}`}
        role="img"
        aria-label={t('bowl.heroAlt')}
      >
        <div className="bowl-hero-far" style={{ backgroundImage: `url(${ART}/bowl-hero.webp)` }} />
      </section>

      {/* Старт для нового игрока: порядок действий, доступность и демо-режим —
          до первого клика, а не после первой ошибки. */}
      <section className="card stack-sm" data-testid="bowl-start">
        <div className="strong">{t('skate.start')}</div>
        <ol className="stack-sm" style={{ margin: 0, paddingLeft: 20 }}>
          <li><Link to="/grid">{t('skate.step1')}</Link></li>
          <li><Link to="/bowl/tag">{t('skate.step2')}</Link></li>
          <li><Link to="/bowl/builder">{t('skate.step3')}</Link></li>
        </ol>
        <div className="tiny muted">{t('skate.browse')}</div>
        <div className="tiny muted">{t('skate.wallet')}</div>
        {isMock() && <div className="warn tiny" data-testid="bowl-mock-note">{t('skate.mock')}</div>}
      </section>

      <div className="strong" aria-hidden>{t('skate.create')}</div>
      <section className="card stack-sm">
        <div className="strong">{t('builder.boards')}</div>
        <div className="small muted">{t('builder.boardsHint')}</div>

        {/* Целая доска района одним артом: фон района — в самом арте,
            вторая подложка-сцена давала двойной фон (жалоба 2026-10-18),
            поэтому здесь только рамка цветом района. */}
        <img
          className="bowl-wide"
          style={{ border: `2px solid ${collectionColor(boardDistrict)}`, borderRadius: 14 }}
          src={`${ART}/board-d${boardDistrict}.webp`}
          alt=""
          loading="lazy"
          decoding="async"
          data-testid="bowl-fullboard"
        />
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }} role="group" aria-label={t('builder.boards')}>
          {[0, 1, 2, 3, 4, 5, 6, 7].map((d) => (
            <button
              key={d}
              type="button"
              className={`btn btn-sm${boardDistrict === d ? '' : ' btn-ghost'}`}
              aria-pressed={boardDistrict === d}
              onClick={() => setBoardDistrict(d)}
            >
              {collectionName(d)}
            </button>
          ))}
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Link to="/bowl/builder" className="btn btn-sm">{t('bowl.openBuilder')}</Link>
        </div>
      </section>


      {/* Экспозиции как отдельного пустого экрана больше нет (2026-10-18):
          три вечно пустые рамки на хабе не давали ничего. Витрина досок —
          выше на этой странице и в конструкторе, а крышки на доску ставят из
          конструктора (кнопка ведёт в /bowl/rig оттуда). */}

      {/* Команда (docs/16 §5.6): имя, состав и сегмент стены. Хартия покупает
          имя и доску — стену всё так же зарабатывают ездой (§3.4). */}
      <div className="strong" aria-hidden>{t('skate.together')}</div>
      <section className="card stack-sm">
        <div className="strong">{t('crew.title')}</div>
        <div className="small muted">{t('skate.crewHint')}</div>
        <div className="small muted">{t('crew.intro')}</div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Link to="/bowl/crew" className="btn btn-sm">
            {t('crew.open')}
          </Link>
        </div>
      </section>

      <div className="strong" aria-hidden>{t('skate.play')}</div>
      {/* Части досок зарабатываются во Floodgrid (2026-10-19): сектор на 2+
          звезды раз в неделю даёт недостающую часть района недели. Заездов
          больше нет — скейты остались коллекцией, а не отдельной игрой. */}
      <section className="card stack-sm">
        <div className="strong">{t('skate.partsTitle')}</div>
        <div className="small muted">{t('skate.partsHint')}</div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Link to="/grid" className="btn btn-sm" data-testid="bowl-open-grid">
            {t('skate.openGrid')}
          </Link>
          {/* Детали доски также платят квесты/достижения (PR #66/#67). */}
          <Link to="/quests" className="btn btn-sm btn-ghost">
            {t('nav.quests')}
          </Link>
        </div>
      </section>

      <section className="card stack-sm">
        <div className="strong">{t('bowl.wallTitle')}</div>
        <img className="bowl-wide" src={`${ART}/wall-district.webp`} alt="" />
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {/* Редактор и стена уже работают: рисуй тег и занимай слот (docs/16 §3.2–3.4). */}
          <Link to="/bowl/tag" className="btn btn-sm">
            {t('bowl.openEditor')}
          </Link>
          {/* Стена уже принимает теги: смотри docs/16 §3.4. */}
          <Link to="/bowl/wall/0" className="btn btn-sm btn-ghost">
            {t('bowl.openWall')}
          </Link>
          {/* Доска недели: пять тегов города, выбранных жеребьёвкой. */}
          <Link to="/bowl/board" className="btn btn-sm btn-ghost">
            {t('board.title')}
          </Link>
        </div>
      </section>

      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Link to="/collection" className="btn btn-sm btn-ghost">
          {t('bowl.toCaps')}
        </Link>
      </div>

      <p className="tiny muted">{t('bowl.note')}</p>
    </div>
  );
}
