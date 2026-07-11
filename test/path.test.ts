import { describe, expect, it } from 'vitest';
import { FP } from '../src/shared/fixed';
import { Grid, findPath } from '../src/shared/path';

const tile = (fpCoord: number) => Math.floor(fpCoord / FP);

describe('pathfinding', () => {
  it('finds a straight path on open ground', () => {
    const g = new Grid(16);
    const p = findPath(g, 1, 1, { x: 10, y: 1, w: 0, h: 0 });
    expect(p).not.toBeNull();
    const last = p!.slice(-2);
    expect(Math.abs(tile(last[0]) - 10)).toBeLessThanOrEqual(1);
  });

  it('routes around a wall', () => {
    const g = new Grid(16);
    g.setRect(5, 0, 1, 14, 1); // vertical wall with a gap at the bottom
    const p = findPath(g, 2, 2, { x: 10, y: 2, w: 0, h: 0 })!;
    expect(p).not.toBeNull();
    // must pass through the gap (y >= 14 area is open only at y=14/15)
    let sawDetour = false;
    for (let i = 0; i < p.length; i += 2) {
      if (tile(p[i + 1]) >= 13) sawDetour = true;
    }
    expect(sawDetour).toBe(true);
  });

  it('walks as close as possible to an enclosed target (best effort)', () => {
    const g = new Grid(16);
    g.setRect(8, 8, 3, 3, 1);   // solid block
    g.setRect(7, 7, 5, 1, 1);   // wall it in completely
    g.setRect(7, 11, 5, 1, 1);
    g.setRect(7, 7, 1, 5, 1);
    g.setRect(11, 7, 1, 5, 1);
    const p = findPath(g, 1, 1, { x: 9, y: 9, w: 0, h: 0 });
    // unreachable, so the path ends near the wall rather than at the goal
    expect(p).not.toBeNull();
    const last = p!.slice(-2);
    const d = Math.hypot(tile(last[0]) - 9, tile(last[1]) - 9);
    expect(d).toBeGreaterThan(1.4); // outside the ring
    expect(d).toBeLessThan(5);      // but pressed up against it
    expect(g.isBlocked(tile(last[0]), tile(last[1]))).toBe(false);
  });

  it('returns null when the start has no free neighbor at all', () => {
    const g = new Grid(16);
    g.setRect(0, 0, 3, 3, 1);
    g.blocked[g.idx(1, 1)] = 0; // one free tile in a solid block
    const p = findPath(g, 1, 1, { x: 12, y: 12, w: 0, h: 0 });
    expect(p).toBeNull();
  });

  it('reaches tiles adjacent to a building footprint', () => {
    const g = new Grid(16);
    g.setRect(6, 6, 3, 3, 1); // the building blocks its own tiles
    const p = findPath(g, 1, 1, { x: 6, y: 6, w: 3, h: 3 });
    expect(p).not.toBeNull();
    const last = p!.slice(-2);
    const tx = tile(last[0]), ty = tile(last[1]);
    expect(tx).toBeGreaterThanOrEqual(5);
    expect(tx).toBeLessThanOrEqual(9);
    expect(ty).toBeGreaterThanOrEqual(5);
    expect(ty).toBeLessThanOrEqual(9);
    expect(g.isBlocked(tx, ty)).toBe(false);
  });

  it('never cuts corners diagonally', () => {
    const g = new Grid(8);
    // two blocks with only a diagonal squeeze between them
    g.setRect(3, 0, 1, 4, 1);
    g.setRect(4, 4, 1, 4, 1);
    const p = findPath(g, 1, 6, { x: 6, y: 1, w: 0, h: 0 });
    // a path may exist going around, but it must not thread the corner at (3,4)/(4,3)
    if (p) {
      for (let i = 2; i < p.length; i += 2) {
        const ax = tile(p[i - 2]), ay = tile(p[i - 1]);
        const bx = tile(p[i]), by = tile(p[i + 1]);
        if (Math.abs(ax - bx) === 1 && Math.abs(ay - by) === 1) {
          expect(g.isBlocked(ax, by)).toBe(false);
          expect(g.isBlocked(bx, ay)).toBe(false);
        }
      }
    }
  });
});
