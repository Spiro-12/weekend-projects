// JS preprocessing + DTW vs real scipy / numpy (tests/unit/ml/golden.json, made by scripts/golden-ml.py).
import { describe, expect, it } from 'vitest';
import type { BudLocation, Channel, Clip, MotionSample } from '../../../web/src/core/contracts';
import { DEFAULT_CHANNELS } from '../../../web/src/core/contracts';
import { dtw, preprocess } from '../../../web/src/ml/index';
import {
  applyNorm, butterHighpass2, computeNorm, filtfilt, lfilterZi, preprocessRaw, toGrid,
} from '../../../web/src/ml/preprocess';
import { maxAbsDiff, readJson, syntheticDataset } from './helpers';

interface Golden {
  butter: { fc: number; b: number[]; a: number[]; zi: number[] }[];
  filtfilt: { x: number[]; padlen: number; y: number[] }[];
  grid: { name: string; samples: MotionSample[]; grid: number[][] }[];
  raw: { name: string; L: number; hpHz: number; channels: Channel[]; x: number[][] }[];
  norm: {
    ids: string[]; raw0: number[][];
    global: { mean: number[]; std: number[]; x0: number[][] };
    clip: { floor: number[]; x0: number[][] };
  };
  dtw: { a: number[][]; b: number[][]; r: number; d: number }[];
  budnorm: { name: string; loc: BudLocation; L: number; hpHz: number; channels: Channel[]; x: number[][] }[];
}
const g = readJson<Golden>('tests/unit/ml/golden.json');
const TOL = 1e-6;
const samplesOf = (name: string) => g.grid.find((c) => c.name === name)!.samples;
const f32 = (x: number[][]) => x.map((r) => Float32Array.from(r));

describe('golden: scipy filter design', () => {
  it.each(g.butter)('butter(2, $fc, highpass, fs=50) and lfilter_zi', ({ fc, b, a, zi }) => {
    const f = butterHighpass2(fc, 50);
    expect(maxAbsDiff(f.b, b)).toBeLessThan(1e-12);
    expect(maxAbsDiff(f.a, a)).toBeLessThan(1e-12);
    expect(maxAbsDiff(lfilterZi(f.b, f.a), zi)).toBeLessThan(1e-12);
  });
});

describe('golden: scipy filtfilt(padtype=odd, padlen=min(9, n-1))', () => {
  const { b, a } = butterHighpass2(1.0, 50);
  it.each(g.filtfilt.map((c) => ({ ...c, n: c.x.length })))('n = $n', ({ x, padlen, y }) => {
    expect(maxAbsDiff(filtfilt(b, a, Float64Array.from(x), padlen), y)).toBeLessThan(1e-9);
  });
});

describe('golden: 50 Hz grid (np.interp)', () => {
  it.each(g.grid)('$name', ({ samples, grid }) => {
    const out = toGrid(samples, ['rr.x', 'rr.y', 'rr.z', 'ua.x', 'ua.y', 'ua.z']);
    expect(out[0].length).toBe(grid[0].length);
    expect(maxAbsDiff(out, grid)).toBeLessThan(1e-9);
  });

  it('includes the last point when it lands on the grid', () => {
    const s = samplesOf('on-grid'); // 26 samples, 0.04 s apart -> 1.0 s -> 51 grid points
    expect(toGrid(s, ['rr.x'])[0].length).toBe(51);
  });
});

describe('golden: steps 1-4 (grid, high pass, resample)', () => {
  it.each(g.raw.map((c) => ({ ...c, ch: c.channels.join(',') })))('$name L=$L hp=$hpHz [$ch]', ({ name, L, hpHz, channels, x }) => {
    const opts = { L, hpHz, channels };
    const s = samplesOf(name);
    expect(maxAbsDiff(preprocessRaw(s, opts), x)).toBeLessThan(1e-9);
    const out = preprocess(s, opts); // public API, Float32Array, no norm
    expect(out.length).toBe(channels.length);
    expect(out.every((r) => r instanceof Float32Array && r.length === L)).toBe(true);
    expect(maxAbsDiff(out, x)).toBeLessThan(TOL);
  });
});

describe('golden: step 0 bud normalization (right bud mirrored), then steps 1-4', () => {
  it.each(g.budnorm.map((c) => ({ ...c, ch: c.channels.join(',') })))('$name $loc L=$L [$ch]', ({ name, loc, L, hpHz, channels, x }) => {
    const opts = { L, hpHz, channels };
    const s = samplesOf(name);
    expect(maxAbsDiff(preprocessRaw(s, opts, loc), x)).toBeLessThan(1e-9);
    expect(maxAbsDiff(preprocess(s, opts, undefined, loc), x)).toBeLessThan(TOL);
    expect(maxAbsDiff(preprocessRaw(s, { ...opts, budNorm: 'none' }, loc), x)).toBeGreaterThan(1e-3); // 'none': not mirrored
  });
});

describe('golden: step 5 norm stats on fixture clips', () => {
  const byId = new Map(syntheticDataset().clips.map((c) => [c.id, c] as [string, Clip]));
  const clips = g.norm.ids.map((id) => byId.get(id)!);
  // golden-ml.py's raw() reference options (6 channels, L 64, 1 Hz), not DEFAULT_OPTS: these goldens test the spec
  const SPEC = { channels: [...DEFAULT_CHANNELS], L: 64, hpHz: 1.0 };
  const raws = clips.map((c) => preprocessRaw(c.samples, SPEC));

  it('raw clip matches', () => {
    expect(maxAbsDiff(raws[0], g.norm.raw0)).toBeLessThan(1e-9);
  });

  it('global: mean + population std, and the normalized clip', () => {
    const n = computeNorm(raws, 'global', 6);
    expect(maxAbsDiff(n.mean, g.norm.global.mean)).toBeLessThan(1e-12);
    expect(maxAbsDiff(n.std, g.norm.global.std)).toBeLessThan(1e-12);
    expect(maxAbsDiff(applyNorm(raws[0], 'global', n), g.norm.global.x0)).toBeLessThan(1e-9);
    expect(maxAbsDiff(preprocess(clips[0].samples, SPEC, n), g.norm.global.x0)).toBeLessThan(TOL);
  });

  it('clip: per clip z score with floor = 0.5 x median per clip std', () => {
    const n = computeNorm(raws, 'clip', 6);
    expect(maxAbsDiff(n.std, g.norm.clip.floor)).toBeLessThan(1e-12);
    expect(maxAbsDiff(preprocess(clips[0].samples, { ...SPEC, norm: 'clip' }, n), g.norm.clip.x0)).toBeLessThan(TOL);
  });
});

describe('golden: DTW vs a plain numpy full matrix reference', () => {
  it.each(g.dtw.map((c) => ({ ...c, n: c.a[0].length, m: c.b[0].length, C: c.a.length })))('n=$n m=$m C=$C r=$r', ({ a, b, r, d }) => {
    expect(Math.abs(dtw(f32(a), f32(b), r) - d)).toBeLessThan(1e-9 * Math.max(1, d));
  });
});
