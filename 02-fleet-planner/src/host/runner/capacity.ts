// Keeps up = enough capacity AND a flat backlog (PROTOCOL §6). Wraps any runner: a demand run also fetches the same
// settings' capacity run (saturate; cached like any other run) and merges the two. Capacity decides: it does not depend
// on how the order stream happened to bunch up in the 2-hour window, so a crew short by 3% is short, and the backlog
// trend (≤ KEEPS_UP_PCT, from the KPI recorder) stays as a second check on the demand run itself.
import type { RunResult, Scenario } from '../../contracts/types.ts';
import { runKey } from '../settings.ts';
import type { EvaluateOptions, Runner } from './types.ts';

/** The demand run with the capacity run's verdict folded in. */
export function mergeCapacity(s: Scenario, demand: RunResult, capacity: RunResult): RunResult {
  const cap = capacity.kpis.capacityOph ?? capacity.kpis.oph;
  return { ...demand, kpis: { ...demand.kpis, capacityOph: cap, keepsUp: demand.kpis.keepsUp && cap >= s.orders.perHour } };
}

export function withCapacity(inner: Runner): Runner {
  const merged = new Map<string, RunResult>();
  const isDemand = (s: Scenario, o?: EvaluateOptions) => !o?.saturate && s.orders.mode !== 'saturate';
  const remember = (s: Scenario, d: RunResult, c: RunResult) => {
    const k = runKey(s);
    let m = merged.get(k);
    if (!m || m.hash !== d.hash) {
      m = mergeCapacity(s, d, c);
      merged.set(k, m);
    }
    return m;
  };
  return {
    kind: inner.kind,
    async evaluate(s, opts) {
      if (!isDemand(s, opts)) return inner.evaluate(s, opts);
      const [d, c] = await Promise.all([inner.evaluate(s), inner.evaluate(s, { saturate: true })]);
      return remember(s, d, c);
    },
    peek(s, opts) {
      if (!isDemand(s, opts)) return inner.peek(s, opts);
      const d = inner.peek(s);
      const c = inner.peek(s, { saturate: true });
      return d && c ? remember(s, d, c) : undefined;
    },
    dispose() {
      merged.clear();
      inner.dispose();
    },
  };
}
