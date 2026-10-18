/**
 * pipeSolver.ts — real hydraulics for pipe networks (no dependencies).
 *
 * What is simulated (SI units everywhere: m, s, kg, Pa, m³/s):
 *  - Steady flow in every pipe from the Darcy–Weisbach equation with a real friction factor:
 *    laminar 64/Re, turbulent Swamee–Jain (explicit Colebrook), smooth blend through the
 *    transition zone. Pipe roughness, diameter, length and fittings (minor losses) all matter.
 *  - The whole network is solved at once with the Global Gradient Algorithm (Todini & Pilati,
 *    the same method EPANET uses): loops, branches, any topology, mass conserved at every node.
 *  - Centrifugal pumps (quadratic pump curve + affinity laws + check valve), valves
 *    (loss coefficient grows as the opening closes), orifice emitters / nozzles.
 *  - Tanks fill and drain (mass balance, adaptive sub-steps, float-valve behaviour at full/empty).
 *  - Gravity is a parameter: pumps, friction and nozzles are defined in PRESSURE terms, so the
 *    same hardware behaves differently on Mars (3.721 m/s²) than on Earth (9.807 m/s²).
 *  - Absolute pressure vs vapour pressure → cavitation flag.
 *
 * What is NOT simulated: water hammer (fluid inertia), partly-filled gravity sewers (open channel),
 * thermal effects, air in lines. The model is quasi-steady: every tick the network is in
 * hydraulic equilibrium, tanks move slowly between ticks.
 */

export type Vec3 = readonly [number, number, number];

// ───────────────────────────── fluids, gravity, materials ─────────────────────────────

export interface Fluid {
  name: string;
  /** kg/m³ */
  density: number;
  /** dynamic viscosity, Pa·s */
  viscosity: number;
  /** saturation vapour pressure, Pa */
  vaporPressure: number;
}

export const FLUIDS = {
  water20: { name: 'Water 20 °C', density: 998.2, viscosity: 1.002e-3, vaporPressure: 2339 },
  water4: { name: 'Water 4 °C', density: 999.97, viscosity: 1.567e-3, vaporPressure: 813 },
  nutrient: { name: 'Nutrient solution', density: 1004, viscosity: 1.05e-3, vaporPressure: 2300 },
} satisfies Record<string, Fluid>;

/** m/s² */
export const GRAVITY = { earth: 9.80665, mars: 3.721 } as const;

/** Absolute wall roughness ε in metres. */
export const ROUGHNESS = {
  acrylic: 1.5e-6,
  pvc: 1.5e-6,
  steel: 4.5e-5,
  galvanized: 1.5e-4,
  castIron: 2.6e-4,
} as const;

export interface Environment {
  /** m/s² */
  gravity: number;
  /** Pa, pressure of the surrounding atmosphere (dome interior). Default 101325. */
  ambientPressure: number;
}

// ───────────────────────────── network definition ─────────────────────────────

interface NodeBase {
  id: string;
  /** Metres. y is elevation (up). For tanks this is the centre of the tank bottom. */
  position: Vec3;
  /** Where pipes physically attach (defaults to position). Does not change hydraulics. */
  anchor?: Vec3;
}

/** Infinite source with a fixed water level (cistern, supply line). */
export interface ReservoirDef extends NodeBase {
  kind: 'reservoir';
  /** Hydraulic head in metres (water surface elevation). Default: position.y. */
  head?: number;
  /** Only used for drawing. */
  visual?: { diameter: number; height: number };
}

export interface TankDef extends NodeBase {
  kind: 'tank';
  diameter: number;
  maxLevel: number;
  minLevel?: number;
  /** Initial water depth above the tank bottom. */
  level: number;
}

export interface JunctionDef extends NodeBase {
  kind: 'junction';
  /** Constant outflow in m³/s (negative = inflow from outside). */
  demand?: number;
  /** Open nozzle / dripper at this node, discharging to the room: orifice diameter in metres. */
  nozzleDiameter?: number;
  /** Orifice discharge coefficient, default 0.62. */
  dischargeCoefficient?: number;
}

export type NodeDef = ReservoirDef | TankDef | JunctionDef;

interface LinkBase {
  id: string;
  from: string;
  to: string;
  /** Intermediate corner points of the physical route (the route is anchor(from) → via… → anchor(to)). */
  via?: readonly Vec3[];
}

export interface PipeDef extends LinkBase {
  kind: 'pipe';
  /** Inner diameter, m */
  diameter: number;
  /** Absolute roughness, m (see ROUGHNESS). Default steel. */
  roughness?: number;
  /** Sum of fitting loss coefficients (elbows ≈ 0.3 each, tee ≈ 1). Default 0. */
  minorLoss?: number;
  /** Override hydraulic length in metres (default: length of the route). */
  length?: number;
}

export interface PumpDef extends LinkBase {
  kind: 'pump';
  /** Pressure rise at zero flow at full speed, Pa. */
  shutoffPressure: number;
  /** Flow at zero pressure rise at full speed, m³/s. */
  maxFlow: number;
  /** 0…1 relative speed (affinity laws). Default 1. */
  speed?: number;
  /** Port diameter, drawing only. Default 0.05. */
  diameter?: number;
}

export interface ValveDef extends LinkBase {
  kind: 'valve';
  diameter: number;
  /** 0 (closed) … 1 (fully open). Default 1. */
  opening?: number;
  /** Loss coefficient K when fully open. Default 0.2 (ball valve). */
  fullyOpenLoss?: number;
}

export type LinkDef = PipeDef | PumpDef | ValveDef;

export interface NetworkDef {
  nodes: readonly NodeDef[];
  links: readonly LinkDef[];
}

// ───────────────────────────── results ─────────────────────────────

export type Regime = 'still' | 'laminar' | 'transitional' | 'turbulent';
export type TankLock = 'none' | 'empty' | 'full';

export interface NodeState {
  id: string;
  /** Hydraulic head, m (elevation + pressure head). */
  head: number;
  /** Gauge pressure, Pa. */
  pressure: number;
  /** Tanks: water depth, m. Reservoirs: head − elevation. */
  level: number;
  lock: TankLock;
  /** Total liquid that has left the system at this node (nozzle + demand), m³. */
  delivered: number;
  /** Current outflow at this node, m³/s. */
  outflow: number;
  /** True when absolute pressure falls below vapour pressure. */
  cavitation: boolean;
}

export interface LinkState {
  id: string;
  /** m³/s, positive = from → to. */
  flow: number;
  /** Mean velocity, m/s, signed like flow. */
  velocity: number;
  /** H(from) − H(to), m. Negative for a working pump. */
  headLoss: number;
  reynolds: number;
  regime: Regime;
  closed: boolean;
  /** Valve opening / pump speed (1 for pipes). */
  setting: number;
  /** Hydraulic power delivered by a pump, W. */
  power: number;
}

// ───────────────────────────── internals ─────────────────────────────

const PI = Math.PI;
const PMIN = 1e-6;

interface NodeRec {
  idx: number;
  id: string;
  kind: 'reservoir' | 'tank' | 'junction' | 'atmosphere';
  pos: Vec3;
  anchor: Vec3;
  fixedHead: number;
  area: number;
  minLevel: number;
  maxLevel: number;
  level: number;
  lock: TankLock;
  demand: number;
  nozzle: number;
  cd: number;
  delivered: number;
  head: number;
  emitterLink: number;
}

interface LinkRec {
  id: string;
  kind: 'pipe' | 'pump' | 'valve' | 'emitter';
  a: number;
  b: number;
  points: Vec3[];
  length: number;
  diameter: number;
  roughness: number;
  minorK: number;
  shutoff: number;
  maxFlow: number;
  /** valve opening, pump speed, emitter nozzle diameter (m), pipe: 1 */
  setting: number;
  cd: number;
  flow: number;
  init: boolean;
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function swameeJain(re: number, relRough: number): number {
  const t = Math.log10(relRough / 3.7 + 5.74 / Math.pow(re, 0.9));
  return 0.25 / (t * t);
}

/** Quadratic loss h = c·Q|Q| with a linear core near zero (keeps Newton's slope finite). */
function smoothQuad(q: number, c: number, qe: number, oneWay: boolean): number {
  if (q >= qe) return c * q * q;
  if (q >= 0) return c * qe * q;
  return oneWay ? c * qe * 1e3 * q : -smoothQuad(-q, c, qe, false);
}

export class PipeNetwork {
  fluid: Fluid;
  env: Environment;
  /** Simulated seconds since construction. */
  time = 0;
  /** Largest sub-step used by step(), s. */
  maxSubstep = 0.5;
  /** step() shortens sub-steps so no tank level moves more than this, m. */
  maxLevelStep = 0.01;
  /** Relative flow-change tolerance of the Newton iteration. */
  tolerance = 1e-7;
  maxIterations = 100;
  lastIterations = 0;
  lastConverged = true;

  readonly nodeDefs: readonly NodeDef[];
  readonly linkDefs: readonly LinkDef[];
  readonly nodeStates = new Map<string, NodeState>();
  readonly linkStates = new Map<string, LinkState>();

  private nodes: NodeRec[] = [];
  private links: LinkRec[] = [];
  private nodeIndex = new Map<string, number>();
  private linkIndex = new Map<string, number>();
  private warm = false;

  constructor(def: NetworkDef, fluid: Fluid = FLUIDS.water20, env: Partial<Environment> = {}) {
    this.fluid = fluid;
    this.env = { gravity: GRAVITY.earth, ambientPressure: 101325, ...env };
    this.nodeDefs = def.nodes;
    this.linkDefs = def.links;

    for (const d of def.nodes) {
      if (this.nodeIndex.has(d.id)) throw new Error(`Duplicate node id "${d.id}"`);
      const rec: NodeRec = {
        idx: this.nodes.length,
        id: d.id,
        kind: d.kind,
        pos: d.position,
        anchor: d.anchor ?? d.position,
        fixedHead: d.position[1],
        area: 0,
        minLevel: 0,
        maxLevel: 0,
        level: 0,
        lock: 'none',
        demand: 0,
        nozzle: 0,
        cd: 0.62,
        delivered: 0,
        head: d.position[1],
        emitterLink: -1,
      };
      if (d.kind === 'reservoir') {
        rec.fixedHead = d.head ?? d.position[1];
        rec.head = rec.fixedHead;
        rec.level = rec.fixedHead - d.position[1];
      } else if (d.kind === 'tank') {
        if (d.diameter <= 0) throw new Error(`Tank "${d.id}" needs a positive diameter`);
        rec.area = (PI * d.diameter * d.diameter) / 4;
        rec.minLevel = d.minLevel ?? 0;
        rec.maxLevel = d.maxLevel;
        rec.level = Math.min(Math.max(d.level, rec.minLevel), rec.maxLevel);
        rec.head = d.position[1] + rec.level;
      } else {
        rec.demand = d.demand ?? 0;
        rec.nozzle = d.nozzleDiameter ?? 0;
        rec.cd = d.dischargeCoefficient ?? 0.62;
      }
      this.nodeIndex.set(d.id, this.nodes.length);
      this.nodes.push(rec);
    }

    for (const d of def.links) {
      if (this.linkIndex.has(d.id)) throw new Error(`Duplicate link id "${d.id}"`);
      const a = this.nodeIndex.get(d.from);
      const b = this.nodeIndex.get(d.to);
      if (a === undefined) throw new Error(`Link "${d.id}": unknown node "${d.from}"`);
      if (b === undefined) throw new Error(`Link "${d.id}": unknown node "${d.to}"`);
      if (d.kind !== 'pump' && d.diameter <= 0) throw new Error(`Link "${d.id}" needs a positive diameter`);
      const na = this.nodes[a] as NodeRec;
      const nb = this.nodes[b] as NodeRec;
      const points: Vec3[] = [na.anchor, ...(d.via ?? []), nb.anchor];
      let routeLength = 0;
      for (let i = 1; i < points.length; i++) routeLength += dist(points[i - 1] as Vec3, points[i] as Vec3);
      const rec: LinkRec = {
        id: d.id,
        kind: d.kind,
        a,
        b,
        points,
        length: routeLength,
        diameter: 0.05,
        roughness: ROUGHNESS.steel,
        minorK: 0,
        shutoff: 0,
        maxFlow: 0,
        setting: 1,
        cd: 0.62,
        flow: 0,
        init: false,
      };
      if (d.kind === 'pipe') {
        rec.diameter = d.diameter;
        rec.roughness = d.roughness ?? ROUGHNESS.steel;
        rec.minorK = d.minorLoss ?? 0;
        rec.length = Math.max(d.length ?? routeLength, 1e-3);
      } else if (d.kind === 'valve') {
        rec.diameter = d.diameter;
        rec.minorK = d.fullyOpenLoss ?? 0.2;
        rec.setting = d.opening ?? 1;
      } else {
        rec.diameter = d.diameter ?? 0.05;
        rec.shutoff = d.shutoffPressure;
        rec.maxFlow = d.maxFlow;
        rec.setting = d.speed ?? 1;
      }
      this.linkIndex.set(d.id, this.links.length);
      this.links.push(rec);
    }

    // Every junction with a nozzle gets a hidden link to an "atmosphere" node at its own elevation.
    for (let i = 0, n = this.nodes.length; i < n; i++) {
      const node = this.nodes[i] as NodeRec;
      if (node.kind !== 'junction' || node.nozzle <= 0) continue;
      const atm: NodeRec = { ...node, idx: this.nodes.length, id: `atm:${node.id}`, kind: 'atmosphere', fixedHead: node.pos[1], nozzle: 0, demand: 0, emitterLink: -1 };
      const atmIndex = this.nodes.length;
      this.nodes.push(atm);
      node.emitterLink = this.links.length;
      this.links.push({
        id: `nozzle:${node.id}`,
        kind: 'emitter',
        a: i,
        b: atmIndex,
        points: [node.anchor, node.anchor],
        length: 0,
        diameter: node.nozzle,
        roughness: 0,
        minorK: 0,
        shutoff: 0,
        maxFlow: 0,
        setting: node.nozzle,
        cd: node.cd,
        flow: 0,
        init: false,
      });
    }

    for (const n of this.nodes) {
      if (n.kind === 'atmosphere') continue;
      this.nodeStates.set(n.id, {
        id: n.id, head: n.head, pressure: 0, level: n.level, lock: 'none', delivered: 0, outflow: 0, cavitation: false,
      });
    }
    for (const l of this.links) {
      if (l.kind === 'emitter') continue;
      this.linkStates.set(l.id, {
        id: l.id, flow: 0, velocity: 0, headLoss: 0, reynolds: 0, regime: 'still', closed: false, setting: l.setting, power: 0,
      });
    }
    this.solveWithLocks();
  }

  // ───────────── controls ─────────────

  setValveOpening(id: string, opening: number): void {
    const l = this.linkOf(id, 'valve');
    l.setting = Math.min(Math.max(opening, 0), 1);
    if (l.setting < 0.005) { l.flow = 0; l.init = false; }
  }

  setPumpSpeed(id: string, speed: number): void {
    const l = this.linkOf(id, 'pump');
    l.setting = Math.min(Math.max(speed, 0), 1.2);
    if (l.setting < 0.02) { l.flow = 0; l.init = false; }
  }

  setDemand(id: string, demand: number): void {
    this.nodeOf(id).demand = demand;
  }

  setNozzleDiameter(id: string, diameter: number): void {
    const n = this.nodeOf(id);
    if (n.emitterLink < 0) throw new Error(`Node "${id}" was created without a nozzle`);
    (this.links[n.emitterLink] as LinkRec).setting = Math.max(diameter, 0);
    (this.links[n.emitterLink] as LinkRec).diameter = Math.max(diameter, 1e-6);
  }

  setGravity(g: number): void {
    this.env.gravity = g;
  }

  setFluid(fluid: Fluid): void {
    this.fluid = fluid;
  }

  /** Route of a link as a polyline (anchor → via → anchor). */
  routeOf(id: string): readonly Vec3[] {
    return (this.links[this.linkIdx(id)] as LinkRec).points;
  }

  // ───────────── time stepping ─────────────

  /**
   * Advance the simulation by dt seconds. The hydraulics are re-solved before every sub-step
   * (sub-steps are shortened so tank levels change smoothly).
   */
  step(dt: number): void {
    let remaining = Math.max(dt, 0);
    if (remaining === 0) { this.solveWithLocks(); return; }
    let guard = 0;
    while (remaining > 1e-9) {
      this.solveWithLocks();
      let h = Math.min(remaining, this.maxSubstep);
      for (const n of this.nodes) {
        if (n.kind !== 'tank' || n.lock !== 'none') continue;
        const q = Math.abs(this.netInflow(n));
        if (q > 1e-15) h = Math.min(h, (this.maxLevelStep * n.area) / q);
      }
      h = Math.max(h, Math.min(remaining, 1e-3));
      if (++guard > 64) h = remaining;
      this.integrate(h);
      remaining -= h;
    }
    this.refreshStates();
  }

  private integrate(h: number): void {
    for (const n of this.nodes) {
      if (n.kind === 'tank' && n.lock === 'none') {
        n.level = Math.min(Math.max(n.level + (this.netInflow(n) * h) / n.area, n.minLevel), n.maxLevel);
      }
      if (n.kind === 'junction') {
        let q = n.demand;
        if (n.emitterLink >= 0) q += Math.max((this.links[n.emitterLink] as LinkRec).flow, 0);
        n.delivered += q * h;
      }
    }
    this.time += h;
  }

  private netInflow(n: NodeRec): number {
    let q = 0;
    for (const l of this.links) {
      if (l.b === n.idx) q += l.flow;
      else if (l.a === n.idx) q -= l.flow;
    }
    return q;
  }

  // ───────────── steady-state hydraulics ─────────────

  /** Solve the hydraulics for the current levels/settings, handling full/empty tanks. */
  solveWithLocks(): boolean {
    let ok = true;
    for (let pass = 0; pass < 6; pass++) {
      ok = this.solve();
      let changed = false;
      for (const n of this.nodes) {
        if (n.kind !== 'tank') continue;
        if (n.lock === 'none') {
          const net = this.netInflow(n);
          if (n.level <= n.minLevel + 1e-9 && net < -1e-12) { n.lock = 'empty'; changed = true; }
          else if (n.level >= n.maxLevel - 1e-9 && net > 1e-12) { n.lock = 'full'; changed = true; }
        } else {
          const surface = n.pos[1] + n.level;
          if (n.lock === 'empty' && n.head > surface + 1e-6) { n.lock = 'none'; changed = true; }
          else if (n.lock === 'full' && n.head < surface - 1e-6) { n.lock = 'none'; changed = true; }
        }
      }
      if (!changed) break;
    }
    this.refreshStates();
    return ok;
  }

  /** One Global-Gradient solve. Returns false if the iteration limit was hit. */
  solve(): boolean {
    const nodes = this.nodes;
    const links = this.links;
    const nN = nodes.length;
    const nL = links.length;

    // fixed-head nodes
    const fixed = new Uint8Array(nN);
    let headSum = 0;
    let headCount = 0;
    for (let i = 0; i < nN; i++) {
      const n = nodes[i] as NodeRec;
      if (n.kind === 'reservoir' || n.kind === 'atmosphere') {
        fixed[i] = 1;
        n.head = n.fixedHead;
      } else if (n.kind === 'tank' && n.lock === 'none') {
        fixed[i] = 1;
        n.head = n.pos[1] + n.level;
      }
      if (fixed[i]) { headSum += n.head; headCount++; }
    }
    const meanHead = headCount > 0 ? headSum / headCount : 0;

    // open links, adjacency, reachability from fixed nodes
    const open = new Uint8Array(nL);
    const adj: number[][] = Array.from({ length: nN }, () => []);
    for (let li = 0; li < nL; li++) {
      const l = links[li] as LinkRec;
      if (this.isClosed(l)) {
        l.flow = 0;
        l.init = false;
        continue;
      }
      open[li] = 1;
      (adj[l.a] as number[]).push(li);
      (adj[l.b] as number[]).push(li);
    }
    const reached = new Uint8Array(nN);
    const queue: number[] = [];
    for (let i = 0; i < nN; i++) if (fixed[i]) { reached[i] = 1; queue.push(i); }
    for (let qi = 0; qi < queue.length; qi++) {
      for (const li of adj[queue[qi] as number] as number[]) {
        const l = links[li] as LinkRec;
        for (const nb of [l.a, l.b]) {
          if (!reached[nb]) { reached[nb] = 1; queue.push(nb); }
        }
      }
    }
    const uIdx = new Int32Array(nN).fill(-1);
    const unknown: number[] = [];
    for (let i = 0; i < nN; i++) {
      if (!fixed[i] && reached[i]) { uIdx[i] = unknown.length; unknown.push(i); }
      else if (!fixed[i]) { (nodes[i] as NodeRec).head = (nodes[i] as NodeRec).pos[1]; }
    }
    const nU = unknown.length;
    if (!this.warm) for (const i of unknown) (nodes[i] as NodeRec).head = meanHead;

    const active: number[] = [];
    for (let li = 0; li < nL; li++) {
      const l = links[li] as LinkRec;
      if (open[li] && reached[l.a] && reached[l.b]) {
        active.push(li);
        if (!l.init) { l.flow = this.initialFlow(l); l.init = true; }
      } else {
        l.flow = 0;
      }
    }

    const g = new Float64Array(nL);
    const c = new Float64Array(nL);
    const diag = new Float64Array(nU);
    const rhs = new Float64Array(nU);
    const x = new Float64Array(nU);
    const r = new Float64Array(nU);
    const z = new Float64Array(nU);
    const p = new Float64Array(nU);
    const ap = new Float64Array(nU);

    let converged = false;
    let iter = 0;
    for (; iter < this.maxIterations; iter++) {
      diag.fill(0);
      rhs.fill(0);
      for (const li of active) {
        const l = links[li] as LinkRec;
        const q = l.flow;
        const h = this.headLoss(l, q);
        const d = Math.max(1e-10, Math.abs(q) * 1e-4);
        let slope = (this.headLoss(l, q + d) - this.headLoss(l, q - d)) / (2 * d);
        if (!(slope > PMIN)) slope = PMIN;
        g[li] = 1 / slope;
        c[li] = q - h / slope;
        const ia = uIdx[l.a] as number;
        const ib = uIdx[l.b] as number;
        if (ia >= 0) { diag[ia] = (diag[ia] as number) + (g[li] as number); rhs[ia] = (rhs[ia] as number) - (c[li] as number); }
        if (ib >= 0) { diag[ib] = (diag[ib] as number) + (g[li] as number); rhs[ib] = (rhs[ib] as number) + (c[li] as number); }
        if (ia >= 0 && ib < 0) rhs[ia] = (rhs[ia] as number) + (g[li] as number) * (nodes[l.b] as NodeRec).head;
        if (ib >= 0 && ia < 0) rhs[ib] = (rhs[ib] as number) + (g[li] as number) * (nodes[l.a] as NodeRec).head;
      }
      for (let k = 0; k < nU; k++) {
        rhs[k] = (rhs[k] as number) - (nodes[unknown[k] as number] as NodeRec).demand;
        x[k] = (nodes[unknown[k] as number] as NodeRec).head;
      }

      // preconditioned conjugate gradient on  (D − offdiag) x = rhs
      const matvec = (v: Float64Array, out: Float64Array): void => {
        for (let k = 0; k < nU; k++) out[k] = (diag[k] as number) * (v[k] as number);
        for (const li of active) {
          const l = links[li] as LinkRec;
          const ia = uIdx[l.a] as number;
          const ib = uIdx[l.b] as number;
          if (ia >= 0 && ib >= 0) {
            out[ia] = (out[ia] as number) - (g[li] as number) * (v[ib] as number);
            out[ib] = (out[ib] as number) - (g[li] as number) * (v[ia] as number);
          }
        }
      };
      if (nU > 0) {
        matvec(x, ap);
        let bb = 0;
        let rz = 0;
        for (let k = 0; k < nU; k++) {
          r[k] = (rhs[k] as number) - (ap[k] as number);
          z[k] = (r[k] as number) / (diag[k] as number);
          p[k] = z[k] as number;
          rz += (r[k] as number) * (z[k] as number);
          bb += (rhs[k] as number) * (rhs[k] as number);
        }
        const stop = 1e-24 * bb + 1e-60;
        for (let it = 0; it < 5 * nU + 50; it++) {
          let rr = 0;
          for (let k = 0; k < nU; k++) rr += (r[k] as number) * (r[k] as number);
          if (rr <= stop) break;
          matvec(p, ap);
          let pap = 0;
          for (let k = 0; k < nU; k++) pap += (p[k] as number) * (ap[k] as number);
          if (!(pap > 0)) break;
          const alpha = rz / pap;
          let rzNew = 0;
          for (let k = 0; k < nU; k++) {
            x[k] = (x[k] as number) + alpha * (p[k] as number);
            r[k] = (r[k] as number) - alpha * (ap[k] as number);
            z[k] = (r[k] as number) / (diag[k] as number);
            rzNew += (r[k] as number) * (z[k] as number);
          }
          const beta = rzNew / rz;
          rz = rzNew;
          for (let k = 0; k < nU; k++) p[k] = (z[k] as number) + beta * (p[k] as number);
        }
        for (let k = 0; k < nU; k++) (nodes[unknown[k] as number] as NodeRec).head = x[k] as number;
      }

      // new flows from the linearised head-loss law
      let sumDQ = 0;
      let sumQ = 0;
      for (const li of active) {
        const l = links[li] as LinkRec;
        const qNew = (g[li] as number) * ((nodes[l.a] as NodeRec).head - (nodes[l.b] as NodeRec).head) + (c[li] as number);
        sumDQ += Math.abs(qNew - l.flow);
        sumQ += Math.abs(qNew);
        l.flow = qNew;
      }
      if (sumDQ <= this.tolerance * sumQ + 1e-15) { converged = true; iter++; break; }
    }
    this.warm = true;
    this.lastIterations = iter;
    this.lastConverged = converged;
    return converged;
  }

  // ───────────── physics of one link ─────────────

  private isClosed(l: LinkRec): boolean {
    if (l.kind === 'valve') return l.setting < 0.005;
    if (l.kind === 'pump') return l.setting < 0.02;
    if (l.kind === 'emitter') return l.setting <= 0;
    return false;
  }

  private initialFlow(l: LinkRec): number {
    if (l.kind === 'pump') return 0.5 * l.maxFlow * l.setting;
    if (l.kind === 'emitter') return this.emitterK(l);
    return 0.3 * ((PI * l.diameter * l.diameter) / 4);
  }

  private emitterK(l: LinkRec): number {
    const area = (PI * l.setting * l.setting) / 4;
    return l.cd * area * Math.sqrt(2 * this.env.gravity);
  }

  /** Head lost between the link's two ends for flow q (negative = head gained). */
  private headLoss(l: LinkRec, q: number): number {
    const g = this.env.gravity;
    switch (l.kind) {
      case 'pipe': {
        const fl = this.fluid;
        const aq = Math.abs(q);
        const d = l.diameter;
        const re = (4 * fl.density * aq) / (PI * d * fl.viscosity);
        const lam = (16 * PI * d * fl.viscosity * aq) / fl.density; // = (64/Re)·Q²
        let fq2: number;
        if (re <= 2000) fq2 = lam;
        else {
          const turb = swameeJain(re, l.roughness / d) * aq * aq;
          if (re >= 4000) fq2 = turb;
          else {
            const t = (re - 2000) / 2000;
            fq2 = lam * (1 - t) + turb * t;
          }
        }
        const h = (8 / (g * PI * PI * Math.pow(d, 4))) * ((l.length / d) * fq2 + l.minorK * aq * aq);
        return q < 0 ? -h : h;
      }
      case 'valve': {
        const k = l.minorK / (l.setting * l.setting);
        const c = (8 * k) / (g * PI * PI * Math.pow(l.diameter, 4));
        return smoothQuad(q, c, 1e-7, false);
      }
      case 'emitter': {
        const k = this.emitterK(l);
        return smoothQuad(q, 1 / (k * k), 0.01 * k, true);
      }
      case 'pump': {
        const s = l.setting;
        const h0 = (l.shutoff * s * s) / (this.fluid.density * g);
        const qMax = l.maxFlow * s;
        const r = h0 / (qMax * qMax);
        const qRef = 0.1 * qMax;
        const pRef = 2 * r * qRef;
        if (q >= qRef) return r * q * q - h0;
        const hAtZero = -h0 - r * qRef * qRef;
        if (q >= 0) return hAtZero + pRef * q;
        return hAtZero + pRef * 1e3 * q; // check valve: reverse flow is blocked
      }
    }
  }

  // ───────────── results ─────────────

  private refreshStates(): void {
    const g = this.env.gravity;
    const fl = this.fluid;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i] as NodeRec;
      const s = this.nodeStates.get(n.id);
      if (!s) continue;
      const pressure = fl.density * g * (n.head - n.pos[1]);
      s.head = n.head;
      s.pressure = n.kind === 'junction' || n.kind === 'tank' ? pressure : 0;
      s.level = n.kind === 'reservoir' ? n.head - n.pos[1] : n.level;
      s.lock = n.lock;
      s.delivered = n.delivered;
      let out = n.kind === 'junction' ? n.demand : 0;
      if (n.emitterLink >= 0) out += Math.max((this.links[n.emitterLink] as LinkRec).flow, 0);
      s.outflow = out;
      s.cavitation = n.kind === 'junction' && this.env.ambientPressure + pressure < fl.vaporPressure;
    }
    for (const l of this.links) {
      const s = this.linkStates.get(l.id);
      if (!s) continue;
      const area = (PI * l.diameter * l.diameter) / 4;
      const q = l.flow;
      const re = (4 * fl.density * Math.abs(q)) / (PI * l.diameter * fl.viscosity);
      const dh = (this.nodes[l.a] as NodeRec).head - (this.nodes[l.b] as NodeRec).head;
      s.flow = q;
      s.velocity = q / area;
      s.headLoss = this.isClosed(l) ? 0 : dh;
      s.reynolds = re;
      s.regime = Math.abs(q) < 1e-9 ? 'still' : re < 2300 ? 'laminar' : re < 4000 ? 'transitional' : 'turbulent';
      s.closed = this.isClosed(l);
      s.setting = l.setting;
      s.power = l.kind === 'pump' && q > 0 ? fl.density * g * q * Math.max(-dh, 0) : 0;
    }
  }

  // ───────────── lookup helpers ─────────────

  private nodeOf(id: string): NodeRec {
    const i = this.nodeIndex.get(id);
    if (i === undefined) throw new Error(`Unknown node "${id}"`);
    return this.nodes[i] as NodeRec;
  }

  private linkIdx(id: string): number {
    const i = this.linkIndex.get(id);
    if (i === undefined) throw new Error(`Unknown link "${id}"`);
    return i;
  }

  private linkOf(id: string, kind: LinkRec['kind']): LinkRec {
    const l = this.links[this.linkIdx(id)] as LinkRec;
    if (l.kind !== kind) throw new Error(`Link "${id}" is a ${l.kind}, not a ${kind}`);
    return l;
  }
}
