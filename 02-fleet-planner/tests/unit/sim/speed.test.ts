// Speed and the numbers for the report (the brief: 8 h ≤ 10 s, whole tick ≤ 0.2 ms at 150 robots + people, picker
// uplift and capacity at the default inputs). Timings are wall clock and noisy while other tracks run; the asserts are
// loose ceilings that only catch a real regression. The measured values are printed for the report.
import { describe, expect, it } from 'vitest';
import type { Scenario } from '../../../src/contracts/types.ts';
import { makeSim, scenario } from './helpers/data.ts';

const now = () => performance.now();

function shift(s: Scenario, pibt: boolean, ticks: number) {
  const sim = makeSim(s, { pibt });
  const t0 = now();
  sim.step(ticks);
  return { ms: now() - t0, sim };
}

/** Capacity run (saturate, 30 min warm-up + 2 h), the way the runner measures capacityOph. */
function capacity(s: Scenario, pibt: boolean) {
  const sim = makeSim({ ...s, orders: { ...s.orders, mode: 'saturate' } }, { pibt });
  sim.step(30 * 120);
  const a = sim.stats();
  sim.step(2 * 7200);
  const b = sim.stats();
  const pickerUnits = (b.unitsPicked.picker ?? 0) - (a.unitsPicked.picker ?? 0);
  return { oph: (b.shippedOrders - a.shippedOrders) / 2, unitsPerPickerHour: s.fleet.picker > 0 ? pickerUnits / (s.fleet.picker * 2) : 0 };
}

describe('speed', () => {
  it('an 8 h default shift with NaiveController', () => {
    const { ms } = shift(scenario(), false, 8 * 7200);
    console.log(`[track A] 8 h default shift, NaiveController: ${(ms / 1000).toFixed(2)} s (${((ms / (8 * 7200)) * 1000).toFixed(1)} µs/tick)`);
    expect(ms).toBeLessThan(40_000);
  });

  it('an 8 h default shift with the one-brain planner (work keeps flowing)', () => {
    const { ms, sim } = shift(scenario(), true, 8 * 7200);
    console.log(`[track A] 8 h default shift, one-brain: ${(ms / 1000).toFixed(2)} s, shipped ${sim.stats().shippedOrders}`);
    expect(ms).toBeLessThan(40_000);
  });

  it('whole tick at 150 robots + people (one-brain planner, default layout)', () => {
    const s = scenario({ fleet: { amr: 130, forklift: 8, humanoid: 12, picker: 30, driver: 4 }, orders: { mode: 'saturate' } });
    const sim = makeSim(s, { pibt: true });
    sim.step(1800);
    const t0 = now();
    sim.step(3600);
    const ms = now() - t0;
    const naive = makeSim(s, {});
    naive.step(1800);
    const t1 = now();
    naive.step(3600);
    const msNaive = now() - t1;
    console.log(`[track A] 150 robots + 34 people: ${(ms / 3600).toFixed(3)} ms/tick (one-brain), ${(msNaive / 3600).toFixed(3)} ms/tick (naive)`);
    expect(ms / 3600).toBeLessThan(2);
  });
});

/** The fleet Track A recommends as the default (3 cart robots per picker; keeps up with 600 orders/h). The lead owns
 *  data/scenarios/*.json and sets it there. */
export const RECOMMENDED_FLEET = { amr: 42, forklift: 4, humanoid: 2, picker: 14, driver: 2 };

describe('picker uplift (calibration regression floor)', () => {
  it('at the recommended default fleet with the one-brain planner: ≥ 1.2× and the fleet keeps up with 600 orders/h', () => {
    const s = scenario({ fleet: RECOMMENDED_FLEET });
    const withRobots = capacity(s, true);
    const without = capacity({ ...s, fleet: { ...s.fleet, amr: 0, humanoid: 0 } }, true);
    const uplift = withRobots.unitsPerPickerHour / without.unitsPerPickerHour;
    console.log(
      `[track A] recommended fleet (42 AMR, 14 pickers), one-brain planner: capacity ${withRobots.oph} oph with robots, ${without.oph} people only; ` +
        `units/picker-h ${withRobots.unitsPerPickerHour.toFixed(1)} vs ${without.unitsPerPickerHour.toFixed(1)} ⇒ uplift ${uplift.toFixed(2)}×`,
    );
    // measured 1.29–1.43× over seeds 42, 7, 99 (seed 42: 1.29×); the floor catches a real regression, not noise
    expect(uplift).toBeGreaterThanOrEqual(1.2);
    expect(withRobots.oph).toBeGreaterThanOrEqual(600);
    // the manual baseline stays near the case-study 75 units/picker-hour
    expect(without.unitsPerPickerHour).toBeGreaterThan(62);
    expect(without.unitsPerPickerHour).toBeLessThan(82);
  });

  it('at the current default scenario (report only): naive and one-brain', () => {
    const s = scenario();
    const out: string[] = [];
    for (const pibt of [false, true]) {
      const withRobots = capacity(s, pibt);
      const without = capacity({ ...s, fleet: { ...s.fleet, amr: 0, humanoid: 0 } }, pibt);
      const uplift = without.unitsPerPickerHour > 0 ? withRobots.unitsPerPickerHour / without.unitsPerPickerHour : 0;
      out.push(
        `${pibt ? 'one-brain' : 'naive'}: capacity ${withRobots.oph} oph with robots, ${without.oph} oph people only; ` +
          `units/picker-h ${withRobots.unitsPerPickerHour.toFixed(1)} vs ${without.unitsPerPickerHour.toFixed(1)} ⇒ uplift ${uplift.toFixed(2)}×`,
      );
      expect(without.oph).toBeGreaterThan(0);
    }
    console.log(`[track A] ${out.join('\n[track A] ')}`);
  });
});
