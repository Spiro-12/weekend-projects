// The people-only baseline (PROTOCOL §7, PLAN §4): the smallest all-human crew (pickers + forklift drivers) that
// keeps up with the same orders, or the user's crew when `economics.baseline` is set. Payback compares two simulated
// runs, never a guess, and never a baseline that can't keep up.
//
// A baseline that is too big inflates every robot option's savings, so the search aims for the smallest crew, not
// just one that works. It uses at most MAX_BASELINE_EVALS runner calls:
//   1. one capacity run (saturate) at a guess, with plenty of drivers so pickers are the limit: it measures units per
//      picker-hour, how busy pickers are at saturation, and pallet moves per busy driver-hour
//   2. a demand run (A) at the crew those rates say is needed, +5%
//   3-4. if A kept up: pickers cut to A's measured workload (A's pickers × their busy share ÷ the busy share at
//        saturation), then one driver fewer. This trusts only how busy the pickers were, not the capacity run's units
//        per hour, so a capacity-mode rate that differs from the demand-mode rate doesn't leave a bigger crew.
//        If A failed: grow only what the run shows is short (pickers near their saturation busy share, drivers ≥ 85%
//        busy) by the measured shortfall, then come halfway back or trim; or grow everything if that wasn't enough.
// The answer is the smallest crew that kept up in a demand run. If none did (the building itself can't handle the
// orders, e.g. too few pack stations), it is the biggest crew tried, with keepsUp false, and the money panel says
// "no people-only crew we tried keeps up".
//
// The result depends only on the settings the host's baseline cache key keeps (orders, building, pallets, packing,
// shift, seed, events, the user's baseline): never on the candidate's fleet, traffic mode or financing.
import type { RunResult, Scenario } from '../contracts/types.ts';
import { ROBOT_TYPES } from '../contracts/types.ts';
import type { Runner } from '../host/runner/types.ts';
import { peopleOnly } from '../host/settings.ts';
import { KEEPS_UP_PCT } from '../kpi/index.ts';

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
/** The capacity run gets this many times the guessed drivers, so drivers don't limit it (its pickers must be the
 *  bottleneck for its picker readings to mean anything; if its drivers still max out, those readings are dropped). */
const GENEROUS_DRIVERS = 1.5;
/** A demand run whose drivers are at least this busy is short of drivers. */
const DRIVERS_SHORT_PCT = 85;
/** Sustainable picker busy share assumed only when the capacity run's drivers maxed out (its pickers never reached
 *  saturation, so it can't be measured): the rest of a saturated picker's time goes to waits and blocking. */
const ASSUMED_PICKER_BUSY_PCT = 90;
/** A failing demand run whose pickers are at least this share of their saturation busy level is short of pickers. */
const PICKERS_SHORT_SHARE = 0.9;
/** Growth margin on top of the measured shortfall when a crew didn't keep up. */
const GROW_MARGIN = 1.02;
/** Share of the measured work a crew must cover to keep up: backlog growth up to KEEPS_UP_PCT of demand still counts. */
const KEEPS_UP_SHARE = 1 - KEEPS_UP_PCT / 100;
/** Drivers are sized to 1 ÷ 0.95 of their measured pallet work (a little slack so faces don't run dry). */
const DRIVER_HEADROOM = 1.05;
/** People-only runs have no robots, so vendors and the many-brains knobs can't matter: they are fixed to one value
 *  (one vendor per type, spike b's typical knobs) and settings that differ only there share the run cache. */
const NO_ROBOT_VENDORS: Scenario['vendors'] = { amr: [{ id: 'A', pct: 100 }], forklift: [{ id: 'A', pct: 100 }], humanoid: [{ id: 'A', pct: 100 }] };
const NO_ROBOT_SILO: Scenario['traffic']['silo'] = { sensorCells: 3, waitTicks: 5, resetMin: 5, retaskSec: 90 };

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

/** The settings for a people-only run with this crew. Everything robot-only is normalized away (traffic mode, vendors,
 *  the many-brains knobs) so the run cache is shared, and robot-only events are dropped (there are no robots). */
export function baselineScenario(s: Scenario, crew: Crew): Scenario {
  const p = peopleOnly(s);
  return {
    ...p,
    fleet: { ...p.fleet, picker: crew.picker, driver: crew.driver },
    vendors: NO_ROBOT_VENDORS,
    traffic: { mode: 'central', silo: NO_ROBOT_SILO },
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
  const seen = (c: Crew) => tried.some((t) => sameCrew(t.crew, c));

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
  // Units per picker-hour and how busy pickers are when the queue is always full (the most a crew can sustain).
  // If even the capacity run's drivers maxed out, its pickers were starved, not saturated: then the rate per BUSY
  // picker-hour is still right, and the sustainable busy share is assumed.
  const capUph = cap.kpis.unitsPerPickerHour;
  const capPickerBusy = cap.kpis.byType.picker?.utilizationPct ?? 0;
  const capDriversMaxed = (cap.kpis.byType.driver?.utilizationPct ?? 0) >= DRIVERS_SHORT_PCT;
  const starved = capDriversMaxed && capPickerBusy > 0 && capUph > 0;
  const perPicker = starved ? (capUph * ASSUMED_PICKER_BUSY_PCT) / capPickerBusy : capUph > 0 ? capUph : GUESS_UNITS_PER_PICKER_HOUR;
  const pickerBusyAtCap = starved ? ASSUMED_PICKER_BUSY_PCT : capPickerBusy;
  // Pallet moves a run made ÷ its busy driver-hours = moves one fully busy driver makes per hour (null if unknown).
  const movesPerBusyDriver = (r: RunResult, drivers: number): number | null => {
    const oph = r.kpis.capacityOph ?? r.kpis.oph;
    const moved = (s.pallets.linesPerReplenish > 0 ? (oph * meanLinesPerOrder(s)) / s.pallets.linesPerReplenish : 0) + s.pallets.inboundPerHour;
    const busy = (r.kpis.byType.driver?.utilizationPct ?? 0) / 100;
    return drivers > 0 && busy > 0.05 && moved > 0 ? moved / (drivers * busy) : null;
  };
  const perDriver = movesPerBusyDriver(cap, guess.driver) ?? GUESS_PALLETS_PER_DRIVER_HOUR;
  const need = { picker: units / perPicker, driver: pallets / perDriver };
  const crewAt = (f: number): Crew => ({
    picker: Math.max(1, Math.ceil(need.picker * f)),
    driver: Math.max(minDrivers, Math.ceil(need.driver * f)),
  });
  const fewerDrivers = (c: Crew): Crew | null => (c.driver > minDrivers ? { picker: c.picker, driver: c.driver - 1 } : null);
  /** Pickers for the workload a demand run measured: its pickers × their busy share ÷ the busy share at saturation,
   *  less the backlog growth that still counts as keeping up (KEEPS_UP_PCT: a crew at 95% of the work is exactly on the line). */
  const pickersForWorkload = (c: Crew, r: RunResult): number | null => {
    const busy = r.kpis.byType.picker?.utilizationPct ?? 0;
    return busy > 0 && pickerBusyAtCap > 0 ? Math.max(1, Math.ceil(((c.picker * busy) / pickerBusyAtCap) * KEEPS_UP_SHARE)) : null;
  };
  /** Drivers for the pallet work at the moves per busy driver a demand run measured, with a little headroom. */
  const driversForWorkload = (c: Crew, r: RunResult): number | null => {
    const rate = movesPerBusyDriver(r, c.driver);
    return rate !== null ? Math.max(minDrivers, Math.ceil((pallets / rate) * DRIVER_HEADROOM)) : null;
  };
  const pickersShort = (r: RunResult) => pickerBusyAtCap <= 0 || (r.kpis.byType.picker?.utilizationPct ?? 0) >= PICKERS_SHORT_SHARE * pickerBusyAtCap;
  const driversShort = (r: RunResult) => (r.kpis.byType.driver?.utilizationPct ?? 0) >= DRIVERS_SHORT_PCT;
  const shortfall = (r: RunResult) => Math.min(3, s.orders.perHour / Math.max(1, r.kpis.oph));
  /** A bigger crew after a failed run: only the short resource grows (both if the run doesn't say). Pickers grow by
   *  the order shortfall; drivers to the pallet work at the moves per busy driver that run achieved (inbound pallets
   *  are a fixed load, so they don't scale with the order shortfall). */
  const grow = (c: Crew, r: RunResult, all: boolean): Crew => {
    const f = shortfall(r) * GROW_MARGIN;
    const p = pickersShort(r);
    const d = driversShort(r);
    const both = all || p === d;
    const rate = movesPerBusyDriver(r, c.driver);
    const drivers = rate !== null ? Math.ceil((pallets / rate) * GROW_MARGIN) : Math.ceil(c.driver * f);
    return {
      picker: both || p ? Math.max(c.picker + 1, Math.ceil(c.picker * f)) : c.picker,
      driver: both || d ? Math.max(c.driver + 1, drivers) : c.driver,
    };
  };

  // 2. The crew the measured rates say is needed, plus 5%.
  const A = crewAt(1.05);
  const rA = await demandRun(A);

  let C: Crew | null = null;
  if (rA.kpis.keepsUp) {
    // 3. Pickers cut to A's measured workload, same drivers (one dimension at a time, so a failure says which).
    const pB = Math.min(pickersForWorkload(A, rA) ?? crewAt(0.95).picker, A.picker - 1);
    if (pB >= 1) {
      const B = { picker: pB, driver: A.driver };
      const rB = await demandRun(B);
      // 4. If B kept up: drivers cut to B's measured pallet work (at least one fewer), else one picker fewer.
      //    If not, the picker count halfway back toward A, with one driver fewer if A has a spare.
      if (rB.kpis.keepsUp) {
        const d = fewerDrivers(B);
        const fit = driversForWorkload(B, rB);
        C = d ? { picker: B.picker, driver: Math.min(d.driver, fit ?? d.driver) } : B.picker > 1 ? { picker: B.picker - 1, driver: B.driver } : null;
      } else {
        const p = Math.ceil((pB + A.picker) / 2);
        const mid = p > pB && p < A.picker ? p : A.picker;
        C = fewerDrivers({ picker: mid, driver: A.driver }) ?? (mid < A.picker ? { picker: mid, driver: A.driver } : null);
      }
    } else C = fewerDrivers(A);
  } else {
    // 3. Grow what A shows is short.
    const B = grow(A, rA, false);
    const rB = await demandRun(B);
    if (rB.kpis.keepsUp) {
      // 4. The last run, so trim both to what B measured (if it fails, B stands): pickers to B's workload (halfway
      //    back if that isn't known), drivers to B's pallet work (one fewer if that isn't known and they didn't grow).
      const p = pickersForWorkload(B, rB) ?? (B.picker > A.picker ? Math.ceil((A.picker + B.picker) / 2) : B.picker);
      const d = driversForWorkload(B, rB) ?? (B.driver > A.driver ? B.driver : (fewerDrivers(B)?.driver ?? B.driver));
      const trimmed = { picker: Math.min(p, B.picker), driver: Math.min(d, B.driver) };
      C = smaller(trimmed, B) < 0 ? trimmed : null;
    } else {
      // 4. Still short: grow again, everything this time if growing one resource wasn't enough.
      C = grow(B, rB, !(B.picker > A.picker && B.driver > A.driver));
    }
  }
  if (C && !seen(C)) await demandRun(C);

  const keepers = tried.filter((t) => t.result.kpis.keepsUp).sort((a, b) => smaller(a.crew, b.crew));
  if (keepers.length) return keepers[0];
  // No people-only crew we tried keeps up: the biggest one (the money panel flags the comparison).
  return [...tried].sort((a, b) => smaller(b.crew, a.crew))[0];
}
