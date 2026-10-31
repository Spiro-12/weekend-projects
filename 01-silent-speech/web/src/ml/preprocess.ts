// Preprocessing spec v1 (PROTOCOL.md §5). JS and Python must match exactly; tests/unit/ml/golden.json
// holds values made with real scipy by scripts/golden-ml.py and this file must match them to 1e-6.
// All math runs in float64; only the final output is rounded to Float32Array.
import type { BudLocation, Channel, DtwKnnOptions, MotionSample, NormStats } from '../core/contracts';
import { DEFAULT_CHANNELS, GRID_HZ } from '../core/contracts';

/**
 * Defaults picked on Spiro's real recordings (Phase 2, Track F; data/raw s1..s3, exclude list applied, 342 clips):
 * `eval-dtw --sweep` over 768 configs (8 channel sets x L 48/64/96/128 x band 0.05/0.1/0.2 x norm x k 1/3 x budNorm),
 * ranked by LOSO over all 3 sessions (tie break: cross bud = train s2 + s3, test s1). Table:
 * ml/results/dtw-knn/sweep/sweep-real.json.
 * Honest accuracy (`eval-dtw --nested`, ml/results/dtw-knn/sweep/nested-real.json): options picked on 2 sessions
 * only, then tested on the third: s1 (right bud, mirrored) 67.1%, s2 96.6%, s3 98.3%, pooled 88.2% (301.5 / 342). The sweep's
 * own score picks on all 3 sessions and is optimistic: 94.2% (s1 83.8%, s2 97.4%, s3 100%); Phase 1 defaults scored
 * 81.9% there (rank 274 of 768). So: a new session on the same bud ~97 to 98%, the other bud mirrored 67 to 84%.
 * - norm 'clip' is the big win: +8.7 points at the Phase 1 options (81.9% -> 90.6%), +5.6 at these (88.6% -> 94.2%).
 *   The sessions differ a lot in loudness per channel (head against the chair, bud seated differently: s1 rr.z RMS is
 *   twice s2's), and per clip z scoring cancels that.
 * - k 3 beats k 1 now that a class has ~30 takes over 2 training sessions (93.6% -> 94.2% at L 96, band 0.05;
 *   Phase 1's "k 1 wins" was with 5 to 15 takes from one sitting).
 * - L 96 with a narrow band (0.05, r = 5) beat L 64 / band 0.1 (92.7%) and L 96 / band 0.1 (93.3%); all 6 channels
 *   tie the best subset (rr + ua.y/z).
 * - budNorm 'mirror': cross bud 83.8%; unmirrored 26.7% at these options, 41.0% at best (PROTOCOL §5 step 0).
 * - threshold 0.85, from `eval-dtw --thresholds` (ml/results/dtw-knn/sweep/thresholds-real.json): the lowest value in
 *   0.05 steps where (1) <= 3% of sentences fire the wrong action (LOSO all 3, LOSO s2 + s3 and cross bud: all 0%),
 *   (2) no none take fires, and (3) small real models (2 to 4 classes) accept <= 10% of the sentences they were not
 *   trained on (7.7%; 11.1% at 0.80). At 0.85: 61.6% of sentences are acted on (55.1% with the options picked
 *   without the test session), 0 / 315 wrong (95% upper bound 1.2%), 0 / 27 none takes (upper bound 12.8%).
 *   Small models are only safe on average: one sound alike sentence can fire a lot ("call back" fires focus_music
 *   on 73% of takes for a focus_music + demo_48h model), so actions need a full model (Track J gates them).
 *   tests/unit/ml/safety-real.test.ts holds these lines.
 */
export const DEFAULT_OPTS: Readonly<Required<DtwKnnOptions>> = Object.freeze({
  channels: [...DEFAULT_CHANNELS],
  L: 96,
  hpHz: 1.0,
  band: 0.05,
  k: 3,
  norm: 'clip',
  threshold: 0.85,
  budNorm: 'mirror', // PROTOCOL §5 step 0: right bud clips are mirrored into the left bud frame
});

const CHANNEL_INDEX: Record<Channel, ['rr' | 'ua', number]> = {
  'rr.x': ['rr', 0], 'rr.y': ['rr', 1], 'rr.z': ['rr', 2],
  'ua.x': ['ua', 0], 'ua.y': ['ua', 1], 'ua.z': ['ua', 2],
};

/** Fills in defaults and checks the options. Throws on nonsense (bad channel, L < 2, ...). */
export function resolveOpts(o: DtwKnnOptions = {}): Required<DtwKnnOptions> {
  const r: Required<DtwKnnOptions> = {
    channels: [...(o.channels ?? DEFAULT_OPTS.channels)],
    L: o.L ?? DEFAULT_OPTS.L,
    hpHz: o.hpHz ?? DEFAULT_OPTS.hpHz,
    band: o.band ?? DEFAULT_OPTS.band,
    k: o.k ?? DEFAULT_OPTS.k,
    norm: o.norm ?? DEFAULT_OPTS.norm,
    threshold: o.threshold ?? DEFAULT_OPTS.threshold,
    budNorm: o.budNorm ?? DEFAULT_OPTS.budNorm,
  };
  if (r.channels.length === 0) throw new Error('ml: channels must not be empty');
  for (const c of r.channels) if (!(c in CHANNEL_INDEX)) throw new Error(`ml: unknown channel ${String(c)}`);
  if (!Number.isInteger(r.L) || r.L < 2) throw new Error(`ml: L must be an integer >= 2 (got ${r.L})`);
  if (!Number.isInteger(r.k) || r.k < 1) throw new Error(`ml: k must be an integer >= 1 (got ${r.k})`);
  if (!(r.band >= 0)) throw new Error(`ml: band must be >= 0 (got ${r.band})`);
  if (!(r.hpHz < GRID_HZ / 2)) throw new Error(`ml: hpHz must be below ${GRID_HZ / 2} Hz (got ${r.hpHz})`);
  if (r.norm !== 'global' && r.norm !== 'clip') throw new Error(`ml: unknown norm ${String(r.norm)}`);
  if (!Number.isFinite(r.threshold)) throw new Error('ml: threshold must be a number');
  if (r.budNorm !== 'mirror' && r.budNorm !== 'none') throw new Error(`ml: unknown budNorm ${String(r.budNorm)}`);
  return r;
}

// ---------- Step 0: bud normalization ----------

/**
 * Channels that change sign when a right bud sample is mirrored into the left bud frame (PROTOCOL §5 step 0):
 * rr -> [rr.x, -rr.y, -rr.z], ua -> [-ua.x, ua.y, ua.z] (a sagittal reflection: ua is a vector, rr a pseudo vector).
 */
export const MIRROR_FLIPS: Readonly<Record<Channel, boolean>> = Object.freeze({
  'rr.x': false, 'rr.y': true, 'rr.z': true, 'ua.x': true, 'ua.y': false, 'ua.z': false,
});

/** True when step 0 mirrors a clip from this bud: only `right`, and only with budNorm 'mirror'. */
export const mirrors = (loc: BudLocation | undefined, budNorm: Required<DtwKnnOptions>['budNorm']): boolean =>
  budNorm === 'mirror' && loc === 'right';

/** Step 0 spelled out on one sample (reference form; the pipeline flips the same signs inside toGrid). */
export function mirrorSample(s: MotionSample): MotionSample {
  return { ...s, rr: [s.rr[0], -s.rr[1], -s.rr[2]], ua: [-s.ua[0], s.ua[1], s.ua[2]] };
}

// ---------- Step 1 + 2: uniform 50 Hz grid, pick channels ----------

/**
 * Grid length epsilon (PROTOCOL §5 step 1): the last point is kept when it lands on the grid. 1e-6, not 1e-9: real
 * Mac timestamps are ~1.3e6 s (seconds since boot), where t_last - t_0 carries ~1e-8 of float error.
 */
export const GRID_EPS = 1e-6;

/** Longest clip span preprocessing accepts (a push to talk clip is a few seconds; this stops a runaway grid). */
export const MAX_CLIP_SEC = 60;

/**
 * Sort by t (stable), drop duplicate t (keeps the first), grid t_k = t_0 + k/50 for
 * k = 0..floor((t_last - t_0)*50 + GRID_EPS), linear interpolation per channel (same as np.interp).
 * `mirror`: step 0 for a right bud clip (flip the MIRROR_FLIPS channels; negation is exact, so this is bit for
 * bit the same as gridding mirrorSample()d samples). Returns [channel][n].
 */
export function toGrid(samples: MotionSample[], channels: Channel[], mirror = false): Float64Array[] {
  if (samples.length === 0) throw new Error('ml.preprocess: clip has no samples');
  const order = samples.map((_, i) => i).sort((i, j) => samples[i].t - samples[j].t || i - j);
  const keep: number[] = [order[0]];
  for (let q = 1; q < order.length; q++) {
    if (samples[order[q]].t > samples[keep[keep.length - 1]].t) keep.push(order[q]);
  }
  const m = keep.length;
  const t = new Float64Array(m);
  for (let q = 0; q < m; q++) t[q] = samples[keep[q]].t;
  if (!Number.isFinite(t[0]) || !Number.isFinite(t[m - 1])) throw new Error('ml.preprocess: bad sample time');
  const span = t[m - 1] - t[0];
  if (span > MAX_CLIP_SEC) throw new Error(`ml.preprocess: clip spans ${span.toFixed(1)} s, max is ${MAX_CLIP_SEC} s`);
  const n = Math.floor((t[m - 1] - t[0]) * GRID_HZ + GRID_EPS) + 1;
  const out: Float64Array[] = [];
  for (const ch of channels) {
    const [key, idx] = CHANNEL_INDEX[ch];
    const sign = mirror && MIRROR_FLIPS[ch] ? -1 : 1;
    const v = new Float64Array(m);
    for (let q = 0; q < m; q++) v[q] = sign * samples[keep[q]][key][idx];
    const g = new Float64Array(n);
    let p = 0;
    for (let k = 0; k < n; k++) {
      const x = t[0] + k / GRID_HZ;
      while (p < m - 2 && t[p + 1] <= x) p++;
      if (m === 1 || x >= t[m - 1]) g[k] = v[m - 1];
      else if (x <= t[0]) g[k] = v[0];
      else g[k] = v[p] + ((v[p + 1] - v[p]) / (t[p + 1] - t[p])) * (x - t[p]);
    }
    out.push(g);
  }
  return out;
}

// ---------- Step 3: zero phase Butterworth high pass ----------

export interface IIR { b: number[]; a: number[] }

/**
 * 2nd order Butterworth high pass, bilinear transform with prewarping.
 * Same numbers as scipy.signal.butter(2, fc, 'highpass', fs=fs) (a[0] = 1).
 */
export function butterHighpass2(fc: number, fs: number = GRID_HZ): IIR {
  if (!(fc > 0 && fc < fs / 2)) throw new Error(`ml: high pass cutoff must be in (0, ${fs / 2})`);
  const K = Math.tan((Math.PI * fc) / fs);
  const K2 = K * K;
  const norm = 1 / (1 + Math.SQRT2 * K + K2);
  return {
    b: [norm, -2 * norm, norm],
    a: [1, 2 * (K2 - 1) * norm, (1 - Math.SQRT2 * K + K2) * norm],
  };
}

/** scipy.signal.lfilter_zi: steady state of the transposed direct form II filter for a unit step. */
export function lfilterZi(b: number[], a: number[]): Float64Array {
  const n = Math.max(a.length, b.length);
  const a0 = a[0];
  const A = Array.from({ length: n }, (_, i) => (a[i] ?? 0) / a0);
  const B = Array.from({ length: n }, (_, i) => (b[i] ?? 0) / a0);
  const N = n - 1;
  if (N === 0) return new Float64Array(0);
  // (I - companion(a).T) zi = b[1:] - a[1:] * b[0]; companion(a).T has -a[1:] in column 0 and ones above the diagonal.
  const M = Array.from({ length: N }, (_, i) => Array.from({ length: N }, (_, j) => (i === j ? 1 : 0) - (j === 0 ? -A[i + 1] : j === i + 1 ? 1 : 0)));
  const rhs = Array.from({ length: N }, (_, i) => B[i + 1] - A[i + 1] * B[0]);
  // Gaussian elimination with partial pivoting (N is 2 here).
  for (let c = 0; c < N; c++) {
    let piv = c;
    for (let r = c + 1; r < N; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    [rhs[c], rhs[piv]] = [rhs[piv], rhs[c]];
    for (let r = c + 1; r < N; r++) {
      const f = M[r][c] / M[c][c];
      for (let j = c; j < N; j++) M[r][j] -= f * M[c][j];
      rhs[r] -= f * rhs[c];
    }
  }
  const zi = new Float64Array(N);
  for (let r = N - 1; r >= 0; r--) {
    let s = rhs[r];
    for (let j = r + 1; j < N; j++) s -= M[r][j] * zi[j];
    zi[r] = s / M[r][r];
  }
  return zi;
}

/** scipy.signal.lfilter (transposed direct form II) with initial state zi (consumed). */
function lfilterInPlace(b: number[], a: number[], x: Float64Array, zi: Float64Array): Float64Array {
  const n = Math.max(a.length, b.length);
  const a0 = a[0];
  const B = Array.from({ length: n }, (_, i) => (b[i] ?? 0) / a0);
  const A = Array.from({ length: n }, (_, i) => (a[i] ?? 0) / a0);
  const z = zi;
  const N = n - 1;
  const y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = B[0] * xi + (N > 0 ? z[0] : 0);
    for (let s = 0; s < N - 1; s++) z[s] = B[s + 1] * xi + z[s + 1] - A[s + 1] * yi;
    if (N > 0) z[N - 1] = B[N] * xi - A[N] * yi;
    y[i] = yi;
  }
  return y;
}

/**
 * scipy.signal.filtfilt(b, a, x, padtype='odd', padlen=padlen) (method 'pad'):
 * odd extension by padlen, forward pass from zi*x[0], backward pass from zi*y[-1], trim.
 */
export function filtfilt(b: number[], a: number[], x: Float64Array, padlen: number): Float64Array {
  const n = x.length;
  if (n === 0) return new Float64Array(0);
  if (!(padlen >= 0 && padlen < n)) throw new Error(`ml.filtfilt: padlen ${padlen} must be in [0, ${n - 1}]`);
  const e = padlen;
  const ext = new Float64Array(n + 2 * e);
  for (let i = 0; i < e; i++) ext[i] = 2 * x[0] - x[e - i]; // 2*x[0] - x[e..1]
  ext.set(x, e);
  for (let i = 0; i < e; i++) ext[e + n + i] = 2 * x[n - 1] - x[n - 2 - i]; // 2*x[-1] - x[-2..-(e+1)]
  const zi = lfilterZi(b, a);
  const z1 = zi.map((v) => v * ext[0]);
  const fwd = lfilterInPlace(b, a, ext, z1);
  fwd.reverse();
  const z2 = zi.map((v) => v * fwd[0]);
  const bwd = lfilterInPlace(b, a, fwd, z2);
  bwd.reverse();
  return bwd.slice(e, e + n);
}

/** Step 3 per channel: filtfilt with padlen = min(9, n-1). hpHz <= 0 turns the filter off (sweeps only). */
export function highpass(x: Float64Array, hpHz: number): Float64Array {
  if (!(hpHz > 0)) return x.slice();
  const { b, a } = butterHighpass2(hpHz, GRID_HZ);
  return filtfilt(b, a, x, Math.min(9, x.length - 1));
}

// ---------- Step 4: resample to L ----------

/** Value at position j*(n-1)/(L-1), j = 0..L-1, linear interpolation. */
export function resampleLinear(x: Float64Array, L: number): Float64Array {
  const n = x.length;
  const out = new Float64Array(L);
  for (let j = 0; j < L; j++) {
    const pos = (j * (n - 1)) / (L - 1);
    const i = Math.floor(pos);
    if (i >= n - 1) out[j] = x[n - 1];
    else out[j] = x[i] + (pos - i) * (x[i + 1] - x[i]);
  }
  return out;
}

/**
 * Steps 0 to 4 (no normalization). Returns [channel][L] in float64.
 * `loc`: which bud recorded the clip (clip.loc, or ctx.loc at predict time); step 0 mirrors `right` clips.
 */
export function preprocessRaw(samples: MotionSample[], opts?: DtwKnnOptions, loc?: BudLocation): Float64Array[] {
  const o = resolveOpts(opts);
  return toGrid(samples, o.channels, mirrors(loc, o.budNorm)).map((g) => resampleLinear(highpass(g, o.hpHz), o.L));
}

// ---------- Step 5: normalization ----------

export const STD_FLOOR = 1e-8;

function meanStd(x: Float64Array): [number, number] {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i];
  const mean = s / x.length;
  let v = 0;
  for (let i = 0; i < x.length; i++) v += (x[i] - mean) ** 2;
  return [mean, Math.sqrt(v / x.length)];
}

function median(v: number[]): number {
  const s = [...v].sort((p, q) => p - q);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

/**
 * Norm stats from training clips (each [channel][L] after step 4).
 * - global: per channel mean and population std over every value, std floored at 1e-8.
 * - clip: `mean` is all zeros (unused) and `std` holds the per channel std floor =
 *   0.5 x median over training clips of that clip's own std (also floored at 1e-8 so a dead channel can't divide by 0).
 * No training clips: identity stats (mean 0, std 1 / floor 1e-8).
 */
export function computeNorm(raws: Float64Array[][], mode: 'global' | 'clip', nCh: number): NormStats {
  if (mode === 'clip') return { mean: new Array<number>(nCh).fill(0), std: clipFloor(raws.map(channelStds), nCh) };
  const mean = new Array<number>(nCh).fill(0);
  const std = new Array<number>(nCh).fill(1);
  if (raws.length === 0) return { mean, std };
  for (let c = 0; c < nCh; c++) {
    {
      let s = 0, cnt = 0;
      for (const r of raws) for (let i = 0; i < r[c].length; i++) { s += r[c][i]; cnt++; }
      const m = s / cnt;
      let v = 0;
      for (const r of raws) for (let i = 0; i < r[c].length; i++) v += (r[c][i] - m) ** 2;
      mean[c] = m;
      std[c] = Math.max(Math.sqrt(v / cnt), STD_FLOOR);
    }
  }
  return { mean, std };
}

/** Each channel's own population std (what norm 'clip' z scores a clip by). */
export const channelStds = (raw: Float64Array[]): number[] => raw.map((x) => meanStd(x)[1]);

/** The norm 'clip' std floor from every training clip's channelStds: 0.5 x median per channel, at least 1e-8. */
export function clipFloor(stds: number[][], nCh: number): number[] {
  if (stds.length === 0) return new Array<number>(nCh).fill(STD_FLOOR);
  return Array.from({ length: nCh }, (_, c) => Math.max(0.5 * median(stds.map((s) => s[c])), STD_FLOOR));
}

/** Step 5 on one clip. Returns float64 [channel][L]. */
export function applyNorm(raw: Float64Array[], mode: 'global' | 'clip', norm: NormStats): Float64Array[] {
  if (norm.mean.length !== raw.length || norm.std.length !== raw.length) {
    throw new Error(`ml: norm stats have ${norm.std.length} channels, clip has ${raw.length}`);
  }
  return raw.map((x, c) => {
    const [mean, sd] = channelScale(x, c, mode, norm);
    const y = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) y[i] = (x[i] - mean) / sd;
    return y;
  });
}

function channelScale(x: Float64Array, c: number, mode: 'global' | 'clip', norm: NormStats): [number, number] {
  if (mode === 'global') return [norm.mean[c], Math.max(norm.std[c], STD_FLOOR)];
  const [m, s] = meanStd(x);
  return [m, Math.max(s, norm.std[c], STD_FLOOR)];
}

/** Step 5 straight into interleaved [L][channel] float32: bit for bit interleave(toF32(applyNorm(...))). */
export function applyNormInterleaved(raw: Float64Array[], mode: 'global' | 'clip', norm: NormStats): Float32Array {
  if (norm.mean.length !== raw.length || norm.std.length !== raw.length) {
    throw new Error(`ml: norm stats have ${norm.std.length} channels, clip has ${raw.length}`);
  }
  const C = raw.length, n = C ? raw[0].length : 0;
  const out = new Float32Array(n * C);
  for (let c = 0; c < C; c++) {
    const x = raw[c];
    const [mean, sd] = channelScale(x, c, mode, norm);
    for (let i = 0; i < n; i++) out[i * C + c] = (x[i] - mean) / sd;
  }
  return out;
}

export const toF32 = (x: Float64Array[]): Float32Array[] => x.map((r) => Float32Array.from(r));

/**
 * Full spec v1 pipeline. Returns [channel][L].
 * `loc`: the clip's bud for step 0 (only `right` with budNorm 'mirror' changes anything).
 * With `norm`, step 5 runs in `opts.norm` mode (see computeNorm for what the stats hold).
 * Without `norm`, it stops after step 4 (raw, unnormalized), which is what training uses to compute stats.
 */
export function preprocess(samples: MotionSample[], opts?: DtwKnnOptions, norm?: NormStats, loc?: BudLocation): Float32Array[] {
  const o = resolveOpts(opts);
  const raw = preprocessRaw(samples, o, loc);
  return toF32(norm ? applyNorm(raw, o.norm, norm) : raw);
}
