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
// Бэкенда пока нет: состояние живёт в компоненте, контур API (docs/16 §7)
// поднимается моком отдельным шагом. Ничего из показанного здесь не влияет на
// шансы, фьюжн, стейкинг и маркет — инварианты docs/16 §9.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useUiStore } from '@/app/store/ui';
import { useT } from '@/shared/i18n';
import './bowl.css';

const ART = '/art/skate';
const RIDERS = ['01', '02', '03', '04', '05', '06', '07', '08'] as const;

/** Слоты доски: файл спрайта и ключ подписи. Порядок — порядок слоёв в превью. */
const PARTS = [
  { file: 'wheels', label: 'bowl.partWheels' },
  { file: 'trucks', label: 'bowl.partTrucks' },
  { file: 'deck', label: 'bowl.partDeck' },
  { file: 'grip', label: 'bowl.partGrip' },
] as const;

export default function Bowl() {
  const t = useT();
  const reducedMotion = useUiStore((s) => s.reducedMotion);
  const [rider, setRider] = useState<string>('01');
  const [off, setOff] = useState<Record<string, boolean>>({});

  return (
    <div className="page stack">
      <div>
        <h1 className="page-title">{t('bowl.title')}</h1>
        <p className="page-sub">{t('bowl.subtitle')}</p>
      </div>

      {/* Параллакс: дальний фон и райдер двигаются с разной скоростью, оттого
          и глубина. При prefers-reduced-motion оба слоя стоят (см. bowl.css). */}
      <section
        className={`bowl-hero${reducedMotion ? ' bowl-still' : ''}`}
        role="img"
        aria-label={t('bowl.heroAlt')}
      >
        <div className="bowl-hero-far" style={{ backgroundImage: `url(${ART}/bowl-hero.webp)` }} />
        <img className="bowl-hero-near" src={`${ART}/rider-${rider}.webp`} alt="" />
      </section>

      <section className="card stack-sm">
        <div className="strong">{t('bowl.rigTitle')}</div>
        <div className="small muted">{t('bowl.rigSub')}</div>

        <div className="bowl-board">
          {PARTS.map((p) => (
            <img
              key={p.file}
              className={`bowl-board-part bowl-board-${p.file}${off[p.file] ? ' is-off' : ''}`}
              src={`${ART}/${p.file}.webp`}
              alt=""
            />
          ))}
        </div>

        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          {PARTS.map((p) => (
            <button
              key={p.file}
              type="button"
              className={`btn btn-sm${off[p.file] ? '' : ' btn-ghost'}`}
              aria-pressed={!off[p.file]}
              onClick={() => setOff((prev) => ({ ...prev, [p.file]: !prev[p.file] }))}
            >
              {t(p.label)}
            </button>
          ))}
        </div>
      </section>

      <section className="card stack-sm">
        <div className="strong">{t('bowl.riderTitle')}</div>
        <div className="bowl-riders">
          {RIDERS.map((n) => (
            <button
              key={n}
              type="button"
              className={`bowl-rider${rider === n ? ' is-on' : ''}`}
              aria-pressed={rider === n}
              aria-label={t('bowl.riderPick', { n })}
              onClick={() => setRider(n)}
            >
              <img src={`${ART}/rider-${n}.webp`} alt="" />
            </button>
          ))}
        </div>
      </section>

      <section className="card stack-sm">
        <div className="strong">{t('bowl.exhibitTitle')}</div>
        <div className="bowl-niche">
          <img className="bowl-niche-bg" src={`${ART}/empty-niche.webp`} alt="" />
          <div className="bowl-slots">
            {/* Три пустых слота экспозиции: рамка из арта, содержимое рисует код,
                когда появятся выставленные крышки (docs/16 §4.3). */}
            {[0, 1, 2].map((i) => (
              <img key={i} className="bowl-slot" src={`${ART}/ui-slot.webp`} alt="" />
            ))}
          </div>
        </div>
        <div className="small muted">{t('bowl.exhibitEmpty')}</div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Link to="/bowl/rig" className="btn btn-sm">
            {t('bowl.openRig')}
          </Link>
        </div>
      </section>

      {/* Команда (docs/16 §5.6): имя, состав и сегмент стены. Хартия покупает
          имя и доску — стену всё так же зарабатывают ездой (§3.4). */}
      <section className="card stack-sm">
        <div className="strong">{t('crew.title')}</div>
        <div className="small muted">{t('crew.intro')}</div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Link to="/bowl/crew" className="btn btn-sm">
            {t('crew.open')}
          </Link>
        </div>
      </section>

      {/* Линия (docs/16 §5.1): чаша дня одна на всех, три бесплатных заезда. */}
      <section className="card stack-sm">
        <div className="strong">{t('bowl.lineTitle')}</div>
        <img className="bowl-wide" src="/art/skate/line-bg.webp" alt="" aria-hidden loading="lazy" decoding="async" />
        <div className="small muted">{t('bowl.lineSub')}</div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Link to="/bowl/line" className="btn btn-sm">
            {t('bowl.openLine')}
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
