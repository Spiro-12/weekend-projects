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
