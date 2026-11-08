// Web Worker pool runner (browser). min(cores − 1, 8) workers; results cached by settings hash; the same scenario
// is never run twice at once.
import type { RunResult, Scenario } from '../../contracts/types.ts';
import { runKey } from '../settings.ts';
import type { EvaluateOptions, Runner } from './types.ts';
import type { RunReply, RunRequest } from './worker.ts';

export function createWorkerRunner(size = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1))): Runner {
  const workers: Worker[] = [];
  const idle: Worker[] = [];
  const queue: { req: RunRequest; resolve: (r: RunResult) => void; reject: (e: Error) => void }[] = [];
  const inflight = new Map<number, { resolve: (r: RunResult) => void; reject: (e: Error) => void; worker: Worker }>();
  const cache = new Map<string, RunResult>();
  const running = new Map<string, Promise<RunResult>>();
  let nextId = 1;
  const key = (s: Scenario, o?: EvaluateOptions) => runKey(s) + (o?.saturate ? '-sat' : '');

  const spawn = () => {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<RunReply>) => {
      const job = inflight.get(e.data.id);
      inflight.delete(e.data.id);
      idle.push(w);
      if (job) {
        if (e.data.ok) job.resolve(e.data.result);
        else job.reject(new Error(e.data.error));
      }
      pump();
    };
    // A crashed worker: fail its job (so the UI doesn't wait forever), replace the worker, keep going.
    w.onerror = (e) => {
      console.error('[runner worker]', e.message);
      e.preventDefault();
      for (const [id, job] of [...inflight]) {
        if (job.worker !== w) continue;
        inflight.delete(id);
        job.reject(new Error(`runner worker crashed: ${e.message}`));
      }
      w.terminate();
      workers.splice(workers.indexOf(w), 1);
      const i = idle.indexOf(w);
      if (i >= 0) idle.splice(i, 1);
      pump();
    };
    workers.push(w);
    idle.push(w);
  };
  const pump = () => {
    while (queue.length && (idle.length || workers.length < size)) {
      if (!idle.length) spawn();
      const w = idle.pop()!;
      const job = queue.shift()!;
      inflight.set(job.req.id, { resolve: job.resolve, reject: job.reject, worker: w });
      w.postMessage(job.req);
    }
  };

  return {
    kind: 'worker',
    evaluate(s, opts) {
      const k = key(s, opts);
      const hit = cache.get(k);
      if (hit) return Promise.resolve(hit);
      const run = running.get(k);
      if (run) return run;
      const p = new Promise<RunResult>((resolve, reject) => {
        queue.push({ req: { id: nextId++, scenario: s, saturate: opts?.saturate }, resolve, reject });
        pump();
      })
        .then((r) => {
          cache.set(k, r);
          return r;
        })
        .finally(() => running.delete(k)); // a failed run can be retried
      running.set(k, p);
      return p;
    },
    peek: (s, o) => cache.get(key(s, o)),
    dispose() {
      for (const w of workers) w.terminate();
      workers.length = 0;
      idle.length = 0;
      cache.clear();
    },
  };
}
