// Unit tests for the perf harness statistics. Run: npx vitest run --config tests/perf/vitest.config.ts
import { describe, expect, it } from 'vitest';
import { agreement, countAbove, dist, fpsOf, isAppleMetal, isSoftwareGpu, pairedSum, percentile } from './stats.ts';

describe('percentile', () => {
  it('uses nearest rank', () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(percentile(v, 50)).toBe(50);
    expect(percentile(v, 95)).toBe(95);
    expect(percentile(v, 100)).toBe(100);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNaN();
  });
  it('does not depend on input order', () => {
    expect(percentile([5, 1, 4, 2, 3], 50)).toBe(3);
  });
});

describe('dist', () => {
  it('summarises and rounds', () => {
    const d = dist([1, 2, 3, 4, 100])!;
    expect(d).toMatchObject({ n: 5, p50: 3, max: 100, mean: 22 });
    expect(dist([])).toBeNull();
  });
});

describe('pairedSum', () => {
  it('adds CPU and GPU of the same frame and skips frames without GPU', () => {
    expect(pairedSum([1, 2, 3], [10, null, 30])).toEqual([11, 33]);
  });
});

describe('agreement', () => {
  it('agrees within 5%', () => {
    expect(agreement([10, 10.2, 10.4]).agree).toBe(true);
  });
  it('flags a run more than 5% off', () => {
    const a = agreement([10, 10.1, 11.5]);
    expect(a.agree).toBe(false);
    expect(a.spread).toBeCloseTo(0.1485, 3);
  });
  it('tolerates tiny absolute differences on light scenes', () => {
    expect(agreement([1.0, 1.15]).agree).toBe(true);
  });
});

describe('frame helpers', () => {
  it('fps from the median interval', () => {
    expect(fpsOf([16.7, 16.6, 16.8])).toBe(59.9);
  });
  it('counts long frames', () => {
    expect(countAbove([16, 17, 40, 50], 25)).toBe(2);
  });
});

describe('GPU strings', () => {
  it('accepts Apple Metal', () => {
    expect(isAppleMetal('ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)')).toBe(true);
  });
  it('refuses software renderers', () => {
    for (const s of ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', 'llvmpipe (LLVM 15.0.7, 256 bits)']) {
      expect(isSoftwareGpu(s)).toBe(true);
      expect(isAppleMetal(s)).toBe(false);
    }
  });
});
