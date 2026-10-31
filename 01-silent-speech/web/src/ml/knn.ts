// DTW + kNN classifier (PROTOCOL.md §6).
//
// Prediction:
//   1. Preprocess the clip (spec v1, the model's norm stats) and DTW it against every template.
//   2. Label = distance weighted vote of the k nearest templates, weight 1 / (d + 1e-9)
//      (same as the Python `dtw-py` cross check). Ties: the class with the nearer template wins.
//   3. Confidence = vote x separation, both in [0, 1]:
//      - vote       = the label's share of the k neighbour weights (1 when all k agree).
//      - separation = softmax over every class's nearest DTW distance d_c, evaluated at the label:
//                     exp(-(d_c - d_best) / T) / sum over classes, with T = 0.1 x d_best.
//                     The temperature comes from the data (this query's best match), so it is scale free:
//                     a class 10% farther than the best match gets e^-1 the weight, 30% farther e^-3.
//                     It drops toward 1/(#classes) when several classes are about as close, including
//                     when a clip is far from everything (all distances big and similar).
//   4. top = the classes that got neighbour votes (at most k, capped at 3), ordered by vote,
//      score = vote share x separation. So top[0] is always the label and top[0].score === confidence.
//   5. accepted = label !== 'none' && confidence >= threshold.
import type { Clip, DtwKnnModelJSON, DtwKnnOptions, MotionSample, NormStats, Prediction } from '../core/contracts';
import { NONE } from '../core/contracts';
import { bandRadius, dtwFlat, interleave } from './dtw';
import { applyNorm, computeNorm, preprocessRaw, resolveOpts, toF32 } from './preprocess';
import type { DtwKnnModel } from './index';

/** Separation temperature as a fraction of the best match distance (see the header). */
export const SEPARATION_TAU = 0.1;
const VOTE_EPS = 1e-9;
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

interface Template { label: string; x: Float32Array } // x interleaved [L][channel]

export const sortLabels = (labels: Iterable<string>): string[] => [...new Set(labels)].sort();

/** Merge order is kept; the first clip with a given id wins. */
export function dedupeById<T extends { id: string }>(clips: T[]): T[] {
  const seen = new Set<string>();
  return clips.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}

/** Shortest decimal that rounds back to the same float32 (keeps model files about half the size, lossless). */
function f32num(x: number): number {
  for (let p = 6; p < 9; p++) {
    const y = Number(x.toPrecision(p));
    if (Math.fround(y) === x) return y;
  }
  return Number(x.toPrecision(9));
}

export class DtwKnn implements DtwKnnModel {
  readonly name = 'dtw-knn';
  labels: string[] = [];
  threshold: number;
  readonly opts: Required<DtwKnnOptions>;
  readonly norm: NormStats;
  private readonly C: number;
  private readonly radius: number;
  private tpl: Template[] = [];
  private labelIdx = new Map<string, number>();

  /** templates: already normalized, [channel][L]. */
  constructor(opts: Required<DtwKnnOptions>, norm: NormStats, templates: { label: string; x: ArrayLike<number>[] }[]) {
    this.opts = { ...opts, channels: [...opts.channels] };
    this.threshold = opts.threshold;
    this.norm = { mean: [...norm.mean], std: [...norm.std] };
    this.C = opts.channels.length;
    this.radius = bandRadius(opts.band, opts.L);
    if (this.norm.mean.length !== this.C || this.norm.std.length !== this.C) {
      throw new Error(`ml: norm stats need ${this.C} channels`);
    }
    for (const t of templates) this.push(t.label, t.x);
  }

  private push(label: string, x: ArrayLike<number>[]): void {
    if (typeof label !== 'string' || !label) throw new Error('ml: template without a label');
    if (x.length !== this.C) throw new Error(`ml: template has ${x.length} channels, model has ${this.C}`);
    for (const row of x) {
      if (row.length !== this.opts.L) throw new Error(`ml: template length ${row.length}, model L is ${this.opts.L}`);
      for (let i = 0; i < row.length; i++) if (!Number.isFinite(row[i])) throw new Error('ml: template has a non finite value');
    }
    this.tpl.push({ label, x: interleave(x) });
    if (!this.labelIdx.has(label)) {
      this.labels = sortLabels([...this.labels, label]);
      this.labelIdx = new Map(this.labels.map((l, i) => [l, i]));
    }
  }

  get size(): number { return this.tpl.length; }

  /** Spec v1 preprocessing with this model's options and norm stats. Returns [channel][L]. */
  prep(samples: MotionSample[]): Float32Array[] {
    return toF32(applyNorm(preprocessRaw(samples, this.opts), this.opts.norm, this.norm));
  }

  /** Adds one clip as a template, normalized with the model's current stats (stats are not recomputed). */
  add(c: Clip): void {
    this.push(c.label, this.prep(c.samples));
  }

  predict(samples: MotionSample[]): Prediction {
    const t0 = now();
    const p = this.classify(interleave(this.prep(samples)));
    return { ...p, ms: now() - t0 };
  }

  /** Classify an already preprocessed + normalized, interleaved clip. */
  classify(q: Float32Array): Omit<Prediction, 'ms'> {
    const N = this.tpl.length;
    const nL = this.labels.length;
    if (N === 0) return { label: NONE, confidence: 0, accepted: false, top: [] };
    const L = this.opts.L, C = this.C, r = this.radius;
    const k = Math.min(this.opts.k, N);
    if (q.length !== L * C) throw new Error('ml: query has the wrong shape');
    for (let i = 0; i < q.length; i++) if (!Number.isFinite(q[i])) throw new Error('ml.predict: clip has non finite values');
    const nearest = new Float64Array(nL).fill(Infinity); // per class nearest distance
    const kd = new Float64Array(k).fill(Infinity); // k nearest, ascending
    const kl = new Int32Array(k).fill(-1);
    for (let t = 0; t < N; t++) {
      const tp = this.tpl[t];
      const li = this.labelIdx.get(tp.label)!;
      // Exact early abandon: a template farther than both its class's nearest and the k-th best changes nothing.
      const cutoff = nearest[li] > kd[k - 1] ? nearest[li] : kd[k - 1];
      const d = dtwFlat(q, L, tp.x, L, C, r, cutoff);
      if (d < nearest[li]) nearest[li] = d;
      if (d < kd[k - 1]) {
        let s = k - 1;
        while (s > 0 && kd[s - 1] > d) { kd[s] = kd[s - 1]; kl[s] = kl[s - 1]; s--; }
        kd[s] = d; kl[s] = li;
      }
    }
    const w = new Float64Array(nL);
    let wSum = 0;
    for (let s = 0; s < k; s++) { const v = 1 / (kd[s] + VOTE_EPS); w[kl[s]] += v; wSum += v; }
    const voted: number[] = [];
    for (let i = 0; i < nL; i++) if (w[i] > 0) voted.push(i);
    voted.sort((x, y) => w[y] - w[x] || nearest[x] - nearest[y] || x - y);
    const best = voted[0];
    let dBest = Infinity;
    for (let i = 0; i < nL; i++) if (nearest[i] < dBest) dBest = nearest[i];
    const T = SEPARATION_TAU * dBest + 1e-12;
    let z = 0;
    for (let i = 0; i < nL; i++) z += Math.exp(-(nearest[i] - dBest) / T);
    const sep = Math.exp(-(nearest[best] - dBest) / T) / z;
    const top = voted.slice(0, 3).map((i) => ({ label: this.labels[i], score: (w[i] / wSum) * sep }));
    const label = this.labels[best];
    const confidence = top[0].score;
    return { label, confidence, accepted: label !== NONE && confidence >= this.threshold, top };
  }

  toJSON(): DtwKnnModelJSON {
    const { C } = this;
    const L = this.opts.L;
    return {
      kind: 'dtw-knn',
      v: 1,
      opts: { ...this.opts, channels: [...this.opts.channels], threshold: this.threshold },
      norm: { mean: [...this.norm.mean], std: [...this.norm.std] },
      labels: [...this.labels],
      templates: this.tpl.map((t) => ({
        label: t.label,
        x: Array.from({ length: C }, (_, c) => Array.from({ length: L }, (_, i) => f32num(t.x[i * C + c]))),
      })),
    };
  }
}

/** Fits norm stats on `clips` (deduped by id) and stores every clip as a template. */
export function trainModel(clips: Clip[], opts?: DtwKnnOptions): DtwKnn {
  const o = resolveOpts(opts);
  const cs = dedupeById(clips);
  const raws = cs.map((c) => preprocessRaw(c.samples, o));
  return fromRaw(cs.map((c) => c.label), raws, o);
}

/** Builds a model from step 1..4 outputs (lets evaluate reuse preprocessing across folds). */
export function fromRaw(labels: string[], raws: Float64Array[][], o: Required<DtwKnnOptions>): DtwKnn {
  const norm = computeNorm(raws, o.norm, o.channels.length);
  return new DtwKnn(o, norm, raws.map((r, i) => ({ label: labels[i], x: toF32(applyNorm(r, o.norm, norm)) })));
}

export function loadModelJSON(json: DtwKnnModelJSON): DtwKnn {
  if (!json || json.kind !== 'dtw-knn' || json.v !== 1) throw new Error('ml.loadModel: not a dtw-knn v1 model');
  if (!json.norm || !Array.isArray(json.norm.mean) || !Array.isArray(json.norm.std)) throw new Error('ml.loadModel: bad norm');
  if (!Array.isArray(json.templates)) throw new Error('ml.loadModel: bad templates');
  return new DtwKnn(resolveOpts(json.opts), json.norm, json.templates);
}
