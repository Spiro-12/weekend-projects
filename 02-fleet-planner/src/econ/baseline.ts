// The people-only baseline (PROTOCOL §7, PLAN §4): the smallest all-human crew (pickers + forklift drivers) that
// keeps up with the same orders, or the user's crew when `economics.baseline` is set. Payback compares two simulated
// runs, never a guess, and never a baseline that can't keep up.
//
// A baseline that is too big inflates every robot option's savings, so the search aims for the smallest crew, not
// just one that works. It uses at most MAX_BASELINE_EVALS runner calls:
//   1. one capacity run (saturate) at a guess, with plenty of drivers so pickers are the limit: it measures units per
//      picker-hour and pallet moves per busy driver-hour
//   2. a demand run at the crew those rates say is needed, +5%
//   3-4. if it kept up: about 10% fewer pickers, then one driver fewer; if not: grow by the measured shortfall,
//        then halfway back (or grow again)
// The answer is the smallest crew that kept up in a demand run. If none did (the building itself can't handle the
// orders, e.g. too few pack stations), it is the biggest crew tried, with keepsUp false, and the money panel flags it.
//
// The result depends only on the settings the host's baseline cache key keeps (orders, building, pallets, packing,
// shift, seed, events, the user's baseline): never on the candidate's fleet, traffic mode or financing.
import type { RunResult, Scenario } from '../contracts/types.ts';
import { ROBOT_TYPES } from '../contracts/types.ts';
import type { Runner } from '../host/runner/types.ts';
import { peopleOnly } from '../host/settings.ts';

export interface Crew {
  picker: number;
  driver: number;
}

/** The most runner calls one automatic baseline search makes. */
export const MAX_BASELINE_EVALS = 4;
/** Starting guess for the capacity run only (manual cart picking, PLAN §3 research); the run measures the real rate. */
const GUESS_UNITS_PER_PICKER_HOUR = 75;
/** Starting guess for pallet moves per driver-hour (agents.json driver note: "total lands near 20 moves/h"). */
const GUESS_PALLETS_PER_DRIVER_HOUR = 20;
/** The capacity run gets this many times the guessed drivers, so drivers don't limit it. */
const GENEROUS_DRIVERS = 1.5;
/** A demand run whose drivers are at least this busy is short of drivers. */
const DRIVERS_SHORT_PCT = 85;

/** Expected lines per order from the integer weights for 1, 2, 3 … lines. */
export function meanLinesPerOrder(s: Scenario): number {
  const w = s.orders.linesWeights;
  let total = 0;
  let lines = 0;
  for (let i = 0; i < w.length; i++) {
    total += w[i];
    lines += w[i] * (i + 1);
  }
  return total > 0 ? lines / total : 0;
}

/** Pallet moves per hour the orders need: one replenishment per `linesPerReplenish` lines, plus inbound pallets. */
export function palletsPerHour(s: Scenario): number {
  const units = s.orders.perHour * meanLinesPerOrder(s);
  return (s.pallets.linesPerReplenish > 0 ? units / s.pallets.linesPerReplenish : 0) + s.pallets.inboundPerHour;
}

const isRobotRef = (agent: string) => (ROBOT_TYPES as readonly string[]).includes(agent.split(':')[0]);

/** The settings for a people-only run with this crew. Traffic mode is fixed to one brain (there are no robots to
 *  plan, and it keeps the run cache shared across modes); robot-only events are dropped (there are no robots). */
export function baselineScenario(s: Scenario, crew: Crew): Scenario {
  const p = peopleOnly(s);
  return {
    ...p,
    fleet: { ...p.fleet, picker: crew.picker, driver: crew.driver },
    traffic: { ...s.traffic, mode: 'central' },
    events: s.events.filter((e) => !(e.type === 'chargers' || (e.type === 'breakdown' && isRobotRef(e.agent)))),
  };
}

const sameCrew = (a: Crew, b: Crew) => a.picker === b.picker && a.driver === b.driver;
/** Smaller first: fewer people, then fewer drivers. */
const smaller = (a: Crew, b: Crew) => a.picker + a.driver - (b.picker + b.driver) || a.driver - b.driver || a.picker - b.picker;

export async function findBaseline(s: Scenario, runner: Runner): Promise<{ crew: Crew; result: RunResult }> {
  if (s.economics.baseline !== 'auto') {
    const crew = { picker: s.economics.baseline.picker, driver: s.economics.baseline.driver };
    return { crew, result: await runner.evaluate(baselineScenario(s, crew)) };
  }

  const units = s.orders.perHour * meanLinesPerOrder(s);
  const pallets = palletsPerHour(s);
  const minDrivers = pallets > 0 ? 1 : 0;
  const tried: { crew: Crew; result: RunResult }[] = [];
  const demandRun = async (crew: Crew) => {
    const result = await runner.evaluate(baselineScenario(s, crew));
    tried.push({ crew, result });
    return result;
  };

  if (units <= 0) {
    // No orders: no pickers needed; drivers only for inbound pallets.
    const crew = { picker: 0, driver: Math.max(minDrivers, Math.ceil(pallets / GUESS_PALLETS_PER_DRIVER_HOUR)) };
    return { crew, result: await demandRun(crew) };
  }

  // 1. Capacity run at a guess, with generous drivers so the pickers are what limits it.
  const guess: Crew = {
    picker: Math.max(1, Math.ceil(units / GUESS_UNITS_PER_PICKER_HOUR)),
    driver: Math.max(minDrivers, Math.ceil((pallets / GUESS_PALLETS_PER_DRIVER_HOUR) * GENEROUS_DRIVERS)),
  };
  const cap = await runner.evaluate(baselineScenario(s, guess), { saturate: true });
  const perPicker = cap.kpis.unitsPerPickerHour > 0 ? cap.kpis.unitsPerPickerHour : GUESS_UNITS_PER_PICKER_HOUR;
  // Pallet moves at capacity ÷ busy driver-hours = moves one fully busy driver makes per hour.
  const capOph = cap.kpis.capacityOph ?? cap.kpis.oph;
  const movedPerHour = (s.pallets.linesPerReplenish > 0 ? (capOph * meanLinesPerOrder(s)) / s.pallets.linesPerReplenish : 0) + s.pallets.inboundPerHour;
  const driverBusy = (cap.kpis.byType.driver?.utilizationPct ?? 0) / 100;
  const perDriver = guess.driver > 0 && driverBusy > 0.05 && movedPerHour > 0 ? movedPerHour / (guess.driver * driverBusy) : GUESS_PALLETS_PER_DRIVER_HOUR;
  const need = { picker: units / perPicker, driver: pallets / perDriver };
  const crewAt = (f: number): Crew => ({
    picker: Math.max(1, Math.ceil(need.picker * f)),
    driver: Math.max(minDrivers, Math.ceil(need.driver * f)),
  });
  const seen = (c: Crew) => tried.some((t) => sameCrew(t.crew, c));
  const driversShort = (r: RunResult) => (r.kpis.byType.driver?.utilizationPct ?? 0) >= DRIVERS_SHORT_PCT;

  // 2. The crew the measured rates say is needed, plus 5%.
  const fA = 1.05;
  const A = crewAt(fA);
  const rA = await demandRun(A);

  const fewerDrivers = (c: Crew): Crew | null => (c.driver > minDrivers ? { picker: c.picker, driver: c.driver - 1 } : null);
  if (rA.kpis.keepsUp) {
    // 3. About 10% fewer pickers, same drivers (one dimension at a time, so a failure says which one was short).
    const pB = Math.min(crewAt(0.95).picker, A.picker - 1);
    let C: Crew | null = null;
    if (pB >= 1) {
      const B = { picker: pB, driver: A.driver };
      const rB = await demandRun(B);
      // 4. Then one driver fewer (driver counts are small, so the shared scale factor rarely moves them): on B if it
      //    kept up, else on the picker count halfway back toward A. tests/unit/econ/baseline.test.ts checks the
      //    result against a brute-force search on the fake runner.
      if (rB.kpis.keepsUp) C = fewerDrivers(B) ?? (B.picker > 1 ? { picker: B.picker - 1, driver: B.driver } : null);
      else {
        const mid = crewAt(1.0).picker;
        const p = mid > pB && mid < A.picker ? mid : A.picker;
        C = fewerDrivers({ picker: p, driver: A.driver }) ?? (p < A.picker ? { picker: p, driver: A.driver } : null);
      }
    } else C = fewerDrivers(A);
    if (C && !seen(C)) await demandRun(C);
  } else {
    // 3. Grow by the measured shortfall (at least 20%); 4. halfway back if that kept up, else grow again.
    const grow = (from: Crew, r: RunResult, f: number): Crew => {
      let c = crewAt(f);
      if (smaller(c, from) <= 0) c = { picker: from.picker + 1, driver: from.driver };
      if (c.driver <= from.driver && driversShort(r)) c = { ...c, driver: from.driver + 1 };
      return c;
    };
    const shortfall = (r: RunResult) => Math.min(3, s.orders.perHour / Math.max(1, r.kpis.oph));
    const fB = Math.max(fA * 1.2, fA * shortfall(rA) * 1.05);
    const B = grow(A, rA, fB);
    const rB = await demandRun(B);
    if (rB.kpis.keepsUp) {
      const C = crewAt((fA + fB) / 2);
      if (!seen(C) && smaller(C, B) < 0 && smaller(A, C) < 0) await demandRun(C);
    } else {
      await demandRun(grow(B, rB, Math.max(fB * 1.25, fB * shortfall(rB) * 1.05)));
    }
  }

  const keepers = tried.filter((t) => t.result.kpis.keepsUp).sort((a, b) => smaller(a.crew, b.crew));
  if (keepers.length) return keepers[0];
  // Nobody kept up: the biggest crew tried (the money panel flags the comparison).
  return [...tried].sort((a, b) => smaller(b.crew, a.crew))[0];
}
