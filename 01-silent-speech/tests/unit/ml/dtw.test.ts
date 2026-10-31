import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../../web/src/core/rng';
import { dtw } from '../../../web/src/ml/index';
import { bandRadius, dtwFlat, interleave } from '../../../web/src/ml/dtw';

const C = 6, L = 64;
const rand = (seed: number, c = C, n = L) => {
  const r = mulberry32(seed);
  return Array.from({ length: c }, () => Float32Array.from({ length: n }, () => r() * 2 - 1));
};
/** Smooth multi channel "utterance": bumps at given centers (fractions of the clip). */
const bumps = (centers: number[], n = L) =>
  Array.from({ length: C }, (_, c) => Float32Array.from({ length: n }, (_, i) =>
    centers.reduce((s, m, k) => s + (1 + 0.3 * c - 0.2 * k) * Math.exp(-(((i / (n - 1)) - m) ** 2) / 0.002), 0)));
const sqEuclid = (a: Float32Array[], b: Float32Array[]) => {
  let s = 0;
  for (let c = 0; c < a.length; c++) for (let i = 0; i < a[c].length; i++) s += (a[c][i] - b[c][i]) ** 2;
  return s;
};

describe('dtw', () => {
  it('dtw(a, a) = 0', () => {
    const a = rand(1);
    expect(dtw(a, a, 6)).toBe(0);
    expect(dtw(a, a, 0)).toBe(0);
  });

  it('is symmetric', () => {
    for (let s = 0; s < 5; s++) {
      const a = rand(10 + s), b = rand(20 + s);
      for (const r of [0, 1, 6, 20]) expect(dtw(a, b, r)).toBeCloseTo(dtw(b, a, r), 9);
    }
  });

  it('band 0 equals squared Euclidean distance', () => {
    const a = rand(3), b = rand(4);
    expect(dtw(a, b, 0)).toBeCloseTo(sqEuclid(a, b), 9);
  });

  it('a wider band never costs more', () => {
    const a = rand(5), b = rand(6);
    let last = Infinity;
    for (const r of [0, 1, 2, 4, 6, 12, 63]) {
      const d = dtw(a, b, r);
      expect(d).toBeLessThanOrEqual(last + 1e-9);
      last = d;
    }
  });

  it('a time warped copy is closer than a different class', () => {
    const a = bumps([0.2, 0.45, 0.7]);
    const warped = bumps([0.25, 0.5, 0.72]); // same pattern, shifted a little in time
    const other = bumps([0.3, 0.8]); // different number and place of bumps
    const r = bandRadius(0.1, L);
    expect(dtw(a, warped, r)).toBeLessThan(dtw(a, other, r));
    expect(dtw(a, warped, r)).toBeLessThan(0.25 * sqEuclid(a, warped)); // warping really helped
  });

  it('radius = max(1, floor(band * L + 0.5))', () => {
    expect(bandRadius(0.1, 64)).toBe(6);
    expect(bandRadius(0.05, 48)).toBe(2);
    expect(bandRadius(0.2, 96)).toBe(19);
    expect(bandRadius(0, 64)).toBe(1);
    expect(bandRadius(0.1, 5)).toBe(1);
  });

  it('handles different lengths (band widened so a path exists)', () => {
    const a = rand(7, 2, 10), b = rand(8, 2, 14);
    expect(Number.isFinite(dtw(a, b, 1))).toBe(true);
    expect(dtw(a, b, 1)).toBeCloseTo(dtw(b, a, 1), 9);
  });

  it('early abandon returns Infinity only when the true cost is above the cutoff', () => {
    const a = interleave(rand(9)), b = interleave(rand(10));
    const d = dtwFlat(a, L, b, L, C, 6);
    expect(dtwFlat(a, L, b, L, C, 6, d * 1.001)).toBeCloseTo(d, 9);
    expect(dtwFlat(a, L, b, L, C, 6, d * 0.5)).toBe(Infinity);
  });

  it('rejects a channel count mismatch', () => {
    expect(() => dtw(rand(1, 6), rand(2, 5), 6)).toThrow(/channels/);
  });
});
