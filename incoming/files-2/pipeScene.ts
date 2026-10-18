/**
 * pipeScene.ts — draws a PipeNetwork with three.js and keeps simulation and picture in sync.
 *
 *  - Tubes are acrylic (faint tint + additive glint) with the liquid inside as a custom shader
 *    driven by the solver: direction, speed, laminar/turbulent profile, pressure, priming front.
 *  - Brass flanges, couplings, bolts and joints are instanced (a handful of draw calls).
 *  - Tanks/cisterns show a real water level and a rippling free surface (ripples follow inflow).
 *  - Nozzles throw droplets that fall under the network's gravity (watch them on Mars vs Earth).
 *  - Valves and pumps are clickable: onPickLink(id).
 *
 * Needs only `three` (+ `@types/three`). Hydraulics tick at 20 Hz; the picture runs at display rate.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { liquidFragment, liquidVertex, surfaceFragment, surfaceVertex } from './liquidShaders';
import type { PipeNetwork, Vec3 } from './pipeSolver';

export interface PipeTheme {
  background: string;
  floor: string;
  floorGrid: string;
  glass: string;
  /** 0…1 strength of the additive reflection on the glass */
  glint: number;
  metal: string;
  metalDark: string;
  handle: string;
  liquidDeep: string;
  liquidLight: string;
  liquidGlow: string;
  skyLow: string;
  skyHigh: string;
  keyLight: string;
  fillLight: string;
  rimLight: string;
}

/** Hydroponic lab under a Mars-dome grow light: oxidised floor, aged brass, mint nutrient solution. */
export const MARS_LAB_THEME: PipeTheme = {
  background: '#1b0d12',
  floor: '#3a1a14',
  floorGrid: '#7a3d2c',
  glass: '#cfeee3',
  glint: 0.6,
  metal: '#a9824a',
  metalDark: '#4b4a4f',
  handle: '#d2492a',
  liquidDeep: '#0a4f43',
  liquidLight: '#7ad9b4',
  liquidGlow: '#c4f5dc',
  skyLow: '#2b1020',
  skyHigh: '#b0708f',
  keyLight: '#ffd7b0',
  fillLight: '#6f7fb8',
  rimLight: '#ff4fa3',
};

export interface PipeSceneOptions {
  theme?: PipeTheme;
  /** Simulated seconds per real second for tank dynamics (pipe flow is always shown in real time). */
  timeScale?: number;
  onPickLink?: (id: string) => void;
  /** Ids of pipes that start empty and fill as liquid reaches them. */
  initiallyDry?: readonly string[];
  /** Gauge pressure (Pa) that maps to the full pressure tint. */
  referencePressure?: number;
}

const UP = new THREE.Vector3(0, 1, 0);
const CYCLE = 0.5; // metres a streak travels per advection cycle
const TICK = 1 / 20; // hydraulic tick, s

const v3 = (p: Vec3): THREE.Vector3 => new THREE.Vector3(p[0], p[1], p[2]);
const clamp01 = (x: number): number => Math.min(Math.max(x, 0), 1);

function setU(m: THREE.ShaderMaterial, key: string, value: number | THREE.Color | THREE.Vector3): void {
  const u = m.uniforms[key];
  if (u) u.value = value;
}

/** Polyline with rounded corners as a curve, so the tube bends like a real pipe. */
function buildPath(points: readonly Vec3[], bend: number): THREE.CurvePath<THREE.Vector3> {
  const pts = points.map(v3);
  const at = (i: number): THREE.Vector3 => pts[i] as THREE.Vector3;
  const path = new THREE.CurvePath<THREE.Vector3>();
  if (pts.length === 2) {
    path.add(new THREE.LineCurve3(at(0), at(1)));
    return path;
  }
  let cursor = at(0).clone();
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = at(i - 1);
    const cur = at(i);
    const next = at(i + 1);
    const inDir = cur.clone().sub(prev);
    const outDir = next.clone().sub(cur);
    const inLen = inDir.length();
    const outLen = outDir.length();
    const r = Math.min(bend, inLen / 2, outLen / 2);
    const start = cur.clone().addScaledVector(inDir.normalize(), -r);
    const end = cur.clone().addScaledVector(outDir.normalize(), r);
    if (cursor.distanceTo(start) > 1e-6) path.add(new THREE.LineCurve3(cursor.clone(), start));
    path.add(new THREE.QuadraticBezierCurve3(start, cur.clone(), end));
    cursor = end;
  }
  path.add(new THREE.LineCurve3(cursor, at(pts.length - 1).clone()));
  return path;
}

function perpendicular(t: THREE.Vector3): { u: THREE.Vector3; w: THREE.Vector3 } {
  const ref = Math.abs(t.y) < 0.9 ? UP : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(t, ref).normalize();
  const w = new THREE.Vector3().crossVectors(t, u).normalize();
  return { u, w };
}

function softDot(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0.8)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface PipeVisual {
  id: string;
  from: string;
  to: string;
  length: number;
  material: THREE.ShaderMaterial;
  mesh: THREE.Mesh;
  phase: number;
  fill: number;
  fillDir: number;
}
interface TankVisual {
  id: string;
  base: number;
  body: THREE.Mesh;
  surface: THREE.Mesh;
  surfaceMaterial: THREE.ShaderMaterial;
}
interface HandVisual {
  id: string;
  kind: 'valve' | 'pump';
  wheel: THREE.Object3D;
  ring: THREE.Mesh | null;
}
interface NozzleVisual {
  id: string;
  origin: THREE.Vector3;
  area: number;
  points: THREE.Points;
  pos: Float32Array;
  vel: Float32Array;
  age: Float32Array;
  alive: Uint8Array;
  spawn: number;
}

const DROPS = 110;

export class PipeScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  timeScale: number;
  paused = false;
  onPickLink: ((id: string) => void) | undefined;

  private readonly net: PipeNetwork;
  private readonly theme: PipeTheme;
  private readonly refPressure: number;
  private readonly container: HTMLElement;
  private readonly pipes: PipeVisual[] = [];
  private readonly tanks: TankVisual[] = [];
  private readonly hands: HandVisual[] = [];
  private readonly nozzles: NozzleVisual[] = [];
  private readonly pickables: THREE.Object3D[] = [];
  private readonly dryIds: ReadonlySet<string>;
  private readonly resizeObserver: ResizeObserver;
  private readonly raycaster = new THREE.Raycaster();
  private readonly dot = softDot();
  private fitting: THREE.Matrix4[] = [];
  private bolts: THREE.Matrix4[] = [];
  private clockMs = performance.now();
  private elapsed = 0;
  private acc = 0;
  private downAt = { x: 0, y: 0, t: 0 };

  constructor(container: HTMLElement, net: PipeNetwork, options: PipeSceneOptions = {}) {
    this.container = container;
    this.net = net;
    this.theme = options.theme ?? MARS_LAB_THEME;
    this.timeScale = options.timeScale ?? 1;
    this.onPickLink = options.onPickLink;
    this.refPressure = options.referencePressure ?? 120000;
    this.dryIds = new Set(options.initiallyDry ?? []);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;';
    container.appendChild(this.renderer.domElement);

    const bg = new THREE.Color(this.theme.background);
    this.scene.background = bg;
    this.scene.fog = new THREE.Fog(bg, 22, 48);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new (RoomEnvironment as unknown as new () => THREE.Scene)();
    this.scene.environment = pmrem.fromScene(room, 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();

    const key = new THREE.DirectionalLight(this.theme.keyLight, 2.2);
    key.position.set(6, 10, 7);
    const rim = new THREE.DirectionalLight(this.theme.rimLight, 1.6);
    rim.position.set(-8, 5, -6);
    this.scene.add(key, rim, new THREE.HemisphereLight(this.theme.fillLight, this.theme.floor, 0.5));

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.05, 120);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.495;

    this.buildFloor();
    this.build();
    this.fitCamera();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointerup', this.onUp);
    this.renderer.setAnimationLoop(this.tick);
  }

  // ───────────── construction ─────────────

  private buildFloor(): void {
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(16, 72),
      new THREE.MeshStandardMaterial({ color: this.theme.floor, roughness: 0.96, metalness: 0 }),
    );
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);
    const grid = new THREE.GridHelper(32, 32, this.theme.floorGrid, this.theme.floorGrid);
    grid.position.y = 0.002;
    const gm = grid.material as THREE.LineBasicMaterial;
    gm.transparent = true;
    gm.opacity = 0.22;
    this.scene.add(grid);
  }

  private build(): void {
    const theme = this.theme;
    const net = this.net;
    const metal = new THREE.MeshStandardMaterial({ color: theme.metal, metalness: 0.85, roughness: 0.38 });
    const metalDark = new THREE.MeshStandardMaterial({ color: theme.metalDark, metalness: 0.7, roughness: 0.5 });
    const handle = new THREE.MeshStandardMaterial({ color: theme.handle, metalness: 0.2, roughness: 0.55 });
    const glassTint = new THREE.MeshStandardMaterial({
      color: theme.glass, metalness: 0, roughness: 0.1, transparent: true, opacity: 0.1, depthWrite: false,
    });
    const glassGlint = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0x606060).multiplyScalar(theme.glint / 0.6), metalness: 1, roughness: 0.08, envMapIntensity: 0.6,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });

    const radiusAt = new Map<string, number>();
    for (const l of net.linkDefs) {
      const r = (l.kind === 'pump' ? l.diameter ?? 0.05 : l.diameter) / 2;
      for (const id of [l.from, l.to]) radiusAt.set(id, Math.max(radiusAt.get(id) ?? 0, r));
    }

    // links
    for (const l of net.linkDefs) {
      const route = net.routeOf(l.id);
      const r = (l.kind === 'pump' ? l.diameter ?? 0.05 : l.diameter) / 2;
      const path = buildPath(route, Math.max(l.kind === 'pipe' ? l.diameter * 1.5 : 0.1, 0.06));
      const length = path.getLength();
      const segments = Math.min(Math.max(Math.ceil(length * 14), 12), 400);
      if (l.kind === 'pipe') {
        const shellGeo = new THREE.TubeGeometry(path, segments, r, 24, false);
        const shellA = new THREE.Mesh(shellGeo, glassTint);
        shellA.renderOrder = 3;
        const shellB = new THREE.Mesh(shellGeo, glassGlint);
        shellB.renderOrder = 4;
        const liquidMat = this.makeLiquidMaterial(length, r * 0.9);
        const liquid = new THREE.Mesh(new THREE.TubeGeometry(path, segments, r * 0.9, 20, false), liquidMat);
        liquid.renderOrder = 2;
        this.scene.add(shellA, shellB, liquid);
        const dry = this.dryIds.has(l.id);
        this.pipes.push({ id: l.id, from: l.from, to: l.to, length, material: liquidMat, mesh: liquid, phase: 0, fill: dry ? 0 : 1, fillDir: 1 });
        // flanges at both ends and a sleeve coupling about every 1.6 m
        this.addFlange(path.getPointAt(0), path.getTangentAt(0), r, 1);
        this.addFlange(path.getPointAt(1), path.getTangentAt(1), r, -1);
        const sleeves = Math.floor(length / 1.6);
        for (let i = 1; i <= sleeves; i++) {
          const t = i / (sleeves + 1);
          this.fitting.push(this.fittingMatrix(path.getPointAt(t), path.getTangentAt(t), r * 1.2, r * 0.9));
        }
      } else {
        // pumps and valves: solid metal body on a short stub, clickable
        const stub = new THREE.Mesh(new THREE.TubeGeometry(path, Math.max(segments, 4), r * 1.12, 20, false), metalDark);
        this.scene.add(stub);
        this.addFlange(path.getPointAt(0), path.getTangentAt(0), r, 1);
        this.addFlange(path.getPointAt(1), path.getTangentAt(1), r, -1);
        const mid = path.getPointAt(0.5);
        const tan = path.getTangentAt(0.5);
        if (l.kind === 'valve') this.addValve(l.id, mid, r, metal, handle);
        else this.addPump(l.id, mid, tan, r, metal, metalDark);
      }
    }

    // nodes
    const jointGeo = new THREE.SphereGeometry(1, 24, 16);
    for (const d of net.nodeDefs) {
      const anchor = v3(d.anchor ?? d.position);
      if (d.kind === 'tank') {
        this.addTank(d.id, v3(d.position), d.diameter, d.maxLevel + 0.15, metal);
      } else if (d.kind === 'reservoir' && d.visual) {
        this.addTank(d.id, v3(d.position), d.visual.diameter, d.visual.height, metal);
      } else {
        const rr = (radiusAt.get(d.id) ?? 0.02) * 1.32;
        const joint = new THREE.Mesh(jointGeo, metal);
        joint.position.copy(anchor);
        joint.scale.setScalar(rr);
        this.scene.add(joint);
        if (d.kind === 'junction' && (d.nozzleDiameter ?? 0) > 0) this.addNozzle(d.id, anchor, d.nozzleDiameter ?? 0.004, rr, metalDark);
      }
    }
    this.flushInstances(metal, metalDark);
  }

  private makeLiquidMaterial(length: number, radius: number): THREE.ShaderMaterial {
    const t = this.theme;
    return new THREE.ShaderMaterial({
      vertexShader: liquidVertex,
      fragmentShader: liquidFragment,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 }, uPhase: { value: 0 }, uCycle: { value: CYCLE }, uFill: { value: 1 }, uFillDir: { value: 1 },
        uTurb: { value: 0 }, uSpeed: { value: 0 }, uLength: { value: length }, uRadius: { value: radius },
        uPressure: { value: 0 }, uOpacity: { value: 0.92 },
        uColorDeep: { value: new THREE.Color(t.liquidDeep) },
        uColorLight: { value: new THREE.Color(t.liquidLight) },
        uColorGlow: { value: new THREE.Color(t.liquidGlow) },
      },
    });
  }

  private fittingMatrix(p: THREE.Vector3, tangent: THREE.Vector3, radius: number, thickness: number): THREE.Matrix4 {
    const q = new THREE.Quaternion().setFromUnitVectors(UP, tangent);
    return new THREE.Matrix4().compose(p, q, new THREE.Vector3(radius, thickness, radius));
  }

  private addFlange(p: THREE.Vector3, tangent: THREE.Vector3, r: number, side: 1 | -1): void {
    this.fitting.push(this.fittingMatrix(p, tangent, r * 1.6, r * 0.22));
    this.fitting.push(this.fittingMatrix(p.clone().addScaledVector(tangent, side * r * 0.55), tangent, r * 1.18, r * 0.8));
    const { u, w } = perpendicular(tangent);
    const q = new THREE.Quaternion().setFromUnitVectors(UP, tangent);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      const off = u.clone().multiplyScalar(Math.cos(a)).addScaledVector(w, Math.sin(a)).multiplyScalar(r * 1.28);
      this.bolts.push(new THREE.Matrix4().compose(p.clone().add(off), q, new THREE.Vector3(r * 0.13, r * 0.42, r * 0.13)));
    }
  }

  private flushInstances(metal: THREE.Material, metalDark: THREE.Material): void {
    const unit = new THREE.CylinderGeometry(1, 1, 1, 28);
    if (this.fitting.length > 0) {
      const mesh = new THREE.InstancedMesh(unit, metal, this.fitting.length);
      this.fitting.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.instanceMatrix.needsUpdate = true;
      this.scene.add(mesh);
    }
    if (this.bolts.length > 0) {
      const mesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 6), metalDark, this.bolts.length);
      this.bolts.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.instanceMatrix.needsUpdate = true;
      this.scene.add(mesh);
    }
    this.fitting = [];
    this.bolts = [];
  }

  private addValve(id: string, p: THREE.Vector3, r: number, metal: THREE.Material, handle: THREE.Material): void {
    const g = new THREE.Group();
    g.position.copy(p);
    const body = new THREE.Mesh(new THREE.SphereGeometry(r * 1.9, 24, 16), metal);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.28, r * 0.28, r * 2.6, 12), metal);
    stem.position.y = r * 2.4;
    const wheel = new THREE.Group();
    wheel.position.y = r * 3.7;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(r * 1.7, r * 0.2, 10, 28), handle);
    rim.rotation.x = Math.PI / 2;
    wheel.add(rim);
    for (let k = 0; k < 3; k++) {
      const spoke = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.1, r * 0.1, r * 3.4, 8), handle);
      spoke.rotation.z = Math.PI / 2;
      spoke.rotation.y = (k / 3) * Math.PI;
      wheel.add(spoke);
    }
    const hit = new THREE.Mesh(new THREE.SphereGeometry(r * 4, 12, 8), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.y = r * 2.4;
    hit.userData['linkId'] = id;
    g.add(body, stem, wheel, hit);
    this.scene.add(g);
    this.pickables.push(hit);
    this.hands.push({ id, kind: 'valve', wheel, ring: null });
  }

  private addPump(id: string, p: THREE.Vector3, tangent: THREE.Vector3, r: number, metal: THREE.Material, dark: THREE.Material): void {
    const g = new THREE.Group();
    g.position.copy(p);
    const volute = new THREE.Mesh(new THREE.SphereGeometry(r * 2.3, 28, 18), metal);
    const motor = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.7, r * 1.7, r * 5.2, 28), dark);
    motor.position.y = r * 4.6;
    const ringMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: new THREE.Color(this.theme.liquidGlow), emissiveIntensity: 0 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 1.74, r * 0.12, 8, 36), ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = r * 6.0;
    const hit = new THREE.Mesh(new THREE.SphereGeometry(r * 5, 12, 8), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.y = r * 3;
    hit.userData['linkId'] = id;
    g.add(volute, motor, ring, hit);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), new THREE.Vector3(tangent.x, 0, tangent.z).normalize());
    this.scene.add(g);
    this.pickables.push(hit);
    this.hands.push({ id, kind: 'pump', wheel: motor, ring });
  }

  private addTank(id: string, base: THREE.Vector3, diameter: number, height: number, metal: THREE.Material): void {
    const R = diameter / 2;
    const t = this.theme;
    const wall = new THREE.CylinderGeometry(R, R, height, 56, 1, true);
    const tint = new THREE.Mesh(wall, new THREE.MeshStandardMaterial({
      color: t.glass, roughness: 0.1, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide,
    }));
    tint.position.set(base.x, base.y + height / 2, base.z);
    tint.renderOrder = 3;
    const glint = new THREE.Mesh(wall, new THREE.MeshStandardMaterial({
      color: new THREE.Color(0x606060).multiplyScalar(t.glint / 0.6), metalness: 1, roughness: 0.08, envMapIntensity: 0.6,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    glint.position.copy(tint.position);
    glint.renderOrder = 4;
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.08, R * 1.1, 0.1, 56), metal);
    plate.position.set(base.x, base.y - 0.05, base.z);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(R, Math.max(R * 0.025, 0.012), 8, 64), metal);
    rim.rotation.x = Math.PI / 2;
    rim.position.set(base.x, base.y + height, base.z);

    const bodyGeo = new THREE.CylinderGeometry(R * 0.985, R * 0.985, 1, 56, 1, false);
    bodyGeo.translate(0, 0.5, 0);
    const body = new THREE.Mesh(bodyGeo, new THREE.MeshStandardMaterial({
      color: t.liquidDeep, emissive: new THREE.Color(t.liquidDeep), emissiveIntensity: 0.3, roughness: 0.2,
      transparent: true, opacity: 0.6, depthWrite: false,
    }));
    body.position.copy(base);
    body.renderOrder = 2;

    const surfaceMaterial = new THREE.ShaderMaterial({
      vertexShader: surfaceVertex,
      fragmentShader: surfaceFragment,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 }, uAmp: { value: 0 }, uCenter: { value: new THREE.Vector3(base.x, base.y, base.z) },
        uColorDeep: { value: new THREE.Color(t.liquidDeep) }, uColorLight: { value: new THREE.Color(t.liquidLight) },
        uSkyLow: { value: new THREE.Color(t.skyLow) }, uSkyHigh: { value: new THREE.Color(t.skyHigh) },
        uLightDir: { value: new THREE.Vector3(6, 10, 7).normalize() }, uLightColor: { value: new THREE.Color(t.keyLight) },
      },
    });
    const surface = new THREE.Mesh(new THREE.CircleGeometry(R * 0.985, 56), surfaceMaterial);
    surface.rotation.x = -Math.PI / 2;
    surface.position.copy(base);
    surface.renderOrder = 2;
    this.scene.add(tint, glint, plate, rim, body, surface);
    this.tanks.push({ id, base: base.y, body, surface, surfaceMaterial });
  }

  private addNozzle(id: string, anchor: THREE.Vector3, diameter: number, jointRadius: number, dark: THREE.Material): void {
    const cone = new THREE.Mesh(new THREE.CylinderGeometry(jointRadius * 0.45, jointRadius * 0.9, jointRadius * 1.6, 16), dark);
    cone.position.set(anchor.x, anchor.y - jointRadius * 1.2, anchor.z);
    this.scene.add(cone);
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(DROPS * 3).fill(-1e4);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const points = new THREE.Points(geo, new THREE.PointsMaterial({
      color: this.theme.liquidLight, size: 0.045, sizeAttenuation: true, map: this.dot, transparent: true, opacity: 0.85, depthWrite: false,
    }));
    points.frustumCulled = false;
    this.scene.add(points);
    this.nozzles.push({
      id,
      origin: new THREE.Vector3(anchor.x, anchor.y - jointRadius * 2, anchor.z),
      area: (Math.PI * diameter * diameter) / 4,
      points, pos, vel: new Float32Array(DROPS * 3), age: new Float32Array(DROPS), alive: new Uint8Array(DROPS), spawn: 0,
    });
  }

  fitCamera(): void {
    const box = new THREE.Box3();
    for (const l of this.net.linkDefs) for (const p of this.net.routeOf(l.id)) box.expandByPoint(v3(p));
    for (const n of this.net.nodeDefs) {
      box.expandByPoint(v3(n.position));
      if (n.kind === 'tank') box.expandByPoint(new THREE.Vector3(n.position[0], n.position[1] + n.maxLevel, n.position[2]));
      if (n.kind === 'reservoir' && n.visual) box.expandByPoint(new THREE.Vector3(n.position[0], n.position[1] + n.visual.height, n.position[2]));
    }
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    this.controls.target.copy(center);
    this.camera.position.set(center.x + size * 0.55, center.y + size * 0.42, center.z + size * 0.75);
    this.controls.minDistance = size * 0.15;
    this.controls.maxDistance = size * 2.2;
    this.controls.update();
  }

  // ───────────── frame loop ─────────────

  private readonly tick = (): void => {
    const now = performance.now();
    const dt = Math.min((now - this.clockMs) / 1000, 0.1);
    this.clockMs = now;
    this.elapsed += dt;
    if (!this.paused) {
      this.acc += dt;
      let n = 0;
      while (this.acc >= TICK && n < 4) {
        this.net.step(TICK * this.timeScale);
        this.acc -= TICK;
        n++;
      }
      if (this.acc > TICK) this.acc = 0;
    }
    this.sync(this.paused ? 0 : dt);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  private sync(dt: number): void {
    const net = this.net;
    const g = net.env.gravity;

    for (const pv of this.pipes) {
      const st = net.linkStates.get(pv.id);
      if (!st) continue;
      const a = net.nodeStates.get(pv.from);
      const b = net.nodeStates.get(pv.to);
      const v = st.velocity;
      pv.phase += (v * dt) / CYCLE;
      pv.phase -= Math.floor(pv.phase);
      if (pv.fill < 1 && Math.abs(v) > 0.01) {
        pv.fillDir = v > 0 ? 1 : -1;
        pv.fill = Math.min(1, pv.fill + (Math.abs(v) * dt) / pv.length);
      }
      const m = pv.material;
      setU(m, 'uTime', this.elapsed);
      setU(m, 'uPhase', pv.phase);
      setU(m, 'uSpeed', Math.abs(v));
      setU(m, 'uTurb', clamp01((st.reynolds - 2300) / 1700));
      setU(m, 'uFill', pv.fill);
      setU(m, 'uFillDir', pv.fillDir);
      setU(m, 'uPressure', clamp01((((a?.pressure ?? 0) + (b?.pressure ?? 0)) / 2) / this.refPressure));
      pv.mesh.visible = pv.fill > 0.002;
    }

    for (const tv of this.tanks) {
      const st = net.nodeStates.get(tv.id);
      if (!st) continue;
      const level = Math.max(st.level, 0);
      tv.body.scale.y = Math.max(level, 1e-4);
      tv.body.visible = level > 0.003;
      tv.surface.visible = level > 0.003;
      tv.surface.position.y = tv.base + level;
      let inflow = 0;
      for (const l of net.linkDefs) {
        const ls = net.linkStates.get(l.id);
        if (!ls) continue;
        if (l.to === tv.id) inflow += ls.flow;
        else if (l.from === tv.id) inflow -= ls.flow;
      }
      setU(tv.surfaceMaterial, 'uTime', this.elapsed);
      setU(tv.surfaceMaterial, 'uAmp', clamp01(Math.abs(inflow) / 2e-3));
    }

    for (const h of this.hands) {
      const st = net.linkStates.get(h.id);
      if (!st) continue;
      if (h.kind === 'valve') h.wheel.rotation.y = st.setting * Math.PI * 4;
      else if (h.ring) (h.ring.material as THREE.MeshStandardMaterial).emissiveIntensity = st.closed ? 0 : 0.6 + 1.6 * clamp01(st.setting * (st.flow > 0 ? 1 : 0.2));
    }

    for (const nz of this.nozzles) this.updateNozzle(nz, dt, g);
  }

  private updateNozzle(nz: NozzleVisual, dt: number, g: number): void {
    const flow = Math.max(this.net.nodeStates.get(nz.id)?.outflow ?? 0, 0);
    const dropVolume = Math.max(5e-8, flow / 90);
    nz.spawn += Math.min(flow / dropVolume, 90) * dt;
    const v0 = Math.min(flow / nz.area, 2);
    while (nz.spawn >= 1) {
      nz.spawn -= 1;
      let slot = -1;
      for (let i = 0; i < DROPS; i++) if (!nz.alive[i]) { slot = i; break; }
      if (slot < 0) break;
      nz.alive[slot] = 1;
      nz.age[slot] = 0;
      nz.vel[slot * 3] = (Math.random() - 0.5) * 0.3;
      nz.vel[slot * 3 + 1] = -v0;
      nz.vel[slot * 3 + 2] = (Math.random() - 0.5) * 0.3;
      nz.pos[slot * 3] = nz.origin.x;
      nz.pos[slot * 3 + 1] = nz.origin.y;
      nz.pos[slot * 3 + 2] = nz.origin.z;
    }
    for (let i = 0; i < DROPS; i++) {
      if (!nz.alive[i]) { nz.pos[i * 3 + 1] = -1e4; continue; }
      const t = (nz.age[i] as number) + dt;
      nz.age[i] = t;
      nz.vel[i * 3 + 1] = (nz.vel[i * 3 + 1] as number) - g * dt;
      nz.pos[i * 3] = (nz.pos[i * 3] as number) + (nz.vel[i * 3] as number) * dt;
      nz.pos[i * 3 + 1] = (nz.pos[i * 3 + 1] as number) + (nz.vel[i * 3 + 1] as number) * dt;
      nz.pos[i * 3 + 2] = (nz.pos[i * 3 + 2] as number) + (nz.vel[i * 3 + 2] as number) * dt;
      if ((nz.pos[i * 3 + 1] as number) < 0.01) { nz.alive[i] = 0; nz.pos[i * 3 + 1] = -1e4; }
    }
    const attr = nz.points.geometry.getAttribute('position');
    attr.needsUpdate = true;
  }

  // ───────────── input, sizing, teardown ─────────────

  private readonly onDown = (e: PointerEvent): void => {
    this.downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
  };

  private readonly onUp = (e: PointerEvent): void => {
    const moved = Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y);
    if (moved > 6 || performance.now() - this.downAt.t > 450 || !this.onPickLink) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObjects(this.pickables, false)[0];
    const id = hit?.object.userData['linkId'];
    if (typeof id === 'string') this.onPickLink(id);
  };

  private resize(): void {
    const w = Math.max(this.container.clientWidth, 1);
    const h = Math.max(this.container.clientHeight, 1);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    const el = this.renderer.domElement;
    el.removeEventListener('pointerdown', this.onDown);
    el.removeEventListener('pointerup', this.onUp);
    this.controls.dispose();
    const materials = new Set<THREE.Material>();
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const m = mesh.material;
      if (Array.isArray(m)) m.forEach((x) => materials.add(x));
      else if (m) materials.add(m);
    });
    materials.forEach((m) => m.dispose());
    this.dot.dispose();
    this.scene.environment?.dispose();
    this.renderer.dispose();
    el.remove();
  }
}
