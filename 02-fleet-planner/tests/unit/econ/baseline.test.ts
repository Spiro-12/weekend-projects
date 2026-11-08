// findBaseline against the fake runner: at most 4 evaluate calls, the answer keeps up, it is the smallest crew the
// search found, it is close to a brute-force minimum, and it never depends on the candidate's fleet or traffic mode
// (the host caches the baseline by a key that ignores them).
import { describe, expect, it } from 'vitest';
import smallJson from '../../../data/scenarios/small.json';
import largeJson from '../../../data/scenarios/large.json';
import type { RunResult, Scenario } from '../../../src/contracts/types.ts';
import { createFakeRunner } from '../../../src/host/runner/fake.ts';
import type { EvaluateOptions, Runner } from '../../../src/host/runner/types.ts';
import { runKey } from '../../../src/host/settings.ts';
import { baselineScenario, findBaseline, MAX_BASELINE_EVALS, type Crew } from '../../../src/econ/baseline.ts';
import { computeMoney } from '../../../src/econ/money.ts';
import { agents, defaultScenario } from './helpers.ts';

const scenarios: Record<string, Scenario> = { small: smallJson as Scenario, default: defaultScenario, large: largeJson as Scenario };
const withDemand = (s: Scenario, perHour: number): Scenario => ({ ...s, orders: { ...s.orders, perHour } });

/** A fake runner that records every call. */
function counted(inner: Runner = createFakeRunner()) {
  const calls: { s: Scenario; opts?: EvaluateOptions; r: RunResult }[] = [];
  const runner: Runner = {
    ...inner,
    async evaluate(s, opts) {
      const r = await inner.evaluate(s, opts);
      calls.push({ s, opts, r });
      return r;
    },
  };
  return { runner, calls };
}

/** Brute force on the fake runner: the smallest crew (fewest people, then fewest drivers) that keeps up. */
async function bruteForce(s: Scenario): Promise<Crew | null> {
  const runner = createFakeRunner();
  let best: Crew | null = null;
  for (let driver = 0; driver <= 15; driver++) {
    for (let picker = 0; picker <= 80; picker++) {
      if (best && picker + driver > best.picker + best.driver) break;
      if ((await runner.evaluate(baselineScenario(s, { picker, driver }))).kpis.keepsUp) {
        if (!best || picker + driver < best.picker + best.driver || (picker + driver === best.picker + best.driver && driver < best.driver)) best = { picker, driver };
        break;
      }
    }
  }
  return best;
}

describe('findBaseline (auto)', () => {
  for (const [id, s] of Object.entries(scenarios)) {
    it(`${id}: ≤ ${MAX_BASELINE_EVALS} evaluate calls; the answer keeps up and is the smallest crew found`, async () => {
      const { runner, calls } = counted();
      const b = await findBaseline(s, runner);
      expect(calls.length).toBeLessThanOrEqual(MAX_BASELINE_EVALS);
      expect(b.result.kpis.keepsUp).toBe(true);
      // The returned result is a demand run of exactly that crew, people only.
      expect(b.result.kpis.capacityOph).toBeUndefined();
      expect(b.result.fleet).toEqual({ amr: 0, forklift: 0, humanoid: 0, picker: b.crew.picker, driver: b.crew.driver });
      // No crew the search ran on demand that kept up is smaller.
      const keepers = calls.filter((c) => !c.opts?.saturate && c.r.kpis.keepsUp).map((c) => c.s.fleet);
      expect(keepers.length).toBeGreaterThan(0);
      for (const f of keepers) expect(f.picker + f.driver).toBeGreaterThanOrEqual(b.crew.picker + b.crew.driver);
      // Only people-only runs.
      for (const c of calls) expect(c.s.fleet).toMatchObject({ amr: 0, forklift: 0, humanoid: 0 });
    });
  }

  it('lands on the brute-force minimum for the small and default buildings, within 1 person for the large', async () => {
    const found = async (s: Scenario) => (await findBaseline(s, createFakeRunner())).crew;
    expect(await found(scenarios.default)).toEqual(await bruteForce(scenarios.default)); // 18 pickers + 3 drivers
    expect(await found(scenarios.small)).toEqual(await bruteForce(scenarios.small));
    const big = await found(scenarios.large);
    const bigMin = (await bruteForce(scenarios.large))!;
    expect(big.picker + big.driver - (bigMin.picker + bigMin.driver)).toBeLessThanOrEqual(1);
  });

  it('across demand levels: never more than 2 people over the brute-force minimum, and always ≤ 4 calls', async () => {
    let exact = 0;
    let total = 0;
    for (const s of Object.values(scenarios)) {
      for (let perHour = 30; perHour <= 1200; perHour += 90) {
        const sd = withDemand(s, perHour);
        const min = await bruteForce(sd);
        const { runner, calls } = counted();
        const b = await findBaseline(sd, runner);
        expect(calls.length, `${s.id} ${perHour}`).toBeLessThanOrEqual(MAX_BASELINE_EVALS);
        if (!min) {
          expect(b.result.kpis.keepsUp, `${s.id} ${perHour}: nobody can keep up`).toBe(false);
          continue;
        }
        total++;
        expect(b.result.kpis.keepsUp, `${s.id} ${perHour}: a crew exists, so the search must find one`).toBe(true);
        const gap = b.crew.picker + b.crew.driver - (min.picker + min.driver);
        expect(gap, `${s.id} ${perHour}: found ${JSON.stringify(b.crew)}, minimum ${JSON.stringify(min)}`).toBeGreaterThanOrEqual(0);
        expect(gap, `${s.id} ${perHour}: found ${JSON.stringify(b.crew)}, minimum ${JSON.stringify(min)}`).toBeLessThanOrEqual(2);
        if (gap === 0) exact++;
      }
    }
    expect(total).toBeGreaterThan(20);
    expect(exact / total).toBeGreaterThan(0.6);
  });

  it('is deterministic: the same settings give the same crew', async () => {
    const a = await findBaseline(scenarios.default, createFakeRunner());
    const b = await findBaseline(scenarios.default, createFakeRunner());
    expect(b.crew).toEqual(a.crew);
    expect(b.result).toEqual(a.result);
  });

  it('does not depend on the candidate’s fleet, traffic mode or financing (the host’s baseline cache key)', async () => {
    // Not just the same answer: the very same sequence of runs, so the host's cached baseline is right for every
    // candidate that shares its key.
    const runsFor = async (s: Scenario) => {
      const { runner, calls } = counted();
      const b = await findBaseline(s, runner);
      return { crew: b.crew, runs: calls.map((c) => `${runKey(c.s)}${c.opts?.saturate ? '-sat' : ''}`) };
    };
    const ref = await runsFor(scenarios.default);
    const variants: Scenario[] = [
      { ...defaultScenario, fleet: { amr: 0, forklift: 0, humanoid: 0, picker: 40, driver: 9 } },
      { ...defaultScenario, fleet: { amr: 80, forklift: 10, humanoid: 6, picker: 2, driver: 0 } },
      { ...defaultScenario, traffic: { ...defaultScenario.traffic, mode: 'siloed' } },
      { ...defaultScenario, economics: { ...defaultScenario.economics, financing: 'raas' } },
    ];
    for (const v of variants) expect(await runsFor(v)).toEqual(ref);
  });

  it('too many orders for any crew (pack stations full): ≤ 4 calls, the biggest crew tried, keepsUp false, and the money says so', async () => {
    const s = withDemand(defaultScenario, 1500); // 6 stations × 3,600 ÷ 30 s = 720 orders/h at most
    const { runner, calls } = counted();
    const b = await findBaseline(s, runner);
    expect(calls.length).toBeLessThanOrEqual(MAX_BASELINE_EVALS);
    expect(b.result.kpis.keepsUp).toBe(false);
    const tried = calls.filter((c) => !c.opts?.saturate).map((c) => c.s.fleet.picker + c.s.fleet.driver);
    expect(b.crew.picker + b.crew.driver).toBe(Math.max(...tried));
    const m = computeMoney({ scenario: s, agents, candidate: await runner.evaluate(s), baseline: b.result, baselineCrew: b.crew });
    expect(m.paybackMonths.flag).toBe('doesntKeepUp');
    expect(m.baseline.keepsUp).toBe(false);
  });

  it('no orders: no pickers', async () => {
    const b = await findBaseline(withDemand(defaultScenario, 0), createFakeRunner());
    expect(b.crew.picker).toBe(0);
    expect(b.result.kpis.keepsUp).toBe(true);
  });
});

describe('findBaseline (user-set crew)', () => {
  it('uses the user’s crew as is: one demand run, people only', async () => {
    const s: Scenario = { ...defaultScenario, economics: { financing: 'buy', baseline: { picker: 25, driver: 4 } } };
    const { runner, calls } = counted();
    const b = await findBaseline(s, runner);
    expect(calls.length).toBe(1);
    expect(calls[0].opts?.saturate).toBeFalsy();
    expect(b.crew).toEqual({ picker: 25, driver: 4 });
    expect(b.result.fleet).toEqual({ amr: 0, forklift: 0, humanoid: 0, picker: 25, driver: 4 });
  });
});

describe('baselineScenario', () => {
  it('people only, one brain, same orders; robot-only events dropped', () => {
    const s: Scenario = {
      ...defaultScenario,
      traffic: { ...defaultScenario.traffic, mode: 'siloed' },
      events: [
        { type: 'breakdown', atMin: 10, agent: 'amr:3', forMin: 5 },
        { type: 'chargers', atMin: 20, count: 2 },
        { type: 'orderSurge', atMin: 30, factorPct: 150, forMin: 10 },
        { type: 'personInAisle', atMin: 40, cell: [3, 4], forMin: 2 },
      ],
    };
    const b = baselineScenario(s, { picker: 12, driver: 2 });
    expect(b.fleet).toEqual({ amr: 0, forklift: 0, humanoid: 0, picker: 12, driver: 2 });
    expect(b.traffic.mode).toBe('central');
    expect(b.orders).toEqual(s.orders);
    expect(b.seed).toBe(s.seed);
    expect(b.events.map((e) => e.type)).toEqual(['orderSurge', 'personInAisle']);
  });
});
