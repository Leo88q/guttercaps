import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { PipeView } from './PipeView';
import { DEMO_NOZZLES, demoNetwork } from './demoNetwork';
import { FLUIDS, GRAVITY, PipeNetwork } from './pipeSolver';

type Place = 'mars' | 'earth';

interface Readout {
  tank: number;
  nozzles: number;
  pumpFlow: number;
  pumpPower: number;
  riserSpeed: number;
  regime: string;
  cavitation: string | null;
}

const TANK_MAX = 1.7;

function readout(net: PipeNetwork): Readout {
  let nozzles = 0;
  for (const id of DEMO_NOZZLES) nozzles += net.nodeStates.get(id)?.outflow ?? 0;
  const pump = net.linkStates.get('pump');
  const riser = net.linkStates.get('riser');
  let cavitation: string | null = null;
  for (const [id, s] of net.nodeStates) {
    if (s.cavitation) {
      cavitation = id;
      break;
    }
  }
  return {
    tank: net.nodeStates.get('buffer')?.level ?? 0,
    nozzles,
    pumpFlow: pump?.flow ?? 0,
    pumpPower: pump?.power ?? 0,
    riserSpeed: Math.abs(riser?.velocity ?? 0),
    regime: riser?.regime ?? 'still',
    cavitation,
  };
}

const ink = '#eadbd3';
const panel: CSSProperties = {
  position: 'absolute', left: 12, bottom: 12, width: 'min(330px, calc(100% - 24px))', boxSizing: 'border-box', padding: 14,
  background: 'rgba(27, 13, 18, 0.84)', color: ink, border: '1px solid #5a2f35', borderRadius: 6,
  backdropFilter: 'blur(6px)', font: '14px/1.4 system-ui, sans-serif',
};
const row: CSSProperties = { display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'center', margin: '8px 0' };
const slider: CSSProperties = { width: '100%', accentColor: '#d2492a' };
const segment = (on: boolean): CSSProperties => ({
  flex: 1, padding: '7px 8px', cursor: 'pointer', font: 'inherit', color: on ? '#1b0d12' : ink,
  background: on ? '#7ad9b4' : 'transparent', border: '1px solid #7ad9b4', borderRadius: 4,
});

export function PipeDemo() {
  const net = useMemo(() => new PipeNetwork(demoNetwork(), FLUIDS.nutrient, { gravity: GRAVITY.mars }), []);
  const [place, setPlace] = useState<Place>('mars');
  const [pump, setPump] = useState(1);
  const [valveA, setValveA] = useState(1);
  const [valveC, setValveC] = useState(0.6);
  const [speed, setSpeed] = useState(8);
  const [live, setLive] = useState(() => readout(net));

  useEffect(() => {
    const id = window.setInterval(() => setLive(readout(net)), 250);
    return () => window.clearInterval(id);
  }, [net]);

  const choosePlace = (p: Place): void => {
    net.setGravity(GRAVITY[p]);
    setPlace(p);
  };
  const setPumpSpeed = (v: number): void => {
    net.setPumpSpeed('pump', v);
    setPump(v);
  };
  const setValve = (id: 'vA' | 'vC', v: number): void => {
    net.setValveOpening(id, v);
    if (id === 'vA') setValveA(v);
    else setValveC(v);
  };
  const pick = (id: string): void => {
    const s = net.linkStates.get(id);
    if (!s) return;
    const next = s.setting > 0.5 ? 0 : 1;
    if (id === 'pump') setPumpSpeed(next);
    else if (id === 'vA' || id === 'vC') setValve(id, next);
  };

  return (
    <div style={{ position: 'relative', width: '100%', height: '100dvh' }}>
      <PipeView network={net} timeScale={speed} onPickLink={pick} />
      <div style={panel}>
        <div style={{ display: 'flex', gap: 8 }} role="group" aria-label="Gravity">
          <button type="button" style={segment(place === 'mars')} aria-pressed={place === 'mars'} onClick={() => choosePlace('mars')}>Mars, 3.72 m/s²</button>
          <button type="button" style={segment(place === 'earth')} aria-pressed={place === 'earth'} onClick={() => choosePlace('earth')}>Earth, 9.81 m/s²</button>
        </div>

        <div style={row}>
          <label htmlFor="pump">Pump speed</label><span>{Math.round(pump * 100)}%</span>
        </div>
        <input id="pump" style={slider} type="range" min={0} max={1} step={0.01} value={pump} onChange={(e) => setPumpSpeed(Number(e.target.value))} />

        <div style={row}>
          <label htmlFor="va">Valve A, nozzles 1–2</label><span>{Math.round(valveA * 100)}% open</span>
        </div>
        <input id="va" style={slider} type="range" min={0} max={1} step={0.01} value={valveA} onChange={(e) => setValve('vA', Number(e.target.value))} />

        <div style={row}>
          <label htmlFor="vc">Valve C, buffer tank</label><span>{Math.round(valveC * 100)}% open</span>
        </div>
        <input id="vc" style={slider} type="range" min={0} max={1} step={0.01} value={valveC} onChange={(e) => setValve('vC', Number(e.target.value))} />

        <div style={row}>
          <label htmlFor="speed">Tank time, ×{speed}</label><span />
        </div>
        <input id="speed" style={slider} type="range" min={1} max={60} step={1} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />

        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 12px', margin: '12px 0 0' }}>
          <dt>Buffer tank</dt><dd style={{ margin: 0 }}>{live.tank.toFixed(2)} m of {TANK_MAX.toFixed(2)} m</dd>
          <dt>Nozzles</dt><dd style={{ margin: 0 }}>{(live.nozzles * 1000).toFixed(2)} L/s</dd>
          <dt>Pump</dt><dd style={{ margin: 0 }}>{(live.pumpFlow * 1000).toFixed(2)} L/s, {live.pumpPower.toFixed(0)} W</dd>
          <dt>Riser</dt><dd style={{ margin: 0 }}>{live.riserSpeed.toFixed(2)} m/s, {live.regime}</dd>
        </dl>
        {live.cavitation && <p style={{ margin: '8px 0 0', color: '#ff8a6b' }}>Pressure at {live.cavitation} has dropped below the vapour pressure, so the liquid would boil.</p>}
        <p style={{ margin: '10px 0 0', opacity: 0.75 }}>Tap a valve wheel or the pump to switch it. Drag to orbit, pinch or scroll to zoom.</p>
      </div>
    </div>
  );
}
