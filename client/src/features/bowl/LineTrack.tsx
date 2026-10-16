// docs/16 §5.1 — окно чаши: одна и та же картинка для живого заезда и для
// просмотра реплея (§5.5). Вынесено из экрана намеренно: два разных рендера
// трассы разошлись бы, и «посмотреть заезд» показывало бы не ту езду.
//
// Графика — файлы из /art/skate: код двигает камеру, ставит препятствия по
// раскладке дня и поворачивает спрайт райдера. Всё.
import type { ReactNode } from 'react';
import type { LineLayout, RunState } from '@guttercaps/economy';
import { riderArt } from './Rider';

/** Пикселей на единицу пути: на телефоне видно ~2 секунды трассы вперёд. */
const PX = 1;
/** Где стоит райдер по горизонтали (в единицах пути от левого края окна). */
const RIDER_X = 200;
/** Вертикальный масштаб: 146 единиц подъёма не должны уезжать за край окна. */
const AIR_SCALE = 0.85;

const FEATURE_ART: Record<string, string> = {
  gap: '/art/skate/line-gap.webp',
  rail: '/art/skate/line-rail.webp',
  kicker: '/art/skate/line-kicker.webp',
  bump: '/art/skate/line-bump.webp',
};
const FEATURE_H: Record<string, number> = { gap: 74, rail: 70, kicker: 62, bump: 52 };

export interface LineTrackProps {
  layout: LineLayout | null;
  /** Кадр заезда: null — окно пустое (ещё не едем или раскладка не та). */
  frame: RunState | null;
  silhouette: number;
  /** Поворот спрайта в градусах: считает тот, кто ведёт заезд. */
  rot?: number;
  /** Цвет лампы райдера — из коллекции, как на витрине (§4.6). */
  lamp: string;
  stage?: string;
  /** Счёт, время, комбо, бэйлы — рисует вызывающий, у реплея HUD свой. */
  hud?: ReactNode;
  /** Кнопка «поехать» и всё, что лежит поверх чаши. */
  children?: ReactNode;
  testId?: string;
}

export default function LineTrack({ layout, frame, silhouette, rot = 0, lamp, stage, hud, children, testId = 'line-track' }: LineTrackProps) {
  const camera = Math.max(0, (frame?.pos ?? 0) - RIDER_X) * PX;
  return (
    <div className="line-track" data-testid={testId} data-stage={stage}>
      {/* Панорама едет медленнее трассы — так чаша читается как глубина, а не как полоса. */}
      <img className="line-bg" src="/art/skate/line-bg.webp" alt="" aria-hidden
        style={{ transform: `translateX(${-camera * 0.25}px)` }} />
      {layout?.features.map((f, i) => {
        const left = (f.start - camera) * PX;
        if (left < -400 || left > 1600) return null;
        return (
          <img key={i} className="line-feature" src={FEATURE_ART[f.kind]} alt="" aria-hidden
            data-kind={f.kind}
            style={{ left: `${left}px`, width: `${Math.max(40, f.len * PX)}px`, height: `${FEATURE_H[f.kind]}px` }} />
        );
      })}
      <span className="line-ground" aria-hidden />
      <span
        className={`line-rider${frame?.grinding ? ' is-grinding' : ''}${frame?.stunned ? ' is-down' : ''}`}
        data-testid="line-rider"
        data-air={frame?.air ? '1' : '0'}
        style={{ ['--lamp' as string]: lamp, transform: `translateY(${-(frame?.y ?? 0) * AIR_SCALE}px) rotate(${rot}deg)` }}
      >
        <img src={riderArt(silhouette)} alt="" aria-hidden />
      </span>
      {hud}
      {children}
    </div>
  );
}
