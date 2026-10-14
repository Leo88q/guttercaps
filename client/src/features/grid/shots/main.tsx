// Screenshot harness for the Floodgrid art layer (docs/14a, PR attachments).
// Renders the REAL GridBoard against real engine levels (partially solved, deterministic),
// plus the depth strips of the sector selector. Built with vite --config vite.shots.config.ts;
// the runner is scripts/grid-art-shots.mjs. Never shipped to production.
import { createRoot } from 'react-dom/client';
import '@/shared/ui/fonts.css';
import '@/shared/ui/theme.css';
import '@/shared/ui/layout.css';
import { GRID_DEPTHS, GRID_FIELD_THEMES, depthOfLevel, generateLevel, hashString, levelSeed, rotateMask, type Level } from '@guttercaps/economy';
import { GridBoard } from '../GridBoard';
import { canonicalRotOf, gridStripBgUrl } from '../gridArt';
import { SteamVeil, WinFx } from '@/features/vfx/vfx';

/** Детерминированно «доигранный» уровень: доля клеток установлена в решение. */
function partialLevel(level: number, solvedShare: number): Level {
  const lv = generateLevel(level, levelSeed(level));
  lv.tiles.forEach((tile, i) => {
    if (tile.fixed) return;
    const coin = hashString(`shot:${level}:${i}`) % 1000;
    if (coin < solvedShare * 1000) tile.rot = lv.solutionRot[i];
  });
  return lv;
}

function visOf(lv: Level): number[] {
  return lv.tiles.map((tile) => (tile.base === 15 ? 0 : canonicalRotOf(rotateMask(tile.base, tile.rot))));
}

const noop = () => undefined;
const aria = (n: number) => `Плитка ${n}`;

function BoardShot({ id, level, title, accent = '#B6F09C', hintIndex = null }: { id: string; level: number; title: string; accent?: string; hintIndex?: number | null }) {
  const lv = partialLevel(level, 0.5);
  const depth = depthOfLevel(level);
  const d = GRID_DEPTHS[depth - 1];
  return (
    <section data-shot={id} className="shot-card card stack-sm">
      <div className="shot-title">
        {title} · сектор {level} · {lv.size}×{lv.size} · глубина {depth} «{d.name}» · {d.material}
      </div>
      <GridBoard level={lv} vis={visOf(lv)} busy={false} hintIndex={hintIndex} accent={accent} onRotate={noop} tileAria={aria} />
    </section>
  );
}

function StripsShot() {
  return (
    <section data-shot="strips" className="shot-card card stack-sm">
      <div className="shot-title">полосы глубин выбора сектора</div>
      {GRID_DEPTHS.map((d) => (
        <div
          key={d.depth}
          className="stack-sm depth-strip"
          style={{
            borderLeftColor: { chrome: '#d7e3ea', rust: '#c96f2e', cast: '#7a7e85', glass: '#7fe7dc' }[d.material] ?? '#333',
            backgroundImage: `linear-gradient(rgba(22, 21, 26, 0.62), rgba(22, 21, 26, 0.8)), url("${gridStripBgUrl(d.depth)}")`,
          }}
        >
          <div className="tiny muted" style={{ color: '#d8d6de' }}>
            Глубина {d.depth} · {d.name} · {d.grid}
          </div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {Array.from({ length: 5 }, (_, i) => d.levels[0] + i).map((lv) => (
              <span key={lv} className="mono shot-lv">{lv}</span>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

/** Кадр VFX-слоя (docs/14b §3): пар по кромке доски — та же верстка, что в Grid. */
function VfxSteamShot() {
  const lv = partialLevel(33, 0.5);
  return (
    <section data-shot="vfx-steam" className="shot-card card stack-sm">
      <div className="shot-title">vfx: пар по кромке доски · сектор 33 · ржавчина · opacity ≤ .3</div>
      <div className="vfx-host">
        <GridBoard level={lv} vis={visOf(lv)} busy={false} hintIndex={null} accent="#B6F09C" onRotate={noop} tileAria={aria} />
        <SteamVeil />
      </div>
    </section>
  );
}

/** Кадр VFX-слоя: победный залп — конфетти, два луча, две искры поверх карточки итога. */
function VfxWinShot() {
  return (
    <section data-shot="vfx-win" className="shot-card card stack-sm vfx-host">
      <WinFx />
      <div className="strong">Сектор решён · ★3</div>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <span>+120 XP</span>
        <span>капля паводка</span>
      </div>
      <div className="tiny muted">победный залп: конфетти (чистый CSS), лучи .14–.30, искры одним прохождением; reduced-motion гасит всё</div>
    </section>
  );
}

const SHOT_CSS = `
  body { background: #16151A; color: #d8d6de; overflow: auto !important; }
  html, body, #root { height: auto !important; overflow: auto !important; }
  .shot-page { display: flex; flex-direction: column; gap: 18px; padding: 18px; max-width: 620px; margin: 0 auto; }
  .shot-card { padding: 12px; }
  .shot-title { font-family: var(--cg-font-mono, monospace); font-size: 11px; color: #9b96a3; }
  .shot-lv { font-size: 12px; border: 1px solid #333; border-radius: 8px; padding: 5px 9px; background: rgba(22, 21, 26, .55); }
`;

function App() {
  const frost = GRID_FIELD_THEMES.find((t) => t.id === 'field-frost')?.hex ?? '#38bdf8';
  const magma = GRID_FIELD_THEMES.find((t) => t.id === 'field-magma' )?.hex ?? '#fb923c';
  return (
    <div className="shot-page">
      <style>{SHOT_CSS}</style>
      <BoardShot id="d1" level={1} title="default" hintIndex={7} />
      <BoardShot id="d2" level={18} title="default" />
      <BoardShot id="d3" level={33} title="default" />
      <BoardShot id="d3-magma" level={33} title={`тема field-magma ${magma}`} accent={magma} hintIndex={7} />
      <BoardShot id="d4" level={48} title="default" />
      <BoardShot id="d5" level={75} title="default" />
      <BoardShot id="d5-frost" level={75} title={`тема field-frost ${frost}`} accent={frost} />
      <StripsShot />
      <VfxSteamShot />
      <VfxWinShot />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
