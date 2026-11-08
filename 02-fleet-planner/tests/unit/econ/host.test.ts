// The real economics plugged into the lead's host, the way Phase 1 integration will do it: the host's own sanity
// checks (People only ⇒ $0 robot cost; buy/rent reuses the run) must still hold with `econ` instead of `fakeEcon`.
import { describe, expect, it } from 'vitest';
import defaultLayout from '../../../data/layouts/default.json';
import type { LayoutFile, Scenario } from '../../../src/contracts/types.ts';
import { createHost } from '../../../src/host/index.ts';
import { createFakeRunner } from '../../../src/host/runner/fake.ts';
import { econ } from '../../../src/econ/index.ts';
import { agents, defaultScenario, sources, sourceIds } from './helpers.ts';

const data = { agents, sources, layouts: { default: defaultLayout as LayoutFile }, scenarios: { default: defaultScenario } };
const settle = () => new Promise((r) => setTimeout(r, 400));

describe('host + real economics', () => {
  it('computes money against the auto baseline; People only ⇒ $0 robot cost', async () => {
    const host = createHost(data, createFakeRunner(), { econ });
    await settle();
    expect(host.baseline.value?.crew).toEqual({ picker: 19, driver: 3 });
    expect(host.money.value?.capex.value).toBe(2_312_000);
    expect(host.money.value?.paybackMonths.formula).toMatch(/^payback = \$2,312,000 upfront ÷ \(\$[\d,]+ saved a year ÷ 12\) = [\d.]+ months/);
    host.peopleOnly();
    await settle();
    expect(host.money.value?.capex.value).toBe(0);
    expect(host.money.value?.robotOpexYear.value).toBe(0);
    expect(['never', 'doesntKeepUp']).toContain(host.money.value?.paybackMonths.flag);
  });
  it('buy/rent toggles reuse the cached run and the cached baseline', async () => {
    let calls = 0;
    const base = createFakeRunner();
    const runner = { ...base, evaluate: (s: Scenario, o?: { saturate?: boolean }) => (calls++, base.evaluate(s, o)) };
    const host = createHost(data, runner, { econ });
    await settle();
    const before = calls;
    host.setFinancing('raas');
    await settle();
    expect(calls).toBe(before);
    expect(host.money.value?.financing).toBe('raas');
    expect(host.money.value?.capex.value).toBe(482_000);
    for (const l of host.money.value!.lines) for (const i of l.capex.inputs) if (i.from.startsWith('source:')) expect(sourceIds.has(i.from.slice(7))).toBe(true);
  });
});

describe('host + lazily loaded economics (the way the app loads it)', () => {
  it('a loader that resolves gives the same money as the direct port', async () => {
    const host = createHost(data, createFakeRunner(), { econ: () => Promise.resolve(econ) });
    await settle();
    expect(host.moneyPending.value).toBe(false);
    expect(host.money.value?.capex.value).toBe(2_312_000);
  });
  it('a loader that keeps failing at first: no money (and no stuck spinner), then the next settings change retries and money comes back', async () => {
    let tries = 0;
    // Fails for the early preload and the first money attempt, then works.
    const loader = () => (++tries <= 2 ? Promise.reject(new Error('chunk failed to load')) : Promise.resolve(econ));
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a);
    try {
      const host = createHost(data, createFakeRunner(), { econ: loader });
      await settle();
      expect(host.money.value).toBeNull();
      expect(host.moneyPending.value).toBe(false);
      expect(errors.length).toBeGreaterThan(0);
      host.setFinancing('raas');
      await settle();
      expect(tries).toBe(3);
      expect(host.money.value?.financing).toBe('raas');
    } finally {
      console.error = orig;
    }
  });
});
