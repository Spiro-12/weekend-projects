// The part of live accuracy shared by the worker and the main thread fallback (no Worker code here,
// so the worker bundle doesn't pull in itself).
import type { Clip, Metrics } from '../../core/contracts';
import { evaluate } from '../../ml/index';

export interface EvalRequest { id: number; clips: Clip[]; loso: boolean }
export type EvalResponse =
  | { id: number; ok: true; loo: Metrics; loso: Metrics | null }
  | { id: number; ok: false; error: string };

/** Never throws. */
export function runEval(req: EvalRequest): EvalResponse {
  try {
    const loo = evaluate(req.clips, {}, 'loo');
    const loso = req.loso ? evaluate(req.clips, {}, 'loso') : null;
    return { id: req.id, ok: true, loo, loso };
  } catch (e) {
    return { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** ml/index.ts throws this until Track D's classifier is in. */
export const isNotImplemented = (msg: string) => /not implemented/i.test(msg);
