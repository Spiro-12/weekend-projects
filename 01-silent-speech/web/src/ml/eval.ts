// Cross validation for the DTW + kNN model (PROTOCOL.md §6).
// loo  = leave one clip out. loso = leave one session out (session = clip.session).
// Clips are deduped by id first. Norm stats always come from the training fold only.
//
// LOO shortcut: rebuilding each fold's dRef (the model's reference distance, knn.ts) from scratch costs
// O(N^2 / classes) DTWs per fold, O(N^3) in total. Instead LOO computes the same class distances once,
// keeps each clip's two nearest same class distances, and gives fold i the median of "nearest, or second
// nearest when the nearest is clip i", in O(N log N) per fold with no DTW. Those distances use norm stats
// from ALL clips (the held out one included). With norm 'global' they are rescaled to the fold's stats to
// first order: each channel's squared differences scale by (std_all / std_fold)^2, and dRef is multiplied by
// the mean of that over channels ('clip' norm needs no rescale). dRef only scales confidence, it never
// changes a label, and the label path (templates, query, norm) is still the exact per fold one.
// Measured gap to the exact path: same labels; confidence within 0.003 on the 120 clip fixture and on a
// real 17 clip recording, within ~0.04 to 0.1 on a 15 clip pilot (sets <= EXACT_LOO_MAX use the exact path anyway). LOSO stays exact throughout.
import type { Clip, DtwKnnOptions, Metrics, NormStats } from '../core/contracts';
import { NONE } from '../core/contracts';
import { bandRadius, dtwFlat, interleave } from './dtw';
import { dedupeById, finiteMedian, fromRaw, sortLabels, trainModel } from './knn';
import { applyNorm, computeNorm, preprocessRaw, resolveOpts, toF32 } from './preprocess';

export interface FoldResult { id: string; label: string; predicted: string; confidence: number; accepted: boolean; ms: number }

/**
 * For every clip: its nearest and second nearest same class distance (Infinity when missing) and the index
 * of the nearest, with all clips normalized by `norm` (all clip stats). Exact, with early abandon.
 */
export function twoNearestSameClass(labels: string[], raws: Float64Array[][], o: Required<DtwKnnOptions>): { d1: Float64Array; i1: Int32Array; d2: Float64Array; norm: NormStats } {
  const N = raws.length, C = o.channels.length, L = o.L, r = bandRadius(o.band, o.L);
  const norm = computeNorm(raws, o.norm, C);
  const X = raws.map((x) => interleave(toF32(applyNorm(x, o.norm, norm))));
  const d1 = new Float64Array(N).fill(Infinity), d2 = new Float64Array(N).fill(Infinity);
  const i1 = new Int32Array(N).fill(-1);
  const offer = (t: number, d: number, from: number) => {
    if (d < d1[t]) { d2[t] = d1[t]; d1[t] = d; i1[t] = from; } else if (d < d2[t]) d2[t] = d;
  };
  for (let a = 0; a < N; a++) {
    for (let b = a + 1; b < N; b++) {
      if (labels[a] !== labels[b]) continue;
      // a pair farther than both second nearests changes nothing
      const d = dtwFlat(X[a], L, X[b], L, C, r, d2[a] > d2[b] ? d2[a] : d2[b]);
      offer(a, d, b);
      offer(b, d, a);
    }
  }
  return { d1, i1, d2, norm };
}

/**
 * Every held out prediction, in clip order (after dedupe).
 * exactLoo: rebuild each LOO fold's dRef from scratch (slow, O(N^3); for tests). LOSO is always exact.
 * Small sets (<= EXACT_LOO_MAX clips) always use the exact path: it is cheap there and the shortcut's
 * confidence error is largest on tiny data (up to ~0.1 on a 15 clip pilot at L = 48).
 */
export const EXACT_LOO_MAX = 60;

export function crossValidate(clips: Clip[], opts: DtwKnnOptions, protocol: 'loo' | 'loso', exactLoo = false): FoldResult[] {
  const o = resolveOpts(opts);
  const cs = dedupeById(clips);
  if (cs.length < 2) throw new Error('ml.evaluate: need at least 2 clips');
  const groups = cs.map((c, i) => (protocol === 'loo' ? String(i) : (c.session ?? '')));
  const folds = [...new Set(groups)];
  if (protocol === 'loso' && folds.length < 2) throw new Error('ml.evaluate: loso needs clips from at least 2 sessions');
  // Steps 0..4 don't depend on the fold, so run them once (step 0 by each clip's own loc). Step 5 (norm) is refit per fold.
  const raws = cs.map((c) => preprocessRaw(c.samples, o, c.loc));
  const labels = cs.map((c) => c.label);
  const near = protocol === 'loo' && !exactLoo && cs.length > EXACT_LOO_MAX ? twoNearestSameClass(labels, raws, o) : null;
  const out: FoldResult[] = new Array(cs.length);
  const foldNn = new Float64Array(cs.length);
  for (const f of folds) {
    const trainIdx: number[] = [], testIdx: number[] = [];
    groups.forEach((g, i) => (g === f ? testIdx : trainIdx).push(i));
    const trainRaws = trainIdx.map((i) => raws[i]);
    const norm = computeNorm(trainRaws, o.norm, o.channels.length);
    let dRef: number | null | undefined; // undefined = let the model compute it exactly
    if (near) {
      const held = testIdx[0];
      trainIdx.forEach((t, j) => { foldNn[j] = near.i1[t] === held ? near.d2[t] : near.d1[t]; });
      dRef = finiteMedian(foldNn.subarray(0, trainIdx.length));
      if (dRef !== null && o.norm === 'global') {
        let s = 0;
        for (let c = 0; c < norm.std.length; c++) s += (near.norm.std[c] / norm.std[c]) ** 2;
        dRef *= s / norm.std.length;
      }
    }
    const model = fromRaw(trainIdx.map((i) => labels[i]), trainRaws, o, { dRef, norm });
    for (const i of testIdx) {
      const p = model.predict(cs[i].samples, { loc: cs[i].loc }); // full path (preprocess + DTW), timed
      out[i] = { id: cs[i].id, label: cs[i].label, predicted: p.label, confidence: p.confidence, accepted: p.accepted, ms: p.ms };
    }
  }
  return out;
}

/**
 * One fixed split: train on `train`, predict every clip of `test` (each with its own `loc`), in test order.
 * Both are deduped by id; a clip in both is an error (it would be tested on itself). Used for the cross bud score.
 */
export function holdOut(train: Clip[], test: Clip[], opts: DtwKnnOptions): FoldResult[] {
  const tr = dedupeById(train), te = dedupeById(test);
  const ids = new Set(tr.map((c) => c.id));
  if (te.some((c) => ids.has(c.id))) throw new Error('ml.holdOut: a test clip is also a training clip');
  const model = trainModel(tr, opts);
  return te.map((c) => {
    const p = model.predict(c.samples, { loc: c.loc });
    return { id: c.id, label: c.label, predicted: p.label, confidence: p.confidence, accepted: p.accepted, ms: p.ms };
  });
}

/** Metrics from held out predictions. Labels = every true or predicted label, sorted. */
export function metricsFrom(res: FoldResult[], protocol: 'loo' | 'loso', params: Record<string, unknown>): Metrics {
  const labels = sortLabels([...res.map((r) => r.label), ...res.map((r) => r.predicted)]);
  const ix = new Map(labels.map((l, i) => [l, i]));
  const confusion = labels.map(() => new Array<number>(labels.length).fill(0));
  let correct = 0, noneN = 0, noneFA = 0, ms = 0;
  for (const r of res) {
    confusion[ix.get(r.label)!][ix.get(r.predicted)!]++;
    if (r.label === r.predicted) correct++;
    if (r.label === NONE) { noneN++; if (r.accepted) noneFA++; }
    ms += r.ms;
  }
  // Macro F1 like sklearn f1_score(average='macro'): mean over the union of true and predicted labels,
  // F1 = 2TP / (2TP + FP + FN) = 2TP / (support + predicted).
  const f1s = labels.map((_, i) => {
    const support = confusion[i].reduce((a, b) => a + b, 0);
    const predicted = confusion.reduce((a, row) => a + row[i], 0);
    return (2 * confusion[i][i]) / (support + predicted);
  });
  return {
    model: 'dtw-knn',
    protocol,
    nClips: res.length,
    labels,
    accuracy: res.length ? correct / res.length : 0,
    macroF1: f1s.length ? f1s.reduce((a, b) => a + b, 0) / f1s.length : 0,
    confusion,
    noneFalseAcceptRate: noneN ? noneFA / noneN : 0,
    params,
    inferMsPerClip: res.length ? ms / res.length : 0,
    generatedAt: new Date().toISOString(),
  };
}

export function evaluateModel(clips: Clip[], opts: DtwKnnOptions, protocol: 'loo' | 'loso'): Metrics {
  if (protocol !== 'loo' && protocol !== 'loso') throw new Error(`ml.evaluate: unknown protocol ${String(protocol)}`);
  const o = resolveOpts(opts);
  const res = crossValidate(clips, o, protocol);
  const nSessions = new Set(dedupeById(clips).map((c) => c.session ?? '')).size;
  return metricsFrom(res, protocol, { ...o, radius: bandRadius(o.band, o.L), nSessions });
}
