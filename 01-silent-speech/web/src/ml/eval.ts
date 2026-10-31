// Cross validation for the DTW + kNN model (PROTOCOL.md §6).
// loo  = leave one clip out. loso = leave one session out (session = clip.session).
// Clips are deduped by id first. Norm stats always come from the training fold only.
import type { Clip, DtwKnnOptions, Metrics } from '../core/contracts';
import { NONE } from '../core/contracts';
import { bandRadius } from './dtw';
import { dedupeById, fromRaw, sortLabels } from './knn';
import { preprocessRaw, resolveOpts } from './preprocess';

export interface FoldResult { id: string; label: string; predicted: string; confidence: number; accepted: boolean; ms: number }

/** Every held out prediction, in clip order (after dedupe). */
export function crossValidate(clips: Clip[], opts: DtwKnnOptions, protocol: 'loo' | 'loso'): FoldResult[] {
  const o = resolveOpts(opts);
  const cs = dedupeById(clips);
  if (cs.length < 2) throw new Error('ml.evaluate: need at least 2 clips');
  const groups = cs.map((c, i) => (protocol === 'loo' ? String(i) : (c.session ?? '')));
  const folds = [...new Set(groups)];
  if (protocol === 'loso' && folds.length < 2) throw new Error('ml.evaluate: loso needs clips from at least 2 sessions');
  // Steps 1..4 don't depend on the fold, so run them once. Step 5 (norm) is refit per fold.
  const raws = cs.map((c) => preprocessRaw(c.samples, o));
  const out: FoldResult[] = new Array(cs.length);
  for (const f of folds) {
    const trainIdx: number[] = [], testIdx: number[] = [];
    groups.forEach((g, i) => (g === f ? testIdx : trainIdx).push(i));
    const model = fromRaw(trainIdx.map((i) => cs[i].label), trainIdx.map((i) => raws[i]), o);
    for (const i of testIdx) {
      const p = model.predict(cs[i].samples); // full path (preprocess + DTW), timed
      out[i] = { id: cs[i].id, label: cs[i].label, predicted: p.label, confidence: p.confidence, accepted: p.accepted, ms: p.ms };
    }
  }
  return out;
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
