// Доска недели (docs/16 §3.7).
//
// Пять тегов города на неделю. Главное, что здесь не так, как в обычной
// «доске лучших»: **доска не ранжирует**. Никакого «места», никакого счёта,
// никакой стрелки вверх. Пять тегов выбираются жеребьёвкой среди висящих на
// стенах — потому что рейтинг на пользовательском контенте превращает кнопку
// «пожаловаться» в оружие: достаточно скооперироваться, и чужой тег уезжает
// вниз. У нас жалоба — фильтр допуска (подтверждённая модератором снимает тег
// с доски на эту неделю), а не минус к счёту, которого нет.
//
// Сид розыгрыша показываем: доску можно пересчитать и сверить.
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useT, fmtLocale, useLocale } from '@/shared/i18n';
import { useCollections } from '@/shared/lib/lore';
import { shortKey } from '@/shared/lib/format';
import { useWallBoard } from '@/api/hooksLazy';
import { Pill } from '@/shared/ui/primitives';
import { sanitizeInlineSvg, TagThumb, TagTimeLapse, useTagSvgById } from './TagTimeLapse';
import './wall.css';

const DAY_MS = 86_400_000;

/** Одна карточка доски: тег рисует себя сам — это и есть подача витрины. */
function BoardTag({ tagId, wallet, district, slot, runId }: { tagId: string; wallet: string; district: number; slot: number; runId: number }) {
  const t = useT();
  const collections = useCollections();
  const { svg } = useTagSvgById(tagId || undefined);
  const safe = useMemo(() => (svg ? sanitizeInlineSvg(svg) : ''), [svg]);
  const name = collections[district]?.name ?? t('grid.districtN', { n: district });

  return (
    <article className="card board-card stack-sm">
      {safe
        ? <TagTimeLapse svg={safe} className="wall-preview" runId={runId} />
        : <TagThumb id={tagId || undefined} className="wall-preview" />}
      <div className="row between" style={{ alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <span className="strong">{shortKey(wallet)}</span>
        <Pill>{name}</Pill>
      </div>
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span className="tiny muted">{t('board.slot', { n: slot })}</span>
        <Link className="btn btn-sm btn-ghost" to={`/bowl/wall/${district}`}>{t('board.goWall')}</Link>
      </div>
    </article>
  );
}

export default function Board() {
  const t = useT();
  const { locale } = useLocale();
  const board = useWallBoard();
  const data = board.data;
  const items = data?.items ?? [];

  const days = data ? Math.max(0, Math.ceil((Date.parse(data.weekEnd) - Date.now()) / DAY_MS)) : 0;

  return (
    <div className="page stack">
      <div>
        <h1 className="page-title">{t('board.title')}</h1>
        <p className="page-sub">
          {data ? `${fmtLocale.date(Date.parse(data.weekStart), locale)} — ${fmtLocale.date(Date.parse(data.weekEnd), locale)}` : ' '}
        </p>
      </div>

      {/* Правило видно на самой витрине: доска не рейтинг, и почему — тоже видно. */}
      <section className="card stack-sm">
        <div className="row between" style={{ alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
          <span className="strong">{t('board.ruleTitle')}</span>
          <Pill active>{t('board.daysLeft', { n: days })}</Pill>
        </div>
        <p className="small muted">{t('board.rule')}</p>
        {data ? (
          <div className="tiny muted">
            {t('board.candidates', { n: data.candidates })} · {t('board.seed')}: <code>{String(data.seedHex).slice(0, 16)}…</code>
          </div>
        ) : null}
        <div className="tiny muted">{t('board.formula')}</div>
      </section>

      {board.isLoading ? <div className="card muted small">{t('board.loading')}</div> : null}

      {!board.isLoading && items.length === 0 ? (
        <section className="card stack-sm">
          <span className="strong">{t('board.empty')}</span>
          <Link className="btn" to="/bowl/wall/0">{t('board.goWall')}</Link>
        </section>
      ) : null}

      <div className="board-grid">
        {items.map((it, i) => (
          <BoardTag
            key={`${it.tagId ?? i}-${it.district ?? 0}-${it.slot ?? i}`}
            tagId={String(it.tagId ?? '')}
            wallet={String(it.wallet ?? '')}
            district={Number(it.district ?? 0)}
            slot={Number(it.slot ?? 0)}
            runId={0}
          />
        ))}
      </div>
    </div>
  );
}
