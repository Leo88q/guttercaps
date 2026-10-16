// Конструктор доски (docs/16 §4.2).
//
// Три решения, которые видны на экране.
//
// 1. **Часть добывается, а не покупается.** Районный сет собирается заездами
//    (§5.1), квестами и командными конкурсами (§5.6); в магазине — только
//    навесное. Поэтому закрытая часть не «стоит 99 центов», а говорит, где её
//    берут, и ведёт туда ссылкой.
// 2. **Часть не даёт силы.** Ни веса, ни шанса, ни дохода — только вид. Экран
//    не показывает рядом с частью ни одного числа, кроме «добыто/нет».
// 3. **Телефон и нет клавиатуры.** Всё тапами: тап по слоту → тап по детали.
//    Никаких полей ввода, никаких длинных названий в две строки.
//
// Графика не рисуется кодом: каждая деталь — сгенерированный кадр из /art/skate
// (пластина, окрашенная краской района скриптом сборки арта).
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BOARD_PARTS, BOARD_SET_SLOTS, BOARD_SLOTS, partById, stockLoadout, type BoardPart } from '@guttercaps/economy';
import { useBoard, useSetBoard, type BoardSlot } from '@/api/hooksLazy';
import { useT } from '@/shared/i18n';
import { useUiStore } from '@/app/store/ui';
import { collectionName } from '@/shared/lib/rarity';
import { BOARD_ART, partArt } from '@/shared/lib/boardArt';
import { Modal, Pill, Skeleton } from '@/shared/ui/primitives';
import './builder.css';

/** Подпись части: район + уровень. Своих имён у частей нет — их называют район и происхождение. */
function partLabel(partId: string): { name: string; district: number | null; tier: string } {
  const part = partById(partId);
  if (!part) return { name: partId, district: null, tier: 'stock' };
  return {
    name: part.district === null ? '' : collectionName(part.district),
    district: part.district,
    tier: part.tier,
  };
}

const slotKey = (slot: string) => `builder.slots.${slot}` as 'builder.slots.deck';

/** Одна деталь в витрине: кадр, подпись и состояние («добыто» или «где взять»). */
function PartTile({ part, slot, worn, owned, onPick }: {
  part: BoardPart; slot: BoardSlot; worn: boolean; owned: boolean; onPick: () => void;
}) {
  const t = useT();
  const art = partArt(part.id);
  const label = partLabel(part.id);
  return (
    <button
      type="button"
      className={`bd-tile${worn ? ' is-worn' : ''}${owned ? '' : ' is-locked'}`}
      onClick={onPick}
      aria-label={t('builder.partAlt', { slot: t(slotKey(slot)), district: label.name || t(`builder.tier.${part.tier}` as 'builder.tier.stock') })}
    >
      <span className="bd-tile-art">
        {art
          ? <img src={art} alt="" loading="lazy" decoding="async" />
          : <img className="bd-tile-none" src={`${BOARD_ART}/ui-slot.webp`} alt="" />}
      </span>
      <span className="tiny">{label.name || t(`builder.tier.${part.tier}` as 'builder.tier.stock')}</span>
      <span className="tiny muted">
        {owned ? t('builder.owned') : t(`builder.source.${part.source}` as 'builder.source.run')}
      </span>
      {worn ? <span className="bd-worn tiny">{t('builder.wearing')}</span> : null}
    </button>
  );
}

/** Собранная доска: детали лежат так же, как на настоящей — снизу вверх. */
function BoardPreview({ loadout, onSlot }: { loadout: Record<string, string>; onSlot: (slot: BoardSlot) => void }) {
  const t = useT();
  const stack: BoardSlot[] = ['deck', 'grip', 'trucks', 'wheels', 'bolts', 'sticker'];
  return (
    <div className="bd-board">
      {stack.map((slot) => {
        const art = partArt(loadout[slot]);
        return (
          <button
            key={slot}
            type="button"
            className={`bd-layer bd-layer-${slot}`}
            onClick={() => onSlot(slot)}
            aria-label={t('builder.pickTitle', { slot: t(slotKey(slot)) })}
          >
            {art ? <img src={art} alt="" decoding="async" /> : <span className="bd-layer-none tiny muted">{t('builder.stock')}</span>}
            <span className="bd-layer-tag tiny">{t(slotKey(slot))}</span>
          </button>
        );
      })}
    </div>
  );
}

export default function Builder() {
  const t = useT();
  const toast = useUiStore((s) => s.toast);
  const view = useBoard();
  const setBoard = useSetBoard();
  const [slot, setSlot] = useState<BoardSlot | null>(null);

  const data = view.data;
  const stock = useMemo(() => stockLoadout(), []);
  const loadout: Record<string, string> = { ...stock, ...(data ? {
    deck: String(data.deck ?? stock.deck), trucks: String(data.trucks ?? stock.trucks),
    wheels: String(data.wheels ?? stock.wheels), grip: String(data.grip ?? stock.grip),
    bolts: String(data.bolts ?? stock.bolts), sticker: String(data.sticker ?? stock.sticker),
  } : {}) };
  const owned = new Set((data?.owned ?? []).map((p) => String(p?.part ?? '')));
  const districtSet = data?.set ?? null;

  // Витрина слота: порядок каталога не меняем — иначе деталь «прыгает» под
  // пальцем сразу после выдачи, и игрок промахивается.
  const parts = useMemo(() => (slot === null ? [] : BOARD_PARTS.filter((p) => p.slot === slot)), [slot]);

  function wear(partId: string | null) {
    if (!slot) return;
    setBoard.mutate({ slots: [{ slot, part: partId }] }, {
      onSuccess: () => {
        setSlot(null);
        toast({ kind: 'success', title: { key: 'builder.title' }, body: { key: 'builder.saved' } });
      },
      onError: () => toast({ kind: 'error', title: { key: 'builder.title' }, body: { key: 'builder.failed' } }),
    });
  }

  return (
    <div className="page stack">
      <div>
        <h1 className="page-title">{t('builder.title')}</h1>
        <p className="page-sub">{t('builder.intro')}</p>
      </div>

      {view.isLoading && <Skeleton h={220} />}
      {view.isError && <div className="small muted">{t('builder.failed')}</div>}

      {data ? (
        <>
          <section className="card stack-sm">
            <div className="row between" style={{ alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
              <span className="strong">{t('builder.set')}</span>
              {districtSet === null || districtSet === undefined
                ? <span className="tiny muted">{t('builder.setHint')}</span>
                : <Pill active>{`${collectionName(Number(districtSet))} · ${t('builder.setDone')}`}</Pill>}
            </div>
            {/* Собранная доска: тап по детали открывает её слот. */}
            <BoardPreview loadout={loadout} onSlot={(s) => setSlot(s)} />
          </section>

          {/* Район недели: один на весь город, поэтому заезд платит известную
              деталь, а не лотерею. */}
          <section className="card stack-sm">
            <div className="row between" style={{ alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
              <span className="strong">{t('builder.week')}</span>
              <span className="small">{collectionName(Number(data.week?.district ?? 0))}</span>
            </div>
            <div className="small muted">
              {data.week?.claimed
                ? t('builder.weekDone')
                : t('builder.weekPart', { part: t(slotKey(String(partById(String(data.week?.part ?? 'deck_d0'))?.slot ?? 'deck'))) })}
            </div>
            <div className="tiny muted">
              {t('builder.progress', { have: Number(data.weekProgress?.have ?? 0), total: Number(data.weekProgress?.total ?? 4) })}
            </div>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <Link to="/bowl/line" className="btn btn-sm">{t('builder.toLine')}</Link>
              <Link to="/quests" className="btn btn-sm btn-ghost">{t('builder.toQuests')}</Link>
              <Link to="/bowl/crew" className="btn btn-sm btn-ghost">{t('builder.toCrew')}</Link>
            </div>
          </section>

          {/* Слоты: каждый — строка с надетой деталью и кнопкой «изменить». */}
          <section className="card stack-sm">
            {BOARD_SLOTS.map((s) => {
              const partId = loadout[s] ?? String(stock[s as BoardSlot]);
              const art = partArt(partId);
              const label = partLabel(partId);
              return (
                <div key={s} className="bd-row">
                  <span className="bd-row-art">
                    {art ? <img src={art} alt="" loading="lazy" decoding="async" /> : null}
                  </span>
                  <span className="bd-row-text">
                    <span className="small strong">{t(slotKey(s))}</span>
                    <span className="tiny muted">
                      {label.name || t(`builder.tier.${partById(partId)?.tier ?? 'stock'}` as 'builder.tier.stock')}
                      {partById(partId)?.source ? ` · ${t(`builder.source.${partById(partId)?.source}` as 'builder.source.run')}` : ''}
                    </span>
                  </span>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSlot(s as BoardSlot)}>
                    {t('builder.wear')}
                  </button>
                </div>
              );
            })}
            <p className="tiny muted">{t('builder.note')}</p>
          </section>

          {slot !== null && (
            <Modal open onClose={() => setSlot(null)} title={t('builder.pickTitle', { slot: t(slotKey(slot)) })}>
              <div className="stack-sm">
                <div className="bd-grid">
                  {parts.map((p) => (
                    <PartTile
                      key={p.id}
                      part={p}
                      slot={slot}
                      worn={loadout[slot] === p.id}
                      owned={owned.has(p.id) || p.tier === 'stock'}
                      onPick={() => wear(p.id)}
                    />
                  ))}
                </div>
                <button type="button" className="btn btn-ghost btn-sm" disabled={setBoard.isPending} onClick={() => wear(null)}>
                  {t('builder.takeOff')}
                </button>
              </div>
            </Modal>
          )}
        </>
      ) : null}
    </div>
  );
}

/** Слоты сета — те, что собирают район; их и показывает «собери район». */
export const BUILDER_SET_SLOTS = BOARD_SET_SLOTS;
