// Live accuracy for the enroll panel. Runs ml.evaluate in a Web Worker, so a big check never freezes
// the page (a frozen page would delay the next Space press and cut the start of the next clip).
// Falls back to the main thread (only for small sets) if workers are unavailable. A worker that
// doesn't answer in time is killed, so the panel can't sit on "Checking…" forever.
import type { Clip } from '../../core/contracts';
import { runEval, type EvalRequest, type EvalResponse, type EvalResult } from './eval-core';

export type { EvalResult } from './eval-core';

/** Above this many clips per check, the main thread fallback skips it (it would freeze the page). */
export const INLINE_MAX = 150;
export const EVAL_TIMEOUT_MS = 45_000;

export interface EvaluatorOpts {
  makeWorker?: () => Worker; // tests inject a fake
  timeoutMs?: number;
  inlineMax?: number;
}

type Pending = { req: EvalRequest; res: (r: EvalResult) => void; rej: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

const defaultWorker = () => new Worker(new URL('./accuracy-worker.ts', import.meta.url), { type: 'module' });
const slim = (cs: Clip[] | null) => cs && cs.map((c) => ({ id: c.id, label: c.label, session: c.session, samples: c.samples }));

export class Evaluator {
  private worker: Worker | null = null;
  private broken: boolean;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private makeWorker: () => Worker;
  private timeoutMs: number;
  private inlineMax: number;

  constructor(o: EvaluatorOpts = {}) {
    this.makeWorker = o.makeWorker ?? defaultWorker;
    this.broken = !o.makeWorker && typeof Worker === 'undefined';
    this.timeoutMs = o.timeoutMs ?? EVAL_TIMEOUT_MS;
    this.inlineMax = o.inlineMax ?? INLINE_MAX;
  }

  /** Rejects with the classifier's error, or "timed out". */
  run(loo: Clip[] | null, loso: Clip[] | null): Promise<EvalResult> {
    const req: EvalRequest = { id: ++this.seq, loo: slim(loo), loso: slim(loso) };
    return new Promise((res, rej) => {
      const w = this.getWorker();
      if (!w) { setTimeout(() => this.settle({ res, rej }, runEval(req, this.inlineMax)), 0); return; }
      const timer = setTimeout(() => this.timeout(), this.timeoutMs);
      this.pending.set(req.id, { req, res, rej, timer });
      w.postMessage(req);
    });
  }

  private getWorker(): Worker | null {
    if (this.worker || this.broken) return this.worker;
    try {
      const w = this.makeWorker();
      w.onmessage = (e: MessageEvent<EvalResponse>) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        clearTimeout(p.timer);
        this.settle(p, e.data);
      };
      w.onerror = (e) => { // the worker script failed to load: do it on the main thread instead
        e.preventDefault?.();
        console.warn('[enroll] accuracy worker failed, using the main thread', e);
        this.broken = true;
        this.drop();
        const left = [...this.pending.values()];
        this.pending.clear();
        for (const p of left) { clearTimeout(p.timer); this.settle(p, runEval(p.req, this.inlineMax)); }
      };
      this.worker = w;
    } catch (e) {
      console.warn('[enroll] no accuracy worker', e);
      this.broken = true;
    }
    return this.worker;
  }

  /** No answer in time: kill the worker (a fresh one is made next run) and fail what was waiting. */
  private timeout() {
    console.warn('[enroll] accuracy worker timed out');
    this.drop();
    const left = [...this.pending.values()];
    this.pending.clear();
    for (const p of left) { clearTimeout(p.timer); p.rej(new Error('timed out')); }
  }

  private drop() {
    this.worker?.terminate();
    this.worker = null;
  }

  private settle(p: Pick<Pending, 'res' | 'rej'>, r: EvalResponse) {
    if (r.ok) p.res(r.res);
    else p.rej(new Error(r.error));
  }
}
