// Builds the demo model (demo-model.ts) in a Web Worker: making the takes and training takes ~200 to 400 ms
// cold in the browser, which would freeze the page right when someone switches to Recognize. The page
// only loads the finished model (~20 ms). Falls back to the main thread if workers fail or don't answer.
import type { ClassDef } from '../../core/contracts';
import { buildDemoJSON, type DemoResponse } from './demo-model';

export const DEMO_TIMEOUT_MS = 20_000;
export type DemoBuilt = DemoResponse & { where: 'worker' | 'main' };

const defaultWorker = () => new Worker(new URL('./demo-worker.ts', import.meta.url), { type: 'module' });

/** Never rejects. */
export function buildDemoModelJSON(
  classes: ClassDef[], o: { makeWorker?: () => Worker; timeoutMs?: number; build?: typeof buildDemoJSON } = {},
): Promise<DemoBuilt> {
  const build = o.build ?? buildDemoJSON; // tests pass a cheap one
  return new Promise((resolve) => {
    let w: Worker | null = null;
    let done = false;
    const finish = (r: DemoResponse, where: DemoBuilt['where']) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      w?.terminate();
      resolve({ ...r, where });
    };
    const inline = (why: string, e?: unknown) => {
      console.warn(`[result] demo model worker ${why}; building it on the main thread`, e ?? '');
      setTimeout(() => { if (!done) finish(build(classes), 'main'); }, 0);
    };
    const timer = setTimeout(() => inline('did not answer'), o.timeoutMs ?? DEMO_TIMEOUT_MS);
    try {
      if (!o.makeWorker && typeof Worker === 'undefined') throw new Error('no Worker here');
      w = (o.makeWorker ?? defaultWorker)();
      w.onmessage = (e: MessageEvent<DemoResponse>) => finish(e.data, 'worker');
      w.onerror = (e) => { e.preventDefault?.(); inline('failed', e); };
      w.postMessage({ classes: classes.map((c) => ({ ...c })) });
    } catch (e) {
      inline('is unavailable', e);
    }
  });
}
