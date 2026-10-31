import { readFileSync } from 'node:fs';
import type { Dataset, MotionSample } from '../../../web/src/core/contracts';

const root = new URL('../../../', import.meta.url);
export const readJson = <T>(rel: string): T => JSON.parse(readFileSync(new URL(rel, root), 'utf8')) as T;

let synthetic: Dataset | null = null;
/** shared/fixtures/dataset.synthetic.json: 8 classes x 5 reps x 3 sessions (s1..s3). */
export const syntheticDataset = (): Dataset => (synthetic ??= readJson<Dataset>('shared/fixtures/dataset.synthetic.json'));

/** Max absolute difference between two (possibly nested) numeric arrays; throws on shape mismatch. */
export function maxAbsDiff(a: ArrayLike<number> | ArrayLike<number>[], b: ArrayLike<number> | ArrayLike<number>[]): number {
  if (a.length !== b.length) throw new Error(`length ${a.length} vs ${b.length}`);
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number | ArrayLike<number>, y = b[i] as number | ArrayLike<number>;
    const d = typeof x === 'number' ? Math.abs(x - (y as number)) : maxAbsDiff(x, y as ArrayLike<number>);
    if (!(d <= m)) m = d; // NaN propagates as NaN
  }
  return m;
}

/** Samples at `hz` for `sec` seconds, every channel = f(t, channelIndex). */
export function makeSamples(hz: number, sec: number, f: (t: number, ch: number) => number, t0 = 100): MotionSample[] {
  const out: MotionSample[] = [];
  const n = Math.round(sec * hz);
  for (let i = 0; i < n; i++) {
    const t = t0 + i / hz;
    out.push({ seq: i, t, q: [1, 0, 0, 0], rr: [f(t, 0), f(t, 1), f(t, 2)], ua: [f(t, 3), f(t, 4), f(t, 5)] });
  }
  return out;
}

// ---------- Out of vocabulary inputs for the safety tests (seeded) ----------
import { gauss, mulberry32 } from '../../../web/src/core/rng';

const RR = 0.05, UA = 0.006; // about the per channel std of the synthetic fixture (rad/s, g)
const clipOf = (f: (t: number) => number[]): MotionSample[] =>
  Array.from({ length: 75 }, (_, i) => { const t = i * 0.04; const v = f(t); return { seq: i, t: 10 + t, q: [1, 0, 0, 0], rr: [v[0], v[1], v[2]], ua: [v[3], v[4], v[5]] }; });

/** White noise, 3 s at 25 Hz, `scale` x the fixture's channel std. */
export function whiteNoise(n: number, seed: number, scale: number): MotionSample[][] {
  const rng = mulberry32(seed);
  return Array.from({ length: n }, () => clipOf(() => [0, 1, 2, 3, 4, 5].map((c) => scale * (c < 3 ? RR : UA) * gauss(rng))));
}

/** Smooth random motion in the 1 to 6 Hz band (passes the high pass), `scale` x the fixture's std. */
export function bandNoise(n: number, seed: number, scale: number): MotionSample[][] {
  const rng = mulberry32(seed);
  return Array.from({ length: n }, () => {
    const comps = Array.from({ length: 6 }, () => Array.from({ length: 5 }, () => ({ f: 1 + 5 * rng(), p: 2 * Math.PI * rng(), a: gauss(rng) })));
    return clipOf((t) => comps.map((cs, c) => (scale * (c < 3 ? RR : UA) * cs.reduce((a, k) => a + k.a * Math.sin(2 * Math.PI * k.f * t + k.p), 0)) / 2.2));
  });
}

/** Random "jaw bursts" (2 to 10 bumps, random timing and channel mix): looks like speech, but no class. */
export function burstNoise(n: number, seed: number, scale: number): MotionSample[][] {
  const rng = mulberry32(seed);
  return Array.from({ length: n }, () => {
    const bs = Array.from({ length: 2 + Math.floor(rng() * 9) }, () => ({ c: 0.4 + 2.2 * rng(), w: 0.05 + 0.04 * rng(), a: 0.4 + 0.6 * rng(), mix: Array.from({ length: 6 }, () => rng() * 2 - 1) }));
    return clipOf((t) => [0, 1, 2, 3, 4, 5].map((c) => scale * (c < 3 ? 0.12 : 0.012) * (bs.reduce((a, b) => a + b.a * b.mix[c] * Math.exp(-((t - b.c) ** 2) / (2 * b.w * b.w)), 0) + 0.05 * gauss(rng))));
  });
}

/** 80 out of vocabulary noise clips of all three kinds, several loudness levels. */
export const noiseSet = (): MotionSample[][] => [
  ...whiteNoise(10, 1, 0.3), ...whiteNoise(10, 2, 1), ...whiteNoise(5, 3, 3),
  ...bandNoise(10, 4, 1), ...bandNoise(5, 5, 0.3), ...bandNoise(5, 8, 3),
  ...burstNoise(15, 6, 1), ...burstNoise(10, 7, 0.5), ...burstNoise(10, 9, 2),
];
