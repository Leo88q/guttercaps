// Инспектор крышки (docs/16 §2.2) — /chip/:asset, глубокоlinkable.
//
// Орбита жестом (тач/мышь/стрелки), инерция, сброс двойным тапом. Два лица:
// лицо — настоящий арт (512 лениво, 256 на телефоне), оборот — паспорт крышки
// (архетип, район, стихия, сила, уровень, ассет). Кромка с гравировкой района —
// CSS-полоса по ободу, а не нарисованная картинка: арт остаётся артом, код
// отвечает за слой и движение.
//
// Кнопка «поделиться» зовёт POST /v1/chips/{asset}/share: событие даёт метрику
// §12, а ссылка несёт тот же `ref`, что и реферальная программа, — пришедший по
// ней регистрируется уже существующей воронкой, без новой Кушни.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useChipDetail } from '@/api/hooks';
import { api, ApiError } from '@/api/client';
import { ElementGlyph } from '@/shared/ui/element-icons';
import { CleanZone, Empty, KV, Skeleton } from '@/shared/ui/primitives';
import { useUiStore } from '@/app/store/ui';
import { useT } from '@/shared/i18n';
import { EXPLORER, FLAGS } from '@/app/config';
import { PhaseGChipActions } from './PhaseGChipActions';
import { ExternalIcon } from '@/shared/ui/action-icons';
import {
  chipArtUrl, chipImageOf, chipLore, chipName, chipPower, collectionName, collectionSymbol,
  ELEMENT_OF_COLLECTION, rarityColor, rarityName,
} from '@/shared/lib/rarity';
import './inspector.css';

const SPIN_STEP = 30; // градусов на нажатие стрелки
const FLIP_AT = 90; // за этим углом показывается оборот
const FRICTION = 0.94; // инерция: затухание за кадр

type Phase = 'idle' | 'drag';

/** Вращение вокруг вертикальной оси с инерцией; возвращает угол в градусах. */
function useOrbit() {
  const [angle, setAngle] = useState(0);
  const vel = useRef(0);
  const phase = useRef<Phase>('idle');
  const last = useRef<{ x: number; t: number } | null>(null);
  const raf = useRef(0);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const spin = (delta: number) => setAngle((a) => a + delta);
  const reset = () => { vel.current = 0; setAngle(0); };

  const glide = () => {
    vel.current *= FRICTION;
    if (Math.abs(vel.current) < 0.15) { vel.current = 0; return; }
    setAngle((a) => a + vel.current);
    raf.current = requestAnimationFrame(glide);
  };

  const start = (x: number) => {
    cancelAnimationFrame(raf.current);
    phase.current = 'drag';
    last.current = { x, t: performance.now() };
    vel.current = 0;
  };
  const move = (x: number) => {
    if (phase.current !== 'drag' || !last.current) return;
    const dx = x - last.current.x;
    const dt = Math.max(1, performance.now() - last.current.t);
    last.current = { x, t: performance.now() };
    vel.current = (dx / dt) * 12; // градусов за кадр
    setAngle((a) => a + dx * 0.6);
  };
  const end = () => {
    if (phase.current !== 'drag') return;
    phase.current = 'idle';
    last.current = null;
    raf.current = requestAnimationFrame(glide);
  };

  return { angle, spin, reset, start, move, end, dragging: phase.current === 'drag' };
}

export default function ChipInspector() {
  const t = useT();
  const { asset = '' } = useParams();
  const q = useChipDetail(asset);
  const toast = useUiStore((s) => s.toast);
  const orbit = useOrbit();
  const [sharing, setSharing] = useState(false);
  const [ref, setRef] = useState<string | null>(null);

  useEffect(() => { orbit.reset(); }, [asset]);

  const c = q.data;
  // 512 только на широком экране: на телефоне мастер 512 — лишние сотни килобайт.
  const hero = useMemo(() => (c ? chipImageOf({ ...c, collection: c.collection, rarity: c.rarity }, 512) : ''), [c]);
  const fallback = useMemo(() => (c ? chipArtUrl(c.collection ?? 0, c.rarity ?? 0, 512) : ''), [c]);

  const share = async () => {
    if (!c) return;
    setSharing(true);
    try {
      const { path } = await api.post('/chips/{asset}/share', undefined, { path: { asset } });
      setRef(path ?? null);
      const url = `${window.location.origin}${path}`;
      try {
        await navigator.clipboard?.writeText(url);
        toast({ kind: 'success', title: { key: 'inspect.copied' } });
      } catch {
        toast({ kind: 'info', title: { key: 'inspect.shareHint' } });
      }
      if (typeof navigator.share === 'function') {
        try { await navigator.share({ title: chipName(c.collection ?? 0, c.rarity ?? 0), url }); } catch { /* пользователь отменил */ }
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) toast({ kind: 'error', title: { key: 'common.connectWallet' } });
      else toast({ kind: 'error', title: { key: 'inspect.shareFailed' }, error: e });
    } finally { setSharing(false); }
  };

  if (q.isLoading) return <div className="page page-bg page-bg-market stack"><Skeleton h={320} /><Skeleton h={120} /></div>;
  if (!c) return <div className="page page-bg page-bg-market"><Empty>{t('ui.capNotFound')}</Empty></div>;

  const rarity = c.rarity ?? 0;
  const collection = c.collection ?? 0;
  const flipped = Math.abs(((orbit.angle % 360) + 360) % 360 - 180) < FLIP_AT;

  return (
    <div className="page page-bg page-bg-market stack">
      <div className="row between">
        <div>
          <h1 className="page-title">{chipName(collection, rarity)}</h1>
          <p className="page-sub">{t('inspect.hint')}</p>
        </div>
        {FLAGS.launchPhase !== 'full'
          ? <span className="row" style={{ gap: 8 }}><PhaseGChipActions asset={asset} owner={c.owner} /></span>
          : <Link to={`/market/${asset}`} className="btn btn-sm">{t('inspect.toMarket')}</Link>}
      </div>

      {/* Орбита: жест мышью/пальцем, стрелки — для клавиатуры, двойной тап — сброс. */}
      <div
        className={`inspector-stage${orbit.dragging ? ' is-drag' : ''}`}
        role="img"
        aria-label={`${chipName(collection, rarity)} — ${t('inspect.hint')}`}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') { e.preventDefault(); orbit.spin(-SPIN_STEP); }
          if (e.key === 'ArrowRight') { e.preventDefault(); orbit.spin(SPIN_STEP); }
          if (e.key === '0') orbit.reset();
        }}
        onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); orbit.start(e.clientX); }}
        onPointerMove={(e) => orbit.move(e.clientX)}
        onPointerUp={() => orbit.end()}
        onPointerCancel={() => orbit.end()}
        onDoubleClick={() => orbit.reset()}
      >
        <div className="inspector-coin" style={{ transform: `rotateY(${orbit.angle}deg)`, ['--rim' as string]: rarityColor(rarity) }}>
          <div className="inspector-face inspector-front">
            <img src={hero} alt="" draggable={false} onError={(e) => { if (fallback && e.currentTarget.src !== fallback) e.currentTarget.src = fallback; }} />
          </div>
          <div className="inspector-face inspector-back">
            <div className="inspector-engraving">{collectionName(collection)} · {collectionSymbol(collection)}</div>
            <div className="stack-sm">
              <KV k={t('market.filters.rarity')} v={<span style={{ color: rarityColor(rarity) }}>{rarityName(rarity)}</span>} />
              <KV k={t('market.filters.collection')} v={<span className="row" style={{ gap: 4 }}><ElementGlyph element={ELEMENT_OF_COLLECTION[collection]} />{collectionName(collection)}</span>} />
              <KV k={t('ui.power')} v={String(chipPower(rarity, c.level ?? 1))} />
              <KV k={t('ui.level')} v={String(c.level ?? 1)} />
            </div>
          </div>
        </div>
        <div className="inspector-ground" aria-hidden="true" />
      </div>

      <div className="row between">
        <div className="tiny muted">{flipped ? t('inspect.back') : t('inspect.front')}</div>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn btn-sm" onClick={() => orbit.reset()} aria-label={t('inspect.reset')}>{t('inspect.reset')}</button>
          <button className="btn btn-sm" onClick={share} disabled={sharing}>{sharing ? t('common.loading') : t('inspect.share')}</button>
        </div>
      </div>

      {ref && (
        <CleanZone className="stack-sm">
          <div className="label">{t('inspect.link')}</div>
          <div className="tiny mono verify-hex">{window.location.origin}{ref}</div>
          <div className="tiny muted">{t('inspect.refNote')}</div>
        </CleanZone>
      )}

      <CleanZone className="stack-sm">
        <div className="label">{t('inspect.spec')}</div>
        <KV k={t('ui.asset')} v={<a className="row" style={{ gap: 4, display: 'inline-flex' }} href={EXPLORER.account(asset)} target="_blank" rel="noreferrer">{asset.slice(0, 8)}… <ExternalIcon size={11} /></a>} />
        <KV k={t('ui.owner')} v={c.owner ? <a href={EXPLORER.account(c.owner)} target="_blank" rel="noreferrer" className="row" style={{ gap: 4, display: 'inline-flex' }}>{c.owner.slice(0, 8)}… <ExternalIcon size={11} /></a> : '—'} />
        <div className="tiny muted">{chipLore(collection, rarity)}</div>
      </CleanZone>

      <div className="tiny muted">{t('inspect.deepLinkNote')}</div>
    </div>
  );
}
