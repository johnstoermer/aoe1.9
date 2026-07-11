import { describe, expect, it } from 'vitest';
import { FP, dist, fp, fpDiv, fpMul, isqrt, scaleTo } from '../src/shared/fixed';

describe('fixed-point math', () => {
  it('isqrt is the exact floor of sqrt for a wide range', () => {
    for (let n = 0; n < 5000; n++) {
      const r = isqrt(n);
      expect(r * r).toBeLessThanOrEqual(n);
      expect((r + 1) * (r + 1)).toBeGreaterThan(n);
    }
    for (const n of [10_000_019, 999_999_999, 2 ** 40 + 12345]) {
      const r = isqrt(n);
      expect(r * r).toBeLessThanOrEqual(n);
      expect((r + 1) * (r + 1)).toBeGreaterThan(n);
    }
  });

  it('fpMul / fpDiv round toward zero deterministically', () => {
    expect(fpMul(fp(2), fp(3))).toBe(fp(6));
    expect(fpDiv(fp(6), fp(3))).toBe(fp(2));
    expect(fpMul(-fp(2), fp(3))).toBe(-fp(6));
  });

  it('dist matches Euclid within a unit', () => {
    expect(dist(0, 0, fp(3), fp(4))).toBe(fp(5));
    expect(Math.abs(dist(0, 0, fp(1), fp(1)) - Math.round(Math.SQRT2 * FP))).toBeLessThanOrEqual(1);
  });

  it('scaleTo produces vectors of the requested length', () => {
    const [x, y] = scaleTo(fp(10), 0, fp(2));
    expect(x).toBe(fp(2));
    expect(y).toBe(0);
    const [a, b] = scaleTo(fp(3), fp(4), fp(5));
    expect(Math.abs(Math.hypot(a, b) - fp(5))).toBeLessThan(3);
  });
});
