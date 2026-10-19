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
import { useConnection } from '@solana/wallet-adapter-react';
import { BOARD_PARTS, BOARD_SET_SLOTS, BOARD_SLOTS, SERVICE_BY_ID, partById, stockLoadout, type BoardPart } from '@guttercaps/economy';
import { api, claimWithRetry, isMock } from '@/api/client';
import { useBoard, useSetBoard, type BoardSlot } from '@/api/hooksLazy';
import { useGameConfig, useWalletLike } from '@/chain/hooks';
import { payForService, quoteService, serviceRefHash } from '@/chain/flows/serviceFlow';
import { Currency } from '@/chain/ix/chipCore';
import { useT } from '@/shared/i18n';
import { useUiStore } from '@/app/store/ui';
import { collectionColor, collectionName } from '@/shared/lib/rarity';
import { BOARD_ART, boardFullArt, partVisual } from '@/shared/lib/boardArt';
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

/**
 * Одна деталь в витрине: кадр, подпись и состояние («добыто» или
 * «где взять»). Навесное из магазина (§5.4 п.5) покупается здесь
 * же: тап по закрытой плитке платит 49¢ и выдаёт деталь, второй
 * тап — надевает.
 */
function PartTile({ part, slot, worn, owned, onPick, onBuy, buying }: {
  part: BoardPart; slot: BoardSlot; worn: boolean; owned: boolean; onPick: () => void; onBuy: () => void; buying: boolean;
}) {
  const t = useT();
  const art = partVisual(part.id);
  const label = partLabel(part.id);
  const shopLocked = !owned && part.source === 'shop';
  return (
    <button
      type="button"
      className={`bd-tile${worn ? ' is-worn' : ''}${owned ? '' : ' is-locked'}`}
      onClick={shopLocked ? onBuy : onPick}
      aria-label={t('builder.partAlt', { slot: t(slotKey(slot)), district: label.name || t(`builder.tier.${part.tier}` as 'builder.tier.stock') })}
    >
      <span className="bd-tile-art">
        {art
          ? <img src={art} alt="" loading="lazy" decoding="async" />
          : <img className="bd-tile-none" src={`${BOARD_ART}/ui-slot.webp`} alt="" />}
      </span>
      <span className="tiny">{label.name || t(`builder.tier.${part.tier}` as 'builder.tier.stock')}</span>
      <span className="tiny muted">
        {owned
          ? t('builder.owned')
          : shopLocked
            ? t('builder.buy', { cents: SERVICE_BY_ID.boardMount.priceUsdCents })
            : t(`builder.source.${part.source}` as 'builder.source.grid')}
      </span>
      {shopLocked && buying ? <span className="tiny muted">{t('builder.buying')}</span> : null}
      {worn ? <span className="bd-worn tiny">{t('builder.wearing')}</span> : null}
    </button>
  );
}

/**
 * Собранная доска — целым артом района, а не стопкой плоских слоёв: до
 * 2026-10-17 превью складывало отдельные картинки деки/траков/колёс друг на
 * друга и выглядело разобранным скейтом. Теперь: если надет сет района (или
 * хотя бы его дека) — показываем готовую доску этого района одним файлом
 * (board-dN.webp), а слоты живут строкой кнопок под артом.
 */
function BoardPreview({ loadout, districtSet, onSlot }: { loadout: Record<string, string>; districtSet: number | null | undefined; onSlot: (slot: BoardSlot) => void }) {
  const t = useT();
  const deckPart = partById(loadout.deck);
  // Показывать район ЛЮБОЙ надетой районной детали, не только деки: иначе
  // постановка траков/колёс/грипа визуально «никуда не ставится» — сервер
  // деталь принял, а превью доски не изменилось.
  const wornDistrict = (['deck', 'trucks', 'wheels', 'grip'] as const)
    .map((s) => partById(loadout[s])?.district)
    .find((x) => x !== null && x !== undefined) ?? null;
  const d = districtSet ?? deckPart?.district ?? wornDistrict;
  return (
    <div className="stack-sm">
      <img
        className="bd-fullboard"
        style={{ borderColor: d === null ? undefined : collectionColor(d) }}
        src={d === null ? `${BOARD_ART}/deck.webp` : boardFullArt(d)}
        alt=""
        decoding="async"
        data-testid="builder-fullboard"
      />
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {BOARD_SLOTS.map((slot) => (
          <button key={slot} type="button" className="btn btn-sm btn-ghost" onClick={() => onSlot(slot as BoardSlot)}>
            {t(slotKey(slot))}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function Builder() {
  const t = useT();
  const toast = useUiStore((s) => s.toast);
  const view = useBoard();
  const setBoard = useSetBoard();
  const [slot, setSlot] = useState<BoardSlot | null>(null);
  const [buyingPart, setBuyingPart] = useState<string | null>(null);
  const { connection } = useConnection();
  const walletLike = useWalletLike();
  const gameCfg = useGameConfig();

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

  /**
   * Купить навесное (§5.4 п.5): услуга boardMount, 49¢, payload
   * {part} — реф-хеш связывает платёж с конкретной деталью,
   * выдача (grantPart source 'shop') — в той же транзакции, что
   * и consume, на сервере.
   */
  async function buyPart(partId: string) {
    if (buyingPart) return;
    setBuyingPart(partId);
    try {
      if (isMock()) {
        await api.post('/services/claim', {
          signature: `mock-${Date.now()}`, kind: SERVICE_BY_ID.boardMount.kind, payload: { part: partId },
        } as never);
      } else {
        if (!walletLike || !gameCfg.data) throw new Error('wallet');
        const payload = { part: partId };
        const refHash = serviceRefHash(SERVICE_BY_ID.boardMount.kind, walletLike.publicKey, payload);
        const { signature } = await payForService({
          connection, wallet: walletLike, id: 'boardMount', currency: Currency.USDC, refHash,
          quote: quoteService('boardMount', Currency.USDC), cfg: gameCfg.data,
        });
        await claimWithRetry(() => api.post('/services/claim', { signature, kind: SERVICE_BY_ID.boardMount.kind, payload } as never));
      }
      await view.refetch();
      toast({ kind: 'money', title: { key: 'builder.title' }, body: { key: 'builder.bought' } });
    } catch (e) {
      toast({ kind: 'error', title: { key: 'builder.title' }, body: { key: 'builder.failed' } });
    } finally { setBuyingPart(null); }
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
            {/* Собранная доска: целый арт района; тап по слоту открывает его детали. */}
            <BoardPreview loadout={loadout} districtSet={districtSet} onSlot={(s) => setSlot(s)} />
          </section>

          {/* Доски районов: витрина целых артов. Четыре добытые части района
              открывают его доску, и её можно надеть сетом одним тапом. */}
          <section className="card stack-sm" data-testid="builder-boards">
            <div className="strong">{t('builder.boards')}</div>
            <div className="small muted">{t('builder.boardsHint')}</div>
            <div className="bd-boards">
              {[0, 1, 2, 3, 4, 5, 6, 7].map((d) => {
                const have = BOARD_SET_SLOTS.filter((s) => owned.has(`${s}_d${d}`)).length;
                const complete = have >= BOARD_SET_SLOTS.length;
                const isSet = districtSet !== null && districtSet !== undefined && Number(districtSet) === d;
                return (
                  <article key={d} className={`bd-board-card${complete ? '' : ' is-locked'}`}>
                    {/* Арт-фон чаши под каждой доской + оттенок её района. */}
                    <div className="board-stage" style={{ backgroundImage: 'url(/art/skate/board-stage.webp)', ['--tint' as string]: collectionColor(d) }}>
                      <img src={boardFullArt(d)} alt="" loading="lazy" decoding="async" />
                    </div>
                    <div className="row between" style={{ gap: 6, flexWrap: 'wrap' }}>
                      <span className="small strong">{collectionName(d)}</span>
                      <span className="tiny muted">{t('builder.boardProgress', { have, total: BOARD_SET_SLOTS.length })}</span>
                    </div>
                    {complete ? (
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={isSet || setBoard.isPending}
                        onClick={() => setBoard.mutate(
                          { slots: BOARD_SET_SLOTS.map((s) => ({ slot: s as BoardSlot, part: `${s}_d${d}` })) },
                          { onSuccess: () => toast({ kind: 'success', title: { key: 'builder.title' }, body: { key: 'builder.saved' } }), onError: () => toast({ kind: 'error', title: { key: 'builder.title' }, body: { key: 'builder.failed' } }) },
                        )}
                      >
                        {isSet ? t('builder.boardReady') : t('builder.wearSet')}
                      </button>
                    ) : (
                      <span className="tiny muted">{t('builder.where')}</span>
                    )}
                  </article>
                );
              })}
            </div>
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
              <Link to="/grid" className="btn btn-sm">{t('builder.toGrid')}</Link>
              <Link to="/quests" className="btn btn-sm btn-ghost">{t('builder.toQuests')}</Link>
              <Link to="/bowl/crew" className="btn btn-sm btn-ghost">{t('builder.toCrew')}</Link>
              {/* Крышки на собранную доску: бывшая «Экспозиция» живёт здесь,
                  рядом с доской, а не отдельным пустым экраном. */}
              <Link to="/bowl/rig" className="btn btn-sm btn-ghost">{t('bowl.openRig')}</Link>
            </div>
          </section>

          {/* Слоты: каждый — строка с надетой деталью и кнопкой «изменить». */}
          <section className="card stack-sm">
            {BOARD_SLOTS.map((s) => {
              const partId = loadout[s] ?? String(stock[s as BoardSlot]);
              const art = partVisual(partId);
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
                      {partById(partId)?.source ? ` · ${t(`builder.source.${partById(partId)?.source}` as 'builder.source.grid')}` : ''}
                    </span>
                  </span>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSlot(s as BoardSlot)}>
                    {t('builder.choose')}
                  </button>
                </div>
              );
            })}
            <p className="tiny muted">{t('builder.note')}</p>
          </section>

          {slot !== null && (
            <Modal open onClose={() => setSlot(null)} title={t('builder.pickTitle', { slot: t(slotKey(slot)) })}>
              <div className="stack-sm">
                {slot === 'deck' && <div className="strong">{t('builder.decks')}</div>}
                <div className="bd-grid">
                  {parts.map((p) => (
                    <PartTile
                      key={p.id}
                      part={p}
                      slot={slot}
                      worn={loadout[slot] === p.id}
                      owned={owned.has(p.id) || p.tier === 'stock'}
                      onPick={() => wear(p.id)}
                      onBuy={() => buyPart(p.id)}
                      buying={buyingPart === p.id}
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
