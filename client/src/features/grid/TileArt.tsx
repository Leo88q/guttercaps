// Sprite tile for the Floodgrid board (docs/14a): owner's pipe art per depth material, rotated in CSS,
// powered-state water tint as an overlay (palette accent — paid field themes recolor one variable),
// role markers kept from the original schematic render: bus = orange core, receiver = cyan ring,
// fixed = corner dot, hint = gold frame. If the atlas cannot load, the old SVG schematic takes over,
// so a broken asset never yields an empty cell.
import { useMemo } from 'react';
import { gridAtlasUrl, shapeIndexOf, useAtlasStatus, type GridTileSet } from './gridArt';

/** Прежний схематичный рендер тайла — остаётся фолбэком при недоступном атласе. */
function TileSvg({ mask, powered, isBus, isReceiver, fixed, highlight, accent = '#B6FF3C' }: { mask: number; powered: boolean; isBus: boolean; isReceiver: boolean; fixed: boolean; highlight: boolean; accent?: string }) {
  const c = powered ? accent : '#7A8288';
  const lines: [number, number][] = [];
  if (mask & 1) lines.push([20, 0]);
  if (mask & 2) lines.push([40, 20]);
  if (mask & 4) lines.push([20, 40]);
  if (mask & 8) lines.push([0, 20]);
  return (
    <svg viewBox="0 0 40 40" style={{ width: '100%', height: '100%', display: 'block' }} aria-hidden>
      {highlight && <rect x="1" y="1" width="38" height="38" rx="7" fill="none" stroke="#FFD34D" strokeWidth="2.5" />}
      {lines.map(([x, y], i) => <line key={i} x1="20" y1="20" x2={x} y2={y} stroke={c} strokeWidth={powered ? 5 : 4} strokeLinecap="round" />)}
      <circle cx="20" cy="20" r={isBus ? 7 : 4.5} fill={isBus ? '#FF7A1A' : c} />
      {isReceiver && <circle cx="20" cy="20" r="9" fill="none" stroke="#16E5D9" strokeWidth="2" />}
      {fixed && <circle cx="33" cy="7" r="2" fill="#555" />}
    </svg>
  );
}

export interface TileArtProps {
  /** Текущая маска движка (N/E/S/W) с учётом поворота тайла. */
  mask: number;
  /**
   * Угол спрайта в четвертях (накопитель, не mod 4): стартует с canonicalRotOf(стартовая маска),
   * дальше GridBoard копит ±1 за ход — анимация поворота непрерывна и не «отматывается» через 270°.
   */
  vis: number;
  powered: boolean;
  isBus: boolean;
  isReceiver: boolean;
  fixed: boolean;
  highlight: boolean;
  accent: string;
  material: GridTileSet;
  /** Шаг волны потока (BFS-расстояние от шины). */
  flowStep: number;
}

export function TileArt({ mask, vis, powered, isBus, isReceiver, fixed, highlight, accent, material, flowStep }: TileArtProps) {
  const status = useAtlasStatus(material);
  const atlas = gridAtlasUrl(material);
  /** Ячейка спрайта в полосе атласа: x-позиция фона/маски в процентах (по форме текущей маски). */
  const pos = useMemo(() => `${(shapeIndexOf(mask) / 4) * 100}% 0%`, [mask]);

  if (status === 'error') {
    return <TileSvg mask={mask} powered={powered} isBus={isBus} isReceiver={isReceiver} fixed={fixed} highlight={highlight} accent={accent} />;
  }

  const rotStyle = { transform: `rotate(${vis * 90}deg)` } as const;

  return (
    <span className={`gt${powered ? ' gt-on' : ''}`} style={{ ['--flow-accent' as string]: accent }} aria-hidden>
      <span className="gt-s" style={{ ...rotStyle, backgroundImage: `url("${atlas}")`, backgroundPosition: pos }} />
      {powered && (
        <span
          className="gt-f"
          style={{
            ...rotStyle,
            maskImage: `url("${atlas}")`,
            WebkitMaskImage: `url("${atlas}")`,
            maskPosition: pos,
            WebkitMaskPosition: pos,
            animationDelay: `${-flowStep * 140}ms`,
          }}
        />
      )}
      {isReceiver && <span className={`gt-ring${powered ? ' gt-lit' : ''}`} />}
      {isBus && <span className="gt-bus" />}
      {fixed && <span className="gt-fixed" />}
      {highlight && <span className="gt-hint" />}
    </span>
  );
}
