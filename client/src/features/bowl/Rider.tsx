// docs/16 §4.6 — Райдер.
//
// Образ, а не характеристики: один из восьми силуэтов района плюс цвет подсветки
// из темы, которую игрок **купил**. Ни силы, ни шансов, ни дохода — ровно то,
// что §4.6 обещает: «никаких характеристик». Смысл райдера в том, что его
// видят другие, поэтому он живёт на витрине (§4.5) рядом с доской.
//
// Арт настоящий: восемь файлов `art/skate/rider-0N.webp` и тайлы
// `rider-0N-thumb.webp` для полосы выбора (scripts/rider-thumbs.py — тот же
// кадр, ужатый в бокс, без перерисовки). Код здесь делает только раскладку,
// выбор и подсветку.
import { useMemo, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { useCollections } from '@/shared/lib/lore';
import { collectionColor } from '@/shared/lib/rarity';
import { PROFILE_THEMES, ownedThemes, themeById } from '@/shared/lib/cosmetics';
import { useMyServices } from '@/api/hooks';
import { useSetRider, type RigView } from '@/api/hooksLazy';
import { Pill } from '@/shared/ui/primitives';
import { useUiStore } from '@/app/store/ui';
import { useT } from '@/shared/i18n';

/** Силуэтов ровно восемь — по одному на район (§4.6). */
export const RIDER_COUNT = 8;

export const riderArt = (silhouette: number, thumb = false) =>
  `/art/skate/rider-0${(silhouette % RIDER_COUNT) + 1}${thumb ? '-thumb' : ''}.webp`;

/** Фигура района, подсвеченная цветом темы (или своим цветом, если темы нет). */
export function RiderFigure({ silhouette, lamp, alt }: { silhouette: number; lamp: string; alt: string }) {
  return (
    <span className="rider-figure" style={{ ['--lamp' as string]: lamp }}>
      <img src={riderArt(silhouette)} alt={alt} loading="lazy" decoding="async" />
    </span>
  );
}

/**
 * Карточка райдера. `mine` — со всеми переключателями; на чужой витрине та же
 * карточка, но только на просмотр: чужие настройки не меняют.
 */
export function RiderCard({ view, mine = false }: { view?: RigView | null; mine?: boolean }) {
  const t = useT();
  const toast = useUiStore((s) => s.toast);
  const COLLECTIONS = useCollections();
  const services = useMyServices();
  const setRider = useSetRider();
  const owned = useMemo(() => new Set(ownedThemes(services.data?.entitlements)), [services.data]);

  const rider = view?.rider ?? { silhouette: 0, theme: null };
  const silhouette = Math.min(RIDER_COUNT - 1, Math.max(0, rider.silhouette ?? 0));
  // Тема, которой больше не владеют (аренда истекла), не показывается и не
  // надевается: витрина не должна врать о покупке. Проверка есть и на сервере.
  const theme = rider.theme && owned.has(rider.theme) ? themeById(rider.theme) : null;
  const lamp = theme?.hex ?? collectionColor(silhouette);
  const districtName = COLLECTIONS[silhouette]?.name ?? `#${silhouette}`;

  const save = (patch: { silhouette?: number; theme?: string | null }) =>
    setRider.mutate(patch, {
      onError: () => toast({ kind: 'error', title: { key: 'rider.title' }, body: { key: 'rider.failed' } }),
    });

  return (
    <section className="card stack-sm">
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span className="strong">{t('rider.title')}</span>
        <span className="tiny muted">{t('rider.noStats')}</span>
      </div>

      <div
        className={`rider${theme ? ' is-themed' : ''}`}
        data-testid="rider"
        data-silhouette={silhouette}
        data-lamp={lamp}
        style={{ ['--lamp' as string]: lamp, ['--district' as string]: collectionColor(silhouette) } as CSSProperties}
      >
        <RiderFigure silhouette={silhouette} lamp={lamp} alt={t('rider.alt', { district: districtName })} />
        <div className="rider-meta">
          <b style={{ color: lamp }}>{districtName}</b>
          <span className="tiny muted">{theme ? theme.label : t('rider.lampDistrict', { district: districtName })}</span>
        </div>
      </div>

      {mine ? (
        <>
          <span className="label">{t('rider.pickFigure')}</span>
          <div className="rider-picks">
            {COLLECTIONS.slice(0, RIDER_COUNT).map((c, i) => (
              <button
                key={c.symbol}
                type="button"
                className={`rider-pick${i === silhouette ? ' is-active' : ''}`}
                aria-pressed={i === silhouette}
                aria-label={t('rider.pickAlt', { district: c.name })}
                data-testid="rider-pick"
                data-silhouette={i}
                onClick={() => save({ silhouette: i })}
              >
                <img src={riderArt(i, true)} alt="" loading="lazy" decoding="async" />
                <span className="tiny">{c.name}</span>
              </button>
            ))}
          </div>

          <span className="label">{t('rider.pickLamp')}</span>
          <div className="row-wrap" style={{ gap: 6 }}>
            <Pill active={!theme} onClick={() => save({ theme: null })}>{t('rider.lampDistrict', { district: districtName })}</Pill>
            {PROFILE_THEMES.map((th) => {
              const has = owned.has(th.id);
              return (
                <Pill key={th.id} active={theme?.id === th.id} onClick={has ? () => save({ theme: th.id }) : undefined}>
                  <span style={{ width: 8, height: 8, borderRadius: 4, background: has ? th.hex : '#3a3944', display: 'inline-block' }} />
                  {th.label}
                  {!has ? <span className="muted"> · {t('rider.buy')}</span> : null}
                </Pill>
              );
            })}
          </div>
          <div className="tiny muted">
            {t('rider.hint')} <Link to="/shop?tab=services">{t('rider.toShop')}</Link>
          </div>
        </>
      ) : null}
    </section>
  );
}
