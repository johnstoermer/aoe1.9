// Deterministic map generation. Given (seed, size, playerCount) every client
// produces the identical map: player starts on a circle, berries/gold/stone
// near each town center, forest blobs, an enclosing tree ring, and guaranteed
// ground connectivity between all town centers.

import { Prng } from './prng';
import type { ResourceNodeTypeId } from './types';

export interface MapNode {
  type: ResourceNodeTypeId;
  tx: number;
  ty: number;
}

export interface GameMap {
  size: number;
  /** Player town-center top-left tiles, indexed by player. */
  spawns: { tx: number; ty: number }[];
  nodes: MapNode[];
  /** Visual-only terrain variation per tile: 0 grass, 1 light grass, 2 dirt, 3 dark grass. */
  terrain: Uint8Array;
}

// 32-slot integer sine table, scaled by 4096. sin(k * 360/32 deg).
// Hardcoded because Math.sin is not guaranteed bit-identical across engines.
const SIN32 = [
  0, 799, 1567, 2276, 2896, 3406, 3784, 4017,
  4096, 4017, 3784, 3406, 2896, 2276, 1567, 799,
  0, -799, -1567, -2276, -2896, -3406, -3784, -4017,
  -4096, -4017, -3784, -3406, -2896, -2276, -1567, -799,
];
export const dirSin = (k: number): number => SIN32[((k % 32) + 32) % 32];
export const dirCos = (k: number): number => SIN32[((k + 8) % 32 + 32) % 32];

const TC_W = 3;

export function generateMap(seed: number, size: number, playerCount: number): GameMap {
  const rng = new Prng(seed);
  const idx = (x: number, y: number) => y * size + x;
  const inBounds = (x: number, y: number) => x >= 0 && y >= 0 && x < size && y < size;

  // occupancy while generating: 1 = reserved (node/building), used to avoid overlap
  const occ = new Uint8Array(size * size);
  const nodes: MapNode[] = [];
  const terrain = new Uint8Array(size * size);

  const reserve = (x: number, y: number, w: number, h: number) => {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (inBounds(i, j)) occ[idx(i, j)] = 1;
  };
  const areaFree = (x: number, y: number, w: number, h: number): boolean => {
    if (x < 1 || y < 1 || x + w > size - 1 || y + h > size - 1) return false;
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (occ[idx(i, j)]) return false;
    return true;
  };
  const addNode = (type: ResourceNodeTypeId, x: number, y: number): boolean => {
    if (!areaFree(x, y, 1, 1)) return false;
    nodes.push({ type, tx: x, ty: y });
    reserve(x, y, 1, 1);
    return true;
  };

  // --- player spawns on a circle -------------------------------------------
  const c = size >> 1;
  const spawnRadius = Math.floor(size * 0.34);
  const angleOffset = rng.int(32);
  const spawns: { tx: number; ty: number }[] = [];
  for (let p = 0; p < playerCount; p++) {
    const k = angleOffset + Math.floor((32 * p) / playerCount);
    const cx = c + ((spawnRadius * dirCos(k)) >> 12);
    const cy = c + ((spawnRadius * dirSin(k)) >> 12);
    const tx = cx - (TC_W >> 1);
    const ty = cy - (TC_W >> 1);
    spawns.push({ tx, ty });
    // reserve TC footprint plus breathing room for the starting villagers
    reserve(tx - 1, ty - 1, TC_W + 2, TC_W + 2);
  }

  // --- per-player starting resources ---------------------------------------
  const placeCluster = (
    type: ResourceNodeTypeId, count: number,
    originX: number, originY: number, minDist: number, maxDist: number,
  ): { x: number; y: number } => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const k = rng.int(32);
      const d = rng.range(minDist, maxDist);
      const bx = originX + ((d * dirCos(k)) >> 12);
      const by = originY + ((d * dirSin(k)) >> 12);
      if (!inBounds(bx, by) || bx < 2 || by < 2 || bx > size - 3 || by > size - 3) continue;
      if (occ[idx(bx, by)]) continue;
      // grow the cluster as a compact blob around (bx, by)
      let placed = 0;
      addNode(type, bx, by) && placed++;
      let guard = 0;
      while (placed < count && guard++ < 60) {
        const nx = bx + rng.range(-2, 2);
        const ny = by + rng.range(-2, 2);
        if (inBounds(nx, ny) && addNode(type, nx, ny)) placed++;
      }
      if (placed > 0) return { x: bx, y: by };
    }
    return { x: originX, y: originY };
  };

  for (let p = 0; p < playerCount; p++) {
    const { tx, ty } = spawns[p];
    const cx = tx + 1, cy = ty + 1;
    placeCluster('berries', 6, cx, cy, 5, 7);
    placeCluster('gold', 5, cx, cy, 8, 11);
    placeCluster('stone', 4, cx, cy, 8, 11);
    // two starting woodlines
    placeCluster('tree', rng.range(9, 12), cx, cy, 6, 10);
    placeCluster('tree', rng.range(9, 12), cx, cy, 7, 12);
    // scattered stragglers for early wood without walking far
    for (let i = 0; i < 8; i++) {
      const k = rng.int(32);
      const d = rng.range(4, 12);
      addNode('tree', cx + ((d * dirCos(k)) >> 12), cy + ((d * dirSin(k)) >> 12));
    }
  }

  // --- neutral middle resources --------------------------------------------
  placeCluster('gold', 6, c, c, 2, 6);
  placeCluster('stone', 5, c, c, 4, 9);
  for (let i = 0; i < playerCount; i++) {
    placeCluster('gold', 4, c, c, Math.floor(size * 0.18), Math.floor(size * 0.28));
  }

  // --- forests ---------------------------------------------------------------
  const blobs = Math.floor((size * size) / 260);
  for (let b = 0; b < blobs; b++) {
    const bx = rng.range(2, size - 3);
    const by = rng.range(2, size - 3);
    // keep clearings around town centers
    let nearSpawn = false;
    for (const s of spawns) {
      const dx = bx - (s.tx + 1), dy = by - (s.ty + 1);
      if (dx * dx + dy * dy < 36) { nearSpawn = true; break; }
    }
    if (nearSpawn) continue;
    const r = rng.range(1, 3);
    for (let j = -r; j <= r; j++) {
      for (let i = -r; i <= r; i++) {
        if (i * i + j * j > r * r + rng.int(2)) continue;
        addNode('tree', bx + i, by + j);
      }
    }
  }
  // enclosing forest ring, Black-Forest style
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const edge = Math.min(x, y, size - 1 - x, size - 1 - y);
      if (edge === 0 || (edge === 1 && rng.int(10) < 8) || (edge === 2 && rng.int(10) < 4)) {
        addNode('tree', x, y);
      }
    }
  }

  // --- visual terrain variation ---------------------------------------------
  for (let i = 0; i < terrain.length; i++) {
    const r = rng.int(100);
    terrain[i] = r < 62 ? 0 : r < 82 ? 1 : r < 90 ? 2 : 3;
  }
  // dirt plazas under town centers
  for (const s of spawns) {
    for (let j = -2; j <= TC_W + 1; j++) {
      for (let i = -2; i <= TC_W + 1; i++) {
        const x = s.tx + i, y = s.ty + j;
        if (inBounds(x, y) && rng.int(10) < 7) terrain[idx(x, y)] = 2;
      }
    }
  }

  carveConnectivity(size, occ, nodes, spawns);
  return { size, spawns, nodes, terrain };
}

/**
 * Ensure every town center can reach every other one on foot; if a forest
 * wall separates them, fell trees along a straight line. (`occ` marks
 * reserved tiles; trees are the only removable blockers.)
 */
function carveConnectivity(
  size: number, occ: Uint8Array, nodes: MapNode[], spawns: { tx: number; ty: number }[],
) {
  const idx = (x: number, y: number) => y * size + x;
  const blocked = new Uint8Array(size * size);
  const nodeAt = new Map<number, number>(); // tileIdx -> nodes[] index
  nodes.forEach((n, i) => {
    blocked[idx(n.tx, n.ty)] = 1;
    nodeAt.set(idx(n.tx, n.ty), i);
  });
  for (const s of spawns) {
    for (let j = 0; j < TC_W; j++) for (let i = 0; i < TC_W; i++) blocked[idx(s.tx + i, s.ty + j)] = 1;
  }

  const reach = (fx: number, fy: number, tx: number, ty: number): boolean => {
    const seen = new Uint8Array(size * size);
    const q = [idx(fx, fy)];
    seen[q[0]] = 1;
    while (q.length) {
      const cur = q.pop()!;
      const cx = cur % size, cy = (cur / size) | 0;
      if (Math.abs(cx - tx) <= 2 && Math.abs(cy - ty) <= 2) return true;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const ni = idx(nx, ny);
        if (!seen[ni] && !blocked[ni]) { seen[ni] = 1; q.push(ni); }
      }
    }
    return false;
  };

  const doorstep = (s: { tx: number; ty: number }) => ({ x: s.tx + 1, y: s.ty + TC_W }); // south of TC

  for (let a = 1; a < spawns.length; a++) {
    const from = doorstep(spawns[0]);
    const to = doorstep(spawns[a]);
    if (reach(from.x, from.y, to.x, to.y)) continue;
    // carve a 2-wide Bresenham corridor, removing trees only
    let x0 = from.x, y0 = from.y;
    const dx = Math.abs(to.x - x0), dy = Math.abs(to.y - y0);
    const sx = x0 < to.x ? 1 : -1, sy = y0 < to.y ? 1 : -1;
    let err = dx - dy;
    for (let guard = 0; guard < size * 4; guard++) {
      for (const [ox, oy] of [[0, 0], [1, 0], [0, 1]] as const) {
        const cx = x0 + ox, cy = y0 + oy;
        if (cx < 0 || cy < 0 || cx >= size || cy >= size) continue;
        const ni = nodeAt.get(idx(cx, cy));
        if (ni !== undefined && nodes[ni].type === 'tree') {
          blocked[idx(cx, cy)] = 0;
          nodes[ni] = nodes[nodes.length - 1];
          nodeAt.set(idx(nodes[ni].tx, nodes[ni].ty), ni);
          nodes.pop();
          nodeAt.delete(idx(cx, cy));
        }
      }
      if (x0 === to.x && y0 === to.y) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  }
}
