// DTW + kNN classifier (PROTOCOL.md §6).
//
// Prediction:
//   1. Preprocess the clip (spec v1, the model's norm stats) and DTW it against every template.
//   2. Label = distance weighted vote of the k nearest templates (default k = 1), weight 1 / (d + 1e-9)
//      (same as the Python `dtw-py` cross check). Ties: the class with the nearer template wins.
//   3. Reference distance dRef (a property of the model, kept up to date as templates are added): the
//      median, over templates, of the DTW distance to the nearest OTHER template of the same class, i.e.
//      "how far apart two takes of the same sentence usually are". Undefined when no class has 2 templates.
//      (LOO cross validation hands each fold a dRef from all clip norm stats instead, see eval.ts.)
//   4. Confidence = vote x separation, both in [0, 1]:
//      - vote       = the label's share of the k neighbour weights (always 1 for k = 1).
//      - separation = softmax with temperature T = 0.1 x dRef over every class's nearest distance d_c plus
//                     two virtual templates, read at the label:
//                     * "unknown" at 1.7 x dRef. A clip whose best match is well inside 1.7 x dRef (and well
//                       ahead of the other classes) scores high; at 1.7 x dRef it is at most 0.5; farther out
//                       it falls fast toward 0 (far from every template = not a sentence we know).
//                     * "stillness" at 1.25 x sum(q^2) = 1.25 x the DTW distance to the all zeros clip.
//                       It backs a 'none' answer and counts against all other labels. With norm 'global'
//                       (default) all zeros is the training mean, i.e. nothing moved, so a quiet clip is not
//                       accepted even by a model with no 'none' takes. With norm 'clip' every clip is z scored
//                       on its own, so sum(q^2) is about channels x L for any clip louder than the std floor:
//                       there it only catches clips quieter than the floor and is otherwise inert.
//      Limits: distance is the only cue. A different sentence that lands within ~1.7 x dRef of a template is
//      still accepted (synthetic fixture: a text_mom + none model accepts about 7% of the 6 other sentences), and a
//      model trained on one sitting is stricter on other sittings (their takes sit farther than dRef).
//      Unsafe models (fewer than 2 classes, or dRef undefined / 0) get the old scale free softmax
//      (T = 0.1 x best distance, no virtual templates) capped at threshold / 2, so they never accept at a
//      positive threshold.
//   5. top (up to 3, score desc): top[0] = { label, confidence }. top[1..2] = the next classes by their own
//      separation score (same softmax, read at that class), never above top[0].score.
//   6. accepted = label !== 'none' && confidence >= threshold.
import type { Clip, DtwKnnModelJSON, DtwKnnOptions, MotionSample, NormStats, Prediction } from '../core/contracts';
import { NONE } from '../core/contracts';
import { bandRadius, dtwFlat, interleave } from './dtw';
import { applyNorm, applyNormInterleaved, computeNorm, preprocessRaw, resolveOpts, toF32 } from './preprocess';
import type { DtwKnnModel } from './index';

/** Softmax temperature as a fraction of dRef (see the header). */
export const SEPARATION_TAU = 0.1;
/** The virtual "unknown" template sits at this multiple of dRef (see the header). */
export const UNKNOWN_AT = 1.7;
/** The virtual "stillness" template sits at this multiple of the clip's energy sum(q^2) (see the header). */
export const SILENCE_AT = 1.25;
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
  private nnSame: number[] = []; // per template: DTW to the nearest other template of its class (Infinity if alone)
  private nnKnown = true; // false when dRef was handed in (nnSame not computed); referenceDistance() fills it on demand
  private dRef: number | null | undefined; // median of the finite nnSame; undefined = stale

  /**
   * templates: already normalized, [channel][L].
   * internal (used by fromRaw / cross validation):
   * - flat: more templates, already normalized and interleaved [L][channel] (trusted, not copied or checked).
   * - dRef: skip the same class pair distances and use this reference distance instead.
   *   A later add() drops it and recomputes everything exactly.
   */
  constructor(
    opts: Required<DtwKnnOptions>, norm: NormStats, templates: { label: string; x: ArrayLike<number>[] }[],
    internal: { flat?: { label: string; x: Float32Array }[]; dRef?: number | null } = {},
  ) {
    const { dRef } = internal;
    this.opts = { ...opts, channels: [...opts.channels] };
    this.threshold = opts.threshold;
    this.norm = { mean: [...norm.mean], std: [...norm.std] };
    this.C = opts.channels.length;
    this.radius = bandRadius(opts.band, opts.L);
    if (this.norm.mean.length !== this.C || this.norm.std.length !== this.C) {
      throw new Error(`ml: norm stats need ${this.C} channels`);
    }
    if (dRef !== undefined) this.nnKnown = false;
    for (const t of templates) this.push(t.label, t.x);
    for (const t of internal.flat ?? []) this.pushFlat(t.label, t.x);
    if (dRef !== undefined) this.dRef = dRef;
  }

  private push(label: string, x: ArrayLike<number>[]): void {
    if (typeof label !== 'string' || !label) throw new Error('ml: template without a label');
    if (x.length !== this.C) throw new Error(`ml: template has ${x.length} channels, model has ${this.C}`);
    for (const row of x) {
      if (row.length !== this.opts.L) throw new Error(`ml: template length ${row.length}, model L is ${this.opts.L}`);
      for (let i = 0; i < row.length; i++) if (!Number.isFinite(row[i])) throw new Error('ml: template has a non finite value');
    }
    this.pushFlat(label, interleave(x));
  }

  private pushFlat(label: string, x: Float32Array): void {
    if (typeof label !== 'string' || !label) throw new Error('ml: template without a label');
    if (x.length !== this.opts.L * this.C) throw new Error('ml: template has the wrong shape');
    this.tpl.push({ label, x });
    this.nnSame.push(Infinity);
    if (this.nnKnown) this.linkNearest(this.tpl.length - 1);
    this.dRef = undefined;
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

  /** Same as prep, interleaved [L][channel] (what classify takes). */
  prepFlat(samples: MotionSample[]): Float32Array {
    return applyNormInterleaved(preprocessRaw(samples, this.opts), this.opts.norm, this.norm);
  }

  /**
   * Updates nnSame for template t against the templates before it. Each same class pair is computed once
   * (DTW is symmetric), with an exact early abandon (a pair farther than both current nearests changes nothing).
   */
  private linkNearest(t: number): void {
    const { C, radius: r } = this;
    const L = this.opts.L;
    const me = this.tpl[t];
    for (let u = 0; u < t; u++) {
      if (this.tpl[u].label !== me.label) continue;
      const cutoff = this.nnSame[t] > this.nnSame[u] ? this.nnSame[t] : this.nnSame[u];
      const d = dtwFlat(me.x, L, this.tpl[u].x, L, C, r, cutoff);
      if (d < this.nnSame[t]) this.nnSame[t] = d;
      if (d < this.nnSame[u]) this.nnSame[u] = d;
    }
  }

  /**
   * dRef: median over templates of the DTW distance to the nearest other template of the same class
   * (leave one out inside the templates). null when no class has 2 templates. Kept up to date by add().
   */
  referenceDistance(): number | null {
    if (this.dRef !== undefined) return this.dRef;
    if (!this.nnKnown) {
      this.nnSame.fill(Infinity);
      for (let t = 0; t < this.tpl.length; t++) this.linkNearest(t);
      this.nnKnown = true;
    }
    this.dRef = finiteMedian(this.nnSame);
    return this.dRef;
  }

  /** Adds one clip as a template, normalized with the model's current stats (stats are not recomputed). */
  add(c: Clip): void {
    this.push(c.label, this.prep(c.samples));
  }

  predict(samples: MotionSample[]): Prediction {
    const t0 = now();
    const p = this.classify(this.prepFlat(samples));
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
    // Separation: stable softmax of -d / T over every class's nearest distance plus, for safe models,
    // the virtual "unknown" (UNKNOWN_AT x dRef) and "stillness" (SILENCE_AT x sum(q^2)) templates.
    const ref = this.referenceDistance();
    const safe = nL >= 2 && ref !== null && ref > 0 && Number.isFinite(ref);
    const T = safe ? SEPARATION_TAU * ref : SEPARATION_TAU * dBest + 1e-12; // unsafe: scale free, then capped
    const dUnknown = safe ? UNKNOWN_AT * ref : Infinity;
    let energy = 0; // DTW to the all zeros clip (the training mean: nothing moved) is exactly sum(q^2)
    for (let i = 0; i < q.length; i++) energy += q[i] * q[i];
    const dStill = safe ? SILENCE_AT * energy : Infinity;
    const m = -Math.min(dBest, dUnknown, dStill) / T; // largest logit
    const share = (d: number) => Math.exp(-d / T - m);
    let z = share(dUnknown) + share(dStill);
    for (let i = 0; i < nL; i++) z += share(nearest[i]);
    const sepOf = (i: number) => share(nearest[i]) / z;
    const label = this.labels[best];
    // Stillness is a virtual 'none' take: it backs a 'none' answer and counts against every other label.
    let confidence = (w[best] / wSum) * (sepOf(best) + (label === NONE ? share(dStill) / z : 0));
    if (!safe) confidence = Math.min(confidence, Math.max(0, this.threshold / 2));
    const rest = this.labels.map((_, i) => i).filter((i) => i !== best)
      .sort((x, y) => nearest[x] - nearest[y] || x - y).slice(0, 2);
    const top = [{ label, score: confidence }, ...rest.map((i) => ({ label: this.labels[i], score: Math.min(sepOf(i), confidence) }))];
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

/**
 * Builds a model from step 1..4 outputs (lets evaluate reuse preprocessing across folds).
 * internal.norm: norm stats already computed from exactly these raws. internal.dRef: see the constructor.
 */
export function fromRaw(
  labels: string[], raws: Float64Array[][], o: Required<DtwKnnOptions>,
  internal: { dRef?: number | null; norm?: NormStats } = {},
): DtwKnn {
  const norm = internal.norm ?? computeNorm(raws, o.norm, o.channels.length);
  const flat = raws.map((r, i) => ({ label: labels[i], x: applyNormInterleaved(r, o.norm, norm) }));
  return new DtwKnn(o, norm, [], { flat, dRef: internal.dRef });
}

/** Median of the finite values (null if none). Shared by the model and LOO cross validation. */
export function finiteMedian(v: ArrayLike<number>): number | null {
  const s = Float64Array.from(v).filter(Number.isFinite).sort();
  const h = s.length >> 1;
  return s.length === 0 ? null : s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

export function loadModelJSON(json: DtwKnnModelJSON): DtwKnn {
  if (!json || json.kind !== 'dtw-knn' || json.v !== 1) throw new Error('ml.loadModel: not a dtw-knn v1 model');
  if (!json.norm || !Array.isArray(json.norm.mean) || !Array.isArray(json.norm.std)) throw new Error('ml.loadModel: bad norm');
  if (!Array.isArray(json.templates)) throw new Error('ml.loadModel: bad templates');
  return new DtwKnn(resolveOpts(json.opts), json.norm, json.templates);
}
