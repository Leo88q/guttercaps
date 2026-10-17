// docs/16 §5.1 — окно чаши: одна и та же картинка для живого заезда и для
// просмотра реплея (§5.5). Вынесено из экрана намеренно: два разных рендера
// трассы разошлись бы, и «посмотреть заезд» показывало бы не ту езду.
//
// Графика — файлы из /art/skate: код двигает камеру, ставит препятствия по
// раскладке дня и поворачивает спрайт райдера. Всё.
//
// Игровой «фил» (2026-10-17, по жалобе «картинка не ездит»): спрайтовые
// состояния райдера — беговая посадка, воздух, флип доски при грэбе, гринд с
// наклоном, падение кувырком — и бегущая разметка асфальта под камерой.
// Модель состояний и трюк-в-воздухе-вторым вводом адаптированы из ThorBoard
// (MIT, © 2016 Thorbjørn Bonvik, github.com/thorbjxrn/thorBoard, LICENSE —
// рядом в THIRD_PARTY_THORBOARD.md); физика и очки при этом по-прежнему
// считаются детерминированным движком economy, который сервер пересчитывает
// по реплею, — иначе турнир перестал бы быть честным.
import type { ReactNode } from 'react';
import type { LineLayout, RunState } from '@guttercaps/economy';
import { riderArt } from './Rider';

/**
 * Кадровая анимация райдера — как в старых 2D-играх: не один статичный
 * спрайт и не чужая 3D-модель (Kenney-манекен стилю игры не подошёл,
 * 2026-10-18), а набор поз в родной неоновой стилистике, которые движок
 * переключает по состоянию заезда. Толчок и кат чередуются по тикам —
 * получается цикл ходьбы на доске.
 */
export function riderPose(frame: RunState | null): string {
  if (!frame) return riderArt(3); // поза ката (rider-04) — кадр покоя
  if (frame.stunned) return '/art/skate/rider-pose-bail.webp';
  if (frame.grabbed) return '/art/skate/rider-pose-grab.webp';
  if (frame.air) return '/art/skate/rider-pose-air.webp';
  if (frame.grinding) return riderArt(3);
  return frame.tick % 36 < 16 ? '/art/skate/rider-pose-push.webp' : riderArt(3);
}

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

export default function LineTrack({ layout, frame, rot = 0, lamp, stage, hud, children, testId = 'line-track' }: LineTrackProps) {
  const camera = Math.max(0, (frame?.pos ?? 0) - RIDER_X) * PX;
  return (
    <div className="line-track" data-testid={testId} data-stage={stage}>
      {/* Панорама едет медленнее трассы — так чаша читается как глубина, а не
          как полоса. Фон ТАЙЛИТСЯ (repeat-x) и сдвигается по модулю: раньше
          это была одна картинка 240% ширины, к середине заезда она целиком
          уезжала влево и трасса оставалась чёрной пустотой. */}
      <div className="line-bg" aria-hidden
        style={{ backgroundImage: 'url(/art/skate/line-bg.webp)', backgroundPositionX: `${-camera * 0.25}px` }} />
      {layout?.features.map((f, i) => {
        const left = (f.start - camera) * PX;
        if (left < -400 || left > 1600) return null;
        return (
          <img key={i} className="line-feature" src={FEATURE_ART[f.kind]} alt="" aria-hidden
            data-kind={f.kind}
            style={{ left: `${left}px`, width: `${Math.max(40, f.len * PX)}px`, height: `${FEATURE_H[f.kind]}px` }} />
        );
      })}
      {/* Разметка асфальта бежит с камерой в полный рост: скорость читается
          землёй, а не только цифрами HUD. */}
      <span className="line-ground" aria-hidden style={{ backgroundPositionX: `${-camera}px` }} />
      <span
        className={`line-rider${frame?.grinding ? ' is-grinding' : ''}${frame?.stunned ? ' is-down' : ''}${frame?.air ? ' is-air' : ''}${frame?.grabbed ? ' is-grab' : ''}${frame && !frame.air && !frame.grinding && !frame.stunned ? ' is-riding' : ''}`}
        data-testid="line-rider"
        data-air={frame?.air ? '1' : '0'}
        data-grab={frame?.grabbed ? '1' : '0'}
        style={{ ['--lamp' as string]: lamp, transform: `translateY(${-(frame?.y ?? 0) * AIR_SCALE}px) rotate(${rot}deg)` }}
      >
        {/* Позу выбирает состояние заезда (riderPose выше). Чёрный фон поз
            гасится mix-blend-mode: screen в CSS — персонаж стоит прямо на
            трассе, а не в чёрном прямоугольнике. */}
        <img className="line-rider-pose" src={riderPose(frame)} alt="" aria-hidden data-pose={frame?.stunned ? 'bail' : frame?.grabbed ? 'grab' : frame?.air ? 'air' : 'ride'} />
      </span>
      {hud}
      {children}
    </div>
  );
}
