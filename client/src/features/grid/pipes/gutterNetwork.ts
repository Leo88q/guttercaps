import { FLUIDS, GRAVITY, PipeNetwork, ROUGHNESS } from './pipeSolver';
import type { LinkDef, NetworkDef, NodeDef } from './pipeSolver';
import { E, N, S, W, poweredCells, rotateMask, type Level } from '@guttercaps/economy';

/**
 * Головоломка Grid → гидравлическая сеть решателя (встраивание в игру,
 * 2026-10-18): каждая клетка — узел на плоскости квартала, каждая взаимно
 * соединённая пара портов — труба, шина — резервуар с напором, приёмники —
 * форсунки. Игрок крутит фрагменты в головоломке — решатель честно считает
 * расходы, а 3D-сцена показывает именно его сеть. Очки сектора при этом
 * по-прежнему считает сервер по своим правилам: гидравлика здесь — живая
 * обратная связь, а не второй судья.
 */
export function networkFromLevel(level: Level): NetworkDef {
  const size = level.size;
  const CELL = 0.55;
  const nodes: NodeDef[] = [];
  const links: LinkDef[] = [];
  const mask = (i: number) => rotateMask(level.tiles[i].base, level.tiles[i].rot);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const pos: [number, number, number] = [x * CELL, 0, y * CELL];
      if (i === level.bus) nodes.push({ kind: 'reservoir', id: `c${i}`, position: pos, head: 2.4 });
      else if (level.receivers.includes(i)) nodes.push({ kind: 'junction', id: `c${i}`, position: pos, nozzleDiameter: 0.02 });
      else nodes.push({ kind: 'junction', id: `c${i}`, position: pos });
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (x + 1 < size && (mask(i) & E) && (mask(i + 1) & W)) {
        links.push({ kind: 'pipe', id: `l${i}_${i + 1}`, from: `c${i}`, to: `c${i + 1}`, diameter: 0.045, length: CELL, roughness: ROUGHNESS.pvc });
      }
      if (y + 1 < size && (mask(i) & S) && (mask(i + size) & N)) {
        links.push({ kind: 'pipe', id: `l${i}_${i + size}`, from: `c${i}`, to: `c${i + size}`, diameter: 0.045, length: CELL, roughness: ROUGHNESS.pvc });
      }
    }
  }
  return { nodes, links };
}

/** Открытые концы: порт смотрит в соседа, который не отвечает, или за край. */
export function openEnds(level: Level): number {
  return openEndCells(level).filter(Boolean).length;
}

/** Клетки с открытым концом (порт без ответа соседа или за край поля). */
export function openEndCells(level: Level): boolean[] {
  const size = level.size;
  const mask = (i: number) => rotateMask(level.tiles[i].base, level.tiles[i].rot);
  return level.tiles.map((_, i) => {
    const x = i % size;
    const y = Math.floor(i / size);
    const m = mask(i);
    return Boolean(
      ((m & N) && (y === 0 || !(mask(i - size) & S)))
      || ((m & S) && (y === size - 1 || !(mask(i + size) & N)))
      || ((m & W) && (x === 0 || !(mask(i - 1) & E)))
      || ((m & E) && (x === size - 1 || !(mask(i + 1) & W))),
    );
  });
}

export interface LevelHydraulics {
  /** Пиковая скорость воды в трубах каждой клетки, м/с (0 — сухо). */
  speed: number[];
  /** Под током, но есть открытый конец: вода уходит в никуда. */
  leaking: boolean[];
  /** Суммарный расход на приёмники, м³/с. */
  totalFlow: number;
  /** Сколько приёмников реально получает воду. */
  fed: number;
}

/**
 * Гидравлика текущего состояния головоломки — для самой доски, а не для
 * отдельной сцены: скорость воды в каждой клетке берётся из решателя
 * (максимум по инцидентным трубам), и доска красит поток по этим цифрам.
 */
export function solveLevel(level: Level): LevelHydraulics {
  const speed = level.tiles.map(() => 0);
  const open = openEndCells(level);
  let net: PipeNetwork | null = null;
  try {
    net = new PipeNetwork(networkFromLevel(level), FLUIDS.water20, { gravity: GRAVITY.earth });
    net.solve();
  } catch {
    net = null;
  }
  if (net) {
    for (const [id, s] of net.linkStates) {
      const m = /^l(\d+)_(\d+)$/.exec(id);
      if (!m) continue;
      const v = Math.abs(s.velocity);
      speed[Number(m[1])] = Math.max(speed[Number(m[1])], v);
      speed[Number(m[2])] = Math.max(speed[Number(m[2])], v);
    }
  }
  const powered = poweredCells(level);
  let totalFlow = 0;
  let fed = 0;
  if (net) {
    for (const i of level.receivers) {
      const out = net.nodeStates.get(`c${i}`)?.outflow ?? 0;
      totalFlow += out;
      if (out > 1e-9) fed++;
    }
  }
  return {
    speed,
    leaking: level.tiles.map((_, i) => powered[i] && open[i]),
    totalFlow,
    fed,
  };
}

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
