// Deterministic fixed-point math for the simulation.
//
// The sim never touches IEEE floats: every quantity is an integer, and JS
// integer arithmetic (within 2^53, with |0 / Math.imul for 32-bit ops) is
// exactly specified and identical on every platform. World-space positions
// are stored in fixed point where FP units = 1 tile.

export const FP_BITS = 8;
export const FP = 1 << FP_BITS; // 256 fixed-point units per tile

export const fp = (tiles: number): number => Math.round(tiles * FP);
export const fpFloor = (v: number): number => v >> FP_BITS;
export const toTiles = (v: number): number => v / FP; // render-side only

export function fpMul(a: number, b: number): number {
  // Operands stay well under 2^26 in practice (maps are <= 96 tiles wide),
  // so the double-precision product is exact.
  return Math.trunc((a * b) / FP);
}

export function fpDiv(a: number, b: number): number {
  return Math.trunc((a * FP) / b);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Integer square root (floor), exact and deterministic. */
export function isqrt(n: number): number {
  if (n <= 0) return 0;
  let x = Math.floor(Math.sqrt(n)); // seed guess; corrected below to exact floor
  // Math.sqrt is correctly rounded per IEEE-754, but guard against any
  // off-by-one from the double round-trip anyway.
  while (x * x > n) x--;
  while ((x + 1) * (x + 1) <= n) x++;
  return x;
}

export function distSq(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

/** Fixed-point distance between two fixed-point positions. */
export function dist(ax: number, ay: number, bx: number, by: number): number {
  return isqrt(distSq(ax, ay, bx, by));
}

/**
 * Normalize the vector (dx, dy) to the given fixed-point length.
 * Returns [0, 0] for the zero vector.
 */
export function scaleTo(dx: number, dy: number, len: number): [number, number] {
  const d = isqrt(dx * dx + dy * dy);
  if (d === 0) return [0, 0];
  return [Math.trunc((dx * len) / d), Math.trunc((dy * len) / d)];
}
