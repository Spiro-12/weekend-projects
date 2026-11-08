// withCapacity (PROTOCOL §6): keeps up = capacity ≥ demand AND a flat backlog. A stub inner runner returns chosen numbers.
import { describe, expect, it } from 'vitest';
import type { RunResult, Scenario } from '../../src/contracts/types.ts';
import { withCapacity } from '../../src/host/runner/capacity.ts';
import type { EvaluateOptions, Runner } from '../../src/host/runner/types.ts';
import { runKey } from '../../src/host/settings.ts';
import { defaultScenario, mkRun } from './econ/helpers.ts';

/** Inner runner: demand runs keep up on their own trend; capacity runs report `cap`. Caches like the real ones. */
function stub(cap: number, opts: { failCapacityOnce?: boolean } = {}) {
  const cache = new Map<string, RunResult>();
  const calls: string[] = [];
  let failed = false;
  const key = (s: Scenario, o?: EvaluateOptions) => runKey(s) + (o?.saturate ? '-sat' : '');
  const runner: Runner = {
    kind: 'inline',
    async evaluate(s, o) {
      const k = key(s, o);
      calls.push(o?.saturate ? 'sat' : 'demand');
      if (o?.saturate && opts.failCapacityOnce && !failed) {
        failed = true;
        throw new Error('capacity run crashed');
      }
      let r = cache.get(k);
      if (!r) {
        r = o?.saturate ? { ...mkRun({ oph: cap, capacityOph: cap }), hash: 'sat' } : { ...mkRun({ oph: s.orders.perHour, keepsUp: true, backlogTrendPerHour: 3 }), hash: 'dem' };
        cache.set(k, r);
      }
      return r;
    },
    peek: (s, o) => cache.get(key(s, o)),
    dispose: () => cache.clear(),
  };
  return { runner, calls };
}
const s: Scenario = { ...defaultScenario, orders: { ...defaultScenario.orders, perHour: 600 } };

describe('withCapacity', () => {
  it('a flat backlog but capacity below demand does not keep up; at or above demand it does', async () => {
    const short = await withCapacity(stub(582.5).runner).evaluate(s);
    expect(short.kpis.keepsUp).toBe(false);
    expect(short.kpis.capacityOph).toBe(582.5);
    expect(short.kpis.backlogTrendPerHour).toBe(3); // the demand run's own numbers are kept
    expect((await withCapacity(stub(600).runner).evaluate(s)).kpis.keepsUp).toBe(true);
    expect((await withCapacity(stub(613).runner).evaluate(s)).kpis.keepsUp).toBe(true);
  });
  it('a demand run that falls behind on its own trend stays "doesn\'t keep up" even with capacity to spare', async () => {
    const inner = stub(700).runner;
    const behind: Runner = { ...inner, evaluate: async (sc, o) => (o?.saturate ? inner.evaluate(sc, o) : { ...mkRun({ oph: 540, keepsUp: false, backlogTrendPerHour: 61 }), hash: 'b' }) };
    expect((await withCapacity(behind).evaluate(s)).kpis.keepsUp).toBe(false);
  });
  it('peek: nothing until both runs are cached, then the very object evaluate returned', async () => {
    const w = withCapacity(stub(650).runner);
    expect(w.peek(s)).toBeUndefined();
    const r = await w.evaluate(s);
    expect(w.peek(s)).toBe(r);
    expect(await w.evaluate(s)).toBe(r);
  });
  it('capacity runs pass straight through: {saturate: true} and orders.mode "saturate"', async () => {
    const { runner, calls } = stub(650);
    const w = withCapacity(runner);
    const sat = await w.evaluate(s, { saturate: true });
    expect(sat.hash).toBe('sat');
    expect(w.peek(s, { saturate: true })).toBe(sat);
    await w.evaluate({ ...s, orders: { ...s.orders, mode: 'saturate' } });
    expect(calls).toEqual(['sat', 'demand']); // the saturate-mode scenario went through as one plain call
  });
  it('a crashed capacity run rejects the evaluate; the next try succeeds', async () => {
    const w = withCapacity(stub(650, { failCapacityOnce: true }).runner);
    await expect(w.evaluate(s)).rejects.toThrow('capacity run crashed');
    expect((await w.evaluate(s)).kpis.keepsUp).toBe(true);
  });
});
