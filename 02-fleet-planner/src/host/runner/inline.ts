// Inline runner (Node and tests): same results as the worker pool, run on the calling thread.
import type { KpiRecorderFactory, RunResult, Scenario } from '../../contracts/types.ts';
import type { SimData, SimImpl } from '../../sim/index.ts';
import { settingsHash } from '../settings.ts';
import { runScenario } from './run.ts';
import type { EvaluateOptions, Runner } from './types.ts';

export function createInlineRunner(dataFor: (s: Scenario) => SimData, recorder: KpiRecorderFactory, impl?: SimImpl): Runner {
  const cache = new Map<string, RunResult>();
  const key = (s: Scenario, o?: EvaluateOptions) => settingsHash(s) + (o?.saturate ? '-sat' : '');
  return {
    kind: 'inline',
    async evaluate(s, opts) {
      const k = key(s, opts);
      let r = cache.get(k);
      if (!r) {
        r = runScenario(s, dataFor(s), recorder, { ...opts, impl });
        cache.set(k, r);
      }
      return r;
    },
    peek: (s, o) => cache.get(key(s, o)),
    dispose: () => cache.clear(),
  };
}
