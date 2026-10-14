// Floodgrid art layer (docs/14a): owner-generated pipe sprites and depth backdrops from Leo88q/1.
// Pure presentation: the board engine, attempts and economy numbers are untouched — this module only
// maps a level/depth to art files and computes view-state (canonical rotation, flow wave distance).
//
// Mask contract is identical on both sides (N=1, E=2, S=4, W=8). Sprites are drawn in one canonical
// position per shape (Leo88q/1 `web.json`: stub=1, straight=5, elbow=3, tee=7, cross=15) and rotated
// in CSS by the same quarter-steps the engine applies to the mask — so one file serves all 0–3 turns.
import { useEffect, useState } from 'react';
import { GRID_DEPTHS, deltaForBit, depthOfLevel, kindOf, rotationToReach, tileMask, type Level, type TileKind } from '@guttercaps/economy';

/** Tile-material of each depth, mirroring GRID_DEPTHS.material (file names in client/public/art/grid/). */
export type GridTileSet = 'zinc' | 'chrome' | 'rust' | 'cast' | 'glass';

/** Каноническая маска, в которой нарисован спрайт формы (контракт исходника, docs/14a §1). */
const CANON_MASK: Record<TileKind, number> = { cap: 1, straight: 5, elbow: 3, tee: 7, cross: 15 };
/** Порядок спрайтов в полосе атласа — собирает scripts/floodgrid-art-build.py (ATLAS_ORDER). */
const SHAPE_INDEX: Record<TileKind, number> = { cap: 0, straight: 1, elbow: 2, tee: 3, cross: 4 };
/** Число спрайтов в атласе (для background-size: N×100%). */
export const ATLAS_SPRITES = 5;

/** Material set for the depth a level belongs to (contract/deep/ghost/prestige attempts carry level 1–75 too). */
export function gridMaterialForLevel(level: number): GridTileSet {
  const depth = GRID_DEPTHS[depthOfLevel(level) - 1];
  return depth.material as GridTileSet;
}

export const gridAtlasUrl = (set: GridTileSet): string => `/art/grid/tiles-${set}.webp`;
export const gridBoardBgUrl = (depth: number): string => `/art/grid/bg-depth-${depth}.webp`;
export const gridStripBgUrl = (depth: number): string => `/art/grid/strip-depth-${depth}.webp`;

export function shapeIndexOf(mask: number): number {
  return SHAPE_INDEX[kindOf(mask)];
}

/**
 * Поворот спрайта (в четвертях, по часовой), который выставляет канонический рисунок на текущую маску.
 * Понятие «куда смотрит тайл» — маска движка; эта функция говорит, как довернуть картинку.
 */
export function canonicalRotOf(mask: number): number {
  return rotationToReach(CANON_MASK[kindOf(mask)], mask);
}

/** Противоположный бит порта (для обхода соединений). */
const OPPOSITE: Record<number, number> = { 1: 4, 4: 1, 2: 8, 8: 2 };

/**
 * BFS-расстояние от шины до каждой ячейки по открытым портам текущих масок (−1 — недостижимо).
 * Используется только для анимации потока (задержка волны), на логику не влияет.
 */
export function flowDistance(level: Level): number[] {
  const { size, bus } = level;
  const dist = new Array<number>(size * size).fill(-1);
  if (bus < 0 || bus >= dist.length) return dist;
  dist[bus] = 0;
  const queue: number[] = [bus];
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    const mask = tileMask(level, i);
    const x = i % size;
    const y = Math.floor(i / size);
    for (const bit of [1, 2, 4, 8]) {
      if (!(mask & bit)) continue;
      const [dx, dy] = deltaForBit(bit);
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const j = ny * size + nx;
      if (dist[j] !== -1) continue;
      if (!(tileMask(level, j) & OPPOSITE[bit])) continue;
      dist[j] = dist[i] + 1;
      queue.push(j);
    }
  }
  return dist;
}

// ---- загрузка атласа: lazy по глубине + статус для SVG-фолбэка -----------------------------

export type AtlasStatus = 'loading' | 'ok' | 'error';
const atlasStatus = new Map<GridTileSet, AtlasStatus>();
const atlasListeners = new Set<() => void>();

function notifyAtlas() {
  atlasListeners.forEach((fn) => fn());
}

/** Загружает атлас материала (один раз на набор) и отмечает результат — по нему решается фолбэк. */
function ensureAtlas(set: GridTileSet): AtlasStatus {
  const cached = atlasStatus.get(set);
  if (cached) return cached;
  atlasStatus.set(set, 'loading');
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => { atlasStatus.set(set, 'ok'); notifyAtlas(); };
  img.onerror = () => { atlasStatus.set(set, 'error'); notifyAtlas(); };
  img.src = gridAtlasUrl(set);
  return 'loading';
}

/** Статус атласа для React (подписка на ручной кэш). */
export function useAtlasStatus(set: GridTileSet): AtlasStatus {
  const [, bump] = useState(0);
  useEffect(() => {
    const fn = () => bump((n) => n + 1);
    atlasListeners.add(fn);
    ensureAtlas(set);
    return () => { atlasListeners.delete(fn); };
  }, [set]);
  return atlasStatus.get(set) ?? ensureAtlas(set);
}

/**
 * Прогрев арта глубины, следующей за сыгранной (next level per route) — только когда браузер
 * свободен, чтобы не мешать первому рендеру доски; c save-data не греем вовсе.
 */
export function prefetchDepthForLevel(level: number): void {
  if (level < 1 || level > 75) return;
  const nav = navigator as Navigator & { connection?: { saveData?: boolean } };
  if (nav.connection?.saveData) return;
  const depth = depthOfLevel(level);
  const run = () => {
    const img = new Image();
    img.decoding = 'async';
    img.src = gridAtlasUrl(gridMaterialForLevel(level));
    img.onload = () => { atlasStatus.set(gridMaterialForLevel(level), 'ok'); notifyAtlas(); };
    img.onerror = () => { atlasStatus.set(gridMaterialForLevel(level), 'error'); notifyAtlas(); };
    const bg = new Image();
    bg.src = gridBoardBgUrl(depth);
  };
  const ric = (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(run, { timeout: 4000 });
  else window.setTimeout(run, 1200);
}
