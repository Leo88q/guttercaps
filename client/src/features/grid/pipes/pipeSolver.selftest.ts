/**
 * Self-test for pipeSolver.ts.  Run:  npx tsx src/pipes/pipeSolver.selftest.ts
 * Every check compares the solver with an independent calculation or a conservation law.
 */
import { FLUIDS, GRAVITY, ROUGHNESS, PipeNetwork } from './pipeSolver';
import type { NetworkDef } from './pipeSolver';

let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}
const near = (a: number, b: number, rel: number): boolean => Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b), 1e-30);

const fl = FLUIDS.water20;
const PI = Math.PI;

// independent Darcy–Weisbach (turbulent Swamee–Jain / laminar Poiseuille) for one pipe
function darcyHead(q: number, d: number, len: number, eps: number, g: number): number {
  const re = (4 * fl.density * q) / (PI * d * fl.viscosity);
  const v = q / ((PI * d * d) / 4);
  const f = re < 2000 ? 64 / re : 0.25 / Math.pow(Math.log10(eps / (3.7 * d) + 5.74 / Math.pow(re, 0.9)), 2);
  return (f * len * v * v) / (d * 2 * g);
}
function bisect(fn: (x: number) => number, lo: number, hi: number): number {
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (fn(mid) > 0) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

// 1 ── reservoir → pipe → reservoir, turbulent and laminar, Earth and Mars
for (const [label, d, len, dh, g] of [
  ['turbulent, Earth', 0.05, 12, 2.0, GRAVITY.earth],
  ['turbulent, Mars', 0.05, 12, 2.0, GRAVITY.mars],
  ['laminar, Earth', 0.004, 3, 0.1, GRAVITY.earth],
] as const) {
  const def: NetworkDef = {
    nodes: [
      { kind: 'reservoir', id: 'A', position: [0, 0, 0], head: 10 + dh },
      { kind: 'reservoir', id: 'B', position: [len, 0, 0], head: 10 },
    ],
    links: [{ kind: 'pipe', id: 'p', from: 'A', to: 'B', diameter: d, length: len, roughness: ROUGHNESS.steel }],
  };
  const net = new PipeNetwork(def, fl, { gravity: g });
  const q = (net.linkStates.get('p') as { flow: number }).flow;
  const qRef = bisect((x) => darcyHead(x, d, len, ROUGHNESS.steel, g) - dh, 1e-12, 1);
  check(`single pipe, ${label}`, near(q, qRef, 5e-3), `Q=${q.toExponential(4)} m³/s  reference=${qRef.toExponential(4)}  iterations=${net.lastIterations}`);
}

// 2 ── looped network: mass balance at every node and head-loss closure around the loop
{
  const def: NetworkDef = {
    nodes: [
      { kind: 'reservoir', id: 'R', position: [0, 0, 0], head: 30 },
      { kind: 'junction', id: 'n1', position: [10, 0, 0], demand: 0.004 },
      { kind: 'junction', id: 'n2', position: [10, 0, 10], demand: 0.006 },
      { kind: 'junction', id: 'n3', position: [0, 0, 10], demand: 0.003 },
    ],
    links: [
      { kind: 'pipe', id: 'a', from: 'R', to: 'n1', diameter: 0.1, length: 100, roughness: ROUGHNESS.castIron },
      { kind: 'pipe', id: 'b', from: 'n1', to: 'n2', diameter: 0.06, length: 80, roughness: ROUGHNESS.castIron, minorLoss: 1.5 },
      { kind: 'pipe', id: 'c', from: 'R', to: 'n3', diameter: 0.08, length: 90, roughness: ROUGHNESS.castIron },
      { kind: 'pipe', id: 'd', from: 'n3', to: 'n2', diameter: 0.05, length: 70, roughness: ROUGHNESS.castIron },
      { kind: 'pipe', id: 'e', from: 'n1', to: 'n3', diameter: 0.05, length: 60, roughness: ROUGHNESS.castIron },
    ],
  };
  const net = new PipeNetwork(def, fl);
  const Q = (id: string): number => (net.linkStates.get(id) as { flow: number }).flow;
  const dH = (id: string): number => (net.linkStates.get(id) as { headLoss: number }).headLoss;
  const r1 = Q('a') - Q('b') - Q('e') - 0.004;
  const r2 = Q('b') + Q('d') - 0.006;
  const r3 = Q('c') + Q('e') - Q('d') - 0.003;
  check('loop network mass balance', Math.max(Math.abs(r1), Math.abs(r2), Math.abs(r3)) < 1e-9, `residuals ${[r1, r2, r3].map((v) => v.toExponential(1)).join(' ')}  converged=${net.lastConverged}`);
  check('loop network head closure', Math.abs(dH('e') + dH('d') - dH('b')) < 1e-6, `path n1→n3→n2 loses ${(dH('e') + dH('d')).toFixed(5)} m, direct n1→n2 loses ${dH('b').toFixed(5)} m`);
  // every pipe must obey Darcy–Weisbach + fittings, evaluated here independently of the solver
  const geometry: Record<string, [number, number, number]> = { a: [0.1, 100, 0], b: [0.06, 80, 1.5], c: [0.08, 90, 0], d: [0.05, 70, 0], e: [0.05, 60, 0] };
  let worst = 0;
  for (const [id, [d, len, k]] of Object.entries(geometry)) {
    const q = Q(id);
    const v = Math.abs(q) / ((PI * d * d) / 4);
    const expected = Math.sign(q) * (darcyHead(Math.abs(q), d, len, ROUGHNESS.castIron, GRAVITY.earth) + (k * v * v) / (2 * GRAVITY.earth));
    worst = Math.max(worst, Math.abs(dH(id) - expected) / Math.abs(expected));
  }
  check('every pipe obeys Darcy–Weisbach', worst < 1e-3, `worst relative deviation ${worst.toExponential(2)}`);
}

// 3 ── pump operating point = intersection of pump curve and system curve
{
  const shutoff = 80000;
  const qMax = 4e-3;
  const lift = 3;
  const def: NetworkDef = {
    nodes: [
      { kind: 'reservoir', id: 'src', position: [0, 0, 0], head: 1 },
      { kind: 'junction', id: 'in', position: [0, 0, 0] },
      { kind: 'junction', id: 'out', position: [0, 0.5, 0] },
      { kind: 'reservoir', id: 'dst', position: [8, 0, 0], head: 1 + lift },
    ],
    links: [
      { kind: 'pipe', id: 's', from: 'src', to: 'in', diameter: 0.05, length: 0.5 },
      { kind: 'pump', id: 'pump', from: 'in', to: 'out', shutoffPressure: shutoff, maxFlow: qMax },
      { kind: 'pipe', id: 'd', from: 'out', to: 'dst', diameter: 0.04, length: 8, roughness: ROUGHNESS.pvc },
    ],
  };
  for (const g of [GRAVITY.earth, GRAVITY.mars]) {
    const net = new PipeNetwork(def, fl, { gravity: g });
    const q = (net.linkStates.get('pump') as { flow: number }).flow;
    const h0 = shutoff / (fl.density * g);
    const pumpHead = (x: number): number => h0 * (1 - (x / qMax) ** 2);
    const system = (x: number): number => lift + darcyHead(x, 0.04, 8, ROUGHNESS.pvc, g) + darcyHead(x, 0.05, 0.5, ROUGHNESS.steel, g);
    const qRef = bisect((x) => system(x) - pumpHead(x), 1e-9, qMax);
    check(`pump operating point, g=${g}`, near(q, qRef, 2e-2), `Q=${(q * 1000).toFixed(3)} L/s  reference=${(qRef * 1000).toFixed(3)} L/s  (shutoff head ${h0.toFixed(1)} m)`);
  }
}

// 4 ── nozzle follows the orifice law Q = Cd·A·√(2·Δp/ρ), independent of gravity for the same pressure
{
  const def: NetworkDef = {
    nodes: [
      { kind: 'reservoir', id: 'R', position: [0, 0, 0], head: 5 },
      { kind: 'junction', id: 'j', position: [1, 0, 0], nozzleDiameter: 0.004 },
    ],
    links: [{ kind: 'pipe', id: 'p', from: 'R', to: 'j', diameter: 0.05, length: 1 }],
  };
  const net = new PipeNetwork(def, fl, { gravity: GRAVITY.earth });
  const state = net.nodeStates.get('j') as { outflow: number; pressure: number };
  const expect = 0.62 * ((PI * 0.004 ** 2) / 4) * Math.sqrt((2 * state.pressure) / fl.density);
  check('nozzle orifice law', near(state.outflow, expect, 1e-4), `Q=${state.outflow.toExponential(4)}  Cd·A·√(2p/ρ)=${expect.toExponential(4)}  p=${(state.pressure / 1000).toFixed(2)} kPa`);
}

// 5 ── gravity-fed flow ratio on Mars: fully rough turbulent flow scales with √g
{
  const def: NetworkDef = {
    nodes: [
      { kind: 'reservoir', id: 'A', position: [0, 0, 0], head: 6 },
      { kind: 'reservoir', id: 'B', position: [30, 0, 0], head: 0 },
    ],
    links: [{ kind: 'pipe', id: 'p', from: 'A', to: 'B', diameter: 0.3, length: 30, roughness: ROUGHNESS.castIron }],
  };
  const qE = (new PipeNetwork(def, fl, { gravity: GRAVITY.earth }).linkStates.get('p') as { flow: number }).flow;
  const qM = (new PipeNetwork(def, fl, { gravity: GRAVITY.mars }).linkStates.get('p') as { flow: number }).flow;
  const expected = Math.sqrt(GRAVITY.mars / GRAVITY.earth);
  check('gravity-fed flow ∝ √g (rough turbulent)', near(qM / qE, expected, 2e-2), `Q_mars/Q_earth=${(qM / qE).toFixed(4)}  √(gM/gE)=${expected.toFixed(4)}`);
}

// 6 ── tank fills until it equals the source head, mass is conserved, then flow stops
{
  const def: NetworkDef = {
    nodes: [
      { kind: 'reservoir', id: 'R', position: [0, 0, 0], head: 2 },
      { kind: 'tank', id: 'T', position: [3, 0, 0], diameter: 0.5, maxLevel: 3, level: 0.2 },
    ],
    links: [{ kind: 'pipe', id: 'p', from: 'R', to: 'T', diameter: 0.04, length: 4 }],
  };
  const net = new PipeNetwork(def, fl);
  const area = (PI * 0.5 * 0.5) / 4;
  const before = (net.nodeStates.get('T') as { level: number }).level;
  let delivered = 0;
  for (let i = 0; i < 4000; i++) {
    net.step(0.5);
    delivered += (net.linkStates.get('p') as { flow: number }).flow * 0.5;
  }
  const after = (net.nodeStates.get('T') as { level: number }).level;
  const qEnd = (net.linkStates.get('p') as { flow: number }).flow;
  check('tank equalises with source', near(after, 2, 5e-3), `level ${before.toFixed(3)} → ${after.toFixed(4)} m (source head 2 m)  residual flow ${qEnd.toExponential(2)} m³/s`);
  // the flow integrated over time must equal the stored volume (rectangle rule on a decaying flow → loose tolerance)
  check('tank mass balance', near(delivered, (after - before) * area, 5e-2), `pipe delivered ${delivered.toFixed(4)} m³, tank gained ${((after - before) * area).toFixed(4)} m³`);
}

// 7 ── float valve: a full tank blocks inflow, an empty tank cannot be drained
{
  const def: NetworkDef = {
    nodes: [
      { kind: 'reservoir', id: 'R', position: [0, 0, 0], head: 10 },
      { kind: 'tank', id: 'T', position: [2, 0, 0], diameter: 0.4, maxLevel: 1, level: 0.99 },
    ],
    links: [{ kind: 'pipe', id: 'p', from: 'R', to: 'T', diameter: 0.04, length: 2 }],
  };
  const net = new PipeNetwork(def, fl);
  for (let i = 0; i < 200; i++) net.step(0.5);
  const t = net.nodeStates.get('T') as { level: number; lock: string };
  const q = (net.linkStates.get('p') as { flow: number }).flow;
  check('full tank closes its float valve', t.level <= 1 + 1e-12 && t.lock === 'full' && Math.abs(q) < 1e-9, `level=${t.level.toFixed(4)} lock=${t.lock} flow=${q.toExponential(1)}`);
}

// 8 ── closed valve and disconnected piping carry no flow, solver stays finite
{
  const def: NetworkDef = {
    nodes: [
      { kind: 'reservoir', id: 'R', position: [0, 0, 0], head: 5 },
      { kind: 'junction', id: 'j1', position: [1, 0, 0] },
      { kind: 'junction', id: 'j2', position: [2, 0, 0], nozzleDiameter: 0.003 },
    ],
    links: [
      { kind: 'pipe', id: 'p1', from: 'R', to: 'j1', diameter: 0.04, length: 1 },
      { kind: 'valve', id: 'v', from: 'j1', to: 'j2', diameter: 0.04, opening: 1 },
    ],
  };
  const net = new PipeNetwork(def, fl);
  const open = (net.linkStates.get('v') as { flow: number }).flow;
  net.setValveOpening('v', 0);
  net.solveWithLocks();
  const shut = (net.linkStates.get('v') as { flow: number }).flow;
  const p2 = (net.nodeStates.get('j2') as { pressure: number }).pressure;
  check('closed valve isolates the branch', open > 1e-5 && shut === 0 && Number.isFinite(p2), `open ${open.toExponential(2)} → shut ${shut}  downstream pressure ${p2.toFixed(1)} Pa`);
}

// 9 ── speed: 100-node grid solve
{
  const nodes: NetworkDef['nodes'][number][] = [{ kind: 'reservoir', id: 'R', position: [0, 0, 0], head: 40 }];
  const links: NetworkDef['links'][number][] = [];
  const N = 10;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    nodes.push({ kind: 'junction', id: `n${i}_${j}`, position: [i, 0, j], demand: 5e-5 });
    if (i > 0) links.push({ kind: 'pipe', id: `h${i}_${j}`, from: `n${i - 1}_${j}`, to: `n${i}_${j}`, diameter: 0.04, length: 20 });
    if (j > 0) links.push({ kind: 'pipe', id: `v${i}_${j}`, from: `n${i}_${j - 1}`, to: `n${i}_${j}`, diameter: 0.04, length: 20 });
  }
  links.push({ kind: 'pipe', id: 'feed', from: 'R', to: 'n0_0', diameter: 0.1, length: 50 });
  const t00 = performance.now();
  const net = new PipeNetwork({ nodes, links }, fl);
  const cold = performance.now() - t00;
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) net.solve();
  const ms = (performance.now() - t0) / 20;
  check('100-node grid solves quickly', net.lastConverged && ms < 25, `first solve ${cold.toFixed(1)} ms, warm re-solve ${ms.toFixed(2)} ms, ${net.lastIterations} iteration(s)`);
}

console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) FAILED.`);
if (failed > 0) throw new Error('pipeSolver self-test failed');
