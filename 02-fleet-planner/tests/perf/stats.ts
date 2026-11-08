// Small, pure statistics for the perf harness. No DOM, no node.

export interface Dist {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

/** Nearest-rank percentile (q in 0..100) of an unsorted list. NaN for an empty list. */
export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((q / 100) * s.length);
  return s[Math.min(s.length - 1, Math.max(0, rank - 1))];
}

export function median(values: readonly number[]): number {
  return percentile(values, 50);
}

const round = (v: number, d = 3): number => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v);

/** p50 / p95 / p99 / max / mean, rounded to 3 decimals. Null for an empty list. */
export function dist(values: readonly number[]): Dist | null {
  if (values.length === 0) return null;
  let sum = 0;
  let max = -Infinity;
  for (const v of values) {
    sum += v;
    if (v > max) max = v;
  }
  return {
    n: values.length,
    p50: round(percentile(values, 50)),
    p95: round(percentile(values, 95)),
    p99: round(percentile(values, 99)),
    max: round(max),
    mean: round(sum / values.length),
  };
}

/** Per-frame CPU + GPU where both exist (same frame index). */
export function pairedSum(cpu: readonly number[], gpu: readonly (number | null)[]): number[] {
  const out: number[] = [];
  const n = Math.min(cpu.length, gpu.length);
  for (let i = 0; i < n; i++) {
    const g = gpu[i];
    if (g !== null && Number.isFinite(g)) out.push(cpu[i] + g);
  }
  return out;
}

export interface Agreement {
  /** (max - min) / median of the values, as a fraction. */
  spread: number;
  /** Absolute max - min. */
  range: number;
  agree: boolean;
}

/**
 * Do repeated runs agree? They agree when (max - min) <= tol x median, or when the absolute range is at most `absMs`
 * (so 1.00 ms vs 1.06 ms on a light scene does not count as noise; timer and scheduler jitter is about 0.1 ms).
 */
export function agreement(values: readonly number[], tol = 0.05, absMs = 0.2): Agreement {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length < 2) return { spread: 0, range: 0, agree: true };
  const lo = Math.min(...finite);
  const hi = Math.max(...finite);
  const mid = median(finite);
  const spread = mid > 0 ? (hi - lo) / mid : 0;
  return { spread: round(spread, 4), range: round(hi - lo), agree: spread <= tol || hi - lo <= absMs };
}

/** Frames per second from frame intervals in ms (1000 / median interval). */
export function fpsOf(frameMs: readonly number[]): number {
  const m = median(frameMs);
  return Number.isFinite(m) && m > 0 ? round(1000 / m, 1) : NaN;
}

/** Count of values above a threshold (long frames). */
export function countAbove(values: readonly number[], limit: number): number {
  let n = 0;
  for (const v of values) if (v > limit) n++;
  return n;
}

/** GPU renderer strings that mean software rendering: numbers from them are meaningless. */
export function isSoftwareGpu(renderer: string): boolean {
  return /swiftshader|llvmpipe|softpipe|software|microsoft basic render/i.test(renderer);
}

/** True when the WebGL renderer string shows an Apple GPU or ANGLE's Metal backend, e.g.
 *  "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)". */
export function isAppleMetal(renderer: string): boolean {
  return /apple|metal/i.test(renderer) && !isSoftwareGpu(renderer);
}
