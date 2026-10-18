// Живая гидравлика головоломки Grid: сеть игрока из решателя труб.
//
// Встраивание входящего модуля в саму игру (запрос пользователя 2026-10-18):
// каждый поворот фрагмента в головоломке пересобирает PipeNetwork из текущего
// состояния квартала (networkFromLevel), решатель считает расходы по
// Darcy–Weisbach, а 3D-сцена показывает именно сеть игрока — где вода дошла
// до приёмников, где скорость, где открытые концы текут в никуда.
//
// Серверные правила сектора (poweredCells/isSolved) остаются судьёй очков;
// гидравлика — физическая обратная связь поверх них, о чём говорит подпись.
import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import type { Level } from '@guttercaps/economy';
import { FLUIDS, GRAVITY, PipeNetwork } from './pipes/pipeSolver';
import { networkFromLevel, openEnds } from './pipes/gutterNetwork';
import { GUTTER_PIPE_THEME } from './PipesPanel';
import { useT } from '@/shared/i18n';
import { Skeleton } from '@/shared/ui/primitives';

const PipeView = lazy(() => import('./pipes/PipeView').then((m) => ({ default: m.PipeView })));

export default function GridHydraulics({ level }: { level: Level }) {
  const t = useT();
  // Сеть пересобирается при каждом повороте: подпись состояния — повороты.
  const sig = `${level.size}:${level.bus}:${level.tiles.map((x) => x.rot).join(',')}`;
  const net = useMemo(() => {
    try {
      return new PipeNetwork(networkFromLevel(level), FLUIDS.water20, { gravity: GRAVITY.earth });
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  const leaks = useMemo(() => openEnds(level), [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const [live, setLive] = useState({ flow: 0, fed: 0, maxVel: 0 });

  useEffect(() => {
    if (!net) return;
    const id = window.setInterval(() => {
      let flow = 0;
      let fed = 0;
      for (const i of level.receivers) {
        const out = net.nodeStates.get(`c${i}`)?.outflow ?? 0;
        flow += out;
        if (out > 1e-9) fed++;
      }
      let maxVel = 0;
      for (const s of net.linkStates.values()) maxVel = Math.max(maxVel, Math.abs(s.velocity));
      setLive({ flow, fed, maxVel });
    }, 250);
    return () => window.clearInterval(id);
  }, [net, level.receivers]);

  if (!net) return null;
  return (
    <section className="card stack-sm" data-testid="grid-hydraulics">
      <div className="strong">{t('pipes.live')}</div>
      <div style={{ height: 300, position: 'relative' }}>
        <Suspense fallback={<Skeleton h={300} />}>
          <PipeView network={net} theme={GUTTER_PIPE_THEME} />
        </Suspense>
      </div>
      <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
        <span className="small">{t('pipes.flow')}: <b>{(live.flow * 1000).toFixed(2)} L/s</b></span>
        <span className="small">{t('pipes.fed')}: <b>{live.fed}/{level.receivers.length}</b></span>
        <span className="small">{t('pipes.maxVel')}: <b>{live.maxVel.toFixed(2)} m/s</b></span>
        <span className="small" style={leaks ? { color: '#FF7A1A' } : undefined}>{t('pipes.leaks')}: <b>{leaks}</b></span>
      </div>
      <p className="tiny muted">{t('pipes.note')}</p>
    </section>
  );
}
