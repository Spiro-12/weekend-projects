// Classifier API (frozen). Track D implements these. See PROTOCOL.md section "Classifier".
// Implementation: preprocess.ts (spec v1 §5), dtw.ts, knn.ts (model + how confidence/top are defined), eval.ts (loo / loso).
import type {
  BudLocation, Clip, Classifier, DtwKnnModelJSON, DtwKnnOptions, Metrics, MotionSample, NormStats,
} from '../core/contracts';
import { dtw as dtwImpl } from './dtw';
import { evaluateModel } from './eval';
import { loadModelJSON, trainModel } from './knn';
import { preprocess as preprocessImpl } from './preprocess';

export interface DtwKnnModel extends Classifier {
  threshold: number;
  add(c: Clip): void;
  toJSON(): DtwKnnModelJSON;
}

/**
 * Dedupes by clip id, fits norm stats on all clips, keeps every clip as a template.
 * Each clip's `loc` is its bud (PROTOCOL §5 step 0): with budNorm 'mirror', `right` clips are mirrored into the
 * left bud frame before anything else, so templates are always stored in the left bud frame. A clip without
 * `loc` is taken as is (left frame): callers fill it in (mergeDatasets does, from the file's device.loc).
 */
export function train(clips: Clip[], opts?: DtwKnnOptions): DtwKnnModel { return trainModel(clips, opts); }
/** Templates in the JSON are already preprocessed, so loading is instant. */
export function loadModel(json: DtwKnnModelJSON): DtwKnnModel { return loadModelJSON(json); }
/** Leave one clip out or leave one session out. Dedupes by id; norm stats from the training fold only. */
export function evaluate(clips: Clip[], opts: DtwKnnOptions, protocol: 'loo' | 'loso'): Metrics {
  return evaluateModel(clips, opts, protocol);
}
/**
 * Returns [channel][L] after the spec v1 pipeline.
 * `loc` (optional): the clip's bud for step 0 (mirrors `right` when budNorm is 'mirror'; anything else: as is).
 * With `norm`, step 5 runs in `opts.norm` mode ('global': (x - mean) / std; 'clip': per clip z score with
 * `norm.std` as the per channel std floor, `norm.mean` unused). Without `norm`, stops after step 4.
 */
export function preprocess(s: MotionSample[], opts: DtwKnnOptions, norm?: NormStats, loc?: BudLocation): Float32Array[] {
  return preprocessImpl(s, opts, norm, loc);
}
/** Total DTW cost: dependent, squared Euclidean summed over channels, Sakoe-Chiba radius in samples. */
export function dtw(a: Float32Array[], b: Float32Array[], radius: number): number { return dtwImpl(a, b, radius); }
