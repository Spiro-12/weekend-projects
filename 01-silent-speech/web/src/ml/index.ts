// Classifier API (frozen). Track D implements these. See PROTOCOL.md section "Classifier".
import type {
  Clip, Classifier, DtwKnnModelJSON, DtwKnnOptions, Metrics, MotionSample, NormStats,
} from '../core/contracts';

export interface DtwKnnModel extends Classifier {
  threshold: number;
  add(c: Clip): void;
  toJSON(): DtwKnnModelJSON;
}

const todo = (name: string): never => { throw new Error(`ml.${name}: not implemented yet (Track D)`); };

export function train(clips: Clip[], opts?: DtwKnnOptions): DtwKnnModel { void clips; void opts; return todo('train'); }
export function loadModel(json: DtwKnnModelJSON): DtwKnnModel { void json; return todo('loadModel'); }
export function evaluate(clips: Clip[], opts: DtwKnnOptions, protocol: 'loo' | 'loso'): Metrics {
  void clips; void opts; void protocol; return todo('evaluate');
}
/** Returns [channel][L] after the spec v1 pipeline. */
export function preprocess(s: MotionSample[], opts: DtwKnnOptions, norm?: NormStats): Float32Array[] {
  void s; void opts; void norm; return todo('preprocess');
}
export function dtw(a: Float32Array[], b: Float32Array[], radius: number): number { void a; void b; void radius; return todo('dtw'); }
