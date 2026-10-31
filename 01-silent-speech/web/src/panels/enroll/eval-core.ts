// The part of live accuracy shared by the worker and the main thread fallback (no Worker code here,
// so the worker bundle doesn't pull in itself).
import type { Clip, Metrics } from '../../core/contracts';
import { evaluate } from '../../ml/index';

/** `loo`: leave one clip out (current session). `loso`: leave one session out. null = don't run it. */
export interface EvalRequest { id: number; loo: Clip[] | null; loso: Clip[] | null }
export interface EvalResult { loo: Metrics | null; loso: Metrics | null; skipped: ('loo' | 'loso')[] }
export type EvalResponse = { id: number; ok: true; res: EvalResult } | { id: number; ok: false; error: string };

/** Never throws. Sets bigger than `cap` clips are skipped (the main thread fallback uses this). */
export function runEval(req: EvalRequest, cap = Infinity): EvalResponse {
  try {
    const res: EvalResult = { loo: null, loso: null, skipped: [] };
    for (const p of ['loo', 'loso'] as const) {
      const clips = req[p];
      if (!clips) continue;
      if (clips.length > cap) { res.skipped.push(p); continue; }
      res[p] = evaluate(clips, {}, p);
    }
    return { id: req.id, ok: true, res };
  } catch (e) {
    return { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** ml/index.ts throws this until Track D's classifier is in. */
export const isNotImplemented = (msg: string) => /not implemented/i.test(msg);
