// The Floodgrid play board (docs/14a): sprite tiles over the depth backdrop. Interaction is unchanged
// from the schematic render: click rotates CW, right-click / 450 ms long-press rotates CCW; aria/dedicated
// disabled states come from the same props. Pure presentation — turns are reported via onRotate and the
// engine state stays in the caller.
import { useRef } from 'react';
import { depthOfLevel, poweredCells, tileMask, type Level } from '@guttercaps/economy';
import { TileArt } from './TileArt';
import { flowDistance, gridBoardBgUrl, gridMaterialForLevel } from './gridArt';

export interface GridBoardProps {
  /** Текущий уровень с ходами игрока (маски — источник картинки и «под током»). */
  level: Level;
  /** Визуальные четверти поворота по клеткам (накопители, см. TileArt). */
  vis: number[];
  busy: boolean;
  hintIndex: number | null;
  /** Цвет потока: палитра по умолчанию или hex платной темы поля. */
  accent: string;
  onRotate: (idx: number, dir: 1 | -1) => void;
  tileAria: (n: number) => string;
}

export function GridBoard({ level, vis, busy, hintIndex, accent, onRotate, tileAria }: GridBoardProps) {
  const lpTimer = useRef<number | null>(null);
  const lpFired = useRef(false);
  const size = level.size;
  const depth = depthOfLevel(level.level);
  const material = gridMaterialForLevel(level.level);
  const powered = poweredCells(level);
  const flow = flowDistance(level);

  return (
    <div
      className="gt-board"
      data-depth={depth}
      style={{ ['--gt-bg' as string]: `url("${gridBoardBgUrl(depth)}")`, ['--flow-accent' as string]: accent }}
    >
      <div className="gt-grid" style={{ gridTemplateColumns: `repeat(${size}, 1fr)` }}>
        {level.tiles.map((tile, i) => (
          <button
            key={i}
            type="button"
            className={`grid-tile${powered[i] ? ' grid-tile-on' : ''}`}
            disabled={busy || tile.fixed}
            onPointerDown={() => {
              lpFired.current = false;
              if (lpTimer.current) window.clearTimeout(lpTimer.current);
              lpTimer.current = window.setTimeout(() => {
                lpFired.current = true;
                onRotate(i, -1);
              }, 450);
            }}
            onPointerUp={() => { if (lpTimer.current) window.clearTimeout(lpTimer.current); }}
            onPointerLeave={() => { if (lpTimer.current) window.clearTimeout(lpTimer.current); }}
            onPointerCancel={() => { if (lpTimer.current) window.clearTimeout(lpTimer.current); }}
            onClick={() => {
              if (lpFired.current) {
                lpFired.current = false;
                return;
              }
              onRotate(i, 1);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              onRotate(i, -1);
            }}
            style={{ cursor: tile.fixed ? 'default' : 'pointer' }}
            aria-label={tileAria(i + 1)}
          >
            <TileArt
              mask={tileMask(level, i)}
              vis={vis[i] ?? 0}
              powered={!!powered[i]}
              isBus={i === level.bus}
              isReceiver={level.receivers.includes(i)}
              fixed={tile.fixed}
              highlight={hintIndex === i}
              accent={accent}
              material={material}
              flowStep={flow[i] ?? 0}
            />
          </button>
        ))}
      </div>
    </div>
  );
}
