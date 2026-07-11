// Grid pathfinding: 8-directional A* over the static blocker grid with a
// binary heap, deterministic tie-breaking, corner-cut prevention, multi-goal
// "reach any tile adjacent to this footprint" searches, and line-of-sight
// waypoint smoothing. All coordinates are tiles; returned waypoints are
// fixed-point world positions at tile centers.

import { FP, FP_BITS } from './fixed';

const STRAIGHT = 256;
const DIAGONAL = 362; // ~sqrt(2) * 256

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];

export class Grid {
  readonly size: number;
  readonly blocked: Uint8Array;

  constructor(size: number) {
    this.size = size;
    this.blocked = new Uint8Array(size * size);
  }

  idx(x: number, y: number): number {
    return y * this.size + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.size && y < this.size;
  }

  isBlocked(x: number, y: number): boolean {
    return !this.inBounds(x, y) || this.blocked[y * this.size + x] !== 0;
  }

  setRect(x: number, y: number, w: number, h: number, v: number) {
    for (let j = y; j < y + h; j++) {
      for (let i = x; i < x + w; i++) {
        if (this.inBounds(i, j)) this.blocked[this.idx(i, j)] = v;
      }
    }
  }

  rectFree(x: number, y: number, w: number, h: number): boolean {
    if (x < 0 || y < 0 || x + w > this.size || y + h > this.size) return false;
    for (let j = y; j < y + h; j++) {
      for (let i = x; i < x + w; i++) {
        if (this.blocked[this.idx(i, j)]) return false;
      }
    }
    return true;
  }

  /** Nearest unblocked tile to (x, y), searching outward ring by ring. */
  nearestFree(x: number, y: number, maxR = 12): { x: number; y: number } | null {
    if (!this.isBlocked(x, y)) return { x, y };
    for (let r = 1; r <= maxR; r++) {
      for (let j = -r; j <= r; j++) {
        for (let i = -r; i <= r; i++) {
          if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
          if (!this.isBlocked(x + i, y + j)) return { x: x + i, y: y + j };
        }
      }
    }
    return null;
  }
}

// --- binary heap keyed by (f, then higher g, then insertion order) ----------

class Heap {
  private f: number[] = [];
  private g: number[] = [];
  private seq: number[] = [];
  private node: number[] = [];
  private n = 0;
  private counter = 0;

  get size(): number {
    return this.n;
  }

  private less(a: number, b: number): boolean {
    if (this.f[a] !== this.f[b]) return this.f[a] < this.f[b];
    if (this.g[a] !== this.g[b]) return this.g[a] > this.g[b]; // deeper first
    return this.seq[a] < this.seq[b];
  }

  push(node: number, f: number, g: number) {
    let i = this.n++;
    this.f[i] = f; this.g[i] = g; this.seq[i] = this.counter++; this.node[i] = node;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): number {
    const top = this.node[0];
    this.n--;
    if (this.n > 0) {
      this.swap(0, this.n);
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.n && this.less(l, m)) m = l;
        if (r < this.n && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number) {
    let t = this.f[a]; this.f[a] = this.f[b]; this.f[b] = t;
    t = this.g[a]; this.g[a] = this.g[b]; this.g[b] = t;
    t = this.seq[a]; this.seq[a] = this.seq[b]; this.seq[b] = t;
    t = this.node[a]; this.node[a] = this.node[b]; this.node[b] = t;
  }
}

const MAX_EXPANSIONS = 6000;

export interface PathTarget {
  /** Footprint rect (in tiles). A 0x0 rect at a point means "reach that tile". */
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A* from start tile to any tile adjacent to (or inside, if walkable) the
 * target rect. Returns waypoints as fixed-point positions (tile centers),
 * smoothed by line of sight, ordered start -> goal. Returns null if
 * unreachable; on expansion blowout returns a best-effort path toward the
 * closest approach.
 */
export function findPath(
  grid: Grid, sx: number, sy: number, target: PathTarget,
): number[] | null {
  const size = grid.size;
  const rx0 = target.x, ry0 = target.y;
  const rx1 = target.x + Math.max(target.w, 1) - 1;
  const ry1 = target.y + Math.max(target.h, 1) - 1;

  const isGoal = (x: number, y: number): boolean =>
    x >= rx0 - 1 && x <= rx1 + 1 && y >= ry0 - 1 && y <= ry1 + 1;

  const cx = (rx0 + rx1) >> 1, cy = (ry0 + ry1) >> 1;
  const hDist = (x: number, y: number): number => {
    const dx = Math.abs(x - cx), dy = Math.abs(y - cy);
    return dx > dy ? STRAIGHT * dx + (DIAGONAL - STRAIGHT) * dy : STRAIGHT * dy + (DIAGONAL - STRAIGHT) * dx;
  };

  if (isGoal(sx, sy)) return [];

  const gScore = new Int32Array(size * size).fill(-1);
  const cameFrom = new Int32Array(size * size).fill(-1);
  const heap = new Heap();
  const startIdx = grid.idx(sx, sy);
  gScore[startIdx] = 0;
  heap.push(startIdx, hDist(sx, sy), 0);

  let best = startIdx;
  let bestH = hDist(sx, sy);
  let expansions = 0;
  let goalIdx = -1;

  while (heap.size > 0) {
    const cur = heap.pop();
    const x = cur % size, y = (cur / size) | 0;
    if (isGoal(x, y)) { goalIdx = cur; break; }
    if (++expansions > MAX_EXPANSIONS) break;

    const g = gScore[cur];
    for (let d = 0; d < 8; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (grid.isBlocked(nx, ny)) continue;
      if (d >= 4 && (grid.isBlocked(x + DX[d], y) || grid.isBlocked(x, y + DY[d]))) continue; // no corner cutting
      const ni = ny * size + nx;
      const ng = g + (d >= 4 ? DIAGONAL : STRAIGHT);
      if (gScore[ni] === -1 || ng < gScore[ni]) {
        gScore[ni] = ng;
        cameFrom[ni] = cur;
        const h = hDist(nx, ny);
        heap.push(ni, ng + h, ng);
        if (h < bestH) { bestH = h; best = ni; }
      }
    }
  }

  const end = goalIdx >= 0 ? goalIdx : best;
  if (end === startIdx) return goalIdx >= 0 ? [] : null;

  // reconstruct tile chain start -> end
  const tiles: number[] = [];
  for (let cur = end; cur !== -1; cur = cameFrom[cur]) tiles.push(cur);
  tiles.reverse();

  // line-of-sight smoothing: keep a waypoint only when the direct hop to the
  // tile after it is blocked
  const out: number[] = [];
  let anchor = 0;
  for (let i = 1; i < tiles.length; i++) {
    if (i === tiles.length - 1 || !losClear(grid, tiles[anchor], tiles[i + 1])) {
      out.push(((tiles[i] % size) << FP_BITS) + FP / 2, (((tiles[i] / size) | 0) << FP_BITS) + FP / 2);
      anchor = i;
    }
  }
  return out;
}

/** Supercover line-of-sight between two tile indices over the blocker grid. */
export function losClear(grid: Grid, a: number, b: number): boolean {
  const size = grid.size;
  let x0 = a % size, y0 = (a / size) | 0;
  const x1 = b % size, y1 = (b / size) | 0;
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    if (grid.isBlocked(x0, y0)) return false;
    if (x0 === x1 && y0 === y1) return true;
    const e2 = 2 * err;
    if (e2 > -dy && e2 < dx) {
      // diagonal step: both orthogonal neighbors must be free (unit width)
      if (grid.isBlocked(x0 + sx, y0) || grid.isBlocked(x0, y0 + sy)) return false;
    }
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
}
