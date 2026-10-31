// Live accuracy for the enroll panel. Runs ml.evaluate in a Web Worker, so a big leave one out
// check never freezes the page (a frozen page would delay the next Space press and cut the
// start of the next clip). Falls back to the main thread if workers are unavailable.
import type { Clip, Metrics } from '../../core/contracts';
import { runEval, type EvalRequest, type EvalResponse } from './eval-core';

export interface EvalResult { loo: Metrics; loso: Metrics | null }

type Pending = { req: EvalRequest; res: (r: EvalResult) => void; rej: (e: Error) => void };

export class Evaluator {
  private worker: Worker | null = null;
  private broken = typeof Worker === 'undefined';
  private seq = 0;
  private pending = new Map<number, Pending>();

  run(clips: Clip[], loso: boolean): Promise<EvalResult> {
    // Only what evaluate needs: keeps the copy to the worker small.
    const slim = clips.map((c) => ({ id: c.id, label: c.label, session: c.session, samples: c.samples }));
    const req: EvalRequest = { id: ++this.seq, clips: slim, loso };
    return new Promise((res, rej) => {
      const p: Pending = { req, res, rej };
      const w = this.getWorker();
      if (!w) { this.inline(p); return; }
      this.pending.set(req.id, p);
      w.postMessage(req);
    });
  }

  private getWorker(): Worker | null {
    if (this.worker || this.broken) return this.worker;
    try {
      const w = new Worker(new URL('./accuracy-worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<EvalResponse>) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        this.settle(p, e.data);
      };
      w.onerror = (e) => { // the worker script failed to load: do it on the main thread instead
        e.preventDefault?.();
        console.warn('[enroll] accuracy worker failed, using the main thread', e);
        this.broken = true;
        w.terminate();
        this.worker = null;
        const left = [...this.pending.values()];
        this.pending.clear();
        left.forEach((p) => this.inline(p));
      };
      this.worker = w;
    } catch (e) {
      console.warn('[enroll] no accuracy worker', e);
      this.broken = true;
    }
    return this.worker;
  }

  private inline(p: Pending) {
    setTimeout(() => this.settle(p, runEval(p.req)), 0);
  }

  private settle(p: Pending, r: EvalResponse) {
    if (r.ok) p.res({ loo: r.loo, loso: r.loso });
    else p.rej(new Error(r.error));
  }
}
