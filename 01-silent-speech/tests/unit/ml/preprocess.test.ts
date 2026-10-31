import { describe, expect, it } from 'vitest';
import { DEFAULT_CHANNELS } from '../../../web/src/core/contracts';
import { preprocess } from '../../../web/src/ml/index';
import { computeNorm, highpass, preprocessRaw, resolveOpts, toGrid } from '../../../web/src/ml/preprocess';
import { makeSamples, syntheticDataset } from './helpers';

const power = (x: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return s / x.length;
};
const sine = (hz: number) => (t: number) => Math.sin(2 * Math.PI * hz * t);

describe('high pass (1 Hz, zero phase)', () => {
  it('removes a 0.2 Hz sine (> 90% power drop) but keeps 5 Hz (> 80% kept)', () => {
    for (const inputHz of [25, 50]) {
      const slow = toGrid(makeSamples(inputHz, 10, sine(0.2)), ['rr.x'])[0];
      const fast = toGrid(makeSamples(inputHz, 10, sine(5)), ['rr.x'])[0];
      expect(power(highpass(slow, 1.0)) / power(slow)).toBeLessThan(0.1);
      expect(power(highpass(fast, 1.0)) / power(fast)).toBeGreaterThan(0.8);
    }
  });

  it('also on a typical 3 s clip through the full pipeline', () => {
    const slow = preprocessRaw(makeSamples(25, 3, (t) => 0.5 + sine(0.2)(t)), { channels: ['rr.x'] })[0];
    const raw = toGrid(makeSamples(25, 3, (t) => 0.5 + sine(0.2)(t)), ['rr.x'])[0];
    expect(power(slow) / power(raw)).toBeLessThan(0.1);
    const fast = preprocessRaw(makeSamples(25, 3, sine(5)), { channels: ['rr.x'], L: 150 })[0];
    expect(power(fast) / power(toGrid(makeSamples(25, 3, sine(5)), ['rr.x'])[0])).toBeGreaterThan(0.8);
  });

  it('hpHz <= 0 turns it off', () => {
    const x = toGrid(makeSamples(25, 3, sine(0.2)), ['rr.x'])[0];
    expect(Array.from(highpass(x, 0))).toEqual(Array.from(x));
  });
});

describe('preprocess', () => {
  const clip = syntheticDataset().clips[0];

  it('returns Float32Array[channel][L]', () => {
    const out = preprocess(clip.samples, {});
    expect(out.length).toBe(6);
    for (const r of out) { expect(r).toBeInstanceOf(Float32Array); expect(r.length).toBe(64); }
    const o2 = preprocess(clip.samples, { L: 48, channels: ['ua.z', 'rr.x'] });
    expect(o2.length).toBe(2);
    expect(o2[0].length).toBe(48);
    expect(Array.from(o2[1])).toEqual(Array.from(preprocess(clip.samples, { L: 48 })[0])); // rr.x, same values
  });

  it('grid is 50 Hz no matter the input rate, and sorts / drops duplicate t', () => {
    const s = makeSamples(25, 2, (t, c) => t * (c + 1));
    expect(toGrid(s, ['rr.x'])[0].length).toBe(99); // 0 .. 1.96 s
    const shuffled = [...s].reverse();
    shuffled.push({ ...s[10], rr: [99, 99, 99] }); // duplicate t after the original: dropped (first one wins)
    expect(Array.from(toGrid(shuffled, ['rr.x'])[0])).toEqual(Array.from(toGrid(s, ['rr.x'])[0]));
  });

  it('global norm gives mean 0 / std 1 per channel over the training clips', () => {
    const clips = syntheticDataset().clips.slice(0, 20);
    const raws = clips.map((c) => preprocessRaw(c.samples));
    const n = computeNorm(raws, 'global', 6);
    const xs = clips.map((c) => preprocess(c.samples, {}, n));
    for (let ch = 0; ch < 6; ch++) {
      const v = xs.flatMap((x) => Array.from(x[ch]));
      const m = v.reduce((a, b) => a + b, 0) / v.length;
      const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
      expect(Math.abs(m)).toBeLessThan(1e-5);
      expect(Math.abs(sd - 1)).toBeLessThan(1e-5);
    }
  });

  it('clip norm z scores each clip, and the floor stops a quiet clip from blowing up', () => {
    const clips = syntheticDataset().clips.slice(0, 20);
    const n = computeNorm(clips.map((c) => preprocessRaw(c.samples)), 'clip', 6);
    expect(n.mean).toEqual([0, 0, 0, 0, 0, 0]);
    const x = preprocess(clips[0].samples, { norm: 'clip' }, n);
    const m = x[0].reduce((a, b) => a + b, 0) / x[0].length;
    expect(Math.abs(m)).toBeLessThan(1e-5);
    const quiet = preprocess(makeSamples(25, 3, (t) => 1e-6 * Math.sin(20 * t)), { norm: 'clip' }, n);
    expect(Math.max(...quiet.map((r) => Math.max(...Array.from(r, Math.abs))))).toBeLessThan(1e-3);
  });

  it('a constant channel stays finite (std floor)', () => {
    const s = makeSamples(25, 2, () => 0.3);
    const n = computeNorm([preprocessRaw(s)], 'global', 6);
    const out = preprocess(s, {}, n);
    expect(out.every((r) => Array.from(r).every(Number.isFinite))).toBe(true);
  });

  it('rejects a clip that spans more than 60 s (before building the grid)', () => {
    const long = [...makeSamples(25, 1, () => 0.1), ...makeSamples(25, 1, () => 0.1, 160.5)]; // 100 .. 161.46 s
    expect(() => preprocess(long, {})).toThrow(/max is 60 s/);
    expect(preprocess(makeSamples(2, 59, () => 0.1), {})[0].length).toBe(64);
  });

  it('resolves defaults and rejects bad options', () => {
    expect(resolveOpts()).toEqual({ channels: DEFAULT_CHANNELS, L: 64, hpHz: 1, band: 0.1, k: 1, norm: 'global', threshold: 0.5, budNorm: 'mirror' });
    expect(() => resolveOpts({ L: 1 })).toThrow();
    expect(() => resolveOpts({ k: 0 })).toThrow();
    expect(() => resolveOpts({ channels: [] })).toThrow();
    expect(() => resolveOpts({ hpHz: 30 })).toThrow();
    expect(() => preprocess([], {})).toThrow(/no samples/);
  });
});
