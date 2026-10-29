// Экспозиция крышек (docs/16 §4.3) и витрина (§4.5).
//
// Три решения, которые видны на экране:
//
// 1. **Крышка остаётся твоей.** Экспозиция хранит ссылку, а не крышку: она не
//    сжигается, не передаётся и не блокируется — продашь или сожжёшь фьюжном,
//    слот просто опустеет. Редкость даёт ровно один эффект — визуальный.
// 2. **Слоты открываются коллекцией, а не деньгами.** Закрытый слот говорит,
//    сколько крышек не хватает, и ведёт в паки, маркет и фьюжн: каждая дырка
//    в доске указывает в существующий контур (правило-гейт из §0.2).
// 3. **Телефон и нет клавиатуры.** Всё — тапами: тап по слоту → тап по крышке.
//
// Графика не рисуется кодом: дека, грип и рамка слота — сгенерированные файлы
// из /art/skate, крышка рисуется существующим ChipArt.
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { useT } from '@/shared/i18n';
import { rarityColor, rarityName } from '@/shared/lib/rarity';
import { ChipArt } from '@/shared/ui/ChipArt';
import { Modal, Pill } from '@/shared/ui/primitives';
import { useUiStore } from '@/app/store/ui';
import { useRig, useRigOf, useSetRig, type RigCap, type RigChip, type RigSlot, type RigView } from '@/api/hooksLazy';
import { shortKey } from '@/shared/lib/format';
import { partArt, partVisual } from '@/shared/lib/boardArt';
import './rig.css';

const ART = '/art/skate';
/** Размер коллекции: 8 районов × 9 редкостей. Только для честного текста «собери N из 72». */
const CAPS_TOTAL = 72;

/** Свойство слота: `mine` — можно менять, витрина — только смотреть. */
interface BoardProps {
  view: RigView;
  mine: boolean;
  busy: boolean;
  onSlot: (slot: number) => void;
}

/** Поля из openapi-типов приходят опциональными — здесь они становятся числами. */
function SlotChip({ cap }: { cap: RigChip }) {
  const t = useT();
  const rarity = Number(cap.rarity ?? 0);
  const level = Number(cap.level ?? 1);
  return (
    <div className="rig-chip">
      <ChipArt collection={Number(cap.collection ?? 0)} rarity={rarity} index={null} level={level} crimp={rarityColor(rarity)} />
      <span className="rig-chip-name">{rarityName(rarity)}</span>
      <span className="rig-chip-sub">{t('rig.level', { n: level })}</span>
    </div>
  );
}

function Board({ view, mine, busy, onSlot }: BoardProps) {
  const t = useT();
  const slots = view.slots ?? [];
  // Дека — та, что собрана в конструкторе (§4.2): экспозиция стоит именно на
  // ней. Нет ответа конструктора (старый кэш, чужая витрина без доски) —
  // показываем стоковую деку, а не дыру.
  const deckArt = partVisual(String(view.board?.deck ?? '')) ?? `${ART}/deck.webp`;
  const gripArt = partArt(String(view.board?.grip ?? ''));
  const deck = slots.find((s) => s.place === 'deck') ?? slots[0];
  const deckSlot = Number(deck?.slot ?? -1);
  const grips = slots.filter((s) => Number(s.slot) !== deckSlot);

  const render = (s: RigSlot | undefined, big: boolean) => {
    if (!s) return null;
    const slot = Number(s.slot);
    const locked = !s.unlocked;
    return (
      <button
        key={slot}
        type="button"
        className={`rig-slot${big ? ' is-deck' : ''}${locked ? ' is-locked' : ''}${s.chip ? ' is-filled' : ''}`}
        aria-label={t('rig.slotAlt', { n: slot + 1 })}
        disabled={!mine || busy}
        onClick={() => onSlot(slot)}
      >
        {s.chip ? (
          <SlotChip cap={s.chip} />
        ) : (
          <>
            <img className="rig-slot-frame" src={`${ART}/ui-slot.webp`} alt="" />
            <span className="rig-slot-empty">{locked ? t('rig.locked', { n: s.unlockAt }) : t('rig.slotEmpty')}</span>
          </>
        )}
      </button>
    );
  };

  return (
    <div className="rig-board">
      <div className="rig-deck">
        <img className="rig-deck-art" src={deckArt} alt="" />
        <div className="rig-deck-slot">{render(deck, true)}</div>
      </div>
      {/* Грип — тоже из конструктора: доска собрана целиком, а не наполовину. */}
      <div className="rig-grip" style={gripArt ? { backgroundImage: `url(${gripArt})` } : undefined}>
        <div className="rig-grip-slots">{grips.map((s) => render(s, false))}</div>
        <span className="rig-grip-label">{t('rig.grip')}</span>
      </div>
      {view.next && mine ? (
        // Закрытый слот не продаётся: он говорит, сколько собрать, и ведёт в
        // существующие контуры — паки, маркет, фьюжн.
        <div className="rig-hint stack-sm">
          <span className="small">{t('rig.lockedHint', { n: view.next.need })}</span>
          <span className="label">{t('rig.whereToGet')}</span>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <Link to="/shop" className="btn btn-sm btn-ghost">{t('rig.toPacks')}</Link>
            <Link to="/market" className="btn btn-sm btn-ghost">{t('rig.toMarket')}</Link>
            <Link to="/fusion" className="btn btn-sm btn-ghost">{t('rig.toFusion')}</Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Моя доска: /bowl/rig. */
export default function Rig() {
  const t = useT();
  const toast = useUiStore((s) => s.toast);
  const { publicKey } = useWallet();
  const view = useRig();
  const setRig = useSetRig();
  const [pick, setPick] = useState<number | null>(null);
  const caps: RigCap[] = (view.data?.caps ?? []).filter((c): c is RigCap => !!c);
  const collected = caps.length;

  function choose(cap: RigCap | undefined) {
    if (pick === null) return;
    setRig.mutate({ slots: [{ slot: pick, asset: cap ? String(cap.asset) : null }] }, {
      onSuccess: () => { setPick(null); toast({ kind: 'info', title: { key: 'rig.title' }, body: { key: cap ? 'rig.set' : 'rig.cleared' } }); },
      onError: () => toast({ kind: 'error', title: { key: 'rig.title' }, body: { key: 'rig.failed' } }),
    });
  }

  return (
    <div className="page stack">
      <div>
        <h1 className="page-title">{t('rig.title')}</h1>
        <p className="page-sub">{t('rig.subtitle')}</p>
      </div>

      <section className="card stack-sm">
        <div className="row between" style={{ alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
          <span className="strong">{t('rig.collected', { n: collected, total: CAPS_TOTAL })}</span>
          {view.data?.public ? <Pill active>{t('rig.publicOn')}</Pill> : null}
        </div>
        <Board view={view.data ?? { wallet: '', public: false, caps: [], slots: [], next: null } as RigView} mine busy={setRig.isPending} onSlot={(slot) => setPick(slot)} />
        <p className="tiny muted">{t('rig.note')}</p>
        {/* Доска собирается в конструкторе (§4.2), а крышки ставятся здесь (§4.3):
            один экран без ссылки на другой оставляет половину доски невидимой. */}
        <Link to="/bowl/builder" className="btn btn-sm btn-ghost">{t('bowl.openBuilder')}</Link>
      </section>

      <section className="card stack-sm">
        <label className="row between" style={{ gap: 8 }}>
          <span className="strong">{t('rig.publicSwitch')}</span>
          <input
            type="checkbox"
            checked={view.data?.public === true}
            disabled={setRig.isPending || !view.data}
            onChange={(e) => setRig.mutate({ slots: [], public: e.currentTarget.checked })}
          />
        </label>
        <div className="tiny muted">{t('rig.publicHint')}</div>
        {publicKey ? (
          <Link to={`/rig/${publicKey.toBase58()}`} className="btn btn-sm btn-ghost">{t('rig.openPublic')}</Link>
        ) : null}
      </section>

      {pick !== null && (
        <Modal open onClose={() => setPick(null)} title={t('rig.pickTitle')}>
          <div className="stack-sm">
            {caps.length === 0 ? (
              <>
                <div className="small muted">{t('rig.emptyHint')}</div>
                <Link to="/collection" className="btn btn-sm">{t('rig.toCaps')}</Link>
              </>
            ) : (
              <div className="rig-picker">
                {caps.map((c, i) => (
                  <button key={String(c?.asset ?? i)} type="button" className="rig-pick" onClick={() => choose(c)}>
                    <ChipArt collection={Number(c?.collection ?? 0)} rarity={Number(c?.rarity ?? 0)} index={null} level={Number(c?.level ?? 1)} />
                    <span className="tiny">{rarityName(Number(c?.rarity ?? 0))}</span>
                    {Number(c?.copies ?? 1) > 1 ? <span className="tiny muted">{t('rig.copies', { n: Number(c.copies) })}</span> : null}
                  </button>
                ))}
              </div>
            )}
            <button type="button" className="btn btn-ghost btn-sm" disabled={setRig.isPending} onClick={() => choose(undefined)}>
              {t('rig.slotClear')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Чужая витрина: /rig/:wallet. Только просмотр; 404 — это «владелец не включил показ». */
export function PublicRig() {
  const t = useT();
  const params = useParams();
  const wallet = String(params.wallet ?? '');
  const view = useRigOf(wallet);

  if (view.isError) {
    return (
      <div className="page stack">
        <h1 className="page-title">{t('rig.privateTitle')}</h1>
        <p className="page-sub">{t('rig.privateHint')}</p>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Link to="/bowl/rig" className="btn btn-sm">{t('rig.viewMine')}</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page stack">
      <div>
        <h1 className="page-title">{t('rig.owner', { who: shortKey(wallet) })}</h1>
        <p className="page-sub">{t('rig.subtitle')}</p>
      </div>
      <section className="card stack-sm">
        <Board view={view.data ?? { wallet, public: true, caps: [], slots: [], next: null } as RigView} mine={false} busy={false} onSlot={() => {}} />
        <p className="tiny muted">{t('rig.note')}</p>
      </section>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Link to="/bowl/rig" className="btn btn-sm btn-ghost">{t('rig.viewMine')}</Link>
      </div>
    </div>
  );
}
