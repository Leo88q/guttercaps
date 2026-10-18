// Трубы района — интерактивная гидравлика ливнёвки Floodgrid.
//
// Входящий модуль (прислан пользователем 2026-10-18, incoming/files-2):
// настоящий гидравлический решатель сетей (Darcy–Weisbach + Global Gradient
// Algorithm, как в EPANET) и three.js-сцена с шейдерной жидкостью. Здесь он
// обёрнут в тему Gutter City: коллектор района, насос, два вентиля, четыре
// точки ливнёвки и накопительный бак. Тап по вентилю/насосу в 3D тоже
// работает (onPickLink).
//
// Это песочница-визуализация: на шансы, Floodgrid-очки и экономику она не
// влияет (инвариант docs/16 §9 — картинка не двигает шансы), о чём честно
// написано под панелью.
import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { FLUIDS, GRAVITY, PipeNetwork } from './pipes/pipeSolver';
import { DEMO_NOZZLES, gutterNetwork } from './pipes/gutterNetwork';
import type { PipeTheme } from './pipes/pipeScene';
import { useT } from '@/shared/i18n';
import { Skeleton } from '@/shared/ui/primitives';

const PipeView = lazy(() => import('./pipes/PipeView').then((m) => ({ default: m.PipeView })));

/** Тема сцены под Gutter City: тёмный коллектор, циановая вода, розовый неон. */
export const GUTTER_PIPE_THEME: PipeTheme = {
  background: '#0a0910',
  floor: '#12111a',
  floorGrid: '#2a2438',
  glass: '#d8f6ff',
  glint: 0.5,
  metal: '#8f9bb0',
  metalDark: '#3c414d',
  handle: '#ff2e8a',
  liquidDeep: '#0b3d4a',
  liquidLight: '#16e5d9',
  liquidGlow: '#a5fff4',
  skyLow: '#160a18',
  skyHigh: '#3d1440',
  keyLight: '#ffd7ef',
  fillLight: '#4d5f9e',
  rimLight: '#ff2e8a',
};

const TANK_MAX = 1.7;

export default function PipesPanel() {
  const t = useT();
  const net = useMemo(
    () => new PipeNetwork(gutterNetwork(), FLUIDS.water20, { gravity: GRAVITY.earth }),
    [],
  );
  const [pump, setPump] = useState(1);
  const [valveA, setValveA] = useState(1);
  const [valveC, setValveC] = useState(0.6);
  const [speed, setSpeed] = useState(8);
  const [live, setLive] = useState({ tank: 0, nozzles: 0, pumpFlow: 0, pumpPower: 0, riserSpeed: 0, regime: 'still', cavitation: null as string | null });

  useEffect(() => {
    const id = window.setInterval(() => {
      let nozzles = 0;
      for (const nid of DEMO_NOZZLES) nozzles += net.nodeStates.get(nid)?.outflow ?? 0;
      let cavitation: string | null = null;
      for (const [nid, s] of net.nodeStates) if (s.cavitation) { cavitation = nid; break; }
      setLive({
        tank: net.nodeStates.get('buffer')?.level ?? 0,
        nozzles,
        pumpFlow: net.linkStates.get('pump')?.flow ?? 0,
        pumpPower: net.linkStates.get('pump')?.power ?? 0,
        riserSpeed: Math.abs(net.linkStates.get('riser')?.velocity ?? 0),
        regime: net.linkStates.get('riser')?.regime ?? 'still',
        cavitation,
      });
    }, 250);
    return () => window.clearInterval(id);
  }, [net]);

  const applyPump = (v: number) => { net.setPumpSpeed('pump', v); setPump(v); };
  const applyValve = (id: 'vA' | 'vC', v: number) => {
    net.setValveOpening(id, v);
    if (id === 'vA') setValveA(v); else setValveC(v);
  };
  const pick = (id: string) => {
    const s = net.linkStates.get(id);
    if (!s) return;
    const next = s.setting > 0.5 ? 0 : 1;
    if (id === 'pump') applyPump(next);
    else if (id === 'vA' || id === 'vC') applyValve(id, next);
  };

  return (
    <div className="page stack">
      <div>
        <h1 className="page-title">{t('pipes.title')}</h1>
        <p className="page-sub">{t('pipes.hint')}</p>
      </div>

      <section className="card stack-sm">
        <div style={{ height: 430, position: 'relative' }}>
          <Suspense fallback={<Skeleton h={430} />}>
            <PipeView network={net} theme={GUTTER_PIPE_THEME} timeScale={speed} onPickLink={pick} />
          </Suspense>
        </div>

        <div className="stack-sm">
          <label className="small">{t('pipes.pump')} · {Math.round(pump * 100)}%</label>
          <input type="range" min={0} max={1} step={0.01} value={pump} aria-label={t('pipes.pump')}
            onChange={(e) => applyPump(Number(e.target.value))} style={{ width: '100%', accentColor: '#ff2e8a' }} />
          <label className="small">{t('pipes.valveA')} · {Math.round(valveA * 100)}%</label>
          <input type="range" min={0} max={1} step={0.01} value={valveA} aria-label={t('pipes.valveA')}
            onChange={(e) => applyValve('vA', Number(e.target.value))} style={{ width: '100%', accentColor: '#16e5d9' }} />
          <label className="small">{t('pipes.valveC')} · {Math.round(valveC * 100)}%</label>
          <input type="range" min={0} max={1} step={0.01} value={valveC} aria-label={t('pipes.valveC')}
            onChange={(e) => applyValve('vC', Number(e.target.value))} style={{ width: '100%', accentColor: '#b6ff3c' }} />
          <label className="small">{t('pipes.time')} · ×{speed}</label>
          <input type="range" min={1} max={60} step={1} value={speed} aria-label={t('pipes.time')}
            onChange={(e) => setSpeed(Number(e.target.value))} style={{ width: '100%' }} />
        </div>

        <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
          <span className="small">{t('pipes.tank')}: <b>{live.tank.toFixed(2)} / {TANK_MAX.toFixed(2)} m</b></span>
          <span className="small">{t('pipes.nozzles')}: <b>{(live.nozzles * 1000).toFixed(2)} L/s</b></span>
          <span className="small">{t('pipes.pumpOut')}: <b>{(live.pumpFlow * 1000).toFixed(2)} L/s · {live.pumpPower.toFixed(0)} W</b></span>
          <span className="small">{t('pipes.riser')}: <b>{live.riserSpeed.toFixed(2)} m/s · {live.regime}</b></span>
        </div>
        {live.cavitation && <div className="warn small">{t('pipes.cavitation', { node: live.cavitation })}</div>}
        <p className="tiny muted">{t('pipes.note')}</p>
      </section>
    </div>
  );
}
