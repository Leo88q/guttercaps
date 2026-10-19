// Стена района (docs/16 §3.4).
//
// Три вещи, которые здесь решены:
//
// 1. **Стену нельзя купить.** Слот даётся за активность (7 дней подряд) и одну
//    застейканную крышку. На экране это видно до нажатия: кнопка объясняет, чего
//    не хватает, а не молчит.
// 2. **Телефон — основной экран.** 200 слотов на 412 px не нарисовать 20
//    колонками: сетка 10×20, ячейка 44 px (ровно палец), стена скроллится и
//    вправо, и вниз. Ничего не требует клавиатуры, всё — тапом.
// 3. **Графика — сгенерированная.** Фон стены и сами теги — файлы; код делает
//    только раскладку, слои и состояние. Тег вставляется как <img src="/v1/tags/…/svg">,
//    а не как innerHTML: в картинке у SVG нет исполняемого контекста.
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useT } from '@/shared/i18n';
import { useCollections } from '@/shared/lib/lore';
import { useUiStore } from '@/app/store/ui';
import { API_BASE } from '@/app/config';
import { useClaimSlot, useMyTags, useMyWall, useReleaseSlot, useRenewSlot, useReportTag, useWall, type TagReportReason } from '@/api/hooksLazy';
import { fmtLocale, useLocale } from '@/shared/i18n';
import { Pill, Modal } from '@/shared/ui/primitives';
import { shortKey } from '@/shared/lib/format';
import { sanitizeInlineSvg, TagThumb, TagTimeLapse, useTagSvgById } from './TagTimeLapse';
import './wall.css';

const REASONS: TagReportReason[] = ['hate', 'violence', 'sexual', 'ads', 'personal_data', 'other'];
/** Ячейка 44 px — палец, а не мышка; сетка 10×20 потому, что 20 колонок в 412 px не влезают. */
const COLS = 10;

export const tagImageUrl = (id: string) => `${API_BASE}/tags/${id}/svg`;

/** Поля из openapi-типов приходят опциональными — здесь они становятся обязательными. */
interface WallElig {
  activeDays: number; activeDaysNeeded: number; stakedCaps: number; stakedCapsNeeded: number;
  eligible: boolean; reason: string | null; mySlot: number | null;
}
function eligibilityOf(src?: {
  activeDays?: number; activeDaysNeeded?: number; stakedCaps?: number; stakedCapsNeeded?: number;
  eligible?: boolean; reason?: string | null; mySlot?: number | null;
}): WallElig | undefined {
  if (!src) return undefined;
  return {
    activeDays: Number(src.activeDays ?? 0),
    activeDaysNeeded: Number(src.activeDaysNeeded ?? 7),
    stakedCaps: Number(src.stakedCaps ?? 0),
    stakedCapsNeeded: Number(src.stakedCapsNeeded ?? 1),
    eligible: src.eligible === true,
    reason: src.reason ?? null,
    mySlot: src.mySlot ?? null,
  };
}

export default function Wall() {
  const { district } = useParams<{ district: string }>();
  const idx = Math.max(0, Math.min(7, Number(district ?? 0) || 0));
  const t = useT();
  const { locale } = useLocale();
  const toast = useUiStore((s) => s.toast);
  const collections = useCollections();
  const district0 = collections[idx];

  const view = useWall(idx);
  const mine = useMyWall();
  const tags = useMyTags();
  const claim = useClaimSlot();
  const renew = useRenewSlot();
  const release = useReleaseSlot();
  const report = useReportTag();

  const [open, setOpen] = useState<number | null>(null);
  const [tagId, setTagId] = useState('');
  const myTags = useMemo(() => (tags.data?.items ?? []).filter((x) => x.status === 'live'), [tags.data]);
  useEffect(() => {
    const first = myTags[0];
    if (!tagId && first?.id) setTagId(first.id);
  }, [myTags, tagId]);

  const bySlot = useMemo(() => new Map((view.data?.items ?? []).map((i) => [Number(i.slot), i] as const)), [view.data]);
  const layers = useMemo(() => {
    const map = new Map<number, { tagId: string; wallet: string }[]>();
    for (const l of view.data?.layers ?? []) {
      const slot = Number(l.slot);
      const list = map.get(slot) ?? [];
      if (list.length < 3) list.push({ tagId: l.tagId ?? '', wallet: l.wallet ?? '' });
      map.set(slot, list);
    }
    return map;
  }, [view.data]);

  // Право и свой слот: со стены (если зашли анонимно — из /me/wall).
  const me = useMemo(() => {
    if (view.data?.me) return eligibilityOf(view.data.me);
    if (!mine.data) return undefined;
    return eligibilityOf({ ...mine.data.eligibility, mySlot: (mine.data.items ?? []).find((i) => Number(i.district) === idx)?.slot ?? null });
  }, [view.data, mine.data, idx]);
  const mySlot = me?.mySlot ?? null;
  const opened = open === null ? null : bySlot.get(open) ?? null;
  /** Перезапуск таймлапса: по кнопке «ещё раз» тег рисуется заново. */
  const [replay, setReplay] = useState(0);
  const { svg: tagSvg } = useTagSvgById(opened?.tagId ?? undefined);
  // Инлайним только то, что прошло санитайзер; иначе тег остаётся картинкой.
  const timelapse = useMemo(() => (tagSvg ? sanitizeInlineSvg(tagSvg) : ''), [tagSvg]);
  const mineOpened = opened !== null && mySlot === open;
  const busy = claim.isPending || renew.isPending || release.isPending || report.isPending;

  function onClaim() {
    if (!tagId) return;
    claim.mutate({ district: idx, tagId, slot: open ?? undefined }, {
      onSuccess: () => { setOpen(null); toast({ kind: 'info', title: { key: 'wall.claim' }, body: { key: 'wall.claimed' } }); },
      onError: () => toast({ kind: 'error', title: { key: 'wall.claim' }, body: { key: 'wall.failed' } }),
    });
  }

  return (
    <div className="page stack">
      <div>
        <h1 className="page-title">{t('wall.title')}</h1>
        <p className="page-sub">{district0?.name} — {t('wall.subtitle')}</p>
        {/* Доска недели — тот же город, другой взгляд: пять тегов со всех стен. */}
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <Link to="/bowl/board" className="btn btn-sm btn-ghost">{t('board.title')}</Link>
        </div>
      </div>

      {/* Право на слот: показываем, чего не хватает, до того как игрок нажмёт. */}
      <section className="card stack-sm">
        <div className="row between" style={{ alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
          <span className="strong">{t('wall.slotsTaken', { taken: view.data?.taken ?? 0, slots: view.data?.slots ?? 200 })}</span>
          {me ? <Pill active={!!me.eligible}>{t('wall.haveDays', { n: me.activeDays, m: me.activeDaysNeeded })}</Pill> : null}
        </div>
        {me && !me.eligible ? (
          <div className="small muted">
            {me.reason === 'need_staked_cap' ? t('wall.needStake') : t('wall.needDays', { n: me.activeDaysNeeded })}
          </div>
        ) : null}

        {me?.eligible && mySlot === null ? (
          myTags.length === 0 ? (
            <Link to="/bowl/tag" className="btn">{t('wall.goEditor')}</Link>
          ) : (
            <div className="stack-sm">
              <span className="label">{t('wall.pickTag')}</span>
              <div className="tag-list">
                {myTags.map((x, i) => (
                  <Pill key={x.id ?? i} active={tagId === x.id} onClick={() => setTagId(x.id ?? '')}>
                    <TagThumb id={x.id ?? undefined} className="wall-pill-thumb" />
                    {fmtLocale.dateTime(Date.parse(x.createdAt ?? ''), locale)}
                  </Pill>
                ))}
              </div>
              <button type="button" className="btn" disabled={busy || !tagId} onClick={() => claim.mutate({ district: idx, tagId })}>
                {t('wall.claim')}
              </button>
            </div>
          )
        ) : null}

        {mySlot !== null ? (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span className="small">{t('wall.mySlot', { n: mySlot })}</span>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => renew.mutate({ district: idx })}>{t('wall.renew')}</button>
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => release.mutate({ district: idx })}>{t('wall.release')}</button>
          </div>
        ) : null}
      </section>

      <section className="wall-scroll">
        <div className="wall-grid" style={{ gridTemplateColumns: `repeat(${COLS}, 44px)`, backgroundImage: 'url(/art/skate/wall-district.webp)' }}>
          {Array.from({ length: view.data?.slots ?? 200 }, (_, i) => {
            const item = bySlot.get(i);
            const under = layers.get(i) ?? [];
            return (
              <button
                key={i}
                type="button"
                className={`wall-slot${item ? ' is-taken' : ''}${mySlot === i ? ' is-mine' : ''}${open === i ? ' is-open' : ''}`}
                aria-label={item ? t('wall.slotAlt', { n: i }) : t('wall.slotEmpty', { n: i })}
                onClick={() => setOpen(i)}
              >
                {/* Прошлое стены: прошлые теги лежат под свежим слоем краски. */}
                {under.map((l, k) => (
                  <TagThumb key={`${l.tagId}-${k}`} id={l.tagId ?? undefined} className="wall-layer" style={{ opacity: 0.3 - k * 0.08 }} />
                ))}
                {item ? <TagThumb id={item.tagId ?? undefined} className="wall-tag" /> : null}
              </button>
            );
          })}
        </div>
      </section>

      {open !== null && (
        <Modal open onClose={() => setOpen(null)}>
          <div className="stack">
            <div className="strong">{opened ? t('wall.slotTitle', { n: open }) : t('wall.slotEmptyTitle', { n: open })}</div>
            {opened ? (
              <>
                {/* Таймлапс: тег рисует себя сам, в порядке мазков. Если текст
                    тега не достался — остаётся старая картинка. */}
                {timelapse
                  ? <TagTimeLapse svg={timelapse} className="wall-preview" runId={replay} />
                  : <TagThumb id={opened.tagId ?? undefined} className="wall-preview" />}
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setReplay((n) => n + 1)}>{t('wall.replay')}</button>
                <div className="tiny muted">
                  {shortKey(opened.wallet ?? '')} · {fmtLocale.dateTime(Date.parse(opened.appliedAt ?? ''), locale)}
                  {' · '}{t('wall.daysLeft', { n: Math.max(0, Math.ceil((Date.parse(opened.expiresAt ?? '') - Date.now()) / 86_400_000)) })}
                </div>
                {mineOpened ? (
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => renew.mutate({ district: idx })}>{t('wall.renew')}</button>
                    <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => { release.mutate({ district: idx }); setOpen(null); }}>{t('wall.release')}</button>
                  </div>
                ) : (
                  <div className="stack-sm">
                    <span className="label">{t('wall.reportTitle')}</span>
                    <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                      {REASONS.map((r) => (
                        <button
                          key={r}
                          type="button"
                          className="btn btn-sm"
                          disabled={busy}
                          onClick={() => report.mutate({ id: opened.tagId ?? '', reason: r }, {
                            onSuccess: () => { setOpen(null); toast({ kind: 'info', title: { key: 'wall.report' }, body: { key: 'wall.reported' } }); },
                          })}
                        >
                          {t(`wall.reason_${r}`)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="small muted">{t('wall.slotFree')}</div>
                {me?.eligible && mySlot === null && myTags.length > 0 ? (
                  <button type="button" className="btn" disabled={busy || !tagId} onClick={onClaim}>{t('wall.claimHere')}</button>
                ) : (
                  <Link to="/bowl/tag" className="btn btn-ghost">{t('wall.goEditor')}</Link>
                )}
              </>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
