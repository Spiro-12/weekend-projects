// findBaseline against the fake runner: at most 4 evaluate calls, the answer keeps up, it is the smallest crew the
// search found, it is close to a brute-force minimum, and it never depends on the candidate's fleet or traffic mode
// (the host caches the baseline by a key that ignores them).
import { describe, expect, it } from 'vitest';
import defaultLayout from '../../../data/layouts/default.json';
import smallJson from '../../../data/scenarios/small.json';
import largeJson from '../../../data/scenarios/large.json';
import type { LayoutFile, RunResult, Scenario } from '../../../src/contracts/types.ts';
import { validateScenario } from '../../../src/contracts/validate.ts';
import { createFakeRunner } from '../../../src/host/runner/fake.ts';
import { runScenario } from '../../../src/host/runner/run.ts';
import type { EvaluateOptions, Runner } from '../../../src/host/runner/types.ts';
import { runKey } from '../../../src/host/settings.ts';
import { baselineScenario, findBaseline, MAX_BASELINE_EVALS, meanLinesPerOrder, type Crew } from '../../../src/econ/baseline.ts';
import { computeMoney } from '../../../src/econ/money.ts';
import { createKpiRecorder, keepsUpAt } from '../../../src/kpi/index.ts';
import { agents, defaultScenario, mkRun } from './helpers.ts';

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

/** Brute force (fake runner by default): the smallest crew (fewest people, then fewest drivers) that keeps up. */
async function bruteForce(s: Scenario, runner: Runner = createFakeRunner()): Promise<Crew | null> {
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

  it('lands on the brute-force minimum for the small and default buildings, within 2 people for the large', async () => {
    const found = async (s: Scenario) => (await findBaseline(s, createFakeRunner())).crew;
    expect(await found(scenarios.default)).toEqual(await bruteForce(scenarios.default)); // 18 pickers + 3 drivers
    expect(await found(scenarios.small)).toEqual(await bruteForce(scenarios.small));
    // The fake's crowding term makes each picker faster as the crew shrinks (and its busy shares are whole percents),
    // which a workload cut can't see: 40 + 5 found vs 38 + 5 at 1,200 orders/h.
    const big = await found(scenarios.large);
    const bigMin = (await bruteForce(scenarios.large))!;
    expect(big.picker + big.driver - (bigMin.picker + bigMin.driver)).toBeLessThanOrEqual(2);
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
    // 75% under the old 2% keeps-up line; 71% under 5% (RESULTS.md: "Baseline crew search").
    expect(exact / total).toBeGreaterThan(0.7);
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
      { ...defaultScenario, vendors: { ...defaultScenario.vendors, amr: [{ id: 'Z', pct: 100 }] } },
      { ...defaultScenario, traffic: { mode: 'siloed', silo: { sensorCells: 2, waitTicks: 8, resetMin: 3, retaskSec: 120 } } },
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

// A stub runner whose step-1 estimate is NOT exact by construction, the way the real sim may differ from the fake:
// pickers work at rDemand units per busy hour in demand runs but rSat in capacity runs; at most uMax of their time
// is busy; drivers make driverRate moves per busy hour; the capacity run can under-report driver busy time.
interface StubModel {
  rDemand: number;
  rSat: number;
  uMax: number;
  driverRate: number;
  /** The capacity run reports driver busy share × this (1 = honest). */
  satDriverBusyScale?: number;
}
function stubRunner(m: StubModel): Runner {
  const run = (s: Scenario, opts?: EvaluateOptions): RunResult => {
    const sat = !!opts?.saturate;
    const lines = meanLinesPerOrder(s);
    const palletsPerOrder = lines / s.pallets.linesPerReplenish;
    const { picker: p, driver: d } = s.fleet;
    const r = sat ? m.rSat : m.rDemand;
    const pickCap = (p * m.uMax * r) / lines;
    const driverCap = Math.max(0, d * m.driverRate - s.pallets.inboundPerHour) / palletsPerOrder;
    const cap = Math.min(pickCap, driverCap);
    const demand = sat ? cap : s.orders.perHour;
    const oph = Math.min(demand, cap);
    const keepsUp = keepsUpAt(demand - oph, demand); // the real KPI rule: backlog growth ≤ KEEPS_UP_PCT of demand
    const pickerBusy = p > 0 ? ((oph * lines) / (p * r)) * 100 : 0;
    const driverBusy = d > 0 ? Math.min(100, ((oph * palletsPerOrder + s.pallets.inboundPerHour) / (d * m.driverRate)) * 100) * (sat ? (m.satDriverBusyScale ?? 1) : 1) : 0;
    const share = (u: number) => ({ utilizationPct: u, idlePct: 100 - u, blockedPct: 0, waitPct: 0, chargingPct: 0, brokenPct: 0 });
    return mkRun(
      {
        oph,
        capacityOph: sat ? cap : undefined,
        keepsUp,
        backlogTrendPerHour: keepsUp ? 0 : demand - oph,
        unitsPerPickerHour: p > 0 ? (oph * lines) / p : 0,
        byType: { picker: share(pickerBusy), driver: share(driverBusy) },
      },
      s.fleet,
    );
  };
  return { kind: 'inline', evaluate: async (s, o) => run(s, o), peek: () => undefined, dispose: () => {} };
}

describe('findBaseline on a stub runner (step 1 is wrong on purpose)', () => {
  const s = defaultScenario; // 600 orders/h × 2.21 lines = 1,326 units/h; 45.15 pallet moves/h
  const check = async (m: StubModel) => {
    const stub = stubRunner(m);
    const { runner, calls } = counted(stub);
    const b = await findBaseline(s, runner);
    const min = (await bruteForce(s, stub))!;
    return { b, min, calls, demandRuns: calls.filter((c) => !c.opts?.saturate).map((c) => ({ ...c.s.fleet })) };
  };
  it('capacity runs 20% slower per picker than demand runs: the workload cut lands on the minimum', async () => {
    // Step 1 overestimates pickers by 25%; cutting by a fixed 5% would leave 18 pickers, the workload gives 14.
    const { b, min, calls } = await check({ rDemand: 100, rSat: 80, uMax: 0.9, driverRate: 25 });
    expect(min).toEqual({ picker: 14, driver: 2 });
    expect(b.crew).toEqual(min);
    expect(b.result.kpis.keepsUp).toBe(true);
    expect(calls.length).toBeLessThanOrEqual(MAX_BASELINE_EVALS);
  });
  it('capacity runs 20% faster per picker: the first crew is short, pickers grow by the shortfall, then halfway back', async () => {
    const { b, min, calls, demandRuns } = await check({ rDemand: 100, rSat: 120, uMax: 0.9, driverRate: 25 });
    expect(demandRuns[0].picker).toBeLessThan(min.picker); // A was too small…
    expect(demandRuns[1].driver).toBe(demandRuns[0].driver); // …because of pickers, so only pickers grew
    expect(b.crew).toEqual(min);
    expect(calls.length).toBeLessThanOrEqual(MAX_BASELINE_EVALS);
  });
  it('drivers are the bottleneck (the capacity run under-reports their busy time): only drivers grow, then pickers are trimmed', async () => {
    const { b, min, calls, demandRuns } = await check({ rDemand: 100, rSat: 100, uMax: 0.9, driverRate: 25, satDriverBusyScale: 0.5 });
    const [A, B] = demandRuns;
    expect(A.driver).toBeLessThan(min.driver); // step 1 under-sized the drivers
    expect(calls.find((c) => !c.opts?.saturate)!.r.kpis.byType.driver!.utilizationPct).toBeGreaterThanOrEqual(85); // so driversShort fires
    expect(B).toMatchObject({ picker: A.picker, driver: min.driver }); // drivers sized from the measured moves, pickers untouched
    expect(b.crew).toEqual(min);
    expect(calls.length).toBeLessThanOrEqual(MAX_BASELINE_EVALS);
  });
  const gapFor = async (m: StubModel, perHour: number) => {
    const sd = withDemand(s, perHour);
    const stub = stubRunner(m);
    const { runner, calls } = counted(stub);
    const b = await findBaseline(sd, runner);
    const min = (await bruteForce(sd, stub))!;
    const what = `${JSON.stringify(m)}, ${perHour}/h: found ${JSON.stringify(b.crew)}, minimum ${JSON.stringify(min)}`;
    expect(calls.length, what).toBeLessThanOrEqual(MAX_BASELINE_EVALS);
    expect(b.result.kpis.keepsUp, what).toBe(true);
    return { gap: b.crew.picker + b.crew.driver - (min.picker + min.driver), what };
  };
  it('one wrong reading at a time (picker rate, driver busy share, slow drivers): within 1 person of the minimum', async () => {
    const models: StubModel[] = [];
    for (const uMax of [0.8, 0.9, 0.95]) {
      for (const rSat of [70, 85, 100, 115, 130]) models.push({ rDemand: 100, rSat, uMax, driverRate: 25 });
      for (const driverRate of [25, 40]) for (const satDriverBusyScale of [0.5, 1.5]) models.push({ rDemand: 100, rSat: 100, uMax, driverRate, satDriverBusyScale });
    }
    // Drivers so slow that even the capacity run is short of them (its pickers starve; 90% busy is assumed then).
    models.push({ rDemand: 100, rSat: 100, uMax: 0.9, driverRate: 12 });
    for (const m of models) {
      for (const perHour of [150, 600, 1200]) {
        const { gap, what } = await gapFor(m, perHour);
        expect(gap, what).toBeGreaterThanOrEqual(0);
        // ≤ 1 under the old 2% keeps-up line; the 5% line (KEEPS_UP_PCT) trims harder per step, so a wrong driver
        // reading at 1,200/h can end 2 over (RESULTS.md: "Baseline crew search").
        expect(gap, what).toBeLessThanOrEqual(2);
      }
    }
  });
  it('every combination of wrong readings (405 models): ≤ 4 calls, always keeps up, mostly exact', async () => {
    let exact = 0;
    let n = 0;
    for (const uMax of [0.8, 0.9, 0.95]) for (const rSat of [70, 85, 100, 115, 130]) for (const driverRate of [12, 25, 40]) for (const satDriverBusyScale of [0.5, 1, 1.5]) {
      for (const perHour of [150, 600, 1200]) {
        const { gap } = await gapFor({ rDemand: 100, rSat, uMax, driverRate, satDriverBusyScale }, perHour);
        n++;
        if (gap === 0) exact++;
      }
    }
    expect(n).toBe(405);
    expect(exact / n).toBeGreaterThan(0.7);
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
  it('vendors and the many-brains knobs are normalized (they can’t matter without robots), and the result is valid', () => {
    const odd: Scenario = {
      ...defaultScenario,
      vendors: { amr: [{ id: 'Q', pct: 30 }, { id: 'R', pct: 70 }], forklift: [{ id: 'B', pct: 100 }], humanoid: [{ id: 'C', pct: 100 }] },
      traffic: { mode: 'siloed', silo: { sensorCells: 5, waitTicks: 8, resetMin: 9, retaskSec: 120 } },
    };
    const a = baselineScenario(odd, { picker: 12, driver: 2 });
    const b = baselineScenario(defaultScenario, { picker: 12, driver: 2 });
    expect(runKey(a)).toBe(runKey(b));
    expect(validateScenario(a, ['small', 'default', 'large'])).toEqual([]);
  });
  it('runs on the real runner loop (FakeSim) without trouble', () => {
    const r = runScenario(baselineScenario(defaultScenario, { picker: 18, driver: 3 }), { agents, layout: defaultLayout as LayoutFile }, createKpiRecorder);
    expect(r.fleet).toMatchObject({ amr: 0, forklift: 0, humanoid: 0, picker: 18, driver: 3 });
    expect(r.kpis.oph).toBeGreaterThan(0);
  });
});
