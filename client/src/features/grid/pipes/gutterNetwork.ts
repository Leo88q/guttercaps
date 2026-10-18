import { ROUGHNESS } from './pipeSolver';
import type { NetworkDef } from './pipeSolver';

/**
 * Ливнёвка района Gutter City, метры, y вверх (топология демо-сети входящего модуля):
 *
 *   cistern ─ pump ─ riser ─┬─ valve A ─ nozzle 1 ─ nozzle 2
 *                           ├─ header B ─ nozzle 3 ─ nozzle 4
 *                           └─ valve C (throttled) ─ buffer tank (enters at the bottom, submerged)
 */
export const DEMO_NOZZLES = ['e1', 'e2', 'e3', 'e4'] as const;

export function gutterNetwork(): NetworkDef {
  const acrylic = ROUGHNESS.acrylic;
  const nozzle = 0.0045;
  return {
    nodes: [
      { kind: 'reservoir', id: 'cistern', position: [-4.5, 0, 0], head: 1.4, anchor: [-3.6, 0.5, 0], visual: { diameter: 1.8, height: 2 } },
      { kind: 'junction', id: 'j0', position: [-3.0, 0.5, 0] },
      { kind: 'junction', id: 'j1', position: [-2.2, 0.5, 0] },
      { kind: 'junction', id: 'tee', position: [0, 1.6, 0] },
      { kind: 'junction', id: 'ha', position: [1.0, 1.6, 0] },
      { kind: 'junction', id: 'e1', position: [2.0, 1.6, 0], nozzleDiameter: nozzle },
      { kind: 'junction', id: 'e2', position: [3.2, 1.6, 0], nozzleDiameter: nozzle },
      { kind: 'junction', id: 'hb', position: [0, 1.6, -1.6] },
      { kind: 'junction', id: 'e3', position: [1.2, 1.6, -1.6], nozzleDiameter: nozzle },
      { kind: 'junction', id: 'e4', position: [2.4, 1.6, -1.6], nozzleDiameter: nozzle },
      { kind: 'junction', id: 'jc1', position: [0, 1.6, 1.4] },
      { kind: 'junction', id: 'jc2', position: [0, 1.6, 2.0] },
      { kind: 'tank', id: 'buffer', position: [0, 0, 3.0], anchor: [0, 0.18, 2.75], diameter: 0.5, maxLevel: 1.7, level: 0.15 },
    ],
    links: [
      { kind: 'pipe', id: 'p0', from: 'cistern', to: 'j0', diameter: 0.05, roughness: acrylic },
      { kind: 'pump', id: 'pump', from: 'j0', to: 'j1', shutoffPressure: 70000, maxFlow: 2.5e-3, diameter: 0.05 },
      { kind: 'pipe', id: 'riser', from: 'j1', to: 'tee', via: [[-2.2, 1.6, 0]], diameter: 0.05, roughness: acrylic, minorLoss: 0.9 },
      { kind: 'valve', id: 'vA', from: 'tee', to: 'ha', diameter: 0.04 },
      { kind: 'pipe', id: 'a1', from: 'ha', to: 'e1', diameter: 0.04, roughness: acrylic },
      { kind: 'pipe', id: 'a2', from: 'e1', to: 'e2', diameter: 0.04, roughness: acrylic },
      { kind: 'pipe', id: 'b0', from: 'tee', to: 'hb', diameter: 0.04, roughness: acrylic, minorLoss: 0.9 },
      { kind: 'pipe', id: 'b1', from: 'hb', to: 'e3', diameter: 0.04, roughness: acrylic, minorLoss: 0.9 },
      { kind: 'pipe', id: 'b2', from: 'e3', to: 'e4', diameter: 0.04, roughness: acrylic },
      { kind: 'pipe', id: 'c0', from: 'tee', to: 'jc1', diameter: 0.04, roughness: acrylic },
      { kind: 'valve', id: 'vC', from: 'jc1', to: 'jc2', diameter: 0.04, opening: 0.6 },
      { kind: 'pipe', id: 'c1', from: 'jc2', to: 'buffer', via: [[0, 0.18, 2.0]], diameter: 0.012, roughness: acrylic, minorLoss: 0.9 },
    ],
  };
}
